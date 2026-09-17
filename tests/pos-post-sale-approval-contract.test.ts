import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("pedido pós-venda bloqueia a venda e persiste somente snapshot calculado no servidor", () => {
  const route = source("app/api/erp/pdv/approvals/route.ts");
  const requestBlock = route.slice(
    route.indexOf("async function requestApproval"),
    route.indexOf("async function authoritativePosApprovalRequest"),
  );
  assert.ok(
    requestBlock.indexOf("authoritativePosApprovalRequest") <
      requestBlock.indexOf("tx.posApproval.create"),
  );
  const helper = route.slice(
    route.indexOf("async function authoritativePosApprovalRequest"),
    route.indexOf("function assertPosApprovalRequestReplay"),
  );
  const lock = helper.indexOf(
    'SELECT "id" FROM "sales" WHERE "id" = ${saleId} FOR UPDATE',
  );
  const load = helper.indexOf("const sale = await tx.sale.findFirst", lock);
  const build = helper.indexOf("buildPosCancelApprovalContext", load);
  const bind = helper.indexOf(
    "bindAuthoritativePosApprovalContext(request, scope, authoritativeContext",
    build,
  );
  assert.ok(lock >= 0 && load > lock && build > load && bind > build);
  assert.match(
    route,
    /payments:\s*\{[\s\S]*?where: \{ type: "payment" \}[\s\S]*?refunds:[\s\S]*?orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/,
  );
  assert.match(
    route,
    /assertPosApprovalRequestReplay\(winner, normalized, scope\)/,
  );
});

test("cancelamento e devolução recalculam snapshot sob lock antes de consumir", () => {
  const route = source("app/api/erp/pdv/route.ts");
  const cancel = route.slice(
    route.indexOf("async function cancelSale"),
    route.indexOf("async function createReturn"),
  );
  const returned = route.slice(
    route.indexOf("async function createReturn"),
    route.indexOf("async function restorePosKitSaleItemComponents"),
  );
  for (const [body, builder, gate] of [
    [
      cancel,
      "buildPosCancelApprovalContext",
      "Cancelamento eletrônico exige confirmação server-side",
    ],
    [
      returned,
      "buildPosReturnApprovalContext",
      "Devolução eletrônica exige um conector server-side homologado",
    ],
  ] as const) {
    const lock = body.indexOf(
      'SELECT "id" FROM "sales" WHERE "id" = ${saleId} FOR UPDATE',
    );
    const build = body.indexOf(builder);
    const consume = body.indexOf("consumeApprovedPosAction", build);
    const electronicGate = body.indexOf(gate, consume);
    assert.ok(
      lock >= 0 && build > lock && consume > build && electronicGate > consume,
      `${builder} deve ser recalculado no lock e preservar o gate eletrônico`,
    );
  }
  assert.match(
    route,
    /assertPosPostSaleApprovalContext\(\s*approval\.context,\s*expectedContext/,
  );
  assert.match(
    route,
    /decisionData\?\.authenticationMode !== "password_step_up"/,
  );
  assert.match(
    route,
    /const liveAccess = await liveRegisterSaleAccess[\s\S]*?requiresApproval = !liveAccess\.canCancel/,
  );
  assert.match(
    route,
    /const liveAccess = await liveRegisterSaleAccess[\s\S]*?requiresApproval = !liveAccess\.canRefund/,
  );
});

test("telas solicitam aprovação com o payload exato e supervisor vê resumo autoritativo", () => {
  const workspace = source("components/erp/pdv-workspace.tsx");
  const dialog = source("components/erp/pdv-approval-dialog.tsx");
  assert.match(
    workspace,
    /approvalAction: "sale\.cancel"[\s\S]*?context: \{ sessionId \}/,
  );
  assert.match(
    workspace,
    /approvalAction: "return\.create"[\s\S]*?items: selected\.map/,
  );
  assert.match(
    workspace,
    /reasonCode,[\s\S]*?description,[\s\S]*?exchangeRequested/,
  );
  assert.match(
    dialog,
    /approval\.action === "sale\.cancel"[\s\S]*?Total a restituir/,
  );
  assert.match(dialog, /approval\.action === "return\.create"[\s\S]*?Destinos/);
});
