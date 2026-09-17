import assert from "node:assert/strict";
import test from "node:test";
import { drainPosScanQueue, PosScanQueue } from "../lib/erp/pos-scan-queue";

test("fila HID processa ao menos 20 leituras em FIFO, uma por vez", async () => {
  const queue = new PosScanQueue(32);
  const expected = Array.from({ length: 20 }, (_, index) => `7890000000${String(index).padStart(3, "0")}`);

  expected.forEach((code, index) => {
    const result = queue.enqueue({ captureId: `hid:${index}`, code });
    assert.equal(result.accepted, true);
    assert.equal(result.depth, index + 1);
  });

  const processed: string[] = [];
  let active = 0;
  let maximumActive = 0;
  await drainPosScanQueue(queue, async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    processed.push(item.code);
    active -= 1;
  });

  assert.deepEqual(processed, expected);
  assert.equal(maximumActive, 1);
  assert.equal(queue.depth, 0);
});

test("o mesmo Enter não duplica a captura, mas uma nova leitura do mesmo código é válida", () => {
  const queue = new PosScanQueue(4);

  assert.equal(queue.enqueue({ captureId: "input:7", code: "7891234567890" }).reason, "accepted");
  assert.equal(queue.enqueue({ captureId: "input:7", code: "7891234567890" }).reason, "duplicate");
  assert.equal(queue.enqueue({ captureId: "input:8", code: "7891234567890" }).reason, "accepted");
  assert.equal(queue.depth, 2);
});

test("a fila recusa excedente com limite e profundidade explícitos", () => {
  const queue = new PosScanQueue(2);

  queue.enqueue({ captureId: "hid:1", code: "A01" });
  queue.enqueue({ captureId: "hid:2", code: "A02" });
  const overflow = queue.enqueue({ captureId: "hid:3", code: "A03" });

  assert.deepEqual(overflow, { accepted: false, reason: "full", depth: 2 });
  assert.equal(queue.limit, 2);
  assert.equal(queue.depth, 2);
});

test("leituras recebidas durante o processamento entram no fim da fila", async () => {
  const queue = new PosScanQueue(4);
  queue.enqueue({ captureId: "hid:1", code: "A01" });
  queue.enqueue({ captureId: "hid:2", code: "A02" });
  const processed: string[] = [];

  await drainPosScanQueue(queue, async (item) => {
    processed.push(item.code);
    if (item.code === "A01") queue.enqueue({ captureId: "hid:3", code: "A03" });
  });

  assert.deepEqual(processed, ["A01", "A02", "A03"]);
});
