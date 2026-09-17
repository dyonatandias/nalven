import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePosReadinessMatrix, summarizePosReadiness } from "../lib/erp/pos-readiness";

const matrix = readFileSync(fileURLToPath(new URL("../docs/erp/pdv/PLANO-E-RASTREABILIDADE.md", import.meta.url)), "utf8");

test("matriz de prontidão tem IDs únicos, estados fechados e bloqueia produção honestamente", () => {
  const items = parsePosReadinessMatrix(matrix), report = summarizePosReadiness(items);
  assert.ok(items.length >= 40);
  assert.equal(report.total, items.length);
  assert.equal(Object.values(report.counts).reduce((sum, value) => sum + value, 0), items.length);
  assert.equal(report.productionReady, false);
  for (const id of ["POS-604", "POS-605", "POS-701"]) assert.ok(report.productionBlockers.some(item => item.id === id), `${id} deve continuar bloqueando produção`);
});

test("parser rejeita duplicidade, estado arbitrário e matriz vazia", () => {
  const valid = "| POS-101 | Caixa | P0 | DONE | evidência |";
  assert.equal(parsePosReadinessMatrix(valid).length, 1);
  assert.throws(() => parsePosReadinessMatrix(`${valid}\n${valid}`), /duplicado/);
  assert.throws(() => parsePosReadinessMatrix("| POS-101 | Caixa | P0 | READY | evidência |"), /malformada/);
  assert.throws(() => parsePosReadinessMatrix("# sem matriz"), /ausente/);
});
