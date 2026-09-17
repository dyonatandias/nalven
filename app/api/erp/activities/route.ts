import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { controlDb, currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import {
  auditChanges, auditCsv, auditFilterSnapshot, auditJsonl, AuditInputError,
  eventKey, investigationCreateInput, investigationLinkInput, investigationNoteInput,
  investigationStatusInput, parseAuditQuery, redactAuditPayload, savedViewInput,
} from "@/lib/erp/audit-center";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
type Db = Awaited<ReturnType<typeof tenantDb>>;
type Actor = { name: string; email: string };

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "activities.read");
    const db = await tenantDb(organization.id);
    const params = new URL(request.url).searchParams;
    const memberships = await controlDb.membership.findMany({ where: { organizationId: organization.id }, include: { user: { select: { id: true, name: true, email: true } } } });
    const actors = new Map(memberships.map((item) => [item.user.id, { name: item.user.name, email: item.user.email }]));
    if (params.get("eventKey")) return detailResponse(db, String(params.get("eventKey")), actors);

    const query = parseAuditQuery(params);
    if (query.format !== "json") {
      const exportId = positiveId(params.get("exportId"), "Registre a exportação antes de baixar o arquivo."), minimumCreatedAt = new Date(Date.now() - 5 * 60_000);
      if (!await db.auditExportEvent.findFirst({ where: { id: exportId, requestedBy: access.user.id, format: query.format, createdAt: { gte: minimumCreatedAt } }, select: { id: true } })) throw new AuditInputError("A autorização da exportação expirou ou não pertence ao usuário atual.");
    }
    const actorMatches = query.search ? memberships.filter((item) => `${item.user.name} ${item.user.email}`.toLocaleLowerCase("pt-BR").includes(query.search.toLocaleLowerCase("pt-BR"))).map((item) => item.userId) : [];
    const tenantWhere = tenantAuditWhere(query, actorMatches);
    const integrationWhere = integrationAuditWhere(query, actorMatches);
    const tenantEnabled = true;
    const integrationEnabled = !query.source || query.source === "integration";
    const take = query.format === "json" ? query.page * query.limit : 5_000;
    const [tenantRows, integrationRows, tenantTotal, integrationTotal] = await Promise.all([
      tenantEnabled ? db.tenantAuditEvent.findMany({ where: tenantWhere, orderBy: [{ createdAt: query.sort === "newest" ? "desc" : "asc" }, { id: query.sort === "newest" ? "desc" : "asc" }], take }) : Promise.resolve([]),
      integrationEnabled ? db.integrationAuditLog.findMany({ where: integrationWhere, orderBy: [{ createdAt: query.sort === "newest" ? "desc" : "asc" }, { id: query.sort === "newest" ? "desc" : "asc" }], take }) : Promise.resolve([]),
      tenantEnabled ? db.tenantAuditEvent.count({ where: tenantWhere }) : 0,
      integrationEnabled ? db.integrationAuditLog.count({ where: integrationWhere }) : 0,
    ]);
    const merged = [...tenantRows.map((item) => mapTenant(item, actors)), ...integrationRows.map((item) => mapIntegration(item, actors))]
      .sort((a, b) => (query.sort === "newest" ? b.createdAt.valueOf() - a.createdAt.valueOf() : a.createdAt.valueOf() - b.createdAt.valueOf()));
    const total = tenantTotal + integrationTotal;
    const exportRows = merged.slice(0, 5_000);
    if (query.format === "csv") return download(auditCsv(exportRows), "csv", "text/csv; charset=utf-8");
    if (query.format === "jsonl") return download(auditJsonl(exportRows), "jsonl", "application/x-ndjson; charset=utf-8");
    const items = merged.slice((query.page - 1) * query.limit, query.page * query.limit);

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const startTrend = new Date(startToday.valueOf() - 13 * 86_400_000);
    const [summary, facets, trend, investigations, savedViews, settings, recentExports, integrity] = await Promise.all([
      summaryData(db, tenantWhere, integrationWhere, tenantEnabled, integrationEnabled, startToday),
      facetData(db), trendData(db, startTrend),
      db.auditInvestigation.findMany({ include: { events: { orderBy: { createdAt: "desc" }, take: 100 }, notes: { orderBy: { createdAt: "desc" }, take: 20 } }, orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: 100 }),
      db.auditSavedView.findMany({ where: { OR: [{ ownerId: access.user.id }, { visibility: "shared" }] }, orderBy: [{ ownerId: "desc" }, { updatedAt: "desc" }], take: 100 }),
      db.tenantSettings.findUnique({ where: { id: 1 }, select: { auditRetentionDays: true, timezone: true, dataProtectionEmail: true } }),
      db.auditExportEvent.findMany({ orderBy: { createdAt: "desc" }, take: 8 }), integrityData(db),
    ]);
    return Response.json({
      items, pagination: { page: query.page, limit: query.limit, total, pages: Math.max(1, Math.ceil(total / query.limit)) },
      summary: { ...summary, total, integrity }, facets, trend, investigations, savedViews, recentExports,
      actors: memberships.map((item) => ({ id: item.user.id, name: item.user.name, email: item.user.email, status: item.status })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
      policy: { retentionDays: settings?.auditRetentionDays || 1825, timezone: settings?.timezone || "America/Sao_Paulo", dataProtectionEmail: settings?.dataProtectionEmail || null, exportLimit: 5_000 },
      capabilities: { canWrite: matches(access.permissions, "activities.write"), canExport: true }, generatedAt: new Date().toISOString(),
    }, { headers: NO_STORE });
  } catch (error) { return failure(error, "consultar a auditoria"); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const db = await tenantDb(organization.id);
    const body = await readPosJson(request, 262_144);
    const action = String(body.action || ""), correlationId = randomUUID();
    const readAccess = await assertTenantPermission(organization.id, "activities.read");
    const access = action === "export.record" ? readAccess : await assertTenantPermission(organization.id, "activities.write");
    if (action !== "export.record") await assertTenantWriteAccess(organization.id);
    await enforcePosRateLimit(db, access.user.id, action === "export.record" ? "audit.export" : "audit.investigation");

    if (action === "investigation.create") {
      const input = investigationCreateInput(body); await assertAssignee(organization.id, input.assigneeId);
      const fingerprints = await validEventFingerprints(db, input.eventKeys);
      const investigation = await db.$transaction(async (tx) => {
        const created = await tx.auditInvestigation.create({ data: { title: input.title, summary: input.summary, severity: input.severity, assigneeId: input.assigneeId, openedBy: access.user.id, dueAt: input.dueAt } });
        if (input.eventKeys.length) await tx.auditInvestigationEvent.createMany({ data: input.eventKeys.map((key) => ({ investigationId: created.id, eventKey: key, eventFingerprint: fingerprints.get(key) || null, linkedBy: access.user.id })) });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "audit.investigation.created", entityType: "audit_investigation", entityId: created.id, correlationId, afterData: { title: created.title, severity: created.severity, assigneeId: created.assigneeId, dueAt: created.dueAt, eventKeys: input.eventKeys } } });
        return tx.auditInvestigation.findUniqueOrThrow({ where: { id: created.id }, include: { events: true, notes: true } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ investigation, correlationId }, { status: 201, headers: NO_STORE });
    }

    if (action === "investigation.link") {
      const input = investigationLinkInput(body), fingerprints = await validEventFingerprints(db, input.eventKeys);
      const investigation = await db.$transaction(async (tx) => {
        const current = await tx.auditInvestigation.findUnique({ where: { id: input.id } }); if (!current) throw new AuditInputError("Investigação não encontrada.");
        const result = await tx.auditInvestigationEvent.createMany({ data: input.eventKeys.map((key) => ({ investigationId: input.id, eventKey: key, eventFingerprint: fingerprints.get(key) || null, linkedBy: access.user.id })), skipDuplicates: true });
        await tx.auditInvestigation.update({ where: { id: input.id }, data: { version: { increment: 1 } } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "audit.investigation.events_linked", entityType: "audit_investigation", entityId: input.id, correlationId, afterData: { eventKeys: input.eventKeys, linked: result.count } } });
        return tx.auditInvestigation.findUniqueOrThrow({ where: { id: input.id }, include: { events: true, notes: { orderBy: { createdAt: "desc" } } } });
      });
      return Response.json({ investigation, correlationId }, { headers: NO_STORE });
    }

    if (action === "investigation.note") {
      const input = investigationNoteInput(body);
      const investigation = await db.$transaction(async (tx) => {
        const current = await tx.auditInvestigation.findUnique({ where: { id: input.id } }); if (!current) throw new AuditInputError("Investigação não encontrada.");
        const note = await tx.auditInvestigationNote.create({ data: { investigationId: input.id, authorId: access.user.id, body: input.body } });
        await tx.auditInvestigation.update({ where: { id: input.id }, data: { version: { increment: 1 } } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "audit.investigation.note_added", entityType: "audit_investigation", entityId: input.id, correlationId, afterData: { noteId: note.id, length: input.body.length } } });
        return tx.auditInvestigation.findUniqueOrThrow({ where: { id: input.id }, include: { events: true, notes: { orderBy: { createdAt: "desc" } } } });
      });
      return Response.json({ investigation, correlationId }, { headers: NO_STORE });
    }

    if (action === "investigation.status") {
      const input = investigationStatusInput(body); await assertAssignee(organization.id, input.assigneeId);
      const investigation = await db.$transaction(async (tx) => {
        const before = await tx.auditInvestigation.findUnique({ where: { id: input.id } }); if (!before) throw new AuditInputError("Investigação não encontrada.");
        const final = input.status === "resolved" || input.status === "dismissed";
        const changed = await tx.auditInvestigation.updateMany({ where: { id: input.id, version: input.expectedVersion }, data: { status: input.status, ...(input.severity ? { severity: input.severity } : {}), assigneeId: input.assigneeId, resolution: final ? input.resolution : null, resolvedAt: final ? new Date() : null, resolvedBy: final ? access.user.id : null, version: { increment: 1 } } });
        if (changed.count !== 1) throw new AuditConflictError();
        const updated = await tx.auditInvestigation.findUniqueOrThrow({ where: { id: input.id }, include: { events: true, notes: { orderBy: { createdAt: "desc" } } } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: `audit.investigation.${input.status}`, entityType: "audit_investigation", entityId: input.id, correlationId, beforeData: { status: before.status, severity: before.severity, assigneeId: before.assigneeId, version: before.version }, afterData: { status: updated.status, severity: updated.severity, assigneeId: updated.assigneeId, resolution: updated.resolution, version: updated.version } } });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ investigation, correlationId }, { headers: NO_STORE });
    }

    if (action === "view.save") {
      const input = savedViewInput(body);
      const view = input.id
        ? await db.auditSavedView.update({ where: { id: input.id, ownerId: access.user.id }, data: { name: input.name, description: input.description, visibility: input.visibility, filters: input.filters } })
        : await db.auditSavedView.create({ data: { name: input.name, description: input.description, visibility: input.visibility, filters: input.filters, ownerId: access.user.id, ownerName: access.user.name } });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: input.id ? "audit.view.updated" : "audit.view.created", entityType: "audit_saved_view", entityId: String(view.id), correlationId, afterData: { name: view.name, visibility: view.visibility } } });
      return Response.json({ view, correlationId }, { status: input.id ? 200 : 201, headers: NO_STORE });
    }

    if (action === "view.delete") {
      const id = positiveId(body.viewId, "Visão inválida.");
      const deleted = await db.auditSavedView.deleteMany({ where: { id, ownerId: access.user.id } }); if (!deleted.count) throw new AuditInputError("Visão não encontrada ou sem permissão para excluir.");
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "audit.view.deleted", entityType: "audit_saved_view", entityId: String(id), correlationId } });
      return Response.json({ deleted: true, correlationId }, { headers: NO_STORE });
    }

    if (action === "export.record") {
      const format = body.format === "jsonl" ? "jsonl" : body.format === "csv" ? "csv" : null; if (!format) throw new AuditInputError("Formato de exportação inválido.");
      const filters = auditFilterSnapshot(body.filters || {}), estimatedRows = Math.min(5_000, Math.max(0, Number(body.estimatedRows) || 0));
      const exported = await db.auditExportEvent.create({ data: { format, filters, estimatedRows, requestedBy: access.user.id, requestedName: access.user.name } });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "audit.export.requested", entityType: "audit_export", entityId: String(exported.id), correlationId, afterData: { format, filters, estimatedRows } } });
      return Response.json({ exportId: exported.id, correlationId }, { status: 201, headers: NO_STORE });
    }
    throw new AuditInputError("Ação de auditoria não reconhecida.");
  } catch (error) { return failure(error, "atualizar a governança da auditoria"); }
}

