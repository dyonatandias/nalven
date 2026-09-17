const marginCache = new Map<string, { expiresAt: number; value: unknown }>();

export function getMarginCache(key: string) {
  const hit = marginCache.get(key);
  if (!hit || hit.expiresAt <= Date.now()) {
    if (hit) marginCache.delete(key);
    return null;
  }
  return hit.value;
}

export function setMarginCache(key: string, value: unknown) {
  marginCache.set(key, { expiresAt: Date.now() + 5 * 60_000, value });
}

export function invalidateMarginReportCache() {
  marginCache.clear();
}
