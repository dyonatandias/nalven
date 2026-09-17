import assert from "node:assert/strict";
import test from "node:test";
import { parseStandardPosScaleFrame, posScaleQuantity, renderPosDrawerPulse, renderPosEscPosReceipt, validatePosCustomerDisplayPayload, validatePosScaleReading } from "../lib/erp/pos-peripherals";

const receipt = () => ({
  saleNumber: "PDV-000001",
  merchantName: "NALVEN COMERCIO",
  issuedAt: new Date("2026-08-29T12:30:00.000Z"),
  items: [{ description: "Cafe especial torrado", quantity: 1.5, unit: "KG", unitPriceCents: 2_000, totalCents: 3_000 }],
  subtotalCents: 3_000,
  discountCents: 100,
  surchargeCents: 0,
  totalCents: 2_900,
  payments: [{ label: "Dinheiro", amountCents: 2_900 }],
  changeCents: 0,
  footer: "Obrigado pela preferencia",
  qrText: "NALVEN-POS.v1.receipt.key.payload.signature",
});

test("renderer ESC/POS fecha valores, é determinístico e inclui QR/corte sem abrir gaveta", () => {
  const profile = { columns: 32 as const, codePage: "ascii" as const, cut: "partial" as const, qr: true };
  const first = renderPosEscPosReceipt(receipt(), profile);
  const second = renderPosEscPosReceipt(receipt(), profile);
  assert.deepEqual(first, second);
  assert.deepEqual([...first.slice(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...first.slice(-3)], [0x1d, 0x56, 0x01]);
  assert.equal(Buffer.from(first).includes(Buffer.from([0x1b, 0x70])), false, "impressão jamais pulsa a gaveta implicitamente");
  assert.equal(Buffer.from(first).includes(Buffer.from([0x1d, 0x28, 0x6b])), true);
});

test("renderer recusa equação divergente, QR sem capability e perfil arbitrário", () => {
  assert.throws(() => renderPosEscPosReceipt({ ...receipt(), totalCents: 2_899 }, { columns: 32, codePage: "ascii", cut: "none", qr: true }), /não fecha/);
  assert.throws(() => renderPosEscPosReceipt(receipt(), { columns: 32, codePage: "ascii", cut: "none", qr: false }), /não declara suporte/);
  assert.throws(() => renderPosEscPosReceipt(receipt(), { columns: 40 as 32, codePage: "ascii", cut: "none", qr: true }), /Perfil/);
});

test("gaveta é comando ESC/POS separado com pulso limitado", () => {
  assert.deepEqual([...renderPosDrawerPulse({ pin: 2, onMs: 100, offMs: 200 })], [0x1b, 0x70, 0, 50, 100]);
  assert.deepEqual([...renderPosDrawerPulse({ pin: 5, onMs: 100, offMs: 200 })], [0x1b, 0x70, 1, 50, 100]);
  assert.throws(() => renderPosDrawerPulse({ pin: 2, onMs: 1, offMs: 200 }), /Pulso/);
});

test("balança normaliza gramas, tara, estabilidade, idade, precisão e unidade do produto", () => {
  const now = new Date("2026-08-29T12:30:00.000Z");
  const reading = validatePosScaleReading({ deviceId: "scale-1", weight: 1.25, tare: 0.05, unit: "kg", stable: true, capturedAt: new Date(now.valueOf() - 500) }, { maximumAgeMs: 2_000, minimumGrams: 10, maximumGrams: 5_000, incrementGrams: 10, requireStable: true }, now);
  assert.deepEqual({ gross: reading.grossWeightGrams, tare: reading.tareGrams, net: reading.netWeightGrams }, { gross: 1_250, tare: 50, net: 1_200 });
  assert.equal(posScaleQuantity(reading, "KG"), 1.2);
  assert.equal(posScaleQuantity(reading, "G"), 1_200);
  assert.throws(() => posScaleQuantity(reading, "UN"), /KG ou G/);
  assert.throws(() => validatePosScaleReading({ deviceId: "scale-1", weight: 1.25, unit: "kg", stable: false, capturedAt: now }, undefined, now), /estabilização/);
  assert.throws(() => validatePosScaleReading({ deviceId: "scale-1", weight: 1.25, unit: "kg", stable: true, capturedAt: new Date(now.valueOf() - 10_000) }, undefined, now), /expirou/);
  assert.throws(() => validatePosScaleReading({ deviceId: "scale-1", weight: 1.251, unit: "kg", stable: true, capturedAt: now }, { maximumAgeMs: 2_000, minimumGrams: 1, maximumGrams: 5_000, incrementGrams: 10, requireStable: true }, now), /precisão configurada/);
});

test("perfil serial padrão distingue estável/instável e limita o quadro", () => {
  const now = new Date("2026-08-29T12:30:00.000Z");
  const reading = parseStandardPosScaleFrame("ST,GS,+001.234kg\r\n", "scale-serial-1", now);
  assert.equal(reading.netWeightGrams, 1_234);
  assert.equal(reading.stable, true);
  assert.throws(() => parseStandardPosScaleFrame("US,GS,+001.234kg", "scale-serial-1", now), /estabilização/);
  assert.throws(() => parseStandardPosScaleFrame("ST;rm -rf /", "scale-serial-1", now), /não reconhecido/);
});

test("display aceita somente DTO público e QR Pix apenas no pagamento", () => {
  const payload = validatePosCustomerDisplayPayload({ state: "payment", description: "Cafe", quantity: 1, unitPriceCents: 1_000, discountCents: 0, totalCents: 1_000, pixQr: "000201010212" });
  assert.equal(Object.isFrozen(payload), true);
  assert.throws(() => validatePosCustomerDisplayPayload({ ...payload, state: "completed", pixQr: "000201" }), /durante o pagamento/);
  assert.throws(() => validatePosCustomerDisplayPayload({ ...payload, operatorEmail: "secret@example.test" } as never), /não público/);
});
