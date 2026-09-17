import type { Prisma } from "@/generated/tenant/client";
import { isValidGtin, parsePosScan, PosDomainError, type PosScan } from "@/lib/erp/pos-domain";

export const POS_PRODUCT_CODE_SYMBOLOGIES = ["gtin", "ean13", "ean8", "upca", "code128", "code39", "qr", "plu", "sku", "internal", "unknown"] as const;
export const POS_VARIABLE_LOOKUP_SYMBOLOGIES = ["plu", "sku", "internal"] as const;
export const POS_VARIABLE_VALUE_MODES = ["quantity", "total_price"] as const;
export const POS_VARIABLE_CHECK_DIGITS = ["gtin", "none"] as const;
export const POS_VARIABLE_VALUE_SCALES = [1, 10, 100, 1000] as const;

export type PosProductCodeSymbology = typeof POS_PRODUCT_CODE_SYMBOLOGIES[number];
export type PosVariableLookupSymbology = typeof POS_VARIABLE_LOOKUP_SYMBOLOGIES[number];
export type PosVariableValueMode = typeof POS_VARIABLE_VALUE_MODES[number];
export type PosVariableCheckDigit = typeof POS_VARIABLE_CHECK_DIGITS[number];

type CodeDb = Pick<Prisma.TransactionClient, "posProductCode" | "posVariableCodeRule">;
type CodeMapping = {
  id: number;
  productId: number;
  variationId: number | null;
  packageQuantity: number;
  unit: string | null;
  symbology: string;
  scopeKey: string;
  priority: number;
};
export type PosVariableRuleShape = {
  id: string;
  branchId: number;
  name: string;
  prefix: string;
  totalLength: number;
  productCodeStart: number;
  productCodeLength: number;
  lookupSymbology: string;
  valueStart: number;
  valueLength: number;
  valueMode: string;
  valueScale: number;
  measurementUnit: string;
  checkDigitAlgorithm: string;
  priority: number;
};

export type PosVariableCodeDecoded = {
  ruleId: string;
  ruleName: string;
  productCode: string;
  rawValue: string;
  scaledValue: number;
  valueMode: PosVariableValueMode;
  measurementUnit: string;
  priority: number;
};

export type PosProductCodeResolution = {
  scan: PosScan;
  mapping: CodeMapping;
  variable: PosVariableCodeDecoded | null;
};

export function normalizePosProductCode(value: unknown) {
  if (typeof value !== "string" || value.length > 256) throw new PosDomainError("Código de produto inválido.");
  const normalized = value.normalize("NFKC").trim().replace(/[^0-9A-Za-z]/g, "");
  if (!normalized || normalized.length > 160) throw new PosDomainError("Código de produto inválido.");
  return normalized;
}

export function assertPosProductCodeFormat(code: string, symbology: PosProductCodeSymbology) {
  const normalized = normalizePosProductCode(code);
  const expectedLength = symbology === "ean13" ? 13 : symbology === "ean8" ? 8 : symbology === "upca" ? 12 : null;
  if (expectedLength && (normalized.length !== expectedLength || !/^\d+$/.test(normalized) || !isValidGtin(normalized))) throw new PosDomainError(`${symbology.toUpperCase()} inválido: confira tamanho e dígito verificador.`);
  if (symbology === "gtin" && (!/^\d{8}$|^\d{12,14}$/.test(normalized) || !isValidGtin(normalized))) throw new PosDomainError("GTIN inválido: confira tamanho e dígito verificador.");
  if (symbology === "plu" && !/^\d{1,20}$/.test(normalized)) throw new PosDomainError("PLU deve conter somente dígitos.");
  return normalized;
}

export function decodePosVariableCode(raw: string, rule: PosVariableRuleShape): PosVariableCodeDecoded | null {
  const digits = raw.trim().replace(/^\][A-Za-z][0-9]/, "");
  if (!/^\d+$/.test(digits) || digits.length !== rule.totalLength || !digits.startsWith(rule.prefix)) return null;
  validateRuleShape(rule);
  if (rule.checkDigitAlgorithm === "gtin" && !isValidGtin(digits)) throw new PosDomainError(`Etiqueta variável inválida para a regra ${rule.name}: dígito verificador não confere.`);
  const productCode = digits.slice(rule.productCodeStart, rule.productCodeStart + rule.productCodeLength);
  const rawValue = digits.slice(rule.valueStart, rule.valueStart + rule.valueLength);
  if (!productCode || !rawValue || !/^\d+$/.test(productCode) || !/^\d+$/.test(rawValue)) throw new PosDomainError(`Etiqueta variável inválida para a regra ${rule.name}.`);
  const integer = BigInt(rawValue);
  if (integer <= BigInt(0) || integer > BigInt(999_999) * BigInt(rule.valueScale)) throw new PosDomainError(`Valor da etiqueta variável fora do limite para a regra ${rule.name}.`);
  const scaledValue = Number(integer) / rule.valueScale;
  if (!Number.isSafeInteger(Math.round(scaledValue * 1000)) || scaledValue <= 0 || scaledValue > 999_999) throw new PosDomainError(`Valor da etiqueta variável inválido para a regra ${rule.name}.`);
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    productCode,
    rawValue,
    scaledValue,
    valueMode: rule.valueMode as PosVariableValueMode,
    measurementUnit: rule.measurementUnit,
    priority: rule.priority,
  };
}

