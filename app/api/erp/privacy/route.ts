import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { controlDb, currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import {
  addBusinessDays, allowedIncidentTransition, allowedRequestTransition, impactAssessmentInput,
  incidentCreateInput, incidentTransitionInput, legalBasisInput, maskContact, maskDocument,
  parsePrivacyQuery, privacyCsv, PrivacyGovernanceError, privacyNoteInput, privacyRequestCreateInput,
  privacyRequestTransitionInput, privacySettingsInput, protectPrivacySubject, retentionRuleInput, treatmentInput,
} from "@/lib/erp/privacy-governance";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
type Db = Awaited<ReturnType<typeof tenantDb>>;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "privacy.read"), db = await tenantDb(organization.id), params = new URL(request.url).searchParams, query = parsePrivacyQuery(params), where = requestWhere(query);
    if (query.format === "csv") {
      const exportId = positiveId(params.get("exportId"), "Registre a exportação antes de baixar o arquivo."), minimumCreatedAt = new Date(Date.now() - 5 * 60_000);
      if (!await db.auditExportEvent.findFirst({ where: { id: exportId, requestedBy: access.user.id, format: "privacy_csv", createdAt: { gte: minimumCreatedAt } }, select: { id: true } })) throw new PrivacyGovernanceError("A autorização da exportação expirou ou não pertence ao usuário atual.");
      const rows = await db.privacyRequest.findMany({ where, orderBy: [{ createdAt: query.sort === "newest" ? "desc" : "asc" }, { id: query.sort === "newest" ? "desc" : "asc" }], take: 5_000 });
      return new Response(privacyCsv(rows.map(publicRequest)), { headers: { ...NO_STORE, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="solicitacoes-lgpd-${new Date().toISOString().slice(0, 10)}.csv"`, "x-content-type-options": "nosniff" } });
    }
    const memberships = await controlDb.membership.findMany({ where: { organizationId: organization.id, status: "active" }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } });
    const [requests, total, allRequests, bases, retention, incidents, treatments, assessments, settings, consentGroups] = await Promise.all([
      db.privacyRequest.findMany({ where, include: { events: { orderBy: { createdAt: "desc" }, take: 50 } }, orderBy: [{ createdAt: query.sort === "newest" ? "desc" : "asc" }, { id: query.sort === "newest" ? "desc" : "asc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      db.privacyRequest.count({ where }),
      db.privacyRequest.findMany({ select: { status: true, priority: true, dueAt: true, createdAt: true, completedAt: true } }),
      db.legalBasis.findMany({ orderBy: [{ active: "desc" }, { dataCategory: "asc" }] }),
      db.retentionRule.findMany({ orderBy: [{ active: "desc" }, { dataCategory: "asc" }] }),
      db.privacyIncident.findMany({ include: { events: { orderBy: { createdAt: "desc" }, take: 50 } }, orderBy: [{ status: "asc" }, { reportedAt: "desc" }], take: 200 }),
      db.privacyTreatmentActivity.findMany({ include: { _count: { select: { assessments: true } } }, orderBy: [{ status: "asc" }, { riskLevel: "desc" }, { updatedAt: "desc" }], take: 300 }),
      db.privacyImpactAssessment.findMany({ include: { treatment: { select: { id: true, name: true, department: true } } }, orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: 200 }),
      db.tenantSettings.findUnique({ where: { id: 1 }, select: { dataProtectionOfficerName: true, dataProtectionEmail: true, dataProtectionPhone: true, privacySmallAgent: true, privacyDefaultRequestDays: true, privacyProgramReviewAt: true, timezone: true } }),
      db.customerConsent.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const now = new Date(), openRequests = allRequests.filter((item) => !["completed", "rejected"].includes(item.status)), completed30 = allRequests.filter((item) => item.completedAt && item.completedAt >= new Date(now.valueOf() - 30 * 86_400_000)), openIncidents = incidents.filter((item) => item.status !== "resolved"), activeTreatments = treatments.filter((item) => item.status === "active"), assessmentsCurrent = new Set(assessments.filter((item) => ["in_review", "approved"].includes(item.status)).map((item) => item.treatmentId).filter(Boolean)), highRiskTreatments = activeTreatments.filter((item) => ["high", "critical"].includes(item.riskLevel) || item.sensitiveData || item.childrenData);
    const readiness = readinessData({ settings, bases, retention, treatments: activeTreatments, assessmentsCurrent, highRiskTreatments, openRequests, incidents: openIncidents, now });
    return Response.json({
      requests: requests.map(publicRequest), pagination: { page: query.page, limit: query.limit, total, pages: Math.max(1, Math.ceil(total / query.limit)) },
      bases, retention, incidents, treatments, assessments,
      actors: memberships.map((item) => ({ id: item.user.id, name: item.user.name, email: item.user.email })),
      settings: settings || { dataProtectionOfficerName: null, dataProtectionEmail: null, dataProtectionPhone: null, privacySmallAgent: false, privacyDefaultRequestDays: 15, privacyProgramReviewAt: null, timezone: "America/Sao_Paulo" },
      summary: {
        openRequests: openRequests.length, overdueRequests: openRequests.filter((item) => item.dueAt < now).length, dueSoon: openRequests.filter((item) => item.dueAt >= now && item.dueAt <= new Date(now.valueOf() + 3 * 86_400_000)).length, urgentRequests: openRequests.filter((item) => item.priority === "urgent").length,
        completed30: completed30.length, averageResolutionDays: averageDays(completed30), openIncidents: openIncidents.length, notificationAtRisk: openIncidents.filter((item) => item.riskRelevant && item.notificationDueAt && item.notificationDueAt <= new Date(now.valueOf() + 86_400_000) && (!item.anpdNotifiedAt || !item.subjectsNotifiedAt)).length,
        mappedTreatments: activeTreatments.length, highRiskTreatments: highRiskTreatments.length, assessmentsPending: assessments.filter((item) => item.status === "draft" || item.status === "in_review").length,
        consentRecords: Object.fromEntries(consentGroups.map((item) => [item.status, item._count._all])), readiness,
      },
      trend: trendData(allRequests, incidents, now), capabilities: { canWrite: matches(access.permissions, "privacy.write"), canExport: true }, generatedAt: now.toISOString(),
    }, { headers: NO_STORE });
  } catch (error) { return failure(error, "consultar a central de privacidade"); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization(), db = await tenantDb(organization.id), body = await readPosJson(request, 262_144), action = String(body.action || ""), correlationId = randomUUID(), readAccess = await assertTenantPermission(organization.id, "privacy.read"), access = action === "export.record" ? readAccess : await assertTenantPermission(organization.id, "privacy.write");
    if (action !== "export.record") await assertTenantWriteAccess(organization.id);
    await enforcePosRateLimit(db, access.user.id, action === "export.record" ? "privacy.export" : "privacy.write");

    if (action === "request.create") {
      const input = privacyRequestCreateInput(body), protectedSubject = protectPrivacySubject(input.document, input.contact), settings = await db.tenantSettings.findUnique({ where: { id: 1 }, select: { privacyDefaultRequestDays: true } }), dueAt = new Date(); dueAt.setUTCDate(dueAt.getUTCDate() + (settings?.privacyDefaultRequestDays || 15));
      const item = await db.$transaction(async (tx) => {
        const created = await tx.privacyRequest.create({ data: { number: `LGPD-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, type: input.type, subjectName: input.subjectName, ...protectedSubject, channel: input.channel, priority: input.priority, requesterRelation: input.requesterRelation, status: "received", dueAt, assignedTo: input.assignedTo || access.user.name, createdBy: access.user.name } });
        await tx.privacyRequestEvent.create({ data: { requestId: created.id, kind: "created", toStatus: "received", note: input.note, actorId: access.user.id, actorName: access.user.name } });
        await audit(tx, access.user.id, "privacy.request.created", "privacy_request", created.id, correlationId, null, { number: created.number, type: created.type, priority: created.priority, dueAt: created.dueAt, documentToken: created.subjectDocumentHash });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ request: publicRequest(item), correlationId }, { status: 201, headers: NO_STORE });
    }

    if (action === "request.transition") {
      const input = privacyRequestTransitionInput(body);
      const item = await db.$transaction(async (tx) => {
        const before = await tx.privacyRequest.findUnique({ where: { id: input.id } }); if (!before) throw new PrivacyGovernanceError("Solicitação não encontrada.", 404);
        if (input.status !== before.status && !allowedRequestTransition(before.status, input.status)) throw new PrivacyGovernanceError("Essa transição não é permitida para a etapa atual.", 409);
        const final = input.status === "completed" || input.status === "rejected", changed = await tx.privacyRequest.updateMany({ where: { id: input.id, version: input.expectedVersion }, data: { status: input.status, assignedTo: input.assignedTo || before.assignedTo, identityMethod: input.identityMethod || before.identityMethod, verifiedAt: input.status === "verified" && !before.verifiedAt ? new Date() : before.verifiedAt, completedAt: final ? new Date() : null, evidence: input.evidence || before.evidence, responseSummary: input.responseSummary || before.responseSummary, rejectionReason: input.status === "rejected" ? input.rejectionReason : null, version: { increment: 1 } } });
        if (changed.count !== 1) throw new PrivacyGovernanceError("A solicitação foi alterada por outra pessoa. Recarregue antes de continuar.", 409);
        await tx.privacyRequestEvent.create({ data: { requestId: input.id, kind: "status_changed", fromStatus: before.status, toStatus: input.status, note: input.note, actorId: access.user.id, actorName: access.user.name } });
        const updated = await tx.privacyRequest.findUniqueOrThrow({ where: { id: input.id }, include: { events: { orderBy: { createdAt: "desc" } } } });
        await audit(tx, access.user.id, `privacy.request.${updated.status}`, "privacy_request", updated.id, correlationId, { status: before.status, version: before.version }, { status: updated.status, version: updated.version, evidenceRecorded: Boolean(updated.evidence) });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ request: publicRequest(item), correlationId }, { headers: NO_STORE });
    }

    if (action === "request.note") {
      const input = privacyNoteInput(body), item = await db.$transaction(async (tx) => {
        const current = await tx.privacyRequest.findUnique({ where: { id: input.id } }); if (!current) throw new PrivacyGovernanceError("Solicitação não encontrada.", 404);
        await tx.privacyRequestEvent.create({ data: { requestId: input.id, kind: "note", toStatus: current.status, note: input.note, actorId: access.user.id, actorName: access.user.name } });
        const updated = await tx.privacyRequest.update({ where: { id: input.id }, data: { version: { increment: 1 } }, include: { events: { orderBy: { createdAt: "desc" } } } });
        await audit(tx, access.user.id, "privacy.request.note_added", "privacy_request", input.id, correlationId, null, { length: input.note.length }); return updated;
      });
      return Response.json({ request: publicRequest(item), correlationId }, { headers: NO_STORE });
    }

    if (action === "basis.save") {
      const input = legalBasisInput(body), basis = await db.$transaction(async (tx) => {
        if (!input.id) {
          const created = await tx.legalBasis.create({ data: { name: input.name, basis: input.basis, purpose: input.purpose, dataCategory: input.dataCategory, description: input.description, dataSubjects: json(input.dataSubjects), sourceSystems: json(input.sourceSystems), recipients: json(input.recipients), internationalTransfer: input.internationalTransfer, safeguards: input.safeguards, owner: input.owner, reviewAt: input.reviewAt, active: input.active, updatedBy: access.user.name } });
          await audit(tx, access.user.id, "privacy.legal_basis.created", "legal_basis", created.id, correlationId, null, { basis: created.basis, dataCategory: created.dataCategory }); return created;
        }
        const before = await tx.legalBasis.findUnique({ where: { id: input.id } }); if (!before) throw new PrivacyGovernanceError("Base legal não encontrada.", 404);
        const changed = await tx.legalBasis.updateMany({ where: { id: input.id, version: input.expectedVersion || -1 }, data: { name: input.name, basis: input.basis, purpose: input.purpose, dataCategory: input.dataCategory, description: input.description, dataSubjects: json(input.dataSubjects), sourceSystems: json(input.sourceSystems), recipients: json(input.recipients), internationalTransfer: input.internationalTransfer, safeguards: input.safeguards, owner: input.owner, reviewAt: input.reviewAt, active: input.active, updatedBy: access.user.name, version: { increment: 1 } } });
        if (!changed.count) throw new PrivacyGovernanceError("A base legal foi alterada por outra pessoa.", 409); const updated = await tx.legalBasis.findUniqueOrThrow({ where: { id: input.id } }); await audit(tx, access.user.id, "privacy.legal_basis.updated", "legal_basis", updated.id, correlationId, { basis: before.basis, active: before.active, version: before.version }, { basis: updated.basis, active: updated.active, version: updated.version }); return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ basis, correlationId }, { status: input.id ? 200 : 201, headers: NO_STORE });
    }

    if (action === "retention.save") {
      const input = retentionRuleInput(body), rule = await db.$transaction(async (tx) => {
        if (!input.id) {
          if (await tx.retentionRule.findUnique({ where: { dataCategory: input.dataCategory }, select: { id: true } })) throw new PrivacyGovernanceError("Já existe uma regra para essa categoria.", 409);
          const created = await tx.retentionRule.create({ data: { dataCategory: input.dataCategory, retentionDays: input.retentionDays, legalReason: input.legalReason, action: input.action, appliesTo: input.appliesTo, owner: input.owner, reviewAt: input.reviewAt, active: input.active, updatedBy: access.user.name } }); await audit(tx, access.user.id, "privacy.retention.created", "retention_rule", created.id, correlationId, null, { dataCategory: created.dataCategory, retentionDays: created.retentionDays, action: created.action }); return created;
        }
        const before = await tx.retentionRule.findUnique({ where: { id: input.id } }); if (!before) throw new PrivacyGovernanceError("Regra de retenção não encontrada.", 404);
        const changed = await tx.retentionRule.updateMany({ where: { id: input.id, version: input.expectedVersion || -1 }, data: { dataCategory: input.dataCategory, retentionDays: input.retentionDays, legalReason: input.legalReason, action: input.action, appliesTo: input.appliesTo, owner: input.owner, reviewAt: input.reviewAt, active: input.active, updatedBy: access.user.name, version: { increment: 1 } } }); if (!changed.count) throw new PrivacyGovernanceError("A regra de retenção foi alterada por outra pessoa.", 409);
        const updated = await tx.retentionRule.findUniqueOrThrow({ where: { id: input.id } }); await audit(tx, access.user.id, "privacy.retention.updated", "retention_rule", updated.id, correlationId, { retentionDays: before.retentionDays, action: before.action, version: before.version }, { retentionDays: updated.retentionDays, action: updated.action, version: updated.version }); return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ rule, correlationId }, { status: input.id ? 200 : 201, headers: NO_STORE });
    }

    if (action === "treatment.save") {
      const input = treatmentInput(body), treatment = await db.$transaction(async (tx) => {
        if (!input.id) {
          const created = await tx.privacyTreatmentActivity.create({ data: { ...treatmentData(input, access.user.name), createdBy: access.user.name } }); await audit(tx, access.user.id, "privacy.treatment.created", "privacy_treatment", created.id, correlationId, null, { name: created.name, riskLevel: created.riskLevel, legalBasis: created.legalBasis }); return created;
        }
        const before = await tx.privacyTreatmentActivity.findUnique({ where: { id: input.id } }); if (!before) throw new PrivacyGovernanceError("Tratamento não encontrado.", 404);
        const changed = await tx.privacyTreatmentActivity.updateMany({ where: { id: input.id, version: input.expectedVersion || -1 }, data: { ...treatmentData(input, access.user.name), version: { increment: 1 } } }); if (!changed.count) throw new PrivacyGovernanceError("O inventário foi alterado por outra pessoa.", 409);
        const updated = await tx.privacyTreatmentActivity.findUniqueOrThrow({ where: { id: input.id } }); await audit(tx, access.user.id, "privacy.treatment.updated", "privacy_treatment", updated.id, correlationId, { status: before.status, riskLevel: before.riskLevel, version: before.version }, { status: updated.status, riskLevel: updated.riskLevel, version: updated.version }); return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ treatment, correlationId }, { status: input.id ? 200 : 201, headers: NO_STORE });
    }

    if (action === "assessment.save") {
      const input = impactAssessmentInput(body), assessment = await db.$transaction(async (tx) => {
        if (input.treatmentId && !await tx.privacyTreatmentActivity.findUnique({ where: { id: input.treatmentId }, select: { id: true } })) throw new PrivacyGovernanceError("Tratamento relacionado não encontrado.", 404);
        const data = assessmentData(input, access.user.name);
        if (!input.id) { const created = await tx.privacyImpactAssessment.create({ data: { ...data, createdBy: access.user.name } }); await audit(tx, access.user.id, "privacy.ripd.created", "privacy_impact_assessment", created.id, correlationId, null, { title: created.title, status: created.status, residualRisk: created.residualRisk }); return created; }
        const before = await tx.privacyImpactAssessment.findUnique({ where: { id: input.id } }); if (!before) throw new PrivacyGovernanceError("RIPD não encontrado.", 404);
        const changed = await tx.privacyImpactAssessment.updateMany({ where: { id: input.id, version: input.expectedVersion || -1 }, data: { ...data, version: { increment: 1 } } }); if (!changed.count) throw new PrivacyGovernanceError("O RIPD foi alterado por outra pessoa.", 409);
        const updated = await tx.privacyImpactAssessment.findUniqueOrThrow({ where: { id: input.id } }); await audit(tx, access.user.id, "privacy.ripd.updated", "privacy_impact_assessment", updated.id, correlationId, { status: before.status, residualRisk: before.residualRisk, version: before.version }, { status: updated.status, residualRisk: updated.residualRisk, version: updated.version }); return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ assessment, correlationId }, { status: input.id ? 200 : 201, headers: NO_STORE });
    }

    if (action === "incident.create") {
      const input = incidentCreateInput(body), notificationDueAt = input.riskRelevant ? addBusinessDays(input.detectedAt, 3) : null, incident = await db.$transaction(async (tx) => {
        const created = await tx.privacyIncident.create({ data: { title: input.title, severity: input.severity, description: input.description, status: "open", affectedSubjects: input.affectedSubjects, riskRelevant: input.riskRelevant, dataCategories: json(input.dataCategories), detectedAt: input.detectedAt, notificationDueAt, decisionReason: input.decisionReason, assignedTo: input.assignedTo || access.user.name, createdBy: access.user.name } });
        await tx.privacyIncidentEvent.create({ data: { incidentId: created.id, kind: "created", toStatus: "open", note: input.decisionReason, actorId: access.user.id, actorName: access.user.name } }); await audit(tx, access.user.id, "privacy.incident.created", "privacy_incident", created.id, correlationId, null, { severity: created.severity, riskRelevant: created.riskRelevant, affectedSubjects: created.affectedSubjects, notificationDueAt }); return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ incident, correlationId }, { status: 201, headers: NO_STORE });
    }

    if (action === "incident.transition") {
      const input = incidentTransitionInput(body), incident = await db.$transaction(async (tx) => {
        const before = await tx.privacyIncident.findUnique({ where: { id: input.id } }); if (!before) throw new PrivacyGovernanceError("Incidente não encontrado.", 404);
        if (input.status !== before.status && !allowedIncidentTransition(before.status, input.status)) throw new PrivacyGovernanceError("Essa transição não é permitida para o incidente.", 409);
        const anpdNotifiedAt = input.markAnpdNotified ? before.anpdNotifiedAt || new Date() : before.anpdNotifiedAt, subjectsNotifiedAt = input.markSubjectsNotified ? before.subjectsNotifiedAt || new Date() : before.subjectsNotifiedAt;
        if (input.status === "resolved" && input.riskRelevant && (!anpdNotifiedAt || !subjectsNotifiedAt)) throw new PrivacyGovernanceError("Incidente relevante exige o registro das comunicações à ANPD e aos titulares antes da resolução.");
        const notificationDueAt = input.riskRelevant ? before.notificationDueAt || addBusinessDays(before.detectedAt, 3) : null, changed = await tx.privacyIncident.updateMany({ where: { id: input.id, version: input.expectedVersion }, data: { status: input.status, riskRelevant: input.riskRelevant, notificationDueAt, containedAt: ["contained", "notifying", "resolved"].includes(input.status) ? before.containedAt || new Date() : before.containedAt, anpdNotifiedAt, subjectsNotifiedAt, rootCause: input.rootCause || before.rootCause, containmentMeasures: input.containmentMeasures || before.containmentMeasures, correctiveActions: input.correctiveActions || before.correctiveActions, decisionReason: input.decisionReason, assignedTo: input.assignedTo || before.assignedTo, resolvedAt: input.status === "resolved" ? new Date() : null, version: { increment: 1 } } });
        if (!changed.count) throw new PrivacyGovernanceError("O incidente foi alterado por outra pessoa. Recarregue antes de continuar.", 409);
        await tx.privacyIncidentEvent.create({ data: { incidentId: input.id, kind: input.status === before.status ? "response_updated" : "status_changed", fromStatus: before.status, toStatus: input.status, note: input.note, actorId: access.user.id, actorName: access.user.name } }); const updated = await tx.privacyIncident.findUniqueOrThrow({ where: { id: input.id }, include: { events: { orderBy: { createdAt: "desc" } } } }); await audit(tx, access.user.id, `privacy.incident.${updated.status}`, "privacy_incident", updated.id, correlationId, { status: before.status, riskRelevant: before.riskRelevant, version: before.version }, { status: updated.status, riskRelevant: updated.riskRelevant, anpdNotified: Boolean(updated.anpdNotifiedAt), subjectsNotified: Boolean(updated.subjectsNotifiedAt), version: updated.version }); return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ incident, correlationId }, { headers: NO_STORE });
    }

    if (action === "settings.save") {
      const input = privacySettingsInput(body), settings = await db.tenantSettings.upsert({ where: { id: 1 }, update: { ...input, updatedBy: access.user.name, version: { increment: 1 } }, create: { id: 1, organizationName: organization.name, ...input, updatedBy: access.user.name } }); await audit(db, access.user.id, "privacy.settings.updated", "tenant_settings", settings.id, correlationId, null, { dpoConfigured: Boolean(settings.dataProtectionOfficerName && settings.dataProtectionEmail), privacySmallAgent: settings.privacySmallAgent, defaultRequestDays: settings.privacyDefaultRequestDays }); return Response.json({ settings, correlationId }, { headers: NO_STORE });
    }

    if (action === "export.record") {
      const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters) ? body.filters as Record<string, unknown> : {}, parsed = parsePrivacyQuery(new URLSearchParams(Object.entries(filters).filter((entry) => typeof entry[1] === "string").map(([key, value]) => [key, String(value)]))), estimatedRows = Math.min(5_000, Math.max(0, Number(body.estimatedRows) || 0));
      const exported = await db.auditExportEvent.create({ data: { format: "privacy_csv", filters: json({ search: parsed.search, status: parsed.status, type: parsed.type, priority: parsed.priority, sort: parsed.sort }), estimatedRows, requestedBy: access.user.id, requestedName: access.user.name } }); await audit(db, access.user.id, "privacy.export.requested", "privacy_export", exported.id, correlationId, null, { format: "csv", estimatedRows }); return Response.json({ exportId: exported.id, correlationId }, { status: 201, headers: NO_STORE });
    }
    throw new PrivacyGovernanceError("Ação de privacidade não reconhecida.");
  } catch (error) { return failure(error, "atualizar a governança de privacidade"); }
}

