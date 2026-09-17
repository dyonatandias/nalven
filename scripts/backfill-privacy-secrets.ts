import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { isProtectedPrivacySecret, protectPrivacySubject } from "../lib/erp/privacy-governance";

if (process.env.NALVEN_ALLOW_PRIVACY_BACKFILL !== "1") throw new Error("Defina NALVEN_ALLOW_PRIVACY_BACKFILL=1 para confirmar a proteção dos registros legados.");
const tenantUrl = process.env.TENANT_DATABASE_URL;
if (!tenantUrl) throw new Error("TENANT_DATABASE_URL é obrigatória.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: tenantUrl }) });

async function main() {
  const [identity] = await db.$queryRawUnsafe<Array<{ database: string; role: string }>>("SELECT current_database() AS database, current_user AS role");
  if (!identity || !/^nalven_t_[a-z0-9_]+$/.test(identity.database) || identity.role !== `${identity.database}_runtime`) throw new Error("O backfill exige a credencial runtime do próprio tenant.");
  const rows = await db.privacyRequest.findMany({ select: { id: true, subjectDocument: true, contact: true } }); let protectedCount = 0;
  for (const row of rows) {
    if (isProtectedPrivacySecret(row.subjectDocument) && isProtectedPrivacySecret(row.contact)) continue;
    const document = row.subjectDocument.replace(/\D/g, ""), contact = row.contact.trim(); if (!document || !contact) throw new Error(`Registro legado de privacidade inválido: ${row.id}`);
    const protectedSubject = protectPrivacySubject(document, contact);
    await db.$transaction(async (tx) => {
      await tx.privacyRequest.update({ where: { id: row.id }, data: { ...protectedSubject, version: { increment: 1 } } });
      await tx.privacyRequestEvent.create({ data: { requestId: row.id, kind: "security_migration", note: "Identificadores legados protegidos com criptografia autenticada e índice HMAC.", actorId: "system", actorName: "Migração de segurança" } });
      await tx.tenantAuditEvent.create({ data: { action: "privacy.request.identifiers_encrypted", entityType: "privacy_request", entityId: String(row.id), correlationId: `privacy-secret-backfill-${row.id}`, afterData: { encrypted: true, tokenized: true } } });
    });
    protectedCount += 1;
  }
  console.log(JSON.stringify({ database: identity.database, scanned: rows.length, protected: protectedCount }));
}

main().finally(async () => db.$disconnect());
