const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/u;
const PRISMA_CODE = /^P\d{4}$/u;
const NESTED_ERROR_KEYS = ["meta", "cause", "driverAdapterError", "error"] as const;

export function postgresErrorCode(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 6) return "";
  const record = error as Record<string, unknown>;
  for (const key of ["originalCode", "sqlState", "code"] as const) {
    const candidate = String(record[key] ?? "");
    if (POSTGRES_SQLSTATE.test(candidate) && !PRISMA_CODE.test(candidate)) return candidate;
  }
  for (const key of NESTED_ERROR_KEYS) {
    const nested = postgresErrorCode(record[key], depth + 1);
    if (nested) return nested;
  }
  const direct = String(record.code ?? "");
  return PRISMA_CODE.test(direct) ? direct : "";
}