function requestWhere(query: ReturnType<typeof parsePrivacyQuery>): Prisma.PrivacyRequestWhereInput {
  return { ...(query.search ? { OR: [{ number: { contains: query.search, mode: "insensitive" } }, { subjectName: { contains: query.search, mode: "insensitive" } }, { assignedTo: { contains: query.search, mode: "insensitive" } }] } : {}), ...(query.status ? { status: query.status } : {}), ...(query.type ? { type: query.type } : {}), ...(query.priority ? { priority: query.priority } : {}) };
}

function publicRequest<T extends { id: number; number: string; type: string; subjectName: string; subjectDocumentLast4: string | null; contactPreview: string | null; contact: string; status: string; priority: string; channel: string; requesterRelation: string; identityMethod: string | null; dueAt: Date; verifiedAt: Date | null; completedAt: Date | null; evidence: string | null; responseSummary: string | null; rejectionReason: string | null; assignedTo: string | null; createdBy: string; version: number; createdAt: Date; updatedAt: Date; events?: unknown }>(item: T) {
  return { id: item.id, number: item.number, type: item.type, subjectName: item.subjectName, subjectDocument: maskDocument(item.subjectDocumentLast4), contact: item.contactPreview || (item.contact.startsWith("v1.") ? "Contato protegido" : maskContact(item.contact)), status: item.status, priority: item.priority, channel: item.channel, requesterRelation: item.requesterRelation, identityMethod: item.identityMethod, dueAt: item.dueAt, verifiedAt: item.verifiedAt, completedAt: item.completedAt, evidence: item.evidence, responseSummary: item.responseSummary, rejectionReason: item.rejectionReason, assignedTo: item.assignedTo, createdBy: item.createdBy, version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.events ? { events: item.events } : {}) };
}

