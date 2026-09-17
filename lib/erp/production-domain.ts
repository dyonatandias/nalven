import { createHash } from "node:crypto";
import { ProductionInputError } from "./production-input";
import { quantityToMicros, POS_QUANTITY_SCALE } from "./pos-inventory-tracking";

export type ProductionMaterial = {
  productId: number;
  variationId: number | null;
  quantity: number;
  wastePercent: number;
};
export type ProductionSnapshot = {
  name: string;
  code: string;
  outputProductId: number;
  outputVariationId: number | null;
  yieldQuantity: number;
  notes: string | null;
  items: ProductionMaterial[];
  laborHourlyCents: number;
  machineHourlyCents: number;
  energyBatchCents: number;
  overheadBatchCents: number;
  checklist: string[];
};
export type ProductionShift = { day: number; start: string; end: string };
export const MICRO = POS_QUANTITY_SCALE;
export const ZERO = BigInt(0);

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProductionInputError("Dados de produção inválidos.");
  return value as Record<string, unknown>;
}
export function boundedText(
  value: unknown,
  label: string,
  max = 2000,
  required = false,
) {
  if (value != null && typeof value !== "string")
    throw new ProductionInputError(`${label} inválido.`);
  const text = String(value ?? "").trim();
  if (
    text.length > max ||
    (required && !text) ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)
  )
    throw new ProductionInputError(`${label} inválido.`);
  return text;
}
export function integer(
  value: unknown,
  label: string,
  min = 0,
  max = 2_000_000_000,
) {
  if (typeof value === "boolean" || value == null || value === "")
    throw new ProductionInputError(`${label} inválido.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new ProductionInputError(`${label} inválido.`);
  return result;
}
export function quantity(value: unknown, allowZero = false) {
  if (typeof value === "boolean" || value == null || value === "")
    throw new ProductionInputError("Quantidade inválida.");
  const result = Number(value);
  if (allowZero && result === 0) return ZERO;
  try {
    return quantityToMicros(result);
  } catch {
    throw new ProductionInputError(
      "Informe quantidade positiva com até seis casas decimais.",
    );
  }
}
export function asQuantity(value: bigint) {
  return Number(value) / Number(MICRO);
}
export function cents(value: unknown) {
  return integer(value, "Custo em centavos");
}
export function uuid(value: unknown) {
  const result = String(value ?? "");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result,
    )
  )
    throw new ProductionInputError("Identificador de operação inválido.");
  return result;
}
export function dateOnly(value: unknown, optional = false): string | null {
  if (optional && (value == null || value === "")) return null;
  const result = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result))
    throw new ProductionInputError("Data inválida.");
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  )
    throw new ProductionInputError("Data inválida.");
  return result;
}
export function instant(value: unknown) {
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new ProductionInputError("Informe data e horário com fuso.");
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new ProductionInputError("Horário inválido.");
  return result;
}
export function snapshotInput(value: unknown): ProductionSnapshot {
  const x = object(value);
  if (!Array.isArray(x.items) || !x.items.length || x.items.length > 200)
    throw new ProductionInputError("Informe entre 1 e 200 materiais.");
  const outputProductId = integer(x.outputProductId, "Produto acabado", 1);
  const outputVariationId = x.outputVariationId
    ? integer(x.outputVariationId, "Variação", 1)
    : null;
  const seen = new Set<string>();
  const items = x.items
    .map((raw) => {
      const line = object(raw),
        productId = integer(line.productId, "Material", 1);
      const variationId = line.variationId
        ? integer(line.variationId, "Variação", 1)
        : null;
      const key = `${productId}:${variationId}`;
      if (seen.has(key) || productId === outputProductId)
        throw new ProductionInputError(
          "Material repetido ou igual ao produto acabado.",
        );
      seen.add(key);
      const wastePercent = Number(line.wastePercent ?? 0);
      if (
        !Number.isFinite(wastePercent) ||
        wastePercent < 0 ||
        wastePercent > 100 ||
        Math.round(wastePercent * 100) / 100 !== wastePercent
      )
        throw new ProductionInputError(
          "Perda prevista deve ficar entre 0 e 100%, com até duas casas.",
        );
      return {
        productId,
        variationId,
        quantity: asQuantity(quantity(line.quantity)),
        wastePercent,
      };
    })
    .sort(
      (a, b) =>
        a.productId - b.productId ||
        (a.variationId ?? 0) - (b.variationId ?? 0),
    );
  const checklist = x.checklist ?? [
    "Quantidade conferida",
    "Composição conferida",
    "Integridade do produto",
  ];
  if (!Array.isArray(checklist) || !checklist.length || checklist.length > 30)
    throw new ProductionInputError(
      "Informe entre 1 e 30 verificações de qualidade.",
    );
  const checks = checklist.map((item) =>
    boundedText(item, "Verificação", 180, true),
  );
  if (new Set(checks).size !== checks.length)
    throw new ProductionInputError("Verificação repetida.");
  return {
    name: boundedText(x.name, "Nome", 180, true),
    code: boundedText(x.code, "Código", 40, true),
    outputProductId,
    outputVariationId,
    yieldQuantity: asQuantity(quantity(x.yieldQuantity)),
    notes: boundedText(x.notes, "Observações") || null,
    items,
    checklist: checks,
    laborHourlyCents: cents(x.laborHourlyCents ?? 0),
    machineHourlyCents: cents(x.machineHourlyCents ?? 0),
    energyBatchCents: cents(x.energyBatchCents ?? 0),
    overheadBatchCents: cents(x.overheadBatchCents ?? 0),
  };
}

/** Integer arithmetic rounds required inputs upward so fractional batches never under-reserve. */
export function materialNeeds(
  snapshot: ProductionSnapshot,
  outputMicros: bigint,
) {
  const yieldMicros = quantity(snapshot.yieldQuantity);
  return snapshot.items.map((item) => {
    const numerator =
      quantity(item.quantity) *
      outputMicros *
      BigInt(10_000 + Math.round(item.wastePercent * 100));
    const denominator = yieldMicros * BigInt(10_000);
    const requiredMicros = (numerator + denominator - BigInt(1)) / denominator;
    if (requiredMicros > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ProductionInputError(
        "Necessidade de material excede o limite.",
      );
    return { ...item, requiredMicros };
  });
}
export function materialCost(quantityMicros: bigint, unitCostCents: number) {
  return cents(
    Number(
      (quantityMicros * BigInt(cents(unitCostCents)) + MICRO / BigInt(2)) /
        MICRO,
    ),
  );
}
export function reportCosts(
  snapshot: ProductionSnapshot,
  input: {
    materialCostCents: number;
    laborMinutes: number;
    machineMinutes: number;
    processedMicros: bigint;
  },
) {
  const ratioCost = (rate: number) =>
    cents(
      Math.round(
        (rate * asQuantity(input.processedMicros)) / snapshot.yieldQuantity,
      ),
    );
  const result = {
    materialCostCents: cents(input.materialCostCents),
    laborCostCents: cents(
      Math.round(
        (snapshot.laborHourlyCents *
          integer(input.laborMinutes, "Minutos", 0, 525600)) /
          60,
      ),
    ),
    machineCostCents: cents(
      Math.round(
        (snapshot.machineHourlyCents *
          integer(input.machineMinutes, "Minutos", 0, 525600)) /
          60,
      ),
    ),
    energyCostCents: ratioCost(snapshot.energyBatchCents),
    overheadCostCents: ratioCost(snapshot.overheadBatchCents),
  };
  return {
    ...result,
    totalCostCents: cents(
      Object.values(result).reduce((sum, amount) => sum + amount, 0),
    ),
  };
}
export function weightedAverageCost(
  existingQuantity: number,
  existingUnitCost: number,
  receivedMicros: bigint,
  receivedCostCents: number,
) {
  if (
    !Number.isFinite(existingQuantity) ||
    existingQuantity < 0 ||
    !Number.isFinite(existingUnitCost) ||
    existingUnitCost < 0
  )
    throw new ProductionInputError(
      "Saldo ou custo atual inválido para custo médio.",
    );
  const totalQuantity = existingQuantity + asQuantity(receivedMicros);
  if (totalQuantity <= 0)
    throw new ProductionInputError("Quantidade inválida para custo médio.");
  return (
    cents(
      Math.round(
        (existingQuantity * existingUnitCost * 100 + cents(receivedCostCents)) /
          totalQuantity,
      ),
    ) / 100
  );
}
export function requestHash(value: unknown): string {
  function canonical(v: unknown): string {
    if (v === null || typeof v === "boolean" || typeof v === "string")
      return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object")
      return `{${Object.keys(v)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((v as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    throw new ProductionInputError("Conteúdo de comando inválido.");
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function shiftsInput(value: unknown): ProductionShift[] {
  if (!Array.isArray(value) || !value.length || value.length > 21)
    throw new ProductionInputError("Configure entre 1 e 21 turnos semanais.");
  const result = value
    .map((raw) => {
      const x = object(raw),
        day = integer(x.day, "Dia da semana", 0, 6);
      const start = String(x.start ?? ""),
        end = String(x.end ?? "");
      if (
        ![start, end].every((time) =>
          /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
        ) ||
        start >= end
      )
        throw new ProductionInputError(
          "Turnos precisam de início e fim no mesmo dia, sem sobreposição.",
        );
      return { day, start, end };
    })
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  if (
    result.some(
      (shift, i) =>
        i > 0 &&
        shift.day === result[i - 1].day &&
        shift.start < result[i - 1].end,
    )
  )
    throw new ProductionInputError("Turnos sobrepostos.");
  return result;
}
export function assertScheduleWithinShifts(
  start: Date,
  end: Date,
  shifts: ProductionShift[],
  timeZone: string,
) {
  if (start.getTime() % 60000 !== 0 || end.getTime() % 60000 !== 0)
    throw new ProductionInputError("Agende horários em minutos inteiros.");
  if (end <= start || end.getTime() - start.getTime() > 31 * 86400000)
    throw new ProductionInputError(
      "Janela de produção inválida (máximo 31 dias).",
    );
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new ProductionInputError("Fuso do centro de trabalho inválido.");
  }
  // Every occupied minute must belong to a configured shift, including across DST changes.
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += 60000) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(cursor))
        .map((part) => [part.type, part.value]),
    );
    const day = days.indexOf(parts.weekday),
      time = `${parts.hour}:${parts.minute}`;
    if (
      !shifts.some(
        (shift) => shift.day === day && time >= shift.start && time < shift.end,
      )
    )
      throw new ProductionInputError(
        "O agendamento ocupa horário fora dos turnos do recurso.",
      );
  }
}
export function safeJson(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as import("@/generated/tenant/client").Prisma.InputJsonValue;
}
