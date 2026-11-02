import { DurableObject } from "cloudflare:workers";

export interface RegistryEntry {
  id: string;
  tenantId: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

const PREFIX = "registry:tenant:";
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/** Tenant-scoped Durable Object registry for sandbox ownership and lookup. */
export class Registry extends DurableObject {
  private operation: Promise<unknown> = Promise.resolve();

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await fn(); } finally { release(); }
  }

  private key(tenantId: string): string {
    if (typeof tenantId !== "string" || !tenantId.trim() || tenantId.length > 256 || tenantId.includes("\0")) {
      throw new TypeError("tenantId must be a non-empty string of at most 256 characters");
    }
    return `${PREFIX}${encodeURIComponent(tenantId)}`;
  }

  private async entries(tenantId: string): Promise<RegistryEntry[]> {
    return (await this.ctx.storage.get<RegistryEntry[]>(this.key(tenantId))) ?? [];
  }

  /** Return this tenant's boxes in creation order. */
  async list(tenantId: string): Promise<RegistryEntry[]> {
    return this.exclusive(() => this.entries(tenantId));
  }

  /** Register a sandbox ID for a tenant. Re-adding the same ID is idempotent. */
  async add(tenantId: string, id: string, metadata?: Record<string, string>): Promise<RegistryEntry> {
    return this.exclusive(async () => {
      const key = this.key(tenantId);
      if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("id must contain 1-128 letters, numbers, underscores, or hyphens");
      if (metadata && (typeof metadata !== "object" || Array.isArray(metadata) || Object.entries(metadata).some(([k, v]) => !k || typeof v !== "string"))) {
        throw new TypeError("metadata must be a string-to-string object");
      }
      const entries = (await this.ctx.storage.get<RegistryEntry[]>(key)) ?? [];
      const existing = entries.find((entry) => entry.id === id);
      if (existing) {
        if (metadata) existing.metadata = { ...metadata };
        await this.ctx.storage.put(key, entries);
        return existing;
      }
      const entry: RegistryEntry = { id, tenantId, createdAt: Date.now(), ...(metadata ? { metadata: { ...metadata } } : {}) };
      entries.push(entry);
      await this.ctx.storage.put(key, entries);
      return entry;
    });
  }

  /** Remove an ID from a tenant's registry; absent IDs are treated as success. */
  async remove(tenantId: string, id: string): Promise<{ id: string; removed: boolean }> {
    return this.exclusive(async () => {
      const key = this.key(tenantId);
      if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("Invalid sandbox id");
      const entries = (await this.ctx.storage.get<RegistryEntry[]>(key)) ?? [];
      const next = entries.filter((entry) => entry.id !== id);
      const removed = next.length !== entries.length;
      if (removed) await this.ctx.storage.put(key, next);
      return { id, removed };
    });
  }
}