function tenantAuditWhere(query: ReturnType<typeof parseAuditQuery>, actorMatches: string[]): Prisma.TenantAuditEventWhereInput {
  const search = query.search ? { OR: [
    { action: { contains: query.search, mode: "insensitive" as const } }, { entityType: { contains: query.search, mode: "insensitive" as const } },
    { entityId: { contains: query.search, mode: "insensitive" as const } }, { correlationId: { contains: query.search, mode: "insensitive" as const } },
    ...(actorMatches.length ? [{ actorId: { in: actorMatches } }] : []),
  ] } : {};
  return { ...search, ...(query.actorId ? { actorId: query.actorId } : {}), ...(query.action ? { action: query.action } : {}), ...(query.entityType ? { entityType: query.entityType } : {}), ...(query.correlationId ? { correlationId: { contains: query.correlationId, mode: "insensitive" } } : {}), ...(query.severity ? { severity: query.severity } : {}), ...(query.category ? { category: query.category } : {}), ...(query.source ? { source: query.source } : {}), ...(query.onlyChanges ? { beforeData: { not: Prisma.DbNull } } : {}), ...dateWhere(query.from, query.to) };
}
function integrationAuditWhere(query: ReturnType<typeof parseAuditQuery>, actorMatches: string[]): Prisma.IntegrationAuditLogWhereInput {
  const exactAction = query.action.startsWith("integration.") ? query.action.slice(12) : query.action;
  const search = query.search ? { OR: [
    { action: { contains: query.search.replace(/^integration\./, ""), mode: "insensitive" as const } }, { targetType: { contains: query.search, mode: "insensitive" as const } },
    { targetId: { contains: query.search, mode: "insensitive" as const } }, { correlationId: { contains: query.search, mode: "insensitive" as const } },
    ...(actorMatches.length ? [{ userId: { in: actorMatches } }] : []),
  ] } : {};
  return { ...search, ...(query.actorId ? { userId: query.actorId } : {}), ...(exactAction ? { action: exactAction } : {}), ...(query.entityType ? { targetType: query.entityType } : {}), ...(query.correlationId ? { correlationId: { contains: query.correlationId, mode: "insensitive" } } : {}), ...(query.severity ? { severity: query.severity } : {}), ...(query.category ? { category: query.category } : {}), ...(query.onlyChanges ? { beforeData: { not: Prisma.DbNull } } : {}), ...dateWhere(query.from, query.to) };
}
function dateWhere(from: Date | null, to: Date | null) { return from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}; }

