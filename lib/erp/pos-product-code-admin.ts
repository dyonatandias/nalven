import { createHash } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import {
  assertPosProductCodeFormat,
  decodePosVariableCode,
  POS_PRODUCT_CODE_SYMBOLOGIES,
  POS_VARIABLE_CHECK_DIGITS,
  POS_VARIABLE_LOOKUP_SYMBOLOGIES,
  POS_VARIABLE_VALUE_MODES,
  POS_VARIABLE_VALUE_SCALES,
  type PosProductCodeSymbology,
  type PosVariableCheckDigit,
  type PosVariableLookupSymbology,
  type PosVariableValueMode,
} from "@/lib/erp/pos-product-codes";

export const POS_PRODUCT_CODE_ADMIN_ACTIONS = [
  "product_code.create", "product_code.update", "product_code.deactivate",
  "variable_code_rule.create", "variable_code_rule.update", "variable_code_rule.deactivate",
] as const;

type Common = { action: typeof POS_PRODUCT_CODE_ADMIN_ACTIONS[number]; idempotencyKey: string };
type CodeFields = {
  branchId: number;
  productId: number;
  variationId: number | null;
  scope: "global" | "branch";
  code: string;
  symbology: PosProductCodeSymbology;
  packageQuantity: number;
  unit: string | null;
  packageLabel: string | null;
  priority: number;
};
type RuleFields = {
  branchId: number;
  name: string;
  prefix: string;
  totalLength: number;
  productCodeStart: number;
  productCodeLength: number;
  lookupSymbology: PosVariableLookupSymbology;
  valueStart: number;
  valueLength: number;
  valueMode: PosVariableValueMode;
  valueScale: typeof POS_VARIABLE_VALUE_SCALES[number];
  measurementUnit: string;
  checkDigitAlgorithm: PosVariableCheckDigit;
  priority: number;
};

export type PosProductCodeAdminInput =
  | Common & CodeFields & { action: "product_code.create" }
  | Common & CodeFields & { action: "product_code.update"; codeId: number }
  | Common & { action: "product_code.deactivate"; branchId: number; codeId: number }
  | Common & RuleFields & { action: "variable_code_rule.create" }
  | Common & RuleFields & { action: "variable_code_rule.update"; ruleId: string }
  | Common & { action: "variable_code_rule.deactivate"; branchId: number; ruleId: string };

export class PosProductCodeAdminError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosProductCodeAdminError";
  }
}

