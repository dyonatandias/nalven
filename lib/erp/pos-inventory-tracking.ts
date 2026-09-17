export class PosInventoryTrackingError extends Error {}

export const POS_QUANTITY_SCALE = BigInt(1_000_000);
const ZERO_MICROS = BigInt(0);
const MAX_SAFE_MICROS = BigInt("9007199254740991");

export type PosTrackedStockCandidate = {
  id: string;
  warehouseId: number;
  productId: number;
  variationId: number | null;
  lotCode?: string | null;
  normalizedLotCode?: string | null;
  serialNumber?: string | null;
  normalizedSerialNumber?: string | null;
  expiresOn?: Date | string | null;
  receivedAt: Date | string;
  status: string;
  quantityMicros: bigint | number | string;
  reservedMicros: bigint | number | string;
};

export type PosFefoAllocation = {
  lotId: string;
  quantityMicros: bigint;
  quantity: number;
  lotCode: string | null;
  serialNumber: string | null;
  expiresOn: string | null;
};

export function selectPosFefo(input: {
  warehouseId: number;
  productId: number;
  variationId?: number | null;
  quantity: number;
  businessDate: string;
  requestedLotCode?: string | null;
  requestedSerialNumber?: string | null;
  candidates: readonly PosTrackedStockCandidate[];
}) {
  const warehouseId = positiveInteger(input.warehouseId, "Depósito");
  const productId = positiveInteger(input.productId, "Produto");
  const variationId = input.variationId == null ? null : positiveInteger(input.variationId, "Variação");
  const requestedMicros = quantityToMicros(input.quantity);
  const businessDate = dateOnly(input.businessDate, "Data operacional");
  const requestedLotCode = input.requestedLotCode ? normalizePosTrackingIdentity(input.requestedLotCode, "Lote") : null;
  const requestedSerialNumber = input.requestedSerialNumber ? normalizePosTrackingIdentity(input.requestedSerialNumber, "Série") : null;
  if (!Array.isArray(input.candidates) || input.candidates.length > 10_000) throw new PosInventoryTrackingError("Candidatos de estoque inválidos.");

  const ids = new Set<string>(), serials = new Set<string>();
  const normalized = input.candidates.map((candidate) => {
    const id = requiredText(candidate.id, 160, "Identificador do saldo rastreado");
    if (ids.has(id)) throw new PosInventoryTrackingError(`Saldo rastreado duplicado: ${id}.`);
    ids.add(id);
    if (candidate.warehouseId !== warehouseId || candidate.productId !== productId || (candidate.variationId ?? null) !== variationId) {
      throw new PosInventoryTrackingError("Saldo rastreado pertence a outro depósito, produto ou variação.");
    }
    const lotCode = candidate.lotCode ? requiredText(candidate.lotCode, 160, "Lote") : null;
    const serialNumber = candidate.serialNumber ? requiredText(candidate.serialNumber, 200, "Série") : null;
    const normalizedLotCode = candidate.normalizedLotCode ? normalizePosTrackingIdentity(candidate.normalizedLotCode, "Lote") : lotCode ? normalizePosTrackingIdentity(lotCode, "Lote") : null;
    const normalizedSerialNumber = candidate.normalizedSerialNumber ? normalizePosTrackingIdentity(candidate.normalizedSerialNumber, "Série") : serialNumber ? normalizePosTrackingIdentity(serialNumber, "Série") : null;
    if (!normalizedLotCode && !normalizedSerialNumber) throw new PosInventoryTrackingError("Saldo rastreado sem lote ou série.");
    if (normalizedSerialNumber) {
      if (serials.has(normalizedSerialNumber)) throw new PosInventoryTrackingError(`Série duplicada: ${serialNumber || normalizedSerialNumber}.`);
      serials.add(normalizedSerialNumber);
    }
    const quantityMicros = micros(candidate.quantityMicros, "Quantidade do saldo"), reservedMicros = micros(candidate.reservedMicros, "Reserva do saldo");
    if (reservedMicros > quantityMicros) throw new PosInventoryTrackingError("Reserva rastreada supera a quantidade física.");
    if (normalizedSerialNumber && ![ZERO_MICROS, POS_QUANTITY_SCALE].includes(quantityMicros)) throw new PosInventoryTrackingError("Uma série deve representar zero ou uma unidade.");
    if (normalizedSerialNumber && ![ZERO_MICROS, POS_QUANTITY_SCALE].includes(reservedMicros)) throw new PosInventoryTrackingError("A reserva de uma série deve ser zero ou uma unidade.");
    const expiresOn = candidate.expiresOn == null ? null : dateOnly(candidate.expiresOn, "Validade");
    const receivedAt = instant(candidate.receivedAt, "Recebimento");
    return { ...candidate, id, lotCode, serialNumber, normalizedLotCode, normalizedSerialNumber, quantityMicros, reservedMicros, expiresOn, receivedAt };
  });

  const eligible = normalized.filter((candidate) =>
    candidate.status === "available"
    && candidate.quantityMicros > candidate.reservedMicros
    && (!candidate.expiresOn || candidate.expiresOn >= businessDate)
    && (!requestedLotCode || candidate.normalizedLotCode === requestedLotCode)
    && (!requestedSerialNumber || candidate.normalizedSerialNumber === requestedSerialNumber));
  if (requestedLotCode && requestedSerialNumber && !eligible.length) throw new PosInventoryTrackingError("Lote/série solicitado indisponível, vencido ou bloqueado.");
  if (requestedLotCode && !eligible.length) throw new PosInventoryTrackingError("Lote solicitado indisponível, vencido ou bloqueado.");
  if (requestedSerialNumber && !eligible.length) throw new PosInventoryTrackingError("Série solicitada indisponível, vencida ou bloqueada.");
  const serialized = eligible.some((candidate) => candidate.normalizedSerialNumber);
  if (serialized && eligible.some((candidate) => !candidate.normalizedSerialNumber)) throw new PosInventoryTrackingError("Configuração ambígua: o mesmo item mistura controle serializado e não serializado.");
  if (serialized && requestedMicros % POS_QUANTITY_SCALE !== ZERO_MICROS) throw new PosInventoryTrackingError("Itens serializados exigem quantidade inteira.");
  if (requestedSerialNumber && requestedMicros !== POS_QUANTITY_SCALE) throw new PosInventoryTrackingError("A leitura de uma série identifica exatamente uma unidade.");

  eligible.sort((left, right) => compareNullableDate(left.expiresOn, right.expiresOn) || left.receivedAt - right.receivedAt || compareText(left.id, right.id));
  let remaining = requestedMicros;
  const allocations: PosFefoAllocation[] = [];
  for (const candidate of eligible) {
    if (remaining === ZERO_MICROS) break;
    const available = BigInt(candidate.quantityMicros) - BigInt(candidate.reservedMicros);
    const allocated = available < remaining ? available : remaining;
    if (allocated <= ZERO_MICROS) continue;
    allocations.push({
      lotId: candidate.id,
      quantityMicros: allocated,
      quantity: microsToQuantity(allocated),
      lotCode: candidate.lotCode,
      serialNumber: candidate.serialNumber,
      expiresOn: candidate.expiresOn,
    });
    remaining -= allocated;
  }
  if (remaining !== ZERO_MICROS) throw new PosInventoryTrackingError(`Saldo FEFO insuficiente: faltam ${microsToQuantity(remaining)} unidades.`);
  return { requestedMicros, quantity: input.quantity, serialized, allocations };
}