async function summaryData(db: Db, tenantWhere: Prisma.TenantAuditEventWhereInput, integrationWhere: Prisma.IntegrationAuditLogWhereInput, tenantEnabled: boolean, integrationEnabled: boolean, startToday: Date) {
  const tenant = (extra: Prisma.TenantAuditEventWhereInput) => tenantEnabled ? db.tenantAuditEvent.count({ where: { AND: [tenantWhere, extra] } }) : Promise.resolve(0);
  const integration = (extra: Prisma.IntegrationAuditLogWhereInput) => integrationEnabled ? db.integrationAuditLog.count({ where: { AND: [integrationWhere, extra] } }) : Promise.resolve(0);
  const [todayT, todayI, criticalT, criticalI, warningT, warningI, correlationT, correlationI, changesT, changesI, actorT, actorI] = await Promise.all([
    tenant({ createdAt: { gte: startToday } }), integration({ createdAt: { gte: startToday } }), tenant({ severity: "critical" }), integration({ severity: "critical" }),
    tenant({ severity: "warning" }), integration({ severity: "warning" }), tenant({ correlationId: { not: null } }), integration({ correlationId: { not: null } }),
    tenant({ beforeData: { not: Prisma.DbNull } }), integration({ beforeData: { not: Prisma.DbNull } }),
    tenantEnabled ? db.tenantAuditEvent.groupBy({ by: ["actorId"], where: tenantWhere }) : Promise.resolve([]), integrationEnabled ? db.integrationAuditLog.groupBy({ by: ["userId"], where: integrationWhere }) : Promise.resolve([]),
  ]);
  return { today: todayT + todayI, critical: criticalT + criticalI, warning: warningT + warningI, correlated: correlationT + correlationI, changes: changesT + changesI, actors: new Set([...actorT.map((item) => item.actorId), ...actorI.map((item) => item.userId)].filter(Boolean)).size };
}

