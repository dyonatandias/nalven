import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { matches } from "@/lib/erp/permissions";
import { reportContext } from "@/lib/erp/report-server";
import {
  nextScheduleRun,
  parseReportKey,
  reportName,
  REPORT_DEFINITIONS,
  ReportWorkspaceInputError,
  savedViewInput,
  scheduleInput,
  type ReportFrequency,
} from "@/lib/erp/report-workspace";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

const NO_STORE = { "cache-control": "private, no-store" };

export async function GET() {
  try {
    const { access, db, timezone } = await reportContext("reports.read");
    const canWrite = matches(access.permissions, "reports.write");
    const [views, schedules, exports] = await Promise.all([
      db.savedReportView.findMany({
        where: {
          OR: [{ ownerUserId: access.user.id }, { visibility: "team" }],
        },
        include: {
          favorites: {
            where: { userId: access.user.id },
            select: { createdAt: true },
          },
          _count: { select: { schedules: true } },
        },
        orderBy: [
          { favorites: { _count: "desc" } },
          { lastOpenedAt: "desc" },
          { updatedAt: "desc" },
        ],
        take: 100,
      }),
      db.reportSchedule.findMany({
        orderBy: [
          { status: "asc" },
          { nextRunAt: "asc" },
          { updatedAt: "desc" },
        ],
        take: 100,
      }),
      db.reportExportEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    ]);
    return Response.json(
      {
        catalog: REPORT_DEFINITIONS,
        views: views.map((view) => ({
          ...view,
          favorite: view.favorites.length > 0,
          canEdit: view.ownerUserId === access.user.id,
          favorites: undefined,
        })),
        schedules,
        exports,
        summary: {
          savedViews: views.length,
          favorites: views.filter((view) => view.favorites.length > 0).length,
          activeSchedules: schedules.filter(
            (schedule) => schedule.status === "active",
          ).length,
          exports30d: exports.filter(
            (item) => item.createdAt >= new Date(Date.now() - 30 * 86_400_000),
          ).length,
        },
        capabilities: { canWrite },
        timezone,
        generatedAt: new Date().toISOString(),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonObject(request, 524_288);
    const action = String(body.action || "");
    const { access, db, timezone } = await reportContext("reports.read");
    const canWrite = matches(access.permissions, "reports.write");
    const correlationId = randomUUID();

    if (action === "view.create") {
      const input = savedViewInput(body);
      if (input.visibility === "team" && !canWrite) throw new AuthError(403);
      const duplicate = await db.savedReportView.findUnique({
        where: {
          ownerUserId_name: { ownerUserId: access.user.id, name: input.name },
        },
        select: { id: true },
      });
      if (duplicate)
        throw new ReportWorkspaceInputError(
          "Você já possui uma visão com esse nome.",
          409,
        );
      const view = await db.$transaction(async (tx) => {
        const created = await tx.savedReportView.create({
          data: {
            ...input,
            ownerUserId: access.user.id,
            ownerName: access.user.name,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "report_view.created",
            entityType: "saved_report_view",
            entityId: String(created.id),
            correlationId,
            afterData: {
              name: created.name,
              reportKey: created.reportKey,
              visibility: created.visibility,
              filters: created.filters,
            },
          },
        });
        return created;
      });
      return Response.json(
        { view, correlationId },
        { status: 201, headers: NO_STORE },
      );
    }

    if (action === "view.update") {
      const id = identifier(body.viewId, "Visão inválida."),
        before = await db.savedReportView.findUnique({ where: { id } });
      if (!before)
        return Response.json(
          { error: "Visão não encontrada." },
          { status: 404, headers: NO_STORE },
        );
      if (before.ownerUserId !== access.user.id) throw new AuthError(403);
      const input = savedViewInput(body);
      if (input.visibility === "team" && !canWrite) throw new AuthError(403);
      const duplicate = await db.savedReportView.findFirst({
        where: {
          ownerUserId: access.user.id,
          name: input.name,
          id: { not: id },
        },
        select: { id: true },
      });
      if (duplicate)
        throw new ReportWorkspaceInputError(
          "Você já possui uma visão com esse nome.",
          409,
        );
      const view = await db.$transaction(async (tx) => {
        const updated = await tx.savedReportView.update({
          where: { id },
          data: input,
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "report_view.updated",
            entityType: "saved_report_view",
            entityId: String(id),
            correlationId,
            beforeData: viewSnapshot(before),
            afterData: viewSnapshot(updated),
          },
        });
        return updated;
      });
      return Response.json({ view, correlationId }, { headers: NO_STORE });
    }

    if (action === "view.favorite") {
      const id = identifier(body.viewId, "Visão inválida."),
        view = await accessibleView(db, id, access.user.id);
      if (!view)
        return Response.json(
          { error: "Visão não encontrada." },
          { status: 404, headers: NO_STORE },
        );
      const favorite = body.favorite === true;
      if (favorite)
        await db.reportViewFavorite.upsert({
          where: {
            reportViewId_userId: { reportViewId: id, userId: access.user.id },
          },
          update: {},
          create: { reportViewId: id, userId: access.user.id },
        });
      else
        await db.reportViewFavorite.deleteMany({
          where: { reportViewId: id, userId: access.user.id },
        });
      return Response.json({ ok: true, favorite }, { headers: NO_STORE });
    }

    if (action === "view.open") {
      const id = identifier(body.viewId, "Visão inválida."),
        view = await accessibleView(db, id, access.user.id);
      if (!view)
        return Response.json(
          { error: "Visão não encontrada." },
          { status: 404, headers: NO_STORE },
        );
      await db.savedReportView.update({
        where: { id },
        data: { lastOpenedAt: new Date() },
      });
      return Response.json({ ok: true }, { headers: NO_STORE });
    }

    if (action === "view.delete") {
      const id = identifier(body.viewId, "Visão inválida."),
        view = await db.savedReportView.findUnique({ where: { id } });
      if (!view)
        return Response.json(
          { error: "Visão não encontrada." },
          { status: 404, headers: NO_STORE },
        );
      if (
        view.ownerUserId !== access.user.id &&
        !(canWrite && view.visibility === "team")
      )
        throw new AuthError(403);
      await db.$transaction(async (tx) => {
        await tx.savedReportView.delete({ where: { id } });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "report_view.deleted",
            entityType: "saved_report_view",
            entityId: String(id),
            correlationId,
            beforeData: viewSnapshot(view),
          },
        });
      });
      return Response.json({ ok: true, correlationId }, { headers: NO_STORE });
    }

    if (action === "schedule.create") {
      if (!canWrite) throw new AuthError(403);
      const input = scheduleInput(body, timezone);
      const savedReportViewId = optionalIdentifier(
        body.viewId,
        "Visão inválida.",
      );
      if (
        savedReportViewId &&
        !(await accessibleView(db, savedReportViewId, access.user.id))
      )
        throw new ReportWorkspaceInputError("Visão salva não encontrada.", 404);
      const schedule = await db.$transaction(async (tx) => {
        const created = await tx.reportSchedule.create({
          data: {
            ...input,
            savedReportViewId,
            createdBy: access.user.id,
            createdByName: access.user.name,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "report_schedule.created",
            entityType: "report_schedule",
            entityId: String(created.id),
            correlationId,
            afterData: scheduleSnapshot(created),
          },
        });
        return created;
      });
      return Response.json(
        { schedule, correlationId },
        { status: 201, headers: NO_STORE },
      );
    }

    if (action === "schedule.toggle") {
      if (!canWrite) throw new AuthError(403);
      const id = identifier(body.scheduleId, "Rotina inválida."),
        before = await db.reportSchedule.findUnique({ where: { id } });
      if (!before)
        return Response.json(
          { error: "Rotina não encontrada." },
          { status: 404, headers: NO_STORE },
        );
      const status = body.active === true ? "active" : "paused";
      const nextRunAt =
        status === "active"
          ? nextScheduleRun({
              frequency: before.frequency as ReportFrequency,
              weekday: before.weekday,
              dayOfMonth: before.dayOfMonth,
              time: before.time,
              timezone: before.timezone,
            })
          : null;
      const schedule = await db.reportSchedule.update({
        where: { id },
        data: { status, nextRunAt },
      });
      await db.tenantAuditEvent.create({
        data: {
          actorId: access.user.id,
          action: "report_schedule.status_changed",
          entityType: "report_schedule",
          entityId: String(id),
          correlationId,
          beforeData: { status: before.status },
          afterData: { status },
        },
      });
      return Response.json({ schedule, correlationId }, { headers: NO_STORE });
    }

    if (action === "schedule.complete") {
      if (!canWrite) throw new AuthError(403);
      const id = identifier(body.scheduleId, "Rotina inválida."),
        before = await db.reportSchedule.findUnique({ where: { id } });
      if (!before)
        return Response.json(
          { error: "Rotina não encontrada." },
          { status: 404, headers: NO_STORE },
        );
      const now = new Date(),
        nextRunAt =
          before.status === "active"
            ? nextScheduleRun(
                {
                  frequency: before.frequency as ReportFrequency,
                  weekday: before.weekday,
                  dayOfMonth: before.dayOfMonth,
                  time: before.time,
                  timezone: before.timezone,
                },
                now,
              )
            : null;
      const [schedule] = await db.$transaction([
        db.reportSchedule.update({
          where: { id },
          data: { lastRunAt: now, lastStatus: "completed", nextRunAt },
        }),
        db.reportExportEvent.create({
          data: {
            reportKey: before.reportKey,
            reportName: before.name,
            format: before.format,
            scope: "scheduled",
            status: "completed",
            fileName: safeFileName(body.fileName),
            requestedBy: access.user.id,
            requestedByName: access.user.name,
          },
        }),
        db.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "report_schedule.completed",
            entityType: "report_schedule",
            entityId: String(id),
            correlationId,
            afterData: { lastRunAt: now, nextRunAt },
          },
        }),
      ]);
      return Response.json({ schedule, correlationId }, { headers: NO_STORE });
    }

    if (action === "schedule.delete") {
      if (!canWrite) throw new AuthError(403);
      const id = identifier(body.scheduleId, "Rotina inválida."),
        before = await db.reportSchedule.findUnique({ where: { id } });
      if (!before)
        return Response.json(
          { error: "Rotina não encontrada." },
          { status: 404, headers: NO_STORE },
        );
      await db.$transaction([
        db.reportSchedule.delete({ where: { id } }),
        db.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "report_schedule.deleted",
            entityType: "report_schedule",
            entityId: String(id),
            correlationId,
            beforeData: scheduleSnapshot(before),
          },
        }),
      ]);
      return Response.json({ ok: true, correlationId }, { headers: NO_STORE });
    }

    if (action === "export.record") {
      const reportKey = parseReportKey(body.reportKey);
      const event = await db.reportExportEvent.create({
        data: {
          reportKey,
          reportName: reportName(reportKey),
          format: "csv",
          scope: "manual",
          status: "completed",
          fileName: safeFileName(body.fileName),
          requestedBy: access.user.id,
          requestedByName: access.user.name,
        },
      });
      return Response.json({ event }, { status: 201, headers: NO_STORE });
    }

    throw new ReportWorkspaceInputError("Ação inválida.");
  } catch (error) {
    return failure(error);
  }
}