export function parsePosProductCodeAdminInput(body: Record<string, unknown>): PosProductCodeAdminInput {
  const action = choice(body.action, POS_PRODUCT_CODE_ADMIN_ACTIONS, "Ação"), idempotencyKey = key(body.idempotencyKey);
  if (action === "product_code.deactivate") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "codeId"]);
    return { action, idempotencyKey, branchId: id(body.branchId, "Filial"), codeId: id(body.codeId, "Código") };
  }
  if (action === "variable_code_rule.deactivate") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "ruleId"]);
    return { action, idempotencyKey, branchId: id(body.branchId, "Filial"), ruleId: stringId(body.ruleId, "Regra") };
  }
  if (action === "product_code.create" || action === "product_code.update") {
    onlyKeys(body, ["action", "idempotencyKey", ...(action === "product_code.update" ? ["codeId"] : []), "branchId", "productId", "variationId", "scope", "code", "symbology", "packageQuantity", "unit", "packageLabel", "priority"]);
    const symbology = choice(body.symbology, POS_PRODUCT_CODE_SYMBOLOGIES, "Simbologia");
    const code = text(body.code, "Código", 1, 256);
    try { assertPosProductCodeFormat(code, symbology); } catch (error) { throw asAdminError(error); }
    const parsed = {
      action,
      idempotencyKey,
      ...(action === "product_code.update" ? { codeId: id(body.codeId, "Código") } : {}),
      branchId: id(body.branchId, "Filial"),
      productId: id(body.productId, "Produto"),
      variationId: nullableId(body.variationId, "Variação"),
      scope: choice(body.scope, ["global", "branch"] as const, "Escopo"),
      code,
      symbology,
      packageQuantity: decimalQuantity(body.packageQuantity, "Multiplicador da embalagem"),
      unit: nullableText(body.unit, "Unidade", 20)?.toUpperCase() || null,
      packageLabel: nullableText(body.packageLabel, "Embalagem", 80),
      priority: integer(body.priority, "Prioridade", -1000, 1000),
    };
    return parsed as PosProductCodeAdminInput;
  }
  const update = action === "variable_code_rule.update";
  onlyKeys(body, ["action", "idempotencyKey", ...(update ? ["ruleId"] : []), "branchId", "name", "prefix", "totalLength", "productCodeStart", "productCodeLength", "lookupSymbology", "valueStart", "valueLength", "valueMode", "valueScale", "measurementUnit", "checkDigitAlgorithm", "priority"]);
  const parsed = {
    action,
    idempotencyKey,
    ...(update ? { ruleId: stringId(body.ruleId, "Regra") } : {}),
    branchId: id(body.branchId, "Filial"),
    name: text(body.name, "Nome", 2, 160),
    prefix: pattern(body.prefix, "Prefixo", /^\d{1,12}$/),
    totalLength: integer(body.totalLength, "Comprimento total", 4, 64),
    productCodeStart: integer(body.productCodeStart, "Início do PLU", 0, 63),
    productCodeLength: integer(body.productCodeLength, "Tamanho do PLU", 1, 20),
    lookupSymbology: choice(body.lookupSymbology, POS_VARIABLE_LOOKUP_SYMBOLOGIES, "Simbologia do PLU"),
    valueStart: integer(body.valueStart, "Início do valor", 0, 63),
    valueLength: integer(body.valueLength, "Tamanho do valor", 1, 20),
    valueMode: choice(body.valueMode, POS_VARIABLE_VALUE_MODES, "Modo do valor"),
    valueScale: integerChoice(body.valueScale, POS_VARIABLE_VALUE_SCALES, "Divisor do valor"),
    measurementUnit: text(body.measurementUnit, "Unidade medida", 1, 20).toUpperCase(),
    checkDigitAlgorithm: choice(body.checkDigitAlgorithm, POS_VARIABLE_CHECK_DIGITS, "Dígito verificador"),
    priority: integer(body.priority, "Prioridade", -1000, 1000),
  } as PosProductCodeAdminInput;
  const rule = parsed as Extract<PosProductCodeAdminInput, { action: "variable_code_rule.create" | "variable_code_rule.update" }>;
  try {
    decodePosVariableCode(exampleForRule(rule), { id: "validation", ...rule });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("dígito verificador")) throw asAdminError(error);
  }
  return parsed;
}

