import { PosDomainError } from "@/lib/erp/pos-domain";

const ESC = 0x1b;
const GS = 0x1d;
const MAX_TEXT_LENGTH = 500;

export type PosReceiptSnapshot = {
  saleNumber: string;
  merchantName: string;
  issuedAt: Date;
  items: ReadonlyArray<{
    description: string;
    quantity: number;
    unit: string;
    unitPriceCents: number;
    totalCents: number;
  }>;
  subtotalCents: number;
  discountCents: number;
  surchargeCents: number;
  totalCents: number;
  payments: ReadonlyArray<{ label: string; amountCents: number }>;
  changeCents: number;
  footer?: string | null;
  qrText?: string | null;
};

export type PosEscPosProfile = {
  columns: 32 | 48;
  codePage: "ascii" | "utf8";
  cut: "none" | "partial" | "full";
  qr: boolean;
};

export type PosScaleReadingInput = {
  deviceId: string;
  weight: number;
  tare?: number;
  unit: "kg" | "g";
  stable: boolean;
  capturedAt: Date;
};

export type PosScalePolicy = {
  maximumAgeMs: number;
  minimumGrams: number;
  maximumGrams: number;
  incrementGrams: number;
  requireStable: boolean;
};

export type PosCustomerDisplayPayload = {
  state: "idle" | "item" | "payment" | "completed";
  description?: string;
  quantity?: number;
  unitPriceCents?: number;
  discountCents?: number;
  totalCents: number;
  changeCents?: number;
  pixQr?: string;
};

export function renderPosEscPosReceipt(snapshot: PosReceiptSnapshot, profile: PosEscPosProfile): Uint8Array {
  validateReceipt(snapshot);
  validatePrintProfile(profile);
  const encode = profile.codePage === "ascii" ? asciiBytes : utf8Bytes;
  const chunks: number[][] = [[ESC, 0x40], [ESC, 0x61, 0x01], ...lines(wrap(snapshot.merchantName, profile.columns), encode), ...lines([snapshot.saleNumber, formatReceiptDate(snapshot.issuedAt)], encode), [ESC, 0x61, 0x00]];

  chunks.push(...lines(["-".repeat(profile.columns)], encode));
  for (const item of snapshot.items) {
    chunks.push(...lines(wrap(item.description, profile.columns), encode));
    const left = `${formatQuantity(item.quantity)} ${item.unit} x ${formatCents(item.unitPriceCents)}`;
    chunks.push(...lines([columns(left, formatCents(item.totalCents), profile.columns)], encode));
  }
  chunks.push(...lines(["-".repeat(profile.columns)], encode));
  chunks.push(...lines([
    columns("Subtotal", formatCents(snapshot.subtotalCents), profile.columns),
    ...(snapshot.discountCents ? [columns("Desconto", `-${formatCents(snapshot.discountCents)}`, profile.columns)] : []),
    ...(snapshot.surchargeCents ? [columns("Acrescimo", formatCents(snapshot.surchargeCents), profile.columns)] : []),
  ], encode));
  chunks.push([ESC, 0x45, 0x01]);
  chunks.push(...lines([columns("TOTAL", formatCents(snapshot.totalCents), profile.columns)], encode));
  chunks.push([ESC, 0x45, 0x00]);
  for (const payment of snapshot.payments) chunks.push(...lines([columns(payment.label, formatCents(payment.amountCents), profile.columns)], encode));
  if (snapshot.changeCents) chunks.push(...lines([columns("Troco", formatCents(snapshot.changeCents), profile.columns)], encode));
  if (snapshot.footer) chunks.push([ESC, 0x61, 0x01], ...lines(wrap(snapshot.footer, profile.columns), encode), [ESC, 0x61, 0x00]);
  if (snapshot.qrText) {
    if (!profile.qr) throw new PosDomainError("O perfil da impressora não declara suporte a QR Code.");
    chunks.push([ESC, 0x61, 0x01], ...escPosQr(snapshot.qrText), [ESC, 0x61, 0x00]);
  }
  chunks.push(...lines(["", "", ""], encode));
  if (profile.cut !== "none") chunks.push([GS, 0x56, profile.cut === "partial" ? 0x01 : 0x00]);
  return Uint8Array.from(chunks.flat());
}

export function renderPosDrawerPulse(input: { pin: 2 | 5; onMs: number; offMs: number }): Uint8Array {
  if (![2, 5].includes(input.pin) || !Number.isSafeInteger(input.onMs) || !Number.isSafeInteger(input.offMs) || input.onMs < 2 || input.onMs > 510 || input.offMs < 2 || input.offMs > 510) {
    throw new PosDomainError("Pulso de gaveta inválido para o perfil ESC/POS.");
  }
  return Uint8Array.from([ESC, 0x70, input.pin === 2 ? 0 : 1, Math.round(input.onMs / 2), Math.round(input.offMs / 2)]);
}

