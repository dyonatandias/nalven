import { createHash } from "node:crypto";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { calculatePosReturnRefundCents } from "@/lib/erp/pos-returns";

const POST_SALE_APPROVAL_VERSION = 1;
const REJECTED_REFUND_STATUSES = new Set(["failed", "cancelled", "declined"]);

export type PosPostSaleApprovalAction = "sale.cancel" | "return.create";
export type PosReturnDisposition = "restock" | "quarantine" | "discard";

export type PosCancelApprovalIntent = {
  sessionId: number;
};

export type PosReturnApprovalIntent = {
  sessionId: number;
  items: Array<{ saleItemId: number; quantityMicros: number; disposition: PosReturnDisposition }>;
  reasonCode: string;
  description: string;
  exchangeRequested: boolean;
};

type ApprovalSaleItem = {
  id: number;
  productId: number;
  productName: string;
  variationId: number | null;
  quantity: number;
  returnedQuantity: number;
  unitPriceCents: number;
  totalCents: number;
  returnedCents: number;
  kitComponents?: Array<{
    id: string;
    bomId: string;
    bomVersion: number;
    productId: number;
    variationId: number | null;
    componentScopeKey: string;
    unitQuantityMicros: bigint;
    quantityMicros: bigint;
    returnedMicros: bigint;
  }>;
};

type ApprovalPayment = {
  id: string;
  method: string;
  status: string;
  amountCents: number;
  provider: string | null;
  metadata: unknown;
  refunds: Array<{ id: string; status: string; amountCents: number }>;
};

export type PosPostSaleApprovalSale = {
  id: number;
  branchId: number | null;
  warehouseId: number | null;
  sessionId: number | null;
  customerId: number | null;
  saleNumber: string;
  status: string;
  totalCents: number;
  changeCents: number;
  items: ApprovalSaleItem[];
  payments: ApprovalPayment[];
};

type SaleSnapshot = {
  id: number;
  branchId: number;
  sessionId: number | null;
  warehouseId: number | null;
  customerId: number | null;
  saleNumber: string;
  status: string;
  totalCents: number;
  changeCents: number;
  items: Array<{
    saleItemId: number;
    productId: number;
    productName: string;
    variationId: number | null;
    quantityMicros: number;
    returnedQuantityMicros: number;
    unitPriceCents: number;
    totalCents: number;
    returnedCents: number;
    kitComponents: Array<{
      componentId: string;
      bomId: string;
      bomVersion: number;
      productId: number;
      variationId: number | null;
      componentScopeKey: string;
      unitQuantityMicros: string;
      quantityMicros: string;
      returnedMicros: string;
    }>;
  }>;
  payments: Array<{
    paymentId: string;
    method: string;
    provider: string | null;
    status: string;
    amountCents: number;
    reservedRefundCents: number;
    availableRefundCents: number;
    valueAccountId: string | null;
    valueAmountUnits: number | null;
  }>;
};

type PosCancelApprovalPayload = {
  schemaVersion: typeof POST_SALE_APPROVAL_VERSION;
  action: "sale.cancel";
  sale: SaleSnapshot;
  operation: {
    processingSessionId: number;
    registerId: number;
    reason: string;
    inventoryDisposition: "restock";
    refundTotalCents: number;
  };
};

type PosReturnApprovalPayload = {
  schemaVersion: typeof POST_SALE_APPROVAL_VERSION;
  action: "return.create";
  sale: SaleSnapshot;
  operation: {
    processingSessionId: number;
    registerId: number;
    reasonCode: string;
    description: string;
    exchangeRequested: boolean;
    items: Array<{
      saleItemId: number;
      quantityMicros: number;
      disposition: PosReturnDisposition;
      refundCents: number;
    }>;
    refundTotalCents: number;
    allocations: Array<{
      paymentId: string;
      method: string;
      provider: string | null;
      amountCents: number;
      valueAccountId: string | null;
      valueRefundUnits: number | null;
    }>;
  };
};

export type PosPostSaleApprovalContext = (PosCancelApprovalPayload | PosReturnApprovalPayload) & { contentHash: string };