async function facetData(db: Db) {
  const [tenantEntity, integrationEntity, tenantAction, integrationAction, tenantActors, integrationActors] = await Promise.all([
    db.tenantAuditEvent.groupBy({ by: ["entityType"], _count: { _all: true } }), db.integrationAuditLog.groupBy({ by: ["targetType"], _count: { _all: true } }),
    db.tenantAuditEvent.groupBy({ by: ["action"], _count: { _all: true } }), db.integrationAuditLog.groupBy({ by: ["action"], _count: { _all: true } }),
    db.tenantAuditEvent.groupBy({ by: ["actorId"], _count: { _all: true } }), db.integrationAuditLog.groupBy({ by: ["userId"], _count: { _all: true } }),
  ]);
  return {
    entityTypes: mergeCounts([...tenantEntity.map((item) => [item.entityType, item._count._all] as const), ...integrationEntity.map((item) => [item.targetType, item._count._all] as const)]),
    actions: mergeCounts([...tenantAction.map((item) => [item.action, item._count._all] as const), ...integrationAction.map((item) => [`integration.${item.action}`, item._count._all] as const)]).slice(0, 150),
    actors: mergeCounts([...tenantActors.flatMap((item) => item.actorId ? [[item.actorId, item._count._all] as const] : []), ...integrationActors.map((item) => [item.userId, item._count._all] as const)]),
  };
}
function mergeCounts(items: ReadonlyArray<readonly [string, number]>) { const values = new Map<string, number>(); for (const [key, count] of items) values.set(key, (values.get(key) || 0) + count); return [...values].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "pt-BR")); }

