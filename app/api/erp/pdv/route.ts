import { createHash, randomUUID } from "node:crypto";
import { POS_SETTINGS_REQUIRED } from "@/lib/erp/pos-settings";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  classifyPosScanPurpose,
  isValidGtin,
  parsePosScan,
  PosDomainError,
  pricePosCart,
  settlePosPayments,
} from "@/lib/erp/pos-domain";
import {
  assertAuthoritativePosCodeReads,
  finalizePosProductCodeResolution,
  resolvePosProductCode,
} from "@/lib/erp/pos-product-codes";
import { evaluatePosClosingPolicy } from "@/lib/erp/pos-closing";
import {
  assertPosDiscountApprovalContext,
  buildPosDiscountApproval,
  type PosDiscountApprovalContext,
} from "@/lib/erp/pos-discount-approval";
import {
  assertPosMutationRequest,
  enforcePosRateLimit,
  PosHttpError,
  readPosJson,
} from "@/lib/erp/pos-http";
import {
  applyPosCommonStockChange,
  posAvailableStock,
  PosCommonStockError,
  stockMode,
} from "@/lib/erp/pos-common-stock";
import {
  allocatePosTrackedSaleItem,
  parsePosScanTrackingRequests,
  posBusinessDate,
  PosInventoryOperationError,
  restorePosTrackedSaleItem,
} from "@/lib/erp/pos-inventory-operations";
import { PosInventoryTrackingError } from "@/lib/erp/pos-inventory-tracking";
import {
  posKitReturnMicros,
  posKitSnapshotForHash,
  PosKitError,
  resolvePosKitPlans,
} from "@/lib/erp/pos-kits";
import {
  parsePosOfflineToken,
  verifyPosOfflineCredential,
} from "@/lib/erp/pos-offline-credential";
import {
  hashPosInternalQr,
  loadPosInternalQrKeyring,
  PosInternalQrError,
  verifyPosInternalQr,
} from "@/lib/erp/pos-internal-qr";
import {
  planPosPromotionReversal,
  posPromotionReversalReason,
  PosPromotionRedemptionError,
} from "@/lib/erp/pos-promotion-redemptions";
import {
  buildPosPromotionRule,
  evaluatePosPromotions,
  hashPosCouponCode,
  normalizePosCouponCode,
  PosPromotionDomainError,
} from "@/lib/erp/pos-promotions";
import { PosValueError } from "@/lib/erp/pos-value-accounts";
import {
  accruePosSaleValues,
  consumePosSaleValues,
  posValueRefundUnits,
  refundPosSaleValue,
  reversePosSaleAccruals,
  type PosSaleValuePaymentInput,
} from "@/lib/erp/pos-value-sale";
import {
  hashPosValueRequestSecret,
  PosValueSecretError,
} from "@/lib/erp/pos-value-secrets";
import { calculatePosReturnRefundCents } from "@/lib/erp/pos-returns";
import {
  assertPosPostSaleApprovalContext,
  buildPosCancelApprovalContext,
  buildPosReturnApprovalContext,
  normalizePosPostSaleApprovalIntent,
  type PosPostSaleApprovalContext,
  type PosReturnApprovalIntent,
} from "@/lib/erp/pos-post-sale-approval";
import { publicPosCustomer } from "@/lib/erp/pos-customer-privacy";
import {
  buildPosCatalogPage,
  parsePosCatalogPageRequest,
  PosCatalogPaginationError,
} from "@/lib/erp/pos-catalog-pagination";
import { POS_DRAFT_RECOVERY_INTENT_STATES } from "@/lib/erp/pos-draft-recovery";
import {
  assertExactPosOrderCart,
  assertExactPosOrderPricing,
  assertExactReservationQuantity,
  assertPosOrderClaimContext,
  assertPosOrderEligible,
  assertPosOrderSettlement,
  evaluatePosOrderEligibility,
  hashPosOrderClaimRequest,
  posOrderClaimLease,
  posOrderPaymentMethod,
  PosOrderClaimError,
} from "@/lib/erp/pos-order-claim";
import {
  locatePosOrderClaimSalesOrder,
  prelockPosOrderClaimWrite,
} from "@/lib/erp/pos-order-claim-prelock";
import {
  assertPosManualPaymentApprovalContext,
  posManualPaymentApprovalContext,
  type PosManualPaymentApprovalContext,
} from "@/lib/erp/pos-manual-payment";
import {
  posManualPaymentReferenceWriteTarget,
  posSalePaymentWriteTarget,
  preparePosManualPaymentReferenceWrite,
  preparePosSalePaymentWrite,
} from "@/lib/erp/pos-payment-artifact-capability";
import { prelockPosManualReferenceWrite } from "@/lib/erp/pos-manual-payment-reference-prelock";
import { preparePosManualSessionTransition } from "@/lib/erp/pos-manual-operational-prelock";
import { preparePosHeldSaleItemsCapability } from "@/lib/erp/pos-held-sale-item-capability";
import { prelockPosHeldSaleItemWrite } from "@/lib/erp/pos-held-sale-item-prelock";
import {
  consumeCapturedPosPaymentIntent,
  PosPaymentPersistenceError,
} from "@/lib/erp/pos-payment-persistence";
import { prelockPosSalePaymentWriteGraph } from "@/lib/erp/pos-sale-payment-prelock";
import {
  consumePosPaymentPlan,
  exactPosPaymentPlanForCommit,
  persistQuotedPosPaymentPlan,
  posPaymentPlanDto,
  PosPaymentPlanError,
  preparePosPaymentPlanConsumption,
  supersedeOpenPosPaymentPlansForDraft,
  type PosPaymentPlanExecutionInput,
} from "@/lib/erp/pos-payment-plan";
import {
  assertPosOperationalTerminalProof,
  assertPosSessionTerminalBinding,
  authenticatePosOperationalTerminal,
  posOperationalTerminalSelect,
  posTerminalBoundOpenRequestHash,
  PosTerminalBoundaryError,
  readPosOperationalTerminalCredential,
  type PosOperationalTerminalProof,
} from "@/lib/erp/pos-terminal-boundary";
import { queuePosFiscalIssuanceForSale } from "@/lib/erp/pos-fiscal-persistence";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Access = Awaited<ReturnType<typeof posContext>>;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(
      organization.id,
      "pdv.read",
    );
    const db = await tenantDb(organization.id);
    const context = await posContext(db, permission, organization.id);
    const url = new URL(request.url);
    if (url.searchParams.has("resource"))
      return await paginatedPosCatalog(db, context, url.searchParams);
    const query = url.searchParams.get("q")?.trim().slice(0, 100) || "";
    return Response.json(await bootstrap(db, context, query));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(
      organization.id,
      "pdv.write",
    );
    const db = await tenantDb(organization.id);
    const body = await readPosJson(request);
    const action = string(body.action, "Ação", 80);
    await enforcePosRateLimit(db, permission.user.id, action);
    let context = await posContext(db, permission, organization.id);
    if (action === "scan.resolve") return resolveScan(db, context, body);
    if (action === "value.accounts")
      return availableValueAccounts(db, context, body);
    if (action === "order.lookup") return lookupPosOrder(db, context, body);
    await assertTenantWriteAccess(organization.id);
    if (context.privileged) {
      await materializePrivilegedPosAccess(db, context);
      context = await posContext(db, permission, organization.id);
    }
    const terminalProof = FINANCIAL_TERMINAL_ACTIONS.has(action)
      ? await operationalTerminalProof(db, context, request)
      : null;
    if (action === "promotion.quote")
      return quotePromotion(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "session.open")
      return openSession(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "access.update")
      return updateRegisterAccess(db, context, body);
    if (action === "cash.event")
      return cashEvent(db, context, body, requiredTerminalProof(terminalProof));
    if (action === "session.close")
      return closeSession(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "cart.draft.save")
      return saveRecoveryDraft(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "cart.draft.discard")
      return discardRecoveryDraft(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "cart.hold")
      return holdCart(db, context, body, requiredTerminalProof(terminalProof));
    if (action === "cart.discard")
      return discardCart(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "order.claim")
      return claimPosOrder(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "order.claim.recover")
      return recoverPosOrderClaim(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "order.claim.renew")
      return renewPosOrderClaim(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "order.claim.release")
      return releasePosOrderClaim(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "sale.commit")
      return commitSale(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "sale.cancel")
      return cancelSale(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    if (action === "return.create")
      return createReturn(
        db,
        context,
        body,
        requiredTerminalProof(terminalProof),
      );
    throw new PosDomainError("Ação de PDV inválida.");
  } catch (error) {
    return failure(error);
  }
}

const FINANCIAL_TERMINAL_ACTIONS = new Set([
  "promotion.quote",
  "session.open",
  "cash.event",
  "session.close",
  "cart.draft.save",
  "cart.draft.discard",
  "cart.hold",
  "cart.discard",
  "order.claim",
  "order.claim.recover",
  "order.claim.renew",
  "order.claim.release",
  "sale.commit",
  "sale.cancel",
  "return.create",
]);

async function operationalTerminalProof(
  db: Db,
  context: Access,
  request: Request,
) {
  const credential = readPosOperationalTerminalCredential(request.headers);
  const terminal = await db.posTerminal.findUnique({
    where: { id: credential.terminalId },
    select: posOperationalTerminalSelect,
  });
  if (credential.token.startsWith("posoff_v1_")) {
    const parsed = parsePosOfflineToken(credential.token);
    const offline = await db.posOfflineCredential.findFirst({
      where: {
        id: parsed.id,
        terminalId: credential.terminalId,
        userProfileId: context.profile.id,
        userId: context.permission.user.id,
        state: "active",
        expiresAt: { gt: new Date() },
        credentialVersion: terminal?.credentialVersion,
      },
    });
    if (
      !terminal ||
      !offline ||
      !verifyPosOfflineCredential(
        offline.tokenHash,
        context.organizationId,
        terminal.id,
        offline.id,
        credential.token,
      )
    ) {
      throw new PosTerminalBoundaryError(
        "A ativação deste terminal expirou ou foi revogada. Ative-o novamente.",
        401,
      );
    }
    if (!terminal.tokenHash)
      throw new PosTerminalBoundaryError(
        "O terminal ainda não possui identidade operacional pareada.",
        409,
      );
    const proof: PosOperationalTerminalProof = {
      terminalId: terminal.id,
      registerId: terminal.registerId,
      branchId: terminal.register.branchId,
      tokenHash: terminal.tokenHash,
      credentialVersion: terminal.credentialVersion,
      authenticatedAt: new Date(),
    };
    assertPosOperationalTerminalProof(terminal, proof, {
      expectedBranchId: context.branch.id,
      expectedRegisterId: terminal.registerId,
    });
    return {
      ...proof,
      offlineCredentialId: offline.id,
      offlineCredentialHash: offline.tokenHash,
    };
  }
  return authenticatePosOperationalTerminal(terminal, {
    organizationId: context.organizationId,
    ...credential,
    expectedBranchId: context.branch.id,
  });
}

function requiredTerminalProof(proof: PosOperationalTerminalProof | null) {
  if (!proof)
    throw new PosTerminalBoundaryError(
      "A operação financeira exige identidade criptográfica do terminal.",
      401,
    );
  return proof;
}