export function isPosPostSaleApprovalAction(action: string): action is PosPostSaleApprovalAction {
  return action === "sale.cancel" || action === "return.create";
}

export function normalizePosPostSaleApprovalIntent(
  action: PosPostSaleApprovalAction,
  context: Record<string, unknown>,
  entityId: string | null,
  approvalReason: string,
): PosCancelApprovalIntent | PosReturnApprovalIntent {
  const saleId = positiveInteger(entityId, "Venda");
  if (String(saleId) !== entityId) throw new PosDomainError("Identificador da venda inválido para aprovação.");
  if (action === "sale.cancel") {
    exactKeys(context, ["sessionId"], "cancelamento");
    return { sessionId: positiveInteger(context.sessionId, "Turno") };
  }
  exactKeys(context, ["sessionId", "items", "reasonCode", "description", "exchangeRequested"], "devolução");
  if (!Array.isArray(context.items) || !context.items.length || context.items.length > 200) {
    throw new PosDomainError("A aprovação da devolução exige de 1 a 200 itens.");
  }
  const items = context.items.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PosDomainError("Item inválido na aprovação da devolução.");
    const item = raw as Record<string, unknown>;
    exactKeys(item, ["saleItemId", "quantity", "disposition"], "item da devolução");
    return {
      saleItemId: positiveInteger(item.saleItemId, "Item"),
      quantityMicros: quantityMicros(item.quantity),
      disposition: disposition(item.disposition),
    };
  }).sort((left, right) => left.saleItemId - right.saleItemId);
  if (new Set(items.map((item) => item.saleItemId)).size !== items.length) {
    throw new PosDomainError("Cada item deve aparecer uma única vez na aprovação da devolução.");
  }
  const reasonCode = boundedText(context.reasonCode, 1, 60, "Motivo da devolução");
  const description = boundedText(context.description, 8, 500, "Descrição da devolução");
  if (description !== approvalReason) throw new PosDomainError("A justificativa da aprovação deve ser a mesma descrição da devolução.");
  if (typeof context.exchangeRequested !== "boolean") throw new PosDomainError("Opção de troca inválida na aprovação.");
  return {
    sessionId: positiveInteger(context.sessionId, "Turno"),
    items,
    reasonCode,
    description,
    exchangeRequested: context.exchangeRequested,
  };
}

export function posReturnApprovalIntentToRequestContext(intent: PosReturnApprovalIntent): Record<string, unknown> {
  return {
    sessionId: intent.sessionId,
    items: intent.items.map((item) => ({
      saleItemId: item.saleItemId,
      quantity: item.quantityMicros / 1_000_000,
      disposition: item.disposition,
    })),
    reasonCode: intent.reasonCode,
    description: intent.description,
    exchangeRequested: intent.exchangeRequested,
  };
}

export function buildPosCancelApprovalContext(input: {
  sale: PosPostSaleApprovalSale;
  branchId: number;
  processingSessionId: number;
  registerId: number;
  reason: string;
}): PosPostSaleApprovalContext {
  assertSaleScope(input.sale, input.branchId, ["completed"]);
  if (input.sale.sessionId !== input.processingSessionId) throw new PosDomainError("O cancelamento deve ser aprovado no turno original da venda.");
  const sale = saleSnapshot(input.sale, input.branchId);
  if (sale.payments.some((payment) => payment.reservedRefundCents !== 0)) {
    throw new PosDomainError("A venda já possui estorno financeiro e não pode receber aprovação de cancelamento integral.");
  }
  const refundTotalCents = sale.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  if (refundTotalCents !== sale.totalCents) throw new PosDomainError("O saldo financeiro da venda não corresponde ao total; o cancelamento foi bloqueado.");
  return withContentHash({
    schemaVersion: POST_SALE_APPROVAL_VERSION,
    action: "sale.cancel",
    sale,
    operation: {
      processingSessionId: input.processingSessionId,
      registerId: input.registerId,
      reason: boundedText(input.reason, 1, 500, "Motivo do cancelamento"),
      inventoryDisposition: "restock",
      refundTotalCents,
    },
  });
}

