import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPosScannerWedgeProtectionAvailable,
  createPosScannerCaptureConfiguration,
  PosScannerCaptureCore,
  posScannerWedgeBlockReason,
  posScannerWedgeProtectionAvailable,
  type PosScannerCaptureContext,
} from "../lib/erp/pos-scanner-capture";

const body: PosScannerCaptureContext = { operationActive: false, wedgeSessionActive: false, target: { tagName: "BODY", purpose: "ordinary" } };
const configuration = createPosScannerCaptureConfiguration({
  prefixKeys: ["F9"],
  suffixKeys: ["Enter"],
  interKeyTimeoutMs: 80,
  duplicateWindowMs: 200,
  minimumLength: 3,
  maximumLength: 16,
  queueLimit: 4,
  resultLimit: 4,
});

function scan(core: PosScannerCaptureCore, code: string, startAtMs: number) {
  let atMs = startAtMs;
  core.feed({ key: "F9", atMs, context: body });
  for (const key of code) core.feed({ key, atMs: atMs += 5, context: body });
  return core.feed({ key: "Enter", atMs: atMs + 5, context: body });
}

test("política wedge classifica operação, edição, financeiro e credencial", () => {
  assert.equal(posScannerWedgeBlockReason({ operationActive: true, wedgeSessionActive: false, target: { tagName: "BODY" } }), "operation_active");
  for (const tagName of ["INPUT", "textarea", "Select"]) {
    assert.equal(posScannerWedgeBlockReason({ operationActive: false, wedgeSessionActive: false, target: { tagName } }), "protected_target");
  }
  assert.equal(posScannerWedgeBlockReason({ operationActive: false, wedgeSessionActive: false, target: { tagName: "DIV", contentEditable: true } }), "protected_target");
  assert.equal(posScannerWedgeBlockReason({ operationActive: false, wedgeSessionActive: false, target: { tagName: "DIV", purpose: "financial" } }), "protected_target");
  assert.equal(posScannerWedgeBlockReason({ operationActive: false, wedgeSessionActive: false, target: { tagName: "INPUT", purpose: "credential" } }), "protected_target");
  assert.equal(posScannerWedgeBlockReason({ operationActive: false, wedgeSessionActive: false, target: { tagName: "INPUT", purpose: "scanner" } }), null);
  assert.equal(posScannerWedgeBlockReason(body), null);
});

test("prefixo e sufixo configurados preservam captureId em FIFO até o settle", () => {
  const core = new PosScannerCaptureCore(configuration, "hid");
  assert.equal(core.feed({ key: "7", atMs: 0, context: body }).disposition, "ignored");
  assert.equal(scan(core, "ABC", 10).disposition, "queued");
  assert.equal(scan(core, "XYZ", 100).disposition, "queued");
  assert.deepEqual(core.pendingSnapshot().map(item => item.captureId), ["hid:1", "hid:2"]);

  const first = core.take(), second = core.take();
  assert.deepEqual(first, { captureId: "hid:1", code: "ABC", enqueuedAtMs: 30 });
  assert.deepEqual(second, { captureId: "hid:2", code: "XYZ", enqueuedAtMs: 120 });
  assert.equal(core.take(), null);
  assert.deepEqual(core.settle(first!.captureId, { accepted: true }, 200), { captureId: "hid:1", status: "accepted", reasonCode: "resolved", atMs: 200 });
  assert.deepEqual(core.settle(second!.captureId, { accepted: false, reasonCode: "not_found" }, 201), { captureId: "hid:2", status: "rejected", reasonCode: "not_found", atMs: 201 });
});

test("duas leituras legítimas do mesmo código nunca são deduplicadas por conteúdo ou proximidade", () => {
  const core = new PosScannerCaptureCore(configuration, "same");
  scan(core, "789", 0);
  scan(core, "789", 30);
  assert.deepEqual([core.take(), core.take()].map(item => [item?.captureId, item?.code]), [["same:1", "789"], ["same:2", "789"]]);
});

test("somente Enter repetido e deliveryId físico repetido viram duplicate na janela", () => {
  const core = new PosScannerCaptureCore(configuration, "dedupe");
  scan(core, "ABC", 0);
  const repeatedEnter = core.feed({ key: "Enter", atMs: 25, context: body });
  assert.equal(repeatedEnter.disposition, "duplicate");
  assert.deepEqual(repeatedEnter.immediateResults[0], { captureId: "dedupe:2", status: "duplicate", reasonCode: "duplicate_terminator", atMs: 25 });

  assert.equal(core.offerCode({ captureId: "serial:1", deliveryId: "frame:9", code: "ABC", atMs: 100, context: body }).queued, true);
  const duplicate = core.offerCode({ captureId: "serial:2", deliveryId: "frame:9", code: "ABC", atMs: 120, context: body });
  assert.deepEqual(duplicate.result, { captureId: "serial:2", status: "duplicate", reasonCode: "duplicate_delivery", atMs: 120 });
  assert.equal(core.offerCode({ captureId: "serial:3", deliveryId: "frame:10", code: "ABC", atMs: 121, context: body }).queued, true);
});

