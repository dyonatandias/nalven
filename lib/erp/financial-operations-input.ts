export class FinancialOperationsInputError extends Error {}
export function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FinancialOperationsInputError("Dados inválidos.");
  return value as Record<string, unknown>;
}
export function entityId(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new FinancialOperationsInputError("Registro inválido.");
  return parsed;
}
export function amount(value: unknown, allowZero = false) {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < (allowZero ? 0 : 0.01) ||
    parsed > 1e12
  )
    throw new FinancialOperationsInputError("Valor inválido.");
  return Math.round(parsed * 100) / 100;
}
export function text(value: unknown, label: string, max = 180) {
  const parsed = String(value || "").trim();
  if (parsed.length < 2 || parsed.length > max)
    throw new FinancialOperationsInputError(`${label} inválido.`);
  return parsed;
}
export function optional(value: unknown, max = 500) {
  const parsed = String(value || "").trim();
  if (parsed.length > max)
    throw new FinancialOperationsInputError("Texto muito longo.");
  return parsed || null;
}
export function choice(value: unknown, allowed: string[]) {
  const parsed = String(value);
  if (!allowed.includes(parsed))
    throw new FinancialOperationsInputError("Opção inválida.");
  return parsed;
}
export function date(value: unknown) {
  const parsed = new Date(`${String(value)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()))
    throw new FinancialOperationsInputError("Data inválida.");
  return parsed;
}
export function integer(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new FinancialOperationsInputError("Número inválido.");
  return parsed;
}
