import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function source(path: string) {
  return readFileSync(join(projectRoot, path), "utf8");
}

function between(value: string, start: string, end: string) {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  assert.ok(from >= 0, `início ausente: ${start}`);
  assert.ok(to > from, `fim ausente: ${end}`);
  return value.slice(from, to);
}

test("todas as mutações web do PDV combinam anti-CSRF, JSON, pdv.write, limite e licença", () => {
  for (const path of [
    "app/api/erp/pdv/route.ts",
    "app/api/erp/pdv/admin/route.ts",
    "app/api/erp/pdv/customers/route.ts",
    "app/api/erp/pdv/inventory/route.ts",
    "app/api/erp/pdv/print-jobs/route.ts",
    "app/api/erp/pdv/promotions/route.ts",
    "app/api/erp/pdv/product-codes/route.ts",
    "app/api/erp/pdv/held-sales/transfer/route.ts",
    "app/api/erp/pdv/value-accounts/route.ts",
    "app/api/erp/pdv/approvals/route.ts",
    "app/api/erp/pdv/terminals/route.ts",
  ]) {
    const route = source(path);
    const postStart = route.indexOf("export async function POST");
    const helperStarts = [
      route.indexOf("\nasync function ", postStart + 1),
      route.indexOf("\nfunction ", postStart + 1),
    ].filter((index) => index > postStart);
    assert.ok(
      postStart >= 0 && helperStarts.length,
      `${path} deve expor POST e helpers isolados`,
    );
    const post = route.slice(postStart, Math.min(...helperStarts));
    assert.match(
      post,
      /assertSameOrigin\(request\)/,
      `${path} deve validar a origem`,
    );
    assert.match(
      post,
      /assertPosMutationRequest\(request\)/,
      `${path} deve exigir JSON e Fetch Metadata seguro`,
    );
    assert.match(
      route,
      /assertTenantPermission\([\s\S]*?,\s*["']pdv\.write["'],?\s*\)/,
      `${path} deve exigir pdv.write`,
    );
    assert.match(
      route,
      /enforcePosRateLimit\(/,
      `${path} deve limitar taxa por ator/ação`,
    );
    assert.match(
      route,
      /assertTenantWriteAccess\(/,
      `${path} deve respeitar licença de escrita`,
    );
  }
});

test("administração e credenciais exigem papel privilegiado além de pdv.write", () => {
  for (const path of [
    "app/api/erp/pdv/admin/route.ts",
    "app/api/erp/pdv/inventory/route.ts",
    "app/api/erp/pdv/promotions/route.ts",
    "app/api/erp/pdv/product-codes/route.ts",
    "app/api/erp/pdv/terminals/route.ts",
    "app/api/erp/pdv/value-accounts/route.ts",
  ]) {
    const route = source(path);
    assert.match(
      route,
      /assertTenantPermission\([\s\S]*?,\s*["']pdv\.write["'],?\s*\)/,
    );
    assert.match(
      route,
      /\["owner",\s*"admin"\]\.includes\([^)]*membership\.role\)/,
    );
  }
  const operational = source("app/api/erp/pdv/route.ts");
  assert.match(
    operational,
    /const privileged = \["owner", "admin"\]\.includes\(permission\.membership\.role\)/,
  );
  assert.match(
    operational,
    /if \(!context\.privileged\)\s*throw new PosDomainError\(\s*"Somente administradores podem alterar acessos de caixa\.",?\s*\)/,
  );
});

test("operador de aprovação permanece vinculado à filial e a um caixa vigente", () => {
  const approvals = source("app/api/erp/pdv/approvals/route.ts");
  const context = between(
    approvals,
    "async function approvalContext",
    "\nasync function requestApproval",
  );
  assert.match(
    context,
    /branchId_userProfileId:\s*\{[\s\S]*?branchId:\s*branch\.id,\s*userProfileId:\s*profile\.id\s*\}/,
  );
  assert.match(context, /branchAccess\?\.canSell/);
  assert.match(context, /posRegisterAccess\.findFirst/);
  assert.match(
    context,
    /register:\s*\{[\s\S]*?branchId:\s*branch\.id,\s*status:\s*"active"\s*\}/,
  );
  assert.match(context, /validFrom:[\s\S]*?validUntil:/);
  assert.match(
    approvals,
    /context\.privileged \? \{\} : \{ requesterId: permission\.user\.id \}/,
  );
  assert.match(approvals, /id:\s*input\.approvalId,\s*branchId/);
});

test("step-up do supervisor reautentica outra identidade sem persistir a credencial", () => {
  const approvals = source("app/api/erp/pdv/approvals/route.ts");
  const domain = source("lib/erp/pos-approval-step-up.ts");
  const dialog = source("components/erp/pdv-approval-dialog.tsx");
  const http = source("lib/erp/pos-http.ts");
  assert.match(approvals, /normalizePosApprovalStepUpInput\(body\)/);
  assert.match(
    approvals,
    /verifyPassword\(input\.password, supervisor\?\.passwordHash \|\| STEP_UP_DUMMY_PASSWORD_HASH\)/,
  );
  assert.match(
    approvals,
    /memberships:\s*\{ where:\s*\{ organizationId, status: "active" \}/,
  );
  assert.match(approvals, /\["owner", "admin"\]\.includes\(membership\.role\)/);
  assert.match(approvals, /current\.requesterId === approver\.id/);
  assert.match(
    approvals,
    /authenticationMode:\s*"session" \| "password_step_up"/,
  );
  assert.match(
    approvals,
    /MANDATORY_STEP_UP_ACTIONS\.has\(current\.action\) && authenticationMode !== "password_step_up"/,
  );
  assert.match(approvals, /invalid_supervisor_credential/);
  assert.doesNotMatch(approvals, /afterData:[^\n]*(?:password|email)/i);
  assert.match(domain, /ALLOWED_KEYS/);
  assert.match(
    domain,
    /TextEncoder\(\)\.encode\(value\.password\)\.byteLength > 512/,
  );
  assert.match(domain, /createHash\("sha256"\)/);
  assert.match(
    http,
    /"approval\.step-up\.decide": \{ limit: 6, seconds: 300 \}/,
  );
  assert.match(
    dialog,
    /As credenciais são verificadas no servidor e não são armazenadas/,
  );
  assert.match(
    dialog,
    /requiresStepUp = \["payment\.manual_reference", "sale\.cancel", "return\.create"\]\.includes\(approval\.action\)/,
  );
  assert.doesNotMatch(dialog, /localStorage|sessionStorage/);
});

test("isolamento tenant deriva o banco da organização autenticada ou vincula o token ao path", () => {
  for (const path of [
    "app/api/erp/pdv/route.ts",
    "app/api/erp/pdv/admin/route.ts",
    "app/api/erp/pdv/customers/route.ts",
    "app/api/erp/pdv/inventory/route.ts",
    "app/api/erp/pdv/print-jobs/route.ts",
    "app/api/erp/pdv/promotions/route.ts",
    "app/api/erp/pdv/product-codes/route.ts",
    "app/api/erp/pdv/held-sales/transfer/route.ts",
    "app/api/erp/pdv/value-accounts/route.ts",
    "app/api/erp/pdv/value-accounts/resolve/route.ts",
    "app/api/erp/pdv/approvals/route.ts",
    "app/api/erp/pdv/terminals/route.ts",
  ]) {
    const route = source(path);
    assert.match(
      route,
      /currentOrganization\(\)/,
      `${path} deve resolver o tenant autenticado`,
    );
    assert.match(
      route,
      /tenantDb\([^)]*organization(?:\.id|Id)\)/,
      `${path} deve abrir somente o banco do tenant atual`,
    );
  }
  const agent = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/route.ts",
  );
  const pairing = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/pair/route.ts",
  );
  assert.match(
    agent,
    /verifyAgentToken\(terminal\.tokenHash, organizationId, terminalId, token\)/,
  );
  assert.match(agent, /terminal\.register\.branch\.status !== "active"/);
  assert.match(pairing, /hashPairingCode\(organizationId, terminalId, code\)/);
  assert.match(pairing, /terminalId, codeHash/);
});

test("replays persistentes são vinculados a ator, ação, hash e contexto operacional", () => {
  const operational = source("app/api/erp/pdv/route.ts");
  for (const helper of [
    "assertSessionReplayContext",
    "assertHeldReplayContext",
  ]) {
    const block = between(
      operational,
      `function ${helper}`,
      helper === "assertSessionReplayContext"
        ? "\nfunction assertHeldReplayContext"
        : "\nasync function consumeApprovedPosAction",
    );
    assert.match(block, /operatorProfileId !== context\.profile\.id/);
    assert.match(
      block,
      /context\.registers\.some\(\(register\) => register\.id ===/,
    );
    assert.match(block, /storedHash !== requestHash/);
  }
  for (const path of [
    "app/api/erp/pdv/admin/route.ts",
    "app/api/erp/pdv/inventory/route.ts",
    "app/api/erp/pdv/promotions/route.ts",
    "app/api/erp/pdv/product-codes/route.ts",
    "app/api/erp/pdv/terminals/route.ts",
    "app/api/erp/pdv/value-accounts/route.ts",
  ]) {
    const route = source(path);
    assert.match(
      route,
      /record\.actorId !== actorId \|\| record\.action !== [^|]+ \|\| record\.requestHash !== requestHash/,
    );
    assert.match(route, /isolationLevel:\s*"Serializable"/);
    assert.match(route, /idempotency-replayed/);
  }
  const approvals = source("app/api/erp/pdv/approvals/route.ts");
  assert.match(approvals, /branchId_requesterId_idempotencyKey/);
  assert.match(
    approvals,
    /assertApprovalReplay\([^,]+\.requestHash, normalized\.requestHash\)/,
  );
});

test("transferência de carrinho vincula posse, alçada, revisão e replay ao contexto", () => {
  const route = source("app/api/erp/pdv/held-sales/transfer/route.ts");
  const domain = source("lib/erp/pos-held-cart-transfer.ts");
  assert.match(route, /assertSameOrigin\(request\)/);
  assert.match(route, /assertPosMutationRequest\(request\)/);
  assert.match(
    route,
    /assertTenantPermission\(organization\.id, "pdv\.write"\)/,
  );
  assert.match(route, /readPosJson\(request, 16_384\)/);
  assert.match(
    route,
    /enforcePosRateLimit\(db, permission\.user\.id, "cart\.transfer"\)/,
  );
  assert.match(route, /assertTenantWriteAccess\(organization\.id\)/);
  assert.match(
    domain,
    /actorUserId !== context\.actorUserId[\s\S]*?actorProfileId !== context\.actorProfileId[\s\S]*?branchId !== context\.branchId/,
  );
  assert.match(domain, /canTransferHeld: true/);
  assert.match(domain, /operatorProfileId: context\.actorProfileId/);
  assert.match(domain, /revision: input\.expectedRevision/);
  assert.match(domain, /isolationLevel: "Serializable"/);
  assert.match(
    domain,
    /const locator = await tx\.posHeldSale\.findUnique[\s\S]*cash_register_sessions[\s\S]*pos_held_sales[\s\S]*const held = await tx\.posHeldSale\.findUnique/,
  );
  assert.match(domain, /idempotencyKey: input\.idempotencyKey/);
  assert.match(domain, /pos\.held_cart\.transferred/);
});

test("gestão de códigos usa payload estrito, idempotência persistente, auditoria e CAS", () => {
  const route = source("app/api/erp/pdv/product-codes/route.ts");
  const domain = source("lib/erp/pos-product-code-admin.ts");
  assert.match(route, /readPosJson\(request, 32_768\)/);
  assert.match(route, /pdvAdminMutation\.create/);
  assert.match(route, /tenantAuditEvent\.create/);
  assert.match(route, /isolationLevel: "Serializable"/);
  assert.match(
    route,
    /record\.actorId !== actorId \|\| record\.action !== action \|\| record\.requestHash !== requestHash/,
  );
  assert.match(domain, /onlyKeys\(body,/);
  assert.match(domain, /FOR UPDATE/);
  assert.match(
    domain,
    /updateMany\(\{ where: \{ id: before\.id, version: before\.version, updatedAt: before\.updatedAt/,
  );
  assert.doesNotMatch(
    domain,
    /pos(?:ProductCode|VariableCodeRule)\.(?:delete|deleteMany)/,
  );
});

test("DTOs públicos não devolvem hashes, certificados nem referências de credencial", () => {
  const admin = source("app/api/erp/pdv/admin/route.ts");
  const credentials = source("app/api/erp/pdv/terminals/route.ts");
  const operational = source("app/api/erp/pdv/route.ts");
  const terminalDto = between(
    admin,
    "function terminalDto",
    "\nfunction deviceDto",
  );
  const connectorDto = between(
    admin,
    "function connectorDto",
    "\nfunction defined",
  );
  const terminalPublic = between(
    credentials,
    "function terminalPublic",
    "\nfunction text",
  );
  const operationalTerminalSelect = between(
    operational,
    "const terminalSelect",
    "\n  let registers",
  );
  for (const block of [terminalDto, terminalPublic, operationalTerminalSelect])
    assert.doesNotMatch(block, /tokenHash|certificateFingerprint/);
  assert.doesNotMatch(connectorDto, /credentialRef:\s*value\.credentialRef/);
  assert.match(
    connectorDto,
    /credentialConfigured:\s*Boolean\(value\.credentialRef\)/,
  );
});

test("gestão de promoções não persiste nem reexibe código aberto de cupom", () => {
  const route = source("app/api/erp/pdv/promotions/route.ts");
  const domain = source("lib/erp/pos-promotion-admin.ts");
  const couponDto = between(
    route,
    "function couponDto",
    "\nfunction positiveId",
  );
  assert.doesNotMatch(couponDto, /codeHash/);
  assert.match(
    domain,
    /payload\.couponCodeHash = hashPosCouponCode\(payload\.code\)[\s\S]*?delete payload\.code/,
  );
  assert.match(
    route,
    /responseBody = jsonObject\([\s\S]*?secretAvailable: false/,
  );
  assert.match(route, /pdvAdminMutation\.update\([\s\S]*?responseBody/);
  assert.match(
    route,
    /const couponCode = input\.action === "coupon\.create" \|\| input\.action === "coupon\.rotate" \? input\.code : null/,
  );
  assert.match(route, /function replay[\s\S]*?secretAvailable: false/);
  assert.match(route, /SELECT "id" FROM "pos_promotions"[\s\S]*?FOR UPDATE/);
  assert.match(route, /SELECT "id" FROM "pos_coupons"[\s\S]*?FOR UPDATE/);
  assert.match(route, /isolationLevel: "Serializable"/);
});

test("gift card não persiste segredo aberto e resolução exige PIN sob limite forte", () => {
  const route = source("app/api/erp/pdv/value-accounts/route.ts");
  const resolve = source("app/api/erp/pdv/value-accounts/resolve/route.ts");
  const domain = source("lib/erp/pos-value-accounts.ts");
  const secrets = source("lib/erp/pos-value-secrets.ts");
  const http = source("lib/erp/pos-http.ts");
  const accountDto = between(
    route,
    "function accountAdminDto",
    "\nfunction programDto",
  );
  assert.doesNotMatch(accountDto, /codeHash|pinHash|operationKey|requestHash/);
  assert.match(
    route,
    /responseBody = jsonObject\([\s\S]*?secretAvailable: false/,
  );
  assert.match(
    route,
    /return Response\.json\(\{ \.\.\.completed\.body, \.\.\.\(giftCode \? \{ giftCode, secretAvailable: true \}/,
  );
  assert.match(route, /function replay[\s\S]*?secretAvailable: false/);
  assert.match(
    route,
    /hashPosGiftCode\(giftCode\)[\s\S]*?hashPosGiftPin\(input\.pin\)/,
  );
  assert.match(resolve, /assertSameOrigin\(request\)/);
  assert.match(resolve, /assertPosMutationRequest\(request\)/);
  assert.match(
    resolve,
    /assertTenantPermission\(organization\.id, "pdv\.write"\)/,
  );
  assert.match(resolve, /assertTenantWriteAccess\(organization\.id\)/);
  assert.match(
    resolve,
    /enforcePosRateLimit\(db, actor\.user\.id, "gift\.resolve"\)/,
  );
  assert.match(resolve, /readPosJson\(request, 8_192\)/);
  assert.match(http, /"gift\.resolve": \{ limit: 10, seconds: 300 \}/);
  assert.match(secrets, /createHmac\("sha256", secretPepper\(\)\)/);
  assert.match(
    secrets,
    /hashPassword\(pinMaterial\(validatePosGiftPin\(pin\)\)\)/,
  );
  assert.match(source("lib/password.ts"), /return `scrypt:/);
  assert.match(domain, /verifyPosGiftPin\(input\.pin, account\.pinHash\)/);
  assert.match(
    domain,
    /account\.customerId != null && account\.customerId !== input\.expectedCustomerId/,
  );
});

test("venda integra saldos locais sem persistir credenciais e fecha sem contagem fictícia", () => {
  const route = source("app/api/erp/pdv/route.ts");
  const service = source("lib/erp/pos-value-sale.ts");
  const workspace = source("components/erp/pdv-workspace.tsx");
  assert.match(route, /action === "value\.accounts"/);
  assert.match(
    route,
    /customerId,\s*status:\s*"active",\s*kind:\s*\{\s*not:\s*"gift_card"\s*\}/,
  );
  assert.match(route, /consumePosSaleValues\(tx/);
  assert.match(route, /accruePosSaleValues\(tx/);
  assert.match(route, /refundPosSaleValue\(tx/);
  assert.match(route, /reversePosSaleAccruals\(tx/);
  assert.match(
    route,
    /function saleCommitRequestHash[\s\S]*hashPosValueRequestSecret\(giftCode\)[\s\S]*hashPosValueRequestSecret\(giftPin\)[\s\S]*hashPosInternalQr\(giftQrToken\)/,
  );
  assert.match(
    route,
    /method: \{ not: "store_credit" \}[\s\S]*distinct: \["method", "provider"\]/,
    "saldo local não deve pedir contagem física no fechamento",
  );
  assert.match(
    service,
    /account\.kind === "gift_card" \? account\.customerId : input\.customerId/,
    "gift card ao portador deve funcionar mesmo em venda identificada",
  );
  assert.match(
    service,
    /numerator % divisor[\s\S]*unidades inteiras/,
    "estorno de pontos não pode arredondar valor",
  );
  assert.match(workspace, /giftQrToken/);
  assert.match(workspace, /couponQrToken/);
  assert.match(workspace, /isLocallyReversibleSale/);
});

test("diálogo administrativo integra gestão de promoções sem remover segredo único do terminal", () => {
  const dialog = source("components/erp/pdv-admin-dialog.tsx");
  const promotions = source("components/erp/pdv-promotions-admin.tsx");
  assert.match(dialog, /<PdvPromotionsAdmin branchId=\{data\.branch\.id\}/);
  assert.match(dialog, /Código de pareamento \(exibição única\)/);
  assert.match(dialog, /Token do agente \(exibição única\)/);
  assert.match(promotions, /Código do cupom \(exibição única\)/);
  assert.match(promotions, /coupon\.rotate/);
  assert.match(promotions, /coupon\.deactivate/);
  assert.doesNotMatch(promotions, /localStorage|sessionStorage/);
});

test("revogação invalida material de autenticação e o agente falha fechado", () => {
  const credentials = source("app/api/erp/pdv/terminals/route.ts");
  const pairingIssue = between(
    credentials,
    'if (input.action === "terminal.pairing.issue")',
    '} else if (input.action === "terminal.token.rotate")',
  );
  assert.match(pairingIssue, /status:\s*"unpaired"/);
  assert.match(pairingIssue, /pairedAt:\s*null/);
  assert.match(pairingIssue, /revokedAt:\s*null/);
  const revoke = credentials.slice(
    credentials.indexOf('input.action === "terminal.token.rotate"'),
  );
  for (const field of [
    "tokenHash",
    "tokenIssuedAt",
    "tokenExpiresAt",
    "certificateFingerprint",
    "offlineAllowedUntil",
  ]) {
    assert.match(
      revoke,
      new RegExp(`${field}: null`),
      `revogação deve limpar ${field}`,
    );
  }
  assert.match(revoke, /status:\s*"revoked"/);
  assert.match(revoke, /posDevice\.updateMany[\s\S]*?status:\s*"disabled"/);

  const agent = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/route.ts",
  );
  assert.match(agent, /!verifyAgentToken\(/);
  assert.match(
    agent,
    /!terminal\.tokenExpiresAt \|\| terminal\.tokenExpiresAt <= now/,
  );
  assert.match(
    agent,
    /\["unpaired", "revoked"\]\.includes\(terminal\.status\)/,
  );
  assert.match(agent, /terminal\.register\.status !== "active"/);
  const liveWhere = between(
    agent,
    "function liveAgentWhere",
    "\nasync function assertLiveAgentCredential",
  );
  assert.match(liveWhere, /tokenHash:\s*context\.terminal\.tokenHash/);
  assert.match(
    liveWhere,
    /credentialVersion:\s*context\.terminal\.credentialVersion/,
  );
  assert.match(liveWhere, /tokenExpiresAt:\s*\{\s*gt:\s*new Date\(\)\s*\}/);
  assert.match(
    liveWhere,
    /status:\s*\{\s*notIn:\s*\["unpaired", "revoked"\]\s*\}/,
  );
  for (const operation of [
    "deviceHealth",
    "pullPrintJobs",
    "acknowledgePrintJobs",
  ]) {
    const block = agent.slice(agent.indexOf(`async function ${operation}`));
    assert.match(
      block,
      /\$transaction\(async tx => \{\s*await assertLiveAgentCredential\(tx, context\)/,
    );
  }
  const heartbeat = between(
    agent,
    "async function heartbeat",
    "\nasync function deviceHealth",
  );
  assert.match(heartbeat, /updateMany\(\{ where: liveAgentWhere\(context\)/);
  assert.match(heartbeat, /changed\.count !== 1/);
});

test("canais do agente têm payload estrito, limite por ação e escopo de terminal", () => {
  const agent = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/route.ts",
  );
  const pairing = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/pair/route.ts",
  );
  assert.match(agent, /readPosJson\(request, 131_072\)/);
  assert.match(pairing, /readPosJson\(request, 16_384\)/);
  assert.match(
    agent,
    /persistentRateLimit\(db, `pos-agent:auth:\$\{terminalId\}:/,
  );
  assert.match(
    pairing,
    /persistentRateLimit\(db, `pos-agent:pair:\$\{terminalId\}:/,
  );
  assert.match(agent, /onlyKeys\(body, \["action", "appVersion"\]\)/);
  assert.match(
    agent,
    /where:\s*\{[\s\S]*?terminalId:\s*context\.terminal\.id,\s*id:/,
  );
  const acknowledgementApply = between(
    agent,
    "async function applyPrintAcknowledgements",
    "\nasync function replayAppliedPrintAcknowledgements",
  );
  const leaseMutation = between(
    acknowledgementApply,
    "const changed = await tx.posPrintJob.updateMany",
    "\n      if (changed.count",
  );
  for (const invariant of [
    /id:\s*job\.id/,
    /terminalId:\s*input\.terminalId/,
    /status:\s*"processing"/,
    /claimId:\s*input\.claimId/,
  ]) {
    assert.match(leaseMutation, invariant);
  }
  assert.match(
    pairing,
    /onlyKeys\(body, \["action", "pairingCode", "certificateFingerprint"\]\)/,
  );
});

test("ACK de impressão usa ledger imutável antes de consultar ou alterar o lease", () => {
  const route = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/route.ts",
  );
  const schema = source("prisma/tenant/schema.prisma");
  const migration = source(
    "prisma/tenant/migrations/20260828143000_pos_print_ack_ledger/migration.sql",
  );
  const apply = between(
    route,
    "async function applyPrintAcknowledgements",
    "\nasync function replayAppliedPrintAcknowledgements",
  );
  const replayLookup = apply.indexOf("posPrintAcknowledgement.findUnique");
  const leaseLookup = apply.indexOf("posPrintJob.findFirst");
  const leaseUpdate = apply.indexOf("posPrintJob.updateMany");
  assert.ok(
    replayLookup >= 0 &&
      leaseLookup > replayLookup &&
      leaseUpdate > leaseLookup,
    "ledger deve preceder qualquer acesso mutável ao lease",
  );
  assert.match(
    apply,
    /if \(existing\) \{[\s\S]*?replayPosPrintAck\(existing, input\)[\s\S]*?continue;/,
  );
  assert.match(
    apply,
    /posPrintAcknowledgement\.create[\s\S]*?tenantAuditEvent\.create/,
  );
  assert.doesNotMatch(
    apply.slice(apply.indexOf("if (existing)"), apply.indexOf("const job")),
    /updateMany|tenantAuditEvent\.create/,
  );
  assert.match(
    route,
    /PosPrintAckConcurrentError[\s\S]*?\["P2002", "P2034"\][\s\S]*?replayAppliedPrintAcknowledgements/,
  );

  const model = between(
    schema,
    "model PosPrintAcknowledgement",
    "\nmodel Customer",
  );
  assert.match(model, /claimId\s+String\s+@unique/);
  assert.match(
    model,
    /@relation\(fields: \[jobId, terminalId\], references: \[id, terminalId\], onDelete: Restrict\)/,
  );
  assert.doesNotMatch(
    model,
    /\berror\b/i,
    "ledger não deve persistir o erro aberto",
  );
  for (const invariant of [
    "pos_print_jobs_id_terminal_id_key",
    "pos_print_acknowledgements_claim_id_key",
    "pos_print_ack_terminal_job_claim_key",
    "pos_print_ack_job_terminal_fkey",
    "pos_print_ack_request_hash_check",
    "pos_print_ack_state_result_check",
    "pos_print_ack_attempt_check",
  ])
    assert.match(migration, new RegExp(invariant));
  assert.doesNotMatch(migration, /"error"/i);
});

test("produtor de comprovante deriva snapshot no servidor e reautoriza replay", () => {
  const route = source("app/api/erp/pdv/print-jobs/route.ts");
  const migration = source(
    "prisma/tenant/migrations/20260828147000_pos_print_job_producer/migration.sql",
  );
  const transaction = between(
    route,
    "const result = await db.$transaction",
    "\n      }, { isolationLevel",
  );
  assert.match(
    route,
    /onlyKeys\(body, \["sessionId", "saleId", "terminalId", "copy", "reason", "idempotencyKey"\]\)/,
  );
  assert.doesNotMatch(
    route,
    /onlyKeys\([^\n]*"payload"/,
    "cliente não pode fornecer payload de impressão",
  );
  assert.ok(
    transaction.indexOf("cashRegisterSession.findFirst") <
      transaction.indexOf("sale.findFirst"),
  );
  assert.ok(
    transaction.indexOf("sale.findFirst") <
      transaction.indexOf("posPrintJob.findUnique"),
    "replay só deve ocorrer após reautorizar turno/venda",
  );
  assert.match(transaction, /items:\s*\{\s*select:/);
  assert.match(transaction, /payments:\s*\{\s*select:/);
  assert.match(transaction, /schema:\s*"nalven\.pos\.receipt\.v1"/);
  assert.match(
    transaction,
    /posPrintJob\.create[\s\S]*?tenantAuditEvent\.create/,
  );
  const dto = between(route, "function publicJob", "\nfunction hash");
  assert.doesNotMatch(dto, /payload|requestHash|idempotencyKey|requestedBy/);
  for (const invariant of [
    "pos_print_jobs_idempotency_key_key",
    "pos_print_jobs_one_original_receipt_idx",
    "pos_print_jobs_request_hash_check",
  ])
    assert.match(migration, new RegExp(invariant));
});

test("cadastro rápido de cliente não concede crédito nem sobrescreve cadastro existente", () => {
  const route = source("app/api/erp/pdv/customers/route.ts");
  assert.match(
    route,
    /onlyKeys\(body, \["sessionId", "name", "tradeName", "document", "email", "phone"\]\)/,
  );
  assert.match(route, /operatorProfileId:\s*profile\.id,\s*status:\s*"open"/);
  assert.match(route, /posRegisterAccess\.findFirst[\s\S]*?canSell:\s*true/);
  assert.match(route, /customerInput\(\{ \.\.\.body, creditLimit: 0 \}\)/);
  assert.match(route, /customer\.create\([\s\S]*?creditLimit:\s*0/);
  const duplicate = route.slice(
    route.indexOf('if (prismaCode(error) !== "P2002")'),
  );
  assert.match(
    duplicate,
    /customer\.findUnique\(\{ where: \{ document: input\.document \} \}\)/,
  );
  assert.doesNotMatch(duplicate, /customer\.update|customer\.upsert/);
});

test("sincronização offline autentica novamente sob lock e transação serializável", () => {
  const route = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/sync/route.ts",
  );
  const apply = between(
    route,
    "async function applySyncBatch",
    "\nasync function replaySyncBatch",
  );
  assert.match(route, /assertPosMutationRequest\(request\)/);
  assert.match(route, /readPosJson\(request, 262_144\)/);
  assert.match(
    route,
    /persistentRateLimit\(db, `pos-agent:sync-auth:\$\{terminalId\}:/,
  );
  assert.match(
    route,
    /persistentRateLimit\(db, `pos-agent:\$\{terminalId\}:\$\{action\}`/,
  );
  assert.match(
    route,
    /verifyAgentToken\(terminal\.tokenHash, organizationId, terminalId, token\)/,
  );
  assert.ok(
    apply.indexOf("await lockTerminal") <
      apply.indexOf("await assertLiveCredential"),
  );
  assert.match(apply, /isolationLevel:\s*"Serializable"/);
  const liveWhere = between(
    route,
    "function liveTerminalWhere",
    "\nfunction liveOfflineCredentialWhere",
  );
  for (const invariant of [
    /tokenHash:/,
    /credentialVersion:/,
    /tokenExpiresAt:/,
    /status:/,
    /register:/,
  ])
    assert.match(liveWhere, invariant);
});

test("ledger offline vincula idempotência ao contexto e avança cursor monotônico sob lock", () => {
  const route = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/sync/route.ts",
  );
  const helper = source("lib/erp/pos-offline-sync.ts");
  const apply = between(
    route,
    "async function applySyncBatch",
    "\nasync function replaySyncBatch",
  );
  assert.match(helper, /purpose:\s*"pos\.offline\.sync"/);
  for (const field of [
    "organizationId",
    "terminalId",
    "operationId",
    "sequence",
    "type",
    "occurredAt",
    "payload",
  ])
    assert.match(helper, new RegExp(`${field}:`));
  assert.ok(
    apply.indexOf("posSyncOperation.findUnique") <
      apply.indexOf("posSyncOperation.create"),
    "replay deve preceder criação",
  );
  assert.match(apply, /terminalId_operationId/);
  assert.match(apply, /terminalId_sequence/);
  assert.match(apply, /const expected = cursor \+ BigInt\(1\)/);
  assert.match(apply, /operation\.sequence !== expected/);
  assert.match(
    apply,
    /state:\s*"received"[\s\S]*?state:\s*"processing"[\s\S]*?state:\s*final\.state/,
  );
  assert.match(apply, /lastSyncCursor:\s*cursor/);
  assert.match(route, /\["P2002", "P2034"\][\s\S]*?replaySyncBatch/);
  assert.match(route, /idempotency-replayed/);
});

test("sincronização offline mantém escopo honesto sem aceitar pagamento ou fiscal do cliente", () => {
  const helper = source("lib/erp/pos-offline-sync.ts");
  const route = source(
    "app/api/pos-agent/[organizationId]/[terminalId]/sync/route.ts",
  );
  assert.match(helper, /"terminal\.heartbeat": "applied"/);
  assert.match(helper, /"cart\.draft\.upsert": "applied"/);
  assert.match(helper, /"cart\.draft\.discard": "applied"/);
  for (const type of [
    "sale.commit",
    "payment.capture",
    "payment.confirm",
    "fiscal.issue",
    "fiscal.authorize",
  ])
    assert.match(
      helper,
      new RegExp(`"${type.replace(".", "\\.")}": "rejected"`),
    );
  assert.match(helper, /code:\s*"offline_operation_not_supported"/);
  assert.match(helper, /requiresOnline:\s*true/);
  assert.doesNotMatch(
    route,
    /paymentIntent|providerReference|fiscalDocument|sale\.create/,
  );
  const audit = between(
    route,
    "await tx.tenantAuditEvent.create",
    "\n      cursor = operation.sequence",
  );
  assert.doesNotMatch(audit, /(?:payload|response|conflict)\s*:/);
});

test("migration offline fecha estados, hashes, JSON e índices de reconciliação", () => {
  const schema = source("prisma/tenant/schema.prisma");
  const migration = source(
    "prisma/tenant/migrations/20260828160000_pos_offline_sync_hardening/migration.sql",
  );
  const model = between(
    schema,
    "model PosSyncOperation",
    "\nmodel PosApproval",
  );
  assert.match(model, /@@unique\(\[terminalId, operationId\]\)/);
  assert.match(model, /@@unique\(\[terminalId, sequence\]\)/);
  for (const invariant of [
    "pos_terminals_last_sync_cursor_check",
    "pos_sync_operations_sequence_check",
    "pos_sync_operations_operation_id_check",
    "pos_sync_operations_type_check",
    "pos_sync_operations_state_check",
    "pos_sync_operations_request_hash_check",
    "pos_sync_operations_payload_object_check",
    "pos_sync_operations_response_object_check",
    "pos_sync_operations_conflict_object_check",
    "pos_sync_operations_lifecycle_check",
    "pos_sync_operations_terminal_state_sequence_idx",
    "pos_sync_operations_terminal_occurred_idx",
  ])
    assert.match(migration, new RegExp(invariant));
  assert.match(
    migration,
    /received'[\s\S]*?'processing'[\s\S]*?'applied'[\s\S]*?'rejected'[\s\S]*?'conflict'/,
  );
});