test("operação ou alvo protegido interrompe captura sem reter o código parcial", () => {
  const core = new PosScannerCaptureCore(configuration, "blocked");
  core.feed({ key: "F9", atMs: 0, context: body });
  core.feed({ key: "A", atMs: 5, context: body });
  const blocked = core.feed({ key: "B", atMs: 10, context: { operationActive: true, wedgeSessionActive: false, target: { tagName: "BODY" } } });
  assert.equal(blocked.consumed, true);
  assert.deepEqual(blocked.immediateResults, []);
  const blockedEnd = core.feed({ key: "Enter", atMs: 15, context: body });
  assert.deepEqual(blockedEnd.immediateResults, [{ captureId: "blocked:1", status: "rejected", reasonCode: "operation_active", atMs: 15 }]);
  assert.equal(core.queueDepth, 0);
  assert.equal(JSON.stringify(core.resultsSnapshot()).includes("A"), false);

  const protectedInput = core.feed({ key: "7", atMs: 20, context: { operationActive: false, wedgeSessionActive: false, target: { tagName: "INPUT", purpose: "financial" } } });
  assert.equal(protectedInput.consumed, false);
  assert.equal(protectedInput.sourceIdentified, false);
  assert.equal(protectedInput.blockReason, "protected_target");
});

test("prefixo reconhecido consome o frame inteiro sobre campo financeiro sem deixar payload escapar", () => {
  const core = new PosScannerCaptureCore(configuration, "financial");
  const financial: PosScannerCaptureContext = {
    operationActive: false,
    wedgeSessionActive: false,
    target: { tagName: "INPUT", purpose: "financial" },
  };
  const outcomes = ["F9", "A", "B", "C", "Enter"].map((key, index) => core.feed({ key, atMs: index * 5, context: financial }));
  assert.equal(outcomes.every(outcome => outcome.consumed && outcome.sourceIdentified), true);
  assert.equal(core.queueDepth, 0);
  assert.deepEqual(outcomes.at(-1)?.immediateResults, [
    { captureId: "financial:1", status: "rejected", reasonCode: "protected_target", atMs: 20 },
  ]);
  assert.equal(JSON.stringify(core.resultsSnapshot()).includes("ABC"), false);
});

test("sessão wedge explícita consome cada tecla bloqueada mesmo sem prefixo", () => {
  const noPrefix = createPosScannerCaptureConfiguration({ ...configuration, prefixKeys: [] });
  const core = new PosScannerCaptureCore(noPrefix, "session");
  const credential: PosScannerCaptureContext = {
    operationActive: false,
    wedgeSessionActive: true,
    target: { tagName: "INPUT", purpose: "credential" },
  };
  const outcomes = ["A", "B", "C", "Enter"].map((key, index) => core.feed({ key, atMs: index * 5, context: credential }));
  assert.equal(outcomes.every(outcome => outcome.consumed && outcome.sourceIdentified), true);
  assert.equal(core.queueDepth, 0);
  assert.equal(outcomes.at(-1)?.immediateResults[0]?.reasonCode, "protected_target");
});

test("campo híbrido manual/scanner com prefixo não captura digitação humana antes do prefixo", () => {
  const core = new PosScannerCaptureCore(configuration, "hybrid");
  const hybrid: PosScannerCaptureContext = {
    operationActive: false,
    wedgeSessionActive: false,
    target: { tagName: "INPUT", purpose: "scanner" },
  };
  const humanKey = core.feed({ key: "A", atMs: 0, context: hybrid });
  assert.deepEqual({ disposition: humanKey.disposition, consumed: humanKey.consumed, sourceIdentified: humanKey.sourceIdentified }, {
    disposition: "ignored",
    consumed: false,
    sourceIdentified: false,
  });
  const outcomes = ["F9", "A", "B", "C", "Enter"].map((key, index) => core.feed({ key, atMs: 10 + index * 5, context: hybrid }));
  assert.equal(outcomes.every(outcome => outcome.consumed && outcome.sourceIdentified), true);
  assert.deepEqual(core.take(), { captureId: "hybrid:1", code: "ABC", enqueuedAtMs: 30 });
});

