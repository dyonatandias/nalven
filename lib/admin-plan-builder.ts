import { PLAN_RESOURCES } from "./admin-plan-catalog";
import { STRICT_PLAN_POLICY } from "./erp/plan-features";

export const PLAN_GROUPS = [
  { id: "commercial", name: "Vendas e relacionamento", resources: ["dashboard", "pdv", "pos-settings", "sales", "orders", "crm", "contracts", "service-orders", "customers"] },
  { id: "operations", name: "Produtos e operações", resources: ["products", "categories", "stock", "inventory", "purchases", "suppliers", "production", "logistics", "marketplaces"] },
  { id: "finance", name: "Financeiro e fiscal", resources: ["finance", "cash-close", "accounts", "reconciliation", "planning", "fiscal", "invoices", "payments"] },
  { id: "management", name: "Gestão e segurança", resources: ["users", "branches", "reports", "activities", "privacy", "settings", "billing"] },
  { id: "connections", name: "Integrações e conteúdo", resources: ["integrations", "automations", "transactional-email", "ai-integrations", "library"] },
] as const;
export function searchText(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim(); }
export function changePlanGrant(current: string[], resource: string, grant: string, enabled: boolean) {
  const next = new Set(current);
  next.add(STRICT_PLAN_POLICY);
  if (enabled) { next.add(grant); next.add(`${resource}.read`); }
  else {
    next.delete(grant);
    if (grant === `${resource}.read`) for (const key of [`menu:${resource}`, `${resource}.read`, `${resource}.write`]) next.delete(key);
  }
  return [...next];
}
export function setPlanResourceMode(current: string[], resources: string[], mode: "read" | "write" | "none") {
  let next = [...current];
  for (const resource of resources) {
    next = changePlanGrant(next, resource, `${resource}.read`, false);
    if (mode !== "none") {
      next = changePlanGrant(next, resource, `menu:${resource}`, true);
      if (mode === "write") next = changePlanGrant(next, resource, `${resource}.write`, true);
    }
  }
  return next;
}
export function planGrantSummary(modules: string[]) {
  return { read: PLAN_RESOURCES.filter(([key]) => modules.includes(`${key}.read`)).length, write: PLAN_RESOURCES.filter(([key]) => modules.includes(`${key}.write`)).length, menus: PLAN_RESOURCES.filter(([key]) => modules.includes(`menu:${key}`) && modules.includes(`${key}.read`)) };
}