export function buildPosReturnApprovalContext(input: {
  sale: PosPostSaleApprovalSale;
  branchId: number;
  processingSessionId: number;
  registerId: number;
  intent: PosReturnApprovalIntent;
}): PosPostSaleApprovalContext {
  assertSaleScope(input.sale, input.branchId, ["completed", "partially_returned"]);
  if (input.processingSessionId !== input.intent.sessionId) throw new PosDomainError("O turno da aprovação não corresponde ao turno da devolução.");
  const sale = saleSnapshot(input.sale, input.branchId);
  const itemById = new Map(sale.items.map((item) => [item.saleItemId, item]));
  const items = input.intent.items.map((requested) => {
    const item = itemById.get(requested.saleItemId);
    if (!item || requested.quantityMicros > item.quantityMicros - item.returnedQuantityMicros) {
      throw new PosDomainError("Quantidade de devolução superior ao saldo do item.");
    }
    return {
      ...requested,
      refundCents: calculatePosReturnRefundCents({
        totalQuantity: item.quantityMicros,
        returnedQuantity: item.returnedQuantityMicros,
        totalCents: item.totalCents,
        returnedCents: item.returnedCents,
      }, requested.quantityMicros),
    };
  });
  const refundTotalCents = items.reduce((sum, item) => sum + item.refundCents, 0);
  let remaining = refundTotalCents;
  const allocations = sale.payments.flatMap((payment) => {
    const amountCents = Math.min(payment.availableRefundCents, remaining);
    remaining -= amountCents;
    return amountCents > 0 ? [{
      paymentId: payment.paymentId,
      method: payment.method,
      provider: payment.provider,
      amountCents,
      valueAccountId: payment.valueAccountId,
      valueRefundUnits: payment.valueAccountId && payment.valueAmountUnits != null
        ? proportionalValueRefundUnits(payment.valueAmountUnits, payment.amountCents, amountCents)
        : null,
    }] : [];
  });
  if (remaining > 0) throw new PosDomainError("O valor da devolução supera o saldo financeiro disponível da venda.");
  return withContentHash({
    schemaVersion: POST_SALE_APPROVAL_VERSION,
    action: "return.create",
    sale,
    operation: {
      processingSessionId: input.processingSessionId,
      registerId: input.registerId,
      reasonCode: input.intent.reasonCode,
      description: input.intent.description,
      exchangeRequested: input.intent.exchangeRequested,
      items,
      refundTotalCents,
      allocations,
    },
  });
}

export function assertPosPostSaleApprovalContext(actual: unknown, expected: PosPostSaleApprovalContext) {
  const normalized = validatedContext(actual);
  if (canonicalJson(normalized) !== canonicalJson(expected)) {
    throw new PosDomainError("A aprovação não corresponde ao conteúdo financeiro atual da operação.");
  }
}

export function assertPosPostSaleApprovalReplay(
  action: PosPostSaleApprovalAction,
  incomingIntent: PosCancelApprovalIntent | PosReturnApprovalIntent,
  storedContext: unknown,
) {
  const stored = validatedContext(storedContext);
  if (stored.action !== action) throw new PosDomainError("A chave de idempotência pertence a outra operação aprovada.");
  const matches = action === "sale.cancel"
    ? incomingIntent.sessionId === stored.operation.processingSessionId
    : stored.action === "return.create" && canonicalJson(incomingIntent) === canonicalJson({
      sessionId: stored.operation.processingSessionId,
      items: stored.operation.items.map(({ saleItemId, quantityMicros, disposition }) => ({ saleItemId, quantityMicros, disposition })),
      reasonCode: stored.operation.reasonCode,
      description: stored.operation.description,
      exchangeRequested: stored.operation.exchangeRequested,
    });
  if (!matches) throw new PosDomainError("A chave de idempotência já foi usada com outro pedido de aprovação.");
}

