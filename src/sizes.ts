/** Cloudflare named instance types supported by CloudflareBoxes. */
export const INSTANCE_SIZES = ['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'] as const;
export type InstanceSize = typeof INSTANCE_SIZES[number];
export const DEFAULT_INSTANCE_SIZE: InstanceSize = 'standard-2';
// Boxes created before size selection used Cloudflare's default, lite.
export const LEGACY_INSTANCE_SIZE: InstanceSize = 'lite';
export function isInstanceSize(value: unknown): value is InstanceSize {
  return typeof value === 'string' && (INSTANCE_SIZES as readonly string[]).includes(value);
}
