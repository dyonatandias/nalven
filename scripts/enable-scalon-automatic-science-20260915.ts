import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";

const EXPECTED_DATABASE = "nalven_t_scalon_modas";
const EXPECTED_DOCUMENT = "62119228000152";
const CONFIRMATION = `ENABLE-AUTOMATIC-SCIENCE:${EXPECTED_DOCUMENT}`;
const ACTOR = "maintenance:user-authorized-20260915";

async function main() {
  if (process.env.NALVEN_CONFIRM_AUTOMATIC_SCIENCE !== CONFIRMATION) throw new Error("Confirmação explícita da política fiscal ausente.");
  const tenant = parseEnv(readFileSync("/etc/nalven/tenants/scalon-modas.env", "utf8"));
  const connectionString = tenant.TENANT_DATABASE_URL || "";
  const dsn = new URL(connectionString);
  if (decodeURIComponent(dsn.pathname) !== `/${EXPECTED_DATABASE}` || decodeURIComponent(dsn.username) !== `${EXPECTED_DATABASE}_runtime`) throw new Error("Banco ou autoridade inesperada.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dfe-auto-science:${EXPECTED_DOCUMENT}`]);
    const branch = (await client.query("SELECT id,document FROM branches WHERE id=$1 AND status=$2", [1, "active"])).rows[0];
    if (!branch || branch.document.replace(/\D/g, "") !== EXPECTED_DOCUMENT) throw new Error("Filial destinatária inesperada.");
    const cursor = (await client.query("SELECT id,enabled,processing_mode,auto_science_enabled,auto_science_authorized_at,auto_science_authorized_by FROM dfe_sync_cursors WHERE branch_id=$1 AND source=$2 AND environment=$3 FOR UPDATE", [branch.id, "sefaz_nfe", "production"])).rows[0];
    if (!cursor) throw new Error("Política de captura NF-e não configurada.");
    if (!cursor.auto_science_enabled) {
      const authorizedAt = new Date();
      await client.query("UPDATE dfe_sync_cursors SET auto_science_enabled=true,auto_science_authorized_at=$1,auto_science_authorized_by=$2,enabled=true,updated_at=now() WHERE id=$3", [authorizedAt, ACTOR, cursor.id]);
      await client.query("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,correlation_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)", [
        ACTOR, "dfe.automatic_science.enabled", "dfe_sync_cursor", String(cursor.id), randomUUID(),
        JSON.stringify({ enabled: cursor.enabled, processingMode: cursor.processing_mode, automaticScience: cursor.auto_science_enabled }),
        JSON.stringify({ branchId: branch.id, source: "sefaz_nfe", environment: "production", enabled: true, processingMode: cursor.processing_mode, automaticScience: true, authorizedAt, authorizedBy: ACTOR, scope: "all_inbound_goods_nfe", conclusiveManifestationAutomatic: false, stockReceiptAutomatic: false }),
      ]);
    }
    await client.query("COMMIT");
    const state = (await client.query("SELECT id,enabled,processing_mode,auto_science_enabled,auto_science_authorized_at,auto_science_authorized_by,next_sync_at,last_error FROM dfe_sync_cursors WHERE id=$1", [cursor.id])).rows[0];
    console.log(JSON.stringify(state));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Falha inesperada");
  process.exitCode = 1;
});