function saleSnapshot(sale: PosPostSaleApprovalSale, branchId: number): SaleSnapshot {
  return {
    id: sale.id,
    branchId,
    sessionId: sale.sessionId,
    warehouseId: sale.warehouseId,
    customerId: sale.customerId,
    saleNumber: boundedText(sale.saleNumber, 1, 160, "Número da venda"),
    status: boundedText(sale.status, 1, 80, "Estado da venda"),
    totalCents: nonNegativeInteger(sale.totalCents, "Total da venda"),
    changeCents: nonNegativeInteger(sale.changeCents, "Troco da venda"),
    items: [...sale.items].sort((left, right) => left.id - right.id).map((item) => ({
      saleItemId: positiveInteger(item.id, "Item"),
      productId: positiveInteger(item.productId, "Produto"),
      productName: boundedText(item.productName, 1, 500, "Produto"),
      variationId: item.variationId == null ? null : positiveInteger(item.variationId, "Variação"),
      quantityMicros: persistedQuantityMicros(item.quantity, "Quantidade vendida"),
      returnedQuantityMicros: persistedQuantityMicros(item.returnedQuantity, "Quantidade devolvida"),
      unitPriceCents: nonNegativeInteger(item.unitPriceCents, "Preço unitário"),
      totalCents: nonNegativeInteger(item.totalCents, "Total do item"),
      returnedCents: nonNegativeInteger(item.returnedCents, "Valor devolvido"),
      kitComponents: [...(item.kitComponents ?? [])].sort((left, right) => left.id.localeCompare(right.id)).map((component) => ({
        componentId: boundedText(component.id, 1, 160, "Componente vendido"),
        bomId: boundedText(component.bomId, 1, 160, "BOM vendido"),
        bomVersion: positiveInteger(component.bomVersion, "Versão da BOM"),
        productId: positiveInteger(component.productId, "Produto componente"),
        variationId: component.variationId == null ? null : positiveInteger(component.variationId, "Variação componente"),
        componentScopeKey: boundedText(component.componentScopeKey, 1, 500, "Escopo do componente"),
        unitQuantityMicros: nonNegativeBigIntText(component.unitQuantityMicros, "Quantidade unitária do componente"),
        quantityMicros: nonNegativeBigIntText(component.quantityMicros, "Quantidade do componente"),
        returnedMicros: nonNegativeBigIntText(component.returnedMicros, "Quantidade devolvida do componente"),
      })),
    })),
    payments: sale.payments.map((payment) => {
      const reservedRefundCents = payment.refunds
        .filter((refund) => !REJECTED_REFUND_STATUSES.has(refund.status))
        .reduce((sum, refund) => sum + nonNegativeInteger(refund.amountCents, "Estorno"), 0);
      if (reservedRefundCents > payment.amountCents) throw new PosDomainError("Os estornos da venda excedem o pagamento original.");
      const value = valueDestination(payment.method, payment.metadata);
      return {
        paymentId: boundedText(payment.id, 1, 160, "Pagamento"),
        method: boundedText(payment.method, 1, 80, "Forma de pagamento"),
        provider: nullableText(payment.provider, 160),
        status: boundedText(payment.status, 1, 80, "Estado do pagamento"),
        amountCents: nonNegativeInteger(payment.amountCents, "Pagamento"),
        reservedRefundCents,
        availableRefundCents: payment.amountCents - reservedRefundCents,
        ...value,
      };
    }),
  };
}

function valueDestination(method: string, metadata: unknown) {
  if (method !== "store_credit") return { valueAccountId: null, valueAmountUnits: null };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new PosDomainError("Pagamento por saldo sem destino íntegro para aprovação.");
  const record = metadata as Record<string, unknown>;
  const valueAccountId = String(record.valueAccountId ?? "");
  const valueAmountUnits = Number(record.valueAmountUnits);
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(valueAccountId) || !Number.isSafeInteger(valueAmountUnits) || valueAmountUnits <= 0) {
    throw new PosDomainError("Pagamento por saldo sem destino íntegro para aprovação.");
  }
  return { valueAccountId, valueAmountUnits };
}

