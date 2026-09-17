import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePosProductCodeAdminInput } from "../lib/erp/pos-product-code-admin";
import {
  assertAuthoritativePosCodeReads,
  assertPosProductCodeFormat,
  decodePosVariableCode,
  finalizePosProductCodeResolution,
  normalizePosProductCode,
  resolvePosProductCode,
  type PosVariableRuleShape,
} from "../lib/erp/pos-product-codes";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const quantityRule: PosVariableRuleShape = {
  id: "rule-quantity", branchId: 1, name: "Peso filial", prefix: "20", totalLength: 13,
  productCodeStart: 2, productCodeLength: 5, lookupSymbology: "plu", valueStart: 7, valueLength: 5,
  valueMode: "quantity", valueScale: 1000, measurementUnit: "KG", checkDigitAlgorithm: "gtin", priority: 10,
};

test("normaliza código e valida GTIN/PLU conforme a simbologia cadastrada", () => {
  assert.equal(normalizePosProductCode(" SKU-00 42 "), "SKU0042");
  assert.equal(assertPosProductCodeFormat("7894900011517", "ean13"), "7894900011517");
  assert.equal(assertPosProductCodeFormat("00123", "plu"), "00123");
  assert.throws(() => assertPosProductCodeFormat("7894900011518", "ean13"), /dígito verificador/);
  assert.throws(() => assertPosProductCodeFormat("AB-12", "plu"), /somente dígitos/);
});

test("regra configurável extrai PLU e quantidade sem prefixo global hard-coded", () => {
  const rule = { ...quantityRule, prefix: "77", name: "Prefixo próprio" };
  const raw = ean13("771234500125");
  assert.deepEqual(decodePosVariableCode(raw, rule), {
    ruleId: rule.id, ruleName: rule.name, productCode: "12345", rawValue: "00125", scaledValue: 0.125,
    valueMode: "quantity", measurementUnit: "KG", priority: 10,
  });
  assert.equal(decodePosVariableCode(ean13("201234500125"), rule), null);
  assert.throws(() => decodePosVariableCode(`${raw.slice(0, -1)}${(Number(raw.at(-1)) + 1) % 10}`, rule), /dígito verificador/);
});

test("preço total deriva quantidade representável e falha fechado em unidade divergente", () => {
  const raw = ean13("201234500125"), variable = decodePosVariableCode(raw, { ...quantityRule, id: "price", valueMode: "total_price", valueScale: 1 })!;
  const resolution = { scan: { raw, lookup: "12345", gtin: raw, lot: null, serial: null, expiresOn: null, measuredQuantity: null, measurementUnit: null, kind: "linear" as const }, mapping: mapping(), variable };
  const result = finalizePosProductCodeResolution(resolution, 1000, "KG");
  assert.equal(result.quantity, 0.125);
  assert.equal(result.measuredTotalCents, 125);
  assert.throws(() => finalizePosProductCodeResolution(resolution, 1000, "UN"), /mede KG/);
  assert.throws(() => finalizePosProductCodeResolution(resolution, 10_000, "KG"), /precisão de quantidade/);
});

test("resolver respeita regra da filial, simbologia PLU e revalida leituras na cotação", async () => {
  const raw = ean13("201234500125"), calls: string[] = [];
  const db = {
    posVariableCodeRule: { findMany: async () => [quantityRule] },
    posProductCode: { findMany: async ({ where }: { where: { normalizedCode: string } }) => {
      calls.push(where.normalizedCode);
      return where.normalizedCode === "12345" ? [mapping()] : [];
    } },
  };
  const resolution = await resolvePosProductCode(db as never, 1, raw);
  assert.ok(resolution?.variable);
  assert.deepEqual(calls, [raw, "12345"]);
  await assert.doesNotReject(assertAuthoritativePosCodeReads(db as never, 1, [{
    productId: 9, variationId: null, quantity: 0.125, unitPriceCents: 1000, productUnit: "KG", scanData: { codeReads: [{ raw }] },
  }]));
  await assert.rejects(assertAuthoritativePosCodeReads(db as never, 1, [{
    productId: 9, variationId: null, quantity: 0.126, unitPriceCents: 1000, productUnit: "KG", scanData: { codeReads: [{ raw }] },
  }]), /não corresponde/);
});

test("parser administrativo fecha escopo, embalagem e segmentos sobrepostos", () => {
  const code = parsePosProductCodeAdminInput({
    action: "product_code.create", idempotencyKey: "product-code-test-0001", branchId: 1, productId: 9, variationId: null,
    scope: "branch", code: "00123", symbology: "plu", packageQuantity: 12, unit: "UN", packageLabel: "Caixa com 12", priority: 0,
  });
  assert.equal(code.action, "product_code.create");
  assert.equal(code.packageQuantity, 12);
  assert.throws(() => parsePosProductCodeAdminInput({ ...code, idempotencyKey: "product-code-test-0002", packageQuantity: 0.0001 }), /três casas/);
  assert.throws(() => parsePosProductCodeAdminInput({
    action: "variable_code_rule.create", idempotencyKey: "variable-rule-test-0001", branchId: 1, name: "Inválida", prefix: "20", totalLength: 13,
    productCodeStart: 2, productCodeLength: 6, lookupSymbology: "plu", valueStart: 7, valueLength: 5, valueMode: "quantity", valueScale: 1000,
    measurementUnit: "KG", checkDigitAlgorithm: "gtin", priority: 0,
  }), /Configuração inválida/);
});

test("migration cria regra por filial, CAS e ações administrativas sem prefixo de negócio", () => {
  const migration = readFileSync(`${projectRoot}/prisma/tenant/migrations/20260829130000_pos_product_code_admin/migration.sql`, "utf8");
  for (const token of ["pos_variable_code_rules", "product_code.create", "product_code.update", "product_code.deactivate", "variable_code_rule.create", "pos_variable_code_rules_format_check", "pos_product_codes_values_check"]) assert.match(migration, new RegExp(token.replaceAll(".", "\\.")));
  assert.match(migration, /"value_mode" IN \('quantity', 'total_price'\)/);
  assert.match(migration, /"value_scale" IN \(1, 10, 100, 1000\)/);
  assert.doesNotMatch(readFileSync(`${projectRoot}/lib/erp/pos-product-codes.ts`, "utf8"), /prefix\s*===\s*["'](?:2|20|21|22|23|24|25|26|27|28|29)["']/);
});

function mapping() {
  return { id: 4, productId: 9, variationId: null, packageQuantity: 1, unit: "KG", symbology: "plu", scopeKey: "branch:1", priority: 0 };
}

function ean13(base: string) {
  assert.match(base, /^\d{12}$/);
  const sum = [...base].reduce((total, value, index) => total + Number(value) * (index % 2 === 0 ? 1 : 3), 0);
  return `${base}${(10 - sum % 10) % 10}`;
}
