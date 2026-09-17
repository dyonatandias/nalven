import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("abertura, caixa, venda e devolução exigem prova criptográfica do terminal", () => {
  const route = source("app/api/erp/pdv/route.ts");
  for (const action of [
    "session.open",
    "cash.event",
    "session.close",
    "sale.commit",
    "sale.cancel",
    "return.create",
  ]) {
    assert.match(
      route,
      new RegExp(
        `FINANCIAL_TERMINAL_ACTIONS[\\s\\S]*${action.replace(".", "\\.")}`,
      ),
    );
  }
  assert.match(
    route,
    /readPosOperationalTerminalCredential\(request\.headers\)/,
  );
  assert.match(route, /assertLiveTerminalProof\(tx, context, terminalProof/);
  assert.match(
    route,
    /posTerminalBoundOpenRequestHash\(\{\s*registerId:\s*register\.id,\s*openingAmountCents,\s*terminalId:\s*terminalProof\.terminalId,?\s*\}\)/,
  );
  assert.match(
    route,
    /assertPosSessionTerminalBinding\(session, terminalProof\)/,
  );
  assert.doesNotMatch(
    route,
    /certificateFingerprint.*(?:authenticate|credential|proof)/i,
  );
});

test("intenção eletrônica, referência manual e ciclo do turno não contornam o vínculo", () => {
  const payment = source("app/api/erp/pdv/payment-intents/route.ts");
  const persistence = source("lib/erp/pos-payment-persistence.ts");
  const manual = source("app/api/erp/pdv/manual-payments/route.ts");
  const lifecycle = source("app/api/erp/pdv/session-lifecycle/route.ts");
  for (const route of [payment, manual, lifecycle]) {
    assert.match(
      route,
      /readPosOperationalTerminalCredential\(request\.headers\)/,
    );
    assert.match(route, /assertPosSessionTerminalBinding/);
    assert.match(route, /PosTerminalBoundaryError/);
  }
  assert.match(
    payment,
    /createPosPaymentIntent\(db, context, input!, terminalProof\)/,
  );
  assert.match(persistence, /terminalId: terminalProof\.terminalId/);
  assert.match(
    manual,
    /assertPosOperationalTerminalProof\(liveTerminal, terminalProof/,
  );
});

test("consumo de intent capturado exige o mesmo terminal da venda", () => {
  const persistence = source("lib/erp/pos-payment-persistence.ts");
  assert.match(persistence, /terminalId: string;/);
  assert.match(persistence, /intent\.terminalId !== input\.terminalId/);
});