function treatmentData(input: ReturnType<typeof treatmentInput>, actor: string) { return { name: input.name, department: input.department, purpose: input.purpose, legalBasis: input.legalBasis, dataCategories: json(input.dataCategories), dataSubjects: json(input.dataSubjects), operations: json(input.operations), collectionSource: input.collectionSource, recipients: json(input.recipients), systems: json(input.systems), sensitiveData: input.sensitiveData, childrenData: input.childrenData, internationalTransfer: input.internationalTransfer, transferSafeguards: input.transferSafeguards, securityMeasures: input.securityMeasures, retentionSummary: input.retentionSummary, owner: input.owner, riskLevel: input.riskLevel, status: input.status, lastReviewedAt: input.lastReviewedAt, nextReviewAt: input.nextReviewAt, updatedBy: actor }; }
function assessmentData(input: ReturnType<typeof impactAssessmentInput>, actor: string) { return { treatmentId: input.treatmentId, title: input.title, reason: input.reason, status: input.status, inherentRisk: input.inherentRisk, residualRisk: input.residualRisk, risks: json(input.risks), safeguards: json(input.safeguards), necessity: input.necessity, proportionality: input.proportionality, dpoOpinion: input.dpoOpinion, approvedBy: input.status === "approved" ? actor : null, approvedAt: input.status === "approved" ? new Date() : null, reviewAt: input.reviewAt, updatedBy: actor }; }
function json(value: unknown) { return value as Prisma.InputJsonValue; }
function positiveId(value: unknown, message: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new PrivacyGovernanceError(message); return id; }
function averageDays(items: Array<{ createdAt: Date; completedAt: Date | null }>) { if (!items.length) return 0; return Math.round(items.reduce((total, item) => total + ((item.completedAt?.valueOf() || item.createdAt.valueOf()) - item.createdAt.valueOf()) / 86_400_000, 0) / items.length * 10) / 10; }
function trendData(requests: Array<{ createdAt: Date }>, incidents: Array<{ reportedAt: Date }>, now: Date) { return Array.from({ length: 14 }, (_, index) => { const day = new Date(now); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() - (13 - index)); const end = new Date(day.valueOf() + 86_400_000); return { date: day.toISOString().slice(0, 10), requests: requests.filter((item) => item.createdAt >= day && item.createdAt < end).length, incidents: incidents.filter((item) => item.reportedAt >= day && item.reportedAt < end).length }; }); }
function readinessData(input: { settings: { dataProtectionOfficerName: string | null; dataProtectionEmail: string | null; privacyProgramReviewAt: Date | null } | null; bases: Array<{ active: boolean }>; retention: Array<{ active: boolean; reviewAt: Date | null }>; treatments: Array<{ nextReviewAt: Date | null }>; assessmentsCurrent: Set<string | null>; highRiskTreatments: Array<{ id: string }>; openRequests: Array<{ dueAt: Date }>; incidents: Array<{ riskRelevant: boolean; notificationDueAt: Date | null; anpdNotifiedAt: Date | null; subjectsNotifiedAt: Date | null }>; now: Date }) {
  const checks = [
    { key: "dpo", label: "Canal do encarregado publicado", ok: Boolean(input.settings?.dataProtectionOfficerName && input.settings?.dataProtectionEmail) },
    { key: "basis", label: "Hipóteses legais documentadas", ok: input.bases.some((item) => item.active) },
    { key: "retention", label: "Políticas de retenção ativas", ok: input.retention.some((item) => item.active) },
    { key: "ropa", label: "Inventário de tratamentos ativo", ok: input.treatments.length > 0 },
    { key: "ripd", label: "RIPD para tratamentos de maior risco", ok: input.highRiskTreatments.every((item) => input.assessmentsCurrent.has(item.id)) },
    { key: "requests", label: "Solicitações dentro do prazo", ok: !input.openRequests.some((item) => item.dueAt < input.now) },
    { key: "incidents", label: "Comunicações de incidentes controladas", ok: !input.incidents.some((item) => item.riskRelevant && item.notificationDueAt && item.notificationDueAt < input.now && (!item.anpdNotifiedAt || !item.subjectsNotifiedAt)) },
    { key: "review", label: "Revisão periódica planejada", ok: Boolean(input.settings?.privacyProgramReviewAt && input.settings.privacyProgramReviewAt >= input.now) && !input.treatments.some((item) => item.nextReviewAt && item.nextReviewAt < input.now) },
  ];
  return { score: Math.round(checks.filter((item) => item.ok).length / checks.length * 100), checks };
}
async function audit(db: Db | Prisma.TransactionClient, actorId: string, action: string, entityType: string, id: number | string, correlationId: string, beforeData: object | null, afterData: object | null) { await db.tenantAuditEvent.create({ data: { actorId, action, entityType, entityId: String(id), correlationId, beforeData: beforeData || undefined, afterData: afterData || undefined } }); }
function failure(error: unknown, operation: string) {
  if (error instanceof PrivacyGovernanceError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: 403, headers: NO_STORE });
  if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "central de privacidade") }, { status: error.status, headers: NO_STORE });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return Response.json({ error: "Conflito de concorrência. Recarregue e tente novamente." }, { status: 409, headers: NO_STORE });
  console.error(`privacy center failed to ${operation}`, error instanceof Error ? error.name : "unknown"); return Response.json({ error: `Não foi possível ${operation}.` }, { status: 500, headers: NO_STORE });
}
