export class ProductionInputError extends Error {}
export function bomInput(v: unknown) {
  const x = rec(v),
    rows = Array.isArray(x.items) ? x.items : [];
  if (!rows.length) throw new ProductionInputError("Informe os materiais.");
  const seen = new Set<number>(),
    items = rows.map((raw) => {
      const r = rec(raw),
        productId = id(r.productId);
      if (seen.has(productId))
        throw new ProductionInputError("Material repetido.");
      seen.add(productId);
      return {
        productId,
        quantity: num(r.quantity, 0.0001),
        wastePercent: num(r.wastePercent || 0, 0, 100),
      };
    });
  const outputProductId = id(x.outputProductId);
  if (seen.has(outputProductId))
    throw new ProductionInputError(
      "O produto acabado não pode ser seu próprio material.",
    );
  return {
    name: text(x.name),
    code: String(x.code || x.name)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .slice(0, 40),
    outputProductId,
    yieldQuantity: num(x.yieldQuantity || 1, 0.0001),
    notes:
      String(x.notes || "")
        .trim()
        .slice(0, 2000) || null,
    items,
  };
}
export function productionOrderInput(v: unknown) {
  const x = rec(v);
  return {
    bomId: id(x.bomId),
    warehouseId: id(x.warehouseId),
    plannedQuantity: num(x.plannedQuantity, 0.0001),
    priority: choice(x.priority || "normal", [
      "low",
      "normal",
      "high",
      "urgent",
    ]),
    tags: tags(x.tags),
    assignedTo: optionalText(x.assignedTo, 120),
    dueAt: date(x.dueAt),
    notes:
      String(x.notes || "")
        .trim()
        .slice(0, 2000) || null,
  };
}
export function productionOrderMetadataInput(v: unknown) {
  const x = rec(v);
  return {
    orderId: id(x.orderId),
    priority: choice(x.priority || "normal", [
      "low",
      "normal",
      "high",
      "urgent",
    ]),
    tags: tags(x.tags),
    assignedTo: optionalText(x.assignedTo, 120),
    dueAt: date(x.dueAt),
    notes: optionalText(x.notes, 2000),
  };
}
export function productionId(v: unknown) {
  return id(v);
}
function rec(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new ProductionInputError("Dados inválidos.");
  return v as Record<string, unknown>;
}
function id(v: unknown) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new ProductionInputError("Registro inválido.");
  return n;
}
function num(v: unknown, min: number, max = 1e8) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new ProductionInputError("Quantidade inválida.");
  return n;
}
function text(v: unknown) {
  const s = String(v || "").trim();
  if (s.length < 2 || s.length > 180)
    throw new ProductionInputError("Nome inválido.");
  return s;
}
function optionalText(v: unknown, max: number) {
  const value = String(v || "").trim();
  if (value.length > max) throw new ProductionInputError("Texto muito longo.");
  return value || null;
}
function choice(v: unknown, values: string[]) {
  const value = String(v || "");
  if (!values.includes(value))
    throw new ProductionInputError("Opção inválida.");
  return value;
}
function tags(v: unknown) {
  const values = Array.isArray(v) ? v : String(v || "").split(",");
  const normalized = [
    ...new Set(
      values
        .map((item) => String(item).trim().replace(/^#+/, ""))
        .filter(Boolean),
    ),
  ];
  if (normalized.length > 12 || normalized.some((item) => item.length > 30))
    throw new ProductionInputError(
      "Use no máximo 12 etiquetas de até 30 caracteres.",
    );
  return normalized;
}
function date(v: unknown) {
  const value = String(v || "").trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ProductionInputError("Data inválida.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new ProductionInputError("Data inválida.");
  return parsed;
}
