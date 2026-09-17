export class PosDomainError extends Error {}

export type PosScan = {
  raw: string;
  lookup: string;
  gtin: string | null;
  lot: string | null;
  serial: string | null;
  expiresOn: string | null;
  measuredQuantity: number | null;
  measurementUnit: string | null;
  kind: "gs1" | "digital_link" | "linear" | "qr" | "sku";
};

export type PosScanPurpose = "product" | "internal_qr" | "pix_payment" | "fiscal_document" | "generic_qr";

export type PosPricedLine = {
  productId: number;
  variationId?: number | null;
  quantity: number;
  unitPriceCents: number;
  discountCents?: number;
};

export type PosPaymentInput = {
  method: "cash" | "pix" | "credit" | "debit" | "voucher" | "store_credit" | "other";
  amountCents: number;
  tenderedCents?: number;
};

const fixedLengthAis: Record<string, number> = {
  "00": 18,
  "01": 14,
  "02": 14,
  "11": 6,
  "12": 6,
  "13": 6,
  "15": 6,
  "16": 6,
  "17": 6,
  "20": 2,
};
const variableLengthAis: Record<string, number> = { "10": 20, "21": 20, "30": 8 };

export function parsePosScan(value: unknown): PosScan {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) throw new PosDomainError("Código lido inválido.");
  const withoutAim = raw.replace(/^\][A-Za-z][0-9]/, "");
  const digital = parseDigitalLink(withoutAim);
  if (digital) return { raw, lookup: digital.gtin || withoutAim, kind: "digital_link", ...digital };
  const gs1 = parseGs1(withoutAim);
  if (gs1.gtin) return { raw, lookup: gs1.gtin, kind: "gs1", ...gs1 };
  const compact = withoutAim.replace(/[\s-]/g, "");
  if (/^\d{8,14}$/.test(compact)) {
    return { raw, lookup: compact, gtin: compact, lot: null, serial: null, expiresOn: null, measuredQuantity: null, measurementUnit: null, kind: "linear" };
  }
  const looksLikeQr = /^(https?:\/\/|pix:|000201)/i.test(withoutAim);
  return { raw, lookup: withoutAim, gtin: null, lot: null, serial: null, expiresOn: null, measuredQuantity: null, measurementUnit: null, kind: looksLikeQr ? "qr" : "sku" };
}

/**
 * Classifies the destination of a reader payload before a product lookup.
 * This is intentionally conservative: payment and fiscal QR payloads must
 * never fall through to a SKU/product-code match merely because the same HID
 * reader is used for every symbology.
 */
export function classifyPosScanPurpose(value: unknown): PosScanPurpose {
  const scan = parsePosScan(value);
  const raw = scan.raw.normalize("NFKC").trim();
  const upper = raw.toUpperCase();
  if (raw.startsWith("NALVEN-POS.v1.")) return "internal_qr";
  if (upper.startsWith("PIX:") || raw.startsWith("000201") && upper.includes("BR.GOV.BCB.PIX")) return "pix_payment";
  if (looksLikeFiscalQr(raw)) return "fiscal_document";
  if (scan.kind === "qr") return "generic_qr";
  return "product";
}

export function isValidGtin(value: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop();
  let weight = 3;
  const total = digits.reverse().reduce((sum, digit) => {
    const result = sum + digit * weight;
    weight = weight === 3 ? 1 : 3;
    return result;
  }, 0);
  return check === (10 - (total % 10)) % 10;
}

export function pricePosCart(lines: PosPricedLine[], orderDiscountCents = 0, surchargeCents = 0) {
  if (!lines.length) throw new PosDomainError("Adicione ao menos um item à venda.");
  const priced = lines.map((line) => {
    if (!Number.isInteger(line.productId) || line.productId <= 0) throw new PosDomainError("Produto inválido.");
    if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 999_999) throw new PosDomainError("Quantidade inválida.");
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) throw new PosDomainError("Preço inválido.");
    const grossCents = boundedCents(Math.round(line.unitPriceCents * line.quantity), "Total do item");
    const discountCents = integerAmount(line.discountCents ?? 0, "Desconto do item");
    if (discountCents > grossCents) throw new PosDomainError("O desconto do item não pode superar seu valor.");
    return { ...line, grossCents, discountCents, totalCents: grossCents - discountCents };
  });
  const subtotalCents = boundedCents(priced.reduce((sum, line) => sum + line.totalCents, 0), "Subtotal");
  if (subtotalCents <= 0) throw new PosDomainError("O subtotal líquido da venda deve ser positivo.");
  const discountCents = integerAmount(orderDiscountCents, "Desconto da venda");
  const normalizedSurcharge = integerAmount(surchargeCents, "Acréscimo");
  if (discountCents > subtotalCents) throw new PosDomainError("O desconto da venda não pode superar o subtotal.");
  const totalCents = boundedCents(subtotalCents - discountCents + normalizedSurcharge, "Total");
  if (totalCents <= 0) throw new PosDomainError("O total da venda deve ser positivo.");
  return { lines: priced, subtotalCents, discountCents, surchargeCents: normalizedSurcharge, totalCents };
}

