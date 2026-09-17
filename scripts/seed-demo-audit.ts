import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";

if (process.env.NALVEN_ALLOW_DEMO_AUDIT_SEED !== "1") throw new Error("Defina NALVEN_ALLOW_DEMO_AUDIT_SEED=1 para confirmar o seed demonstrativo de auditoria.");
const tenantUrl = process.env.TENANT_DATABASE_URL;
if (!tenantUrl) throw new Error("TENANT_DATABASE_URL é obrigatória.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: tenantUrl }) });
const DAY = 86_400_000, now = new Date();

const scenarios = [
  ["membership.sessions_revoked", "membership", "m-demo-finance", { activeSessions: 3 }, { activeSessions: 0, reason: "Revisão preventiva de acesso" }],
  ["tenant_role.updated", "tenant_role", "finance", { permissions: ["finance.read"] }, { permissions: ["finance.read", "reports.read", "activities.write"] }],
  ["organization_invite.revoked", "organization_invite", "invite-demo-expired", { status: "pending" }, { status: "revoked", reason: "Convite não reconhecido" }],
  ["branch.status_changed", "branch", "6", { status: "active" }, { status: "inactive", reason: "Reorganização operacional" }],
  ["nfe.issue.failed", "fiscal_document", "NFE-DEMO-2841", { status: "processing" }, { status: "failed", errorCode: "539", reason: "Duplicidade de NF-e" }],
  ["dfe.sync.completed", "dfe_sync_cursor", "2", { lastNsu: "000000000008700" }, { lastNsu: "000000000008724", documents: 24 }],
  ["bank.reconciliation.reversed", "bank_transaction", "TX-DEMO-114", { status: "reconciled", amount: 1840.5 }, { status: "pending", reason: "Documento vinculado incorretamente" }],
  ["financial_title.status_changed", "financial_title", "721", { status: "open" }, { status: "overdue", amount: 4275.9 }],
  ["cash_close.adjusted", "cash_register_session", "CX-DEMO-09", { differenceCents: 7800 }, { differenceCents: 0, approvedBy: "supervisor" }],
  ["stock.adjustment.created", "stock_movement", "MOV-DEMO-220", { quantity: 18 }, { quantity: 15, reason: "Avaria identificada na contagem" }],
  ["inventory.count.completed", "inventory_count", "INV-DEMO-32", { status: "counting" }, { status: "completed", divergences: 3 }],
  ["purchase.approval.rejected", "purchase_order", "PC-DEMO-91", { status: "pending", total: 14850 }, { status: "rejected", reason: "Cotação acima do orçamento" }],
  ["sales_order.discount_override", "sales_order", "PED-DEMO-1208", { discountPercent: 10 }, { discountPercent: 24, approvalReference: "APR-DEMO-17" }],
  ["contract.updated", "service_contract", "CTR-DEMO-0001", { amount: 2350 }, { amount: 2450, adjustmentIndex: "IPCA" }],
  ["customer.updated", "customer", "1", { email: "contato.antigo@cliente.demo", document: "11444777000161" }, { email: "financeiro@cliente.demo", document: "11444777000161" }],
  ["supplier.homologation.changed", "supplier", "2", { status: "pending" }, { status: "approved", validUntil: "2027-09-03" }],
  ["privacy.request.completed", "privacy_request", "LGPD-DEMO-8", { status: "processing" }, { status: "completed", deliveryToken: "demo-protected-token", subjectEmail: "titular@cliente.demo" }],
  ["report.exported", "report_export", "EXP-DEMO-38", null, { report: "DRE gerencial", format: "csv", rows: 348 }],
  ["media.asset.deleted", "tenant_media_asset", "MEDIA-DEMO-4", { status: "active" }, { status: "deleted", reason: "Arquivo duplicado" }],
  ["category.updated", "category", "4", { taxProfile: "standard" }, { taxProfile: "monophase", effectiveAt: "2026-09-01" }],
  ["production.order.completed", "production_order", "OP-DEMO-18", { status: "in_progress" }, { status: "completed", produced: 12, waste: 1 }],
  ["shipment.incident.opened", "shipping_incident", "INC-DEMO-77", null, { carrier: "Transportadora Sul", reason: "Volume extraviado", customerNotified: true }],
  ["marketplace.order.imported", "marketplace_order", "MKP-DEMO-440", null, { provider: "Mercado Livre", orderNumber: "2000007440", total: 389.9 }],
  ["webhook.delivery.failed", "webhook_delivery", "WH-DEMO-31", { attempt: 4 }, { attempt: 5, status: "dead_letter", secret: "never-show-demo-secret" }],
  ["pos.sale.completed", "sale", "VENDA-DEMO-881", { status: "processing" }, { status: "completed", totalCents: 87540, paymentMethod: "pix" }],
  ["pos.payment.denied", "pos_payment_intent", "PAY-DEMO-509", { status: "authorized" }, { status: "denied", providerCode: "51" }],
  ["pos.receipt.reprint_queued", "pos_print_job", "PRINT-DEMO-62", null, { copy: "reprint", reason: "Solicitação do cliente" }],
  ["settings.updated", "tenant_settings", "1", { auditRetentionDays: 1095 }, { auditRetentionDays: 1825 }],
  ["customer.csv_imported", "customer", null, null, { created: 24, updated: 11, skipped: 2 }],
  ["supplier.csv_imported", "supplier", null, null, { created: 8, updated: 3, skipped: 1 }],
  ["service_order.completed", "service_order", "OS-DEMO-0012", { status: "in_progress" }, { status: "completed", slaMinutes: 182 }],
] as const;

async function main() {
  const [identity] = await db.$queryRawUnsafe<Array<{ database: string; role: string }>>("SELECT current_database() AS database, current_user AS role");
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime") throw new Error("O seed de auditoria só pode executar em nalven_t_demo com a credencial runtime.");
  const profiles = await db.tenantUserProfile.findMany({ orderBy: { id: "asc" }, select: { userId: true } }), actors = profiles.map((item) => item.userId);
  if (!actors.length) throw new Error("Execute primeiro o seed demonstrativo de usuários.");
  const eventKeys: string[] = [];
  for (const [index, row] of scenarios.entries()) {
    const correlationId = `demo-audit-${String(index + 1).padStart(3, "0")}`;
    let event = await db.tenantAuditEvent.findFirst({ where: { correlationId }, select: { id: true } });
    if (!event) event = await db.tenantAuditEvent.create({ data: { actorId: index % 7 === 0 ? null : actors[index % actors.length], action: row[0], entityType: row[1], entityId: row[2], correlationId, beforeData: row[3] || undefined, afterData: row[4], createdAt: new Date(now.valueOf() - ((index % 14) * DAY + (index % 8) * 3_600_000)) }, select: { id: true } });
    eventKeys.push(`erp:${event.id}`);
  }
  const integrationRows = [
    { id: "audit-demo-integration-01", action: "webhook.tested", targetType: "webhook", targetId: "WH-DEMO-01", beforeData: null, afterData: { status: "success", latencyMs: 184 } },
    { id: "audit-demo-integration-02", action: "credential.updated", targetType: "integration_credential", targetId: "ERP-DEMO-02", beforeData: { status: "expired" }, afterData: { status: "active", accessToken: "demo-token-masked" } },
    { id: "audit-demo-integration-03", action: "webhook.failed", targetType: "webhook", targetId: "WH-DEMO-03", beforeData: { attempts: 5 }, afterData: { status: "failed", responseCode: 503 } },
  ];
  for (const [index, row] of integrationRows.entries()) if (!await db.integrationAuditLog.findUnique({ where: { id: row.id }, select: { id: true } })) await db.integrationAuditLog.create({ data: { ...row, beforeData: row.beforeData || undefined, userId: actors[index % actors.length], correlationId: `demo-integration-${index + 1}`, createdAt: new Date(now.valueOf() - (index + 1) * DAY) } });
  const integrationKeys = integrationRows.map((row) => `integration:${row.id}`);
  const investigations = [
    { id: "audit-demo-fiscal-risk", title: "Falhas fiscais e reprocessamento da NF-e", summary: "Validar a duplicidade detectada e confirmar que nenhum documento foi contabilizado duas vezes.", status: "in_review", severity: "high", dueAt: new Date(now.valueOf() + 2 * DAY), keys: [eventKeys[4], eventKeys[5]], resolution: null },
    { id: "audit-demo-access-review", title: "Revisão de acessos privilegiados", summary: "Evidências da revogação preventiva de sessões e atualização do perfil financeiro.", status: "open", severity: "critical", dueAt: new Date(now.valueOf() + DAY), keys: [eventKeys[0], eventKeys[1], eventKeys[2]], resolution: null },
    { id: "audit-demo-integration-health", title: "Instabilidade no endpoint do parceiro", summary: "Acompanhar indisponibilidade HTTP e validar a rotação da credencial de integração.", status: "resolved", severity: "medium", dueAt: new Date(now.valueOf() - DAY), keys: [eventKeys[23], integrationKeys[1], integrationKeys[2]], resolution: "Endpoint estabilizado e credencial rotacionada com teste de entrega bem-sucedido." },
  ];
  for (const item of investigations) {
    const saved = await db.auditInvestigation.upsert({ where: { id: item.id }, update: { title: item.title, summary: item.summary, status: item.status, severity: item.severity, assigneeId: actors[1] || actors[0], dueAt: item.dueAt, resolution: item.resolution, resolvedAt: item.status === "resolved" ? new Date(now.valueOf() - 12 * 3_600_000) : null, resolvedBy: item.status === "resolved" ? actors[0] : null }, create: { id: item.id, title: item.title, summary: item.summary, status: item.status, severity: item.severity, assigneeId: actors[1] || actors[0], openedBy: actors[0], dueAt: item.dueAt, resolution: item.resolution, resolvedAt: item.status === "resolved" ? new Date(now.valueOf() - 12 * 3_600_000) : null, resolvedBy: item.status === "resolved" ? actors[0] : null } });
    const erpKeys = item.keys.filter(Boolean).filter((key) => key.startsWith("erp:")), fingerprints = new Map((await db.tenantAuditEvent.findMany({ where: { id: { in: erpKeys.map((key) => BigInt(key.slice(4))) } }, select: { id: true, fingerprint: true } })).map((event) => [`erp:${event.id}`, event.fingerprint]));
    for (const key of item.keys.filter(Boolean)) await db.auditInvestigationEvent.upsert({ where: { investigationId_eventKey: { investigationId: saved.id, eventKey: key } }, update: {}, create: { investigationId: saved.id, eventKey: key, eventFingerprint: fingerprints.get(key) || null, linkedBy: actors[0] } });
    if (!await db.auditInvestigationNote.findFirst({ where: { investigationId: saved.id } })) await db.auditInvestigationNote.create({ data: { investigationId: saved.id, authorId: actors[0], body: item.status === "resolved" ? "Correção validada em homologação e evidências anexadas ao caso." : "Triagem concluída; responsáveis e prazo definidos para a apuração." } });
  }
  const views = [
    { name: "Riscos críticos · 30 dias", description: "Eventos críticos recentes para triagem diária.", filters: { severity: "critical", from: new Date(now.valueOf() - 30 * DAY).toISOString().slice(0, 10), sort: "newest" }, visibility: "shared" },
    { name: "Alterações financeiras", description: "Mudanças com antes/depois no domínio financeiro.", filters: { category: "finance", onlyChanges: true, sort: "newest" }, visibility: "shared" },
    { name: "PDV e integrações", description: "Operações técnicas monitoradas pela equipe.", filters: { search: "pos", sort: "newest" }, visibility: "private" },
  ];
  for (const view of views) await db.auditSavedView.upsert({ where: { ownerId_name: { ownerId: actors[0], name: view.name } }, update: { description: view.description, filters: view.filters, visibility: view.visibility }, create: { ...view, ownerId: actors[0], ownerName: "Equipe demo" } });
  console.log(JSON.stringify({ auditEvents: await db.tenantAuditEvent.count(), integrationEvents: await db.integrationAuditLog.count(), investigations: await db.auditInvestigation.count(), evidenceLinks: await db.auditInvestigationEvent.count(), savedViews: await db.auditSavedView.count() }));
}

main().finally(async () => db.$disconnect());