test("HID genérico sem prefixo não alega proteção e exige superfície ou sessão identificada", () => {
  const noPrefix = createPosScannerCaptureConfiguration({ ...configuration, prefixKeys: [] });
  const financial: PosScannerCaptureContext = {
    operationActive: false,
    wedgeSessionActive: false,
    target: { tagName: "INPUT", purpose: "financial" },
  };
  assert.equal(posScannerWedgeProtectionAvailable(noPrefix, financial), false);
  assert.throws(() => assertPosScannerWedgeProtectionAvailable(noPrefix, financial), /prefixo.*sessão identificada.*campo dedicado\/read-only.*agente/i);
  const outcome = new PosScannerCaptureCore(noPrefix).feed({ key: "7", atMs: 0, context: financial });
  assert.deepEqual({ disposition: outcome.disposition, consumed: outcome.consumed, sourceIdentified: outcome.sourceIdentified }, {
    disposition: "unidentified",
    consumed: false,
    sourceIdentified: false,
  });

  assert.equal(posScannerWedgeProtectionAvailable(noPrefix, { ...financial, wedgeSessionActive: true }), true);
  assert.equal(posScannerWedgeProtectionAvailable(noPrefix, {
    operationActive: false,
    wedgeSessionActive: false,
    target: { tagName: "INPUT", purpose: "scanner" },
  }), true);
});

test("timeout, tamanho máximo e fila cheia geram reasonCode seguro e limitado", () => {
  const core = new PosScannerCaptureCore(createPosScannerCaptureConfiguration({ ...configuration, queueLimit: 1, resultLimit: 2, maximumLength: 3 }), "limits");
  core.feed({ key: "F9", atMs: 0, context: body });
  core.feed({ key: "A", atMs: 5, context: body });
  const timeout = core.feed({ key: "F9", atMs: 100, context: body });
  assert.equal(timeout.immediateResults[0].reasonCode, "capture_timeout");
  core.feed({ key: "1", atMs: 105, context: body });
  core.feed({ key: "2", atMs: 110, context: body });
  core.feed({ key: "3", atMs: 115, context: body });
  assert.equal(core.feed({ key: "4", atMs: 120, context: body }).immediateResults[0].reasonCode, "capture_too_long");
  core.feed({ key: "Enter", atMs: 125, context: body });

  scan(core, "ABC", 200);
  const full = scan(core, "XYZ", 240);
  assert.equal(full.immediateResults[0].reasonCode, "queue_full");
  assert.equal(core.resultsSnapshot().length, 2);
  assert.deepEqual(core.resultsSnapshot().map(result => result.reasonCode), ["capture_too_long", "queue_full"]);
});

test("drain sequencial preserva IDs e reduz exceção aberta a processor_error", async () => {
  const core = new PosScannerCaptureCore(configuration, "drain");
  core.offerCode({ code: "GOOD", atMs: 0, context: body });
  core.offerCode({ code: "FAIL", atMs: 1, context: body });
  let active = 0, maximumActive = 0;
  const results = await core.drain(async capture => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    active -= 1;
    if (capture.code === "FAIL") throw new Error("provider payload must not escape");
    return { accepted: true };
  }, capture => capture.enqueuedAtMs + 100);
  assert.equal(maximumActive, 1);
  assert.deepEqual(results, [
    { captureId: "drain:1", status: "accepted", reasonCode: "resolved", atMs: 100 },
    { captureId: "drain:2", status: "rejected", reasonCode: "processor_error", atMs: 101 },
  ]);
  assert.equal(JSON.stringify(results).includes("provider"), false);
});

test("histórico público nunca expõe código ou QR cru", () => {
  const core = new PosScannerCaptureCore(createPosScannerCaptureConfiguration({ ...configuration, maximumLength: 64 }), "redacted");
  const rawQr = "NALVEN-POS.v1.kind.secret.signature";
  core.offerCode({ code: rawQr, atMs: 0, context: body });
  const capture = core.take()!;
  core.settle(capture.captureId, { accepted: false, reasonCode: "invalid_code" }, 1);
  const serialized = JSON.stringify(core.resultsSnapshot());
  assert.equal(serialized.includes(rawQr), false);
  assert.deepEqual(Object.keys(core.resultsSnapshot()[0]).sort(), ["atMs", "captureId", "reasonCode", "status"]);
  assert.deepEqual(Object.keys(core.pendingSnapshot()), []);
});

test("configuração rejeita limites e sequências inseguras", () => {
  assert.throws(() => createPosScannerCaptureConfiguration({ suffixKeys: [] }), /sufixo/);
  assert.throws(() => createPosScannerCaptureConfiguration({ minimumLength: 10, maximumLength: 3 }), /mínimo/);
  assert.throws(() => createPosScannerCaptureConfiguration({ interKeyTimeoutMs: 0 }), /timeout/);
  assert.throws(() => new PosScannerCaptureCore(configuration, "QR cru não serve como namespace"), /Namespace/);
});
