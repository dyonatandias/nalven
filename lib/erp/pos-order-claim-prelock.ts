import { Prisma } from "@/generated/tenant/client";
import { PosOrderClaimError } from "@/lib/erp/pos-order-claim";
import {
  assertPosOperationalTerminalProof,
  assertPosSessionTerminalBinding,
  posOperationalTerminalSelect,
  type PosOperationalTerminalProof,
} from "@/lib/erp/pos-terminal-boundary";

type ClaimAction = "create" | "expire_and_create" | "recover" | "renew" | "release";

export type PosOrderClaimPrelockInput = {
  action: ClaimAction;
  branchId: number;
  registerId: number;
  sessionId: number;
  sessionVersion: number;
  operatorProfileId: number;
  terminalProof: PosOperationalTerminalProof;
  salesOrderId: number;
  claimId?: string;
  newClaimId?: string;
  locatedActiveClaimIds?: readonly string[];
  expectedVersion?: number;
  idempotencyKey?: string;
};

/** Read-only transport locator. Its result only selects advisory/root identities. */
export async function locatePosOrderClaimSalesOrder(
  db: Pick<Prisma.TransactionClient, "posOrderClaim">,
  claimId: string,
) {
  return db.posOrderClaim.findUnique({ where: { id: claimId }, select: { salesOrderId: true } });
}

/**
 * Canonical claim writer prelock: advisory namespaces first, then
 * session -> terminal -> profile -> branch -> register -> grants -> order ->
 * claim -> held sale. Every locator binding is reread under the acquired roots.
 */
