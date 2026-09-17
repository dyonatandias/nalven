import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  nextScheduleRun,
  normalizeReportFilters,
  reportHref,
  ReportWorkspaceInputError,
  savedViewInput,
  scheduleInput,
} from "../lib/erp/report-workspace";

test("normaliza apenas filtros permitidos e mantém URLs reproduzíveis", () => {
  assert.deepEqual(
    normalizeReportFilters("sales", {
      period: "30d",
      page: 9,
      malicious: "drop",
      date_min: "2026-08-01",
    }),
    { period: "30d", date_min: "2026-08-01" },
  );
  assert.equal(
    reportHref("margins", { health: "critical", page: 5 }),
    "/erp/relatorios/margens?health=critical",
  );
  assert.throws(
    () => normalizeReportFilters("fiscal", { search: { nested: true } }),
    ReportWorkspaceInputError,
  );
});

test("valida visões e rotinas sem confiar na interface", () => {
  assert.deepEqual(
    savedViewInput({
      name: " Visão mensal ",
      reportKey: "sales",
      visibility: "team",
      filters: { period: "90d" },
    }),
    {
      name: "Visão mensal",
      description: null,
      reportKey: "sales",
      visibility: "team",
      filters: { period: "90d" },
    },
  );
  assert.throws(
    () => savedViewInput({ name: "x", reportKey: "sales" }),
    ReportWorkspaceInputError,
  );
  assert.throws(
    () =>
      scheduleInput(
        {
          name: "Agenda",
          reportKey: "sales",
          frequency: "weekly",
          weekday: 9,
          time: "08:00",
        },
        "America/Sao_Paulo",
      ),
    ReportWorkspaceInputError,
  );
});

test("calcula próxima execução no fuso operacional para cada cadência", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  assert.equal(
    nextScheduleRun(
      {
        frequency: "daily",
        weekday: null,
        dayOfMonth: null,
        time: "10:00",
        timezone: "America/Sao_Paulo",
      },
      now,
    ).toISOString(),
    "2026-09-03T13:00:00.000Z",
  );
  assert.equal(
    nextScheduleRun(
      {
        frequency: "weekly",
        weekday: 1,
        dayOfMonth: null,
        time: "08:00",
        timezone: "America/Sao_Paulo",
      },
      now,
    ).toISOString(),
    "2026-09-07T11:00:00.000Z",
  );
  assert.equal(
    nextScheduleRun(
      {
        frequency: "monthly",
        weekday: null,
        dayOfMonth: 15,
        time: "09:30",
        timezone: "America/Sao_Paulo",
      },
      now,
    ).toISOString(),
    "2026-09-15T12:30:00.000Z",
  );
});

test("central aplica autorização, isolamento, auditoria e proteção de origem", async () => {
  const source = await readFile(
    new URL("../app/api/erp/reports/workspace/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /reportContext\("reports\.read"\)/);
  assert.match(source, /assertSameOrigin\(request\)/);
  assert.match(source, /ownerUserId: access\.user\.id/);
  assert.match(source, /report_view\.created/);
  assert.match(source, /report_schedule\.completed/);
  assert.match(source, /cache-control": "private, no-store/);
});

test("interface cobre central, biblioteca, rotinas, histórico e breakpoints móveis", async () => {
  const [component, css, schema, migration, seed, reports] = await Promise.all([
    readFile(
      new URL("../components/erp/reports-workspace-hub.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../components/erp/reports-workspace-hub.module.css",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../prisma/tenant/schema.prisma", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../prisma/tenant/migrations/20260903190000_report_workspace_control_center/migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../scripts/seed-demo-reports.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/erp/reports-center.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  for (const label of [
    "CENTRAL DE INTELIGÊNCIA",
    "Visões salvas",
    "Rotinas recorrentes",
    "Exportações recentes",
  ])
    assert.match(component, new RegExp(label));
  assert.match(component, /ReportDetailTools/);
  assert.match(reports, /ReportsWorkspaceHub/);
  assert.match(reports, /\/margens/);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
  assert.doesNotMatch(css, /font-size:\s*[0-9]px/);
  for (const model of [
    "SavedReportView",
    "ReportSchedule",
    "ReportExportEvent",
  ])
    assert.match(schema, new RegExp(`model ${model}`));
  assert.match(migration, /ON DELETE CASCADE/);
  assert.match(migration, /status_next_run_at_idx/);
  assert.match(seed, /NALVEN_ALLOW_DEMO_REPORT_SEED/);
  assert.match(seed, /nalven_t_demo_runtime/);
});
