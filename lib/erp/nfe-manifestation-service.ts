import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { tenantDb } from "@/db";
import { decryptSecret } from "@/lib/secrets";
import { buildScienceEvent, NfeManifestationError, pfxSigningIdentity, sendScienceEvent } from "./nfe-manifestation";
import { validAccessKey, validCnpj } from "./nfe-input";

type TenantDb = Awaited<ReturnType<typeof tenantDb>>;
type Environment = "production" | "homologation";
type Actor = { id: string; name: string };

export type NfeRecovery = {
  accessKey: string;
  branchId: number;
  environment: Environment;
  status: "science_registered" | "available";
  protocol: string | null;
  requestedAt: string;
  nextLookupAt: string;
};

export async function registerNfeScience(db: TenantDb, input: {
  branchId: number;
  accessKey: string;
  environment: Environment;
  acknowledged: boolean;
  actor: Actor;
}) {
  const accessKey = input.accessKey.replace(/\D/g, "");
  if (!validAccessKey(accessKey)) throw new NfeManifestationError("Informe uma chave de acesso de NF-e válida.");
  if (!input.acknowledged) throw new NfeManifestationError("Confirme que a Ciência da Operação será registrada e deverá ser concluída posteriormente.");
  const correlationId = randomUUID();
  return db.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'nfe-science:' + input.environment + ':' + accessKey}))`);
    const [branch, existingDocument, prior] = await Promise.all([
      tx.branch.findFirst({ where: { id: input.branchId, status: "active" }, select: { id: true, document: true } }),
      tx.inboundFiscalDocument.findUnique({ where: { source_accessKey: { source: "sefaz_nfe", accessKey, environment: input.environment } }, select: { id: true, branchId: true, manifestationStatus: true, fullDocumentAvailable: true } }),
      tx.tenantAuditEvent.findFirst({ where: { action: "dfe.manifestation.science.registered", entityType: "nfe_access_key", entityId: accessKey }, select: { afterData: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
    ]);
    if (!branch || !validCnpj(branch.document.replace(/\D/g, ""))) throw new NfeManifestationError("A filial precisa ter um CNPJ válido.");
    if (existingDocument && existingDocument.branchId !== branch.id) throw new NfeManifestationError("A NF-e detectada pertence a outra filial.", 403);
    if (existingDocument?.fullDocumentAvailable) return { accessKey, status: "available" as const, documentId: existingDocument.id, correlationId };
    if (prior) {
      const priorData = jsonObject(prior.afterData), nextLookupAt = stringDate(priorData.nextLookupAt) || new Date(prior.createdAt.getTime() + 60 * 60_000);
      await ensureRecoveryAudit(tx, { accessKey, branchId: branch.id, environment: input.environment, actor: input.actor, correlationId, protocol: textValue(priorData.protocol), requestedAt: prior.createdAt, nextLookupAt });
      await scheduleRecovery(tx, branch.id, input.environment, nextLookupAt);
      await markScience(tx, existingDocument, input.actor.id, correlationId, textValue(priorData.protocol), nextLookupAt);
      return { accessKey, status: "science_registered" as const, protocol: textValue(priorData.protocol), nextLookupAt, correlationId, alreadyRegistered: true };
    }
    const certificate = await tx.fiscalCertificate.findFirst({ where: { branchId: branch.id, active: true, expiresAt: { gte: new Date() } }, orderBy: { expiresAt: "desc" }, select: { encryptedContent: true, encryptedPassword: true } });
    if (!certificate) throw new NfeManifestationError("Configure um certificado A1 válido para esta filial.");
    const pfx = Buffer.from(decryptSecret(certificate.encryptedContent), "base64"), passphrase = decryptSecret(certificate.encryptedPassword), occurredAt = new Date();
    const identity = pfxSigningIdentity(pfx, passphrase, branch.document);
    const eventXml = buildScienceEvent({ accessKey, document: branch.document, environment: input.environment, occurredAt, ...identity });
    const response = await sendScienceEvent({ eventXml, accessKey, pfx, passphrase, environment: input.environment });
    const nextLookupAt = new Date(occurredAt.getTime() + 60 * 60_000);
    await tx.tenantAuditEvent.create({ data: { actorId: input.actor.id, action: "dfe.manifestation.science.registered", entityType: "nfe_access_key", entityId: accessKey, correlationId, afterData: { branchId: branch.id, environment: input.environment, status: response.result.status, reason: response.result.reason, protocol: response.result.protocol, registered: response.result.registered, alreadyRegistered: response.result.alreadyRegistered, requestedAt: occurredAt, nextLookupAt } } });
    await ensureRecoveryAudit(tx, { accessKey, branchId: branch.id, environment: input.environment, actor: input.actor, correlationId, protocol: response.result.protocol, requestedAt: occurredAt, nextLookupAt });
    await scheduleRecovery(tx, branch.id, input.environment, nextLookupAt);
    await markScience(tx, existingDocument, input.actor.id, correlationId, response.result.protocol, nextLookupAt);
    return { accessKey, status: "science_registered" as const, protocol: response.result.protocol, nextLookupAt, correlationId, alreadyRegistered: response.result.alreadyRegistered };
  }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 45_000 });
}

async function scheduleRecovery(tx: Prisma.TransactionClient, branchId: number, environment: Environment, nextLookupAt: Date) {
  const cursor = await tx.dfeSyncCursor.upsert({
    where: { branchId_source_environment: { branchId, source: "sefaz_nfe", environment } },
    create: { branchId, source: "sefaz_nfe", environment, nextSyncAt: nextLookupAt },
    update: { enabled: true },
    select: { id: true },
  });
  await tx.dfeSyncCursor.updateMany({ where: { id: cursor.id, OR: [{ nextSyncAt: null }, { nextSyncAt: { lt: nextLookupAt } }] }, data: { nextSyncAt: nextLookupAt } });
}

async function markScience(tx: Prisma.TransactionClient, document: { id: number; manifestationStatus: string } | null, actorId: string, correlationId: string, protocol: string | null, nextLookupAt: Date) {
  if (!document || document.manifestationStatus === "science") return;
  await tx.inboundFiscalDocument.update({ where: { id: document.id }, data: { manifestationStatus: "science" } });
  await tx.inboundFiscalDocumentEvent.create({ data: { documentId: document.id, type: "dfe.manifestation.science.registered", actorId, correlationId, metadata: { protocol, nextLookupAt } } });
}

export async function listPendingNfeRecoveries(db: TenantDb, branchIds: number[], environment: Environment) {
  if (!branchIds.length) return [] as NfeRecovery[];
  const events = await db.tenantAuditEvent.findMany({
    where: { action: "dfe.key.recovery.requested", entityType: "nfe_access_key", createdAt: { gte: new Date(Date.now() - 120 * 86400000) } },
    select: { entityId: true, afterData: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 100,
  });
  const keys = events.flatMap(event => event.entityId ? [event.entityId] : []);
  const available = keys.length ? await db.inboundFiscalDocument.findMany({ where: { source: "sefaz_nfe", environment, accessKey: { in: keys }, fullDocumentAvailable: true }, select: { accessKey: true } }) : [];
  const availableKeys = new Set(available.flatMap(item => item.accessKey ? [item.accessKey] : [])), seen = new Set<string>(), rows: NfeRecovery[] = [];
  for (const event of events) {
    const data = jsonObject(event.afterData), accessKey = event.entityId || "", branchId = Number(data.branchId), eventEnvironment = data.environment === "homologation" ? "homologation" : "production";
    if (!validAccessKey(accessKey) || !branchIds.includes(branchId) || eventEnvironment !== environment || seen.has(accessKey) || availableKeys.has(accessKey)) continue;
    seen.add(accessKey);
    const requestedAt = stringDate(data.requestedAt) || event.createdAt, nextLookupAt = stringDate(data.nextLookupAt) || new Date(requestedAt.getTime() + 60 * 60_000);
    rows.push({ accessKey, branchId, environment: eventEnvironment, status: "science_registered", protocol: textValue(data.protocol), requestedAt: requestedAt.toISOString(), nextLookupAt: nextLookupAt.toISOString() });
  }
  return rows;
}

export async function recoverAutomaticNfeScience(db: TenantDb) {
  const policies = await db.dfeSyncCursor.findMany({ where: {
    source: "sefaz_nfe", environment: "production", enabled: true, autoScienceEnabled: true,
    autoScienceAuthorizedAt: { not: null }, autoScienceAuthorizedBy: { not: null },
  }, select: { branchId: true, autoScienceAuthorizedBy: true }, take: 10 });
  const result = { registered: 0, alreadyRegistered: 0, failed: 0 };
  const retryCutoff = new Date(Date.now() - 60 * 60_000);
  for (const policy of policies) {
    const documents = await db.inboundFiscalDocument.findMany({ where: {
      branchId: policy.branchId, source: "sefaz_nfe", environment: "production", documentType: "nfe", classification: "goods",
      fullDocumentAvailable: false, manifestationStatus: "pending", accessKey: { not: null },
      status: { notIn: ["ignored", "cancelled", "received"] }, manifestationDeadline: { gte: new Date() },
      events: { none: { type: "dfe.manifestation.science.failed", createdAt: { gte: retryCutoff } } },
    }, select: { id: true, accessKey: true }, orderBy: [{ issueDate: "asc" }, { id: "asc" }], take: 10 });
    for (const document of documents) {
      if (!document.accessKey) continue;
      try {
        const registered = await registerNfeScience(db, {
          branchId: policy.branchId, accessKey: document.accessKey, environment: "production", acknowledged: true,
          actor: { id: "system:dfe-auto-science", name: "Automação fiscal autorizada" },
        });
        if (registered.alreadyRegistered) result.alreadyRegistered++;
        else result.registered++;
      } catch (error) {
        result.failed++;
        await db.inboundFiscalDocumentEvent.create({ data: {
          documentId: document.id, type: "dfe.manifestation.science.failed", actorId: "system:dfe-auto-science", correlationId: randomUUID(),
          metadata: { reason: error instanceof Error ? error.message.slice(0, 300) : "Falha inesperada", retryAfterMinutes: 60 },
        } }).catch(() => undefined);
      }
    }
  }
  return result;
}

async function ensureRecoveryAudit(tx: Prisma.TransactionClient, input: { accessKey: string; branchId: number; environment: Environment; actor: Actor; correlationId: string; protocol: string | null; requestedAt: Date; nextLookupAt: Date }) {
  const exists = await tx.tenantAuditEvent.findFirst({ where: { action: "dfe.key.recovery.requested", entityType: "nfe_access_key", entityId: input.accessKey }, select: { id: true } });
  if (!exists) await tx.tenantAuditEvent.create({ data: { actorId: input.actor.id, action: "dfe.key.recovery.requested", entityType: "nfe_access_key", entityId: input.accessKey, correlationId: input.correlationId, afterData: { branchId: input.branchId, environment: input.environment, status: "science_registered", protocol: input.protocol, requestedAt: input.requestedAt, nextLookupAt: input.nextLookupAt } } });
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Prisma.JsonValue> : {}; }
function textValue(value: Prisma.JsonValue | undefined) { return typeof value === "string" ? value : null; }
function stringDate(value: Prisma.JsonValue | undefined) { if (typeof value !== "string") return null; const date = new Date(value); return Number.isFinite(date.valueOf()) ? date : null; }