export async function resolvePosProductCode(db: CodeDb, branchId: number, raw: unknown): Promise<PosProductCodeResolution | null> {
  const scan = parsePosScan(raw);
  const normalized = normalizePosProductCode(scan.lookup);
  const direct = await mappedCode(db, branchId, normalized);
  if (direct) {
    if (["gtin", "ean13", "ean8", "upca"].includes(direct.symbology) && scan.gtin && !isValidGtin(scan.gtin)) throw new PosDomainError("GTIN inválido: dígito verificador não confere.");
    return { scan, mapping: direct, variable: null };
  }
  const rules = await db.posVariableCodeRule.findMany({
    where: { branchId, status: "active" },
    orderBy: [{ priority: "desc" }, { id: "asc" }],
    take: 100,
  });
  const candidates = rules.filter(rule => scan.raw.trim().replace(/^\][A-Za-z][0-9]/, "").length === rule.totalLength && scan.raw.trim().replace(/^\][A-Za-z][0-9]/, "").startsWith(rule.prefix));
  if (!candidates.length) return null;
  const decoded = candidates.map(rule => decodePosVariableCode(scan.raw, rule)).filter((value): value is PosVariableCodeDecoded => value != null);
  if (!decoded.length) throw new PosDomainError("A etiqueta variável corresponde a uma regra da filial, mas seu conteúdo é inválido.");
  const highest = Math.max(...decoded.map(value => value.priority));
  const winners = decoded.filter(value => value.priority === highest);
  if (winners.length !== 1) throw new PosDomainError("Etiqueta variável ambígua. Ajuste a prioridade das regras desta filial.");
  const winner = winners[0];
  const rule = candidates.find(value => value.id === winner.ruleId)!;
  const mapping = await mappedCode(db, branchId, normalizePosProductCode(winner.productCode), rule.lookupSymbology);
  if (!mapping) throw new PosDomainError(`PLU ${winner.productCode} da etiqueta não está cadastrado ou ativo nesta filial.`);
  return { scan: { ...scan, lookup: winner.productCode }, mapping, variable: winner };
}

export function finalizePosProductCodeResolution(resolution: PosProductCodeResolution, unitPriceCents: number, productUnit: string) {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) throw new PosDomainError("Preço autoritativo inválido para a leitura.");
  let measuredQuantity = resolution.scan.measuredQuantity;
  let measuredTotalCents: number | null = null;
  if (resolution.variable?.valueMode === "quantity") measuredQuantity = resolution.variable.scaledValue;
  if (resolution.variable?.valueMode === "total_price") {
    measuredTotalCents = resolution.variable.scaledValue;
    if (!Number.isSafeInteger(measuredTotalCents) || measuredTotalCents <= 0 || measuredTotalCents > 2_147_483_647) throw new PosDomainError("Preço total da etiqueta variável não representa centavos inteiros válidos.");
    if (unitPriceCents <= 0) throw new PosDomainError("Produto com preço zerado não pode usar etiqueta de preço total.");
    measuredQuantity = Math.round(measuredTotalCents / unitPriceCents * 1000) / 1000;
    if (Math.round(unitPriceCents * measuredQuantity) !== measuredTotalCents) throw new PosDomainError("O preço total da etiqueta não pode ser representado com a precisão de quantidade do PDV.");
  }
  const quantity = measuredQuantity ?? resolution.mapping.packageQuantity;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999_999 || Math.abs(Math.round(quantity * 1000) - quantity * 1000) > 1e-9) throw new PosDomainError("Quantidade derivada do código inválida.");
  if (resolution.variable) {
    const expectedUnit = normalizeUnit(resolution.variable.measurementUnit);
    const mappedUnit = resolution.mapping.unit ? normalizeUnit(resolution.mapping.unit) : null;
    const authoritativeProductUnit = normalizeUnit(productUnit);
    if (mappedUnit && expectedUnit !== mappedUnit) throw new PosDomainError(`A regra ${resolution.variable.ruleName} mede ${resolution.variable.measurementUnit}, mas o código usa ${resolution.mapping.unit}.`);
    if (expectedUnit !== authoritativeProductUnit) throw new PosDomainError(`A regra ${resolution.variable.ruleName} mede ${resolution.variable.measurementUnit}, mas o produto usa ${productUnit}.`);
  }
  return {
    scan: {
      ...resolution.scan,
      measuredQuantity: quantity,
      measurementUnit: resolution.variable?.measurementUnit || resolution.scan.measurementUnit || resolution.mapping.unit,
      packageQuantity: resolution.mapping.packageQuantity,
      symbology: resolution.variable ? "variable_plu" : resolution.mapping.symbology,
      productCodeId: resolution.mapping.id,
      variableRuleId: resolution.variable?.ruleId || null,
      measuredTotalCents,
      codeRead: { raw: resolution.scan.raw },
    },
    quantity,
    measuredTotalCents,
  };
}