export function planPosTrackedReturn(input: {
  quantity: number;
  businessDate: string;
  disposition: "restock" | "quarantine" | "discard";
  originalAllocations: readonly {
    lotId: string;
    soldMicros: bigint | number | string;
    returnedMicros: bigint | number | string;
    expiresOn?: Date | string | null;
    lotStatus: string;
  }[];
}) {
  let remaining = quantityToMicros(input.quantity);
  const businessDate = dateOnly(input.businessDate, "Data operacional");
  const ids = new Set<string>();
  const allocations = input.originalAllocations.map((allocation) => {
    const lotId = requiredText(allocation.lotId, 160, "Lote da venda");
    if (ids.has(lotId)) throw new PosInventoryTrackingError(`Lote repetido na venda: ${lotId}.`);
    ids.add(lotId);
    const soldMicros = micros(allocation.soldMicros, "Quantidade vendida"), returnedMicros = micros(allocation.returnedMicros, "Quantidade já devolvida");
    if (returnedMicros > soldMicros) throw new PosInventoryTrackingError("Quantidade rastreada já devolvida supera a venda.");
    return { ...allocation, lotId, soldMicros, returnedMicros, expiresOn: allocation.expiresOn == null ? null : dateOnly(allocation.expiresOn, "Validade") };
  });
  const result: Array<{ lotId: string; quantityMicros: bigint; quantity: number; disposition: "restock" | "quarantine" | "discard" }> = [];
  for (const allocation of allocations) {
    if (remaining === ZERO_MICROS) break;
    const available = allocation.soldMicros - allocation.returnedMicros;
    const quantityMicros = available < remaining ? available : remaining;
    if (quantityMicros <= ZERO_MICROS) continue;
    // `depleted` only means the sale consumed the last available unit. A valid
    // return may make that same identity sellable again; blocked/quarantined or
    // expired stock must never be silently re-enabled.
    const unsafeToRestock = !["available", "depleted"].includes(allocation.lotStatus) || Boolean(allocation.expiresOn && allocation.expiresOn < businessDate);
    result.push({ lotId: allocation.lotId, quantityMicros, quantity: microsToQuantity(quantityMicros), disposition: input.disposition === "restock" && unsafeToRestock ? "quarantine" : input.disposition });
    remaining -= quantityMicros;
  }
  if (remaining !== ZERO_MICROS) throw new PosInventoryTrackingError("A devolução supera o saldo rastreado originalmente vendido.");
  return result;
}

