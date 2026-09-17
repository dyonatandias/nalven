import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  choice,
  entityId,
  FinancialOperationsInputError,
  record,
  text,
} from "@/lib/erp/financial-operations-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";
export async function GET() {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "automations.read");
    const db = await tenantDb(organization.id),
      [rules, notifications] = await Promise.all([
        db.automationRule.findMany({
          include: { runs: { orderBy: { startedAt: "desc" }, take: 10 } },
          orderBy: { name: "asc" },
        }),
        db.automationNotification.findMany({
          include: { rule: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);
    return Response.json({
      rules,
      notifications,
      summary: {
        active: rules.filter((item) => item.active).length,
        runs: rules.reduce((sum, item) => sum + item.runs.length, 0),
        actions: rules
          .flatMap((item) => item.runs)
          .reduce((sum, item) => sum + item.actionCount, 0),
        failures: rules
          .flatMap((item) => item.runs)
          .filter((item) => item.status === "failed").length,
      },
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(),
      access = await assertTenantPermission(
        organization.id,
        "automations.write",
      );
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id),
      body = record(await readJsonObject(request, 262_144)),
      correlationId = randomUUID();
    if (body.action === "create") {
      const trigger = choice(body.trigger, [
          "low_stock",
          "overdue_title",
          "shipment_incident",
        ]),
        conditionValue = Number(body.conditionValue);
      if (!Number.isFinite(conditionValue))
        throw new FinancialOperationsInputError("Valor da condição inválido.");
      const rule = await db.automationRule.create({
        data: {
          name: text(body.name, "Nome"),
          trigger,
          conditionField:
            trigger === "low_stock"
              ? "stock"
              : trigger === "overdue_title"
                ? "days_overdue"
                : "incident_count",
          operator: choice(body.operator || "gte", [
            "gt",
            "gte",
            "lt",
            "lte",
            "eq",
          ]),
          conditionValue: String(conditionValue),
          actionType: choice(body.actionType, [
            "notify",
            "audit",
            "create_task",
          ]),
          actionConfig: {
            message: String(body.message || "Ação automática")
              .trim()
              .slice(0, 300),
          },
          createdBy: access.user.name,
        },
      });
      await audit(
        db,
        access.user.id,
        "automation_rule.created",
        "automation_rule",
        rule.id,
        correlationId,
        { trigger: rule.trigger, actionType: rule.actionType },
      );
      return Response.json({ rule, correlationId }, { status: 201 });
    }
    if (body.action === "toggle") {
      const id = entityId(body.ruleId),
        before = await db.automationRule.findUnique({ where: { id } });
      if (!before)
        throw new FinancialOperationsInputError("Regra não encontrada.");
      const rule = await db.automationRule.update({
        where: { id },
        data: { active: !before.active },
      });
      await audit(
        db,
        access.user.id,
        "automation_rule.toggled",
        "automation_rule",
        id,
        correlationId,
        { active: rule.active },
      );
      return Response.json({ rule, correlationId });
    }
    if (body.action === "scan" || body.action === "run") {
      const rules =
        body.action === "run"
          ? await db.automationRule.findMany({
              where: { id: entityId(body.ruleId), active: true },
            })
          : await db.automationRule.findMany({ where: { active: true } });
      if (!rules.length)
        throw new FinancialOperationsInputError(
          "Nenhuma regra ativa encontrada.",
        );
      const bucket = new Date().toISOString().slice(0, 13),
        results = [];
      for (const rule of rules)
        results.push(
          await executeRule(
            db,
            rule,
            access.user,
            `${rule.id}:${bucket}`,
            correlationId,
          ),
        );
      return Response.json({ results, correlationId });
    }
    if (body.action === "notification.read") {
      const id = entityId(body.notificationId),
        updated = await db.automationNotification.updateMany({
          where: { id, status: "unread" },
          data: { status: "read", readAt: new Date() },
        });
      if (!updated.count)
        throw new FinancialOperationsInputError("Notificação não encontrada.");
      return Response.json({ read: true, correlationId });
    }
    throw new FinancialOperationsInputError("Ação de automação inválida.");
  } catch (error) {
    return failure(error);
  }
}
async function executeRule(
  db: Awaited<ReturnType<typeof tenantDb>>,
  rule: {
    id: number;
    name: string;
    trigger: string;
    conditionField: string;
    operator: string;
    conditionValue: string;
    actionType: string;
    actionConfig: unknown;
  },
  user: { id: string; name: string },
  key: string,
  correlationId: string,
) {
  const existing = await db.automationRun.findUnique({
    where: { idempotencyKey: key },
  });
  if (existing) return existing;
  let labels: string[] = [];
  const threshold = Number(rule.conditionValue);
  if (rule.trigger === "low_stock") {
    const products = await db.product.findMany({
      where: { active: true, type: "product" },
    });
    labels = products
      .filter((item) => compare(item.stock, threshold, rule.operator))
      .map((item) => `${item.name}: ${item.stock}`);
  } else if (rule.trigger === "overdue_title") {
    const titles = await db.financialTitle.findMany({
      where: {
        status: { in: ["open", "partial", "overdue"] },
        dueAt: { lt: new Date() },
      },
    });
    labels = titles
      .filter((item) =>
        compare(
          Math.floor((Date.now() - item.dueAt.valueOf()) / 86400000),
          threshold,
          rule.operator,
        ),
      )
      .map(
        (item) =>
          `${item.documentNumber || item.description}: ${item.dueAt.toISOString().slice(0, 10)}`,
      );
  } else {
    const shipments = await db.shipment.findMany({
      where: { status: { not: "delivered" } },
      include: { events: { where: { type: "incident" } } },
    });
    labels = shipments
      .filter((item) => compare(item.events.length, threshold, rule.operator))
      .map((item) => `${item.number}: ${item.events.length} ocorrência(s)`);
  }
  const messageConfig =
    rule.actionConfig &&
    typeof rule.actionConfig === "object" &&
    "message" in rule.actionConfig
      ? String((rule.actionConfig as { message?: unknown }).message || "")
      : "";
  return db.$transaction(async (tx) => {
    const run = await tx.automationRun.create({
      data: {
        ruleId: rule.id,
        idempotencyKey: key,
        status: "completed",
        matchedCount: labels.length,
        actionCount: labels.length ? 1 : 0,
        finishedAt: new Date(),
      },
    });
    if (labels.length && rule.actionType !== "audit")
      await tx.automationNotification.create({
        data: {
          ruleId: rule.id,
          subject:
            rule.actionType === "create_task"
              ? `Tarefa: ${rule.name}`
              : rule.name,
          message:
            `${messageConfig || "Regra atendida"}. ${labels.slice(0, 5).join("; ")}`.slice(
              0,
              1000,
            ),
        },
      });
    await tx.tenantAuditEvent.create({
      data: {
        actorId: user.id,
        action: "automation_rule.executed",
        entityType: "automation_rule",
        entityId: String(rule.id),
        correlationId,
        afterData: {
          runId: run.id,
          matchedCount: labels.length,
          actionType: rule.actionType,
        },
      },
    });
    return run;
  });
}
function compare(value: number, threshold: number, operator: string) {
  return operator === "gt"
    ? value > threshold
    : operator === "gte"
      ? value >= threshold
      : operator === "lt"
        ? value < threshold
        : operator === "lte"
          ? value <= threshold
          : value === threshold;
}
async function audit(
  db: Awaited<ReturnType<typeof tenantDb>>,
  actorId: string,
  action: string,
  entityType: string,
  id: number,
  correlationId: string,
  afterData: object,
) {
  await db.tenantAuditEvent.create({
    data: {
      actorId,
      action,
      entityType,
      entityId: String(id),
      correlationId,
      afterData,
    },
  });
}
function failure(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (
    error instanceof FinancialOperationsInputError ||
    error instanceof CustomerInputError
  )
    return Response.json(
      { error: error.message },
      { status: error.message.includes("Origem") ? 403 : 400 },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("erp-automations", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Erro nas automações." }, { status: 500 });
}
