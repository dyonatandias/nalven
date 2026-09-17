export class PurchaseInputError extends Error {}

export type PurchaseOrderInput = {
  supplierId: number;
  expectedAt: Date | null;
  dueAt: Date;
  freight: number;
  discount: number;
  notes: string | null;
  items: Array<{ productId: number; quantity: number; unitCost: number }>;
};

export function purchaseOrderInput(value: unknown): PurchaseOrderInput {
  const input = record(value, "Dados do pedido inválidos.");
  const supplierId = positiveInteger(input.supplierId, "Fornecedor inválido.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new PurchaseInputError("Adicione de 1 a 100 produtos ao pedido.");
  const items = input.items.map(item => {
    const row = record(item, "Item do pedido inválido.");
    return { productId: positiveInteger(row.productId, "Produto inválido."), quantity: decimal(row.quantity, 0.0001, 1000000, "Quantidade inválida."), unitCost: decimal(row.unitCost, 0, 100000000, "Custo unitário inválido.") };
  });
  if (new Set(items.map(item => item.productId)).size !== items.length) throw new PurchaseInputError("Cada produto pode aparecer somente uma vez no pedido.");
  const freight = decimal(input.freight || 0, 0, 100000000, "Frete inválido.");
  const discount = decimal(input.discount || 0, 0, 100000000, "Desconto inválido.");
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  if (discount > subtotal + freight) throw new PurchaseInputError("O desconto não pode superar o valor do pedido.");
  return { supplierId, expectedAt: optionalDate(input.expectedAt, "Previsão inválida."), dueAt: requiredDate(input.dueAt, "Vencimento inválido."), freight, discount, notes: optionalText(input.notes, 2000), items };
}

export function receiptInput(value: unknown) {
  const input = record(value, "Dados do recebimento inválidos.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new PurchaseInputError("Informe ao menos um item recebido.");
  const items = input.items.map(item => {
    const row = record(item, "Item recebido inválido.");
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity < 0.000001 || quantity > 1000000 || Math.abs(quantity * 1000000 - Math.round(quantity * 1000000)) > 0.00001) throw new PurchaseInputError("Quantidade recebida inválida. Use até seis casas decimais.");
    return { itemId: positiveInteger(row.itemId, "Item do pedido inválido."), quantity: Math.round(quantity * 1000000) / 1000000 };
  });
  if (new Set(items.map(item => item.itemId)).size !== items.length) throw new PurchaseInputError("Cada item pode aparecer somente uma vez no recebimento.");
  return { items, notes: optionalText(input.notes, 1000) };
}

function record(value: unknown, message: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PurchaseInputError(message); return value as Record<string, unknown>; }
function positiveInteger(value: unknown, message: string) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new PurchaseInputError(message); return number; }
function decimal(value: unknown, min: number, max: number, message: string) { const number = Number(value); if (!Number.isFinite(number) || number < min || number > max) throw new PurchaseInputError(message); return Math.round(number * 10000) / 10000; }
function optionalText(value: unknown, max: number) { const text = String(value || "").trim(); if (text.length > max) throw new PurchaseInputError("Observações excedem o tamanho permitido."); return text || null; }
function requiredDate(value: unknown, message: string) { const parsed = optionalDate(value, message); if (!parsed) throw new PurchaseInputError(message); return parsed; }
function optionalDate(value: unknown, message: string) { const text = String(value || "").trim(); if (!text) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new PurchaseInputError(message); const date = new Date(`${text}T12:00:00.000Z`); if (Number.isNaN(date.getTime())) throw new PurchaseInputError(message); return date; }