function proportionalValueRefundUnits(paymentUnits: number, paymentCents: number, refundCents: number) {
  const numerator = BigInt(paymentUnits) * BigInt(refundCents), divisor = BigInt(paymentCents);
  if (paymentCents <= 0 || refundCents <= 0 || refundCents > paymentCents || numerator % divisor !== BigInt(0)) {
    throw new PosDomainError("A devolução parcial não corresponde a unidades inteiras do saldo utilizado.");
  }
  const result = numerator / divisor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new PosDomainError("O estorno do saldo excede o limite seguro.");
  return Number(result);
}

function assertSaleScope(sale: PosPostSaleApprovalSale, branchId: number, statuses: string[]) {
  if (sale.branchId !== branchId) throw new PosDomainError("Venda não encontrada nesta filial.");
  if (!statuses.includes(sale.status)) throw new PosDomainError("Venda não elegível para esta aprovação.");
}

function validatedContext(value: unknown): PosPostSaleApprovalContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosDomainError("A aprovação não possui snapshot financeiro autoritativo.");
  const context = value as Record<string, unknown>;
  if (context.schemaVersion !== POST_SALE_APPROVAL_VERSION || !isPosPostSaleApprovalAction(String(context.action)) || typeof context.contentHash !== "string") {
    throw new PosDomainError("A aprovação não possui snapshot financeiro autoritativo.");
  }
  if (!context.sale || typeof context.sale !== "object" || Array.isArray(context.sale) || !context.operation || typeof context.operation !== "object" || Array.isArray(context.operation)) {
    throw new PosDomainError("A aprovação não possui snapshot financeiro autoritativo.");
  }
  const operation = context.operation as Record<string, unknown>;
  if (!Number.isSafeInteger(operation.processingSessionId) || context.action === "return.create" && !Array.isArray(operation.items)) {
    throw new PosDomainError("A aprovação não possui snapshot financeiro autoritativo.");
  }
  const { contentHash, ...payload } = context;
  if (contentHash !== hash(payload)) throw new PosDomainError("O snapshot financeiro da aprovação está corrompido.");
  return context as PosPostSaleApprovalContext;
}

function withContentHash<T extends PosCancelApprovalPayload | PosReturnApprovalPayload>(payload: T): T & { contentHash: string } {
  return { ...payload, contentHash: hash(payload) };
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const accepted = new Set(allowed);
  const extra = Object.keys(value).find((key) => !accepted.has(key));
  const missing = allowed.find((key) => !Object.hasOwn(value, key));
  if (extra || missing) throw new PosDomainError(`O contexto de ${label} deve conter somente os campos operacionais exigidos.`);
}

function quantityMicros(value: unknown) {
  const amount = Number(value);
  const micros = Math.round(amount * 1_000_000);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999 || micros % 1000 !== 0 || Math.abs(micros / 1_000_000 - amount) > 1e-9) {
    throw new PosDomainError("Quantidade inválida na aprovação da devolução.");
  }
  return micros;
}

function persistedQuantityMicros(value: unknown, label: string) {
  const amount = Number(value);
  const micros = Math.round(amount * 1_000_000);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(micros)) throw new PosDomainError(`${label} inválida.`);
  return micros;
}

function disposition(value: unknown): PosReturnDisposition {
  const result = String(value ?? "");
  if (!new Set(["restock", "quarantine", "discard"]).has(result)) throw new PosDomainError("Destino inválido na aprovação da devolução.");
  return result as PosReturnDisposition;
}

function positiveInteger(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function nonNegativeBigIntText(value: unknown, label: string) {
  if (typeof value !== "bigint" || value < BigInt(0)) throw new PosDomainError(`${label} inválida.`);
  return value.toString();
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string) {
  const result = String(value ?? "").trim();
  if (result.length < minimum || result.length > maximum) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function nullableText(value: unknown, maximum: number) {
  if (value == null) return null;
  const result = String(value).trim();
  if (!result) return null;
  if (result.length > maximum) throw new PosDomainError("Texto do snapshot financeiro excede o limite permitido.");
  return result;
}

function hash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
