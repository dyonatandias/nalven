export function assertFiscalEntryAllowed(document: { documentType: string; classification: string; status: string; environment?: string }) {
  if (document.environment && document.environment !== "production") throw new Error("Documento de homologação ou ambiente não identificado não pode gerar entrada real.");
  if (["cancelled", "ignored"].includes(document.status)) throw new Error("Documento cancelado ou ignorado não pode gerar entrada.");
  if (document.documentType !== "nfe" || document.classification !== "goods") throw new Error("Somente NF-e classificada como mercadoria pode gerar entrada de estoque.");
}

export function assertFiscalReclassificationAllowed(status: string) {
  if (["received", "cancelled"].includes(status)) throw new Error("Documento recebido ou cancelado não pode ser reclassificado.");
}

export function fiscalDirection(document: { documentType: string; issuerDocument?: string | null; recipientDocument?: string | null }, branchDocument: string) {
  if (document.documentType === "event") return "event";
  const normalized = branchDocument.replace(/\D/g, "");
  if (document.issuerDocument === normalized) return "issued";
  if (document.recipientDocument === normalized) return "received";
  return "other_party";
}