async function trendData(db: Db, from: Date) {
  const rows = await db.$queryRaw<Array<{ day: Date; severity: string; count: bigint }>>(Prisma.sql`
    SELECT date_trunc('day', "created_at") AS "day", "severity", count(*)::bigint AS "count" FROM "audit_events" WHERE "created_at" >= ${from} GROUP BY 1, 2
    UNION ALL
    SELECT date_trunc('day', "created_at") AS "day", "severity", count(*)::bigint AS "count" FROM "integration_audit_log" WHERE "created_at" >= ${from} GROUP BY 1, 2
    ORDER BY 1 ASC`);
  const days = new Map<string, { date: string; info: number; warning: number; critical: number; total: number }>();
  for (let cursor = new Date(from); cursor <= new Date(); cursor = new Date(cursor.valueOf() + 86_400_000)) { const date = cursor.toISOString().slice(0, 10); days.set(date, { date, info: 0, warning: 0, critical: 0, total: 0 }); }
  for (const row of rows) { const item = days.get(row.day.toISOString().slice(0, 10)); if (!item) continue; const count = Number(row.count); if (row.severity === "critical") item.critical += count; else if (row.severity === "warning") item.warning += count; else item.info += count; item.total += count; }
  return [...days.values()];
}

async function integrityData(db: Db) {
  const [result] = await db.$queryRaw<Array<{ total: bigint; valid: bigint }>>(Prisma.sql`
    SELECT COALESCE(sum("total"),0)::bigint AS "total", COALESCE(sum("valid"),0)::bigint AS "valid" FROM (
      SELECT count(*)::bigint AS "total", count(*) FILTER (WHERE "fingerprint" = "nalven_audit_fingerprint"('erp:' || "id"::text,"actor_id","action","entity_type","entity_id","correlation_id","before_data","after_data","severity","category","source","schema_version","created_at"))::bigint AS "valid" FROM "audit_events"
      UNION ALL
      SELECT count(*)::bigint, count(*) FILTER (WHERE "fingerprint" = "nalven_audit_fingerprint"('integration:' || "id","user_id",'integration.' || "action","target_type","target_id","correlation_id","before_data","after_data","severity","category","source","schema_version","created_at"))::bigint FROM "integration_audit_log"
    ) "integrity"`);
  const total = Number(result?.total || 0), valid = Number(result?.valid || 0); return { total, valid, invalid: total - valid, coverage: total ? Math.round(valid * 10_000 / total) / 100 : 100 };
}

