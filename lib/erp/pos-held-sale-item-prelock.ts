import { Prisma } from "@/generated/tenant/client";

export type PosHeldSaleItemWriteAction = "create" | "replace_batch";

export type PosHeldSaleItemWriteRoots = {
  action: PosHeldSaleItemWriteAction;
  idempotencyKey: string;
  heldSaleId: string;
  sessionIds: readonly number[];
  terminalIds: readonly string[];
  branchIds: readonly number[];
  registerIds: readonly number[];
  operatorProfileIds: readonly number[];
  terminalRegisterPairs: ReadonlyArray<readonly [terminalId: string, registerId: number]>;
  registerBranchPairs: ReadonlyArray<readonly [registerId: number, branchId: number]>;
  branchProfilePairs: ReadonlyArray<readonly [branchId: number, operatorProfileId: number]>;
  registerProfilePairs: ReadonlyArray<readonly [registerId: number, operatorProfileId: number]>;
  /** An absent claim is allowed only when declared explicitly by the caller. */
  orderClaim?: { id: string; expectation: "required" | "optional" };
  /** Locks required by a downstream guarded write before this helper locks roots. */
  preRootAdvisoryNamespaces?: readonly string[];
};

/**
 * Prelocks and revalidates every operational root reached by a
 * pos_held_sale_items writer. Discovery lookups may run before this helper, but
 * no decision may rely on them: advisory serialization comes first and every
 * required row/grant is checked again under its lock.
 */
