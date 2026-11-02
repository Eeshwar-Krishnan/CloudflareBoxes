/** Cloudflare Artifacts Workers binding surface used by this module. */
export interface ArtifactsBinding {
  create(name: string, options?: { description?: string; readOnly?: boolean }): Promise<{
    name: string;
    remote: string;
    defaultBranch?: string;
    token: string;
  }>;
  get(name: string): Promise<ArtifactsRepoHandle>;
  list(options?: { limit?: number; cursor?: string }): Promise<{
    repos: Array<{ name: string }>;
    cursor?: string | null;
  }>;
  delete(name: string): Promise<boolean>;
}

export interface ArtifactsRepoHandle {
  info(): Promise<{ name: string }>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<{
    plaintext: string;
    expiresAt: string | number | Date;
    [key: string]: unknown;
  }>;
  [key: symbol]: unknown;
}

export interface CreateArtifactOptions {
  tenantId: string;
  /** Lifetime for the repository in seconds. Defaults to 24 hours. */
  ttlSeconds?: number;
}

export interface ArtifactMetadata {
  id: string;
  name: string;
  remote: string;
  tenantId: string;
  createdAt: number;
  expiresAt: number;
  defaultBranch?: string;
}

export interface ArtifactToken {
  token: string;
  scope: "read" | "write";
  expiresAt: string | number | Date;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_MAX_TTL_SECONDS = 60 * 60;
const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose;
const NAME_PATTERN = /^cfbox-([a-f0-9]{16})-([0-9a-z]+)-([a-f0-9]{24})$/;

function validateTenant(tenantId: string): void {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0 || tenantId.length > 256 || tenantId.includes("\0")) {
    throw new TypeError("tenantId must be a non-empty string of at most 256 characters");
  }
}

function validateTtl(ttlSeconds: number, max: number, label: string): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > max) {
    throw new RangeError(`${label} must be an integer between ${MIN_TTL_SECONDS} and ${max} seconds`);
  }
}

async function tenantFingerprint(tenantId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tenantId));
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseArtifactName(name: string): { tenantFingerprint: string; expiresAt: number } | null {
  const match = NAME_PATTERN.exec(name);
  if (!match) return null;
  const expiresAt = Number.parseInt(match[2], 36);
  return Number.isSafeInteger(expiresAt) ? { tenantFingerprint: match[1], expiresAt } : null;
}

async function requireOwned(artifacts: ArtifactsBinding, id: string, tenantId: string): Promise<ArtifactsRepoHandle> {
  validateTenant(tenantId);
  if (typeof id !== "string" || id.length > 128) throw new TypeError("Invalid artifact id");
  const parsed = parseArtifactName(id);
  if (!parsed || parsed.tenantFingerprint !== await tenantFingerprint(tenantId)) {
    throw new Error("Artifact does not belong to this tenant");
  }
  const repo = await artifacts.get(id);
  try {
    const info = await repo.info();
    if (info.name !== id) throw new Error("Artifact identity validation failed");
  } catch (error) {
    (repo[DISPOSE] as (() => void) | undefined)?.call(repo);
    throw error;
  }
  return repo;
}

/** Create an expiring, tenant-scoped repository. The initial creation token is discarded. */
export async function createArtifact(
  artifacts: ArtifactsBinding,
  options: CreateArtifactOptions,
): Promise<ArtifactMetadata> {
  validateTenant(options?.tenantId);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  validateTtl(ttlSeconds, MAX_TTL_SECONDS, "ttlSeconds");
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlSeconds * 1000;
  const name = `cfbox-${await tenantFingerprint(options.tenantId)}-${expiresAt.toString(36)}-${randomSuffix()}`;
  // The create response includes an initial write token. Never return or place it in a URL.
  const created = await artifacts.create(name, { description: `Temporary artifact; expires ${new Date(expiresAt).toISOString()}` });
  return {
    id: created.name,
    name: created.name,
    remote: created.remote,
    tenantId: options.tenantId,
    createdAt,
    expiresAt,
    ...(created.defaultBranch ? { defaultBranch: created.defaultBranch } : {}),
  };
}

/** Mint a repository-scoped, short-lived Git credential after checking tenant ownership. */
export async function createArtifactToken(
  artifacts: ArtifactsBinding,
  id: string,
  tenantId: string,
  scope: "read" | "write" = "read",
  ttlSeconds = 15 * 60,
): Promise<ArtifactToken> {
  validateTtl(ttlSeconds, TOKEN_MAX_TTL_SECONDS, "ttlSeconds");
  if (scope !== "read" && scope !== "write") throw new TypeError("scope must be read or write");
  const parsed = parseArtifactName(id);
  if (!parsed || parsed.expiresAt <= Date.now() || parsed.expiresAt - Date.now() < ttlSeconds * 1000) throw new Error("Token cannot outlive the artifact");
  const repo = await requireOwned(artifacts, id, tenantId);
  try {
    const result = await repo.createToken(scope, ttlSeconds);
    return { token: result.plaintext, scope, expiresAt: result.expiresAt };
  } finally {
    (repo[DISPOSE] as (() => void) | undefined)?.call(repo);
  }
}

/** Check whether the tenant fingerprint embedded in a repository name matches. */
export async function validateArtifactOwnership(id: string, tenantId: string): Promise<boolean> {
  validateTenant(tenantId);
  const parsed = typeof id === "string" ? parseArtifactName(id) : null;
  return !!parsed && parsed.tenantFingerprint === await tenantFingerprint(tenantId);
}

/** Delete a repository only after validating its tenant-scoped identity. */
export async function deleteArtifact(
  artifacts: ArtifactsBinding,
  id: string,
  tenantId: string,
): Promise<{ id: string; deleted: boolean }> {
  const repo = await requireOwned(artifacts, id, tenantId);
  try {
    return { id, deleted: await artifacts.delete(id) };
  } finally {
    (repo[DISPOSE] as (() => void) | undefined)?.call(repo);
  }
}

/**
 * Cleanup hook for a scheduled Worker invocation. Call periodically; Artifacts does not
 * automatically delete repositories based on description or name metadata.
 */
export async function cleanupExpiredArtifacts(
  artifacts: ArtifactsBinding,
  now = Date.now(),
): Promise<{ scanned: number; deleted: number }> {
  let cursor: string | undefined;
  let scanned = 0;
  let deleted = 0;
  do {
    const page = await artifacts.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const repo of page.repos) {
      scanned++;
      const metadata = parseArtifactName(repo.name);
      if (metadata && metadata.expiresAt <= now && await artifacts.delete(repo.name)) deleted++;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return { scanned, deleted };
}