export function hashPosProductCodeAdminInput(input: PosProductCodeAdminInput) {
  const payload = { ...input } as Record<string, unknown>;
  delete payload.idempotencyKey;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export async function applyPosProductCodeAdminMutation(tx: Prisma.TransactionClient, input: PosProductCodeAdminInput) {
  await activeBranch(tx, input.branchId);
  if (input.action === "product_code.create" || input.action === "product_code.update") {
    const normalizedCode = assertPosProductCodeFormat(input.code, input.symbology);
    await activeCodeTarget(tx, input.branchId, input.productId, input.variationId);
    const data = {
      productId: input.productId,
      variationId: input.variationId,
      branchId: input.scope === "branch" ? input.branchId : null,
      scopeKey: input.scope === "branch" ? `branch:${input.branchId}` : "global",
      code: input.code,
      normalizedCode,
      symbology: input.symbology,
      packageQuantity: input.packageQuantity,
      unit: input.unit,
      priority: input.priority,
      metadata: input.packageLabel ? { packageLabel: input.packageLabel } : Prisma.DbNull,
    };
    if (input.action === "product_code.create") {
      const created = await tx.posProductCode.create({ data });
      return { status: 201, entityType: "pos_product_code", entityId: String(created.id), before: null, body: { code: posProductCodeDto(created) } };
    }
    const before = await lockedCode(tx, input.codeId);
    assertCodeBranch(before, input.branchId);
    if (!before.active) throw new PosProductCodeAdminError("Código desativado não pode ser editado.", 409);
    const changed = await tx.posProductCode.updateMany({ where: { id: before.id, version: before.version, updatedAt: before.updatedAt, active: true }, data: { ...data, version: { increment: 1 } } });
    if (changed.count !== 1) throw concurrent();
    const saved = await tx.posProductCode.findUniqueOrThrow({ where: { id: before.id } });
    return { status: 200, entityType: "pos_product_code", entityId: String(saved.id), before: posProductCodeDto(before), body: { code: posProductCodeDto(saved) } };
  }
  if (input.action === "product_code.deactivate") {
    const before = await lockedCode(tx, input.codeId);
    assertCodeBranch(before, input.branchId);
    if (!before.active) throw new PosProductCodeAdminError("Código já está desativado.", 409);
    const changed = await tx.posProductCode.updateMany({ where: { id: before.id, version: before.version, updatedAt: before.updatedAt, active: true }, data: { active: false, version: { increment: 1 } } });
    if (changed.count !== 1) throw concurrent();
    const saved = await tx.posProductCode.findUniqueOrThrow({ where: { id: before.id } });
    return { status: 200, entityType: "pos_product_code", entityId: String(saved.id), before: posProductCodeDto(before), body: { code: posProductCodeDto(saved) } };
  }
  if (input.action === "variable_code_rule.create" || input.action === "variable_code_rule.update") {
    const data = ruleData(input);
    if (input.action === "variable_code_rule.create") {
      const created = await tx.posVariableCodeRule.create({ data });
      return { status: 201, entityType: "pos_variable_code_rule", entityId: created.id, before: null, body: { rule: posVariableCodeRuleDto(created) } };
    }
    const before = await lockedRule(tx, input.ruleId);
    if (before.branchId !== input.branchId) throw new PosProductCodeAdminError("Regra não pertence à filial.", 404);
    if (before.status !== "active") throw new PosProductCodeAdminError("Regra desativada não pode ser editada.", 409);
    const changed = await tx.posVariableCodeRule.updateMany({ where: { id: before.id, version: before.version, updatedAt: before.updatedAt, status: "active" }, data: { ...data, version: { increment: 1 } } });
    if (changed.count !== 1) throw concurrent();
    const saved = await tx.posVariableCodeRule.findUniqueOrThrow({ where: { id: before.id } });
    return { status: 200, entityType: "pos_variable_code_rule", entityId: saved.id, before: posVariableCodeRuleDto(before), body: { rule: posVariableCodeRuleDto(saved) } };
  }
  const before = await lockedRule(tx, input.ruleId);
  if (before.branchId !== input.branchId) throw new PosProductCodeAdminError("Regra não pertence à filial.", 404);
  if (before.status !== "active") throw new PosProductCodeAdminError("Regra já está desativada.", 409);
  const changed = await tx.posVariableCodeRule.updateMany({ where: { id: before.id, version: before.version, updatedAt: before.updatedAt, status: "active" }, data: { status: "inactive", version: { increment: 1 } } });
  if (changed.count !== 1) throw concurrent();
  const saved = await tx.posVariableCodeRule.findUniqueOrThrow({ where: { id: before.id } });
  return { status: 200, entityType: "pos_variable_code_rule", entityId: saved.id, before: posVariableCodeRuleDto(before), body: { rule: posVariableCodeRuleDto(saved) } };
}

export function posProductCodeDto(value: { id: number; productId: number; variationId: number | null; branchId: number | null; scopeKey: string; code: string; normalizedCode: string; symbology: string; packageQuantity: number; unit: string | null; priority: number; active: boolean; version: number; metadata: Prisma.JsonValue | null; createdAt: Date; updatedAt: Date }) {
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? value.metadata as Record<string, unknown> : null;
  return {
    id: value.id, productId: value.productId, variationId: value.variationId, branchId: value.branchId, scope: value.scopeKey === "global" ? "global" : "branch",
    code: value.code, normalizedCode: value.normalizedCode, symbology: value.symbology, packageQuantity: value.packageQuantity, unit: value.unit,
    packageLabel: typeof metadata?.packageLabel === "string" ? metadata.packageLabel : null, priority: value.priority, active: value.active, version: value.version,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

export function posVariableCodeRuleDto(value: { id: string; branchId: number; name: string; status: string; prefix: string; totalLength: number; productCodeStart: number; productCodeLength: number; lookupSymbology: string; valueStart: number; valueLength: number; valueMode: string; valueScale: number; measurementUnit: string; checkDigitAlgorithm: string; priority: number; version: number; createdAt: Date; updatedAt: Date }) {
  return { ...value };
}

function ruleData(input: Extract<PosProductCodeAdminInput, { action: "variable_code_rule.create" | "variable_code_rule.update" }>) {
  return {
    branchId: input.branchId, name: input.name, prefix: input.prefix, totalLength: input.totalLength,
    productCodeStart: input.productCodeStart, productCodeLength: input.productCodeLength, lookupSymbology: input.lookupSymbology,
    valueStart: input.valueStart, valueLength: input.valueLength, valueMode: input.valueMode, valueScale: input.valueScale,
    measurementUnit: input.measurementUnit, checkDigitAlgorithm: input.checkDigitAlgorithm, priority: input.priority,
  };
}

async function activeBranch(tx: Prisma.TransactionClient, branchId: number) {
  if (!await tx.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } })) throw new PosProductCodeAdminError("Filial ativa não encontrada.", 404);
}