function mapTenant<T extends { id: bigint; actorId: string | null; action: string; entityType: string; entityId: string | null; correlationId: string | null; beforeData: unknown; afterData: unknown; severity: string; category: string; source: string; fingerprint: string | null; schemaVersion: number; createdAt: Date }>(item: T, actors: Map<string, Actor>) {
  const beforeData = redactAuditPayload(item.beforeData), afterData = redactAuditPayload(item.afterData), changes = auditChanges(item.beforeData, item.afterData);
  return { ...item, id: `erp:${item.id}`, beforeData, afterData, createdAt: item.createdAt, actor: actor(item.actorId, actors), changes, changedFields: changes.map((change) => change.key), integrity: item.fingerprint ? "fingerprinted" : "legacy" };
}
function mapIntegration<T extends { id: string; userId: string; action: string; targetType: string; targetId: string; correlationId: string | null; beforeData: unknown; afterData: unknown; severity: string; category: string; source: string; fingerprint: string | null; schemaVersion: number; createdAt: Date }>(item: T, actors: Map<string, Actor>) {
  const beforeData = redactAuditPayload(item.beforeData), afterData = redactAuditPayload(item.afterData), changes = auditChanges(item.beforeData, item.afterData);
  return { id: `integration:${item.id}`, actorId: item.userId, action: `integration.${item.action}`, entityType: item.targetType, entityId: item.targetId, correlationId: item.correlationId, beforeData, afterData, severity: item.severity, category: item.category, source: item.source, fingerprint: item.fingerprint, schemaVersion: item.schemaVersion, createdAt: item.createdAt, actor: actor(item.userId, actors), changes, changedFields: changes.map((change) => change.key), integrity: item.fingerprint ? "fingerprinted" : "legacy" };
}
function actor(id: string | null, actors: Map<string, Actor>) { return id ? actors.get(id) || { name: "Usuário removido", email: "—" } : { name: "Sistema", email: "—" }; }