export function parseStandardPosScaleFrame(frame: string, deviceId: string, capturedAt = new Date()) {
  if (typeof frame !== "string" || frame.length < 8 || frame.length > 128 || /[^\x20-\x7e\r\n]/.test(frame)) throw new PosDomainError("Quadro da balança inválido.");
  const normalized = frame.trim();
  const match = /^(ST|US),(GS|NT),([+-]?\d+(?:[.,]\d+)?)\s*(kg|g)$/i.exec(normalized);
  if (!match) throw new PosDomainError("Layout de balança não reconhecido pelo perfil padrão.");
  const weight = Number(match[3].replace(",", "."));
  return validatePosScaleReading({ deviceId, weight, tare: 0, unit: match[4].toLowerCase() as "kg" | "g", stable: match[1].toUpperCase() === "ST", capturedAt }, undefined, capturedAt);
}

export function validatePosScaleReading(input: PosScaleReadingInput, policy: PosScalePolicy = defaultScalePolicy(), now = new Date()) {
  const deviceId = boundedText(input.deviceId, "Dispositivo da balança", 1, 160);
  if (!(input.capturedAt instanceof Date) || !Number.isFinite(input.capturedAt.valueOf()) || input.capturedAt.valueOf() > now.valueOf() + 5_000) throw new PosDomainError("Timestamp da balança inválido.");
  if (!Number.isSafeInteger(policy.maximumAgeMs) || policy.maximumAgeMs < 100 || policy.maximumAgeMs > 60_000) throw new PosDomainError("Janela de leitura da balança inválida.");
  if (now.valueOf() - input.capturedAt.valueOf() > policy.maximumAgeMs) throw new PosDomainError("A leitura da balança expirou.");
  const weightGrams = toGrams(input.weight, input.unit, "Peso");
  const tareGrams = toGrams(input.tare ?? 0, input.unit, "Tara", true);
  if (tareGrams > weightGrams) throw new PosDomainError("A tara não pode superar o peso bruto informado.");
  const netWeightGrams = weightGrams - tareGrams;
  validateScalePolicy(policy);
  if (policy.requireStable && !input.stable) throw new PosDomainError("Aguarde a estabilização da balança.");
  if (netWeightGrams < policy.minimumGrams || netWeightGrams > policy.maximumGrams) throw new PosDomainError("Peso líquido fora dos limites configurados.");
  if (netWeightGrams % policy.incrementGrams !== 0) throw new PosDomainError("Peso líquido não respeita a precisão configurada.");
  return Object.freeze({ deviceId, grossWeightGrams: weightGrams, tareGrams, netWeightGrams, stable: input.stable, capturedAt: new Date(input.capturedAt) });
}

export function posScaleQuantity(reading: ReturnType<typeof validatePosScaleReading>, productUnit: string) {
  const unit = boundedText(productUnit, "Unidade do produto", 1, 12).toUpperCase();
  if (unit === "KG") return reading.netWeightGrams / 1_000;
  if (unit === "G") return reading.netWeightGrams;
  throw new PosDomainError("Produto pesado deve usar unidade KG ou G.");
}

export function validatePosCustomerDisplayPayload(input: PosCustomerDisplayPayload): Readonly<PosCustomerDisplayPayload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PosDomainError("Payload do display inválido.");
  const allowed = new Set(["state", "description", "quantity", "unitPriceCents", "discountCents", "totalCents", "changeCents", "pixQr"]);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) throw new PosDomainError(`Campo não público no display: ${extra}.`);
  if (!["idle", "item", "payment", "completed"].includes(input.state)) throw new PosDomainError("Estado do display inválido.");
  if (input.description != null) boundedText(input.description, "Descrição pública", 1, 120);
  if (input.quantity != null && (!Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > 999_999)) throw new PosDomainError("Quantidade do display inválida.");
  for (const [label, value] of [["Preço", input.unitPriceCents], ["Desconto", input.discountCents], ["Total", input.totalCents], ["Troco", input.changeCents]] as const) {
    if (value != null && (!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000_000)) throw new PosDomainError(`${label} do display inválido.`);
  }
  if (input.pixQr != null) boundedText(input.pixQr, "QR Pix", 1, 1_024);
  if (input.state !== "payment" && input.pixQr != null) throw new PosDomainError("QR Pix só pode ser exibido durante o pagamento.");
  return Object.freeze({ ...input });
}