export async function assertAuthoritativePosCodeReads(db: CodeDb, branchId: number, lines: Array<{
  productId: number;
  variationId: number | null;
  quantity: number;
  unitPriceCents: number;
  productUnit: string;
  scanData: Prisma.InputJsonObject | undefined;
}>) {
  for (const line of lines) {
    const reads = posCodeReads(line.scanData);
    if (!reads.length) continue;
    let quantityMillis = 0;
    for (const raw of reads) {
      const resolution = await resolvePosProductCode(db, branchId, raw);
      if (!resolution) throw new PosDomainError("Um código lido foi removido ou não está mais disponível nesta filial.");
      if (resolution.mapping.productId !== line.productId || resolution.mapping.variationId !== line.variationId) throw new PosDomainError("Um código lido agora aponta para outro produto ou variação. Refaça a leitura.");
      const finalized = finalizePosProductCodeResolution(resolution, line.unitPriceCents, line.productUnit);
      quantityMillis += Math.round(finalized.quantity * 1000);
    }
    if (quantityMillis !== Math.round(line.quantity * 1000)) throw new PosDomainError("A quantidade do item não corresponde às leituras autoritativas de código/embalagem/PLU.");
  }
}

export function posCodeReads(scanData: Prisma.InputJsonObject | undefined) {
  if (!scanData) return [] as string[];
  const values = Array.isArray(scanData.codeReads) ? scanData.codeReads : scanData.codeRead ? [scanData.codeRead] : [];
  if (values.length > 200) throw new PosDomainError("Quantidade excessiva de leituras de código no item.");
  return values.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "raw") || typeof (value as { raw?: unknown }).raw !== "string") throw new PosDomainError("Snapshot de leitura de código inválido.");
    const raw = (value as { raw: string }).raw.trim();
    if (!raw || raw.length > 2048) throw new PosDomainError("Snapshot de leitura de código inválido.");
    return raw;
  });
}

async function mappedCode(db: CodeDb, branchId: number, normalizedCode: string, symbology?: string) {
  const rows = await db.posProductCode.findMany({
    where: {
      normalizedCode,
      active: true,
      scopeKey: { in: [`branch:${branchId}`, "global"] },
      ...(symbology ? { symbology } : {}),
    },
    select: { id: true, productId: true, variationId: true, packageQuantity: true, unit: true, symbology: true, scopeKey: true, priority: true },
    orderBy: [{ priority: "desc" }, { id: "asc" }],
    take: 4,
  });
  const scoped = rows.some(row => row.scopeKey === `branch:${branchId}`) ? rows.filter(row => row.scopeKey === `branch:${branchId}`) : rows.filter(row => row.scopeKey === "global");
  if (new Set(scoped.map(row => `${row.productId}:${row.variationId || 0}`)).size > 1) throw new PosDomainError("Código ambíguo. Corrija o cadastro antes de vender.");
  return scoped[0] || null;
}

function validateRuleShape(rule: PosVariableRuleShape) {
  const checkOffset = rule.checkDigitAlgorithm === "gtin" ? 1 : 0;
  const payloadEnd = rule.totalLength - checkOffset;
  const productEnd = rule.productCodeStart + rule.productCodeLength;
  const valueEnd = rule.valueStart + rule.valueLength;
  if (!/^\d{1,12}$/.test(rule.prefix)
    || !POS_VARIABLE_LOOKUP_SYMBOLOGIES.includes(rule.lookupSymbology as PosVariableLookupSymbology)
    || !POS_VARIABLE_VALUE_MODES.includes(rule.valueMode as PosVariableValueMode)
    || !POS_VARIABLE_CHECK_DIGITS.includes(rule.checkDigitAlgorithm as PosVariableCheckDigit)
    || !POS_VARIABLE_VALUE_SCALES.includes(rule.valueScale as typeof POS_VARIABLE_VALUE_SCALES[number])
    || rule.totalLength < 4 || rule.totalLength > 64
    || rule.productCodeStart < rule.prefix.length || rule.valueStart < rule.prefix.length
    || rule.productCodeLength < 1 || rule.productCodeLength > 20 || rule.valueLength < 1 || rule.valueLength > 20
    || productEnd > payloadEnd || valueEnd > payloadEnd
    || !(productEnd <= rule.valueStart || valueEnd <= rule.productCodeStart)
    || rule.checkDigitAlgorithm === "gtin" && ![8, 12, 13, 14].includes(rule.totalLength)
    || !rule.measurementUnit.trim() || rule.measurementUnit.trim().length > 20) throw new PosDomainError(`Configuração inválida na regra variável ${rule.name}.`);
}

function normalizeUnit(value: string) {
  return value.normalize("NFKC").trim().toUpperCase();
}
