import { STRICT_PLAN_POLICY } from "@/lib/erp/plan-features";
import { setPlanResourceMode } from "@/lib/admin-plan-builder";

export const BILLING_MODULE_CODES = [
  "gestao_base", "catalogo_estoque", "pdv_vendas", "financeiro_base", "vendas_pedidos",
  "compras_fiscal", "crm", "servicos_recorrencia", "operacao_avancada", "governanca_analytics",
  "multiempresa_producao", "omnichannel",
] as const;
export type BillingModuleCode = typeof BILLING_MODULE_CODES[number];
const CODE_SET = new Set<string>(BILLING_MODULE_CODES);

/**
 * DRAFT crosswalk from Billing's commercial module codes to NALVEN's internal ERP permission
 * resources (lib/erp/permission-resources.ts). Built from the nalven_* capability identifiers
 * documented in vendor/billing-integration/docs/integracao-nalven/catalogo-modular-e-precificacao.md.
 *
 * This mapping needs sign-off from whoever owns the ERP permission catalog before it is treated
 * as final — it encodes a business decision (which resources each paid module unlocks, and at
 * what read/write granularity), not something derivable purely from the two vocabularies. Treat
 * it as a starting point for that review, not as settled truth.
 */
const MODULE_RESOURCE_MODE: Record<BillingModuleCode, { write: string[]; read?: string[] }> = {
  gestao_base: { write: ["dashboard", "customers", "suppliers", "categories", "users"], read: ["reports"] },
  catalogo_estoque: { write: ["products", "stock"] },
  pdv_vendas: { write: ["pdv", "pos-settings", "sales"] },
  financeiro_base: { write: ["finance", "cash-close", "accounts", "payments"] },
  vendas_pedidos: { write: ["orders"] },
  compras_fiscal: { write: ["purchases", "invoices", "fiscal"] },
  crm: { write: ["crm"] },
  servicos_recorrencia: { write: ["service-orders", "contracts"] },
  operacao_avancada: { write: ["inventory", "reconciliation", "planning"] },
  governanca_analytics: { write: ["reports", "activities", "privacy"] },
  multiempresa_producao: { write: ["branches", "production"] },
  omnichannel: { write: ["marketplaces", "logistics", "integrations"] },
};

// Platform self-service, not a commercial add-on — available regardless of contracted modules.
const ALWAYS_ON = { write: ["settings"], read: ["billing"] };

/** Turns a Billing catalog entry's included module codes into the internal RBAC grant array stored on Plan.modules / Organization.modules. Unknown codes are ignored. */
export function deriveRbacModules(billingModuleCodes: unknown): string[] {
  const codes = Array.isArray(billingModuleCodes)
    ? billingModuleCodes.filter((value): value is BillingModuleCode => typeof value === "string" && CODE_SET.has(value))
    : [];
  const writeResources = new Set<string>(ALWAYS_ON.write);
  const readResources = new Set<string>(ALWAYS_ON.read);
  for (const code of codes) {
    const grant = MODULE_RESOURCE_MODE[code];
    grant.write.forEach(resource => writeResources.add(resource));
    grant.read?.forEach(resource => readResources.add(resource));
  }
  for (const resource of writeResources) readResources.delete(resource);
  let modules = setPlanResourceMode([STRICT_PLAN_POLICY], [...writeResources], "write");
  modules = setPlanResourceMode(modules, [...readResources], "read");
  return modules;
}
