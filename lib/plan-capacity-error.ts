export const PLAN_CAPACITY_MESSAGE = "O plano não comporta a quantidade de usuários ativos. Amplie o limite ou desative acessos antes de continuar.";

/** Match only our database constraint marker; never expose driver error details. */
export function isPlanCapacityError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const value = error as Record<string, unknown>;
  if (typeof value.message === "string" && value.message.includes("NALVEN_PLAN_CAPACITY")) return true;
  if (typeof value.database_error === "string" && value.database_error.includes("NALVEN_PLAN_CAPACITY")) return true;
  if (typeof value.originalMessage === "string" && value.originalMessage.includes("NALVEN_PLAN_CAPACITY")) return true;
  return [value.meta, value.cause, value.driverAdapterError, value.originalError].some(cause => isPlanCapacityError(cause, depth + 1));
}
