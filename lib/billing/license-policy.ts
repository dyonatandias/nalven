export function licensePolicy(value: unknown): { licenseTimeoutMs: number; licenseCacheSeconds: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const timeout = input.licenseTimeoutMs, cache = input.licenseCacheSeconds;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1000 || timeout > 30000 || typeof cache !== "number" || !Number.isInteger(cache) || cache < 30 || cache > 3600) return null;
  return { licenseTimeoutMs: timeout, licenseCacheSeconds: cache };
}
