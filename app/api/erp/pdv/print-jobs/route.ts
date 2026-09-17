import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    await enforcePosRateLimit(db, permission.user.id, "print.enqueue");
    const body = await readPosJson(request, 16_384);
    onlyKeys(body, ["sessionId", "saleId", "terminalId", "copy", "reason", "idempotencyKey"]);
    const sessionId = positiveInt(body.sessionId, "Turno"), saleId = positiveInt(body.saleId, "Venda");
    const terminalId = text(body.terminalId, 100, "Terminal"), copy = choice(body.copy, ["original", "reprint"] as const, "Tipo de cópia");
    const reason = copy === "reprint" ? text(body.reason, 500, "Motivo da reimpressão", 8) : null;
    const idempotencyKey = key(body.idempotencyKey);
    const requestHash = hash({ actorId: permission.user.id, sessionId, saleId, terminalId, copy, reason });
    const profile = await db.tenantUserProfile.findUnique({ where: { userId: permission.user.id }, select: { id: true, status: true } });
    if (!profile || profile.status !== "active") throw denied("Perfil operacional ativo não configurado.");
    const privileged = ["owner", "admin"].includes(permission.membership.role);
    const now = new Date(), correlationId = randomUUID();
    try {
      const result = await db.$transaction(async tx => {
        const session = await tx.cashRegisterSession.findFirst({ where: { id: sessionId, operatorProfileId: profile.id, status: "open", register: { status: "active", branch: { status: "active" } } }, select: { id: true, registerId: true, register: { select: { branchId: true, name: true } } } });
        if (!session?.registerId || !session.register) throw denied("A impressão exige um turno aberto do próprio operador.");
        const terminal = await tx.posTerminal.findFirst({ where: { id: terminalId, registerId: session.registerId, status: { notIn: ["unpaired", "revoked"] }, devices: { some: { type: "printer" } } }, select: { id: true, name: true } });
        if (!terminal) throw denied("O terminal não pertence a este caixa ou não possui impressora configurada.");
        const access = privileged ? { canSell: true, canReprint: true } : await tx.posRegisterAccess.findFirst({ where: { registerId: session.registerId, userProfileId: profile.id, active: true, canSell: true, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }] }, select: { canSell: true, canReprint: true } });
        if (!access?.canSell || copy === "reprint" && !access.canReprint) throw denied(copy === "reprint" ? "Você não possui alçada de reimpressão neste caixa." : "Seu acesso de venda neste caixa não está vigente.");
        if (!privileged && !await tx.branchUserAccess.findFirst({ where: { branchId: session.register.branchId, userProfileId: profile.id, canSell: true }, select: { id: true } })) throw denied("Seu acesso de venda nesta filial não está vigente.");
        const sale = await tx.sale.findFirst({ where: { id: saleId, sessionId, branchId: session.register.branchId }, select: {
          id: true, saleNumber: true, customer: true, seller: true, cashRegister: true, createdAt: true, subtotalCents: true, discountCents: true, surchargeCents: true, totalCents: true, changeCents: true, status: true,
          items: { select: { productName: true, skuSnapshot: true, gtinSnapshot: true, unit: true, quantity: true, unitPriceCents: true, discountCents: true, surchargeCents: true, totalCents: true } },
          payments: { select: { method: true, status: true, amountCents: true, tenderedCents: true, changeCents: true, provider: true, nsu: true, authorizationCode: true, cardBrand: true, cardLastFour: true, installments: true } },
          branch: { select: { name: true, legalName: true, document: true, street: true, number: true, complement: true, district: true, city: true, state: true, zip: true } },
        } });
        if (!sale) throw denied("A venda não pertence ao turno e à filial atuais.");
        const existing = await tx.posPrintJob.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (!existing.requestHash || existing.requestHash !== requestHash) throw new PosHttpError("A chave idempotente já foi usada em outra impressão.", 409);
          return { job: existing, replayed: true };
        }
        const settings = await tx.tenantSettings.findUnique({ where: { id: 1 }, select: { organizationName: true, tradeName: true, receiptFooter: true, currency: true, locale: true } });
        const payload = JSON.parse(JSON.stringify({ schema: "nalven.pos.receipt.v1", copy, reason, organization: settings, branch: sale.branch, sale: { ...sale, branch: undefined }, requestedAt: now.toISOString(), terminal: { id: terminal.id, name: terminal.name } })) as Prisma.InputJsonObject;
        const created = await tx.posPrintJob.create({ data: { terminalId, type: `receipt.${copy}`, referenceType: "sale", referenceId: String(sale.id), templateVersion: "receipt.v1", payload, requestedBy: permission.user.name, requestedById: permission.user.id, idempotencyKey, requestHash } });
        await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: copy === "reprint" ? "pos.receipt.reprint_queued" : "pos.receipt.print_queued", entityType: "pos_print_job", entityId: created.id, correlationId, afterData: { saleId, terminalId, copy, reason, idempotencyKey } } });
        return { job: created, replayed: false };
      }, { isolationLevel: "Serializable" });
      return Response.json({ job: publicJob(result.job), correlationId: result.replayed ? undefined : correlationId, replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers: noStore() });
    } catch (error) {
      if (!new Set(["P2002", "P2034"]).has(prismaCode(error))) throw error;
      const concurrent = await db.posPrintJob.findUnique({ where: { idempotencyKey } });
      if (concurrent) return replayResponse(concurrent, requestHash);
      if (copy === "original") {
        const original = await db.posPrintJob.findFirst({ where: { type: "receipt.original", referenceType: "sale", referenceId: String(saleId) } });
        if (original) return Response.json({ job: publicJob(original), replayed: true, alreadyQueued: true }, { headers: noStore() });
      }
      throw new PosHttpError("Conflito concorrente ao enfileirar impressão; tente novamente.", 409);
    }
  } catch (error) {
    return failure(error);
  }
}