async function detailResponse(db: Db, rawKey: string, actors: Map<string, Actor>) {
  const parsed = eventKey(rawKey); let selected: ReturnType<typeof mapTenant> | ReturnType<typeof mapIntegration>;
  if (parsed.source === "erp") { let id: bigint; try { id = BigInt(parsed.id); } catch { throw new AuditInputError("Evento inválido."); } const row = await db.tenantAuditEvent.findUnique({ where: { id } }); if (!row) throw new AuditNotFoundError(); selected = mapTenant(row, actors); }
  else { const row = await db.integrationAuditLog.findUnique({ where: { id: parsed.id } }); if (!row) throw new AuditNotFoundError(); selected = mapIntegration(row, actors); }
  const correlation = selected.correlationId ? await Promise.all([
    db.tenantAuditEvent.findMany({ where: { correlationId: selected.correlationId }, orderBy: { createdAt: "asc" }, take: 100 }),
    db.integrationAuditLog.findMany({ where: { correlationId: selected.correlationId }, orderBy: { createdAt: "asc" }, take: 100 }),
  ]) : [[], []] as const;
  const related = [...correlation[0].map((item) => mapTenant(item, actors)), ...correlation[1].map((item) => mapIntegration(item, actors))].sort((a, b) => a.createdAt.valueOf() - b.createdAt.valueOf());
  const investigations = await db.auditInvestigation.findMany({ where: { events: { some: { eventKey: parsed.key } } }, select: { id: true, title: true, status: true, severity: true }, orderBy: { updatedAt: "desc" } });
  return Response.json({ event: selected, related, investigations }, { headers: NO_STORE });
}

async function validEventFingerprints(db: Db, keys: string[]) {
  const erpIds: bigint[] = [], integrationIds: string[] = [];
  for (const key of keys) { const parsed = eventKey(key); if (parsed.source === "erp") { try { erpIds.push(BigInt(parsed.id)); } catch { throw new AuditInputError("Evento inválido."); } } else integrationIds.push(parsed.id); }
  const [erp, integration] = await Promise.all([erpIds.length ? db.tenantAuditEvent.findMany({ where: { id: { in: erpIds } }, select: { id: true, fingerprint: true } }) : [], integrationIds.length ? db.integrationAuditLog.findMany({ where: { id: { in: integrationIds } }, select: { id: true, fingerprint: true } }) : []]);
  const result = new Map<string, string | null>([...erp.map((item) => [`erp:${item.id}`, item.fingerprint] as const), ...integration.map((item) => [`integration:${item.id}`, item.fingerprint] as const)]);
  if (result.size !== keys.length) throw new AuditInputError("Um dos eventos selecionados não existe mais."); return result;
}
async function assertAssignee(organizationId: string, userId: string | null) { if (!userId) return; if (!await controlDb.membership.findFirst({ where: { organizationId, userId, status: "active" }, select: { id: true } })) throw new AuditInputError("Responsável não pertence à organização ou está inativo."); }
function positiveId(value: unknown, message: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new AuditInputError(message); return id; }
function download(content: string, extension: string, contentType: string) { return new Response(content, { headers: { ...NO_STORE, "content-type": contentType, "content-disposition": `attachment; filename="auditoria-nalven-${new Date().toISOString().slice(0, 10)}.${extension}"`, "x-content-type-options": "nosniff" } }); }
class AuditConflictError extends Error {}
class AuditNotFoundError extends Error {}
function failure(error: unknown, operation: string) { if (error instanceof AuditInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE }); if (error instanceof AuditConflictError) return Response.json({ error: "A investigação foi alterada por outra pessoa. Recarregue antes de continuar." }, { status: 409, headers: NO_STORE }); if (error instanceof AuditNotFoundError) return Response.json({ error: "Evento de auditoria não encontrado." }, { status: 404, headers: NO_STORE }); if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "central de auditoria") }, { status: error.status, headers: NO_STORE }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE }); if (error instanceof AuthError) return authErrorResponse(error); console.error(`audit center failed to ${operation}`, error instanceof Error ? error.name : "unknown"); return Response.json({ error: `Não foi possível ${operation}.` }, { status: 500, headers: NO_STORE }); }
