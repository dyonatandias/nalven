import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const workspace = readFileSync(join(root, "components/erp/pdv-workspace.tsx"), "utf8");

test("workspace usa o core congelado e remove o buffer HID heurístico anterior", () => {
  assert.match(workspace, /new PosScannerCaptureCore\(posScannerConfiguration, "hid"\)/);
  assert.match(workspace, /prefixKeys: \["F9"\]/);
  assert.match(workspace, /scannerCapture\.feed\(\{/);
  assert.match(workspace, /scannerCapture\.offerCode\(\{/);
  assert.match(workspace, /scannerCapture\.drain\(/);
  assert.doesNotMatch(workspace, /scannerBuffer|new PosScanQueue|drainPosScanQueue/);
});

test("adaptador só impede a tecla reconhecida e fornece política operacional/alvo", () => {
  assert.match(workspace, /if \(outcome\.consumed\) event\.preventDefault\(\)/);
  assert.match(workspace, /operationActive: Boolean\(operation \|\| requestLock\.current\)/);
  assert.match(workspace, /wedgeSessionActive: false/);
  assert.match(workspace, /target: posScannerTarget\(event\.target, scanRef\.current\)/);
  assert.match(workspace, /purpose: "credential"/);
  assert.match(workspace, /purpose: "financial"/);
  assert.match(workspace, /purpose: "scanner"/);
});

test("câmera e entrada manual preservam captureId sem publicar payload da fila", () => {
  assert.match(workspace, /enqueueScanCode\(detectedCode, `camera:\$\{\+\+scanCaptureSequence\.current\}`\)/);
  assert.match(workspace, /enqueueScanCode\(scan, `input:\$\{scanInputRevision\.current\}`\)/);
  assert.match(workspace, /captureId,/);
  assert.match(workspace, /useState<PosScannerCaptureResult \| null>\(null\)/);
  assert.match(workspace, /posScannerResultStatus\(lastScanResult\)/);
  assert.doesNotMatch(workspace, /setLastScanResult\([^)]*code/);
});

test("modais operacionais migrados usam a camada acessível sem alterar cash/close", () => {
  for (const title of [
    "Aponte para o código",
    "Pausar ou passar o turno",
    "Transferir carrinho suspenso",
    "Funcionários por caixa",
    "Cliente rápido",
    "Comprovante comercial",
  ]) assert.match(workspace, new RegExp(`<PdvAccessibleModal[^>]*title=${title.includes(" ") ? `"${title}"` : `"${title}"`}`));
  assert.match(workspace, /returnFocusRef=\{returnFocus\}/);
  assert.match(workspace, /busy=\{busy\}/);
  assert.match(workspace, /function CashDialog/);
  assert.match(workspace, /function CloseDialog/);
});