export async function prelockPosHeldSaleItemWrite(
  tx: Prisma.TransactionClient,
  roots: PosHeldSaleItemWriteRoots,
) {
  const sessionIds = sortedUniqueNumbers(roots.sessionIds);
  const terminalIds = sortedUniqueStrings(roots.terminalIds);
  const branchIds = sortedUniqueNumbers(roots.branchIds);
  const registerIds = sortedUniqueNumbers(roots.registerIds);
  const operatorProfileIds = sortedUniqueNumbers(roots.operatorProfileIds);
  const terminalRegisterPairs = sortedUniqueStringNumberPairs(roots.terminalRegisterPairs);
  const registerBranchPairs = sortedUniquePairs(roots.registerBranchPairs);
  const branchProfilePairs = sortedUniquePairs(roots.branchProfilePairs);
  const registerProfilePairs = sortedUniquePairs(roots.registerProfilePairs);
  if (!roots.idempotencyKey || !roots.heldSaleId || !sessionIds.length || !terminalIds.length || !branchIds.length || !registerIds.length
    || !operatorProfileIds.length || !terminalRegisterPairs.length || !registerBranchPairs.length || !branchProfilePairs.length || !registerProfilePairs.length) {
    throw new Error("Raízes operacionais incompletas para gravar itens do carrinho.");
  }
  assertStringNumberPairMembers(terminalRegisterPairs, terminalIds, registerIds, "terminal/caixa");
  assertStringNumberPairCoverage(terminalRegisterPairs, terminalIds, registerIds, "terminal/caixa");
  assertPairMembers(registerBranchPairs, registerIds, branchIds, "caixa/filial");
  assertPairCoverage(registerBranchPairs, registerIds, branchIds, "caixa/filial");
  assertPairMembers(branchProfilePairs, branchIds, operatorProfileIds, "filial");
  assertPairMembers(registerProfilePairs, registerIds, operatorProfileIds, "caixa");
  assertPairCoverage(branchProfilePairs, branchIds, operatorProfileIds, "filial");
  assertPairCoverage(registerProfilePairs, registerIds, operatorProfileIds, "caixa");

  // Read-only locator. It only discovers the sales-order identity needed for
  // advisory/root ordering; every binding is reread after the locks below.
  const orderClaimLocator = roots.orderClaim
    ? await tx.posOrderClaim.findUnique({ where: { id: roots.orderClaim.id }, select: { salesOrderId: true } })
    : null;

  // T2 §6: advisory -> session -> terminal -> profiles/branch/register/grants
  // -> claim -> held sale -> items.  A create has two zero-row identities that
  // must be serialized independently: the immutable parent id and the
  // idempotency key.  Sorting is mandatory because a replace can race a
  // conflicting create/replay that reaches the same identities in another
  // order.  Do not acquire advisory locks after a row root.
  const advisoryNamespaces = [
    `pos-held-sale-items:v1:held-sale:${roots.heldSaleId}`,
    `pos-held-sale-items:v1:idempotency:${roots.idempotencyKey}`,
    ...(roots.orderClaim ? [
      `pos-order-claim:v1:claim:${roots.orderClaim.id}`,
      `pos-order-claim:v1:artifacts:${roots.orderClaim.id}`,
    ] : []),
    ...(orderClaimLocator ? [`pos-order-claim:v1:order:${orderClaimLocator.salesOrderId}`] : []),
    ...(roots.preRootAdvisoryNamespaces ?? []),
  ].sort((left, right) => left.localeCompare(right));
  for (const advisoryNamespace of advisoryNamespaces) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${advisoryNamespace}, 0))`);
  }

  const sessions = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "cash_register_sessions"
     WHERE "id" IN (${Prisma.join(sessionIds)}) AND "status" = 'open'
     ORDER BY "id" FOR UPDATE
  `);
  assertExactIds("turnos abertos", sessionIds, sessions.map((row) => row.id));

  const terminals = await tx.$queryRaw<Array<{ id: string; registerId: number }>>(Prisma.sql`
    SELECT "id", "register_id" AS "registerId" FROM "pos_terminals"
     WHERE "id" IN (${Prisma.join(terminalIds)}) AND "status" = 'online' AND "revoked_at" IS NULL
     ORDER BY "id" FOR UPDATE
  `);
  assertExactIds("terminais online", terminalIds, terminals.map((row) => row.id));
  assertExactStringNumberPairs("terminais vinculados aos caixas", terminalRegisterPairs, terminals.map((row) => [row.id, row.registerId] as const));

  const profiles = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "tenant_user_profiles"
     WHERE "id" IN (${Prisma.join(operatorProfileIds)}) AND "status" = 'active'
     ORDER BY "id" FOR UPDATE
  `);
  assertExactIds("perfis ativos", operatorProfileIds, profiles.map((row) => row.id));

  const branches = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "branches"
     WHERE "id" IN (${Prisma.join(branchIds)}) AND "status" = 'active'
     ORDER BY "id" FOR UPDATE
  `);
  assertExactIds("filiais ativas", branchIds, branches.map((row) => row.id));

  const registers = await tx.$queryRaw<Array<{ id: number; branchId: number }>>(Prisma.sql`
    SELECT "id", "branch_id" AS "branchId" FROM "pos_registers"
     WHERE "id" IN (${Prisma.join(registerIds)}) AND "status" = 'active'
     ORDER BY "id" FOR UPDATE
  `);
  assertExactIds("caixas ativos", registerIds, registers.map((row) => row.id));
  assertExactPairs("caixas vinculados às filiais", registerBranchPairs, registers.map((row) => [row.id, row.branchId] as const));

  const branchGrants = await tx.$queryRaw<Array<{ branchId: number; operatorProfileId: number }>>(Prisma.sql`
    SELECT "branch_id" AS "branchId", "user_profile_id" AS "operatorProfileId"
      FROM "branch_user_accesses"
     WHERE ("branch_id", "user_profile_id") IN (${pairSql(branchProfilePairs)})
       AND "can_sell" = TRUE
     ORDER BY "branch_id", "user_profile_id" FOR UPDATE
  `);
  assertExactPairs("grants de filial", branchProfilePairs, branchGrants.map((row) => [row.branchId, row.operatorProfileId] as const));

  const registerGrants = await tx.$queryRaw<Array<{ registerId: number; operatorProfileId: number; validFrom: Date | null; validUntil: Date | null }>>(Prisma.sql`
    SELECT "register_id" AS "registerId", "user_profile_id" AS "operatorProfileId",
           "valid_from" AS "validFrom", "valid_until" AS "validUntil"
      FROM "pos_register_accesses"
     WHERE ("register_id", "user_profile_id") IN (${pairSql(registerProfilePairs)})
       AND "active" = TRUE AND "can_sell" = TRUE
     ORDER BY "register_id", "user_profile_id" FOR UPDATE
  `);
  assertExactPairs("grants vigentes de caixa", registerProfilePairs, registerGrants.map((row) => [row.registerId, row.operatorProfileId] as const));

  if (roots.orderClaim) {
    if (orderClaimLocator) {
      const orders = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT "id" FROM "sales_orders"
         WHERE "id" = ${orderClaimLocator.salesOrderId}
         FOR UPDATE
      `);
      assertExactIds("pedido da posse", [orderClaimLocator.salesOrderId], orders.map((row) => row.id));
    }
    const claims = await tx.$queryRaw<Array<{ id: string; salesOrderId: number }>>(Prisma.sql`
      SELECT "id", "sales_order_id" AS "salesOrderId" FROM "pos_order_claims"
       WHERE "id" = ${roots.orderClaim.id}
       FOR UPDATE
    `);
    if (roots.orderClaim.expectation === "required") assertExactIds("pedido reivindicado", [roots.orderClaim.id], claims.map((row) => row.id));
    if (Boolean(orderClaimLocator) !== Boolean(claims.length)
      || orderClaimLocator && claims[0]?.salesOrderId !== orderClaimLocator.salesOrderId) {
      throw new Error("O vínculo da posse do pedido mudou durante o pré-lock.");
    }
  }

  const heldSales = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "pos_held_sales"
     WHERE "id" = ${roots.heldSaleId}
     FOR UPDATE
  `);
  if (roots.action === "replace_batch") {
    assertExactIds("carrinho existente", [roots.heldSaleId], heldSales.map((row) => row.id));
  } else if (heldSales.length !== 0) {
    throw new Error("A identidade do novo carrinho já existe.");
  }

  if (heldSales.length) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "pos_held_sale_items"
       WHERE "held_sale_id" = ${roots.heldSaleId}
       ORDER BY "id" FOR UPDATE
    `);
  }

  const clockRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  const now = clockRows[0]?.now;
  if (!now || registerGrants.some((grant) => grant.validFrom && grant.validFrom > now || grant.validUntil && grant.validUntil < now)) {
    throw new Error("Grant de caixa fora da vigência após o pré-lock.");
  }
}

function pairSql(pairs: ReadonlyArray<readonly [number, number]>) {
  return Prisma.join(pairs.map(([scopeId, profileId]) => Prisma.sql`(${scopeId}, ${profileId})`));
}

function assertPairMembers(pairs: ReadonlyArray<readonly [number, number]>, scopeIds: readonly number[], profileIds: readonly number[], label: string) {
  if (pairs.some(([scopeId, profileId]) => !scopeIds.includes(scopeId) || !profileIds.includes(profileId))) {
    throw new Error(`Par operacional de ${label} não pertence às raízes declaradas.`);
  }
}

function assertPairCoverage(pairs: ReadonlyArray<readonly [number, number]>, scopeIds: readonly number[], profileIds: readonly number[], label: string) {
  if (scopeIds.some((scopeId) => !pairs.some((pair) => pair[0] === scopeId)) || profileIds.some((profileId) => !pairs.some((pair) => pair[1] === profileId))) {
    throw new Error(`Cobertura incompleta dos pares operacionais de ${label}.`);
  }
}

function assertStringNumberPairMembers(pairs: ReadonlyArray<readonly [string, number]>, scopeIds: readonly string[], targetIds: readonly number[], label: string) {
  if (pairs.some(([scopeId, targetId]) => !scopeIds.includes(scopeId) || !targetIds.includes(targetId))) {
    throw new Error(`Par operacional de ${label} não pertence às raízes declaradas.`);
  }
}

function assertStringNumberPairCoverage(pairs: ReadonlyArray<readonly [string, number]>, scopeIds: readonly string[], targetIds: readonly number[], label: string) {
  if (scopeIds.some((scopeId) => !pairs.some((pair) => pair[0] === scopeId)) || targetIds.some((targetId) => !pairs.some((pair) => pair[1] === targetId))) {
    throw new Error(`Cobertura incompleta dos pares operacionais de ${label}.`);
  }
}

function assertExactIds<T extends number | string>(label: string, expected: readonly T[], actual: readonly T[]) {
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error(`Cardinalidade ou estado inválido em ${label}.`);
  }
}

function assertExactPairs(label: string, expected: ReadonlyArray<readonly [number, number]>, actual: ReadonlyArray<readonly [number, number]>) {
  if (expected.length !== actual.length || expected.some((pair, index) => pair[0] !== actual[index]?.[0] || pair[1] !== actual[index]?.[1])) {
    throw new Error(`Cardinalidade ou estado inválido em ${label}.`);
  }
}

function assertExactStringNumberPairs(label: string, expected: ReadonlyArray<readonly [string, number]>, actual: ReadonlyArray<readonly [string, number]>) {
  if (expected.length !== actual.length || expected.some((pair, index) => pair[0] !== actual[index]?.[0] || pair[1] !== actual[index]?.[1])) {
    throw new Error(`Cardinalidade ou estado inválido em ${label}.`);
  }
}

function sortedUniqueNumbers(values: readonly number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sortedUniqueStrings(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniquePairs(values: ReadonlyArray<readonly [number, number]>) {
  return [...new Map(values.map((pair) => [`${pair[0]}:${pair[1]}`, pair])).values()]
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function sortedUniqueStringNumberPairs(values: ReadonlyArray<readonly [string, number]>) {
  return [...new Map(values.map((pair) => [`${pair[0]}:${pair[1]}`, pair])).values()]
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1]);
}