async function activeCodeTarget(tx: Prisma.TransactionClient, branchId: number, productId: number, variationId: number | null) {
  const product = await tx.product.findFirst({ where: { id: productId, active: true, branchConfigurations: { some: { branchId, active: true, saleEnabled: true } } }, select: { id: true } });
  if (!product) throw new PosProductCodeAdminError("Produto ativo e vendável na filial não encontrado.", 404);
  if (variationId && !await tx.productVariation.findFirst({ where: { id: variationId, productId, enabled: true }, select: { id: true } })) throw new PosProductCodeAdminError("Variação ativa e compatível não encontrada.", 404);
}

async function lockedCode(tx: Prisma.TransactionClient, id: number) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_product_codes" WHERE "id" = ${id} FOR UPDATE`);
  const code = await tx.posProductCode.findUnique({ where: { id } });
  if (!code) throw new PosProductCodeAdminError("Código não encontrado.", 404);
  return code;
}

async function lockedRule(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_variable_code_rules" WHERE "id" = ${id} FOR UPDATE`);
  const rule = await tx.posVariableCodeRule.findUnique({ where: { id } });
  if (!rule) throw new PosProductCodeAdminError("Regra variável não encontrada.", 404);
  return rule;
}

function assertCodeBranch(code: { branchId: number | null; scopeKey: string }, branchId: number) {
  if (code.scopeKey !== "global" && code.branchId !== branchId) throw new PosProductCodeAdminError("Código não pertence à filial.", 404);
}

function exampleForRule(rule: Extract<PosProductCodeAdminInput, { action: "variable_code_rule.create" | "variable_code_rule.update" }>) {
  const chars = Array.from({ length: rule.totalLength }, () => "1");
  for (let index = 0; index < rule.prefix.length; index += 1) chars[index] = rule.prefix[index];
  return chars.join("");
}

function asAdminError(error: unknown) { return new PosProductCodeAdminError(error instanceof Error ? error.message : "Código ou regra inválida."); }
function concurrent() { return new PosProductCodeAdminError("O cadastro mudou durante a operação. Atualize e tente novamente.", 409); }
function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(body).find(field => !allowed.includes(field)); if (extra) throw new PosProductCodeAdminError(`Campo não permitido: ${extra}.`); }
function key(value: unknown) { if (typeof value !== "string") throw new PosProductCodeAdminError("Chave idempotente inválida."); const result = value.trim(); if (result.length < 16 || result.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosProductCodeAdminError("Chave idempotente inválida."); return result; }
function id(value: unknown, label: string) { return integer(value, label, 1, 2_147_483_647); }
function nullableId(value: unknown, label: string) { return value == null || value === "" ? null : id(value, label); }
function integer(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosProductCodeAdminError(`${label} inválido.`); return value; }
function decimalQuantity(value: unknown, label: string) { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 999_999 || Math.abs(Math.round(value * 1000) - value * 1000) > 1e-9) throw new PosProductCodeAdminError(`${label} deve ser positivo e ter no máximo três casas decimais.`); return value; }
function text(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "string") throw new PosProductCodeAdminError(`${label} inválido.`); const result = value.normalize("NFKC").trim(); if (result.length < minimum || result.length > maximum) throw new PosProductCodeAdminError(`${label} inválido.`); return result; }
function nullableText(value: unknown, label: string, maximum: number) { return value == null || value === "" ? null : text(value, label, 1, maximum); }
function stringId(value: unknown, label: string) { return text(value, label, 1, 160); }
function pattern(value: unknown, label: string, expression: RegExp) { const result = text(value, label, 1, 160); if (!expression.test(result)) throw new PosProductCodeAdminError(`${label} inválido.`); return result; }
function choice<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] { if (typeof value !== "string" || !values.includes(value)) throw new PosProductCodeAdminError(`${label} inválido.`); return value as T[number]; }
function integerChoice<const T extends readonly number[]>(value: unknown, values: T, label: string): T[number] { if (typeof value !== "number" || !values.includes(value)) throw new PosProductCodeAdminError(`${label} inválido.`); return value as T[number]; }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(field => `${JSON.stringify(field)}:${canonicalJson(record[field])}`).join(",")}}`; }
