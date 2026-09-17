import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { request as httpsRequest } from "node:https";
import pg from "pg";
import { buildScienceEvent, pfxSigningIdentity, sendScienceEvent } from "../lib/erp/nfe-manifestation";

const ACCESS_KEY = String(process.env.NFE_ACCESS_KEY || "").replace(/\D/g, "");
const EXPECTED_DOCUMENT = "62119228000152";
if (!ACCESS_KEY || process.env.NALVEN_CONFIRM_NFE_SCIENCE !== `SCIENCE:${ACCESS_KEY}`) throw new Error("Chave e confirmação explícita da Ciência da Operação são obrigatórias.");
const app = parseEnv(readFileSync("/etc/nalven/app.env", "utf8"));
const tenant = parseEnv(readFileSync("/etc/nalven/tenants/scalon-modas.env", "utf8"));
const master = createHash("sha256").update(app.NALVEN_SECRETS_MASTER_KEY || "").digest();
function decrypt(value: string) { const [version, iv, tag, data] = value.split("."); if (version !== "v1") throw new Error("Invalid secret"); const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8"); }

const client = new pg.Client({ connectionString: tenant.TENANT_DATABASE_URL });
async function main() {
await client.connect();
try {
  const detected = (await client.query("SELECT id,recipient_document,full_document_available,document_type,classification FROM inbound_fiscal_documents WHERE source='sefaz_nfe' AND environment='production' AND branch_id=1 AND access_key=$1", [ACCESS_KEY])).rows[0];
  if (!detected || detected.recipient_document.replace(/\D/g, "") !== EXPECTED_DOCUMENT || detected.document_type !== "nfe" || detected.classification !== "goods") throw new Error("NF-e de mercadorias destinada à matriz não encontrada.");
  if (detected.full_document_available) { console.log({ accessKey: ACCESS_KEY, status: "already_available" }); return; }
  const prior = await client.query("SELECT after_data,created_at FROM audit_events WHERE action='dfe.manifestation.science.registered' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1", [ACCESS_KEY]);
  if (prior.rowCount) {
    const requestedAt = new Date(prior.rows[0].created_at), nextLookupAt = new Date(requestedAt.getTime() + 60 * 60_000), correlationId = randomUUID();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`nfe-science:${ACCESS_KEY}`]);
    await client.query("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,correlation_id,after_data) SELECT $1,$2,$3,$4,$5,$6::jsonb WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE action=$2 AND entity_type=$3 AND entity_id=$4)", ["maintenance:nfe-science", "dfe.key.recovery.requested", "nfe_access_key", ACCESS_KEY, correlationId, JSON.stringify({ branchId: 1, environment: "production", status: "science_registered", protocol: prior.rows[0].after_data?.protocol || null, requestedAt, nextLookupAt })]);
    await client.query("UPDATE inbound_fiscal_documents SET manifestation_status='science',updated_at=now() WHERE id=$1 AND full_document_available=false", [detected.id]);
    await client.query("UPDATE dfe_sync_cursors SET next_sync_at=GREATEST(COALESCE(next_sync_at,now()),$1),updated_at=now() WHERE branch_id=1 AND source='sefaz_nfe' AND environment='production'", [nextLookupAt]);
    await client.query("COMMIT");
    console.log({ accessKey: ACCESS_KEY, status: "already_audited", nextLookupAt });
  }
  else {
    const branch = (await client.query("SELECT id,document FROM branches WHERE id=1 AND status='active'")).rows[0];
    if (branch?.document.replace(/\D/g, "") !== EXPECTED_DOCUMENT) throw new Error("Filial inesperada");
    const certificate = (await client.query("SELECT encrypted_content,encrypted_password FROM fiscal_certificates WHERE branch_id=1 AND active AND expires_at>now() ORDER BY expires_at DESC LIMIT 1")).rows[0];
    if (!certificate) throw new Error("Certificado A1 válido ausente");
    const pfx = Buffer.from(decrypt(certificate.encrypted_content), "base64"), passphrase = decrypt(certificate.encrypted_password);
    if (process.env.NFE_WSDL === "1") {
      const wsdl = await new Promise<string>((resolve, reject) => { const request = httpsRequest("https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx?WSDL", { pfx, passphrase, rejectUnauthorized: true }, response => { const chunks: Buffer[]=[]; response.on("data", (chunk: Buffer)=>chunks.push(chunk)); response.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8"))); }); request.on("error",reject); request.end(); });
      console.log(wsdl.slice(0, 20_000)); return;
    }
    const identity = pfxSigningIdentity(pfx, passphrase, EXPECTED_DOCUMENT), requestedAt = new Date(), correlationId = randomUUID();
    const eventXml = buildScienceEvent({ accessKey: ACCESS_KEY, document: EXPECTED_DOCUMENT, environment: "production", occurredAt: requestedAt, ...identity });
    const response = await sendScienceEvent({ eventXml, accessKey: ACCESS_KEY, pfx, passphrase, environment: "production" });
    const nextLookupAt = new Date(requestedAt.getTime() + 60 * 60_000);
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`nfe-science:${ACCESS_KEY}`]);
    await client.query("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,correlation_id,after_data) VALUES($1,$2,$3,$4,$5,$6::jsonb)", ["maintenance:nfe-science", "dfe.manifestation.science.registered", "nfe_access_key", ACCESS_KEY, correlationId, JSON.stringify({ branchId: 1, environment: "production", status: response.result.status, reason: response.result.reason, protocol: response.result.protocol, registered: response.result.registered, alreadyRegistered: response.result.alreadyRegistered, requestedAt, nextLookupAt })]);
    await client.query("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,correlation_id,after_data) VALUES($1,$2,$3,$4,$5,$6::jsonb)", ["maintenance:nfe-science", "dfe.key.recovery.requested", "nfe_access_key", ACCESS_KEY, correlationId, JSON.stringify({ branchId: 1, environment: "production", status: "science_registered", protocol: response.result.protocol, requestedAt, nextLookupAt })]);
    await client.query("UPDATE inbound_fiscal_documents SET manifestation_status='science',updated_at=now() WHERE id=$1 AND full_document_available=false", [detected.id]);
    await client.query("INSERT INTO inbound_fiscal_document_events(document_id,type,actor_id,correlation_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)", [detected.id, "dfe.manifestation.science.registered", "maintenance:nfe-science", correlationId, JSON.stringify({ protocol: response.result.protocol, status: response.result.status, nextLookupAt })]);
    await client.query("UPDATE dfe_sync_cursors SET next_sync_at=GREATEST(COALESCE(next_sync_at,now()),$1),updated_at=now() WHERE branch_id=1 AND source='sefaz_nfe' AND environment='production'", [nextLookupAt]);
    await client.query("COMMIT");
    console.log(response.result);
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally { await client.end(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Falha inesperada"); process.exitCode = 1; });