function validateReceipt(value: PosReceiptSnapshot) {
  boundedText(value.saleNumber, "Número da venda", 1, 80);
  boundedText(value.merchantName, "Nome do estabelecimento", 1, 120);
  if (!(value.issuedAt instanceof Date) || !Number.isFinite(value.issuedAt.valueOf())) throw new PosDomainError("Data do comprovante inválida.");
  if (!Array.isArray(value.items) || !value.items.length || value.items.length > 200) throw new PosDomainError("Comprovante deve possuir entre 1 e 200 itens.");
  let itemsTotal = 0;
  for (const item of value.items) {
    boundedText(item.description, "Descrição do item", 1, 200);
    boundedText(item.unit, "Unidade do item", 1, 12);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 999_999) throw new PosDomainError("Quantidade do comprovante inválida.");
    cents(item.unitPriceCents, "Preço unitário");
    cents(item.totalCents, "Total do item");
    itemsTotal += item.totalCents;
  }
  for (const [label, amount] of [["Subtotal", value.subtotalCents], ["Desconto", value.discountCents], ["Acréscimo", value.surchargeCents], ["Total", value.totalCents], ["Troco", value.changeCents]] as const) cents(amount, label);
  if (itemsTotal !== value.subtotalCents || value.subtotalCents - value.discountCents + value.surchargeCents !== value.totalCents) throw new PosDomainError("Equação monetária do comprovante não fecha.");
  if (!Array.isArray(value.payments) || !value.payments.length || value.payments.length > 20) throw new PosDomainError("Pagamentos do comprovante inválidos.");
  const paid = value.payments.reduce((sum, payment) => {
    boundedText(payment.label, "Forma de pagamento", 1, 60);
    cents(payment.amountCents, "Pagamento");
    return sum + payment.amountCents;
  }, 0);
  if (paid !== value.totalCents) throw new PosDomainError("Pagamentos do comprovante não fecham com o total.");
  if (value.footer != null) boundedText(value.footer, "Rodapé", 1, MAX_TEXT_LENGTH);
  if (value.qrText != null) boundedText(value.qrText, "QR do comprovante", 1, 1_024);
}

function validatePrintProfile(profile: PosEscPosProfile) {
  if (![32, 48].includes(profile.columns) || !["ascii", "utf8"].includes(profile.codePage) || !["none", "partial", "full"].includes(profile.cut) || typeof profile.qr !== "boolean") throw new PosDomainError("Perfil ESC/POS inválido.");
}

function validateScalePolicy(policy: PosScalePolicy) {
  if (!Number.isSafeInteger(policy.minimumGrams) || !Number.isSafeInteger(policy.maximumGrams) || !Number.isSafeInteger(policy.incrementGrams) || policy.minimumGrams < 0 || policy.maximumGrams < policy.minimumGrams || policy.maximumGrams > 10_000_000 || policy.incrementGrams < 1 || policy.incrementGrams > 10_000) throw new PosDomainError("Política de peso inválida.");
}

function defaultScalePolicy(): PosScalePolicy {
  return { maximumAgeMs: 5_000, minimumGrams: 1, maximumGrams: 100_000, incrementGrams: 1, requireStable: true };
}

function toGrams(value: number, unit: "kg" | "g", label: string, allowZero = false) {
  if (!Number.isFinite(value) || value < 0 || !allowZero && value === 0) throw new PosDomainError(`${label} da balança inválido.`);
  const grams = Math.round(value * (unit === "kg" ? 1_000 : 1));
  if (!Number.isSafeInteger(grams) || Math.abs(grams / (unit === "kg" ? 1_000 : 1) - value) > 1e-9) throw new PosDomainError(`${label} deve possuir precisão de até um grama.`);
  return grams;
}

function cents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000_000) throw new PosDomainError(`${label} inválido.`);
}

function boundedText(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new PosDomainError(`${label} inválido.`);
  const normalized = value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (normalized.length < minimum || normalized.length > maximum) throw new PosDomainError(`${label} inválido.`);
  return normalized;
}

function asciiBytes(value: string) {
  return [...value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "?")].map((character) => character.charCodeAt(0));
}

function utf8Bytes(value: string) {
  return [...new TextEncoder().encode(value)];
}

function lines(values: string[], encode: (value: string) => number[]) {
  return values.map((value) => [...encode(value), 0x0a]);
}

function wrap(value: string, width: number) {
  const words = boundedText(value, "Texto do comprovante", 1, MAX_TEXT_LENGTH).split(/\s+/);
  const result: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current) result.push(current);
      for (let index = 0; index < word.length; index += width) result.push(word.slice(index, index + width));
      current = "";
    } else if (!current) current = word;
    else if (current.length + word.length + 1 <= width) current += ` ${word}`;
    else { result.push(current); current = word; }
  }
  if (current) result.push(current);
  return result;
}

function columns(left: string, right: string, width: number) {
  const safeLeft = left.slice(0, Math.max(1, width - right.length - 1));
  return `${safeLeft}${" ".repeat(Math.max(1, width - safeLeft.length - right.length))}${right}`.slice(0, width);
}

function formatCents(value: number) {
  const whole = Math.floor(value / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${whole},${String(value % 100).padStart(2, "0")}`;
}

function formatQuantity(value: number) {
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

function formatReceiptDate(value: Date) {
  return value.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function escPosQr(value: string) {
  const data = utf8Bytes(boundedText(value, "QR do comprovante", 1, 1_024));
  const storeLength = data.length + 3;
  return [
    [GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00],
    [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06],
    [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31],
    [GS, 0x28, 0x6b, storeLength & 0xff, storeLength >> 8, 0x31, 0x50, 0x30, ...data],
    [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30],
  ];
}
