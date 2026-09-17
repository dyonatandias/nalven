import type { PortalLicenseData } from "../../lib/billing/portal-license-data";

export function licenseFixture(): PortalLicenseData {
  return {
    license: {
      status: "active", statusCode: "ativa", valid: null,
      validFrom: { kind: "date", value: "2026-09-01T03:00:00-03:00" }, validUntil: { kind: "not_defined", value: null }, maxInstallations: { kind: "finite", value: 5 },
      plan: { code: "gestao-avancada", name: "Gestão avançada" }, resourcesKnown: true, limitsKnown: true,
      resources: Array.from({ length: 35 }, (_, index) => ({ code: `recurso_${String(index).padStart(2, "0")}`, name: index === 0 ? "Cota zero do recurso" : index === 1 ? "Recurso desabilitado" : index === 2 ? "Recurso sem confirmação" : index === 3 ? "Automação sem cota numérica" : `Recurso de gestão ${String(index).padStart(2, "0")}`, enabled: index === 1 ? false : index === 2 ? null : true, availability: index < 2 ? "disabled" : index === 2 ? "unknown" : "enabled", limit: index === 0 ? { kind: "finite", value: 0 } : index === 2 ? { kind: "unknown", value: null } : index === 3 ? { kind: "no_quota", value: null } : { kind: "finite", value: index * 10 }, origin: "plano" })),
      limits: [{ code: "limite_zero", name: "Cota adicional zero", limit: { kind: "finite", value: 0 }, unit: "itens" }, { code: "limite_documentos", name: "Documentos contratados", limit: { kind: "finite", value: 250 }, unit: "documentos" }, { code: "limite_desconhecido", name: "Cota não confirmada", limit: { kind: "unknown", value: null }, unit: null }],
    },
    applicationPlan: { id: "plan-local", name: "Gestão avançada do ambiente", expectedRemoteCode: "gestao-avancada", modules: [{ id: "products", name: "Produtos", enabled: true }, { id: "service-orders", name: "Ordens de serviço", enabled: false }] },
    comparison: { plan: "match" }, source: { name: "billing_headless", checkedAt: "2026-09-08T12:00:00Z", cached: false },
    warnings: ["A validade final não foi confirmada; ausência de data não significa licença sem expiração."],
    capabilities: { canRefresh: true, canExportDiagnostic: true, canRotate: false }, generatedAt: "2026-09-08T12:00:01Z",
  };
}