async function assertLiveTerminalProof(
  tx: Prisma.TransactionClient,
  context: Access,
  proof: PosOperationalTerminalProof,
  registerId: number,
) {
  const terminal = await tx.posTerminal.findUnique({
    where: { id: proof.terminalId },
    select: posOperationalTerminalSelect,
  });
  assertPosOperationalTerminalProof(terminal, proof, {
    expectedBranchId: context.branch.id,
    expectedRegisterId: registerId,
  });
  const browserProof = proof as PosOperationalTerminalProof & {
    offlineCredentialId?: string;
    offlineCredentialHash?: string;
  };
  if (browserProof.offlineCredentialId) {
    const credential = await tx.posOfflineCredential.findFirst({
      where: {
        id: browserProof.offlineCredentialId,
        terminalId: proof.terminalId,
        userProfileId: context.profile.id,
        userId: context.permission.user.id,
        tokenHash: browserProof.offlineCredentialHash,
        credentialVersion: terminal?.credentialVersion,
        state: "active",
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!credential)
      throw new PosTerminalBoundaryError(
        "A ativação deste terminal não está mais vigente.",
        401,
      );
  }
}

async function assertStoredSessionTerminalBinding(
  db: Db,
  sessionId: number,
  proof: PosOperationalTerminalProof,
) {
  const session = await db.cashRegisterSession.findUnique({
    where: { id: sessionId },
    select: {
      registerId: true,
      openingAmountCents: true,
      openRequestHash: true,
    },
  });
  if (!session)
    throw new PosTerminalBoundaryError(
      "O turno vinculado ao terminal não foi encontrado.",
      404,
    );
  assertPosSessionTerminalBinding(session, proof);
}

async function posContext(
  db: Db,
  permission: Awaited<ReturnType<typeof assertTenantPermission>>,
  organizationId: string,
) {
  const profile = await db.tenantUserProfile.findUnique({
    where: { userId: permission.user.id },
    include: { activeBranch: true },
  });
  if (!profile || profile.status !== "active")
    throw new PosDomainError(
      "Perfil operacional ativo não configurado. Sincronize o usuário na gestão de equipe.",
    );
  let branch =
    profile.activeBranch?.status === "active" ? profile.activeBranch : null;
  if (!branch) {
    branch = await db.branch.findFirst({
      where: { status: "active" },
      orderBy: [{ primary: "desc" }, { id: "asc" }],
    });
    if (!branch)
      throw new PosDomainError(
        "Cadastre uma filial ativa antes de usar o PDV.",
      );
  }
  const privileged = ["owner", "admin"].includes(permission.membership.role);
  const branchAccess = await db.branchUserAccess.findUnique({
    where: {
      branchId_userProfileId: {
        branchId: branch.id,
        userProfileId: profile.id,
      },
    },
  });
  if (!privileged && !branchAccess?.canSell)
    throw new PosDomainError(
      "Seu usuário não está autorizado a vender nesta filial.",
    );
  const now = new Date();
  const accessWhere = {
    userProfileId: profile.id,
    active: true,
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
      { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
    ],
  };
  const terminalSelect = {
    id: true,
    code: true,
    name: true,
    status: true,
    appVersion: true,
    lastSeenAt: true,
    offlineAllowedUntil: true,
    pairedAt: true,
    devices: {
      select: {
        id: true,
        type: true,
        name: true,
        provider: true,
        status: true,
        capabilities: true,
        lastError: true,
        lastSeenAt: true,
      },
    },
  } as const;
  let registers = await db.posRegister.findMany({
    where: { branchId: branch.id, status: "active" },
    include: {
      accesses: { where: accessWhere },
      terminals: {
        where: { status: { not: "revoked" } },
        select: terminalSelect,
      },
    },
    orderBy: { name: "asc" },
  });
  if (privileged) {
    registers = registers.map((register) =>
      register.accesses.length
        ? register
        : {
            ...register,
            accesses: [
              {
                id: 0,
                registerId: register.id,
                userProfileId: profile.id,
                active: true,
                canOpen: true,
                canClose: true,
                canSell: true,
                canSupply: true,
                canWithdraw: true,
                canCancel: true,
                canRefund: true,
                canReprint: true,
                canManualPayment: true,
                canReviewManualPayment: false,
                manualPaymentReviewLimitCents: 0,
                canTransferHeld: true,
                maxDiscountBasisPoints: 10_000,
                validFrom: null,
                validUntil: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
    );
  }
  const authorized = registers.filter(
    (register) => register.accesses.length > 0,
  );
  return {
    organizationId,
    permission,
    profile,
    branch,
    branchAccess,
    privileged,
    registers: authorized,
  };
}

async function materializePrivilegedPosAccess(db: Db, context: Access) {
  if (!context.privileged) return;
  const registerIds = context.registers.map((register) => register.id);
  const [branchAccess, registerAccesses] = await Promise.all([
    db.branchUserAccess.findUnique({
      where: {
        branchId_userProfileId: {
          branchId: context.branch.id,
          userProfileId: context.profile.id,
        },
      },
      select: { canSell: true },
    }),
    db.posRegisterAccess.findMany({
      where: {
        registerId: { in: registerIds },
        userProfileId: context.profile.id,
      },
      select: {
        registerId: true,
        active: true,
        canOpen: true,
        canClose: true,
        canSell: true,
        canSupply: true,
        canWithdraw: true,
        canCancel: true,
        canRefund: true,
        canReprint: true,
        canManualPayment: true,
        canTransferHeld: true,
        maxDiscountBasisPoints: true,
        validFrom: true,
        validUntil: true,
      },
    }),
  ]);
  const byRegister = new Map(
    registerAccesses.map((access) => [access.registerId, access]),
  );
  const staleRegisters = registerIds.filter((registerId) => {
    const access = byRegister.get(registerId);
    return (
      !access ||
      !access.active ||
      !access.canOpen ||
      !access.canClose ||
      !access.canSell ||
      !access.canSupply ||
      !access.canWithdraw ||
      !access.canCancel ||
      !access.canRefund ||
      !access.canReprint ||
      !access.canManualPayment ||
      !access.canTransferHeld ||
      access.maxDiscountBasisPoints !== 10_000 ||
      access.validFrom ||
      access.validUntil
    );
  });
  if (branchAccess?.canSell && !staleRegisters.length) return;
  await db.$transaction(
    async (tx) => {
      await tx.branchUserAccess.upsert({
        where: {
          branchId_userProfileId: {
            branchId: context.branch.id,
            userProfileId: context.profile.id,
          },
        },
        create: {
          branchId: context.branch.id,
          userProfileId: context.profile.id,
          canSell: true,
          primary: true,
        },
        update: { canSell: true },
      });
      for (const registerId of staleRegisters) {
        await tx.posRegisterAccess.upsert({
          where: {
            registerId_userProfileId: {
              registerId,
              userProfileId: context.profile.id,
            },
          },
          create: {
            registerId,
            userProfileId: context.profile.id,
            active: true,
            canOpen: true,
            canClose: true,
            canSell: true,
            canSupply: true,
            canWithdraw: true,
            canCancel: true,
            canRefund: true,
            canReprint: true,
            canManualPayment: true,
            canTransferHeld: true,
            maxDiscountBasisPoints: 10_000,
          },
          update: {
            active: true,
            canOpen: true,
            canClose: true,
            canSell: true,
            canSupply: true,
            canWithdraw: true,
            canCancel: true,
            canRefund: true,
            canReprint: true,
            canManualPayment: true,
            canTransferHeld: true,
            maxDiscountBasisPoints: 10_000,
            validFrom: null,
            validUntil: null,
          },
        });
      }
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.permission.user.id,
          action: "pos.access.privileged.materialized",
          entityType: "tenant_user_profile",
          entityId: String(context.profile.id),
          afterData: {
            branchId: context.branch.id,
            registerIds: staleRegisters,
            role: context.permission.membership.role,
          },
        },
      });
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 },
  );
}

async function bootstrap(db: Db, context: Access, query = "") {
  const registerIds = context.registers.map((item) => item.id);
  const session = registerIds.length
    ? await db.cashRegisterSession.findFirst({
        where: {
          registerId: { in: registerIds },
          operatorProfileId: context.profile.id,
          status: { in: ["open", "suspended"] },
        },
        include: {
          register: true,
          events: { orderBy: { createdAt: "desc" }, take: 30 },
          paymentCounts: true,
        },
        orderBy: { openedAt: "desc" },
      })
    : null;
  const warehouseId =
    session?.register?.warehouseId ||
    context.registers[0]?.warehouseId ||
    context.branch.defaultWarehouseId;
  const productWhere = {
    active: true,
    branchConfigurations: {
      some: { branchId: context.branch.id, active: true, saleEnabled: true },
    },
    ...(query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" as const } },
            { sku: { contains: query, mode: "insensitive" as const } },
            { barcode: query },
            { gtin: query },
            {
              variations: {
                some: { OR: [{ sku: query }, { gtin: query }], enabled: true },
              },
            },
          ],
        }
      : {}),
  };
  const [
    products,
    customers,
    settings,
    heldSales,
    recentSales,
    connectors,
    staffAccess,
  ] = await Promise.all([
    db.product.findMany({
      where: productWhere,
      select: {
        id: true,
        name: true,
        sku: true,
        barcode: true,
        gtin: true,
        type: true,
        unit: true,
        manageStock: true,
        soldIndividually: true,
        minimumSalePrice: true,
        price: true,
        cashPrice: true,
        salePrice: true,
        saleStartsAt: true,
        saleEndsAt: true,
        branchConfigurations: {
          where: { branchId: context.branch.id },
          select: { priceOverride: true, preferredWarehouseId: true },
        },
        warehouseBalances: {
          where: warehouseId ? { warehouseId } : { warehouseId: -1 },
          select: { quantity: true, reservedQuantity: true },
        },
        variations: {
          where: { enabled: true },
          select: {
            id: true,
            sku: true,
            gtin: true,
            regularPrice: true,
            salePrice: true,
            saleStartsAt: true,
            saleEndsAt: true,
            manageStock: true,
            stock: true,
            attributes: true,
            warehouseBalances: {
              where: warehouseId ? { warehouseId } : { warehouseId: -1 },
              select: { quantity: true, reservedQuantity: true },
            },
          },
        },
      },
      orderBy: [{ totalSales: "desc" }, { name: "asc" }],
      take: query ? 100 : 250,
    }),
    db.customer.findMany({
      where: { status: "active" },
      select: { id: true, name: true, tradeName: true, document: true },
      orderBy: { name: "asc" },
      take: 100,
    }),
    db.tenantSettings.findUnique({
      where: { id: 1 },
      select: {
        defaultPaymentMethod: true,
        defaultCustomerName: true,
        requireCustomer: true,
        allowNegativeStock: true,
        maxDiscountPercent: true,
        receiptFooter: true,
        currency: true,
        locale: true,
      },
    }),
    session
      ? db.posHeldSale.findMany({
          where: { sessionId: session.id, status: "held" },
          include: {
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    name: true,
                    sku: true,
                    barcode: true,
                    gtin: true,
                    type: true,
                    unit: true,
                    soldIndividually: true,
                  },
                },
              },
            },
            customer: { select: { id: true, name: true } },
          },
          orderBy: { updatedAt: "desc" },
        })
      : [],
    session
      ? db.sale.findMany({
          where: { sessionId: session.id },
          select: {
            id: true,
            saleNumber: true,
            customer: true,
            seller: true,
            status: true,
            totalCents: true,
            changeCents: true,
            createdAt: true,
            payments: {
              select: {
                id: true,
                type: true,
                method: true,
                status: true,
                amountCents: true,
                tenderedCents: true,
                changeCents: true,
                provider: true,
                transactionId: true,
                nsu: true,
              },
            },
            items: {
              select: {
                id: true,
                productName: true,
                quantity: true,
                returnedQuantity: true,
                returnedCents: true,
                unitPriceCents: true,
                discountCents: true,
                totalCents: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [],
    db.posConnector.findMany({
      where: {
        branchId: context.branch.id,
        status: "active",
        OR: [
          { registerId: null },
          { registerId: { in: registerIds.length ? registerIds : [-1] } },
        ],
      },
      select: {
        id: true,
        registerId: true,
        type: true,
        provider: true,
        mode: true,
        settings: true,
        status: true,
        lastHealthOk: true,
      },
    }),
    context.privileged
      ? db.tenantUserProfile.findMany({
          where: {
            status: "active",
            branchAccesses: { some: { branchId: context.branch.id } },
          },
          select: {
            id: true,
            displayName: true,
            email: true,
            role: { select: { key: true, name: true } },
            posRegisterAccesses: {
              where: { register: { branchId: context.branch.id } },
              select: {
                registerId: true,
                active: true,
                canOpen: true,
                canClose: true,
                canSell: true,
                canSupply: true,
                canWithdraw: true,
                canCancel: true,
                canRefund: true,
                canReprint: true,
                canManualPayment: true,
                canTransferHeld: true,
                maxDiscountBasisPoints: true,
                validFrom: true,
                validUntil: true,
              },
            },
          },
          orderBy: { displayName: "asc" },
        })
      : null,
  ]);
  if (!settings) throw new PosDomainError(POS_SETTINGS_REQUIRED);
  const sessionTenders = session
    ? await db.posSalePayment.findMany({
        where: {
          processingSessionId: session.id,
          method: { not: "store_credit" },
          type: { in: ["payment", "refund"] },
        },
        select: { method: true, provider: true },
        distinct: ["method", "provider"],
      })
    : [];
  const productPresentation = new Map(
    (
      await db.product.findMany({
        where: { id: { in: products.map((product) => product.id) } },
        select: {
          id: true,
          category: true,
          imageMediaId: true,
          gallery: {
            orderBy: { position: "asc" },
            take: 1,
            select: { mediaAssetId: true },
          },
          variations: {
            where: { enabled: true },
            select: {
              id: true,
              imageMediaId: true,
              gallery: {
                orderBy: { position: "asc" },
                take: 1,
                select: { mediaAssetId: true },
              },
            },
          },
        },
      })
    ).map((product) => [product.id, product]),
  );
  const closingTenders = [
    { method: "cash", provider: "" },
    ...sessionTenders.map((item) => ({
      method: item.method,
      provider: item.method === "cash" ? "" : item.provider || "",
    })),
  ].filter(
    (item, index, values) =>
      values.findIndex(
        (candidate) =>
          paymentKey(candidate.method, candidate.provider) ===
          paymentKey(item.method, item.provider),
      ) === index,
  );
  return {
    branch: {
      id: context.branch.id,
      code: context.branch.code,
      name: context.branch.name,
      timezone: context.branch.timezone,
    },
    operator: { id: context.profile.id, name: context.profile.displayName },
    registers: context.registers.map(
      ({ accesses, terminals, ...register }) => ({
        ...register,
        access: accesses[0],
        terminals,
      }),
    ),
    session: jsonSafe(session),
    products: products.map((product) => {
      const presentation = productPresentation.get(product.id);
      const configuration = product.branchConfigurations[0];
      const balance = product.warehouseBalances[0];
      const now = Date.now();
      const promotional =
        product.salePrice != null &&
        (!product.saleStartsAt || product.saleStartsAt.valueOf() <= now) &&
        (!product.saleEndsAt || product.saleEndsAt.valueOf() >= now);
      return {
        ...product,
        category: presentation?.category || "Sem categoria",
        imageUrl: posProductImageUrl(presentation),
        branchConfigurations: undefined,
        warehouseBalances: undefined,
        priceCents: Math.round(
          (configuration?.priceOverride ??
            (promotional ? product.salePrice! : product.price)) * 100,
        ),
        stock: posAvailableStock(product, balance),
        variations: product.variations.map(variation => ({
          ...variation,
          warehouseBalances: undefined,
          stock: posAvailableStock(product, balance, variation),
          priceCents: Math.round(currentVariationPrice(variation, configuration?.priceOverride ?? currentPrice(product)) * 100),
        })),
      };
    }),
    customers: customers.map(publicPosCustomer),
    settings,
    heldSales,
    recentSales,
    connectors,
    staffAccess,
    closingTenders,
  };
}

async function paginatedPosCatalog(
  db: Db,
  context: Access,
  params: URLSearchParams,
) {
  const request = parsePosCatalogPageRequest(params);
  if (request.resource === "sales") {
    const session = await db.cashRegisterSession.findFirst({
      where: { registerId: { in: context.registers.map(register => register.id) }, operatorProfileId: context.profile.id, status: { in: ["open", "suspended"] } },
      orderBy: { openedAt: "desc" },
      select: { id: true },
    });
    const where: Prisma.SaleWhereInput = {
      sessionId: session?.id ?? -1,
      ...(request.query ? { OR: [
        { saleNumber: { contains: request.query, mode: "insensitive" } },
        { customer: { contains: request.query, mode: "insensitive" } },
      ] } : {}),
    };
    if (request.cursorId && !await db.sale.findFirst({ where: { ...where, id: request.cursorId }, select: { id: true } }))
      throw new PosCatalogPaginationError("O cursor de vendas expirou ou não pertence a este caixa e consulta.");
    const rows = await db.sale.findMany({
      where,
      select: {
        id: true, saleNumber: true, customer: true, status: true, totalCents: true, changeCents: true, createdAt: true,
        payments: { select: { id: true, type: true, method: true, status: true, amountCents: true } },
        items: { select: { id: true, productName: true, quantity: true, returnedQuantity: true, returnedCents: true, unitPriceCents: true, discountCents: true, totalCents: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: request.limit + 1,
      ...(request.cursorId ? { cursor: { id: request.cursorId }, skip: 1 } : {}),
    });
    return Response.json(buildPosCatalogPage(request, rows), { headers: { "cache-control": "no-store" } });
  }
  if (request.resource === "customers") {
    const documentQuery = request.query.replace(/\D/g, "");
    const where: Prisma.CustomerWhereInput = {
      status: "active",
      ...(request.query
        ? {
            OR: [
              { name: { contains: request.query, mode: "insensitive" } },
              { tradeName: { contains: request.query, mode: "insensitive" } },
              ...(documentQuery.length === 4
                ? [{ document: { endsWith: documentQuery } }]
                : []),
            ],
          }
        : {}),
    };
    if (
      request.cursorId &&
      !(await db.customer.findFirst({
        where: { ...where, id: request.cursorId },
        select: { id: true },
      }))
    )
      throw new PosCatalogPaginationError(
        "O cursor de clientes expirou ou não pertence a esta consulta.",
      );
    const rows = await db.customer.findMany({
      where,
      select: { id: true, name: true, tradeName: true, document: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: request.limit + 1,
      ...(request.cursorId
        ? { cursor: { id: request.cursorId }, skip: 1 }
        : {}),
    });
    const page = buildPosCatalogPage(request, rows);
    return Response.json(
      { ...page, items: page.items.map(publicPosCustomer) },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const session = context.registers.length
    ? await db.cashRegisterSession.findFirst({
        where: {
          registerId: { in: context.registers.map((item) => item.id) },
          operatorProfileId: context.profile.id,
          status: { in: ["open", "suspended"] },
        },
        select: { register: { select: { warehouseId: true } } },
        orderBy: { openedAt: "desc" },
      })
    : null;
  const warehouseId =
    session?.register?.warehouseId ||
    context.registers[0]?.warehouseId ||
    context.branch.defaultWarehouseId;
  const where: Prisma.ProductWhereInput = {
    active: true,
    branchConfigurations: {
      some: { branchId: context.branch.id, active: true, saleEnabled: true },
    },
    ...(request.query
      ? {
          OR: [
            { name: { contains: request.query, mode: "insensitive" } },
            { sku: { contains: request.query, mode: "insensitive" } },
            { barcode: { contains: request.query } },
            { gtin: { contains: request.query } },
            {
              variations: {
                some: {
                  enabled: true,
                  OR: [
                    { sku: { contains: request.query, mode: "insensitive" } },
                    { gtin: { contains: request.query } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };
  if (
    request.cursorId &&
    !(await db.product.findFirst({
      where: { ...where, id: request.cursorId },
      select: { id: true },
    }))
  )
    throw new PosCatalogPaginationError(
      "O cursor de produtos expirou ou não pertence a esta consulta.",
    );
  const rows = await db.product.findMany({
    where,
    select: {
      id: true,
      name: true,
      sku: true,
      barcode: true,
      gtin: true,
      type: true,
      unit: true,
      manageStock: true,
      soldIndividually: true,
      minimumSalePrice: true,
      price: true,
      cashPrice: true,
      salePrice: true,
      saleStartsAt: true,
      saleEndsAt: true,
      branchConfigurations: {
        where: { branchId: context.branch.id },
        select: { priceOverride: true, preferredWarehouseId: true },
      },
      warehouseBalances: {
        where: warehouseId ? { warehouseId } : { warehouseId: -1 },
        select: { quantity: true, reservedQuantity: true },
      },
      variations: {
        where: { enabled: true },
        select: {
          id: true,
          sku: true,
          gtin: true,
          regularPrice: true,
          salePrice: true,
          saleStartsAt: true,
          saleEndsAt: true,
          manageStock: true,
          stock: true,
          attributes: true,
          warehouseBalances: {
            where: warehouseId ? { warehouseId } : { warehouseId: -1 },
            select: { quantity: true, reservedQuantity: true },
          },
        },
      },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: request.limit + 1,
    ...(request.cursorId ? { cursor: { id: request.cursorId }, skip: 1 } : {}),
  });
  const page = buildPosCatalogPage(request, rows);
  const productPresentation = new Map(
    (
      await db.product.findMany({
        where: { id: { in: page.items.map((product) => product.id) } },
        select: {
          id: true,
          category: true,
          imageMediaId: true,
          gallery: {
            orderBy: { position: "asc" },
            take: 1,
            select: { mediaAssetId: true },
          },
          variations: {
            where: { enabled: true },
            select: {
              id: true,
              imageMediaId: true,
              gallery: {
                orderBy: { position: "asc" },
                take: 1,
                select: { mediaAssetId: true },
              },
            },
          },
        },
      })
    ).map((product) => [product.id, product]),
  );
  const items = page.items.map((product) => {
    const configuration = product.branchConfigurations[0];
    const balance = product.warehouseBalances[0];
    const presentation = productPresentation.get(product.id);
    return {
      ...product,
      branchConfigurations: undefined,
      warehouseBalances: undefined,
      category: presentation?.category || "Sem categoria",
      imageUrl: posProductImageUrl(presentation),
      priceCents: Math.round(
        (configuration?.priceOverride ?? currentPrice(product)) * 100,
      ),
      stock: posAvailableStock(product, balance),
      variations: product.variations.map(variation => ({
        ...variation,
        warehouseBalances: undefined,
        stock: posAvailableStock(product, balance, variation),
        priceCents: Math.round(currentVariationPrice(variation, configuration?.priceOverride ?? currentPrice(product)) * 100),
      })),
    };
  });
  return Response.json(
    { ...page, items },
    { headers: { "cache-control": "no-store" } },
  );
}

const posOrderInclude = {
  customer: {
    select: {
      id: true,
      name: true,
      tradeName: true,
      document: true,
      phone: true,
    },
  },
  items: {
    include: {
      product: {
        select: { id: true, name: true, type: true, manageStock: true },
      },
    },
    orderBy: { id: "asc" as const },
  },
  payments: {
    select: {
      status: true,
      paidAt: true,
      transactionId: true,
      paymentUrl: true,
    },
  },
  shipments: { select: { id: true, status: true } },
  tracking: { select: { id: true, status: true } },
  shippingLabels: { select: { id: true, status: true } },
  stockReservations: {
    where: { status: "active" },
    orderBy: { id: "asc" as const },
  },
} as const;

type PosClaimableOrder = Prisma.SalesOrderGetPayload<{
  include: typeof posOrderInclude;
}>;

async function lookupPosOrder(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
) {
  const qrToken = optionalString(body.qrToken, 2_048),
    directLookup = optionalString(body.lookup, 120);
  if (Boolean(qrToken) === Boolean(directLookup))
    throw new PosOrderClaimError(
      "Informe o ID/número ou um QR interno assinado do pedido.",
      422,
    );
  const signedOrderId = qrToken
    ? await db.$transaction((tx) =>
        resolveInternalQrEntity(tx, context, qrToken, "order"),
      )
    : null;
  const lookup = signedOrderId || directLookup!;
  const numericId = /^\d+$/.test(lookup) ? Number(lookup) : null;
  const order = await db.salesOrder.findFirst({
    where: {
      branchId: context.branch.id,
      OR: [
        ...(numericId && Number.isSafeInteger(numericId) && numericId > 0
          ? [{ id: numericId }]
          : []),
        { number: { equals: lookup, mode: "insensitive" } },
      ],
    },
    include: posOrderInclude,
  });
  if (!order)
    throw new PosOrderClaimError("Pedido não encontrado nesta filial.", 404);
  const [sourceSale, activeClaim, products] = await Promise.all([
    db.sale.findUnique({
      where: {
        sourceType_sourceId: {
          sourceType: "sales_order",
          sourceId: String(order.id),
        },
      },
      select: {
        id: true,
        saleNumber: true,
        status: true,
        totalCents: true,
        createdAt: true,
      },
    }),
    db.posOrderClaim.findFirst({
      where: { salesOrderId: order.id, state: "active" },
      select: {
        id: true,
        terminalId: true,
        sessionId: true,
        operatorProfileId: true,
        version: true,
        leaseExpiresAt: true,
        state: true,
      },
    }),
    Promise.all(
      order.items.map((item) =>
        sellableProduct(db, context, item.productId, item.variationId),
      ),
    ),
  ]);
  const eligibility = sourceSale
    ? {
        eligible: false as const,
        code: "converted",
        reason: "O pedido já foi convertido em venda.",
      }
    : evaluatePosOrderEligibility(order, context.branch.id);
  const unavailableItem = products.findIndex((product) => !product);
  const effectiveEligibility =
    eligibility.eligible && unavailableItem >= 0
      ? {
          eligible: false as const,
          code: "unavailable_item",
          reason: `${order.items[unavailableItem].product.name} não está disponível para venda nesta filial.`,
        }
      : eligibility;
  return Response.json(
    {
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        customer: order.customer ? publicPosCustomer(order.customer) : null,
        customerId: order.customerId,
        customerName: order.customerName,
        subtotalCents: Math.round(order.subtotal * 100),
        discountCents: Math.round(order.discount * 100),
        totalCents: Math.round(order.total * 100),
        paymentMethod: posOrderPaymentMethod(order.paymentMethod),
        paymentInstallments: order.paymentInstallments,
        notes: order.notes,
        items: order.items.map((item, index) => ({
          id: item.id,
          productId: item.productId,
          variationId: item.variationId,
          quantity: item.quantity,
          listPriceCents: Math.round(item.listPrice * 100),
          unitPriceCents: Math.round(item.unitPrice * 100),
          discountCents: Math.round(item.discount * 100),
          totalCents: Math.round(item.total * 100),
          product: products[index],
        })),
      },
      eligibility: effectiveEligibility,
      activeClaim: activeClaim
        ? {
            busy: activeClaim.leaseExpiresAt > new Date(),
            leaseExpiresAt: activeClaim.leaseExpiresAt,
          }
        : null,
      convertedSale: sourceSale,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function claimPosOrder(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const session = await ownedBoundOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  if (!register.access.canSell)
    throw new PosOrderClaimError(
      "Você não pode reivindicar pedidos neste caixa.",
      403,
    );
  const orderId = positiveInt(body.orderId, "Pedido"),
    idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 120);
  const requestHash = hashPosOrderClaimRequest({
    action: "order.claim",
    orderId,
    sessionId: session.id,
    registerId: register.id,
    operatorProfileId: context.profile.id,
    terminalId: terminalProof.terminalId,
  });
  const replay = await db.posOrderClaim.findUnique({
    where: { idempotencyKey },
  });
  if (replay)
    return replayClaimCreation(replay, requestHash, {
      orderId,
      sessionId: session.id,
      registerId: register.id,
      operatorProfileId: context.profile.id,
      terminalId: terminalProof.terminalId,
    });
  // Stable across every retry of this logical claim creation.
  const claimId = randomUUID();
  try {
    const claim = await serializablePosOrderClaimRetry(db, async (tx) => {
      // Read-only locator: identities are used only to pre-acquire every
      // advisory namespace and are reread after the order root is locked.
      const activeClaimLocators = await tx.posOrderClaim.findMany({
        where: { salesOrderId: orderId, state: "active" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      await prelockPosOrderClaimWrite(tx, {
        action: "expire_and_create",
        branchId: context.branch.id,
        registerId: register.id,
        sessionId: session.id,
        sessionVersion: session.version,
        operatorProfileId: context.profile.id,
        terminalProof,
        salesOrderId: orderId,
        idempotencyKey,
        newClaimId: claimId,
        locatedActiveClaimIds: activeClaimLocators.map((claim) => claim.id),
      });
      const order = await tx.salesOrder.findFirst({
        where: { id: orderId, branchId: context.branch.id },
        include: posOrderInclude,
      });
      if (!order)
        throw new PosOrderClaimError(
          "Pedido não encontrado nesta filial.",
          404,
        );
      const sourceSale = await tx.sale.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: "sales_order",
            sourceId: String(order.id),
          },
        },
        select: { id: true },
      });
      if (sourceSale)
        throw new PosOrderClaimError("O pedido já foi convertido em venda.");
      assertPosOrderEligible(order, context.branch.id);
      const now = new Date();
      const active = await tx.posOrderClaim.findFirst({
        where: { salesOrderId: order.id, state: "active" },
      });
      if (active && active.leaseExpiresAt > now)
        throw new PosOrderClaimError(
          `O pedido está em uso em outro terminal até ${active.leaseExpiresAt.toISOString()}.`,
        );
      if (active) {
        const blockers = await unresolvedPosOrderClaimArtifacts(tx, active);
        if (blockers.paymentIntents || blockers.manualReferences)
          throw new PosOrderClaimError(
            "A posse expirada ainda possui intenção eletrônica ou referência manual sem resolução. Reconcilie o draft antigo antes de reivindicar novamente.",
          );
        const expired = await tx.posOrderClaim.updateMany({
          where: {
            id: active.id,
            state: "active",
            version: active.version,
            leaseExpiresAt: { lte: now },
          },
          data: {
            state: "expired",
            releasedAt: now,
            version: { increment: 1 },
          },
        });
        if (expired.count !== 1)
          throw new PosOrderClaimError(
            "A posse anterior do pedido mudou durante a expiração.",
          );
        const expireHash = hashPosOrderClaimRequest({
          action: "order.claim.expire",
          claimId: active.id,
          expectedVersion: active.version,
          leaseExpiresAt: active.leaseExpiresAt.toISOString(),
        });
        await tx.posOrderClaimOperation.create({
          data: {
            claimId: active.id,
            action: "expire",
            expectedVersion: active.version,
            resultingVersion: active.version + 1,
            resultingState: "expired",
            idempotencyKey: `${active.id}:expire:${active.version}`,
            requestHash: expireHash,
            leaseExpiresAt: active.leaseExpiresAt,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: "pos.order.claim.expired",
            entityType: "pos_order_claim",
            entityId: active.id,
            beforeData: {
              state: "active",
              version: active.version,
              leaseExpiresAt: active.leaseExpiresAt.toISOString(),
            },
            afterData: {
              state: "expired",
              version: active.version + 1,
              releasedAt: now.toISOString(),
              supersededByClaimIdempotencyKey: idempotencyKey,
            },
          },
        });
      }
      const leaseExpiresAt = posOrderClaimLease(now);
      const created = await tx.posOrderClaim.create({
        data: {
          id: claimId,
          salesOrderId: order.id,
          branchId: context.branch.id,
          registerId: register.id,
          sessionId: session.id,
          operatorProfileId: context.profile.id,
          terminalId: terminalProof.terminalId,
          leaseExpiresAt,
          idempotencyKey,
          requestHash,
        },
      });
      await tx.posOrderClaimOperation.create({
        data: {
          claimId: created.id,
          action: "claim",
          expectedVersion: 0,
          resultingVersion: 0,
          resultingState: "active",
          idempotencyKey: `${idempotencyKey}:claim`,
          requestHash,
          leaseExpiresAt,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.permission.user.id,
          action: "pos.order.claimed",
          entityType: "pos_order_claim",
          entityId: created.id,
          beforeData: { salesOrderId: order.id, status: order.status },
          afterData: {
            salesOrderId: order.id,
            branchId: context.branch.id,
            registerId: register.id,
            sessionId: session.id,
            operatorProfileId: context.profile.id,
            terminalId: terminalProof.terminalId,
            version: 0,
            leaseExpiresAt: leaseExpiresAt.toISOString(),
          },
        },
      });
      return created;
    });
    return Response.json(
      { claim: publicOrderClaim(claim), replayed: false },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (
      ["P2002", "P2034"].includes(
        String((error as { code?: string })?.code || ""),
      )
    ) {
      const concurrent = await db.posOrderClaim.findUnique({
        where: { idempotencyKey },
      });
      if (concurrent)
        return replayClaimCreation(concurrent, requestHash, {
          orderId,
          sessionId: session.id,
          registerId: register.id,
          operatorProfileId: context.profile.id,
          terminalId: terminalProof.terminalId,
        });
      throw new PosOrderClaimError(
        "O pedido foi reivindicado por outro terminal. Consulte-o novamente.",
      );
    }
    throw error;
  }
}

async function renewPosOrderClaim(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  return mutatePosOrderClaim(db, context, body, terminalProof, "renew");
}

async function recoverPosOrderClaim(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const session = await ownedBoundOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
    terminalProof,
  );
  const register = accessFor(context, session.registerId!),
    claimId = string(body.claimId, "Posse do pedido", 120);
  const locator = await locatePosOrderClaimSalesOrder(db, claimId);
  if (!locator)
    return Response.json(
      { claim: null },
      { headers: { "cache-control": "no-store" } },
    );
  const claim = await serializablePosOrderClaimRetry(db, async (tx) => {
    await prelockPosOrderClaimWrite(tx, {
      action: "recover",
      branchId: context.branch.id,
      registerId: register.id,
      sessionId: session.id,
      sessionVersion: session.version,
      operatorProfileId: context.profile.id,
      terminalProof,
      salesOrderId: locator.salesOrderId,
      claimId,
    });
    let current = await tx.posOrderClaim.findUnique({
      where: { id: claimId },
      include: {
        salesOrder: {
          include: {
            items: { orderBy: { id: "asc" } },
            payments: {
              select: {
                status: true,
                paidAt: true,
                transactionId: true,
                paymentUrl: true,
              },
            },
            shipments: { select: { id: true, status: true } },
            tracking: { select: { id: true, status: true } },
            shippingLabels: { select: { id: true, status: true } },
          },
        },
      },
    });
    if (!current) return null;
    assertPosOrderClaimContext(current, {
      version: current.version,
      branchId: context.branch.id,
      registerId: register.id,
      sessionId: session.id,
      operatorProfileId: context.profile.id,
      terminalId: terminalProof.terminalId,
      allowExpired: true,
    });
    if (current.leaseExpiresAt <= new Date()) {
      const draft = await tx.posHeldSale.findFirst({
        where: {
          id: claimId,
          sessionId: session.id,
          registerId: register.id,
          operatorProfileId: context.profile.id,
          status: "draft",
        },
        include: { items: true },
      });
      const [intents, manualReferences] = await Promise.all([
        tx.posPaymentIntent.findMany({
          where: {
            saleDraftId: claimId,
            sessionId: session.id,
            registerId: register.id,
            operatorProfileId: context.profile.id,
            consumedAt: null,
            status: { in: [...POS_DRAFT_RECOVERY_INTENT_STATES] },
          },
        }),
        tx.posManualPaymentReference.findMany({
          where: {
            saleDraftId: claimId,
            sessionId: session.id,
            registerId: register.id,
            requesterProfileId: context.profile.id,
            consumedSalePaymentId: null,
            status: "pending",
          },
          include: { approval: true },
        }),
      ]);
      if (
        intents.some((intent) => intent.status !== "captured") ||
        intents.length > 1 ||
        manualReferences.length > 1 ||
        (intents.length && manualReferences.length)
      )
        throw new PosOrderClaimError(
          "A posse expirou com prova duplicada ou pagamento em estado incerto. Reconcilie sem criar nova cobrança antes de recuperar.",
        );
      if (manualReferences.length === 1) {
        const manual = manualReferences[0],
          now = new Date();
        if (
          manual.approval.status !== "approved" ||
          manual.approval.expiresAt <= now
        )
          throw new PosOrderClaimError(
            "A referência manual expirada, pendente ou rejeitada exige reconciliação explícita; ela não foi descartada nem renovada automaticamente.",
          );
        if (!draft || manual.paymentIndex !== 0)
          throw new PosOrderClaimError(
            "A referência manual após expiração não possui draft e divisão exatos para recuperação segura.",
          );
        assertPosOrderEligible(current.salesOrder, context.branch.id);
        assertExactPosOrderCart(
          current.salesOrder.items,
          draft.items.map((item) => ({
            productId: item.productId,
            variationId: item.variationId,
            quantity: item.quantity,
            discountCents: item.discountCents,
          })),
        );
        if (
          (current.salesOrder.customerId ?? null) !== draft.customerId ||
          Math.round(current.salesOrder.discount * 100) !==
            draft.discountCents ||
          draft.surchargeCents !== 0 ||
          (current.salesOrder.notes || null) !== draft.notes
        )
          throw new PosOrderClaimError(
            "O draft da referência manual diverge do pedido; recuperação automática bloqueada.",
          );
        assertPosOrderSettlement(current.salesOrder, [
          {
            method: manual.method,
            amountCents: manual.amountCents,
            installments: manual.installments,
          },
        ]);
        const leaseExpiresAt = posOrderClaimLease(now),
          requestHash = hashPosOrderClaimRequest({
            action: "order.claim.recover_manual",
            claimId,
            expectedVersion: current.version,
            manualReferenceId: manual.id,
          });
        const changed = await tx.posOrderClaim.updateMany({
          where: {
            id: current.id,
            state: "active",
            version: current.version,
            leaseExpiresAt: { lte: now },
          },
          data: { version: { increment: 1 }, renewedAt: now, leaseExpiresAt },
        });
        if (changed.count !== 1)
          throw new PosOrderClaimError(
            "A posse mudou durante a recuperação da referência manual.",
          );
        await tx.posOrderClaimOperation.create({
          data: {
            claimId: current.id,
            action: "renew",
            expectedVersion: current.version,
            resultingVersion: current.version + 1,
            resultingState: "active",
            idempotencyKey: `${current.id}:recover-manual:${current.version}`,
            requestHash,
            leaseExpiresAt,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: "pos.order.claim.recovered_after_manual_approval",
            entityType: "pos_order_claim",
            entityId: current.id,
            beforeData: {
              version: current.version,
              leaseExpiresAt: current.leaseExpiresAt.toISOString(),
            },
            afterData: {
              version: current.version + 1,
              leaseExpiresAt: leaseExpiresAt.toISOString(),
              manualReferenceId: manual.id,
              approvalId: manual.approvalId,
              draftId: draft.id,
              noNewCharge: true,
            },
          },
        });
        current = {
          ...current,
          version: current.version + 1,
          renewedAt: now,
          leaseExpiresAt,
        };
      }
      if (intents.length === 1) {
        const captured = intents[0];
        if (
          !draft ||
          !captured.providerReference ||
          !captured.providerOccurredAt ||
          captured.paymentIndex !== 0
        )
          throw new PosOrderClaimError(
            "A captura após expiração não possui draft e evidência exatos para recuperação segura.",
          );
        assertPosOrderEligible(current.salesOrder, context.branch.id);
        assertExactPosOrderCart(
          current.salesOrder.items,
          draft.items.map((item) => ({
            productId: item.productId,
            variationId: item.variationId,
            quantity: item.quantity,
            discountCents: item.discountCents,
          })),
        );
        if (
          (current.salesOrder.customerId ?? null) !== draft.customerId ||
          Math.round(current.salesOrder.discount * 100) !==
            draft.discountCents ||
          draft.surchargeCents !== 0 ||
          (current.salesOrder.notes || null) !== draft.notes
        )
          throw new PosOrderClaimError(
            "O draft da captura diverge do pedido; recuperação automática bloqueada.",
          );
        assertPosOrderSettlement(current.salesOrder, [
          {
            method: captured.method,
            amountCents: captured.amountCents,
            installments: captured.installments,
          },
        ]);
        const now = new Date(),
          leaseExpiresAt = posOrderClaimLease(now),
          requestHash = hashPosOrderClaimRequest({
            action: "order.claim.recover_captured",
            claimId,
            expectedVersion: current.version,
            intentId: captured.id,
          });
        const changed = await tx.posOrderClaim.updateMany({
          where: {
            id: current.id,
            state: "active",
            version: current.version,
            leaseExpiresAt: { lte: now },
          },
          data: { version: { increment: 1 }, renewedAt: now, leaseExpiresAt },
        });
        if (changed.count !== 1)
          throw new PosOrderClaimError(
            "A posse mudou durante a recuperação da captura.",
          );
        await tx.posOrderClaimOperation.create({
          data: {
            claimId: current.id,
            action: "renew",
            expectedVersion: current.version,
            resultingVersion: current.version + 1,
            resultingState: "active",
            idempotencyKey: `${current.id}:recover-captured:${current.version}`,
            requestHash,
            leaseExpiresAt,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: "pos.order.claim.recovered_after_capture",
            entityType: "pos_order_claim",
            entityId: current.id,
            beforeData: {
              version: current.version,
              leaseExpiresAt: current.leaseExpiresAt.toISOString(),
            },
            afterData: {
              version: current.version + 1,
              leaseExpiresAt: leaseExpiresAt.toISOString(),
              intentId: captured.id,
              draftId: draft.id,
              noNewCharge: true,
            },
          },
        });
        current = {
          ...current,
          version: current.version + 1,
          renewedAt: now,
          leaseExpiresAt,
        };
      }
    }
    return current;
  });
  if (!claim)
    return Response.json(
      { claim: null },
      { headers: { "cache-control": "no-store" } },
    );
  return Response.json(
    {
      claim: {
        ...publicOrderClaim(claim),
        order: {
          ...claim.salesOrder,
          discountCents: Math.round(claim.salesOrder.discount * 100),
          totalCents: Math.round(claim.salesOrder.total * 100),
          paymentMethod: posOrderPaymentMethod(claim.salesOrder.paymentMethod),
          items: claim.salesOrder.items.map((item) => ({
            productId: item.productId,
            variationId: item.variationId,
            quantity: item.quantity,
            discountCents: Math.round(item.discount * 100),
          })),
        },
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function releasePosOrderClaim(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  return mutatePosOrderClaim(db, context, body, terminalProof, "release");
}

async function mutatePosOrderClaim(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
  action: "renew" | "release",
) {
  const session = await ownedBoundOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  const claimId = string(body.claimId, "Posse do pedido", 120),
    expectedVersion = integerRange(
      body.expectedVersion,
      0,
      2_147_483_647,
      "Versão",
    ),
    idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 120);
  const requestHash = hashPosOrderClaimRequest({
    action: `order.claim.${action}`,
    claimId,
    expectedVersion,
    sessionId: session.id,
    registerId: register.id,
    operatorProfileId: context.profile.id,
    terminalId: terminalProof.terminalId,
  });
  const replay = await db.posOrderClaimOperation.findUnique({
    where: { idempotencyKey },
    include: { claim: true },
  });
  if (replay)
    return replayClaimOperation(replay, action, requestHash, {
      claimId,
      sessionId: session.id,
      registerId: register.id,
      operatorProfileId: context.profile.id,
      terminalId: terminalProof.terminalId,
    });
  const locator = await locatePosOrderClaimSalesOrder(db, claimId);
  if (!locator)
    throw new PosOrderClaimError("Posse do pedido não encontrada.", 404);
  try {
    const result = await serializablePosOrderClaimRetry(db, async (tx) => {
      await prelockPosOrderClaimWrite(tx, {
        action,
        branchId: context.branch.id,
        registerId: register.id,
        sessionId: session.id,
        sessionVersion: session.version,
        operatorProfileId: context.profile.id,
        terminalProof,
        salesOrderId: locator.salesOrderId,
        claimId,
        expectedVersion,
        idempotencyKey,
      });
      const claim = await tx.posOrderClaim.findUnique({
        where: { id: claimId },
      });
      if (!claim)
        throw new PosOrderClaimError("Posse do pedido não encontrada.", 404);
      const now = new Date();
      assertPosOrderClaimContext(claim, {
        version: expectedVersion,
        branchId: context.branch.id,
        registerId: register.id,
        sessionId: session.id,
        operatorProfileId: context.profile.id,
        terminalId: terminalProof.terminalId,
        now,
        allowExpired: action === "release",
      });
      if (action === "release") {
        const blockers = await unresolvedPosOrderClaimArtifacts(tx, claim);
        if (blockers.paymentIntents || blockers.manualReferences)
          throw new PosOrderClaimError(
            "A posse tem intenção eletrônica ou referência manual pendente. Reconcilie ou cancele com segurança antes de liberar o pedido.",
          );
      }
      const leaseExpiresAt =
        action === "renew" ? posOrderClaimLease(now) : claim.leaseExpiresAt;
      const resultingVersion = claim.version + 1,
        resultingState = action === "renew" ? "active" : "released";
      const changed = await tx.posOrderClaim.updateMany({
        where: {
          id: claim.id,
          state: "active",
          version: expectedVersion,
          ...(action === "renew" ? { leaseExpiresAt: { gt: now } } : {}),
        },
        data:
          action === "renew"
            ? { version: { increment: 1 }, renewedAt: now, leaseExpiresAt }
            : { state: "released", version: { increment: 1 }, releasedAt: now },
      });
      if (changed.count !== 1)
        throw new PosOrderClaimError(
          "A posse do pedido mudou durante a operação.",
        );
      if (action === "release")
        await tx.posHeldSale.updateMany({
          where: {
            id: claim.id,
            sessionId: session.id,
            registerId: register.id,
            operatorProfileId: context.profile.id,
            status: "draft",
          },
          data: { status: "discarded", revision: { increment: 1 } },
        });
      await tx.posOrderClaimOperation.create({
        data: {
          claimId: claim.id,
          action,
          expectedVersion,
          resultingVersion,
          resultingState,
          idempotencyKey,
          requestHash,
          leaseExpiresAt,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.permission.user.id,
          action: `pos.order.claim.${action}ed`,
          entityType: "pos_order_claim",
          entityId: claim.id,
          beforeData: {
            state: claim.state,
            version: claim.version,
            leaseExpiresAt: claim.leaseExpiresAt.toISOString(),
          },
          afterData: {
            state: resultingState,
            version: resultingVersion,
            leaseExpiresAt: leaseExpiresAt.toISOString(),
            sessionId: session.id,
            registerId: register.id,
            terminalId: terminalProof.terminalId,
          },
        },
      });
      return {
        id: claim.id,
        salesOrderId: claim.salesOrderId,
        state: resultingState,
        version: resultingVersion,
        leaseExpiresAt,
      };
    });
    return Response.json(
      { claim: result, replayed: false },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (
      ["P2002", "P2034"].includes(
        String((error as { code?: string })?.code || ""),
      )
    ) {
      const concurrent = await db.posOrderClaimOperation.findUnique({
        where: { idempotencyKey },
        include: { claim: true },
      });
      if (concurrent)
        return replayClaimOperation(concurrent, action, requestHash, {
          claimId,
          sessionId: session.id,
          registerId: register.id,
          operatorProfileId: context.profile.id,
          terminalId: terminalProof.terminalId,
        });
      throw new PosOrderClaimError(
        "A posse do pedido mudou em outra operação. Atualize antes de continuar.",
      );
    }
    throw error;
  }
}

async function unresolvedPosOrderClaimArtifacts(
  tx: Prisma.TransactionClient,
  claim: {
    id: string;
    branchId: number;
    registerId: number;
    sessionId: number;
    operatorProfileId: number;
  },
) {
  const [paymentIntents, manualReferences] = await Promise.all([
    tx.posPaymentIntent.count({
      where: {
        saleDraftId: claim.id,
        branchId: claim.branchId,
        registerId: claim.registerId,
        sessionId: claim.sessionId,
        operatorProfileId: claim.operatorProfileId,
        consumedAt: null,
        status: { in: [...POS_DRAFT_RECOVERY_INTENT_STATES] },
      },
    }),
    tx.posManualPaymentReference.count({
      where: {
        saleDraftId: claim.id,
        branchId: claim.branchId,
        registerId: claim.registerId,
        sessionId: claim.sessionId,
        requesterProfileId: claim.operatorProfileId,
        consumedSalePaymentId: null,
        status: "pending",
      },
    }),
  ]);
  return { paymentIntents, manualReferences };
}

async function serializablePosOrderClaimRetry<T>(
  db: Db,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: "Serializable",
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (
        String((error as { code?: string })?.code || "") !== "P2034" ||
        attempt === 3
      )
        throw error;
    }
  }
  throw new PosOrderClaimError(
    "Conflito de serialização ao alterar a posse do pedido.",
  );
}

async function assertNoActivePosOrderClaim(
  tx: Prisma.TransactionClient,
  sessionId: number,
  operation: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_order_claims" WHERE "session_id" = ${sessionId} AND "state" = 'active' FOR UPDATE`,
  );
  const active = await tx.posOrderClaim.findFirst({
    where: { sessionId, state: "active" },
    select: { id: true, salesOrderId: true },
  });
  if (active)
    throw new PosOrderClaimError(
      `Conclua ou libere o pedido reivindicado antes de ${operation} o turno.`,
    );
}

function replayClaimCreation(
  claim: Prisma.PosOrderClaimGetPayload<Record<string, never>>,
  requestHash: string,
  expected: {
    orderId: number;
    sessionId: number;
    registerId: number;
    operatorProfileId: number;
    terminalId: string;
  },
) {
  if (
    claim.requestHash !== requestHash ||
    claim.salesOrderId !== expected.orderId ||
    claim.sessionId !== expected.sessionId ||
    claim.registerId !== expected.registerId ||
    claim.operatorProfileId !== expected.operatorProfileId ||
    claim.terminalId !== expected.terminalId
  )
    throw new PosOrderClaimError(
      "A chave idempotente do claim já foi usada em outro contexto.",
    );
  return Response.json(
    { claim: publicOrderClaim(claim), replayed: true },
    {
      headers: { "cache-control": "no-store", "idempotency-replayed": "true" },
    },
  );
}

function replayClaimOperation(
  operation: Prisma.PosOrderClaimOperationGetPayload<{
    include: { claim: true };
  }>,
  action: "renew" | "release",
  requestHash: string,
  expected: {
    claimId: string;
    sessionId: number;
    registerId: number;
    operatorProfileId: number;
    terminalId: string;
  },
) {
  const claim = operation.claim;
  if (
    operation.action !== action ||
    operation.requestHash !== requestHash ||
    claim.id !== expected.claimId ||
    claim.sessionId !== expected.sessionId ||
    claim.registerId !== expected.registerId ||
    claim.operatorProfileId !== expected.operatorProfileId ||
    claim.terminalId !== expected.terminalId
  )
    throw new PosOrderClaimError(
      "A chave idempotente da operação já foi usada em outro contexto.",
    );
  return Response.json(
    {
      claim: {
        id: claim.id,
        salesOrderId: claim.salesOrderId,
        state: operation.resultingState,
        version: operation.resultingVersion,
        leaseExpiresAt: operation.leaseExpiresAt,
      },
      replayed: true,
    },
    {
      headers: { "cache-control": "no-store", "idempotency-replayed": "true" },
    },
  );
}

function publicOrderClaim(claim: {
  id: string;
  salesOrderId: number;
  state: string;
  version: number;
  leaseExpiresAt: Date;
}) {
  return {
    id: claim.id,
    salesOrderId: claim.salesOrderId,
    state: claim.state,
    version: claim.version,
    leaseExpiresAt: claim.leaseExpiresAt,
  };
}

async function updateRegisterAccess(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
) {
  if (!context.privileged)
    throw new PosDomainError(
      "Somente administradores podem alterar acessos de caixa.",
    );
  const registerId = positiveInt(body.registerId, "Caixa"),
    userProfileId = positiveInt(body.userProfileId, "Funcionário");
  const [register, profile] = await Promise.all([
    db.posRegister.findFirst({
      where: { id: registerId, branchId: context.branch.id, status: "active" },
    }),
    db.tenantUserProfile.findFirst({
      where: { id: userProfileId, status: "active" },
    }),
  ]);
  if (!register || !profile)
    throw new PosDomainError(
      "Caixa ou funcionário não encontrado nesta organização.",
    );
  const active = body.active !== false,
    validFrom = optionalDate(body.validFrom),
    validUntil = optionalDate(body.validUntil);
  if (validFrom && validUntil && validFrom > validUntil)
    throw new PosDomainError(
      "A validade final do acesso deve ser posterior à inicial.",
    );
  const permissions = {
    active,
    canOpen: flag(body.canOpen),
    canClose: flag(body.canClose),
    canSell: flag(body.canSell),
    canSupply: flag(body.canSupply),
    canWithdraw: flag(body.canWithdraw),
    canCancel: flag(body.canCancel),
    canRefund: flag(body.canRefund),
    canReprint: flag(body.canReprint),
    canManualPayment: flag(body.canManualPayment),
    canTransferHeld: flag(body.canTransferHeld),
    maxDiscountBasisPoints: integerRange(
      body.maxDiscountBasisPoints,
      0,
      10_000,
      "Alçada de desconto",
    ),
    validFrom,
    validUntil,
  };
  const correlationId = randomUUID();
  const access = await db.$transaction(
    async (tx) => {
      const before = await tx.posRegisterAccess.findUnique({
        where: { registerId_userProfileId: { registerId, userProfileId } },
      });
      const saved = await tx.posRegisterAccess.upsert({
        where: { registerId_userProfileId: { registerId, userProfileId } },
        update: permissions,
        create: { registerId, userProfileId, ...permissions },
      });
      const canSellInBranch =
        (await tx.posRegisterAccess.count({
          where: {
            userProfileId,
            active: true,
            canSell: true,
            register: { branchId: context.branch.id, status: "active" },
            AND: [
              { OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }] },
              {
                OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
              },
            ],
          },
        })) > 0;
      await tx.branchUserAccess.upsert({
        where: {
          branchId_userProfileId: {
            branchId: context.branch.id,
            userProfileId,
          },
        },
        update: { canSell: canSellInBranch },
        create: {
          branchId: context.branch.id,
          userProfileId,
          canSell: canSellInBranch,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.permission.user.id,
          action: "pos.register_access.updated",
          entityType: "pos_register_access",
          entityId: String(saved.id),
          correlationId,
          beforeData: before
            ? (JSON.parse(JSON.stringify(before)) as Prisma.InputJsonObject)
            : undefined,
          afterData: JSON.parse(
            JSON.stringify(saved),
          ) as Prisma.InputJsonObject,
        },
      });
      return saved;
    },
    { isolationLevel: "Serializable" },
  );
  return Response.json({ access, correlationId });
}

async function resolveScan(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
) {
  const purpose = classifyPosScanPurpose(body.code);
  if (purpose === "internal_qr")
    throw new PosDomainError(
      "QR interno deve ser validado no resolvedor assinado do PDV.",
    );
  if (purpose === "pix_payment")
    throw new PosDomainError(
      "QR Pix é um instrumento de pagamento e não pode ser interpretado como produto.",
    );
  if (purpose === "fiscal_document")
    throw new PosDomainError(
      "QR fiscal identifica um documento e não pode ser interpretado como produto.",
    );
  const scan = parsePosScan(body.code);
  const resolution = await resolvePosProductCode(
    db,
    context.branch.id,
    body.code,
  );
  if (resolution) {
    const product = await sellableProduct(
      db,
      context,
      resolution.mapping.productId,
      resolution.mapping.variationId,
    );
    if (!product)
      throw new PosDomainError(
        "Produto mapeado não está disponível neste caixa.",
      );
    const finalized = finalizePosProductCodeResolution(
      resolution,
      product.priceCents,
      product.unit,
    );
    return Response.json({ scan: finalized.scan, product });
  }
  const matches = await db.product.findMany({
    where: {
      active: true,
      branchConfigurations: {
        some: { branchId: context.branch.id, active: true, saleEnabled: true },
      },
      OR: [
        { sku: scan.lookup },
        { barcode: scan.lookup },
        { gtin: scan.lookup },
        {
          variations: {
            some: {
              enabled: true,
              OR: [{ sku: scan.lookup }, { gtin: scan.lookup }],
            },
          },
        },
      ],
    },
    select: {
      id: true,
      gtin: true,
      barcode: true,
      variations: {
        where: {
          enabled: true,
          OR: [{ sku: scan.lookup }, { gtin: scan.lookup }],
        },
        select: { id: true, gtin: true },
      },
    },
    take: 2,
  });
  if (matches.length > 1)
    throw new PosDomainError(
      "Código ambíguo. Corrija os códigos duplicados no catálogo antes de vender.",
    );
  const match = matches[0];
  if (!match)
    throw new PosDomainError(
      "Código não encontrado no catálogo ativo desta filial.",
    );
  if (match.variations.length > 1)
    throw new PosDomainError(
      "Código ambíguo entre variações. Corrija os códigos duplicados antes de vender.",
    );
  if (
    (match.gtin === scan.lookup ||
      match.variations.some((variation) => variation.gtin === scan.lookup) ||
      scan.kind === "gs1" ||
      scan.kind === "digital_link") &&
    scan.gtin &&
    !isValidGtin(scan.gtin)
  )
    throw new PosDomainError("GTIN inválido: dígito verificador não confere.");
  const product = await sellableProduct(
    db,
    context,
    match.id,
    match.variations[0]?.id || null,
  );
  if (!product) throw new PosDomainError("Produto não disponível neste caixa.");
  return Response.json({ scan, product });
}

async function sellableProduct(
  db: Db,
  context: Access,
  productId: number,
  resolvedVariationId: number | null,
) {
  const session = await db.cashRegisterSession.findFirst({
    where: { operatorProfileId: context.profile.id, status: "open" },
    select: { register: { select: { warehouseId: true } } },
  });
  const warehouseId =
    session?.register?.warehouseId ||
    context.registers[0]?.warehouseId ||
    context.branch.defaultWarehouseId;
  const product = await db.product.findFirst({
    where: {
      id: productId,
      active: true,
      branchConfigurations: {
        some: { branchId: context.branch.id, active: true, saleEnabled: true },
      },
    },
    select: {
      id: true,
      name: true,
      sku: true,
      barcode: true,
      gtin: true,
      type: true,
      unit: true,
      category: true,
      imageMediaId: true,
      gallery: {
        orderBy: { position: "asc" },
        take: 1,
        select: { mediaAssetId: true },
      },
      manageStock: true,
      soldIndividually: true,
      minimumSalePrice: true,
      price: true,
      cashPrice: true,
      salePrice: true,
      saleStartsAt: true,
      saleEndsAt: true,
      branchConfigurations: {
        where: { branchId: context.branch.id },
        select: { priceOverride: true },
      },
      warehouseBalances: {
        where: warehouseId ? { warehouseId } : { warehouseId: -1 },
        select: { quantity: true, reservedQuantity: true },
      },
      variations: {
        where: { enabled: true },
        select: {
          id: true,
          sku: true,
          gtin: true,
          imageMediaId: true,
          gallery: {
            orderBy: { position: "asc" },
            take: 1,
            select: { mediaAssetId: true },
          },
          regularPrice: true,
          salePrice: true,
          saleStartsAt: true,
          saleEndsAt: true,
          manageStock: true,
          stock: true,
          attributes: true,
          warehouseBalances: {
            where: warehouseId ? { warehouseId } : { warehouseId: -1 },
            select: { quantity: true, reservedQuantity: true },
          },
        },
      },
    },
  });
  if (!product) return null;
  const configuration = product.branchConfigurations[0],
    balance = product.warehouseBalances[0],
    variation = product.variations.find(
      (item) => item.id === resolvedVariationId,
    );
  if (resolvedVariationId && !variation) return null;
  const basePrice = configuration?.priceOverride ?? currentPrice(product);
  const variationPrice = variation
    ? currentVariationPrice(variation, basePrice)
    : basePrice;
  const stock = posAvailableStock(product, balance, variation);
  return {
    ...product,
    branchConfigurations: undefined,
    warehouseBalances: undefined,
    resolvedVariationId,
    imageUrl: posProductImageUrl(product, resolvedVariationId),
    priceCents: Math.round(variationPrice * 100),
    stock,
  };
}

async function availableValueAccounts(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
) {
  const session = await ownedOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
  );
  const register = accessFor(context, session.registerId!);
  if (!register.access.canSell)
    throw new PosDomainError(
      "Você não pode consultar saldos para venda neste caixa.",
    );
  const customerId = positiveInt(body.customerId, "Cliente"),
    now = new Date();
  if (
    !(await db.customer.findFirst({
      where: { id: customerId, status: "active" },
      select: { id: true },
    }))
  )
    throw new PosDomainError("Cliente ativo não encontrado.");
  const accounts = await db.posValueAccount.findMany({
    where: {
      branchId: context.branch.id,
      customerId,
      status: "active",
      kind: { not: "gift_card" },
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    select: {
      id: true,
      kind: true,
      unit: true,
      label: true,
      balanceUnits: true,
      reservedUnits: true,
      expiresAt: true,
      program: { select: { name: true, redeemCentsPerUnit: true } },
    },
    orderBy: { label: "asc" },
    take: 20,
  });
  return Response.json(
    {
      customerId,
      accounts: accounts.map((account) => ({
        ...account,
        balanceUnits: account.balanceUnits.toString(),
        reservedUnits: account.reservedUnits.toString(),
        availableUnits: (
          account.balanceUnits - account.reservedUnits
        ).toString(),
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function openSession(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const register = accessFor(context, positiveInt(body.registerId, "Caixa"));
  if (!register.access.canOpen)
    throw new PosDomainError("Você não pode abrir este caixa.");
  if (terminalProof.registerId !== register.id)
    throw new PosTerminalBoundaryError(
      "O terminal autenticado pertence a outro caixa.",
      403,
    );
  const openingAmountCents = cents(
    body.openingAmountCents,
    "Fundo de troco",
    true,
  );
  const businessDate = posDate(body.businessDate, "Data operacional");
  const openingNotes = optionalString(body.openingNotes, 500);
  const openingCount = cashOpeningCount(body.openingCount, openingAmountCents);
  const idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const requestHash = posTerminalBoundOpenRequestHash({
    registerId: register.id,
    openingAmountCents,
    terminalId: terminalProof.terminalId,
  });
  const replay = await db.cashRegisterSession.findUnique({
    where: { openIdempotencyKey: idempotencyKey },
  });
  if (replay) {
    assertSessionReplayContext(
      replay,
      context,
      requestHash,
      replay.openRequestHash,
      { registerId: register.id },
    );
    return Response.json({ session: replay, replayed: true });
  }
  const correlationId = randomUUID();
  let session;
  try {
    session = await db.$transaction(
      async (tx) => {
        await assertLiveTerminalProof(tx, context, terminalProof, register.id);
        const existing = await tx.cashRegisterSession.findFirst({
          where: {
            status: { in: ["open", "suspended", "closing"] },
            OR: [
              { registerId: register.id },
              { operatorProfileId: context.profile.id },
            ],
          },
        });
        if (existing?.registerId === register.id)
          throw new PosDomainError("Este caixa já possui um turno aberto.");
        if (existing)
          throw new PosDomainError(
            "Este operador já possui outro turno aberto.",
          );
        const created = await tx.cashRegisterSession.create({
          data: {
            number: number("CX"),
            registerId: register.id,
            registerName: register.name,
            operatorProfileId: context.profile.id,
            terminalId: terminalProof.terminalId,
            businessDate,
            openingNotes,
            openingCount,
            openedByUserId: context.permission.user.id,
            openingAmount: openingAmountCents / 100,
            openingAmountCents,
            openedBy: context.profile.displayName,
            openIdempotencyKey: idempotencyKey,
            openRequestHash: requestHash,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: "pos.session.opened",
            entityType: "cash_register_session",
            entityId: String(created.id),
            correlationId,
            afterData: {
              registerId: register.id,
              terminalId: terminalProof.terminalId,
              terminalCredentialVersion: terminalProof.credentialVersion,
              businessDate: businessDate.toISOString().slice(0, 10),
              openingAmountCents,
              openingCount,
              openingNotes,
              idempotencyKey,
            },
          },
        });
        return created;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const concurrent = await db.cashRegisterSession.findUnique({
      where: { openIdempotencyKey: idempotencyKey },
    });
    if (concurrent) {
      assertSessionReplayContext(
        concurrent,
        context,
        requestHash,
        concurrent.openRequestHash,
        { registerId: register.id },
      );
      return Response.json({ session: concurrent, replayed: true });
    }
    throw error;
  }
  return Response.json({ session, correlationId }, { status: 201 });
}

async function cashEvent(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const session = await ownedBoundOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  const type = choice(
    body.type,
    ["supply", "withdrawal"] as const,
    "Tipo de movimento",
  );
  if (type === "supply" && !register.access.canSupply)
    throw new PosDomainError("Você não pode registrar suprimento.");
  const requiresApproval =
    type === "withdrawal" &&
    !register.access.canWithdraw &&
    !context.privileged;
  const approvalId = optionalString(body.approvalId, 120);
  if (requiresApproval && !approvalId)
    throw new PosDomainError(
      "Esta sangria exige aprovação de um administrador.",
    );
  const amountCents = cents(body.amountCents, "Valor");
  const description = string(body.description, "Motivo", 300);
  const idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const requestHash = hashPayload({
    sessionId: session.id,
    type,
    amountCents,
    description,
    reasonCode: body.reasonCode || "other",
    approvalId,
  });
  const replay = await db.cashRegisterEvent.findUnique({
    where: { idempotencyKey },
  });
  if (replay) {
    if (replay.sessionId !== session.id || replay.requestHash !== requestHash)
      throw new PosDomainError(
        "A chave idempotente já foi usada com outro movimento.",
      );
    return Response.json({ event: replay, replayed: true });
  }
  const correlationId = randomUUID();
  let event;
  try {
    event = await db.$transaction(
      async (tx) => {
        await assertLiveTerminalProof(
          tx,
          context,
          terminalProof,
          session.registerId!,
        );
        const current = await tx.cashRegisterSession.findFirst({
          where: { id: session.id, status: "open" },
        });
        if (!current) throw new PosDomainError("O turno não está mais aberto.");
        if (requiresApproval)
          await consumeApprovedPosAction(
            tx,
            context,
            approvalId!,
            "cash.withdrawal",
            "cash_register_session",
            String(session.id),
            idempotencyKey,
          );
        if (type === "withdrawal") {
          const [payments, events] = await Promise.all([
            tx.posSalePayment.findMany({
              where: {
                processingSessionId: session.id,
                method: "cash",
                type: { in: ["payment", "refund"] },
                status: { in: ["authorized", "captured", "paid", "refunded"] },
              },
            }),
            tx.cashRegisterEvent.findMany({
              where: {
                sessionId: session.id,
                type: { in: ["supply", "withdrawal"] },
              },
            }),
          ]);
          const available =
            current.openingAmountCents +
            payments.reduce(
              (sum, payment) =>
                sum +
                (payment.type === "refund"
                  ? -payment.amountCents
                  : payment.amountCents),
              0,
            ) +
            events.reduce(
              (sum, item) =>
                sum +
                (item.type === "supply" ? item.amountCents : -item.amountCents),
              0,
            );
          if (amountCents > available)
            throw new PosDomainError(
              "A sangria supera o saldo físico esperado da gaveta.",
            );
        }
        const created = await tx.cashRegisterEvent.create({
          data: {
            sessionId: session.id,
            type,
            amount: amountCents / 100,
            amountCents,
            paymentMethod: "cash",
            description,
            actor: context.profile.displayName,
            reasonCode: string(
              body.reasonCode || "other",
              "Código do motivo",
              60,
            ),
            correlationId,
            idempotencyKey,
            requestHash,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: `pos.cash.${type}`,
            entityType: "cash_register_session",
            entityId: String(session.id),
            correlationId,
            afterData: { eventId: created.id, amountCents, description },
          },
        });
        return created;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      const concurrent = await db.cashRegisterEvent.findUnique({
        where: { idempotencyKey },
      });
      if (concurrent) {
        if (
          concurrent.sessionId !== session.id ||
          concurrent.requestHash !== requestHash
        )
          throw new PosDomainError(
            "A chave idempotente já foi usada com outro movimento.",
          );
        return Response.json({ event: concurrent, replayed: true });
      }
    }
    throw error;
  }
  return Response.json({ event, correlationId }, { status: 201 });
}

async function closeSession(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const sessionId = positiveInt(body.sessionId, "Turno");
  const rawCounts = array(body.counts, "Contagens");
  if (!rawCounts.length || rawCounts.length > 50)
    throw new PosDomainError("Informe entre 1 e 50 contagens.");
  const counts = rawCounts.map((entry) => {
    const item = object(entry);
    const method = choice(
      item.method,
      ["cash", "pix", "credit", "debit", "voucher"] as const,
      "Forma",
    );
    return {
      method,
      provider:
        method === "cash" ? "" : optionalString(item.provider, 80) || "",
      declaredCents: cents(item.declaredCents, "Valor contado", true),
      details: limitedObject(item.details, "Detalhes da contagem"),
    };
  });
  if (!counts.some((item) => item.method === "cash"))
    throw new PosDomainError("Informe a contagem de dinheiro.");
  if (
    new Set(counts.map((item) => paymentKey(item.method, item.provider)))
      .size !== counts.length
  )
    throw new PosDomainError(
      "Há contagens duplicadas para a mesma forma e provedor.",
    );
  const notes = optionalString(body.notes, 1000);
  const approvalId = optionalString(body.approvalId, 100);
  const idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const normalizedCounts = [...counts].sort((left, right) =>
    paymentKey(left.method, left.provider).localeCompare(
      paymentKey(right.method, right.provider),
    ),
  );
  const requestHash = hashPayload({
    sessionId,
    counts: normalizedCounts,
    notes,
    approvalId,
  });
  const replay = await db.cashRegisterSession.findUnique({
    where: { closeIdempotencyKey: idempotencyKey },
    include: { paymentCounts: true },
  });
  if (replay) {
    assertSessionReplayContext(
      replay,
      context,
      requestHash,
      replay.closeRequestHash,
      { sessionId },
    );
    assertPosSessionTerminalBinding(replay, terminalProof);
    const replayRegister = accessFor(context, replay.registerId!);
    if (!replayRegister.access.canClose)
      throw new PosDomainError("Você não pode fechar este caixa.");
    return Response.json({ session: replay, replayed: true });
  }
  const session = await ownedBoundOpenSession(
    db,
    context,
    sessionId,
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  if (!register.access.canClose)
    throw new PosDomainError("Você não pode fechar este caixa.");
  const correlationId = randomUUID();
  let closed;
  try {
    closed = await db.$transaction(
      async (tx) => {
        await assertLiveTerminalProof(
          tx,
          context,
          terminalProof,
          session.registerId!,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${session.id} FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id" = ${terminalProof.terminalId} FOR UPDATE`,
        );
        if (
          await tx.posPaymentPlan.count({
            where: {
              sessionId: session.id,
              state: { in: ["quoted", "active"] },
            },
          })
        )
          throw new PosPaymentPlanError(
            "Recote, cancele com segurança ou reconcilie todos os planos de pagamento antes de fechar o turno.",
          );
        if (
          await tx.posManualPaymentReference.count({
            where: { sessionId: session.id, consumedSalePaymentId: null },
          })
        )
          throw new PosPaymentPlanError(
            "Há prova manual não consumida; o turno só pode fechar após reconciliação explícita.",
          );
        await preparePosManualSessionTransition(tx, {
          action: "close",
          sessionId: session.id,
          expectedVersion: session.version,
          actorProfileId: context.profile.id,
          actorUserId: context.permission.user.id,
          idempotencyKey,
          requestHash,
        });
        const locked = await tx.cashRegisterSession.updateMany({
          where: { id: session.id, status: "open", version: session.version },
          data: {
            status: "closing",
            version: { increment: 1 },
            closeIdempotencyKey: idempotencyKey,
            closeRequestHash: requestHash,
          },
        });
        if (locked.count !== 1)
          throw new PosDomainError("O turno foi alterado por outra operação.");
        await assertNoActivePosOrderClaim(tx, session.id, "fechar");
        if (
          await tx.posHeldSale.count({
            where: { sessionId: session.id, status: { in: ["held", "draft"] } },
          })
        )
          throw new PosDomainError(
            "Resolva ou descarte todos os rascunhos e vendas suspensas antes de fechar o turno.",
          );
        if (
          await tx.posSalePayment.count({
            where: {
              processingSessionId: session.id,
              status: {
                in: [
                  "created",
                  "processing",
                  "pending",
                  "unknown",
                  "manual_review",
                ],
              },
            },
          })
        )
          throw new PosDomainError(
            "Existem pagamentos ou reembolsos pendentes de conciliação neste turno.",
          );
        if (
          await tx.posPaymentIntent.count({
            where: {
              sessionId: session.id,
              consumedAt: null,
              status: {
                in: [
                  "created",
                  "processing",
                  "authorized",
                  "captured",
                  "unknown",
                  "manual_review",
                ],
              },
            },
          })
        )
          throw new PosDomainError(
            "Existem intenções eletrônicas não resolvidas ou capturadas ainda não vinculadas a uma venda neste turno.",
          );
        if (
          await tx.posPaymentIntegrityIncident.count({
            where: {
              status: "open",
              productionBlocking: true,
              intent: { sessionId: session.id },
            },
          })
        )
          throw new PosDomainError(
            "Existem incidentes bloqueantes de integridade de pagamento neste turno.",
          );
        const [payments, events, settings] = await Promise.all([
          tx.posSalePayment.findMany({
            where: {
              processingSessionId: session.id,
              method: { not: "store_credit" },
              status: {
                in: [
                  "authorized",
                  "captured",
                  "manual_confirmed",
                  "paid",
                  "refunded",
                ],
              },
              type: { in: ["payment", "refund"] },
            },
          }),
          tx.cashRegisterEvent.findMany({ where: { sessionId: session.id } }),
          tx.tenantSettings.findUnique({
            where: { id: 1 },
            select: { posCloseToleranceCents: true },
          }),
        ]);
        const expected = new Map<string, number>();
        expected.set(
          paymentKey("cash", ""),
          session.openingAmountCents +
            events.reduce(
              (sum, event) =>
                sum +
                (event.type === "supply"
                  ? event.amountCents
                  : event.type === "withdrawal"
                    ? -event.amountCents
                    : 0),
              0,
            ),
        );
        for (const payment of payments) {
          const key = paymentKey(payment.method, payment.provider || "");
          expected.set(
            key,
            (expected.get(key) || 0) +
              (payment.type === "refund"
                ? -payment.amountCents
                : payment.amountCents),
          );
        }
        await tx.posSessionPaymentCount.deleteMany({
          where: { sessionId: session.id },
        });
        const differencesCents: number[] = [];
        for (const count of counts) {
          const key = paymentKey(count.method, count.provider),
            expectedCents = expected.get(key) || 0;
          const differenceCents = count.declaredCents - expectedCents;
          differencesCents.push(differenceCents);
          await tx.posSessionPaymentCount.create({
            data: {
              sessionId: session.id,
              ...count,
              expectedCents,
              differenceCents,
            },
          });
          expected.delete(key);
        }
        for (const [key, expectedCents] of expected) {
          const [method, provider] = key.split("\u0000");
          differencesCents.push(-expectedCents);
          await tx.posSessionPaymentCount.create({
            data: {
              sessionId: session.id,
              method,
              provider,
              expectedCents,
              declaredCents: 0,
              differenceCents: -expectedCents,
            },
          });
        }
        const closingPolicy = evaluatePosClosingPolicy({
          differencesCents,
          toleranceCents: settings?.posCloseToleranceCents ?? 0,
          notes,
          approvalId,
        });
        if (closingPolicy.approvalRequired) {
          await consumeApprovedPosAction(
            tx,
            context,
            approvalId!,
            "session.close.divergence",
            "cash_register_session",
            String(session.id),
            idempotencyKey,
          );
        }
        const cashExpectedCents = payments
          .filter((payment) => payment.method === "cash")
          .reduce(
            (sum, payment) =>
              sum +
              (payment.type === "refund"
                ? -payment.amountCents
                : payment.amountCents),
            session.openingAmountCents +
              events.reduce(
                (sum, event) =>
                  sum +
                  (event.type === "supply"
                    ? event.amountCents
                    : event.type === "withdrawal"
                      ? -event.amountCents
                      : 0),
                0,
              ),
          );
        const cashDeclaredCents = counts.find(
          (item) => item.method === "cash",
        )!.declaredCents;
        await preparePosManualSessionTransition(tx, {
          action: "close",
          sessionId: session.id,
          expectedVersion: session.version + 1,
          actorProfileId: context.profile.id,
          actorUserId: context.permission.user.id,
          idempotencyKey,
          requestHash,
        });
        const value = await tx.cashRegisterSession.update({
          where: { id: session.id },
          data: {
            status: "closed",
            expectedAmount: cashExpectedCents / 100,
            expectedAmountCents: cashExpectedCents,
            closingAmount: cashDeclaredCents / 100,
            closingAmountCents: cashDeclaredCents,
            difference: (cashDeclaredCents - cashExpectedCents) / 100,
            differenceCents: closingPolicy.totalDifferenceCents,
            absoluteDifferenceCents: closingPolicy.absoluteDifferenceCents,
            closeNotes: notes,
            closeApprovalId: closingPolicy.approvalRequired ? approvalId : null,
            closedBy: context.profile.displayName,
            closedAt: new Date(),
          },
          include: { paymentCounts: true },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: "pos.session.closed",
            entityType: "cash_register_session",
            entityId: String(session.id),
            correlationId,
            beforeData: { status: "open" },
            afterData: {
              status: "closed",
              cashExpectedCents,
              cashDeclaredCents,
              totalDifferenceCents: closingPolicy.totalDifferenceCents,
              absoluteDifferenceCents: closingPolicy.absoluteDifferenceCents,
              closeApprovalId: closingPolicy.approvalRequired
                ? approvalId
                : null,
              idempotencyKey,
            },
          },
        });
        return value;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const concurrent = await db.cashRegisterSession.findUnique({
      where: { closeIdempotencyKey: idempotencyKey },
      include: { paymentCounts: true },
    });
    if (concurrent) {
      assertSessionReplayContext(
        concurrent,
        context,
        requestHash,
        concurrent.closeRequestHash,
        { sessionId },
      );
      assertPosSessionTerminalBinding(concurrent, terminalProof);
      return Response.json({ session: concurrent, replayed: true });
    }
    throw error;
  }
  return Response.json({ session: closed, correlationId });
}

type RecoveryDraftItem = {
  productId: number;
  variationId: number | null;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  scanData: Prisma.InputJsonObject | undefined;
};

function recoveryDraftItems(
  body: Record<string, unknown>,
): RecoveryDraftItem[] {
  const rawItems = array(body.items, "Itens");
  if (!rawItems.length || rawItems.length > 200)
    throw new PosDomainError("O rascunho deve ter entre 1 e 200 itens.");
  const items = rawItems.map((entry) => {
    const item = object(entry);
    return {
      productId: positiveInt(item.productId, "Produto"),
      variationId: optionalPositiveInt(item.variationId),
      quantity: quantity(item.quantity),
      unitPriceCents: cents(item.unitPriceCents, "Preço", true),
      discountCents: cents(item.discountCents || 0, "Desconto", true),
      scanData: limitedObject(item.scanData, "Dados da leitura"),
    };
  });
  if (
    new Set(items.map((item) => `${item.productId}:${item.variationId || 0}`))
      .size !== items.length
  )
    throw new PosDomainError(
      "Consolide itens repetidos da mesma variação no rascunho.",
    );
  return items;
}

async function saveRecoveryDraft(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const sessionId = positiveInt(body.sessionId, "Turno"),
    draftId = string(body.saleDraftId, "Rascunho da venda", 100);
  const expectedRevision =
    body.expectedRevision == null
      ? null
      : integerRange(
          body.expectedRevision,
          0,
          2_147_483_646,
          "Revisão esperada",
        );
  const idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100),
    items = recoveryDraftItems(body);
  const customerId = optionalPositiveInt(body.customerId),
    notes = optionalString(body.notes, 1000);
  const fulfillmentMode = choice(
    body.fulfillmentMode || "on_site",
    ["on_site", "pickup", "delivery"] as const,
    "Modalidade de atendimento",
  );
  const discountCents = cents(body.discountCents || 0, "Desconto", true),
    surchargeCents = cents(body.surchargeCents || 0, "Acréscimo", true);
  const requestHash = hashPayload({
    draftId,
    sessionId,
    customerId,
    notes,
    fulfillmentMode,
    discountCents,
    surchargeCents,
    items,
  });
  const session = await ownedBoundOpenSession(
      db,
      context,
      sessionId,
      terminalProof,
    ),
    register = accessFor(context, session.registerId!);
  if (!register.access.canSell)
    throw new PosDomainError("Você não pode preparar vendas neste caixa.");
  const saved = await db.$transaction(
    async (tx) => {
      const locator = await tx.posHeldSale.findUnique({
        where: { id: draftId },
        select: {
          id: true,
          sessionId: true,
          registerId: true,
          operatorProfileId: true,
          register: { select: { branchId: true } },
        },
      });
      // Read-only locator: release preparation takes t2-plan advisory locks before
      // its roots.  Acquire every release namespace that can affect this draft
      // before the held-item root chain, never after pos_held_sales/items.
      const openPlanLocators = locator
        ? await tx.posPaymentPlan.findMany({
            where: {
              saleDraftId: draftId,
              state: { in: ["quoted", "active"] },
            },
            select: {
              id: true,
              state: true,
              version: true,
              expiresAt: true,
              saleDraftId: true,
              orderClaimId: true,
              orderClaim: { select: { salesOrderId: true } },
            },
            orderBy: { id: "asc" },
          })
        : [];
      await prelockPosHeldSaleItemWrite(tx, {
        action: locator ? "replace_batch" : "create",
        idempotencyKey,
        heldSaleId: draftId,
        sessionIds: [session.id, ...(locator ? [locator.sessionId] : [])],
        terminalIds: [terminalProof.terminalId],
        branchIds: [
          context.branch.id,
          ...(locator ? [locator.register.branchId] : []),
        ],
        registerIds: [register.id, ...(locator ? [locator.registerId] : [])],
        operatorProfileIds: [
          context.profile.id,
          ...(locator ? [locator.operatorProfileId] : []),
        ],
        terminalRegisterPairs: [[terminalProof.terminalId, register.id]],
        registerBranchPairs: [
          [register.id, context.branch.id],
          ...(locator
            ? [[locator.registerId, locator.register.branchId] as const]
            : []),
        ],
        branchProfilePairs: [
          [context.branch.id, context.profile.id],
          ...(locator
            ? [[locator.register.branchId, locator.operatorProfileId] as const]
            : []),
        ],
        registerProfilePairs: [
          [register.id, context.profile.id],
          ...(locator
            ? [[locator.registerId, locator.operatorProfileId] as const]
            : []),
        ],
        orderClaim: { id: draftId, expectation: "optional" },
        preRootAdvisoryNamespaces:
          posPaymentPlanReleaseAdvisoryNamespaces(openPlanLocators),
      });
      await assertLiveTerminalProof(tx, context, terminalProof, register.id);
      if (
        !(await tx.cashRegisterSession.findFirst({
          where: {
            id: session.id,
            registerId: register.id,
            operatorProfileId: context.profile.id,
            status: "open",
            version: session.version,
          },
          select: { id: true },
        }))
      )
        throw new PosOrderClaimError(
          "O turno foi fechado ou alterado antes de salvar o rascunho.",
        );
      const orderClaim = await tx.posOrderClaim.findUnique({
        where: { id: draftId },
        include: {
          salesOrder: {
            select: {
              customerId: true,
              discount: true,
              notes: true,
              items: {
                select: {
                  id: true,
                  productId: true,
                  variationId: true,
                  quantity: true,
                  listPrice: true,
                  unitPrice: true,
                  discount: true,
                  total: true,
                },
                orderBy: { id: "asc" },
              },
            },
          },
        },
      });
      if (orderClaim) {
        assertPosOrderClaimContext(orderClaim, {
          version: orderClaim.version,
          branchId: context.branch.id,
          registerId: register.id,
          sessionId: session.id,
          operatorProfileId: context.profile.id,
          terminalId: terminalProof.terminalId,
        });
        assertExactPosOrderCart(
          orderClaim.salesOrder.items,
          items.map((item) => ({
            productId: item.productId,
            variationId: item.variationId,
            quantity: item.quantity,
            discountCents: item.discountCents,
          })),
        );
        if (
          (orderClaim.salesOrder.customerId ?? null) !== customerId ||
          discountCents !== Math.round(orderClaim.salesOrder.discount * 100) ||
          surchargeCents !== 0 ||
          (orderClaim.salesOrder.notes || null) !== notes
        )
          throw new PosOrderClaimError(
            "Cliente, desconto, acréscimo ou observação do rascunho diverge do pedido reivindicado.",
          );
      }
      const existing = await tx.posHeldSale.findUnique({
        where: { id: draftId },
        include: { items: true },
      });
      if (existing) {
        if (
          existing.sessionId !== session.id ||
          existing.registerId !== register.id ||
          existing.operatorProfileId !== context.profile.id ||
          !["draft", "held"].includes(existing.status)
        )
          throw new PosDomainError(
            "O ID do rascunho pertence a outro contexto ou já foi finalizado.",
          );
        if (existing.requestHash === requestHash)
          return { draft: existing, replayed: true };
        if (expectedRevision == null || existing.revision !== expectedRevision)
          throw new PosDomainError(
            "O rascunho mudou no servidor. Recarregue antes de sobrescrever.",
          );
        const [unresolved, manualReferences] = await Promise.all([
          tx.posPaymentIntent.count({
            where: {
              saleDraftId: draftId,
              sessionId: session.id,
              registerId: register.id,
              operatorProfileId: context.profile.id,
              consumedAt: null,
              status: { in: [...POS_DRAFT_RECOVERY_INTENT_STATES] },
            },
          }),
          tx.posManualPaymentReference.count({
            where: {
              saleDraftId: draftId,
              sessionId: session.id,
              registerId: register.id,
              requesterProfileId: context.profile.id,
              consumedSalePaymentId: null,
              status: "pending",
            },
          }),
        ]);
        if (unresolved || manualReferences)
          throw new PosDomainError(
            "O rascunho possui intenção eletrônica ou referência manual ativa. O carrinho não pode divergir até a reconciliação ou cancelamento seguro.",
          );
        await supersedeOpenPosPaymentPlansForDraft(
          tx,
          existing.id,
          context.permission.user.id,
          "recovery-draft-update",
        );
      } else if (expectedRevision != null) {
        throw new PosDomainError(
          "O rascunho esperado não existe mais no servidor.",
        );
      }
      const productIds = [...new Set(items.map((item) => item.productId))];
      const products = await tx.product.findMany({
        where: {
          id: { in: productIds },
          active: true,
          branchConfigurations: {
            some: {
              branchId: context.branch.id,
              active: true,
              saleEnabled: true,
            },
          },
        },
        select: {
          id: true,
          variations: { where: { enabled: true }, select: { id: true } },
        },
      });
      if (products.length !== productIds.length)
        throw new PosDomainError(
          "Um item do rascunho não está disponível nesta filial.",
        );
      const byId = new Map(products.map((product) => [product.id, product]));
      if (
        items.some(
          (item) =>
            item.variationId &&
            !byId
              .get(item.productId)
              ?.variations.some(
                (variation) => variation.id === item.variationId,
              ),
        )
      )
        throw new PosDomainError(
          "Uma variação do rascunho não está disponível.",
        );
      if (
        customerId &&
        !(await tx.customer.findFirst({
          where: { id: customerId, status: "active" },
          select: { id: true },
        }))
      )
        throw new PosDomainError(
          "Cliente do rascunho não encontrado ou inativo.",
        );
      await preparePosHeldSaleItemsCapability(tx, {
        action: existing ? "replace_batch" : "insert",
        heldSaleId: draftId,
        expectedRevision: existing?.revision ?? 0,
        actorUserId: context.permission.user.id,
        idempotencyKey,
        operationalContext: {
          branchId: context.branch.id,
          registerId: register.id,
          sessionId: session.id,
          operatorProfileId: context.profile.id,
          terminalId: terminalProof.terminalId,
          orderClaimId: orderClaim?.id ?? null,
        },
        items,
      });
      const draft = existing
        ? await tx.posHeldSale.update({
            where: { id: existing.id },
            data: {
              customerId,
              notes,
              fulfillmentMode,
              discountCents,
              surchargeCents,
              requestHash,
              revision: { increment: 1 },
              expiresAt: new Date(Date.now() + 7 * 86_400_000),
              items: { deleteMany: {}, create: items },
            },
            include: { items: true },
          })
        : await tx.posHeldSale.create({
            data: {
              id: draftId,
              registerId: register.id,
              sessionId: session.id,
              operatorProfileId: context.profile.id,
              customerId,
              notes,
              fulfillmentMode,
              discountCents,
              surchargeCents,
              status: "draft",
              idempotencyKey,
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 86_400_000),
              items: { create: items },
            },
            include: { items: true },
          });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.permission.user.id,
          action: existing
            ? "pos.cart.draft.updated"
            : "pos.cart.draft.created",
          entityType: "pos_held_sale",
          entityId: draft.id,
          correlationId: randomUUID(),
          afterData: {
            sessionId: session.id,
            registerId: register.id,
            revision: draft.revision,
            itemCount: items.length,
            requestHash,
            idempotencyKey,
          },
        },
      });
      return { draft, replayed: false };
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
  return Response.json(saved, {
    status: saved.replayed ? 200 : expectedRevision == null ? 201 : 200,
    headers: { "cache-control": "no-store" },
  });
}

async function discardRecoveryDraft(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const sessionId = positiveInt(body.sessionId, "Turno"),
    draftId = string(body.saleDraftId, "Rascunho da venda", 100);
  const expectedRevision = integerRange(
      body.expectedRevision,
      0,
      2_147_483_646,
      "Revisão esperada",
    ),
    idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const requestHash = hashPayload({ sessionId, draftId, expectedRevision }),
    session = await ownedBoundOpenSession(
      db,
      context,
      sessionId,
      terminalProof,
    );
  const result = await db.$transaction(
    async (tx) => {
      const openPlanLocators = await tx.posPaymentPlan.findMany({
        where: { saleDraftId: draftId, state: { in: ["quoted", "active"] } },
        select: {
          id: true,
          version: true,
          saleDraftId: true,
          orderClaimId: true,
          orderClaim: { select: { salesOrderId: true } },
        },
        orderBy: { id: "asc" },
      });
      await lockPaymentPlanReleaseAdvisories(tx, openPlanLocators);
      await assertLiveTerminalProof(
        tx,
        context,
        terminalProof,
        session.registerId!,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${session.id} FOR UPDATE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id" = ${terminalProof.terminalId} FOR UPDATE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "pos_order_claims" WHERE "id" = ${draftId} FOR UPDATE`,
      );
      const activeOrderClaim = await tx.posOrderClaim.findFirst({
        where: { id: draftId, state: "active" },
        select: { id: true },
      });
      if (activeOrderClaim)
        throw new PosOrderClaimError(
          "Este rascunho está vinculado à posse ativa de um pedido. Libere o pedido pelo fluxo de claim antes de descartar o carrinho.",
        );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id" = ${draftId} FOR UPDATE`,
      );
      const draft = await tx.posHeldSale.findUnique({ where: { id: draftId } });
      if (
        !draft ||
        draft.sessionId !== session.id ||
        draft.registerId !== session.registerId ||
        draft.operatorProfileId !== context.profile.id
      )
        throw new PosDomainError(
          "Rascunho não encontrado no contexto operacional atual.",
        );
      if (
        draft.status === "discarded" &&
        draft.discardIdempotencyKey === idempotencyKey &&
        draft.discardRequestHash === requestHash
      )
        return { discarded: true, replayed: true };
      if (draft.status !== "draft" || draft.revision !== expectedRevision)
        throw new PosDomainError(
          "O rascunho mudou ou já foi finalizado. Atualize antes de descartar.",
        );
      const [unresolved, manualReferences] = await Promise.all([
        tx.posPaymentIntent.count({
          where: {
            saleDraftId: draft.id,
            sessionId: session.id,
            registerId: session.registerId!,
            operatorProfileId: context.profile.id,
            consumedAt: null,
            status: { in: [...POS_DRAFT_RECOVERY_INTENT_STATES] },
          },
        }),
        tx.posManualPaymentReference.count({
          where: {
            saleDraftId: draft.id,
            sessionId: session.id,
            registerId: session.registerId!,
            requesterProfileId: context.profile.id,
            consumedSalePaymentId: null,
            status: "pending",
          },
        }),
      ]);
      if (unresolved || manualReferences)
        throw new PosDomainError(
          "O rascunho possui intenção eletrônica ou referência manual ativa. Cancele apenas o pré-dispatch ou conclua a reconciliação antes de descartar.",
        );
      await supersedeOpenPosPaymentPlansForDraft(
        tx,
        draft.id,
        context.permission.user.id,
        "recovery-draft-discard",
      );
      const changed = await tx.posHeldSale.updateMany({
        where: { id: draft.id, status: "draft", revision: expectedRevision },
        data: {
          status: "discarded",
          revision: { increment: 1 },
          discardIdempotencyKey: idempotencyKey,
          discardRequestHash: requestHash,
        },
      });
      if (changed.count !== 1)
        throw new PosDomainError("O rascunho mudou durante o descarte.");
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.permission.user.id,
          action: "pos.cart.draft.discarded",
          entityType: "pos_held_sale",
          entityId: draft.id,
          correlationId: randomUUID(),
          beforeData: { status: "draft", revision: expectedRevision },
          afterData: {
            status: "discarded",
            revision: expectedRevision + 1,
            idempotencyKey,
            requestHash,
          },
        },
      });
      return { discarded: true, replayed: false };
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

async function holdCart(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const sessionId = positiveInt(body.sessionId, "Turno");
  const rawItems = array(body.items, "Itens");
  if (!rawItems.length || rawItems.length > 200)
    throw new PosDomainError("O carrinho deve ter entre 1 e 200 itens.");
  const items = rawItems.map((entry) => {
    const item = object(entry);
    return {
      productId: positiveInt(item.productId, "Produto"),
      variationId: optionalPositiveInt(item.variationId),
      quantity: quantity(item.quantity),
      unitPriceCents: cents(item.unitPriceCents, "Preço", true),
      discountCents: cents(item.discountCents || 0, "Desconto", true),
      scanData: limitedObject(item.scanData, "Dados da leitura"),
      notes: optionalString(item.notes, 300),
    };
  });
  const customerId = optionalPositiveInt(body.customerId),
    label = optionalString(body.label, 100),
    notes = optionalString(body.notes, 500);
  const fulfillmentMode = choice(
    body.fulfillmentMode || "on_site",
    ["on_site", "pickup", "delivery"] as const,
    "Modalidade de atendimento",
  );
  const discountCents = cents(body.discountCents || 0, "Desconto", true),
    surchargeCents = cents(body.surchargeCents || 0, "Acréscimo", true);
  const idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const heldSaleId = `held-${hashPayload({ kind: "held-cart", idempotencyKey }).slice(0, 32)}`;
  const requestHash = hashPayload({
    sessionId,
    customerId,
    label,
    notes,
    fulfillmentMode,
    discountCents,
    surchargeCents,
    items,
  });
  const replay = await db.posHeldSale.findUnique({
    where: { idempotencyKey },
    include: { items: true },
  });
  if (replay) {
    await assertStoredSessionTerminalBinding(
      db,
      replay.sessionId,
      terminalProof,
    );
    assertHeldReplayContext(replay, context, requestHash, replay.requestHash);
    if (replay.sessionId !== sessionId)
      throw new PosDomainError(
        "A chave idempotente pertence a outro contexto operacional.",
      );
    return Response.json({ held: replay, replayed: true });
  }
  const session = await ownedBoundOpenSession(
    db,
    context,
    sessionId,
    terminalProof,
  );
  let held;
  try {
    held = await db.$transaction(
      async (tx) => {
        await prelockPosHeldSaleItemWrite(tx, {
          action: "create",
          idempotencyKey,
          heldSaleId,
          sessionIds: [session.id],
          terminalIds: [terminalProof.terminalId],
          branchIds: [context.branch.id],
          registerIds: [session.registerId!],
          operatorProfileIds: [context.profile.id],
          terminalRegisterPairs: [
            [terminalProof.terminalId, session.registerId!],
          ],
          registerBranchPairs: [[session.registerId!, context.branch.id]],
          branchProfilePairs: [[context.branch.id, context.profile.id]],
          registerProfilePairs: [[session.registerId!, context.profile.id]],
        });
        await assertLiveTerminalProof(
          tx,
          context,
          terminalProof,
          session.registerId!,
        );
        if (
          !(await tx.cashRegisterSession.findFirst({
            where: {
              id: session.id,
              registerId: session.registerId,
              operatorProfileId: context.profile.id,
              status: "open",
              version: session.version,
            },
          }))
        )
          throw new PosDomainError("O turno foi fechado ou alterado.");
        const existingProducts = await tx.product.findMany({
          where: {
            id: { in: items.map((item) => item.productId) },
            active: true,
          },
          select: {
            id: true,
            variations: { where: { enabled: true }, select: { id: true } },
          },
        });
        if (
          existingProducts.length !==
          new Set(items.map((item) => item.productId)).size
        )
          throw new PosDomainError(
            "Um item do carrinho não está mais disponível.",
          );
        const productsById = new Map(
          existingProducts.map((product) => [product.id, product]),
        );
        if (
          items.some(
            (item) =>
              item.variationId &&
              !productsById
                .get(item.productId)
                ?.variations.some(
                  (variation) => variation.id === item.variationId,
                ),
          )
        )
          throw new PosDomainError(
            "Uma variação do carrinho não está mais disponível.",
          );
        await preparePosHeldSaleItemsCapability(tx, {
          action: "insert",
          heldSaleId,
          expectedRevision: 0,
          actorUserId: context.permission.user.id,
          idempotencyKey,
          operationalContext: {
            branchId: context.branch.id,
            registerId: session.registerId!,
            sessionId: session.id,
            operatorProfileId: context.profile.id,
            terminalId: terminalProof.terminalId,
            orderClaimId: null,
          },
          items,
        });
        return tx.posHeldSale.create({
          data: {
            id: heldSaleId,
            registerId: session.registerId!,
            sessionId: session.id,
            operatorProfileId: context.profile.id,
            idempotencyKey,
            requestHash,
            customerId,
            label,
            notes,
            fulfillmentMode,
            discountCents,
            surchargeCents,
            expiresAt: new Date(Date.now() + 7 * 86400000),
            items: { create: items },
          },
          include: { items: true },
        });
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const concurrent = await db.posHeldSale.findUnique({
      where: { idempotencyKey },
      include: { items: true },
    });
    if (concurrent) {
      await assertStoredSessionTerminalBinding(
        db,
        concurrent.sessionId,
        terminalProof,
      );
      assertHeldReplayContext(
        concurrent,
        context,
        requestHash,
        concurrent.requestHash,
      );
      if (concurrent.sessionId !== sessionId)
        throw new PosDomainError(
          "A chave idempotente pertence a outro contexto operacional.",
        );
      return Response.json({ held: concurrent, replayed: true });
    }
    throw error;
  }
  return Response.json({ held }, { status: 201 });
}

async function discardCart(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const id = string(body.heldSaleId, "Venda suspensa", 80);
  const expectedRevision = integerRange(
    body.expectedRevision,
    0,
    2_147_483_646,
    "Revisão esperada",
  );
  const idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const requestHash = hashPayload({ heldSaleId: id, expectedRevision });
  const replay = await db.posHeldSale.findUnique({
    where: { discardIdempotencyKey: idempotencyKey },
  });
  if (replay) {
    await assertStoredSessionTerminalBinding(
      db,
      replay.sessionId,
      terminalProof,
    );
    assertHeldReplayContext(
      replay,
      context,
      requestHash,
      replay.discardRequestHash,
    );
    if (replay.id !== id)
      throw new PosDomainError(
        "A chave idempotente pertence a outro contexto operacional.",
      );
    return Response.json({ discarded: true, replayed: true });
  }
  try {
    await db.$transaction(
      async (tx) => {
        const locator = await tx.posHeldSale.findUnique({
          where: { id },
          select: {
            sessionId: true,
            registerId: true,
            operatorProfileId: true,
          },
        });
        if (
          !locator ||
          locator.operatorProfileId !== context.profile.id ||
          !context.registers.some(
            (register) => register.id === locator.registerId,
          )
        )
          throw new PosDomainError("Venda suspensa não encontrada.");
        const openPlanLocators = await tx.posPaymentPlan.findMany({
          where: { saleDraftId: id, state: { in: ["quoted", "active"] } },
          select: {
            id: true,
            version: true,
            saleDraftId: true,
            orderClaimId: true,
            orderClaim: { select: { salesOrderId: true } },
          },
          orderBy: { id: "asc" },
        });
        await lockPaymentPlanReleaseAdvisories(tx, openPlanLocators);
        await assertLiveTerminalProof(
          tx,
          context,
          terminalProof,
          terminalProof.registerId,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${locator.sessionId} FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id" = ${terminalProof.terminalId} FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id" = ${id} FOR UPDATE`,
        );
        const held = await tx.posHeldSale.findFirst({
          where: {
            id,
            operatorProfileId: context.profile.id,
            registerId: { in: context.registers.map((item) => item.id) },
            status: "held",
          },
        });
        if (!held) throw new PosDomainError("Venda suspensa não encontrada.");
        if (held.registerId !== terminalProof.registerId)
          throw new PosTerminalBoundaryError(
            "A venda suspensa pertence a outro caixa.",
            403,
          );
        const boundSession = await tx.cashRegisterSession.findUnique({
          where: { id: held.sessionId },
          select: {
            registerId: true,
            openingAmountCents: true,
            openRequestHash: true,
          },
        });
        if (!boundSession)
          throw new PosDomainError(
            "O turno da venda suspensa não foi encontrado.",
          );
        assertPosSessionTerminalBinding(boundSession, terminalProof);
        if (held.revision !== expectedRevision)
          throw new PosDomainError(
            "A revisão da venda suspensa está desatualizada. Recarregue o PDV.",
          );
        await supersedeOpenPosPaymentPlansForDraft(
          tx,
          held.id,
          context.permission.user.id,
          "held-cart-discard",
        );
        const changed = await tx.posHeldSale.updateMany({
          where: {
            id: held.id,
            status: "held",
            revision: expectedRevision,
            registerId: held.registerId,
            sessionId: held.sessionId,
            operatorProfileId: held.operatorProfileId,
            discardIdempotencyKey: null,
          },
          data: {
            status: "discarded",
            discardIdempotencyKey: idempotencyKey,
            discardRequestHash: requestHash,
          },
        });
        if (changed.count !== 1)
          throw new PosDomainError(
            "A venda suspensa foi alterada por outra operação.",
          );
        const exchange = await tx.posReturn.findUnique({
          where: { exchangeHeldSaleId: held.id },
          include: { sale: { select: { id: true, branchId: true } } },
        });
        if (exchange) {
          if (
            exchange.sale.branchId !== context.branch.id ||
            exchange.exchangeStatus !== "draft"
          )
            throw new PosDomainError(
              "O vínculo de troca não pertence ao contexto operacional atual.",
            );
          const cancelledAt = new Date(),
            correlationId = randomUUID();
          const exchangeChanged = await tx.posReturn.updateMany({
            where: {
              id: exchange.id,
              exchangeStatus: "draft",
              exchangeSaleId: null,
            },
            data: {
              exchangeStatus: "cancelled",
              exchangeCancelledAt: cancelledAt,
            },
          });
          if (exchangeChanged.count !== 1)
            throw new PosDomainError(
              "A troca foi alterada por outra operação.",
            );
          await tx.posSaleEvent.create({
            data: {
              saleId: exchange.sale.id,
              type: "sale.exchange.cancelled",
              actorId: context.permission.user.id,
              actorName: context.profile.displayName,
              correlationId,
              data: {
                returnId: exchange.id,
                heldSaleId: held.id,
                idempotencyKey,
              },
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: context.permission.user.id,
              action: "pos.exchange.cancelled",
              entityType: "pos_return",
              entityId: exchange.id,
              correlationId,
              beforeData: { exchangeStatus: "draft", heldSaleId: held.id },
              afterData: {
                exchangeStatus: "cancelled",
                cancelledAt: cancelledAt.toISOString(),
              },
            },
          });
        }
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const concurrent = await db.posHeldSale.findUnique({
      where: { discardIdempotencyKey: idempotencyKey },
    });
    if (concurrent) {
      await assertStoredSessionTerminalBinding(
        db,
        concurrent.sessionId,
        terminalProof,
      );
      assertHeldReplayContext(
        concurrent,
        context,
        requestHash,
        concurrent.discardRequestHash,
      );
      if (concurrent.id !== id)
        throw new PosDomainError(
          "A chave idempotente pertence a outro contexto operacional.",
        );
      return Response.json({ discarded: true, replayed: true });
    }
    throw error;
  }
  return Response.json({ discarded: true });
}

type PosRequestedSaleLine = {
  productId: number;
  variationId: number | null;
  quantity: number;
  discountCents: number;
  scanData: Prisma.InputJsonObject | undefined;
};

async function quotePromotion(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const session = await ownedBoundOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  if (!register.access.canSell)
    throw new PosDomainError("Você não pode vender neste caixa.");
  const saleDraftId = string(body.saleDraftId, "Rascunho da venda", 100);
  const orderClaimId = optionalString(body.orderClaimId, 120),
    orderClaimVersion =
      body.orderClaimVersion == null
        ? null
        : integerRange(
            body.orderClaimVersion,
            0,
            2_147_483_647,
            "Versão da posse do pedido",
          );
  if (
    Boolean(orderClaimId) !== (orderClaimVersion != null) ||
    (orderClaimId && saleDraftId !== orderClaimId)
  )
    throw new PosOrderClaimError(
      "A cotação do pedido exige claim e versão exatos.",
      422,
    );
  const approvalId = optionalString(body.discountApprovalId, 120);
  const requested = requestedSaleLines(body);
  const customerId = optionalPositiveInt(body.customerId);
  const orderDiscountCents = cents(body.discountCents || 0, "Desconto", true);
  const surchargeCents = cents(body.surchargeCents || 0, "Acréscimo", true);
  const outcome = await db.$transaction(
    async (tx) => {
      // Keep quote preparation locator-only. persistQuotedPosPaymentPlan invokes
      // the graph capability, which acquires every advisory namespace before the
      // canonical session/terminal/access/claim/draft roots.
      const liveSession = await tx.cashRegisterSession.findFirst({
        where: { id: session.id, registerId: register.id, status: "open" },
      });
      if (!liveSession)
        throw new PosDomainError(
          "O turno foi fechado ou alterado. Atualize o PDV.",
        );
      const liveAccess = await liveRegisterSaleAccess(tx, context, register.id);
      const configuration = await tx.tenantSettings.findUnique({
        where: { id: 1 },
      });
      if (!configuration)
        throw new PosDomainError(
          "Configurações da organização não inicializadas.",
        );
      const customer = customerId
        ? await tx.customer.findFirst({
            where: { id: customerId, status: "active" },
          })
        : null;
      if (customerId && !customer)
        throw new PosDomainError("Cliente não encontrado ou inativo.");
      if (configuration.requireCustomer && !customer)
        throw new PosDomainError(
          "Identifique o cliente antes de calcular a oferta.",
        );
      const orderClaim = orderClaimId
        ? await tx.posOrderClaim.findFirst({
            where: {
              id: orderClaimId,
              branchId: context.branch.id,
              registerId: register.id,
              sessionId: session.id,
              operatorProfileId: context.profile.id,
              state: "active",
              version: orderClaimVersion!,
              leaseExpiresAt: { gt: new Date() },
            },
          })
        : null;
      if (orderClaimId && !orderClaim)
        throw new PosOrderClaimError(
          "A posse do pedido expirou ou mudou antes da cotação.",
        );
      const claimedOrder: PosClaimableOrder | null = orderClaim
        ? await tx.salesOrder.findFirst({
            where: { id: orderClaim.salesOrderId, branchId: context.branch.id },
            include: posOrderInclude,
          })
        : null;
      if (orderClaim && !claimedOrder)
        throw new PosOrderClaimError(
          "O pedido do claim não pertence mais a esta filial.",
        );
      if (claimedOrder) {
        assertPosOrderEligible(claimedOrder, context.branch.id);
        assertExactPosOrderCart(claimedOrder.items, requested);
        if (
          (claimedOrder.customerId ?? null) !== customerId ||
          orderDiscountCents !== Math.round(claimedOrder.discount * 100) ||
          surchargeCents !== 0
        )
          throw new PosOrderClaimError(
            "Cliente ou ajustes da cotação divergem do pedido aprovado.",
          );
      }
      const coupon = await couponIdentityForRequest(
        tx,
        context,
        body.couponCode,
        body.couponQrToken,
      );
      const quoted = await authoritativePromotionQuote(
        tx,
        context,
        saleDraftId,
        requested,
        customer?.id ?? null,
        orderDiscountCents,
        surchargeCents,
        coupon?.hash ?? null,
        new Date(),
        false,
      );
      if (claimedOrder)
        assertExactPosOrderPricing(claimedOrder, {
          promotionId: quoted.award?.promotionId ?? null,
          subtotalCents: quoted.basePricing.subtotalCents,
          manualDiscountCents: orderDiscountCents,
          surchargeCents,
          totalCents: quoted.pricing.totalCents,
          lines: quoted.basePricing.lines.map((line) => ({
            productId: line.productId,
            variationId: line.variationId ?? null,
            unitPriceCents: line.unitPriceCents,
            discountCents: line.discountCents,
            totalCents: line.totalCents,
          })),
        });
      const discountApproval = buildPosDiscountApproval({
        saleDraftId,
        sessionId: session.id,
        grossCents: quoted.basePricing.lines.reduce(
          (sum, item) => sum + item.grossCents,
          0,
        ),
        orderDiscountCents,
        lineDiscountCents: quoted.basePricing.lines.reduce(
          (sum, item) => sum + item.discountCents,
          0,
        ),
        settingsMaximumPercent: configuration.maxDiscountPercent,
        accessMaximumBasisPoints: liveAccess.maxDiscountBasisPoints,
      });
      if (discountApproval.requiresApproval) {
        if (!approvalId)
          throw new PosDomainError(
            "O desconto manual supera sua alçada. Solicite uma aprovação excepcional para este rascunho.",
          );
        await assertApprovedPosAction(
          tx,
          context,
          approvalId,
          "discount.override",
          "sale_draft",
          saleDraftId,
          discountApproval.context,
        );
      }
      const persistedPlan = await persistQuotedPosPaymentPlan(tx, {
        branchId: context.branch.id,
        registerId: register.id,
        sessionId: session.id,
        operatorProfileId: context.profile.id,
        terminalId: terminalProof.terminalId,
        actorUserId: context.permission.user.id,
        saleDraftId,
        orderClaimId,
        quoteHash: quoted.quoteHash,
        totalCents: quoted.pricing.totalCents,
        evaluatedAt: quoted.evaluatedAt,
        promotionId: quoted.award?.promotionId ?? null,
        couponId: quoted.award?.couponId ?? null,
        promotionDiscountCents: quoted.promotionDiscountCents,
        quoteLines: quoted.persistedLines.map((line, index) => {
          const base = quoted.basePricing.lines[index];
          const promotionDiscountCents =
            quoted.award?.allocations.find(
              (allocation) =>
                allocation.lineId ===
                `${line.productId}:${line.variationId || 0}`,
            )?.discountCents ?? 0;
          return {
            productId: line.productId,
            variationId: line.variationId ?? null,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            grossCents: line.grossCents,
            baseDiscountCents: base.discountCents,
            orderDiscountCents:
              line.discountCents - base.discountCents - promotionDiscountCents,
            promotionDiscountCents,
            surchargeCents: line.surchargeCents,
            totalCents: line.totalCents,
          };
        }),
      });
      return { quoted, discountApproval, paymentPlan: persistedPlan.plan };
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
  return Response.json({
    quote: publicPromotionQuote(
      outcome.quoted,
      outcome.discountApproval,
      approvalId,
    ),
    paymentPlan: posPaymentPlanDto(outcome.paymentPlan),
  });
}

function requestedSaleLines(body: Record<string, unknown>) {
  const rawItems = array(body.items, "Itens");
  if (!rawItems.length || rawItems.length > 200)
    throw new PosDomainError("A venda deve ter entre 1 e 200 itens.");
  const requested: PosRequestedSaleLine[] = rawItems.map((entry) => {
    const item = object(entry);
    return {
      productId: positiveInt(item.productId, "Produto"),
      variationId: optionalPositiveInt(item.variationId),
      quantity: quantity(item.quantity),
      discountCents: cents(item.discountCents || 0, "Desconto do item", true),
      scanData: limitedObject(item.scanData, "Dados da leitura"),
    };
  });
  if (
    new Set(
      requested.map((item) => `${item.productId}:${item.variationId || 0}`),
    ).size !== requested.length
  )
    throw new PosDomainError(
      "Consolide itens repetidos da mesma variação antes de concluir.",
    );
  return requested;
}

function assertRecoveryDraftMatchesCommit(
  draft: {
    customerId: number | null;
    notes: string | null;
    discountCents: number;
    surchargeCents: number;
    items: Array<{
      productId: number;
      variationId: number | null;
      quantity: number;
      discountCents: number;
      scanData: Prisma.JsonValue | null;
    }>;
  },
  input: {
    customerId: number | null;
    notes: string | null;
    discountCents: number;
    surchargeCents: number;
    items: PosRequestedSaleLine[];
  },
) {
  const itemSnapshot = (
    items: Array<{
      productId: number;
      variationId: number | null;
      quantity: number;
      discountCents: number;
      scanData?: Prisma.JsonValue | Prisma.InputJsonObject;
    }>,
  ) =>
    items
      .map((item) => ({
        productId: item.productId,
        variationId: item.variationId,
        quantity: item.quantity,
        discountCents: item.discountCents,
        scanData: item.scanData ?? null,
      }))
      .sort(
        (left, right) =>
          left.productId - right.productId ||
          (left.variationId || 0) - (right.variationId || 0),
      );
  const persistedHash = hashPayload({
    customerId: draft.customerId,
    notes: draft.notes,
    discountCents: draft.discountCents,
    surchargeCents: draft.surchargeCents,
    items: itemSnapshot(draft.items),
  });
  const submittedHash = hashPayload({
    customerId: input.customerId,
    notes: input.notes,
    discountCents: input.discountCents,
    surchargeCents: input.surchargeCents,
    items: itemSnapshot(input.items),
  });
  if (persistedHash !== submittedHash)
    throw new PosDomainError(
      "O carrinho diverge do rascunho persistido vinculado ao pagamento. Recarregue e reconcilie antes de concluir.",
    );
}

function couponIdentity(value: unknown) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = normalizePosCouponCode(value);
  return { hash: hashPosCouponCode(normalized) };
}

async function couponIdentityForRequest(
  tx: Prisma.TransactionClient,
  context: Access,
  codeValue: unknown,
  qrValue: unknown,
) {
  const code = couponIdentity(codeValue),
    qr = optionalString(qrValue, 2_048);
  if (code && qr)
    throw new PosDomainError(
      "Informe cupom por texto ou QR, não os dois ao mesmo tempo.",
    );
  if (!qr) return code;
  const couponId = await resolveInternalQrEntity(tx, context, qr, "coupon");
  const coupon = await tx.posCoupon.findUnique({
    where: { id: couponId },
    select: { codeHash: true },
  });
  if (!coupon)
    throw new PosDomainError("Cupom do QR não está mais disponível.");
  return { hash: coupon.codeHash };
}

async function resolveInternalQrEntity(
  tx: Prisma.TransactionClient,
  context: Access,
  token: string,
  expectedKind: "coupon" | "gift_card" | "order",
) {
  const keyring = loadPosInternalQrKeyring();
  const payload = verifyPosInternalQr(token, {
    organizationId: context.organizationId,
    branchId: context.branch.id,
    keys: keyring.keys,
  });
  if (payload.kind !== expectedKind)
    throw new PosDomainError(
      `O QR informado não representa ${expectedKind === "coupon" ? "um cupom" : expectedKind === "gift_card" ? "um gift card" : "um pedido"}.`,
    );
  const keyId = token.split(".")[2] || "",
    now = new Date();
  const record = await tx.posInternalQrIssuance.findFirst({
    where: {
      branchId: context.branch.id,
      kind: expectedKind,
      reference: payload.reference,
      keyId,
      nonce: payload.nonce,
      tokenHash: hashPosInternalQr(token),
      status: "active",
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (!record)
    throw new PosDomainError(
      "QR interno revogado, expirado ou indisponível nesta filial.",
    );
  return payload.reference.slice(payload.reference.indexOf(":") + 1);
}

async function authoritativePromotionQuote(
  tx: Prisma.TransactionClient,
  context: Access,
  saleDraftId: string,
  requested: PosRequestedSaleLine[],
  customerId: number | null,
  orderDiscountCents: number,
  surchargeCents: number,
  couponCodeHash: string | null,
  evaluatedAt: Date,
  lockForCommit: boolean,
) {
  const productIds = [...new Set(requested.map((item) => item.productId))];
  const products = await tx.product.findMany({
    where: {
      id: { in: productIds },
      active: true,
      branchConfigurations: {
        some: { branchId: context.branch.id, active: true, saleEnabled: true },
      },
    },
    include: {
      branchConfigurations: { where: { branchId: context.branch.id } },
      variations: { where: { enabled: true } },
      categoryLinks: { select: { categoryId: true } },
    },
  });
  if (products.length !== productIds.length)
    throw new PosDomainError("Um produto não está disponível nesta filial.");
  const byId = new Map(products.map((item) => [item.id, item]));
  const basePricing = pricePosCart(
    requested.map((item) => {
      const product = byId.get(item.productId)!,
        variation = item.variationId
          ? product.variations.find(
              (candidate) => candidate.id === item.variationId,
            )
          : null;
      if (item.variationId && !variation)
        throw new PosDomainError(
          `A variação de ${product.name} não está disponível.`,
        );
      if (product.soldIndividually && item.quantity !== 1)
        throw new PosDomainError(
          `${product.name} deve ser vendido individualmente.`,
        );
      const basePrice =
        product.branchConfigurations[0]?.priceOverride ??
        currentPrice(product, evaluatedAt.valueOf());
      return {
        ...item,
        unitPriceCents: Math.round(
          (variation
            ? currentVariationPrice(variation, basePrice, evaluatedAt.valueOf())
            : basePrice) * 100,
        ),
      };
    }),
    orderDiscountCents,
    surchargeCents,
  );
  await assertAuthoritativePosCodeReads(
    tx,
    context.branch.id,
    basePricing.lines.map((line) => ({
      productId: line.productId,
      variationId: line.variationId ?? null,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      productUnit: byId.get(line.productId)!.unit,
      scanData: requested.find(
        (item) =>
          item.productId === line.productId &&
          (item.variationId || null) === (line.variationId || null),
      )?.scanData,
    })),
  );
  const kitPlans = await resolvePosKitPlans(tx, {
    branchId: context.branch.id,
    evaluatedAt,
    lockForCommit,
    lines: requested.map((line) => ({
      productId: line.productId,
      variationId: line.variationId,
      quantity: line.quantity,
      productType: byId.get(line.productId)!.type,
    })),
  });

  const manualAllocations = allocateCents(
    orderDiscountCents,
    basePricing.lines.map((line) => line.totalCents),
  );
  const promotionRows = await tx.posPromotion.findMany({
    where: {
      status: "active",
      startsAt: { lte: evaluatedAt },
      AND: [
        { OR: [{ endsAt: null }, { endsAt: { gt: evaluatedAt } }] },
        { OR: [{ branchId: null }, { branchId: context.branch.id }] },
      ],
    },
    orderBy: { id: "asc" },
  });
  const coupon = couponCodeHash
    ? await tx.posCoupon.findUnique({ where: { codeHash: couponCodeHash } })
    : null;
  if (couponCodeHash && !coupon)
    throw new PosDomainError("Cupom inválido, expirado ou indisponível.");
  if (lockForCommit && promotionRows.length) {
    const ids = promotionRows.map((promotion) => promotion.id).sort();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "pos_promotions" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`,
    );
  }
  if (lockForCommit && coupon)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "pos_coupons" WHERE "id" = ${coupon.id} FOR UPDATE`,
    );

  let rules;
  try {
    rules = promotionRows.map((promotion) => buildPosPromotionRule(promotion));
  } catch (error) {
    if (error instanceof PosPromotionDomainError)
      throw new PosDomainError(
        `Configuração promocional inválida: ${error.message}`,
      );
    throw error;
  }
  const promotionIds = rules.map((rule) => rule.id);
  const [totalUsage, customerUsage] = promotionIds.length
    ? await Promise.all([
        tx.posPromotionRedemption.groupBy({
          by: ["promotionId"],
          where: { promotionId: { in: promotionIds }, reversedAt: null },
          _count: { _all: true },
        }),
        customerId == null
          ? Promise.resolve([])
          : tx.posPromotionRedemption.groupBy({
              by: ["promotionId"],
              where: {
                promotionId: { in: promotionIds },
                customerId,
                reversedAt: null,
              },
              _count: { _all: true },
            }),
      ])
    : [[], []];
  const totalByPromotion = new Map(
    totalUsage.map((entry) => [entry.promotionId, entry._count._all]),
  );
  const customerByPromotion = new Map(
    customerUsage.map((entry) => [entry.promotionId, entry._count._all]),
  );
  const usageByPromotionId = Object.fromEntries(
    promotionIds.map((promotionId) => [
      promotionId,
      {
        totalUsed: totalByPromotion.get(promotionId) ?? 0,
        ...(customerId == null
          ? {}
          : { customerUsed: customerByPromotion.get(promotionId) ?? 0 }),
      },
    ]),
  );
  const evaluation = evaluatePosPromotions({
    now: evaluatedAt,
    branchId: context.branch.id,
    customerId,
    lines: basePricing.lines.map((line, index) => {
      const product = byId.get(line.productId)!;
      return {
        lineId: `${line.productId}:${line.variationId || 0}`,
        productId: line.productId,
        categoryId: product.categoryId,
        categoryIds: [
          ...new Set(
            [
              product.categoryId,
              ...product.categoryLinks.map((link) => link.categoryId),
            ].filter((id): id is number => id != null),
          ),
        ],
        quantity: line.quantity,
        subtotalCents: line.totalCents - manualAllocations[index],
      };
    }),
    promotions: rules,
    usageByPromotionId,
    coupon: coupon
      ? {
          id: coupon.id,
          promotionId: coupon.promotionId,
          status: coupon.status,
          usageLimit: coupon.usageLimit,
          usedCount: coupon.usedCount,
          expiresAt: coupon.expiresAt,
        }
      : null,
  });
  if (coupon) {
    const couponRule = rules.find((rule) => rule.id === coupon.promotionId);
    const couponEvaluation = evaluation.evaluations.find(
      (entry) => entry.promotionId === coupon.promotionId,
    );
    if (!couponRule?.conditions.couponRequired || !couponEvaluation?.eligible)
      throw new PosDomainError("Cupom inválido, expirado ou indisponível.");
  }
  const promotionDiscountCents = evaluation.award?.discountCents ?? 0;
  const pricing = pricePosCart(
    basePricing.lines.map((line) => ({
      productId: line.productId,
      variationId: line.variationId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
    })),
    orderDiscountCents + promotionDiscountCents,
    surchargeCents,
  );
  const promotionByLine = new Map(
    evaluation.award?.allocations.map((allocation) => [
      allocation.lineId,
      allocation.discountCents,
    ]) ?? [],
  );
  const netBeforeSurcharge = basePricing.lines.map(
    (line, index) =>
      line.totalCents -
      manualAllocations[index] -
      (promotionByLine.get(`${line.productId}:${line.variationId || 0}`) ?? 0),
  );
  const surchargeAllocations = allocateCents(
    surchargeCents,
    netBeforeSurcharge,
  );
  const persistedLines = basePricing.lines.map((line, index) => {
    const promotionDiscount =
      promotionByLine.get(`${line.productId}:${line.variationId || 0}`) ?? 0;
    const discountCents =
      line.discountCents + manualAllocations[index] + promotionDiscount;
    return {
      ...line,
      discountCents,
      surchargeCents: surchargeAllocations[index],
      totalCents: line.grossCents - discountCents + surchargeAllocations[index],
    };
  });
  for (const line of persistedLines) {
    const product = byId.get(line.productId)!;
    if (
      product.minimumSalePrice != null &&
      line.totalCents <
        Math.round(product.minimumSalePrice * line.quantity * 100)
    )
      throw new PosDomainError(
        `O preço líquido de ${product.name} ficou abaixo do mínimo permitido.`,
      );
  }
  const quoteHash = hashPayload({
    version: 3,
    saleDraftId,
    branchId: context.branch.id,
    customerId,
    couponCodeHash,
    orderDiscountCents,
    surchargeCents,
    lines: basePricing.lines.map((line) => ({
      productId: line.productId,
      variationId: line.variationId ?? null,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      itemDiscountCents: line.discountCents,
    })),
    kits: posKitSnapshotForHash(kitPlans),
    promotion: evaluation.award
      ? {
          id: evaluation.award.promotionId,
          discountCents: evaluation.award.discountCents,
          conditions: evaluation.award.snapshot.conditions,
          effect: evaluation.award.snapshot.effect,
        }
      : null,
    totalCents: pricing.totalCents,
  });
  return {
    byId,
    basePricing,
    pricing,
    persistedLines,
    kitPlans,
    award: evaluation.award,
    coupon,
    quoteHash,
    orderDiscountCents,
    promotionDiscountCents,
    surchargeCents,
    evaluatedAt,
  };
}

function publicPromotionQuote(
  quoted: Awaited<ReturnType<typeof authoritativePromotionQuote>>,
  discountApproval: ReturnType<typeof buildPosDiscountApproval>,
  approvalId: string | null,
) {
  return {
    quoteHash: quoted.quoteHash,
    promotionId: quoted.award?.promotionId ?? null,
    promotionName: quoted.award?.promotionName ?? null,
    couponLastFour: quoted.award?.couponId
      ? (quoted.coupon?.codeLastFour ?? null)
      : null,
    subtotalCents: quoted.basePricing.subtotalCents,
    manualDiscountCents: discountApproval.context.manualDiscountCents,
    manualDiscountBasisPoints: discountApproval.context.basisPoints,
    discountApprovalRequired: discountApproval.requiresApproval,
    discountApprovalId: discountApproval.requiresApproval ? approvalId : null,
    promotionDiscountCents: quoted.promotionDiscountCents,
    surchargeCents: quoted.surchargeCents,
    totalCents: quoted.pricing.totalCents,
    kits: [...quoted.kitPlans.values()].map((plan) => ({
      lineKey: plan.lineKey,
      bomId: plan.root.id,
      version: plan.root.version,
      name: plan.root.name,
      componentCount: plan.components.length,
    })),
    evaluatedAt: quoted.evaluatedAt.toISOString(),
  };
}

async function commitSale(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const sessionId = positiveInt(body.sessionId, "Turno");
  const idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const paymentPlanId = string(body.paymentPlanId, "Plano de pagamento", 160);
  const paymentPlanVersion = integerRange(
    body.paymentPlanVersion,
    0,
    2_147_483_646,
    "Versão do plano de pagamento",
  );
  const heldSaleId = optionalString(body.heldSaleId, 80);
  const orderClaimId = optionalString(body.orderClaimId, 120);
  const orderClaimVersion =
    body.orderClaimVersion == null
      ? null
      : integerRange(
          body.orderClaimVersion,
          0,
          2_147_483_647,
          "Versão da posse do pedido",
        );
  if (Boolean(orderClaimId) !== (orderClaimVersion != null))
    throw new PosOrderClaimError(
      "Informe a posse e a versão do pedido juntas.",
      422,
    );
  if (orderClaimId && idempotencyKey !== orderClaimId)
    throw new PosOrderClaimError(
      "A conversão do pedido deve usar o claim como chave do rascunho e da venda.",
    );
  if (orderClaimId && heldSaleId)
    throw new PosOrderClaimError(
      "Pedido reivindicado não pode ser combinado com venda suspensa ou troca.",
    );
  const discountApprovalId = optionalString(body.discountApprovalId, 120);
  const couponCode = couponIdentity(body.couponCode),
    couponQrToken = optionalString(body.couponQrToken, 2_048);
  if (couponCode && couponQrToken)
    throw new PosDomainError(
      "Informe cupom por texto ou QR, não os dois ao mesmo tempo.",
    );
  const requestHash = saleCommitRequestHash(
    body,
    couponCode?.hash ?? null,
    couponQrToken,
  );
  const replay = await db.sale.findUnique({
    where: { idempotencyKey },
    include: {
      payments: true,
      items: true,
      promotionUses: {
        select: {
          promotionId: true,
          couponId: true,
          discountCents: true,
          snapshot: true,
          promotion: { select: { name: true } },
        },
      },
    },
  });
  if (replay) {
    if (!replay.sessionId)
      throw new PosTerminalBoundaryError(
        "A venda não possui turno vinculado ao terminal.",
        409,
      );
    await assertStoredSessionTerminalBinding(
      db,
      replay.sessionId,
      terminalProof,
    );
    if (
      replay.branchId !== context.branch.id ||
      replay.sessionId !== sessionId ||
      replay.operatorProfileId !== context.profile.id
    )
      throw new PosDomainError(
        "A chave idempotente pertence a outro contexto operacional.",
      );
    if (replay.requestHash !== requestHash)
      throw new PosDomainError(
        "A chave idempotente já foi usada com outro conteúdo.",
      );
    const consumedPlan = await db.posPaymentPlan.findUnique({
      where: { id: paymentPlanId },
    });
    if (
      !consumedPlan ||
      consumedPlan.state !== "consumed" ||
      consumedPlan.consumedSaleId !== replay.id ||
      consumedPlan.version !== paymentPlanVersion + 1
    )
      throw new PosPaymentPlanError(
        "O replay não corresponde ao plano autoritativo consumido por esta venda.",
      );
    if (orderClaimId)
      await assertConvertedOrderClaimReplay(
        db,
        replay.id,
        orderClaimId,
        orderClaimVersion!,
        sessionId,
        context,
        terminalProof,
      );
    return Response.json({ sale: replay, replayed: true });
  }
  const session = await ownedBoundOpenSession(
    db,
    context,
    sessionId,
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  if (!register.access.canSell)
    throw new PosDomainError("Você não pode vender neste caixa.");
  const requested = requestedSaleLines(body);
  const customerId = optionalPositiveInt(body.customerId);
  const fulfillmentMode = choice(
    body.fulfillmentMode || "on_site",
    ["on_site", "pickup", "delivery"] as const,
    "Modalidade de atendimento",
  );
  if (orderClaimId && fulfillmentMode !== "pickup")
    throw new PosOrderClaimError(
      "Pedidos aprovados devem ser concluídos na modalidade Retirada.",
      422,
    );
  const saleNotes = optionalString(body.notes, 1000);
  const rawPayments = array(body.payments, "Pagamentos");
  if (!rawPayments.length || rawPayments.length > 10)
    throw new PosDomainError("Informe entre 1 e 10 pagamentos.");
  const paymentExecutions = rawPayments.map(
    (entry): PosPaymentPlanExecutionInput => {
      const item = object(entry);
      assertSalePaymentKeys(item);
      const manualReferenceId = optionalString(item.manualReferenceId, 120);
      const paymentIntentId = optionalString(item.paymentIntentId, 120);
      const valueAccountId = optionalString(item.valueAccountId, 160),
        giftCode = optionalString(item.giftCode, 160),
        giftPin = optionalString(item.giftPin, 20),
        giftQrToken = optionalString(item.giftQrToken, 2_048);
      const valueUnits =
        item.valueUnits == null
          ? null
          : integerRange(
              item.valueUnits,
              1,
              9_000_000_000_000_000,
              "Unidades de valor",
            );
      const valueModes =
        Number(Boolean(valueAccountId)) +
        Number(Boolean(giftCode)) +
        Number(Boolean(giftQrToken));
      const externalProofs =
        Number(Boolean(manualReferenceId)) + Number(Boolean(paymentIntentId));
      if (externalProofs > 1 || valueModes > 1)
        throw new PosDomainError(
          "Cada divisão aceita uma única prova financeira.",
        );
      if (
        manualReferenceId &&
        !register.access.canManualPayment &&
        !context.privileged
      )
        throw new PosDomainError(
          "Confirmação manual de pagamento não autorizada para este operador.",
        );
      return {
        tenderedCents:
          item.tenderedCents == null
            ? undefined
            : cents(item.tenderedCents, "Valor recebido"),
        manualReferenceId: manualReferenceId || undefined,
        paymentIntentId: paymentIntentId || undefined,
        valueAccountId: valueAccountId || undefined,
        valueUnits: valueUnits ?? undefined,
        giftCode: giftCode || undefined,
        giftPin: giftPin || undefined,
        giftQrToken: giftQrToken || undefined,
      };
    },
  );
  // Every submitted split materializes exactly one payment row: local splits
  // are nested in sale.create and captured intents are materialized immediately
  // afterwards.  Serialize all of their real idempotency identities before
  // looking up or locking the authoritative payment graph.
  const nestedPaymentInsertKeys = paymentExecutions.map(
    (_, index) => `${idempotencyKey}:payment:${index}`,
  );
  // This locator is transport only: it contributes the sales-order advisory
  // namespace and is never trusted for a business decision.  The claim/order
  // graph is reread after the canonical prelock inside the transaction.
  const [orderClaimLocator, paymentPlanLocator] = await Promise.all([
    orderClaimId
      ? db.posOrderClaim.findUnique({
          where: { id: orderClaimId },
          select: { salesOrderId: true },
        })
      : null,
    db.posPaymentPlan.findUnique({
      where: { id: paymentPlanId },
      select: { orderClaimId: true, saleDraftId: true },
    }),
  ]);
  if (!paymentPlanLocator)
    throw new PosPaymentPlanError("Plano de pagamento não encontrado.", 404);
  if (orderClaimId && paymentPlanLocator.orderClaimId !== orderClaimId) {
    throw new PosOrderClaimError(
      "O plano informado não pertence à posse do pedido.",
    );
  }
  if (orderClaimId && paymentPlanLocator.saleDraftId !== orderClaimId) {
    throw new PosOrderClaimError(
      "A identidade do draft deve ser o claim exato do pedido.",
    );
  }
  if (paymentPlanLocator.saleDraftId !== idempotencyKey)
    throw new PosPaymentPlanError(
      "O plano não pertence à identidade idempotente desta venda.",
    );
  const consumeOperationKey = `${idempotencyKey}:payment-plan:consume`;
  const manualReferenceIds = paymentExecutions.flatMap((payment) =>
    payment.manualReferenceId ? [payment.manualReferenceId] : [],
  );
  const manualReferenceOperationKeys = manualReferenceIds.map((id) =>
    manualReferenceConsumeOperationKey(idempotencyKey, id),
  );
  // Reserve every payment identity before the transaction so a manual-reference
  // consume root can bind its causal payment before the nested sale write.
  const paymentRowIds = paymentExecutions.map(() => randomUUID());
  const manualReferenceSlots = paymentExecutions.flatMap(
    (payment, paymentIndex) =>
      payment.manualReferenceId
        ? [{ planId: paymentPlanId, paymentIndex }]
        : [],
  );
  const manualReferenceSalePaymentIds = paymentExecutions.flatMap(
    (payment, paymentIndex) =>
      payment.manualReferenceId ? [paymentRowIds[paymentIndex]!] : [],
  );
  const commitPreRootAdvisoryNamespaces = [
    ...paymentExecutions.flatMap((payment) =>
      payment.paymentIntentId
        ? [`pos-payment-intent-graph:existing:${payment.paymentIntentId}`]
        : [],
    ),
    `pos-held-sale-items:v1:held-sale:${paymentPlanLocator.saleDraftId}`,
    `t2-payment-plan:aggregate:${paymentPlanId}`,
    `t2-payment-plan:draft:${paymentPlanLocator.saleDraftId}`,
    `t2-payment-plan:idempotency:${consumeOperationKey}`,
    ...manualReferenceIds.map(
      (id) => `pos-manual-payment-reference:v1:reference:${id}`,
    ),
    ...manualReferenceOperationKeys.map(
      (key) => `pos-manual-payment-reference:v1:operation:${key}`,
    ),
    ...manualReferenceSlots.map(
      (slot) =>
        `pos-manual-payment-reference:v1:slot:${slot.planId}:${slot.paymentIndex}`,
    ),
    ...manualReferenceSalePaymentIds.map(
      (id) => `pos-manual-payment-reference:v1:sale-payment:${id}`,
    ),
    ...nestedPaymentInsertKeys.map((key) => `pos-sale-payment-insert:${key}`),
    ...(orderClaimId
      ? [
          `pos-order-claim:${orderClaimId}`,
          `pos-order-claim:v1:artifacts:${orderClaimId}`,
          `pos-order-claim-operation:${orderClaimId}:convert`,
          `pos-order-claim:v1:claim:${orderClaimId}`,
          ...(orderClaimLocator
            ? [
                `sales-order:${orderClaimLocator.salesOrderId}`,
                `pos-order-claim:v1:order:${orderClaimLocator.salesOrderId}`,
              ]
            : []),
        ]
      : []),
  ];
  // Keep the payment identity stable for the whole logical checkout, including
  // a captured-intent row that is materialized after the nested sale write.
  const [reservedSale] = await db.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT nextval(pg_get_serial_sequence('public.sales', 'id'))::integer AS "id"
  `);
  if (!reservedSale?.id)
    throw new PosDomainError(
      "Não foi possível reservar a identidade autoritativa da venda.",
    );
  commitPreRootAdvisoryNamespaces.push(
    `t2-payment-plan:consume-sale:${reservedSale.id}`,
  );
  const orderDiscountCents = cents(body.discountCents || 0, "Desconto", true),
    surchargeCents = cents(body.surchargeCents || 0, "Acréscimo", true);
  const correlationId = randomUUID();
  let sale;
  try {
    sale = await db.$transaction(
      async (tx) => {
        for (const namespace of [
          ...new Set(commitPreRootAdvisoryNamespaces),
        ].sort()) {
          await tx.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`,
          );
        }
        const manualReferencePrelock = manualReferenceIds.length
          ? await prelockPosManualReferenceWrite(tx, {
              planIds: [paymentPlanId],
              referenceIds: manualReferenceIds,
              slotCoordinates: manualReferenceSlots,
              reservedSalePaymentIds: manualReferenceSalePaymentIds,
              operationIdempotencyKeys: manualReferenceOperationKeys,
            })
          : null;
        const planConsumeRequestHash = await preparePosPaymentPlanConsumption(
          tx,
          {
            planId: paymentPlanId,
            expectedVersion: paymentPlanVersion,
            saleId: reservedSale.id,
            actorUserId: context.permission.user.id,
            idempotencyKey: consumeOperationKey,
          },
        );
        const salePaymentPrelock = await prelockPosSalePaymentWriteGraph(tx, {
          mode: "operational",
          preRootAdvisoryNamespaces: commitPreRootAdvisoryNamespaces,
          paymentPlanIds: [paymentPlanId],
          insertIdempotencyKeys: nestedPaymentInsertKeys,
        });
        await assertLiveTerminalProof(tx, context, terminalProof, register.id);
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${session.id} FOR UPDATE`,
        );
        const liveSession = await tx.cashRegisterSession.findFirst({
          where: {
            id: session.id,
            registerId: register.id,
            status: "open",
            version: session.version,
          },
        });
        if (!liveSession)
          throw new PosDomainError(
            "O turno foi fechado ou alterado. Atualize o PDV.",
          );
        const liveAccess = await liveRegisterSaleAccess(
          tx,
          context,
          register.id,
        );
        if (
          paymentExecutions.some((payment) => payment.manualReferenceId) &&
          !liveAccess.canManualPayment &&
          !context.privileged
        )
          throw new PosDomainError(
            "A permissão de confirmação manual de pagamento foi revogada.",
          );
        const liveRegister = await tx.posRegister.findFirst({
          where: {
            id: register.id,
            branchId: context.branch.id,
            status: "active",
          },
          include: {
            warehouse: { select: { id: true, branchId: true, active: true } },
          },
        });
        if (
          !liveRegister ||
          (liveRegister.warehouse &&
            (!liveRegister.warehouse.active ||
              liveRegister.warehouse.branchId !== context.branch.id))
        )
          throw new PosDomainError(
            "O caixa não possui um depósito ativo desta filial.",
          );
        if (
          !orderClaimId &&
          (await tx.posOrderClaim.findUnique({
            where: { id: idempotencyKey },
            select: { id: true },
          }))
        )
          throw new PosOrderClaimError(
            "Este rascunho pertence a um pedido reivindicado; recupere o claim exato antes de concluir.",
          );
        const orderClaim = orderClaimId
          ? await tx.posOrderClaim.findUnique({ where: { id: orderClaimId } })
          : null;
        if (orderClaimId && !orderClaim)
          throw new PosOrderClaimError("Posse do pedido não encontrada.", 404);
        if (orderClaim)
          assertPosOrderClaimContext(orderClaim, {
            version: orderClaimVersion!,
            branchId: context.branch.id,
            registerId: register.id,
            sessionId: session.id,
            operatorProfileId: context.profile.id,
            terminalId: terminalProof.terminalId,
          });
        const claimedOrder: PosClaimableOrder | null = orderClaim
          ? await tx.salesOrder.findFirst({
              where: {
                id: orderClaim.salesOrderId,
                branchId: context.branch.id,
              },
              include: posOrderInclude,
            })
          : null;
        if (orderClaim && !claimedOrder)
          throw new PosOrderClaimError(
            "O pedido do claim não pertence mais a esta filial.",
          );
        if (claimedOrder) {
          assertPosOrderEligible(claimedOrder, context.branch.id);
          if (
            await tx.sale.findUnique({
              where: {
                sourceType_sourceId: {
                  sourceType: "sales_order",
                  sourceId: String(claimedOrder.id),
                },
              },
              select: { id: true },
            })
          )
            throw new PosOrderClaimError(
              "O pedido já foi convertido em outra venda.",
            );
        }
        if (heldSaleId)
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id" = ${heldSaleId} FOR UPDATE`,
          );
        const heldSale = heldSaleId
          ? await tx.posHeldSale.findFirst({
              where: {
                id: heldSaleId,
                sessionId: session.id,
                registerId: register.id,
                operatorProfileId: context.profile.id,
                status: "held",
              },
            })
          : null;
        if (heldSaleId && !heldSale)
          throw new PosDomainError(
            "A venda suspensa foi descartada, convertida ou não pertence ao contexto operacional atual.",
          );
        if (!heldSaleId)
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id" = ${idempotencyKey} FOR UPDATE`,
          );
        const recoveryDraft = !heldSaleId
          ? await tx.posHeldSale.findFirst({
              where: {
                id: idempotencyKey,
                sessionId: session.id,
                registerId: register.id,
                operatorProfileId: context.profile.id,
                status: "draft",
              },
              include: { items: true },
            })
          : null;
        const authoritativePayment = await exactPosPaymentPlanForCommit(
          tx,
          {
            branchId: context.branch.id,
            registerId: register.id,
            sessionId: session.id,
            operatorProfileId: context.profile.id,
            terminalId: terminalProof.terminalId,
            actorUserId: context.permission.user.id,
          },
          paymentPlanId,
          paymentPlanVersion,
          paymentExecutions,
        );
        if (authoritativePayment.plan.saleDraftId !== idempotencyKey)
          throw new PosPaymentPlanError(
            "A venda deve consumir a chave exata do rascunho vinculada ao plano.",
          );
        if (authoritativePayment.plan.orderClaimId !== orderClaimId)
          throw new PosPaymentPlanError(
            "O plano e a venda divergem quanto ao claim autoritativo do pedido.",
          );
        const paymentInputs = authoritativePayment.paymentInputs;
        const [intentArtifacts, manualArtifacts] = await Promise.all([
          tx.posPaymentIntent.findMany({
            where: {
              paymentPlanId,
              saleDraftId: idempotencyKey,
              sessionId: session.id,
              registerId: register.id,
              operatorProfileId: context.profile.id,
              consumedAt: null,
              status: { in: [...POS_DRAFT_RECOVERY_INTENT_STATES] },
            },
            select: { id: true, paymentIndex: true },
          }),
          tx.posManualPaymentReference.findMany({
            where: {
              paymentPlanId,
              saleDraftId: idempotencyKey,
              sessionId: session.id,
              registerId: register.id,
              requesterProfileId: context.profile.id,
              consumedSalePaymentId: null,
              status: "pending",
            },
            select: { id: true, paymentIndex: true },
          }),
        ]);
        const exactServerDraft =
          recoveryDraft ??
          (heldSale?.id === idempotencyKey
            ? await tx.posHeldSale.findUnique({
                where: { id: heldSale.id },
                include: { items: true },
              })
            : null);
        if (
          (intentArtifacts.length || manualArtifacts.length) &&
          !exactServerDraft
        )
          throw new PosDomainError(
            "A prova financeira não possui o rascunho exato persistido. O checkout foi bloqueado para reconciliação.",
          );
        if (exactServerDraft)
          assertRecoveryDraftMatchesCommit(exactServerDraft, {
            customerId,
            notes: saleNotes,
            discountCents: orderDiscountCents,
            surchargeCents,
            items: requested,
          });
        const submittedArtifacts = paymentInputs
          .flatMap((payment, paymentIndex) => [
            ...(payment.paymentIntentId
              ? [{ kind: "intent", id: payment.paymentIntentId, paymentIndex }]
              : []),
            ...(payment.manualReferenceId
              ? [
                  {
                    kind: "manual",
                    id: payment.manualReferenceId,
                    paymentIndex,
                  },
                ]
              : []),
          ])
          .sort(paymentArtifactOrder);
        const persistedArtifacts = [
          ...intentArtifacts.map((artifact) => ({
            kind: "intent",
            ...artifact,
          })),
          ...manualArtifacts.map((artifact) => ({
            kind: "manual",
            ...artifact,
          })),
        ].sort(paymentArtifactOrder);
        if (
          JSON.stringify(submittedArtifacts) !==
          JSON.stringify(persistedArtifacts)
        )
          throw new PosOrderClaimError(
            "As provas financeiras persistidas não correspondem exatamente às divisões enviadas. Reconcilie intent ou referência extra antes do commit.",
          );
        if (claimedOrder) {
          assertExactPosOrderCart(claimedOrder.items, requested);
          if ((claimedOrder.customerId ?? null) !== customerId)
            throw new PosOrderClaimError(
              "O cliente do carrinho diverge do pedido aprovado.",
            );
          if (
            orderDiscountCents !== Math.round(claimedOrder.discount * 100) ||
            surchargeCents !== 0
          )
            throw new PosOrderClaimError(
              "Desconto geral ou acréscimo diverge do pedido aprovado.",
            );
        }
        const exchangeOrigin = heldSale
          ? await tx.posReturn.findUnique({
              where: { exchangeHeldSaleId: heldSale.id },
              include: { sale: { select: { id: true, branchId: true } } },
            })
          : null;
        if (
          exchangeOrigin &&
          (exchangeOrigin.sale.branchId !== context.branch.id ||
            exchangeOrigin.status !== "completed" ||
            exchangeOrigin.exchangeStatus !== "draft" ||
            exchangeOrigin.exchangeSaleId != null)
        )
          throw new PosDomainError(
            "A troca vinculada não está vigente para conclusão.",
          );
        const warehouseId = liveRegister.warehouseId;
        const configuration = await tx.tenantSettings.findUnique({
          where: { id: 1 },
        });
        if (!configuration)
          throw new PosDomainError(
            "Configurações da organização não inicializadas.",
          );
        const customer = customerId
          ? await tx.customer.findFirst({
              where: { id: customerId, status: "active" },
            })
          : null;
        if (customerId && !customer)
          throw new PosDomainError("Cliente não encontrado ou inativo.");
        if (configuration.requireCustomer && !customer)
          throw new PosDomainError("Identifique o cliente antes de concluir.");
        const coupon = await couponIdentityForRequest(
          tx,
          context,
          body.couponCode,
          body.couponQrToken,
        );
        const quoted = await authoritativePromotionQuote(
          tx,
          context,
          idempotencyKey,
          requested,
          customer?.id ?? null,
          orderDiscountCents,
          surchargeCents,
          coupon?.hash ?? null,
          new Date(),
          true,
        );
        if (
          authoritativePayment.plan.quoteHash !== quoted.quoteHash ||
          authoritativePayment.plan.totalCents !== quoted.pricing.totalCents ||
          authoritativePayment.plan.promotionId !==
            (quoted.award?.promotionId ?? null) ||
          authoritativePayment.plan.couponId !==
            (quoted.award?.couponId ?? null) ||
          authoritativePayment.plan.promotionDiscountCents !==
            quoted.promotionDiscountCents
        ) {
          throw new PosPaymentPlanError(
            "Preço, promoção ou cupom divergiram da cotação server-side persistida; recote sem criar nova cobrança.",
          );
        }
        const { byId, pricing, persistedLines, kitPlans } = quoted;
        if (claimedOrder)
          assertExactPosOrderPricing(claimedOrder, {
            promotionId: quoted.award?.promotionId ?? null,
            subtotalCents: quoted.basePricing.subtotalCents,
            manualDiscountCents: orderDiscountCents,
            surchargeCents,
            totalCents: pricing.totalCents,
            lines: quoted.basePricing.lines.map((line) => ({
              productId: line.productId,
              variationId: line.variationId ?? null,
              unitPriceCents: line.unitPriceCents,
              discountCents: line.discountCents,
              totalCents: line.totalCents,
            })),
          });
        const consumedOrderReservationIds = claimedOrder
          ? await preparePosOrderReservations(tx, claimedOrder, {
              branchId: context.branch.id,
              warehouseId: liveRegister.warehouseId,
              byId,
              kitPlans,
            })
          : [];
        const discountApproval = buildPosDiscountApproval({
          saleDraftId: idempotencyKey,
          sessionId: session.id,
          grossCents: quoted.basePricing.lines.reduce(
            (sum, item) => sum + item.grossCents,
            0,
          ),
          orderDiscountCents,
          lineDiscountCents: quoted.basePricing.lines.reduce(
            (sum, item) => sum + item.discountCents,
            0,
          ),
          settingsMaximumPercent: configuration.maxDiscountPercent,
          accessMaximumBasisPoints: liveAccess.maxDiscountBasisPoints,
        });
        if (discountApproval.requiresApproval) {
          if (!discountApprovalId)
            throw new PosDomainError(
              "O desconto manual supera sua alçada e exige aprovação excepcional.",
            );
          await consumeApprovedPosAction(
            tx,
            context,
            discountApprovalId,
            "discount.override",
            "sale_draft",
            idempotencyKey,
            idempotencyKey,
            discountApproval.context,
          );
        }
        const settlement = settlePosPayments(pricing.totalCents, paymentInputs);
        if (claimedOrder) assertPosOrderSettlement(claimedOrder, paymentInputs);
        const manualReferences = new Map<
          number,
          Prisma.PosManualPaymentReferenceGetPayload<{
            include: { approval: true };
          }>
        >();
        for (const [paymentIndex, payment] of paymentInputs.entries()) {
          if (!payment.manualReferenceId) continue;
          const manualReference = await tx.posManualPaymentReference.findFirst({
            where: {
              id: payment.manualReferenceId!,
              branchId: context.branch.id,
              registerId: register.id,
              sessionId: session.id,
              requesterProfileId: context.profile.id,
              requesterUserId: context.permission.user.id,
              saleDraftId: idempotencyKey,
              quoteHash: authoritativePayment.plan.quoteHash,
              paymentIndex,
              method: payment.method,
              amountCents: payment.amountCents,
              installments: payment.installments,
              status: "pending",
              consumedSalePaymentId: null,
            },
            include: { approval: true },
          });
          if (!manualReference)
            throw new PosDomainError(
              `A referência manual do pagamento ${paymentIndex + 1} não pertence ao valor, turno, caixa ou rascunho atual.`,
            );
          const expectedContext = posManualPaymentApprovalContext(
            {
              id: manualReference.id,
              saleDraftId: manualReference.saleDraftId,
              quoteHash: manualReference.quoteHash,
              sessionId: manualReference.sessionId,
              paymentIndex: manualReference.paymentIndex,
              method: manualReference.method as
                "pix" | "credit" | "debit" | "voucher",
              amountCents: manualReference.amountCents,
              installments: manualReference.installments,
              provider: manualReference.provider,
              referenceHash: manualReference.referenceHash,
              referenceLastFour: manualReference.referenceLastFour,
              occurredAt: manualReference.occurredAt,
            },
            manualReference.registerId,
          );
          await consumeApprovedPosAction(
            tx,
            context,
            manualReference.approvalId,
            "payment.manual_reference",
            "sale_draft",
            idempotencyKey,
            idempotencyKey,
            expectedContext,
          );
          manualReferences.set(paymentIndex, manualReference);
        }
        const valuePaymentRequests: PosSaleValuePaymentInput[] = [];
        for (const [paymentIndex, payment] of paymentInputs.entries()) {
          if (payment.method !== "store_credit") continue;
          const authorizedGiftAccountId = payment.giftQrToken
            ? await resolveInternalQrEntity(
                tx,
                context,
                payment.giftQrToken,
                "gift_card",
              )
            : undefined;
          valuePaymentRequests.push({
            paymentIndex,
            amountCents: payment.amountCents,
            accountId: payment.valueAccountId,
            units: payment.valueUnits,
            giftCode: payment.giftCode,
            giftPin: payment.giftPin,
            authorizedGiftAccountId,
          });
        }
        const valueCaptures = await consumePosSaleValues(tx, {
          branchId: context.branch.id,
          customerId: customer?.id ?? null,
          saleDraftId: idempotencyKey,
          payments: valuePaymentRequests,
          actor: context.profile.displayName,
          now: new Date(),
        });
        const valueCaptureByPayment = new Map(
          valueCaptures.map((capture) => [capture.paymentIndex, capture]),
        );
        let redemptionSnapshot: Prisma.InputJsonObject | undefined;
        if (quoted.award) {
          if (quoted.award.couponId) {
            if (!quoted.coupon || quoted.coupon.id !== quoted.award.couponId)
              throw new PosDomainError(
                "O cupom selecionado mudou durante a venda.",
              );
            if (
              quoted.coupon.usageLimit != null &&
              quoted.coupon.usedCount >= quoted.coupon.usageLimit
            )
              throw new PosDomainError(
                "Cupom inválido, expirado ou indisponível.",
              );
            const claimed = await tx.posCoupon.updateMany({
              where: {
                id: quoted.coupon.id,
                status: "active",
                usedCount: quoted.coupon.usedCount,
              },
              data: { usedCount: { increment: 1 } },
            });
            if (claimed.count !== 1)
              throw new PosDomainError(
                "Cupom inválido, expirado ou indisponível.",
              );
          }
          redemptionSnapshot = JSON.parse(
            JSON.stringify({
              quoteHash: quoted.quoteHash,
              promotionName: quoted.award.promotionName,
              priority: quoted.award.priority,
              eligibleSubtotalCents: quoted.award.eligibleSubtotalCents,
              allocations: quoted.award.allocations,
              branchId: context.branch.id,
              customerId: customer?.id ?? null,
              conditions: quoted.award.snapshot.conditions,
              effect: quoted.award.snapshot.effect,
              evaluatedAt: quoted.award.snapshot.evaluatedAt,
            }),
          ) as Prisma.InputJsonObject;
        }
        // Open every manual-reference consume root before sale.create performs the
        // causal nested payment INSERT. The deferred SQL guard proves the reserved
        // payment/reference tuple at commit; consumed_at remains server-owned.
        for (const [paymentIndex, manualReference] of manualReferences) {
          const lockedPlan = manualReferencePrelock?.plans.find(
            (plan) => plan.id === manualReference.paymentPlanId,
          );
          if (!lockedPlan)
            throw new PosDomainError(
              "O plano da referência manual não está disponível para consumo.",
            );
          await preparePosManualPaymentReferenceWrite(tx, {
            action: "consume",
            id: manualReference.id,
            expectedVersion: lockedPlan.version,
            actorUserId: context.permission.user.id,
            idempotencyKey: manualReferenceConsumeOperationKey(
              idempotencyKey,
              manualReference.id,
            ),
            target: posManualPaymentReferenceWriteTarget({
              ...manualReference,
              status: "consumed",
              consumedSalePaymentId: paymentRowIds[paymentIndex]!,
              consumedAt: null,
            }),
          });
        }
        const lockedSalePaymentPlan = salePaymentPrelock.plans.find(
          (plan) => plan.id === paymentPlanId,
        );
        if (!lockedSalePaymentPlan)
          throw new PosDomainError(
            "O plano autoritativo dos pagamentos desapareceu durante o pré-lock.",
          );
        const salePaymentCreates = settlement.payments.flatMap(
          (payment, index) => {
            const source = paymentInputs[index],
              valueCapture = valueCaptureByPayment.get(index),
              manualReference = manualReferences.get(index);
            if (source.paymentIntentId) return [];
            return [
              {
                id: paymentRowIds[index]!,
                processingSessionId: session.id,
                paymentPlanId: authoritativePayment.plan.id,
                paymentIndex: index,
                method: payment.method,
                status: manualReference ? "manual_confirmed" : "captured",
                amountCents: payment.amountCents,
                tenderedCents: payment.tenderedCents,
                changeCents:
                  payment.method === "cash"
                    ? payment.tenderedCents - payment.amountCents
                    : 0,
                provider: valueCapture
                  ? "pos_value"
                  : manualReference?.provider || "cash",
                transactionId:
                  valueCapture?.reservationId ||
                  (manualReference?.method === "pix"
                    ? null
                    : manualReference?.reference),
                endToEndId:
                  manualReference?.method === "pix"
                    ? manualReference.reference
                    : null,
                installments: source.installments,
                valueReservationId: valueCapture?.reservationId,
                valueCaptureEntryId: valueCapture?.captureEntryId,
                valueAmountUnits: valueCapture?.amountUnits,
                idempotencyKey: `${idempotencyKey}:payment:${index}`,
                authorizedAt: manualReference ? null : new Date(),
                capturedAt: manualReference ? null : new Date(),
                metadata: {
                  requestHash,
                  ...(valueCapture
                    ? {
                        valueAccountId: valueCapture.accountId,
                        valueAccountKind: valueCapture.accountKind,
                        valueAmountUnits: valueCapture.amountUnits,
                        valueReservationId: valueCapture.reservationId,
                        valueCaptureEntryId: valueCapture.captureEntryId,
                      }
                    : {}),
                  ...(manualReference
                    ? {
                        confirmationMode: "manual_dual_control",
                        manualReferenceId: manualReference.id,
                        manualApprovalId: manualReference.approvalId,
                        externalProviderClaim: manualReference.provider,
                        referenceHash: manualReference.referenceHash,
                        operatorClaimedOccurredAt:
                          manualReference.occurredAt.toISOString(),
                      }
                    : {}),
                },
              },
            ];
          },
        );
        for (const payment of salePaymentCreates) {
          await preparePosSalePaymentWrite(tx, {
            action: "create_commit",
            id: payment.id,
            expectedVersion: lockedSalePaymentPlan.version,
            actorUserId: context.permission.user.id,
            idempotencyKey: payment.idempotencyKey,
            target: posSalePaymentWriteTarget({
              ...payment,
              saleId: reservedSale.id,
              type: "payment",
              metadata: payment.metadata as Prisma.InputJsonObject,
            }),
          });
        }
        const created = await tx.sale.create({
          data: {
            id: reservedSale.id,
            saleNumber: number("PDV"),
            branchId: context.branch.id,
            warehouseId,
            sessionId: session.id,
            customerId: customer?.id,
            operatorProfileId: context.profile.id,
            customer:
              customer?.tradeName ||
              customer?.name ||
              configuration.defaultCustomerName,
            seller: context.profile.displayName,
            cashRegister: liveRegister.name,
            paymentMethod: settlement.payments
              .map((item) => item.method)
              .join(" + "),
            total: pricing.totalCents / 100,
            subtotalCents: pricing.subtotalCents,
            discountCents: pricing.discountCents,
            surchargeCents: pricing.surchargeCents,
            totalCents: pricing.totalCents,
            changeCents: settlement.changeCents,
            idempotencyKey,
            requestHash,
            notes: saleNotes,
            fulfillmentMode,
            status: "completed",
            ...(claimedOrder
              ? { sourceType: "sales_order", sourceId: String(claimedOrder.id) }
              : exchangeOrigin
                ? { sourceType: "pos_exchange", sourceId: exchangeOrigin.id }
                : {}),
            items: {
              create: persistedLines.map((line) => {
                const product = byId.get(line.productId)!,
                  requestedLine = requested.find(
                    (item) =>
                      item.productId === product.id &&
                      (item.variationId || null) === (line.variationId || null),
                  ),
                  variation = line.variationId
                    ? product.variations.find(
                        (item) => item.id === line.variationId,
                      )
                    : null;
                return {
                  productId: product.id,
                  productName: product.name,
                  skuSnapshot: variation?.sku || product.sku,
                  gtinSnapshot:
                    variation?.gtin || product.gtin || product.barcode,
                  variationId: line.variationId,
                  unit: product.unit,
                  quantity: line.quantity,
                  unitPrice: line.unitPriceCents / 100,
                  total: line.totalCents / 100,
                  unitPriceCents: line.unitPriceCents,
                  grossCents: line.grossCents,
                  discountCents: line.discountCents,
                  surchargeCents: line.surchargeCents,
                  totalCents: line.totalCents,
                  scanData: requestedLine?.scanData,
                };
              }),
            },
            payments: { create: salePaymentCreates },
            ...(quoted.award && redemptionSnapshot
              ? {
                  promotionUses: {
                    create: {
                      promotionId: quoted.award.promotionId,
                      couponId: quoted.award.couponId,
                      customerId: customer?.id,
                      discountCents: quoted.award.discountCents,
                      snapshot: redemptionSnapshot,
                    },
                  },
                }
              : {}),
            events: {
              create: {
                type: "sale.completed",
                actorId: context.permission.user.id,
                actorName: context.profile.displayName,
                correlationId,
                data: {
                  requestHash,
                  fulfillmentMode,
                  totalCents: pricing.totalCents,
                  manualDiscountCents:
                    discountApproval.context.manualDiscountCents,
                  discountApprovalId: discountApproval.requiresApproval
                    ? discountApprovalId
                    : null,
                  promotionId: quoted.award?.promotionId ?? null,
                  promotionDiscountCents: quoted.promotionDiscountCents,
                  exchangeReturnId: exchangeOrigin?.id ?? null,
                  payments: settlement.payments.map((item) => ({
                    method: item.method,
                    amountCents: item.amountCents,
                  })),
                },
              },
            },
          },
          include: {
            items: true,
            payments: true,
            promotionUses: {
              select: {
                promotionId: true,
                couponId: true,
                discountCents: true,
                snapshot: true,
                promotion: { select: { name: true } },
              },
            },
          },
        });
        for (const [paymentIndex, manualReference] of manualReferences) {
          const payment = created.payments.find(
            (item) => item.id === paymentRowIds[paymentIndex],
          );
          if (!payment)
            throw new PosDomainError(
              "O pagamento manual persistido não foi encontrado para consumo da referência.",
            );
          const consumedAt = new Date();
          const consumed = await tx.posManualPaymentReference.updateMany({
            where: {
              id: manualReference.id,
              approvalId: manualReference.approvalId,
              status: "pending",
              consumedSalePaymentId: null,
            },
            data: {
              status: "consumed",
              consumedSalePaymentId: payment.id,
              consumedAt,
            },
          });
          if (consumed.count !== 1)
            throw new PosDomainError(
              "A referência manual foi utilizada ou revogada em outra operação.",
            );
          const persistedManualReference =
            await tx.posManualPaymentReference.findUniqueOrThrow({
              where: { id: manualReference.id },
            });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: context.permission.user.id,
              action: "pos.payment.manual_reference.consumed",
              entityType: "pos_manual_payment_reference",
              entityId: manualReference.id,
              correlationId,
              beforeData: {
                status: "pending",
                approvalId: manualReference.approvalId,
              },
              afterData: {
                status: "consumed",
                saleId: created.id,
                salePaymentId: payment.id,
                saleDraftId: idempotencyKey,
                paymentIndex,
                method: manualReference.method,
                amountCents: manualReference.amountCents,
                provider: manualReference.provider,
                referenceHash: manualReference.referenceHash,
                referenceLastFour: manualReference.referenceLastFour,
                consumedAt: persistedManualReference.consumedAt?.toISOString(),
              },
            },
          });
        }
        for (const [paymentIndex, source] of paymentInputs.entries()) {
          if (!source.paymentIntentId) continue;
          await consumeCapturedPosPaymentIntent(tx, {
            intentId: source.paymentIntentId,
            branchId: context.branch.id,
            registerId: register.id,
            terminalId: terminalProof.terminalId,
            sessionId: session.id,
            operatorProfileId: context.profile.id,
            saleDraftId: idempotencyKey,
            paymentPlanId: authoritativePayment.plan.id,
            paymentIndex,
            amountCents: source.amountCents,
            method: source.method as "pix" | "credit" | "debit" | "voucher",
            installments: source.installments || 1,
            saleId: created.id,
            paymentIdempotencyKey: `${idempotencyKey}:payment:${paymentIndex}`,
            paymentId: paymentRowIds[paymentIndex]!,
          });
        }
        await consumePosPaymentPlan(
          tx,
          authoritativePayment.plan,
          created.id,
          context.permission.user.id,
          consumeOperationKey,
          planConsumeRequestHash,
        );
        if (settlement.payments.some((payment) => payment.method === "cash")) {
          const cashCents = settlement.payments
            .filter((payment) => payment.method === "cash")
            .reduce((sum, payment) => sum + payment.amountCents, 0);
          await tx.cashRegisterEvent.create({
            data: {
              sessionId: session.id,
              type: "sale",
              amount: cashCents / 100,
              amountCents: cashCents,
              paymentMethod: "cash",
              description: `Venda ${created.saleNumber}`,
              actor: context.profile.displayName,
              correlationId,
            },
          });
        }
        const businessDate = posBusinessDate(context.branch.timezone);
        const saleItemByLine = new Map(
          created.items.map((item) => [
            `${item.productId}:${item.variationId || 0}`,
            item,
          ]),
        );
        for (const line of persistedLines) {
          const product = byId.get(line.productId)!;
          const variation = line.variationId
            ? product.variations.find((item) => item.id === line.variationId)!
            : null;
          const saleItem = saleItemByLine.get(
            `${line.productId}:${line.variationId || 0}`,
          );
          if (!saleItem)
            throw new PosDomainError(
              `Item persistido não encontrado para ${product.name}.`,
            );
          const kitPlan = kitPlans.get(
            `${line.productId}:${line.variationId || 0}`,
          );
          if (kitPlan) {
            for (const component of kitPlan.components) {
              const mode = stockMode(
                component.product.type,
                component.product.manageStock,
                component.variation?.manageStock,
              );
              const allocation = await tx.posKitSaleComponent.create({
                data: {
                  saleItemId: saleItem.id,
                  bomId: kitPlan.root.id,
                  bomVersion: kitPlan.root.version,
                  productId: component.productId,
                  variationId: component.variationId,
                  componentScopeKey: component.scopeKey,
                  unitQuantityMicros: component.unitQuantityMicros,
                  quantityMicros: component.quantityMicros,
                  snapshot: kitPlan.snapshot,
                },
              });
              if (mode === "none") continue;
              if (!warehouseId)
                throw new PosDomainError(
                  `O caixa não possui depósito para baixar o componente ${component.product.name}.`,
                );
              await allocatePosTrackedSaleItem(tx, {
                warehouseId,
                productId: component.productId,
                variationId:
                  mode === "variation" ? component.variationId : null,
                saleItemId: saleItem.id,
                quantity: component.quantity,
                businessDate,
                idempotencyKey: `${idempotencyKey}:kit:${allocation.id}`,
                actor: context.profile.displayName,
                referenceId: String(created.id),
              });
              await applyPosCommonStockChange(tx, {
                warehouseId,
                product: component.product,
                variation: component.variation,
                delta: -component.quantity,
                allowNegative: configuration.allowNegativeStock,
                movementType: "exit",
                ledgerType: "kit_sale",
                referenceType: "pos_kit_sale_component",
                referenceId: allocation.id,
                actor: context.profile.displayName,
                note: `Componente do kit ${product.name} na venda ${created.saleNumber}`,
              });
            }
            await tx.product.update({
              where: { id: product.id },
              data: { totalSales: { increment: line.quantity } },
            });
            continue;
          }
          const mode = stockMode(
            product.type,
            product.manageStock,
            variation?.manageStock,
          );
          const requestedLine = requested.find(
            (item) =>
              item.productId === line.productId &&
              (item.variationId || null) === (line.variationId || null),
          );
          if (mode === "none") {
            if (
              parsePosScanTrackingRequests(
                requestedLine?.scanData,
                line.quantity,
              ).length
            )
              throw new PosDomainError(
                `${product.name} não possui controle de lote/série configurado.`,
              );
            continue;
          }
          if (!warehouseId)
            throw new PosDomainError(
              "O caixa não possui depósito configurado.",
            );
          await allocatePosTrackedSaleItem(tx, {
            warehouseId,
            productId: product.id,
            variationId:
              mode === "variation" ? (line.variationId ?? null) : null,
            saleItemId: saleItem.id,
            quantity: line.quantity,
            scanData: requestedLine?.scanData,
            businessDate,
            idempotencyKey,
            actor: context.profile.displayName,
            referenceId: String(created.id),
          });
          await applyPosCommonStockChange(tx, {
            warehouseId,
            product,
            variation,
            delta: -line.quantity,
            allowNegative: configuration.allowNegativeStock,
            movementType: "exit",
            ledgerType: "sale",
            referenceType: "sale",
            referenceId: String(created.id),
            actor: context.profile.displayName,
            note: `Venda PDV ${created.saleNumber}`,
          });
          await tx.product.update({
            where: { id: product.id },
            data: { totalSales: { increment: line.quantity } },
          });
        }
        const valueAccruals = await accruePosSaleValues(tx, {
          branchId: context.branch.id,
          customerId: customer?.id ?? null,
          customerName: customer?.tradeName || customer?.name || null,
          saleId: created.id,
          saleKey: idempotencyKey,
          totalCents: pricing.totalCents,
          actor: context.profile.displayName,
          now: new Date(),
        });
        const fiscalPreparation = await queuePosFiscalIssuanceForSale(tx, {
          saleId: created.id,
          branchId: context.branch.id,
          registerId: register.id,
          sessionId: session.id,
          operatorProfileId: context.profile.id,
          actorUserId: context.permission.user.id,
          actorName: context.profile.displayName,
          correlationId,
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: "pos.sale.completed",
            entityType: "sale",
            entityId: String(created.id),
            correlationId,
            afterData: {
              saleNumber: created.saleNumber,
              sessionId: session.id,
              registerId: register.id,
              totalCents: pricing.totalCents,
              manualDiscountCents: discountApproval.context.manualDiscountCents,
              discountApprovalId: discountApproval.requiresApproval
                ? discountApprovalId
                : null,
              promotionId: quoted.award?.promotionId ?? null,
              promotionDiscountCents: quoted.promotionDiscountCents,
              kits: [...kitPlans.values()].map((plan) => ({
                saleLine: plan.lineKey,
                bomId: plan.root.id,
                version: plan.root.version,
                components: plan.components.length,
              })),
              exchangeReturnId: exchangeOrigin?.id ?? null,
              valuePayments: valueCaptures.map((value) => ({
                accountId: value.accountId,
                accountKind: value.accountKind,
                amountUnits: value.amountUnits,
              })),
              valueAccruals,
              fiscalPreparation,
              requestHash,
            },
          },
        });
        await enqueueWebhook(tx, "sale.created", {
          id: created.id,
          number: created.saleNumber,
          total_cents: pricing.totalCents,
          branch_id: context.branch.id,
          occurred_at: new Date().toISOString(),
        });
        if (heldSale) {
          const converted = await tx.posHeldSale.updateMany({
            where: {
              id: heldSale.id,
              sessionId: session.id,
              registerId: register.id,
              operatorProfileId: context.profile.id,
              status: "held",
            },
            data: { status: "converted" },
          });
          if (converted.count !== 1)
            throw new PosDomainError(
              "A venda suspensa foi alterada por outra operação.",
            );
        }
        if (recoveryDraft) {
          const converted = await tx.posHeldSale.updateMany({
            where: {
              id: recoveryDraft.id,
              sessionId: session.id,
              registerId: register.id,
              operatorProfileId: context.profile.id,
              status: "draft",
              revision: recoveryDraft.revision,
            },
            data: { status: "converted", revision: { increment: 1 } },
          });
          if (converted.count !== 1)
            throw new PosDomainError(
              "O rascunho de recuperação mudou durante a venda.",
            );
        }
        if (claimedOrder && orderClaim) {
          const convertedAt = new Date(),
            resultingVersion = orderClaim.version + 1;
          const convertedOrder = await tx.salesOrder.updateMany({
            where: {
              id: claimedOrder.id,
              branchId: context.branch.id,
              status: claimedOrder.status,
            },
            data: { status: "completed", completedAt: convertedAt },
          });
          if (convertedOrder.count !== 1)
            throw new PosOrderClaimError("O pedido mudou durante a conversão.");
          await tx.salesOrderHistory.create({
            data: {
              salesOrderId: claimedOrder.id,
              fromStatus: claimedOrder.status,
              toStatus: "completed",
              actor: context.profile.displayName,
              actorId: context.permission.user.id,
              notes: `Convertido atomicamente pela venda PDV ${created.saleNumber}.`,
            },
          });
          const convertedClaim = await tx.posOrderClaim.updateMany({
            where: {
              id: orderClaim.id,
              salesOrderId: claimedOrder.id,
              state: "active",
              version: orderClaimVersion!,
              leaseExpiresAt: { gt: convertedAt },
              convertedSaleId: null,
            },
            data: {
              state: "converted",
              version: { increment: 1 },
              convertedSaleId: created.id,
              convertedAt,
            },
          });
          if (convertedClaim.count !== 1)
            throw new PosOrderClaimError(
              "A posse expirou ou mudou durante a conversão; nenhuma venda foi confirmada.",
            );
          await tx.posOrderClaimOperation.create({
            data: {
              claimId: orderClaim.id,
              action: "convert",
              expectedVersion: orderClaimVersion!,
              resultingVersion,
              resultingState: "converted",
              idempotencyKey: `${orderClaim.id}:convert`,
              requestHash,
              leaseExpiresAt: orderClaim.leaseExpiresAt,
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: context.permission.user.id,
              action: "pos.order.converted",
              entityType: "sales_order",
              entityId: String(claimedOrder.id),
              correlationId,
              beforeData: {
                status: claimedOrder.status,
                claimId: orderClaim.id,
                claimVersion: orderClaim.version,
              },
              afterData: {
                status: "completed",
                claimId: orderClaim.id,
                claimVersion: resultingVersion,
                saleId: created.id,
                saleNumber: created.saleNumber,
                reservationIds: consumedOrderReservationIds,
                prevalidatedInertOrderPayments: claimedOrder.payments.length,
                convertedAt: convertedAt.toISOString(),
              },
            },
          });
          await enqueueWebhook(tx, "order.updated", {
            id: claimedOrder.id,
            status: "completed",
            sale_id: created.id,
            occurred_at: convertedAt.toISOString(),
            correlation_id: correlationId,
          });
        }
        if (exchangeOrigin) {
          const completedAt = new Date();
          const linked = await tx.posReturn.updateMany({
            where: {
              id: exchangeOrigin.id,
              exchangeStatus: "draft",
              exchangeHeldSaleId: heldSale!.id,
              exchangeSaleId: null,
            },
            data: {
              exchangeStatus: "completed",
              exchangeSaleId: created.id,
              exchangeCompletedAt: completedAt,
            },
          });
          if (linked.count !== 1)
            throw new PosDomainError(
              "A troca foi concluída por outra operação.",
            );
          const differenceCents =
            pricing.totalCents - exchangeOrigin.totalRefundCents;
          await tx.posSaleEvent.create({
            data: {
              saleId: exchangeOrigin.sale.id,
              type: "sale.exchange.completed",
              actorId: context.permission.user.id,
              actorName: context.profile.displayName,
              correlationId,
              data: {
                returnId: exchangeOrigin.id,
                heldSaleId: heldSale!.id,
                exchangeSaleId: created.id,
                returnedCents: exchangeOrigin.totalRefundCents,
                newSaleCents: pricing.totalCents,
                differenceCents,
              },
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: context.permission.user.id,
              action: "pos.exchange.completed",
              entityType: "pos_return",
              entityId: exchangeOrigin.id,
              correlationId,
              beforeData: { exchangeStatus: "draft", heldSaleId: heldSale!.id },
              afterData: {
                exchangeStatus: "completed",
                exchangeSaleId: created.id,
                returnedCents: exchangeOrigin.totalRefundCents,
                newSaleCents: pricing.totalCents,
                differenceCents,
                completedAt: completedAt.toISOString(),
              },
            },
          });
        }
        return tx.sale.findUniqueOrThrow({
          where: { id: created.id },
          include: {
            items: true,
            payments: true,
            promotionUses: {
              select: {
                promotionId: true,
                couponId: true,
                discountCents: true,
                snapshot: true,
                promotion: { select: { name: true } },
              },
            },
          },
        });
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
    );
  } catch (error) {
    if (
      ["P2002", "P2034"].includes(
        String((error as { code?: string })?.code || ""),
      )
    ) {
      const concurrent = await db.sale.findUnique({
        where: { idempotencyKey },
        include: {
          payments: true,
          items: true,
          promotionUses: {
            select: {
              promotionId: true,
              couponId: true,
              discountCents: true,
              snapshot: true,
              promotion: { select: { name: true } },
            },
          },
        },
      });
      if (concurrent) {
        if (!concurrent.sessionId)
          throw new PosTerminalBoundaryError(
            "A venda não possui turno vinculado ao terminal.",
            409,
          );
        await assertStoredSessionTerminalBinding(
          db,
          concurrent.sessionId,
          terminalProof,
        );
        if (
          concurrent.branchId !== context.branch.id ||
          concurrent.sessionId !== session.id ||
          concurrent.operatorProfileId !== context.profile.id
        )
          throw new PosDomainError(
            "A chave idempotente pertence a outro contexto operacional.",
          );
        if (concurrent.requestHash !== requestHash)
          throw new PosDomainError(
            "A chave idempotente já foi usada com outro conteúdo.",
          );
        const concurrentPlan = await db.posPaymentPlan.findUnique({
          where: { id: paymentPlanId },
        });
        if (
          !concurrentPlan ||
          concurrentPlan.state !== "consumed" ||
          concurrentPlan.consumedSaleId !== concurrent.id ||
          concurrentPlan.version !== paymentPlanVersion + 1
        )
          throw new PosPaymentPlanError(
            "O replay concorrente não corresponde ao plano autoritativo consumido.",
          );
        if (orderClaimId)
          await assertConvertedOrderClaimReplay(
            db,
            concurrent.id,
            orderClaimId,
            orderClaimVersion!,
            session.id,
            context,
            terminalProof,
          );
        return Response.json({ sale: concurrent, replayed: true });
      }
      if (String((error as { code?: string })?.code || "") === "P2034")
        throw new PosCommonStockError(
          "O estoque mudou durante uma venda concorrente. Nenhuma venda ou pagamento desta tentativa foi confirmado; repita com a mesma chave idempotente.",
        );
    }
    throw error;
  }
  return Response.json({ sale, correlationId }, { status: 201 });
}

async function preparePosOrderReservations(
  tx: Prisma.TransactionClient,
  order: PosClaimableOrder,
  input: {
    branchId: number;
    warehouseId: number | null;
    byId: Awaited<ReturnType<typeof authoritativePromotionQuote>>["byId"];
    kitPlans: Awaited<
      ReturnType<typeof authoritativePromotionQuote>
    >["kitPlans"];
  },
) {
  const reservationsByItem = new Map<number, typeof order.stockReservations>();
  for (const reservation of order.stockReservations) {
    const current = reservationsByItem.get(reservation.orderItemId) ?? [];
    current.push(reservation);
    reservationsByItem.set(reservation.orderItemId, current);
  }
  const consumedIds: number[] = [];
  const hasAnyReservation = order.stockReservations.length > 0;
  for (const item of order.items) {
    const reservations = reservationsByItem.get(item.id) ?? [];
    const product = input.byId.get(item.productId);
    if (!product)
      throw new PosOrderClaimError(
        `Produto ${item.product.name} não está mais disponível.`,
      );
    const variation = item.variationId
      ? product.variations.find(
          (candidate) => candidate.id === item.variationId,
        )
      : null;
    const lineKey = `${item.productId}:${item.variationId || 0}`;
    const isKit = input.kitPlans.has(lineKey);
    const mode = stockMode(
      product.type,
      product.manageStock,
      variation?.manageStock,
    );
    if (!reservations.length) {
      if (hasAnyReservation && (isKit || mode !== "none"))
        throw new PosOrderClaimError(
          `As reservas ativas não cobrem integralmente o item estocável ${product.name}.`,
        );
      continue;
    }
    if (isKit)
      throw new PosOrderClaimError(
        `A reserva agregada do kit ${product.name} não identifica seus componentes e não pode ser consumida com segurança no PDV.`,
      );
    if (mode === "none")
      throw new PosOrderClaimError(
        `Existe reserva de estoque incompatível com o item não estocável ${product.name}.`,
      );
    if (mode === "variation")
      throw new PosOrderClaimError(
        `A reserva legada de ${product.name} não identifica o bucket da variação; libere ou reconcilie a reserva antes da conversão no PDV.`,
      );
    if (!input.warehouseId)
      throw new PosOrderClaimError(
        "O caixa não possui depósito para reconciliar as reservas do pedido.",
      );
    for (const reservation of reservations) {
      if (
        reservation.salesOrderId !== order.id ||
        reservation.orderItemId !== item.id ||
        reservation.branchId !== input.branchId ||
        reservation.warehouseId !== input.warehouseId ||
        reservation.productId !== item.productId
      ) {
        throw new PosOrderClaimError(
          `A reserva de ${product.name} pertence a outra filial, depósito, produto ou item.`,
        );
      }
    }
    assertExactReservationQuantity(
      item.quantity,
      reservations.reduce((sum, reservation) => sum + reservation.quantity, 0),
      product.name,
    );
    for (const reservation of reservations) {
      const released = await tx.warehouseBalance.updateMany({
        where: {
          warehouseId: input.warehouseId,
          productId: item.productId,
          reservedQuantity: { gte: reservation.quantity },
        },
        data: { reservedQuantity: { decrement: reservation.quantity } },
      });
      if (released.count !== 1)
        throw new PosOrderClaimError(
          `O saldo reservado de ${product.name} está inconsistente.`,
        );
      const consumed = await tx.stockReservation.updateMany({
        where: {
          id: reservation.id,
          salesOrderId: order.id,
          orderItemId: item.id,
          status: "active",
          quantity: reservation.quantity,
        },
        data: { status: "consumed", consumedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new PosOrderClaimError(
          `A reserva de ${product.name} mudou durante a conversão.`,
        );
      consumedIds.push(reservation.id);
    }
  }
  if (consumedIds.length !== order.stockReservations.length)
    throw new PosOrderClaimError(
      "Existem reservas do pedido que não correspondem aos itens aprovados.",
    );
  return consumedIds;
}

async function assertConvertedOrderClaimReplay(
  db: Db,
  saleId: number,
  claimId: string,
  submittedVersion: number,
  sessionId: number,
  context: Access,
  terminalProof: PosOperationalTerminalProof,
) {
  const claim = await db.posOrderClaim.findUnique({
    where: { id: claimId },
    include: {
      operations: {
        where: { action: "convert" },
        orderBy: { id: "desc" },
        take: 1,
      },
    },
  });
  const operation = claim?.operations[0];
  if (
    !claim ||
    claim.state !== "converted" ||
    claim.convertedSaleId !== saleId ||
    claim.sessionId !== sessionId ||
    claim.registerId !== terminalProof.registerId ||
    claim.operatorProfileId !== context.profile.id ||
    claim.terminalId !== terminalProof.terminalId ||
    claim.branchId !== context.branch.id ||
    claim.version !== submittedVersion + 1 ||
    !operation ||
    operation.expectedVersion !== submittedVersion ||
    operation.resultingVersion !== claim.version ||
    operation.resultingState !== "converted"
  ) {
    throw new PosOrderClaimError(
      "O replay não corresponde à conversão exata deste pedido, claim e contexto operacional.",
    );
  }
}

async function cancelSale(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const session = await ownedBoundOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  const saleId = positiveInt(body.saleId, "Venda"),
    reason = string(body.reason, "Motivo", 500),
    correlationId = randomUUID(),
    idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const approvalId = optionalString(body.approvalId, 120);
  const cancelSaleLocator = await db.sale.findFirst({
    where: { id: saleId, sessionId: session.id },
    select: { payments: { where: { type: "payment" }, select: { id: true } } },
  });
  const cancelPaymentLocatorIds = (cancelSaleLocator?.payments ?? [])
    .map((payment) => payment.id)
    .sort();
  const refundPaymentIds = new Map(
    cancelPaymentLocatorIds.map((paymentId) => [paymentId, randomUUID()]),
  );
  const result = await db.$transaction(
    async (tx) => {
      await prelockPosSalePaymentWriteGraph(tx, {
        mode: "historical_refund",
        existingPaymentIds: cancelPaymentLocatorIds,
        allowLegacyNoPlanPayments: true,
        refundOriginalPaymentIds: cancelPaymentLocatorIds,
        insertIdempotencyKeys: cancelPaymentLocatorIds.map(
          (paymentId) => `${idempotencyKey}:refund:${paymentId}`,
        ),
        historicalActorProfileIds: [context.profile.id],
      });
      await assertLiveTerminalProof(tx, context, terminalProof, register.id);
      if (
        !(await tx.cashRegisterSession.findFirst({
          where: {
            id: session.id,
            registerId: register.id,
            operatorProfileId: context.profile.id,
            status: "open",
            version: session.version,
          },
        }))
      )
        throw new PosDomainError("O turno foi fechado ou alterado.");
      const liveAccess = await liveRegisterSaleAccess(tx, context, register.id);
      const requiresApproval = !liveAccess.canCancel && !context.privileged;
      if (requiresApproval && !approvalId)
        throw new PosDomainError(
          "O cancelamento exige aprovação de um administrador.",
        );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "sales" WHERE "id" = ${saleId} FOR UPDATE`,
      );
      const sale = await tx.sale.findFirst({
        where: { id: saleId, sessionId: session.id },
        include: {
          items: { include: { kitComponents: true } },
          payments: {
            where: { type: "payment" },
            include: {
              refunds: {
                select: { id: true, status: true, amountCents: true },
              },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      });
      if (!sale) throw new PosDomainError("Venda não encontrada neste turno.");
      if (sale.status === "cancelled") {
        await reverseSalePromotionRedemptions(
          tx,
          context,
          sale.id,
          "sale_cancel",
          sale.cancelledReason || reason,
          String(sale.id),
          correlationId,
        );
        return sale;
      }
      if (sale.status !== "completed")
        throw new PosDomainError(
          "Esta venda não pode ser cancelada neste estado.",
        );
      const lockedCancelPaymentIds = sale.payments
        .map((payment) => payment.id)
        .sort();
      if (
        JSON.stringify(lockedCancelPaymentIds) !==
        JSON.stringify(cancelPaymentLocatorIds)
      )
        throw new PosDomainError(
          "Os pagamentos da venda mudaram durante o pré-lock do cancelamento.",
        );
      const originalPayments = sale.payments;
      if (requiresApproval) {
        const approvalContext = buildPosCancelApprovalContext({
          sale,
          branchId: context.branch.id,
          processingSessionId: session.id,
          registerId: register.id,
          reason,
        });
        await consumeApprovedPosAction(
          tx,
          context,
          approvalId!,
          "sale.cancel",
          "sale",
          String(sale.id),
          idempotencyKey,
          approvalContext,
        );
      }
      const electronic = originalPayments.filter(
        (payment) => !["cash", "store_credit"].includes(payment.method),
      );
      if (electronic.length)
        throw new PosDomainError(
          "Cancelamento eletrônico exige confirmação server-side do conector; esta instalação ainda não possui um provedor homologado ativo.",
        );
      const cashRefundCents = originalPayments
        .filter((payment) => payment.method === "cash")
        .reduce((sum, payment) => sum + payment.amountCents, 0);
      const [sessionPayments, cashEvents] = await Promise.all([
        tx.posSalePayment.findMany({
          where: {
            processingSessionId: session.id,
            method: "cash",
            type: { in: ["payment", "refund"] },
            status: { in: ["authorized", "captured", "paid", "refunded"] },
          },
        }),
        tx.cashRegisterEvent.findMany({
          where: {
            sessionId: session.id,
            type: { in: ["supply", "withdrawal"] },
          },
        }),
      ]);
      const availableCash =
        session.openingAmountCents +
        sessionPayments.reduce(
          (sum, payment) =>
            sum +
            (payment.type === "refund"
              ? -payment.amountCents
              : payment.amountCents),
          0,
        ) +
        cashEvents.reduce(
          (sum, event) =>
            sum +
            (event.type === "supply" ? event.amountCents : -event.amountCents),
          0,
        );
      if (cashRefundCents > availableCash)
        throw new PosDomainError(
          "O estorno supera o saldo físico esperado. Registre um suprimento ou encaminhe à tesouraria.",
        );
      const businessDate = posBusinessDate(context.branch.timezone);
      for (const item of sale.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
        });
        const variation = item.variationId
          ? await tx.productVariation.findUnique({
              where: { id: item.variationId },
            })
          : null;
        if (!product) continue;
        await tx.product.update({
          where: { id: item.productId },
          data: { totalSales: { decrement: item.quantity } },
        });
        if (item.kitComponents.length) {
          if (!sale.warehouseId)
            throw new PosDomainError(
              `A venda não possui depósito para restaurar os componentes de ${item.productName}.`,
            );
          await restorePosKitSaleItemComponents(tx, {
            saleItemId: item.id,
            warehouseId: sale.warehouseId,
            kitQuantity: item.quantity,
            cancellation: true,
            disposition: "restock",
            businessDate,
            idempotencyKey,
            actor: context.profile.displayName,
            referenceType: "sale_cancel",
            referenceId: String(sale.id),
            note: `Cancelamento ${sale.saleNumber}`,
          });
          continue;
        }
        const tracked = await restorePosTrackedSaleItem(tx, {
          saleItemId: item.id,
          quantity: item.quantity,
          disposition: "restock",
          businessDate,
          idempotencyKey,
          actor: context.profile.displayName,
          referenceType: "sale_cancel",
          referenceId: String(sale.id),
        });
        const mode = stockMode(
          product.type,
          product.manageStock,
          variation?.manageStock,
        );
        const inventoryDelta = tracked.tracked
          ? tracked.aggregateQuantityDelta
          : mode === "none"
            ? 0
            : item.quantity;
        if (inventoryDelta <= 0) continue;
        if (!sale.warehouseId)
          throw new PosDomainError(
            `A venda não possui depósito para restaurar ${item.productName}.`,
          );
        await applyPosCommonStockChange(tx, {
          warehouseId: sale.warehouseId,
          product,
          variation,
          delta: inventoryDelta,
          allowNegative: true,
          movementType: "entry",
          ledgerType: "sale_cancel",
          referenceType: "sale",
          referenceId: String(sale.id),
          actor: context.profile.displayName,
          note: `Cancelamento ${sale.saleNumber}`,
        });
      }
      for (const payment of originalPayments) {
        if (payment.method === "store_credit") {
          const accountId = valuePaymentAccountId(payment.metadata);
          await refundPosSaleValue(tx, {
            branchId: context.branch.id,
            accountId,
            amountUnits: posValueRefundUnits(
              valuePaymentAmountUnits(payment.metadata),
              payment.amountCents,
              payment.amountCents,
            ),
            referenceType: "sale_cancel",
            referenceId: String(sale.id),
            operationKey: `${idempotencyKey}:value-refund:${payment.id}`,
            actor: context.profile.displayName,
            now: new Date(),
          });
        }
        const refundPaymentId = refundPaymentIds.get(payment.id)!;
        const refundIdempotencyKey = `${idempotencyKey}:refund:${payment.id}`;
        const refundedAt = new Date();
        await preparePosSalePaymentWrite(tx, {
          action: "insert_refund_cancel",
          id: refundPaymentId,
          expectedVersion: -1,
          actorUserId: context.permission.user.id,
          idempotencyKey: refundIdempotencyKey,
          target: posSalePaymentWriteTarget({
            id: refundPaymentId,
            saleId: sale.id,
            processingSessionId: session.id,
            originalPaymentId: payment.id,
            type: "refund",
            method: payment.method,
            status: "refunded",
            amountCents: payment.amountCents,
            tenderedCents: payment.amountCents,
            provider: payment.provider,
            idempotencyKey: refundIdempotencyKey,
            refundedAt,
          }),
        });
        await tx.posSalePayment.create({
          data: {
            id: refundPaymentId,
            saleId: sale.id,
            processingSessionId: session.id,
            originalPaymentId: payment.id,
            paymentPlanId: null,
            paymentIndex: null,
            type: "refund",
            method: payment.method,
            status: "refunded",
            amountCents: payment.amountCents,
            tenderedCents: payment.amountCents,
            provider: payment.provider,
            idempotencyKey: refundIdempotencyKey,
            refundedAt,
          },
        });
        const updateIdempotencyKey = `${refundIdempotencyKey}:original-status`;
        await preparePosSalePaymentWrite(tx, {
          action: "update_refund_status",
          id: payment.id,
          expectedVersion: -1,
          actorUserId: context.permission.user.id,
          idempotencyKey: updateIdempotencyKey,
          target: posSalePaymentWriteTarget({
            ...payment,
            status: "refunded",
            refundedAt: null,
            metadata:
              payment.metadata == null
                ? null
                : (JSON.parse(
                    JSON.stringify(payment.metadata),
                  ) as Prisma.InputJsonValue),
          }),
        });
        await tx.posSalePayment.update({
          where: { id: payment.id },
          data: { status: "refunded", refundedAt },
        });
      }
      const updated = await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: "cancelled",
          cancelledReason: reason,
          cancelledBy: context.profile.displayName,
          cancelledAt: new Date(),
        },
        include: { items: true, payments: true },
      });
      await reverseSalePromotionRedemptions(
        tx,
        context,
        sale.id,
        "sale_cancel",
        reason,
        String(sale.id),
        correlationId,
      );
      await reversePosSaleAccruals(tx, {
        branchId: context.branch.id,
        saleId: sale.id,
        saleTotalCents: sale.totalCents,
        returnedCents: sale.totalCents,
        operationKeyRoot: idempotencyKey,
        reason: `Cancelamento: ${reason}`,
        actor: context.profile.displayName,
        now: new Date(),
      });
      await tx.posSaleEvent.create({
        data: {
          saleId: sale.id,
          type: "sale.cancelled",
          actorId: context.permission.user.id,
          actorName: context.profile.displayName,
          correlationId,
          data: { reason, idempotencyKey },
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.permission.user.id,
          action: "pos.sale.cancelled",
          entityType: "sale",
          entityId: String(sale.id),
          correlationId,
          beforeData: { status: sale.status },
          afterData: { status: "cancelled", reason },
        },
      });
      return updated;
    },
    { isolationLevel: "Serializable" },
  );
  return Response.json({ sale: result, correlationId });
}

async function createReturn(
  db: Db,
  context: Access,
  body: Record<string, unknown>,
  terminalProof: PosOperationalTerminalProof,
) {
  const session = await ownedBoundOpenSession(
    db,
    context,
    positiveInt(body.sessionId, "Turno"),
    terminalProof,
  );
  const register = accessFor(context, session.registerId!);
  const saleId = positiveInt(body.saleId, "Venda"),
    requestedItems = array(body.items, "Itens").map((entry) => {
      const item = object(entry);
      return {
        saleItemId: positiveInt(item.saleItemId, "Item"),
        quantity: quantity(item.quantity),
        disposition: choice(
          item.disposition || "restock",
          ["restock", "quarantine", "discard"] as const,
          "Destino",
        ),
      };
    });
  if (!requestedItems.length)
    throw new PosDomainError("Selecione itens para devolver.");
  if (requestedItems.length > 200)
    throw new PosDomainError("A devolução excede o limite de 200 itens.");
  if (
    new Set(requestedItems.map((item) => item.saleItemId)).size !==
    requestedItems.length
  )
    throw new PosDomainError(
      "Cada item da venda deve aparecer uma única vez na devolução.",
    );
  if (body.exchange != null && typeof body.exchange !== "boolean")
    throw new PosDomainError("Opção de troca inválida.");
  const exchangeRequested = body.exchange === true;
  const reasonCode = string(body.reasonCode || "customer_return", "Motivo", 60),
    description = string(body.description, "Descrição", 500);
  const approvalId = optionalString(body.approvalId, 120);
  const correlationId = randomUUID(),
    idempotencyKey = string(body.idempotencyKey, "Chave idempotente", 100);
  const exchangeHeldSaleId = exchangeRequested
    ? `exchange-${hashPayload({ kind: "pos-return-exchange", idempotencyKey }).slice(0, 32)}`
    : null;
  const exchangeHeldItemsIdempotencyKey = exchangeRequested
    ? `exchange:${hashPayload({ kind: "pos-return-exchange-items", idempotencyKey }).slice(0, 48)}`
    : null;
  const requestHash = hashPayload({
    saleId,
    requestedItems,
    reasonCode,
    description,
    approvalId,
    exchangeRequested,
  });
  const existing = await db.posReturn.findUnique({
    where: { idempotencyKey },
    include: {
      items: true,
      sale: { select: { branchId: true } },
      exchangeHeldSale: { include: { items: true } },
    },
  });
  if (existing) {
    if (
      existing.saleId !== saleId ||
      existing.processingSessionId !== session.id ||
      existing.sale.branchId !== context.branch.id ||
      existing.requestHash !== requestHash
    )
      throw new PosDomainError(
        "A chave idempotente já foi usada em outra devolução.",
      );
    return Response.json({
      return: existing,
      exchangeDraft: existing.exchangeHeldSale,
      replayed: true,
    });
  }
  // Read-only locator: identities are used only to acquire the canonical
  // payment locks. Eligibility and the exact payment set are revalidated
  // after the sale itself is locked inside the transaction.
  const returnSaleLocator = await db.sale.findFirst({
    where: { id: saleId, branchId: context.branch.id },
    select: { payments: { where: { type: "payment" }, select: { id: true } } },
  });
  const returnPaymentLocatorIds = (returnSaleLocator?.payments ?? [])
    .map((payment) => payment.id)
    .sort();
  const refundPaymentIds = new Map(
    returnPaymentLocatorIds.map((paymentId) => [paymentId, randomUUID()]),
  );
  let result;
  try {
    result = await db.$transaction(
      async (tx) => {
        await prelockPosSalePaymentWriteGraph(tx, {
          mode: "historical_refund",
          existingPaymentIds: returnPaymentLocatorIds,
          allowLegacyNoPlanPayments: true,
          refundOriginalPaymentIds: returnPaymentLocatorIds,
          insertIdempotencyKeys: returnPaymentLocatorIds.map(
            (paymentId) => `${idempotencyKey}:refund:${paymentId}`,
          ),
          historicalActorProfileIds: [context.profile.id],
        });
        if (exchangeHeldSaleId)
          await prelockPosHeldSaleItemWrite(tx, {
            action: "create",
            idempotencyKey: exchangeHeldItemsIdempotencyKey!,
            heldSaleId: exchangeHeldSaleId,
            sessionIds: [session.id],
            terminalIds: [terminalProof.terminalId],
            branchIds: [context.branch.id],
            registerIds: [register.id],
            operatorProfileIds: [context.profile.id],
            terminalRegisterPairs: [[terminalProof.terminalId, register.id]],
            registerBranchPairs: [[register.id, context.branch.id]],
            branchProfilePairs: [[context.branch.id, context.profile.id]],
            registerProfilePairs: [[register.id, context.profile.id]],
          });
        await assertLiveTerminalProof(tx, context, terminalProof, register.id);
        if (
          !(await tx.cashRegisterSession.findFirst({
            where: {
              id: session.id,
              registerId: register.id,
              operatorProfileId: context.profile.id,
              status: "open",
              version: session.version,
            },
          }))
        )
          throw new PosDomainError("O turno foi fechado ou alterado.");
        const liveAccess = await liveRegisterSaleAccess(
          tx,
          context,
          register.id,
        );
        const requiresApproval = !liveAccess.canRefund && !context.privileged;
        if (requiresApproval && !approvalId)
          throw new PosDomainError(
            "A devolução exige aprovação de um administrador.",
          );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "sales" WHERE "id" = ${saleId} FOR UPDATE`,
        );
        const sale = await tx.sale.findFirst({
          where: { id: saleId, branchId: context.branch.id },
          include: {
            items: { include: { kitComponents: true } },
            payments: {
              where: { type: "payment" },
              include: { refunds: true },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
          },
        });
        if (!sale || !["completed", "partially_returned"].includes(sale.status))
          throw new PosDomainError("Venda não elegível para devolução.");
        const lockedReturnPaymentIds = sale.payments
          .map((payment) => payment.id)
          .sort();
        if (
          JSON.stringify(lockedReturnPaymentIds) !==
          JSON.stringify(returnPaymentLocatorIds)
        )
          throw new PosDomainError(
            "Os pagamentos da venda mudaram durante o pré-lock da devolução.",
          );
        const itemById = new Map(sale.items.map((item) => [item.id, item]));
        const lines = requestedItems.map((request) => {
          const item = itemById.get(request.saleItemId),
            epsilon = 0.000_001;
          if (
            !item ||
            request.quantity > item.quantity - item.returnedQuantity + epsilon
          )
            throw new PosDomainError(
              "Quantidade de devolução superior ao saldo do item.",
            );
          const refundCents = calculatePosReturnRefundCents(
            {
              totalQuantity: item.quantity,
              returnedQuantity: item.returnedQuantity,
              totalCents: item.totalCents,
              returnedCents: item.returnedCents,
            },
            request.quantity,
          );
          return { ...request, item, refundCents };
        });
        const totalRefundCents = lines.reduce(
          (sum, line) => sum + line.refundCents,
          0,
        );
        let remainingRefund = totalRefundCents;
        const allocations = sale.payments.flatMap((payment) => {
          const alreadyRefunded = payment.refunds
            .filter(
              (refund) =>
                !["failed", "cancelled", "declined"].includes(refund.status),
            )
            .reduce((sum, refund) => sum + refund.amountCents, 0);
          const amountCents = Math.min(
            Math.max(0, payment.amountCents - alreadyRefunded),
            remainingRefund,
          );
          remainingRefund -= amountCents;
          return amountCents > 0 ? [{ payment, amountCents }] : [];
        });
        if (remainingRefund > 0)
          throw new PosDomainError(
            "O valor da devolução supera o saldo financeiro disponível da venda.",
          );
        if (requiresApproval) {
          const intent = normalizePosPostSaleApprovalIntent(
            "return.create",
            {
              sessionId: session.id,
              items: requestedItems,
              reasonCode,
              description,
              exchangeRequested,
            },
            String(sale.id),
            description,
          ) as PosReturnApprovalIntent;
          const approvalContext = buildPosReturnApprovalContext({
            sale,
            branchId: context.branch.id,
            processingSessionId: session.id,
            registerId: register.id,
            intent,
          });
          await consumeApprovedPosAction(
            tx,
            context,
            approvalId!,
            "return.create",
            "sale",
            String(sale.id),
            idempotencyKey,
            approvalContext,
          );
        }
        if (
          allocations.some(
            ({ payment }) => !["cash", "store_credit"].includes(payment.method),
          )
        )
          throw new PosDomainError(
            "Devolução eletrônica exige um conector server-side homologado; use o fluxo do provedor antes de receber a mercadoria.",
          );
        const [sessionPayments, cashEvents] = await Promise.all([
          tx.posSalePayment.findMany({
            where: {
              processingSessionId: session.id,
              method: "cash",
              type: { in: ["payment", "refund"] },
              status: { in: ["authorized", "captured", "paid", "refunded"] },
            },
          }),
          tx.cashRegisterEvent.findMany({
            where: {
              sessionId: session.id,
              type: { in: ["supply", "withdrawal"] },
            },
          }),
        ]);
        const availableCash =
          session.openingAmountCents +
          sessionPayments.reduce(
            (sum, payment) =>
              sum +
              (payment.type === "refund"
                ? -payment.amountCents
                : payment.amountCents),
            0,
          ) +
          cashEvents.reduce(
            (sum, event) =>
              sum +
              (event.type === "supply"
                ? event.amountCents
                : -event.amountCents),
            0,
          );
        const cashRefundCents = allocations
          .filter(({ payment }) => payment.method === "cash")
          .reduce((sum, allocation) => sum + allocation.amountCents, 0);
        if (cashRefundCents > availableCash)
          throw new PosDomainError(
            "O reembolso em dinheiro supera o saldo físico esperado. Registre um suprimento ou encaminhe à tesouraria.",
          );
        const refundConfirmed = allocations.every(({ payment }) =>
          ["cash", "store_credit"].includes(payment.method),
        );
        const refundMethods = [
          ...new Set(allocations.map(({ payment }) => payment.method)),
        ];
        const record = await tx.posReturn.create({
          data: {
            number: number("DEV"),
            idempotencyKey,
            requestHash,
            saleId: sale.id,
            processingSessionId: session.id,
            registerId: register.id,
            status: refundConfirmed ? "completed" : "refund_pending",
            reasonCode,
            description,
            disposition: lines.every((line) => line.disposition === "restock")
              ? "restock"
              : "mixed",
            refundMethod:
              refundMethods.length === 1
                ? refundMethods[0]
                : refundMethods.length
                  ? "mixed"
                  : null,
            totalRefundCents,
            requestedBy: context.profile.displayName,
            approvedBy: context.profile.displayName,
            completedAt: refundConfirmed ? new Date() : null,
            items: {
              create: lines.map((line) => ({
                saleItemId: line.item.id,
                productId: line.item.productId,
                quantity: line.quantity,
                refundCents: line.refundCents,
                disposition: line.disposition,
                warehouseId: sale.warehouseId,
              })),
            },
          },
          include: { items: true },
        });
        const businessDate = posBusinessDate(context.branch.timezone);
        const effectiveDispositions: Array<
          "restock" | "quarantine" | "discard" | "mixed"
        > = [];
        for (const line of lines) {
          await tx.saleItem.update({
            where: { id: line.item.id },
            data: {
              returnedQuantity: { increment: line.quantity },
              returnedCents: { increment: line.refundCents },
            },
          });
          const product = await tx.product.findUnique({
            where: { id: line.item.productId },
          });
          if (product)
            await tx.product.update({
              where: { id: product.id },
              data: {
                totalSales: Math.max(0, product.totalSales - line.quantity),
              },
            });
          const returnItem = record.items.find(
            (item) => item.saleItemId === line.item.id,
          );
          if (!returnItem)
            throw new PosDomainError(
              `Item de devolução não encontrado para ${line.item.productName}.`,
            );
          if (line.item.kitComponents.length) {
            if (!sale.warehouseId)
              throw new PosDomainError(
                `A venda não possui depósito para devolver os componentes de ${line.item.productName}.`,
              );
            const kitDisposition = await restorePosKitSaleItemComponents(tx, {
              saleItemId: line.item.id,
              returnItemId: returnItem.id,
              warehouseId: sale.warehouseId,
              kitQuantity: line.quantity,
              cancellation: false,
              disposition: line.disposition,
              businessDate,
              idempotencyKey,
              actor: context.profile.displayName,
              referenceType: "pos_return",
              referenceId: record.id,
              note: `Devolução ${record.number}`,
            });
            effectiveDispositions.push(kitDisposition);
            if (kitDisposition !== returnItem.disposition)
              await tx.posReturnItem.update({
                where: { id: returnItem.id },
                data: { disposition: kitDisposition },
              });
            continue;
          }
          const tracked = await restorePosTrackedSaleItem(tx, {
            saleItemId: line.item.id,
            returnItemId: returnItem.id,
            quantity: line.quantity,
            disposition: line.disposition,
            businessDate,
            idempotencyKey,
            actor: context.profile.displayName,
            referenceType: "pos_return",
            referenceId: record.id,
          });
          const effectiveDisposition =
            tracked.effectiveDisposition || line.disposition;
          effectiveDispositions.push(effectiveDisposition);
          if (effectiveDisposition !== returnItem.disposition)
            await tx.posReturnItem.update({
              where: { id: returnItem.id },
              data: { disposition: effectiveDisposition },
            });
          const variation = line.item.variationId
            ? await tx.productVariation.findUnique({
                where: { id: line.item.variationId },
              })
            : null;
          const mode = product
            ? stockMode(
                product.type,
                product.manageStock,
                variation?.manageStock,
              )
            : "none";
          const inventoryDelta = tracked.tracked
            ? tracked.aggregateQuantityDelta
            : line.disposition === "restock" && mode !== "none"
              ? line.quantity
              : 0;
          if (!product || inventoryDelta <= 0) continue;
          if (!sale.warehouseId)
            throw new PosDomainError(
              `A venda não possui depósito para devolver ${line.item.productName}.`,
            );
          await applyPosCommonStockChange(tx, {
            warehouseId: sale.warehouseId,
            product,
            variation,
            delta: inventoryDelta,
            allowNegative: true,
            movementType: "entry",
            ledgerType: "return",
            referenceType: "pos_return",
            referenceId: record.id,
            actor: context.profile.displayName,
            note: `Devolução ${record.number}`,
          });
        }
        const effectiveReturnDisposition =
          new Set(effectiveDispositions).size === 1
            ? effectiveDispositions[0]
            : "mixed";
        const finalRecord =
          effectiveReturnDisposition === record.disposition
            ? record
            : await tx.posReturn.update({
                where: { id: record.id },
                data: { disposition: effectiveReturnDisposition },
                include: { items: true },
              });
        const fullyReturned = sale.items.every(
          (item) =>
            item.returnedQuantity +
              (lines.find((line) => line.item.id === item.id)?.quantity || 0) >=
            item.quantity - 0.000_001,
        );
        await tx.sale.update({
          where: { id: sale.id },
          data: {
            status: refundConfirmed
              ? fullyReturned
                ? "refunded"
                : "partially_returned"
              : "return_pending",
          },
        });
        for (const { payment, amountCents } of allocations) {
          if (payment.method === "store_credit") {
            const accountId = valuePaymentAccountId(payment.metadata);
            await refundPosSaleValue(tx, {
              branchId: context.branch.id,
              accountId,
              amountUnits: posValueRefundUnits(
                valuePaymentAmountUnits(payment.metadata),
                payment.amountCents,
                amountCents,
              ),
              referenceType: "pos_return",
              referenceId: record.id,
              operationKey: `${idempotencyKey}:value-refund:${payment.id}`,
              actor: context.profile.displayName,
              now: new Date(),
            });
          }
          const refundPaymentId = refundPaymentIds.get(payment.id)!;
          const refundIdempotencyKey = `${idempotencyKey}:refund:${payment.id}`;
          const refundedAt = new Date();
          await preparePosSalePaymentWrite(tx, {
            action: "insert_refund_return",
            id: refundPaymentId,
            expectedVersion: -1,
            actorUserId: context.permission.user.id,
            idempotencyKey: refundIdempotencyKey,
            target: posSalePaymentWriteTarget({
              id: refundPaymentId,
              saleId: sale.id,
              processingSessionId: session.id,
              originalPaymentId: payment.id,
              type: "refund",
              method: payment.method,
              status: "refunded",
              amountCents,
              tenderedCents: amountCents,
              provider: payment.provider,
              idempotencyKey: refundIdempotencyKey,
              refundedAt,
            }),
          });
          await tx.posSalePayment.create({
            data: {
              id: refundPaymentId,
              saleId: sale.id,
              processingSessionId: session.id,
              originalPaymentId: payment.id,
              paymentPlanId: null,
              paymentIndex: null,
              type: "refund",
              method: payment.method,
              status: "refunded",
              amountCents,
              tenderedCents: amountCents,
              provider: payment.provider,
              idempotencyKey: refundIdempotencyKey,
              refundedAt,
            },
          });
          const refunded =
            payment.refunds
              .filter(
                (refund) =>
                  !["failed", "cancelled", "declined"].includes(refund.status),
              )
              .reduce((sum, refund) => sum + refund.amountCents, 0) +
            amountCents;
          const fullyRefunded = refunded >= payment.amountCents;
          const resultingStatus = fullyRefunded
            ? "refunded"
            : "partially_refunded";
          const resultingRefundedAt = fullyRefunded ? refundedAt : null;
          const updateIdempotencyKey = `${refundIdempotencyKey}:original-status`;
          await preparePosSalePaymentWrite(tx, {
            action: "update_refund_status",
            id: payment.id,
            expectedVersion: -1,
            actorUserId: context.permission.user.id,
            idempotencyKey: updateIdempotencyKey,
            target: posSalePaymentWriteTarget({
              ...payment,
              status: resultingStatus,
              refundedAt: null,
              metadata:
                payment.metadata == null
                  ? null
                  : (JSON.parse(
                      JSON.stringify(payment.metadata),
                    ) as Prisma.InputJsonValue),
            }),
          });
          await tx.posSalePayment.update({
            where: { id: payment.id },
            data: { status: resultingStatus, refundedAt: resultingRefundedAt },
          });
        }
        if (refundConfirmed && fullyReturned) {
          await reverseSalePromotionRedemptions(
            tx,
            context,
            sale.id,
            "full_return",
            record.reasonCode,
            record.id,
            correlationId,
          );
        }
        if (refundConfirmed)
          await reversePosSaleAccruals(tx, {
            branchId: context.branch.id,
            saleId: sale.id,
            saleTotalCents: sale.totalCents,
            returnedCents:
              sale.items.reduce((sum, item) => sum + item.returnedCents, 0) +
              totalRefundCents,
            operationKeyRoot: idempotencyKey,
            reason: `${fullyReturned ? "Devolução integral" : "Devolução parcial"}: ${record.reasonCode}`,
            actor: context.profile.displayName,
            now: new Date(),
          });
        if (exchangeRequested)
          await preparePosHeldSaleItemsCapability(tx, {
            action: "insert",
            heldSaleId: exchangeHeldSaleId!,
            expectedRevision: 0,
            actorUserId: context.permission.user.id,
            idempotencyKey: exchangeHeldItemsIdempotencyKey!,
            operationalContext: {
              branchId: context.branch.id,
              registerId: register.id,
              sessionId: session.id,
              operatorProfileId: context.profile.id,
              terminalId: terminalProof.terminalId,
              orderClaimId: null,
            },
            items: lines.map((line) => ({
              productId: line.item.productId,
              variationId: line.item.variationId,
              quantity: line.quantity,
              unitPriceCents: line.item.unitPriceCents,
              discountCents: 0,
              notes:
                "Reposição de troca; lote/série devem ser lidos novamente.",
            })),
          });
        const exchangeDraft = exchangeRequested
          ? await tx.posHeldSale.create({
              data: {
                id: exchangeHeldSaleId!,
                registerId: register.id,
                sessionId: session.id,
                operatorProfileId: context.profile.id,
                idempotencyKey: exchangeHeldItemsIdempotencyKey!,
                requestHash: hashPayload({
                  source: "pos_return_exchange",
                  returnId: record.id,
                  saleId: sale.id,
                  sessionId: session.id,
                  registerId: register.id,
                  customerId: sale.customerId,
                  items: lines.map((line) => ({
                    productId: line.item.productId,
                    variationId: line.item.variationId,
                    quantity: line.quantity,
                  })),
                }),
                customerId: sale.customerId,
                label: `Troca ${sale.saleNumber}`,
                notes: `Troca vinculada à devolução ${record.number}. Preços, descontos, estoque e pagamento serão revalidados na nova venda.`,
                discountCents: 0,
                surchargeCents: 0,
                expiresAt: new Date(Date.now() + 7 * 86_400_000),
                items: {
                  create: lines.map((line) => ({
                    productId: line.item.productId,
                    variationId: line.item.variationId,
                    quantity: line.quantity,
                    unitPriceCents: line.item.unitPriceCents,
                    discountCents: 0,
                    notes:
                      "Reposição de troca; lote/série devem ser lidos novamente.",
                  })),
                },
              },
              include: { items: true },
            })
          : null;
        const completedRecord = exchangeDraft
          ? await tx.posReturn.update({
              where: { id: finalRecord.id },
              data: {
                exchangeStatus: "draft",
                exchangeHeldSaleId: exchangeDraft.id,
                exchangeStartedAt: new Date(),
              },
              include: { items: true },
            })
          : finalRecord;
        const eventType = refundConfirmed
          ? "sale.returned"
          : "sale.return_pending";
        await tx.posSaleEvent.create({
          data: {
            saleId: sale.id,
            type: eventType,
            actorId: context.permission.user.id,
            actorName: context.profile.displayName,
            correlationId,
            data: {
              returnId: record.id,
              totalRefundCents,
              fullyReturned,
              refundConfirmed,
              exchangeHeldSaleId: exchangeDraft?.id ?? null,
            },
          },
        });
        if (exchangeDraft)
          await tx.posSaleEvent.create({
            data: {
              saleId: sale.id,
              type: "sale.exchange.started",
              actorId: context.permission.user.id,
              actorName: context.profile.displayName,
              correlationId,
              data: {
                returnId: record.id,
                heldSaleId: exchangeDraft.id,
                totalRefundCents,
              },
            },
          });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: context.permission.user.id,
            action: refundConfirmed
              ? "pos.return.completed"
              : "pos.return.refund_pending",
            entityType: "pos_return",
            entityId: record.id,
            correlationId,
            afterData: {
              saleId: sale.id,
              processingSessionId: session.id,
              totalRefundCents,
              exchangeStatus: exchangeDraft ? "draft" : null,
              exchangeHeldSaleId: exchangeDraft?.id ?? null,
              items: lines.map((line) => ({
                saleItemId: line.item.id,
                quantity: line.quantity,
              })),
            },
          },
        });
        if (exchangeDraft)
          await tx.tenantAuditEvent.create({
            data: {
              actorId: context.permission.user.id,
              action: "pos.exchange.started",
              entityType: "pos_return",
              entityId: record.id,
              correlationId,
              afterData: {
                saleId: sale.id,
                heldSaleId: exchangeDraft.id,
                returnedCents: totalRefundCents,
                exchangeStatus: "draft",
              },
            },
          });
        return { record: completedRecord, exchangeDraft };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const concurrent = await db.posReturn.findUnique({
      where: { idempotencyKey },
      include: {
        items: true,
        sale: { select: { branchId: true } },
        exchangeHeldSale: { include: { items: true } },
      },
    });
    if (concurrent) {
      if (
        concurrent.saleId !== saleId ||
        concurrent.processingSessionId !== session.id ||
        concurrent.sale.branchId !== context.branch.id ||
        concurrent.requestHash !== requestHash
      )
        throw new PosDomainError(
          "A chave idempotente já foi usada em outra devolução.",
        );
      return Response.json({
        return: concurrent,
        exchangeDraft: concurrent.exchangeHeldSale,
        replayed: true,
      });
    }
    throw error;
  }
  return Response.json(
    {
      return: result.record,
      exchangeDraft: result.exchangeDraft,
      correlationId,
    },
    { status: 201 },
  );
}

async function restorePosKitSaleItemComponents(
  tx: Prisma.TransactionClient,
  input: {
    saleItemId: number;
    returnItemId?: number;
    warehouseId: number;
    kitQuantity: number;
    cancellation: boolean;
    disposition: "restock" | "quarantine" | "discard";
    businessDate: string;
    idempotencyKey: string;
    actor: string;
    referenceType: "sale_cancel" | "pos_return";
    referenceId: string;
    note: string;
  },
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_kit_sale_components" WHERE "sale_item_id" = ${input.saleItemId} ORDER BY "id" FOR UPDATE`,
  );
  const components = await tx.posKitSaleComponent.findMany({
    where: { saleItemId: input.saleItemId },
    include: { product: true, variation: true },
    orderBy: { id: "asc" },
  });
  if (!components.length)
    throw new PosDomainError(
      "O snapshot de componentes do kit não foi encontrado.",
    );
  const dispositions = new Set<
    "restock" | "quarantine" | "discard" | "mixed"
  >();
  for (const component of components) {
    const requestedMicros = input.cancellation
      ? component.quantityMicros - component.returnedMicros
      : posKitReturnMicros(component.unitQuantityMicros, input.kitQuantity);
    if (
      requestedMicros <= BigInt(0) ||
      component.returnedMicros + requestedMicros > component.quantityMicros
    )
      throw new PosDomainError(
        `A devolução supera o saldo do componente ${component.product.name}.`,
      );
    const changed = await tx.posKitSaleComponent.updateMany({
      where: {
        id: component.id,
        returnedMicros: component.returnedMicros,
        quantityMicros: component.quantityMicros,
      },
      data: { returnedMicros: { increment: requestedMicros } },
    });
    if (changed.count !== 1)
      throw new PosDomainError(
        `O saldo pós-venda do componente ${component.product.name} mudou concorrentemente.`,
      );
    await tx.posKitComponentReturnMovement.create({
      data: {
        saleComponentId: component.id,
        returnItemId: input.returnItemId,
        quantityMicros: requestedMicros,
        disposition: input.disposition,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        operationKey: `${input.idempotencyKey}:kit-component:${component.id}`,
        actor: input.actor,
      },
    });
    const quantity = Number(requestedMicros) / 1_000_000;
    const tracked = await restorePosTrackedSaleItem(tx, {
      saleItemId: input.saleItemId,
      trackedProductId: component.productId,
      trackedVariationId: component.variationId,
      returnItemId: input.returnItemId,
      quantity,
      disposition: input.disposition,
      businessDate: input.businessDate,
      idempotencyKey: `${input.idempotencyKey}:kit:${component.id}`,
      actor: input.actor,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    });
    const mode = stockMode(
      component.product.type,
      component.product.manageStock,
      component.variation?.manageStock,
    );
    const inventoryDelta = tracked.tracked
      ? tracked.aggregateQuantityDelta
      : input.disposition === "restock" && mode !== "none"
        ? quantity
        : 0;
    dispositions.add(tracked.effectiveDisposition || input.disposition);
    if (inventoryDelta <= 0) continue;
    await applyPosCommonStockChange(tx, {
      warehouseId: input.warehouseId,
      product: component.product,
      variation: component.variation,
      delta: inventoryDelta,
      allowNegative: true,
      movementType: "entry",
      ledgerType: input.cancellation ? "kit_sale_cancel" : "kit_return",
      referenceType: "pos_kit_sale_component",
      referenceId: component.id,
      actor: input.actor,
      note: input.note,
    });
  }
  return dispositions.size === 1 ? [...dispositions][0] : "mixed";
}

async function reverseSalePromotionRedemptions(
  tx: Prisma.TransactionClient,
  context: Access,
  saleId: number,
  trigger: "sale_cancel" | "full_return",
  detail: string,
  referenceId: string,
  correlationId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_promotion_redemptions" WHERE "sale_id" = ${saleId} ORDER BY "id" FOR UPDATE`,
  );
  const rows = await tx.posPromotionRedemption.findMany({
    where: { saleId },
    select: { id: true, couponId: true, reversedAt: true },
    orderBy: { id: "asc" },
  });
  const plan = planPosPromotionReversal(rows);
  if (!plan.redemptionIds.length)
    return { count: 0, redemptionIds: [] as string[] };
  const couponIds = plan.couponDecrements.map((entry) => entry.couponId);
  if (couponIds.length)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "pos_coupons" WHERE "id" IN (${Prisma.join(couponIds)}) ORDER BY "id" FOR UPDATE`,
    );
  const coupons = couponIds.length
    ? await tx.posCoupon.findMany({
        where: { id: { in: couponIds } },
        select: { id: true, usedCount: true },
      })
    : [];
  const couponById = new Map(coupons.map((coupon) => [coupon.id, coupon]));
  for (const decrement of plan.couponDecrements) {
    const coupon = couponById.get(decrement.couponId);
    if (!coupon || coupon.usedCount < decrement.count)
      throw new PosDomainError(
        "Contador do cupom inconsistente; a reversão foi abortada sem alterar o histórico.",
      );
    const changed = await tx.posCoupon.updateMany({
      where: { id: coupon.id, usedCount: coupon.usedCount },
      data: { usedCount: { decrement: decrement.count } },
    });
    if (changed.count !== 1)
      throw new PosDomainError(
        "O contador do cupom mudou durante a reversão; tente novamente.",
      );
  }
  const reversedAt = new Date(),
    reversalReason = posPromotionReversalReason(trigger, detail);
  const reversedBy = context.permission.user.id;
  if (!reversedBy || reversedBy.length > 160)
    throw new PosDomainError("Ator da reversão promocional inválido.");
  const reversed = await tx.posPromotionRedemption.updateMany({
    where: { id: { in: plan.redemptionIds }, reversedAt: null },
    data: { reversedAt, reversedBy, reversalReason },
  });
  if (reversed.count !== plan.redemptionIds.length)
    throw new PosDomainError(
      "Um resgate promocional mudou durante a reversão; tente novamente.",
    );
  const redemptionIds = plan.redemptionIds.map((id) => id.toString());
  await tx.tenantAuditEvent.create({
    data: {
      actorId: context.permission.user.id,
      action: "pos.promotion.redemption.reversed",
      entityType: "sale",
      entityId: String(saleId),
      correlationId,
      afterData: {
        trigger,
        referenceId,
        reversalReason,
        redemptionIds,
        couponDecrements: plan.couponDecrements,
        reversedAt: reversedAt.toISOString(),
      },
    },
  });
  return { count: reversed.count, redemptionIds };
}

async function ownedOpenSession(db: Db, context: Access, id: number) {
  const session = await db.cashRegisterSession.findFirst({
    where: {
      id,
      operatorProfileId: context.profile.id,
      registerId: { in: context.registers.map((item) => item.id) },
      status: "open",
    },
  });
  if (!session)
    throw new PosDomainError("Turno aberto não encontrado para este operador.");
  return session;
}

async function ownedBoundOpenSession(
  db: Db,
  context: Access,
  id: number,
  terminalProof: PosOperationalTerminalProof,
) {
  const session = await ownedOpenSession(db, context, id);
  assertPosSessionTerminalBinding(session, terminalProof);
  return session;
}

function accessFor(context: Access, registerId: number) {
  const register = context.registers.find((item) => item.id === registerId);
  if (!register?.accesses[0])
    throw new PosDomainError("Você não está autorizado neste caixa.");
  return { ...register, access: register.accesses[0] };
}

async function liveRegisterSaleAccess(
  tx: Prisma.TransactionClient,
  context: Access,
  registerId: number,
) {
  const now = new Date();
  const [branchAccess, registerAccess] = await Promise.all([
    tx.branchUserAccess.findUnique({
      where: {
        branchId_userProfileId: {
          branchId: context.branch.id,
          userProfileId: context.profile.id,
        },
      },
      select: { canSell: true },
    }),
    tx.posRegisterAccess.findFirst({
      where: {
        registerId,
        userProfileId: context.profile.id,
        active: true,
        canSell: true,
        register: { branchId: context.branch.id, status: "active" },
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        ],
      },
      select: {
        canSell: true,
        canCancel: true,
        canRefund: true,
        canManualPayment: true,
        maxDiscountBasisPoints: true,
      },
    }),
  ]);
  if (!branchAccess?.canSell || !registerAccess?.canSell)
    throw new PosDomainError(
      "Seu acesso de venda neste caixa foi revogado ou expirou.",
    );
  return registerAccess;
}

function assertSessionReplayContext(
  session: {
    id: number;
    registerId: number | null;
    operatorProfileId: number | null;
  },
  context: Access,
  requestHash: string,
  storedHash: string | null,
  expected: { sessionId?: number; registerId?: number },
) {
  const authorizedRegister =
    session.registerId != null &&
    context.registers.some((register) => register.id === session.registerId);
  if (
    !authorizedRegister ||
    session.operatorProfileId !== context.profile.id ||
    (expected.sessionId != null && session.id !== expected.sessionId) ||
    (expected.registerId != null && session.registerId !== expected.registerId)
  ) {
    throw new PosDomainError(
      "A chave idempotente pertence a outro contexto operacional.",
    );
  }
  if (storedHash !== requestHash)
    throw new PosDomainError(
      "A chave idempotente já foi usada com outro conteúdo.",
    );
}

function assertHeldReplayContext(
  held: { registerId: number; operatorProfileId: number },
  context: Access,
  requestHash: string,
  storedHash: string | null,
) {
  if (
    held.operatorProfileId !== context.profile.id ||
    !context.registers.some((register) => register.id === held.registerId)
  ) {
    throw new PosDomainError(
      "A chave idempotente pertence a outro contexto operacional.",
    );
  }
  if (storedHash !== requestHash)
    throw new PosDomainError(
      "A chave idempotente já foi usada com outro conteúdo.",
    );
}

async function consumeApprovedPosAction(
  tx: Prisma.TransactionClient,
  context: Access,
  approvalId: string,
  action:
    | "cash.withdrawal"
    | "sale.cancel"
    | "return.create"
    | "session.close.divergence"
    | "discount.override"
    | "payment.manual_reference",
  entityType: "cash_register_session" | "sale" | "sale_draft",
  entityId: string,
  consumptionRef: string,
  expectedContext?:
    | PosDiscountApprovalContext
    | PosManualPaymentApprovalContext
    | PosPostSaleApprovalContext,
) {
  const approval = await assertApprovedPosAction(
    tx,
    context,
    approvalId,
    action,
    entityType,
    entityId,
    expectedContext,
    consumptionRef,
  );
  if (approval.consumedAt) return approval;
  const consumedAt = new Date();
  const changed = await tx.posApproval.updateMany({
    where: {
      id: approval.id,
      status: "approved",
      consumedAt: null,
      expiresAt: { gt: consumedAt },
    },
    data: {
      consumedAt,
      consumedBy: context.permission.user.id,
      consumptionRef,
    },
  });
  if (changed.count !== 1)
    throw new PosDomainError(
      "A aprovação expirou ou foi utilizada em outra sessão.",
    );
  await tx.tenantAuditEvent.create({
    data: {
      actorId: context.permission.user.id,
      action: "pos.approval.consumed",
      entityType: "pos_approval",
      entityId: approval.id,
      correlationId: approval.correlationId,
      afterData: {
        action,
        entityType,
        entityId,
        consumptionRef,
        consumedAt: consumedAt.toISOString(),
      },
    },
  });
  return approval;
}

async function assertApprovedPosAction(
  tx: Prisma.TransactionClient,
  context: Access,
  approvalId: string,
  action:
    | "cash.withdrawal"
    | "sale.cancel"
    | "return.create"
    | "session.close.divergence"
    | "discount.override"
    | "payment.manual_reference",
  entityType: "cash_register_session" | "sale" | "sale_draft",
  entityId: string,
  expectedContext?:
    | PosDiscountApprovalContext
    | PosManualPaymentApprovalContext
    | PosPostSaleApprovalContext,
  reusableConsumptionRef?: string,
) {
  const approval = await tx.posApproval.findFirst({
    where: { id: approvalId, branchId: context.branch.id },
  });
  if (!approval)
    throw new PosDomainError("A aprovação não foi encontrada nesta filial.");
  if (approval.requesterId !== context.permission.user.id)
    throw new PosDomainError("A aprovação pertence a outro solicitante.");
  if (
    approval.action !== action ||
    approval.entityType !== entityType ||
    approval.entityId !== entityId
  )
    throw new PosDomainError("A aprovação não corresponde a esta operação.");
  if (
    approval.status !== "approved" ||
    !approval.approverId ||
    approval.approverId === approval.requesterId
  )
    throw new PosDomainError(
      "A operação ainda não possui aprovação independente.",
    );
  if (
    approval.expiresAt.valueOf() <= Date.now() &&
    !(
      approval.consumedAt &&
      reusableConsumptionRef &&
      approval.consumedBy === context.permission.user.id &&
      approval.consumptionRef === reusableConsumptionRef
    )
  )
    throw new PosDomainError("A aprovação expirou.");
  if (action === "discount.override") {
    if (!expectedContext)
      throw new PosDomainError(
        "O contexto autoritativo do desconto não foi informado.",
      );
    assertPosDiscountApprovalContext(
      approval.context,
      expectedContext as PosDiscountApprovalContext,
    );
  }
  if (action === "payment.manual_reference") {
    if (!expectedContext)
      throw new PosDomainError(
        "O contexto autoritativo da referência manual não foi informado.",
      );
    assertPosManualPaymentApprovalContext(
      approval.context,
      expectedContext as PosManualPaymentApprovalContext,
    );
  }
  if (action === "sale.cancel" || action === "return.create") {
    if (!expectedContext)
      throw new PosDomainError(
        "O snapshot financeiro autoritativo da operação não foi informado.",
      );
    assertPosPostSaleApprovalContext(
      approval.context,
      expectedContext as PosPostSaleApprovalContext,
    );
    const decisionAudit = await tx.tenantAuditEvent.findFirst({
      where: {
        actorId: approval.approverId,
        action: "pos.approval.approved",
        entityType: "pos_approval",
        entityId: approval.id,
        correlationId: approval.correlationId,
      },
      select: { afterData: true },
      orderBy: { createdAt: "desc" },
    });
    const decisionData =
      decisionAudit?.afterData &&
      typeof decisionAudit.afterData === "object" &&
      !Array.isArray(decisionAudit.afterData)
        ? decisionAudit.afterData
        : null;
    if (decisionData?.authenticationMode !== "password_step_up")
      throw new PosDomainError(
        "A aprovação financeira não possui prova de reautenticação do supervisor.",
      );
  }
  if (approval.consumedAt) {
    if (
      reusableConsumptionRef &&
      approval.consumedBy === context.permission.user.id &&
      approval.consumptionRef === reusableConsumptionRef
    )
      return approval;
    throw new PosDomainError("A aprovação já foi utilizada em outra operação.");
  }
  return approval;
}

function currentPrice(
  product: {
    price: number;
    salePrice: number | null;
    saleStartsAt: Date | null;
    saleEndsAt: Date | null;
  },
  now = Date.now(),
) {
  return product.salePrice != null &&
    (!product.saleStartsAt || product.saleStartsAt.valueOf() <= now) &&
    (!product.saleEndsAt || product.saleEndsAt.valueOf() >= now)
    ? product.salePrice
    : product.price;
}

function posProductImageUrl(
  product:
    | {
        imageMediaId: string | null;
        gallery: Array<{ mediaAssetId: string }>;
        variations: Array<{
          id: number;
          imageMediaId: string | null;
          gallery: Array<{ mediaAssetId: string }>;
        }>;
      }
    | undefined,
  variationId?: number | null,
) {
  if (!product) return null;
  const variation = variationId
    ? product.variations.find((item) => item.id === variationId)
    : null;
  const mediaId =
    variation?.imageMediaId ||
    variation?.gallery[0]?.mediaAssetId ||
    product.imageMediaId ||
    product.gallery[0]?.mediaAssetId;
  return mediaId
    ? `/api/erp/library/${encodeURIComponent(mediaId)}/file`
    : null;
}

function currentVariationPrice(
  variation: {
    regularPrice: number | null;
    salePrice: number | null;
    saleStartsAt: Date | null;
    saleEndsAt: Date | null;
  },
  fallback: number,
  now = Date.now(),
) {
  const promotional =
    variation.salePrice != null &&
    (!variation.saleStartsAt || variation.saleStartsAt.valueOf() <= now) &&
    (!variation.saleEndsAt || variation.saleEndsAt.valueOf() >= now);
  return promotional
    ? variation.salePrice!
    : (variation.regularPrice ?? fallback);
}

function allocateCents(totalCents: number, weights: number[]) {
  if (!totalCents) return weights.map(() => 0);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0)
    throw new PosDomainError("Não foi possível ratear o ajuste da venda.");
  const raw = weights.map((weight) => (totalCents * weight) / totalWeight),
    result = raw.map(Math.floor);
  const remainder = totalCents - result.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remainder; index += 1)
    result[order[index % order.length].index] += 1;
  return result;
}

function paymentKey(method: string, provider: string) {
  return `${method}\u0000${method === "cash" ? "" : provider}`;
}
function paymentArtifactOrder(
  left: { kind: string; id: string; paymentIndex: number },
  right: { kind: string; id: string; paymentIndex: number },
) {
  return (
    left.paymentIndex - right.paymentIndex ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}
function manualReferenceConsumeOperationKey(
  saleIdempotencyKey: string,
  referenceId: string,
) {
  return `manual-consume:${createHash("sha256").update(`${saleIdempotencyKey}\0${referenceId}`).digest("hex")}`;
}

function saleCommitRequestHash(
  body: Record<string, unknown>,
  couponCodeHash: string | null,
  couponQrToken: string | null,
) {
  const payments = Array.isArray(body.payments)
    ? body.payments.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return entry;
        const payment = entry as Record<string, unknown>;
        const giftCode = String(payment.giftCode || "").trim(),
          giftPin = String(payment.giftPin || "").trim(),
          giftQrToken = String(payment.giftQrToken || "").trim();
        return {
          ...payment,
          giftCode: giftCode ? hashPosValueRequestSecret(giftCode) : null,
          giftPin: giftPin ? hashPosValueRequestSecret(giftPin) : null,
          giftQrToken: giftQrToken ? hashPosInternalQr(giftQrToken) : null,
        };
      })
    : body.payments;
  return hashPayload({
    ...body,
    payments,
    couponCode: couponCodeHash,
    couponQrToken: couponQrToken ? hashPosInternalQr(couponQrToken) : null,
  });
}

function hashPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Mirrors the immutable release key derivation used by the plan writer. These
 * are locator-only inputs; the plan release procedure revalidates the plan
 * itself after the held-item roots are locked. Acquiring both known release
 * namespaces here prevents a maintenance expiry from holding t2-plan while it
 * waits for the roots this save already owns.
 */
function posPaymentPlanReleaseAdvisoryNamespaces(
  plans: ReadonlyArray<{
    id: string;
    version: number;
    saleDraftId: string;
    orderClaimId?: string | null;
    orderClaim?: { salesOrderId: number } | null;
  }>,
) {
  return plans
    .flatMap((plan) => [
      `pos-held-sale-items:v1:held-sale:${plan.saleDraftId}`,
      `t2-payment-plan:aggregate:${plan.id}`,
      `t2-payment-plan:draft:${plan.saleDraftId}`,
      `t2-payment-plan:idempotency:payment-plan-supersede:${hashPayload({ planId: plan.id, expectedVersion: plan.version })}`,
      `t2-plan:payment-plan-supersede:${hashPayload({ planId: plan.id, expectedVersion: plan.version })}`,
      `t2-plan:payment-plan-expire:${hashPayload({ planId: plan.id, expectedVersion: plan.version })}`,
      ...(plan.orderClaimId
        ? [
            `pos-order-claim:v1:claim:${plan.orderClaimId}`,
            `pos-order-claim:v1:artifacts:${plan.orderClaimId}`,
          ]
        : []),
      ...(plan.orderClaim
        ? [`pos-order-claim:v1:order:${plan.orderClaim.salesOrderId}`]
        : []),
    ])
    .sort();
}

async function lockPaymentPlanReleaseAdvisories(
  tx: Prisma.TransactionClient,
  plans: ReadonlyArray<{
    id: string;
    version: number;
    saleDraftId: string;
    orderClaimId?: string | null;
    orderClaim?: { salesOrderId: number } | null;
  }>,
) {
  for (const namespace of posPaymentPlanReleaseAdvisoryNamespaces(plans)) {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function limitedObject(
  value: unknown,
  label: string,
): Prisma.InputJsonObject | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new PosDomainError(`${label} inválidos.`);
  if (JSON.stringify(value).length > 4096)
    throw new PosDomainError(`${label} excedem o limite permitido.`);
  return value as Prisma.InputJsonObject;
}

function assertSalePaymentKeys(value: Record<string, unknown>) {
  const allowed = new Set([
    "tenderedCents",
    "manualReferenceId",
    "paymentIntentId",
    "valueAccountId",
    "valueUnits",
    "giftCode",
    "giftPin",
    "giftQrToken",
  ]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra)
    throw new PosDomainError(`Campo não permitido no pagamento: ${extra}.`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PosDomainError("Payload inválido.");
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new PosDomainError(`${label} inválido.`);
  return value;
}
function string(value: unknown, label: string, max = 200) {
  const result = String(value ?? "").trim();
  if (!result || result.length > max)
    throw new PosDomainError(`${label} inválido.`);
  return result;
}
function optionalString(value: unknown, max = 200) {
  const result = String(value ?? "").trim();
  if (!result) return null;
  if (result.length > max) throw new PosDomainError("Texto muito longo.");
  return result;
}
function valuePaymentAccountId(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PosDomainError(
      "Pagamento por saldo sem metadados de conta íntegros.",
    );
  const result = String(value.valueAccountId || "");
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(result))
    throw new PosDomainError(
      "Pagamento por saldo sem conta válida para estorno.",
    );
  return result;
}
function valuePaymentAmountUnits(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PosDomainError(
      "Pagamento por saldo sem metadados de unidades íntegros.",
    );
  const units = Number(value.valueAmountUnits);
  if (!Number.isSafeInteger(units) || units <= 0)
    throw new PosDomainError(
      "Pagamento por saldo sem unidades válidas para estorno.",
    );
  return units;
}
function positiveInt(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new PosDomainError(`${label} inválido.`);
  return result;
}
function optionalPositiveInt(value: unknown) {
  if (value == null || value === "") return null;
  return positiveInt(value, "Identificador");
}
function integerRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new PosDomainError(`${label} inválida.`);
  return result;
}
function flag(value: unknown) {
  return value === true;
}
function optionalDate(value: unknown) {
  if (value == null || value === "") return null;
  const result = new Date(String(value));
  if (Number.isNaN(result.valueOf()))
    throw new PosDomainError("Data de validade inválida.");
  return result;
}
function posDate(value: unknown, label: string) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new PosDomainError(`${label} inválida.`);
  const result = new Date(`${text}T00:00:00.000Z`);
  if (
    Number.isNaN(result.valueOf()) ||
    result.toISOString().slice(0, 10) !== text
  )
    throw new PosDomainError(`${label} inválida.`);
  return result;
}
function cashOpeningCount(
  value: unknown,
  expectedCents: number,
): Prisma.InputJsonValue | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PosDomainError("Contagem do fundo de troco inválida.");
  const allowed = new Set([
      "20000",
      "10000",
      "5000",
      "2000",
      "1000",
      "500",
      "200",
      "100",
      "50",
      "25",
      "10",
      "5",
    ]),
    result: Record<string, number> = {};
  let total = 0;
  for (const [denomination, rawCount] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!allowed.has(denomination))
      throw new PosDomainError("Denominação do fundo de troco inválida.");
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 0 || count > 10000)
      throw new PosDomainError("Quantidade de cédulas ou moedas inválida.");
    if (count) result[denomination] = count;
    total += Number(denomination) * count;
  }
  if (total !== expectedCents)
    throw new PosDomainError(
      "A contagem de cédulas e moedas não confere com o fundo de troco.",
    );
  return result;
}
function cents(value: unknown, label: string, allowZero = false) {
  const result = Number(value);
  if (
    !Number.isSafeInteger(result) ||
    result < 0 ||
    (!allowZero && result === 0) ||
    result > 2_147_483_647
  )
    throw new PosDomainError(`${label} inválido.`);
  return result;
}
function quantity(value: unknown) {
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result <= 0 ||
    result > 999_999 ||
    Math.abs(Math.round(result * 1000) - result * 1000) > 1e-9
  )
    throw new PosDomainError("Quantidade inválida.");
  return result;
}
function choice<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] {
  const result = String(value ?? "");
  if (!choices.includes(result)) throw new PosDomainError(`${label} inválido.`);
  return result as T[number];
}
function number(prefix: string) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}
function jsonSafe<T>(value: T): T | null {
  if (!value) return null;
  return JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as T;
}

function failure(error: unknown) {
  if (error instanceof PosHttpError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof PosPaymentPlanError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  if (error instanceof PosTerminalBoundaryError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  if (error instanceof PosInternalQrError)
    return Response.json(
      { error: error.message },
      {
        status:
          error.code === "scope"
            ? 403
            : error.code === "expired"
              ? 410
              : error.code === "key"
                ? 503
                : 422,
      },
    );
  if (error instanceof PosCommonStockError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof PosPaymentPersistenceError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof PosOrderClaimError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  if (
    error instanceof PosDomainError ||
    error instanceof PosCatalogPaginationError ||
    error instanceof PosKitError ||
    error instanceof PosPromotionDomainError ||
    error instanceof PosPromotionRedemptionError ||
    error instanceof PosInventoryTrackingError ||
    error instanceof PosInventoryOperationError ||
    error instanceof PosValueError ||
    error instanceof PosValueSecretError ||
    error instanceof CustomerInputError
  )
    return Response.json(
      { error: error.message },
      {
        status:
          error instanceof PosKitError ||
          error instanceof PosValueError ||
          error instanceof PosValueSecretError
            ? error.status
            : error.message.includes("Origem")
              ? 403
              : 422,
      },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  if ((error as { code?: string })?.code === "P2002")
    return Response.json(
      {
        error:
          "A operação já foi registrada ou conflita com um turno existente.",
      },
      { status: 409 },
    );
  if ((error as { code?: string })?.code === "P2034")
    return Response.json(
      { error: "Conflito concorrente. Atualize o PDV e tente novamente." },
      { status: 409 },
    );
  if (
    (error as { code?: string; message?: string })?.code === "P2010" &&
    String((error as { message?: string }).message || "").includes(
      "payment plan graph transport is DLP-unsafe",
    )
  ) {
    console.error("POS payment-plan transport rejected", { error: error instanceof Error ? error.name : typeof error });
    return Response.json(
      {
        error:
          "O plano de pagamento não pôde ser validado. Atualize os preços e tente novamente.",
      },
      { status: 422, headers: { "cache-control": "no-store" } },
    );
  }
  console.error("POS operation failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json(
    { error: "Não foi possível concluir a operação do PDV." },
    { status: 500 },
  );
}
