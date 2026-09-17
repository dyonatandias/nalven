export class FinanceInputError extends Error {}

const METHODS = ["pix", "cash", "bank_transfer", "boleto", "card", "direct_debit", "other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const SERIES_MODES = ["single", "installments", "recurring"];
const FREQUENCIES = ["weekly", "monthly", "bimonthly", "quarterly", "yearly"];

export function financialTitleInput(value: unknown) {
  const input = record(value);
  const type = choice(input.type, ["payable", "receivable"], "Tipo de título inválido.");
  const supplierId = optionalId(input.supplierId);
  const customerId = optionalId(input.customerId);
  if (type === "payable" && customerId)
    throw new FinanceInputError("Conta a pagar não pode ser vinculada a cliente.");
  if (type === "receivable" && supplierId)
    throw new FinanceInputError("Conta a receber não pode ser vinculada a fornecedor.");
  return {
    type,
    description: text(input.description, 3, 240, "Descrição inválida."),
    amount: decimal(input.amount, 0.01, 100_000_000, "Valor inválido."),
    issueAt: optionalDate(input.issueAt) || startOfUtcDay(new Date()),
    competenceAt: optionalDate(input.competenceAt),
    dueAt: date(input.dueAt, "Vencimento inválido."),
    supplierId,
    customerId,
    branchId: optionalId(input.branchId),
    accountId: optionalId(input.accountId),
    costCenterId: optionalId(input.costCenterId),
    documentNumber: optional(input.documentNumber, 100),
    category: optional(input.category, 80),
    paymentMethod: input.paymentMethod ? choice(input.paymentMethod, METHODS, "Meio de pagamento inválido.") : null,
    barcode: optional(input.barcode, 160),
    priority: choice(input.priority || "normal", PRIORITIES, "Prioridade inválida."),
    notes: optional(input.notes, 1000),
  };
}

export function financialSeriesInput(value: unknown) {
  const input = record(value);
  const mode = choice(input.seriesMode || "single", SERIES_MODES, "Forma de lançamento inválida.");
  const count = mode === "single" ? 1 : integer(input.installmentCount, 2, mode === "installments" ? 120 : 60, "Quantidade de parcelas ou repetições inválida.");
  const frequency = mode === "single" ? "monthly" : choice(input.frequency || "monthly", FREQUENCIES, "Periodicidade inválida.");
  const requestId = String(input.requestId || "").trim();
  if (requestId && !/^[a-zA-Z0-9:_-]{8,120}$/.test(requestId))
    throw new FinanceInputError("Identificador da operação inválido.");
  return { mode, count, frequency, requestId: requestId || null };
}

export function financialTitleUpdateInput(value: unknown, paidAmount: number) {
  const input = financialTitleInput(value);
  if (input.amount + 0.001 < paidAmount)
    throw new FinanceInputError("O valor do título não pode ser menor que o valor já liquidado.");
  return input;
}

export function settlementInput(value: unknown, remaining: number) {
  const input = record(value);
  const amount = decimal(input.amount, 0.01, remaining, "Valor da baixa inválido ou superior ao saldo.");
  const interest = decimal(input.interest || 0, 0, 100_000_000, "Juros inválidos.");
  const discount = decimal(input.discount || 0, 0, remaining, "Desconto inválido.");
  const fee = decimal(input.fee || 0, 0, 100_000_000, "Tarifa inválida.");
  if (amount + discount > remaining + 0.001)
    throw new FinanceInputError("Baixa e desconto superam o saldo do título.");
  return {
    amount,
    interest,
    discount,
    fee,
    method: choice(input.method || "other", METHODS, "Meio de pagamento inválido."),
    accountId: optionalId(input.accountId),
    occurredAt: optionalDate(input.occurredAt) || startOfUtcDay(new Date()),
    notes: optional(input.notes, 1000),
  };
}

export function reversalInput(value: unknown) {
  const input = record(value);
  return {
    settlementId: requiredId(input.settlementId, "Baixa inválida."),
    reason: text(input.reason, 5, 500, "Informe o motivo do estorno."),
  };
}

export function rescheduleInput(value: unknown) {
  const input = record(value);
  return {
    dueAt: date(input.dueAt, "Novo vencimento inválido."),
    reason: text(input.reason, 5, 500, "Informe o motivo do reagendamento."),
  };
}

export function batchInput(value: unknown) {
  const input = record(value);
  const ids = Array.isArray(input.ids)
    ? [...new Set(input.ids.map((id) => requiredId(id, "Seleção inválida.")))]
    : [];
  if (!ids.length || ids.length > 100)
    throw new FinanceInputError("Selecione entre 1 e 100 títulos.");
  const action = choice(input.action, ["cancel", "reschedule", "priority"], "Ação em lote inválida.");
  return {
    ids,
    action,
    reason: action === "priority" ? null : text(input.reason, 5, 500, "Informe o motivo da alteração."),
    dueAt: action === "reschedule" ? date(input.dueAt, "Novo vencimento inválido.") : null,
    priority: action === "priority" ? choice(input.priority, PRIORITIES, "Prioridade inválida.") : null,
  };
}

export function addFrequency(dateValue: Date, frequency: string, offset: number) {
  const dateCopy = new Date(dateValue);
  if (frequency === "weekly") {
    dateCopy.setUTCDate(dateCopy.getUTCDate() + offset * 7);
    return dateCopy;
  }
  const multiplier = frequency === "bimonthly" ? 2 : frequency === "quarterly" ? 3 : frequency === "yearly" ? 12 : 1;
  const originalDay = dateCopy.getUTCDate();
  dateCopy.setUTCDate(1);
  dateCopy.setUTCMonth(dateCopy.getUTCMonth() + offset * multiplier);
  const lastDay = new Date(Date.UTC(dateCopy.getUTCFullYear(), dateCopy.getUTCMonth() + 1, 0)).getUTCDate();
  dateCopy.setUTCDate(Math.min(originalDay, lastDay));
  return dateCopy;
}

export function splitAmount(total: number, count: number) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FinanceInputError("Dados financeiros inválidos.");
  return value as Record<string, unknown>;
}
function text(value: unknown, min: number, max: number, message: string) {
  const result = String(value || "").trim();
  if (result.length < min || result.length > max) throw new FinanceInputError(message);
  return result;
}
function optional(value: unknown, max: number) {
  const result = String(value || "").trim();
  if (result.length > max) throw new FinanceInputError("Campo excede o tamanho permitido.");
  return result || null;
}
function optionalId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return requiredId(value, "Vínculo inválido.");
}
function requiredId(value: unknown, message: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new FinanceInputError(message);
  return id;
}
function decimal(value: unknown, min: number, max: number, message: string) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new FinanceInputError(message);
  return Math.round(result * 100) / 100;
}
function integer(value: unknown, min: number, max: number, message: string) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new FinanceInputError(message);
  return result;
}
function choice(value: unknown, choices: string[], message: string) {
  const result = String(value);
  if (!choices.includes(result)) throw new FinanceInputError(message);
  return result;
}
function optionalDate(value: unknown) {
  return value ? date(value, "Data inválida.") : null;
}
function date(value: unknown, message: string) {
  const source = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source)) throw new FinanceInputError(message);
  const result = new Date(`${source}T00:00:00.000Z`);
  if (Number.isNaN(result.valueOf()) || result.toISOString().slice(0, 10) !== source)
    throw new FinanceInputError(message);
  return result;
}
function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