export function assertPosLotMovement(type: string, balanceBefore: bigint | number | string, delta: bigint | number | string) {
  const before = micros(balanceBefore, "Saldo anterior"), change = signedMicros(delta, "Movimento");
  const positive = ["receipt", "return", "transfer_in"], negative = ["sale", "transfer_out", "discard"];
  if (![...positive, ...negative, "adjustment", "status_change"].includes(type)) throw new PosInventoryTrackingError("Tipo de movimento rastreado inválido.");
  if (positive.includes(type) && change <= ZERO_MICROS || negative.includes(type) && change >= ZERO_MICROS || type === "adjustment" && change === ZERO_MICROS || type === "status_change" && change !== ZERO_MICROS) {
    throw new PosInventoryTrackingError("Sinal incompatível com o tipo de movimento rastreado.");
  }
  const after = before + change;
  if (after < ZERO_MICROS || after > MAX_SAFE_MICROS) throw new PosInventoryTrackingError("Movimento deixa o saldo rastreado fora do limite.");
  return after;
}

const LOT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  available: ["quarantine", "expired", "depleted", "blocked"],
  quarantine: ["available", "expired", "depleted", "blocked"],
  blocked: ["available", "quarantine", "expired", "depleted"],
  expired: ["quarantine", "depleted"],
  depleted: ["available", "quarantine", "expired", "blocked"],
};

export function assertPosLotStatusTransition(from: string, to: string) {
  if (!Object.hasOwn(LOT_TRANSITIONS, from) || !Object.hasOwn(LOT_TRANSITIONS, to)) throw new PosInventoryTrackingError("Estado de lote inválido.");
  if (from !== to && !LOT_TRANSITIONS[from].includes(to)) throw new PosInventoryTrackingError(`Transição de lote inválida: ${from} → ${to}.`);
  return to;
}

export function normalizePosTrackingIdentity(value: string, label = "Identidade rastreada") {
  const source = requiredText(value, 200, label).normalize("NFKC");
  if (/[\u0000-\u001F\u007F]/.test(source)) throw new PosInventoryTrackingError(`${label} inválida.`);
  const normalized = source.toUpperCase().replace(/\s+/g, "");
  if (!normalized) throw new PosInventoryTrackingError(`${label} inválida.`);
  return normalized;
}

export function quantityToMicros(value: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 9_007_199_254) throw new PosInventoryTrackingError("Quantidade rastreada inválida.");
  const scaled = Math.round(value * Number(POS_QUANTITY_SCALE));
  if (!Number.isSafeInteger(scaled) || Math.abs(scaled / Number(POS_QUANTITY_SCALE) - value) > 1e-9) throw new PosInventoryTrackingError("Quantidade rastreada deve ter no máximo seis casas decimais.");
  return BigInt(scaled);
}

function microsToQuantity(value: bigint) { return Number(value) / Number(POS_QUANTITY_SCALE); }
function micros(value: bigint | number | string, label: string) { const result = signedMicros(value, label); if (result < ZERO_MICROS) throw new PosInventoryTrackingError(`${label} inválida.`); return result; }
function signedMicros(value: bigint | number | string, label: string) {
  let result: bigint;
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value) || typeof value === "string" && !/^-?\d+$/.test(value)) throw new Error("invalid");
    result = BigInt(value);
  } catch {
    throw new PosInventoryTrackingError(`${label} inválido.`);
  }
  if (result < -MAX_SAFE_MICROS || result > MAX_SAFE_MICROS) throw new PosInventoryTrackingError(`${label} excede o limite permitido.`);
  return result;
}
function dateOnly(value: Date | string, label: string) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value) return value;
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  throw new PosInventoryTrackingError(`${label} inválida.`);
}
function instant(value: Date | string, label: string) { const parsed = value instanceof Date ? value : new Date(value); if (Number.isNaN(parsed.valueOf())) throw new PosInventoryTrackingError(`${label} inválido.`); return parsed.valueOf(); }
function positiveInteger(value: number, label: string) { if (!Number.isSafeInteger(value) || value <= 0) throw new PosInventoryTrackingError(`${label} inválido.`); return value; }
function requiredText(value: unknown, maximum: number, label: string) { const result = String(value ?? "").trim(); if (!result || result.length > maximum) throw new PosInventoryTrackingError(`${label} inválido.`); return result; }
function compareNullableDate(left: string | null, right: string | null) { if (left === right) return 0; if (left == null) return 1; if (right == null) return -1; return compareText(left, right); }
function compareText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
