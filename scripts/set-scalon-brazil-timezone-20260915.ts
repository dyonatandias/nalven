import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";

const EXPECTED_DATABASE = "nalven_t_scalon_modas";
const EXPECTED_DOCUMENT = "62119228000152";
const TIME_ZONE = "America/Sao_Paulo";
const CONFIRMATION = `SET-BRAZIL-TIMEZONE:${EXPECTED_DOCUMENT}`;
const ACTOR = "maintenance:timezone-standardization-20260915";

async function main() {
  if (process.env.NALVEN_CONFIRM_BRAZIL_TIMEZONE !== CONFIRMATION) {
    throw new Error("Confirmação explícita da padronização de fuso ausente.");
  }
  const tenant = parseEnv(
    readFileSync("/etc/nalven/tenants/scalon-modas.env", "utf8"),
  );
  const connectionString = tenant.TENANT_DATABASE_URL || "";
  const dsn = new URL(connectionString);
  if (
    decodeURIComponent(dsn.pathname) !== `/${EXPECTED_DATABASE}` ||
    decodeURIComponent(dsn.username) !== `${EXPECTED_DATABASE}_runtime`
  ) {
    throw new Error("Banco ou autoridade inesperada.");
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `timezone:${EXPECTED_DOCUMENT}`,
    ]);
    const branches = await client.query<{
      id: number;
      document: string;
      timezone: string;
    }>("SELECT id,document,timezone FROM branches ORDER BY id FOR UPDATE");
    if (
      !branches.rows.some(
        (branch) => branch.document.replace(/\D/g, "") === EXPECTED_DOCUMENT,
      )
    ) {
      throw new Error("Organização destinatária inesperada.");
    }
    const settings = await client.query<{ id: number; timezone: string }>(
      "SELECT id,timezone FROM tenant_settings ORDER BY id FOR UPDATE",
    );
    const schedules = await client.query<{ id: number; timezone: string }>(
      "SELECT id,timezone FROM report_schedules ORDER BY id FOR UPDATE",
    );
    const mismatchedBranches = branches.rows.filter(
      (branch) => branch.timezone !== TIME_ZONE,
    );
    const mismatchedSettings = settings.rows.filter(
      (setting) => setting.timezone !== TIME_ZONE,
    );
    const mismatchedSchedules = schedules.rows.filter(
      (schedule) => schedule.timezone !== TIME_ZONE,
    );

    await client.query(
      "UPDATE tenant_settings SET timezone=$1,updated_at=now() WHERE timezone IS DISTINCT FROM $1",
      [TIME_ZONE],
    );
    await client.query(
      "UPDATE branches SET timezone=$1,updated_at=now() WHERE timezone IS DISTINCT FROM $1",
      [TIME_ZONE],
    );
    await client.query(
      "UPDATE report_schedules SET timezone=$1,updated_at=now() WHERE timezone IS DISTINCT FROM $1",
      [TIME_ZONE],
    );

    const priorAudit = await client.query(
      "SELECT id FROM audit_events WHERE action=$1 AND entity_type=$2 AND entity_id=$3 LIMIT 1",
      ["settings.timezone.standardized", "organization", EXPECTED_DOCUMENT],
    );
    if (!priorAudit.rowCount) {
      await client.query(
        "INSERT INTO audit_events(actor_id,action,entity_type,entity_id,correlation_id,before_data,after_data,category,source) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)",
        [
          ACTOR,
          "settings.timezone.standardized",
          "organization",
          EXPECTED_DOCUMENT,
          randomUUID(),
          JSON.stringify({
            tenantSettings: mismatchedSettings,
            branches: mismatchedBranches,
            reportSchedules: mismatchedSchedules,
          }),
          JSON.stringify({
            timezone: TIME_ZONE,
            tenantSettings: settings.rowCount,
            branches: branches.rowCount,
            reportSchedules: schedules.rowCount,
            timestampsStoredAsUtc: true,
          }),
          "settings",
          "maintenance",
        ],
      );
    }
    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        timezone: TIME_ZONE,
        tenantSettings: settings.rowCount,
        branches: branches.rowCount,
        reportSchedules: schedules.rowCount,
      }),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Falha inesperada");
  process.exitCode = 1;
});
