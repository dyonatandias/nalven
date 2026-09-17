export class InventoryInputError extends Error {}

export function warehouseInput(value: unknown) {
  const input = record(value);
  const name = required(input.name, 2, 120, "Nome do depósito inválido.");
  const rawCode = String(input.code || name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  if (rawCode.length < 2) throw new InventoryInputError("Código do depósito inválido.");
  return { name, code: rawCode, description: optional(input.description, 500) };
}

export function countInput(value: unknown) { const input = record(value); return { warehouseId: positiveId(input.warehouseId, "Depósito inválido."), blind: input.blind !== false && String(input.blind) !== "false", notes: optional(input.notes, 1000) }; }

export function finalizedCountInput(value: unknown) {
  const input = record(value);
  const countId = positiveId(input.countId, "Contagem inválida.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 5000) throw new InventoryInputError("Informe os produtos contados.");
  const items = input.items.map(value => { const item = record(value); return { itemId: positiveId(item.itemId, "Item de contagem inválido."), countedQuantity: quantity(item.countedQuantity, true) }; });
  if (new Set(items.map(item => item.itemId)).size !== items.length) throw new InventoryInputError("Itens de contagem repetidos.");
  return { countId, items };
}

export function transferInput(value: unknown) {
  const input = record(value);
  const fromWarehouseId = positiveId(input.fromWarehouseId, "Depósito de origem inválido.");
  const toWarehouseId = positiveId(input.toWarehouseId, "Depósito de destino inválido.");
  if (fromWarehouseId === toWarehouseId) throw new InventoryInputError("Origem e destino precisam ser diferentes.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new InventoryInputError("Adicione ao menos um produto à transferência.");
  const items = input.items.map(value => { const item = record(value); return { productId: positiveId(item.productId, "Produto inválido."), quantity: quantity(item.quantity, false) }; });
  if (new Set(items.map(item => item.productId)).size !== items.length) throw new InventoryInputError("Cada produto pode aparecer somente uma vez.");
  return { fromWarehouseId, toWarehouseId, items, notes: optional(input.notes, 1000) };
}

export function entityId(value: unknown, message = "Registro inválido.") { return positiveId(value, message); }
function record(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new InventoryInputError("Dados de inventário inválidos."); return value as Record<string, unknown>; }
function required(value: unknown, min: number, max: number, message: string) { const text = String(value || "").trim(); if (text.length < min || text.length > max) throw new InventoryInputError(message); return text; }
function optional(value: unknown, max: number) { const text = String(value || "").trim(); if (text.length > max) throw new InventoryInputError("Campo excede o tamanho permitido."); return text || null; }
function positiveId(value: unknown, message: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new InventoryInputError(message); return id; }
function quantity(value: unknown, allowZero: boolean) { const number = Number(value); if (!Number.isFinite(number) || number < (allowZero ? 0 : 0.0001) || number > 100000000) throw new InventoryInputError("Quantidade inválida."); return Math.round(number * 10000) / 10000; }
