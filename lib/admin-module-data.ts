export const moduleLists: Record<string, string> = {
  organizacoes: "tenants", bancos: "databases", faturamento: "invoices",
  suporte: "tickets", integracoes: "integrations", backups: "backups",
  exportacoes: "exports", provisionamento: "jobs", auditoria: "logs",
  biblioteca: "items", seo: "items", blog: "items", glossario: "items",
};

export function validateModuleData(module: string, data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Resposta inválida do servidor. Tente atualizar.");
  const record = data as Record<string, unknown>;
  const key = moduleLists[module];
  if (key && (!Array.isArray(record[key]) || !record[key].every(row => row && typeof row === "object" && !Array.isArray(row)))) {
    throw new Error("A lista recebida está incompleta. Tente atualizar.");
  }
  if (module === "organizacoes" && !(record.tenants as Record<string,unknown>[]).every(row =>
    ["id","name","status"].every(field => typeof row[field] === "string"))) {
    throw new Error("A lista de organizações recebida está incompleta. Tente atualizar.");
  }
  return record;
}