function replayResponse(value: { requestHash: string | null } & Parameters<typeof publicJob>[0], requestHash: string) {
  if (!value.requestHash || value.requestHash !== requestHash) throw new PosHttpError("A chave idempotente já foi usada em outra impressão.", 409);
  return Response.json({ job: publicJob(value), replayed: true }, { headers: noStore() });
}
function publicJob(value: { id: string; terminalId: string; type: string; referenceId: string; status: string; attempts: number; createdAt: Date }) { return { id: value.id, terminalId: value.terminalId, type: value.type, referenceId: value.referenceId, status: value.status, attempts: value.attempts, createdAt: value.createdAt }; }
function hash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((field) => `${JSON.stringify(field)}:${canonical(record[field])}`).join(",")}}`; }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(value).find((field) => !allowed.includes(field)); if (extra) throw new PosHttpError(`Campo não permitido: ${extra}.`, 422); }
function positiveInt(value: unknown, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new PosHttpError(`${label} inválido.`, 422); return result; }
function text(value: unknown, maximum: number, label: string, minimum = 1) { const result = String(value ?? "").trim(); if (result.length < minimum || result.length > maximum) throw new PosHttpError(`${label} inválido.`, 422); return result; }
function key(value: unknown) { const result = text(value, 160, "Chave idempotente", 16); if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosHttpError("Chave idempotente inválida.", 422); return result; }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { if (typeof value !== "string" || !choices.includes(value)) throw new PosHttpError(`${label} inválido.`, 422); return value as T[number]; }
function denied(message: string) { return new PosHttpError(message, 403); }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function noStore() { return { "cache-control": "no-store", pragma: "no-cache" }; }
function failure(error: unknown) { if (error instanceof PosHttpError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error instanceof PosHttpError ? error.status : 403, headers: noStore() }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStore() }); if (error instanceof AuthError) return authErrorResponse(error); console.error("POS print enqueue failed", { error: error instanceof Error ? error.name : typeof error }); return Response.json({ error: "Não foi possível enfileirar a impressão." }, { status: 500, headers: noStore() }); }