export function settlePosPayments(totalCents: number, payments: PosPaymentInput[]) {
  integerAmount(totalCents, "Total");
  if (totalCents <= 0 || !payments.length) throw new PosDomainError("Informe os pagamentos da venda.");
  let appliedCents = 0;
  let tenderedCents = 0;
  const normalized = payments.map((payment) => {
    const amountCents = integerAmount(payment.amountCents, "Pagamento");
    if (amountCents <= 0) throw new PosDomainError("O pagamento deve ser positivo.");
    if (payment.method !== "cash" && payment.tenderedCents != null && payment.tenderedCents !== amountCents) {
      throw new PosDomainError("Valor recebido só é aplicável a dinheiro.");
    }
    const received = payment.method === "cash" ? integerAmount(payment.tenderedCents ?? amountCents, "Valor recebido") : amountCents;
    if (received < amountCents) throw new PosDomainError("O valor recebido em dinheiro é menor que o valor aplicado.");
    appliedCents += amountCents;
    tenderedCents += received;
    return { ...payment, amountCents, tenderedCents: received };
  });
  if (appliedCents !== totalCents) throw new PosDomainError(`Os pagamentos devem totalizar exatamente ${totalCents} centavos.`);
  const cashApplied = normalized.filter((item) => item.method === "cash").reduce((sum, item) => sum + item.amountCents, 0);
  const cashTendered = normalized.filter((item) => item.method === "cash").reduce((sum, item) => sum + item.tenderedCents, 0);
  return { payments: normalized, appliedCents, tenderedCents, changeCents: cashTendered - cashApplied };
}

export function discountPercent(discountCents: number, grossCents: number) {
  if (grossCents <= 0) return 0;
  return Math.round((discountCents / grossCents) * 10_000) / 100;
}

export function assertDiscountLimit(discountCents: number, grossCents: number, maximumPercent: number) {
  if (!Number.isFinite(maximumPercent) || maximumPercent < 0 || maximumPercent > 100) throw new PosDomainError("Alçada de desconto inválida.");
  if (discountCents * 10_000 > grossCents * maximumPercent * 100) {
    const actual = discountPercent(discountCents, grossCents);
    throw new PosDomainError(`Desconto de ${actual.toFixed(2)}% supera a alçada de ${maximumPercent.toFixed(2)}%.`);
  }
  const actual = discountPercent(discountCents, grossCents);
  return actual;
}

const paymentTransitions: Record<string, readonly string[]> = {
  created: ["processing", "cancelled"],
  processing: ["authorized", "captured", "declined", "unknown", "cancelled"],
  unknown: ["authorized", "captured", "declined", "manual_review"],
  authorized: ["captured", "cancelled", "unknown"],
  captured: ["partially_refunded", "refunded"],
  partially_refunded: ["partially_refunded", "refunded"],
  declined: [], cancelled: [], refunded: [], manual_review: ["authorized", "captured", "declined", "cancelled"],
};

const saleTransitions: Record<string, readonly string[]> = {
  draft: ["suspended", "payment_pending", "cancelled"],
  suspended: ["draft", "cancelled"],
  payment_pending: ["paid", "payment_unknown", "cancelled"],
  payment_unknown: ["paid", "payment_pending", "cancelled", "manual_review"],
  paid: ["fiscal_pending", "completed", "payment_reversal_pending"],
  fiscal_pending: ["completed", "fiscal_contingency", "manual_review"],
  fiscal_contingency: ["completed", "manual_review"],
  completed: ["partially_returned", "refunded", "payment_reversal_pending", "cancelled"],
  partially_returned: ["partially_returned", "refunded"],
  payment_reversal_pending: ["cancelled", "manual_review"],
  return_pending: ["partially_returned", "refunded", "manual_review"],
  manual_review: ["payment_pending", "paid", "fiscal_pending", "completed", "cancelled"],
  cancelled: [], refunded: [],
};

export function assertPosStateTransition(kind: "payment" | "sale", current: string, next: string) {
  const graph = kind === "payment" ? paymentTransitions : saleTransitions;
  if (!Object.hasOwn(graph, current) || !Object.hasOwn(graph, next)) throw new PosDomainError(`Transição inválida de ${current} para ${next}.`);
  if (current === next) return next;
  if (!graph[current]?.includes(next)) throw new PosDomainError(`Transição inválida de ${current} para ${next}.`);
  return next;
}

