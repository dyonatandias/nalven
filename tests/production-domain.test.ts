import assert from "node:assert/strict";
import test from "node:test";
import {
  assertScheduleWithinShifts,
  materialNeeds,
  quantity,
  reportCosts,
  requestHash,
  shiftsInput,
  snapshotInput,
  weightedAverageCost,
} from "../lib/erp/production-domain";

const raw = {
  name: "Kit",
  code: "KIT",
  outputProductId: 2,
  yieldQuantity: 3,
  items: [{ productId: 1, quantity: 1, wastePercent: 10 }],
  laborHourlyCents: 6000,
  machineHourlyCents: 3000,
  energyBatchCents: 90,
  overheadBatchCents: 60,
};
test("material fracionado arredonda para cima na precisão do estoque e não sub-reserva", () => {
  const needs = materialNeeds(snapshotInput(raw), quantity(1));
  assert.equal(needs[0].requiredMicros, BigInt(366667));
  assert.throws(() => quantity(0.0000001), /seis casas/);
  assert.throws(() => quantity(true), /inválida/);
});
test("custo inclui consumo, mão de obra, máquina, energia e indiretos", () => {
  assert.deepEqual(
    reportCosts(snapshotInput(raw), {
      materialCostCents: 500,
      laborMinutes: 30,
      machineMinutes: 12,
      processedMicros: quantity(6),
    }),
    {
      materialCostCents: 500,
      laborCostCents: 3000,
      machineCostCents: 600,
      energyCostCents: 180,
      overheadCostCents: 120,
      totalCostCents: 4400,
    },
  );
  assert.equal(weightedAverageCost(10, 8, quantity(2), 1200), 7.67);
});
test("composição diferencia variações, rejeita ciclos diretos e checklist incompleto", () => {
  const snapshot = snapshotInput({
    ...raw,
    items: [
      { productId: 1, variationId: 10, quantity: 1 },
      { productId: 1, variationId: 11, quantity: 1 },
    ],
  });
  assert.equal(snapshot.items.length, 2);
  assert.throws(
    () => snapshotInput({ ...raw, items: [{ productId: 2, quantity: 1 }] }),
    /acabado/,
  );
  assert.throws(() => snapshotInput({ ...raw, checklist: [] }), /verificações/);
});
test("hash vincula corpo inteiro e independe da ordem das propriedades", () => {
  assert.equal(
    requestHash({ a: 1, nested: { b: 2 } }),
    requestHash({ nested: { b: 2 }, a: 1 }),
  );
  assert.notEqual(requestHash({ quantity: 1 }), requestHash({ quantity: 2 }));
  assert.throws(() => requestHash({ bad: Infinity }), /inválido/);
});
test("turnos rejeitam sobreposição e agenda aplica o fuso do recurso", () => {
  const shifts = shiftsInput([
    { day: 1, start: "08:00", end: "12:00" },
    { day: 1, start: "13:00", end: "18:00" },
  ]);
  assertScheduleWithinShifts(
    new Date("2026-09-07T11:00:00Z"),
    new Date("2026-09-07T12:00:00Z"),
    shifts,
    "America/Sao_Paulo",
  );
  assert.throws(
    () =>
      assertScheduleWithinShifts(
        new Date("2026-09-07T14:30:00Z"),
        new Date("2026-09-07T16:00:00Z"),
        shifts,
        "America/Sao_Paulo",
      ),
    /fora dos turnos/,
  );
  assert.throws(
    () =>
      shiftsInput([
        { day: 1, start: "08:00", end: "12:00" },
        { day: 1, start: "11:00", end: "18:00" },
      ]),
    /sobrepostos/,
  );
});