export async function prelockPosOrderClaimWrite(tx: Prisma.TransactionClient, input: PosOrderClaimPrelockInput) {
  if (input.terminalProof.terminalId.length === 0 || input.salesOrderId <= 0 || input.sessionId <= 0 || input.registerId <= 0 || input.branchId <= 0 || input.operatorProfileId <= 0) {
    throw new PosOrderClaimError("Raízes operacionais incompletas para alterar a posse do pedido.");
  }
  const advisoryNamespaces = [...new Set([
    `pos-order-claim:v1:order:${input.salesOrderId}`,
    ...(input.claimId ? [
      `pos-order-claim:v1:claim:${input.claimId}`,
      `pos-order-claim:v1:artifacts:${input.claimId}`,
    ] : []),
    ...(input.newClaimId ? [`pos-order-claim:v1:claim:${input.newClaimId}`] : []),
    ...(input.locatedActiveClaimIds ?? []).flatMap((claimId) => [
      `pos-order-claim:v1:claim:${claimId}`,
      `pos-order-claim:v1:artifacts:${claimId}`,
    ]),
    ...(input.idempotencyKey ? [`pos-order-claim:v1:idempotency:${input.idempotencyKey}`] : []),
  ])].sort((left, right) => left.localeCompare(right));
  for (const namespace of advisoryNamespaces) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`);
  }

  const sessions = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "cash_register_sessions"
     WHERE "id" = ${input.sessionId}
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("turno", sessions);

  const terminalRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "pos_terminals"
     WHERE "id" = ${input.terminalProof.terminalId}
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("terminal", terminalRows);

  const profileRows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "tenant_user_profiles"
     WHERE "id" = ${input.operatorProfileId} AND "status" = 'active'
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("perfil ativo", profileRows);

  const branchRows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "branches"
     WHERE "id" = ${input.branchId} AND "status" = 'active'
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("filial ativa", branchRows);

  const registerRows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "pos_registers"
     WHERE "id" = ${input.registerId} AND "branch_id" = ${input.branchId} AND "status" = 'active'
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("caixa ativo da filial", registerRows);

  const branchGrantRows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "branch_user_accesses"
     WHERE "branch_id" = ${input.branchId} AND "user_profile_id" = ${input.operatorProfileId} AND "can_sell" = TRUE
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("grant de venda da filial", branchGrantRows);

  const registerGrantRows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "pos_register_accesses"
     WHERE "register_id" = ${input.registerId} AND "user_profile_id" = ${input.operatorProfileId}
       AND "active" = TRUE AND "can_sell" = TRUE
       AND ("valid_from" IS NULL OR "valid_from" <= clock_timestamp())
       AND ("valid_until" IS NULL OR "valid_until" > clock_timestamp())
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("grant vigente de venda do caixa", registerGrantRows);

  const orderRows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "sales_orders"
     WHERE "id" = ${input.salesOrderId} AND "branch_id" = ${input.branchId}
     ORDER BY "id" FOR UPDATE
  `);
  assertOne("pedido da filial", orderRows);

  const lockedClaims = input.claimId
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "pos_order_claims" WHERE "id" = ${input.claimId} ORDER BY "id" FOR UPDATE
      `)
    : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "pos_order_claims"
         WHERE "sales_order_id" = ${input.salesOrderId} AND "state" = 'active'
         ORDER BY "id" FOR UPDATE
      `);
  if (input.claimId) assertOne("posse do pedido", lockedClaims);
  if (!input.claimId && lockedClaims.length > 1) throw new PosOrderClaimError("Mais de uma posse ativa foi encontrada para o pedido.");
  if (!input.claimId && !sameStrings(lockedClaims.map((row) => row.id), input.locatedActiveClaimIds ?? [])) {
    throw new PosOrderClaimError("O conjunto de posses ativas mudou desde a localização canônica.");
  }

  const heldIds = [...new Set(lockedClaims.map((row) => row.id))].sort();
  if (heldIds.length) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "pos_held_sales"
       WHERE "id" IN (${Prisma.join(heldIds)})
       ORDER BY "id" FOR UPDATE
    `);
  }

  const [session, terminal, claim] = await Promise.all([
    tx.cashRegisterSession.findUnique({ where: { id: input.sessionId }, select: { id: true, registerId: true, operatorProfileId: true, status: true, version: true, openingAmountCents: true, openRequestHash: true } }),
    tx.posTerminal.findUnique({ where: { id: input.terminalProof.terminalId }, select: posOperationalTerminalSelect }),
    input.claimId ? tx.posOrderClaim.findUnique({ where: { id: input.claimId } }) : Promise.resolve(null),
  ]);
  if (!session || session.status !== "open" || session.version !== input.sessionVersion || session.registerId !== input.registerId || session.operatorProfileId !== input.operatorProfileId) {
    throw new PosOrderClaimError("O turno foi fechado, alterado ou pertence a outro contexto operacional.");
  }
  assertPosSessionTerminalBinding(session, input.terminalProof);
  assertPosOperationalTerminalProof(terminal, input.terminalProof, { expectedBranchId: input.branchId, expectedRegisterId: input.registerId });
  if (claim) {
    if (claim.salesOrderId !== input.salesOrderId || claim.branchId !== input.branchId || claim.registerId !== input.registerId || claim.sessionId !== input.sessionId || claim.operatorProfileId !== input.operatorProfileId || claim.terminalId !== input.terminalProof.terminalId) {
      throw new PosOrderClaimError("A posse do pedido mudou de vínculo durante o pré-lock.", 403);
    }
    if (input.expectedVersion != null && claim.version !== input.expectedVersion) throw new PosOrderClaimError("A posse do pedido mudou. Atualize antes de continuar.");
    if (claim.state !== "active") throw new PosOrderClaimError("A posse do pedido não está mais ativa.");
    if (input.action === "renew" && claim.leaseExpiresAt <= new Date()) {
      throw new PosOrderClaimError("A posse do pedido expirou. Recupere-a antes de renovar.");
    }
  }
  return { claim, lockedClaimIds: heldIds };
}

function assertOne(label: string, rows: readonly unknown[]) {
  if (rows.length !== 1) throw new PosOrderClaimError(`Cardinalidade ou estado inválido em ${label}.`);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const sortedLeft = [...new Set(left)].sort((a, b) => a.localeCompare(b));
  const sortedRight = [...new Set(right)].sort((a, b) => a.localeCompare(b));
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}
