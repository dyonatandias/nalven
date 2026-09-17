import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "lib/erp/pos-scanner-capture.ts"), "utf8");

test("core não depende de globals de navegador, relógio, storage ou aleatoriedade", () => {
  for (const forbidden of ["window", "document", "navigator", "performance", "localStorage", "sessionStorage", "crypto.randomUUID", "Date.now"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden.replace(".", "\\.")}\\b`));
  }
  assert.match(source, /atMs: number/);
  assert.match(source, /this\.sequence \+= 1/);
});

test("contrato mantém contexto protegido, configuração, FIFO e captureId no processamento", () => {
  for (const evidence of [
    "operationActive",
    "wedgeSessionActive",
    "protected_target",
    "sourceIdentified",
    "unidentified",
    "purpose !== \"scanner\"",
    "prefixKeys",
    "suffixKeys",
    "interKeyTimeoutMs",
    "duplicateWindowMs",
    "maximumLength",
    "queueLimit",
    "resultLimit",
    "this.pending.push",
    "this.pending.shift",
    "this.inFlight.add(item.captureId)",
    "settle(captureId",
  ]) assert.match(source, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /posScannerWedgeProtectionAvailable/);
  assert.match(source, /HID wedge sem prefixo exige sessão identificada, campo dedicado\/read-only ou agente de scanner/);
});

test("resultado público é allowlist sem campo de código, mensagem ou payload", () => {
  const resultType = source.slice(source.indexOf("export type PosScannerCaptureResult"), source.indexOf("export type PosScannerCaptureTarget"));
  assert.match(resultType, /captureId: string/);
  assert.match(resultType, /status: "accepted" \| "rejected" \| "duplicate"/);
  assert.match(resultType, /reasonCode: PosScannerCaptureReasonCode/);
  assert.doesNotMatch(resultType, /\b(?:code|raw|payload|message|error)\b/i);
  assert.match(source, /PROCESSOR_REJECTION_REASONS\.has\(decision\.reasonCode\) \? decision\.reasonCode : "processor_error"/);
});

test("dedupe usa identidade física/captureId e nunca compara o conteúdo lido", () => {
  assert.match(source, /recentDeliveryIds/);
  assert.match(source, /recentCaptureIds/);
  assert.match(source, /duplicate_terminator/);
  assert.match(source, /duplicate_delivery/);
  assert.doesNotMatch(source, /recentCodes|lastCode|codeHash|previousCode|sameCode/);
});
