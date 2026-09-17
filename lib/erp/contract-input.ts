export class ContractInputError extends Error {}
export function contractInput(v: unknown) {
  const x = rec(v),
    amount = Number(x.amount),
    billingDay = Number(x.billingDay || 10),
    sla = x.slaHours ? Number(x.slaHours) : null,
    start = date(x.startDate, "Data inicial inválida."),
    end = x.endDate ? date(x.endDate, "Data final inválida.") : null;
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isInteger(billingDay) ||
    billingDay < 1 ||
    billingDay > 28 ||
    (sla !== null && (!Number.isInteger(sla) || sla < 1 || sla > 8760)) ||
    (end && end < start)
  )
    throw new ContractInputError(
      "Valor, vencimento, SLA ou vigência inválida.",
    );
  return {
    name: text(x.name, 2, 180),
    customerId: id(x.customerId),
    startDate: start,
    endDate: end,
    billingDay,
    amount,
    adjustmentIndex: opt(x.adjustmentIndex, 30),
    nextBillingAt: x.nextBillingAt
      ? date(x.nextBillingAt, "Próxima cobrança inválida.")
      : start,
    slaHours: sla,
    notes: opt(x.notes, 2000),
  };
}
export function contractId(v: unknown) {
  return id(v);
}
export function adjustmentInput(v: unknown) {
  const x = rec(v),
    percentage = Number(x.percentage);
  if (!Number.isFinite(percentage) || percentage <= -100 || percentage > 1000)
    throw new ContractInputError("Percentual inválido.");
  return {
    percentage,
    reason: text(x.reason, 2, 300),
    effectiveAt: x.effectiveAt
      ? date(x.effectiveAt, "Data inválida.")
      : new Date(),
  };
}
function rec(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new ContractInputError("Dados inválidos.");
  return v as Record<string, unknown>;
}
function id(v: unknown) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new ContractInputError("Registro inválido.");
  return n;
}
function text(v: unknown, min: number, max = 180) {
  const s = String(v || "").trim();
  if (s.length < min || s.length > max)
    throw new ContractInputError("Campo inválido.");
  return s;
}
function opt(v: unknown, max: number) {
  const s = String(v || "").trim();
  if (s.length > max) throw new ContractInputError("Campo excede o limite.");
  return s || null;
}
function date(v: unknown, m: string) {
  const d = new Date(`${String(v)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ContractInputError(m);
  return d;
}