type Db = Awaited<ReturnType<typeof reportContext>>["db"];

function accessibleView(db: Db, id: number, userId: string) {
  return db.savedReportView.findFirst({
    where: { id, OR: [{ ownerUserId: userId }, { visibility: "team" }] },
  });
}

function identifier(value: unknown, message: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new ReportWorkspaceInputError(message);
  return parsed;
}

function optionalIdentifier(value: unknown, message: string) {
  return value === null || value === undefined || value === ""
    ? null
    : identifier(value, message);
}

function safeFileName(value: unknown) {
  const normalized = String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 180);
  return normalized || null;
}

function viewSnapshot(value: {
  name: string;
  reportKey: string;
  visibility: string;
  filters: Prisma.JsonValue;
}) {
  return {
    name: value.name,
    reportKey: value.reportKey,
    visibility: value.visibility,
    filters: value.filters,
  };
}

function scheduleSnapshot(value: {
  name: string;
  reportKey: string;
  frequency: string;
  time: string;
  timezone: string;
  status: string;
  nextRunAt: Date | null;
}) {
  return {
    name: value.name,
    reportKey: value.reportKey,
    frequency: value.frequency,
    time: value.time,
    timezone: value.timezone,
    status: value.status,
    nextRunAt: value.nextRunAt,
  };
}

function failure(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  const status =
    error instanceof AuthError
      ? error.status
      : error instanceof ReportWorkspaceInputError
        ? error.status
        : 500;
  if (status >= 500)
    console.error("report_workspace_error", {
      error: error instanceof Error ? error.name : typeof error,
    });
  return Response.json(
    {
      error:
        status >= 500
          ? "Não foi possível concluir a operação."
          : error instanceof Error
            ? error.message
            : "Dados inválidos.",
    },
    { status, headers: NO_STORE },
  );
}
