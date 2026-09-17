import { STRICT_PLAN_POLICY } from "@/lib/erp/plan-features";
import { HttpSecurityError } from "@/lib/http-security";
import { PLAN_ACTIONS, PLAN_RESOURCES } from "@/lib/admin-plan-catalog";
const allowed = new Set<string>([STRICT_PLAN_POLICY, ...PLAN_RESOURCES.flatMap(([key]) => [`menu:${key}`, ...PLAN_ACTIONS.map(action => `${key}.${action}`)])]);

export function parsePlanInput(body: Record<string, unknown>) {
  const text = (key: string, maximum: number) => {
    const value = typeof body[key] === "string" ? body[key].trim() : "";
    if (!value || value.length > maximum) throw new HttpSecurityError(`Campo inválido: ${key}.`);
    return value;
  };
  const id = text("id", 50);
  if (!/^[a-z0-9][a-z0-9_-]{1,49}$/.test(id)) throw new HttpSecurityError("Código do plano inválido.");
  const name = text("name", 160);
  const { monthlyPrice, annualPrice, seats } = body;
  if (typeof monthlyPrice !== "number" || typeof annualPrice !== "number" || typeof seats !== "number") throw new HttpSecurityError("Preços e limite de usuários devem ser números.");
  if (![monthlyPrice, annualPrice].every(value => Number.isFinite(value) && value >= 0 && value <= 1_000_000) || !Number.isInteger(seats) || seats < 1 || seats > 100_000) throw new HttpSecurityError("Preços ou limite de usuários inválidos.");
  if (typeof body.active !== "boolean") throw new HttpSecurityError("Disponibilidade inválida.");
  const visibility = body.visibility;
  if (visibility !== "public" && visibility !== "private") throw new HttpSecurityError("Visibilidade inválida.");
  const ownerOrganizationId = visibility === "private" ? text("ownerOrganizationId", 150) : null;
  if (!Array.isArray(body.modules) || body.modules.length > 250 || !body.modules.includes(STRICT_PLAN_POLICY) || body.modules.some(item => typeof item !== "string" || !allowed.has(item))) throw new HttpSecurityError("Seleção de recursos inválida.");
  const modules = [...new Set(body.modules as string[])];
  for (const [resource] of PLAN_RESOURCES) {
    if (modules.some(value => value === `menu:${resource}` || PLAN_ACTIONS.slice(1).some(action => value === `${resource}.${action}`)) && !modules.includes(`${resource}.read`)) throw new HttpSecurityError("Habilite a consulta antes do menu ou das ações do recurso.");
  }
  return { id, name, monthlyPrice, annualPrice, seats, visibility, ownerOrganizationId, modules, active: body.active };
}
