import { DurableObject } from "cloudflare:workers";

export interface ExecInput {
  /** Executable and arguments. Shell syntax is not interpreted automatically. */
  argv: string[];
  cwd?: string;
  stdin?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  pid: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxSnapshot {
  id: string;
  size: number;
  name?: string;
  image: string;
}

export interface SandboxOptions {
  tenantId: string;
  image?: string;
  /** Optional container entrypoint, passed directly to the platform. */
  entrypoint?: string[];
  /** Internet access is opt-in and defaults to false. */
  enableInternet?: boolean;
  env?: Record<string, string>;
  inactivityTimeoutMs?: number;
}

type SandboxState = {
  id: string;
  tenantId: string;
  image: string;
  state: "new" | "running" | "stopped" | "lost" | "deleted";
  snapshot?: SandboxSnapshot;
  createdAt: number;
  updatedAt: number;
  enableInternet: boolean;
};

const STATE_KEY = "sandbox:state";
const DEFAULT_IMAGE = "workspace";
const DEFAULT_INACTIVITY_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** A single-container lifecycle controller. Snapshot state is filesystem-only. */
export class Sandbox extends DurableObject {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(DEFAULT_INACTIVITY_MS));
  }

  private get container(): Container {
    const container = (this.ctx as DurableObjectState & { container?: Container }).container;
    if (!container) throw new Error("No container is configured for this Durable Object");
    return container;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await fn(); } finally { release(); }
  }

  private async readState(): Promise<SandboxState | undefined> {
    return this.ctx.storage.get<SandboxState>(STATE_KEY);
  }

  private async writeState(state: SandboxState): Promise<SandboxState> {
    state.updatedAt = Date.now();
    await this.ctx.storage.put(STATE_KEY, state);
    if (state.state === "running") {
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + 8 * 60 * 1000);
    }
    return state;
  }

  private requireLive(state: SandboxState | undefined): SandboxState {
    if (!state || state.state === "new") throw new Error("Sandbox has not been created");
    if (state.state === "deleted") throw new Error("Sandbox has been deleted");
    if (state.state === "lost") throw new Error("Sandbox stopped unexpectedly without a saved snapshot");
    return state;
  }

  /** Initialize and start this sandbox. Repeated calls return its current state. */
  async create(options: SandboxOptions): Promise<SandboxState> {
    return this.exclusive(async () => {
      if (!options?.tenantId?.trim()) throw new TypeError("tenantId is required");
      const existing = await this.readState();
      if (existing) {
        if (existing.tenantId !== options.tenantId) throw new Error("Sandbox tenant mismatch");
        if (existing.state === "deleted") throw new Error("Deleted sandbox IDs cannot be reused");
        if (!this.container.running) await this.startContainer(existing);
        return this.writeState({ ...existing, state: "running" });
      }
      const now = Date.now();
      const state: SandboxState = {
        id: this.ctx.id.toString(), tenantId: options.tenantId, image: options.image ?? DEFAULT_IMAGE,
        state: "new", createdAt: now, updatedAt: now, enableInternet: options.enableInternet ?? true,
      };
      await this.ctx.storage.put(STATE_KEY, state);
      this.container.start({
        image: this.container.images.workspace, entrypoint: ["sleep", "infinity"],
        enableInternet: state.enableInternet,

        ...(options.env ? { env: options.env } : {}),
      });
      await this.container.setInactivityTimeout(options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_MS);
      return this.writeState({ ...state, state: "running" });
    });
  }

  private async startContainer(state: SandboxState, snapshot = state.snapshot): Promise<void> {
    this.container.start({
      ...(snapshot ? { containerSnapshot: { id: snapshot.id, size: snapshot.size, ...(snapshot.name ? { name: snapshot.name } : {}) } } : { image: this.container.images.workspace }),
      entrypoint: ["sleep", "infinity"],
      enableInternet: state.enableInternet,
    });
    await this.container.setInactivityTimeout(DEFAULT_INACTIVITY_MS);
  }

  async start(): Promise<SandboxState> { return this.resume(); }

  /** Execute argv directly; this method does not provide shell or hard-timeout semantics. */
  async exec(input: ExecInput): Promise<ExecResult> {
    if (!Array.isArray(input?.argv) || input.argv.length === 0 || input.argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new TypeError("argv must be a non-empty array of strings without null characters");
    }
    return this.exclusive(async () => {
      const state = this.requireLive(await this.readState());
      if (state.state !== "running" || !this.container.running) throw new Error("Sandbox is not running; call resume first");
      const process = await this.container.exec(input.argv, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.stdin !== undefined ? { stdin: new Blob([input.stdin]).stream() } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      const output = await process.output();
      const stdoutBytes = output.stdout.slice(0, MAX_OUTPUT_BYTES);
      const stderrBytes = output.stderr.slice(0, MAX_OUTPUT_BYTES);
      await this.writeState(state);
      return {
        pid: process.pid,
        exitCode: output.exitCode,
        stdout: new TextDecoder().decode(stdoutBytes),
        stderr: new TextDecoder().decode(stderrBytes),
      };
    });
  }

  /** Save writable root filesystem, then destroy the instance. */
  async stop(): Promise<SandboxState> {
    return this.exclusive(async () => {
      const state = this.requireLive(await this.readState());
      if (!this.container.running) {
        if (state.state === "running") { await this.writeState({ ...state, state: "lost" }); throw new Error("Sandbox stopped unexpectedly; unsaved changes were lost"); }
        return state;
      }
      const snapshot = await this.container.snapshotContainer({ name: `sandbox-${state.id}-${Date.now()}` });
      const saved: SandboxSnapshot = { ...snapshot, image: state.image };
      await this.writeState({ ...state, snapshot: saved, state: "stopped" });
      await this.container.destroy();
      return (await this.readState())!;
    });
  }

  async resume(): Promise<SandboxState> {
    return this.exclusive(async () => {
      const state = this.requireLive(await this.readState());
      if (state.state === "running" && this.container.running) return state;
      if (state.state === "running" && !this.container.running) { await this.writeState({ ...state, state: "lost" }); throw new Error("Sandbox stopped unexpectedly; unsaved changes were lost"); }
      if (state.snapshot && state.snapshot.image !== state.image) throw new Error("Snapshot is incompatible with the configured image");
      await this.startContainer(state);
      return this.writeState({ ...state, state: "running" });
    });
  }

  /** Capture a point-in-time disk snapshot suitable for initializing another Sandbox DO. */
  async forkSnapshot(): Promise<SandboxSnapshot> {
    return this.exclusive(async () => {
      const state = this.requireLive(await this.readState());
      if (state.state !== "running" || !this.container.running) throw new Error("Sandbox must be running to fork");
      const snapshot = await this.container.snapshotContainer({ name: `fork-${state.id}-${Date.now()}` });
      return { ...snapshot, image: state.image };
    });
  }

  /** Restore a snapshot into this sandbox; intended for a newly allocated fork DO. */
  async useSnapshot(snapshot: SandboxSnapshot, options: SandboxOptions): Promise<SandboxState> {
    return this.exclusive(async () => {
      if (!snapshot?.id || !Number.isFinite(snapshot.size) || !snapshot.image) throw new TypeError("Invalid snapshot handle");
      if (!options?.tenantId?.trim()) throw new TypeError("tenantId is required");
      const existing = await this.readState();
      if (existing) throw new Error("Snapshot can only initialize an unused sandbox");
      const image = options.image ?? snapshot.image;
      if (image !== snapshot.image) throw new Error("Snapshots can only be restored with the image that created them");
      const now = Date.now();
      const state: SandboxState = {
        id: this.ctx.id.toString(), tenantId: options.tenantId, image, snapshot,
        state: "new", createdAt: now, updatedAt: now, enableInternet: options.enableInternet ?? true,
      };
      await this.ctx.storage.put(STATE_KEY, state);
      await this.startContainer(state, snapshot);
      return this.writeState({ ...state, state: "running" });
    });
  }

  async alarm(): Promise<void> {
    const last = await this.ctx.storage.get<number>("lastActivity") ?? 0;
    const remaining = 8 * 60 * 1000 - (Date.now() - last);
    if (remaining > 0) { await this.ctx.storage.setAlarm(Date.now() + remaining); return; }
    try { await this.stop(); } catch { await this.ctx.storage.setAlarm(Date.now() + 30000); }
  }

  async delete(): Promise<{ id: string; state: "deleted" }> {
    return this.exclusive(async () => {
      const state = await this.readState();
      if (!state || state.state === "deleted") return { id: this.ctx.id.toString(), state: "deleted" };
      // Tombstone first so a failed destroy cannot resurrect this sandbox as usable.
      await this.writeState({ ...state, state: "deleted", snapshot: undefined });
      if (this.container.running) await this.container.destroy();
      return { id: state.id, state: "deleted" };
    });
  }

  async status(): Promise<SandboxState | { id: string; state: "new" }> {
    const state = await this.readState();
    if (!state) return { id: this.ctx.id.toString(), state: "new" };
    if (state.state === "running" && !this.container.running) return this.writeState({ ...state, state: "lost" });
    return state;
  }
}