function integerAmount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new PosDomainError(`${label} inválido.`);
  return value;
}

function boundedCents(value: number, label: string) {
  integerAmount(value, label);
  if (value > 2_147_483_647) throw new PosDomainError(`${label} excede o limite permitido.`);
  return value;
}

function parseDigitalLink(value: string) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part === "01");
    const gtin = index >= 0 && /^\d{14}$/.test(parts[index + 1] || "") ? parts[index + 1] : url.searchParams.get("01");
    if (!gtin || !/^\d{8,14}$/.test(gtin)) return null;
    return {
      gtin,
      lot: valueAfter(parts, "10") || url.searchParams.get("10"),
      serial: valueAfter(parts, "21") || url.searchParams.get("21"),
      expiresOn: gs1Date(valueAfter(parts, "17") || url.searchParams.get("17")),
      measuredQuantity: null,
      measurementUnit: null,
    };
  } catch {
    return null;
  }
}

function looksLikeFiscalQr(value: string) {
  if (/^(?:NFC-?E|NF-?E):/i.test(value)) return true;
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase("en-US");
    const fiscalHost = host.endsWith(".gov.br") && /(?:^|\.)(?:sefaz|fazenda|nfce|svrs)(?:\.|$)/.test(host);
    const fiscalResource = /(?:nfce|nfe|qrcode|consulta|consultar|portal)/i.test(`${url.pathname}${url.search}`);
    return fiscalHost && fiscalResource;
  } catch {
    return false;
  }
}

function valueAfter(parts: string[], key: string) {
  const index = parts.findIndex((part) => part === key);
  if (index < 0 || !parts[index + 1]) return null;
  try { return decodeURIComponent(parts[index + 1]); } catch { return null; }
}

function parseGs1(value: string) {
  const result = { gtin: null as string | null, lot: null as string | null, serial: null as string | null, expiresOn: null as string | null, measuredQuantity: null as number | null, measurementUnit: null as string | null };
  const parenthesized = [...value.matchAll(/\((\d{2,4})\)([^()]*)/g)];
  if (parenthesized.length) {
    for (const [, ai, content] of parenthesized) assignAi(result, ai, content.trim());
    return result;
  }
  const data = value.replaceAll(String.fromCharCode(29), "|");
  if (!data.startsWith("01") || data.length < 16) return result;
  let cursor = 0;
  while (cursor + 2 <= data.length) {
    if (data[cursor] === "|") { cursor += 1; continue; }
    const measurementAi = /^31[0-6][0-5]/.test(data.slice(cursor, cursor + 4)) ? data.slice(cursor, cursor + 4) : null;
    const ai = measurementAi || Object.keys(fixedLengthAis).find((candidate) => data.startsWith(candidate, cursor)) || Object.keys(variableLengthAis).find((candidate) => data.startsWith(candidate, cursor));
    if (!ai) break;
    cursor += ai.length;
    const length = measurementAi ? 6 : fixedLengthAis[ai];
    const separator = data.indexOf("|", cursor);
    const content = length ? data.slice(cursor, cursor + length) : data.slice(cursor, separator >= 0 ? separator : cursor + variableLengthAis[ai]);
    if (length && content.length !== length) break;
    assignAi(result, ai, content);
    cursor += length || content.length;
  }
  return result;
}

function assignAi(target: { gtin: string | null; lot: string | null; serial: string | null; expiresOn: string | null; measuredQuantity: number | null; measurementUnit: string | null }, ai: string, content: string) {
  if (ai === "01" && /^\d{14}$/.test(content)) target.gtin = content;
  if (ai === "10") target.lot = content || null;
  if (ai === "21") target.serial = content || null;
  if (ai === "17") target.expiresOn = gs1Date(content);
  if (ai === "30" && /^\d{1,8}$/.test(content)) { target.measuredQuantity = Number(content); target.measurementUnit = "count"; }
  if (/^31[0-6][0-5]$/.test(ai) && /^\d{6}$/.test(content)) {
    target.measuredQuantity = Number(content) / 10 ** Number(ai[3]);
    target.measurementUnit = ai.startsWith("310") ? "kg" : ai.startsWith("311") ? "m" : ai.startsWith("312") ? "m2" : ai.startsWith("313") ? "m3" : ai.startsWith("314") ? "m2" : ai.startsWith("315") ? "l" : "m3";
  }
}

function gs1Date(value: string | null) {
  if (!value || !/^\d{6}$/.test(value)) return null;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12 || day < 0 || day > 31) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const actualDay = day === 0 ? lastDay : day;
  if (actualDay > lastDay) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(actualDay).padStart(2, "0")}`;
}
