import { tenantDb } from "../db/tenant";
import { controlDb } from "../db/control";
import { syncBranchFiscalSource } from "../lib/erp/dfe-distribution";

// Explicitly scoped operational check; never seeds, emits, manifests or receives stock.
async function main() {
  const organizationId = "org-93e60813-215c-4fc0-b4e2-4897e67fc9f1";
  const db = await tenantDb(organizationId);
  try {
    const branch = await db.branch.findUniqueOrThrow({ where: { id: 1 } });
    if (branch.document.replace(/\D/g, "") !== "62119228000152") throw new Error("Matriz incorreta");
    for (const source of ["nfse_adn", "sefaz_nfe"] as const) {
      await db.dfeSyncCursor.upsert({
        where: { branchId_source_environment: { branchId: 1, source, environment: "production" } },
        update: { processingMode: "review" },
        create: { branchId: 1, source, environment: "production", processingMode: "review", enabled: true },
      });
      try { console.log(JSON.stringify({ source, result: await syncBranchFiscalSource(db, 1, source, "authorized:national-dfe-review", "production") })); }
      catch (error) { console.log(JSON.stringify({ source, error: error instanceof Error ? error.message : "Falha" })); process.exitCode = 1; }
    }
    const documents = await db.inboundFiscalDocument.findMany({ select: { documentType: true, issuerDocument: true, recipientDocument: true, number: true, issueDate: true, total: true } });
    console.log(JSON.stringify({ documents: documents.map(d => ({ ...d, direction: d.issuerDocument === branch.document ? "issued" : d.recipientDocument === branch.document ? "received" : "other_party" })), products: await db.product.count(), invoices: await db.purchaseInvoice.count() }));
  } finally { await db.$disconnect(); await controlDb.$disconnect(); }
}
main().catch(() => { console.error("Diagnóstico interrompido; verificar configuração sem expor credenciais."); process.exitCode = 1; });
