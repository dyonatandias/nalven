import { PERMISSION_RESOURCES } from "@/lib/erp/permission-resources";
import { STRICT_PLAN_POLICY, restrictedFeature } from "@/lib/erp/plan-features";

// These are the permission boundaries actually enforced by ERP routes.
export const PLAN_ACTIONS = ["read", "write"] as const;
export const PLAN_RESOURCES = PERMISSION_RESOURCES;
const allowed = new Set<string>([STRICT_PLAN_POLICY, ...PLAN_RESOURCES.flatMap(([key]) => [`menu:${key}`, ...PLAN_ACTIONS.map(action => `${key}.${action}`)])]);

export function editablePlanModules(value: unknown): string[] {
  if (Array.isArray(value) && value.includes(STRICT_PLAN_POLICY)) return value.filter((item): item is string => typeof item === "string" && allowed.has(item));
  // Preserve the actual legacy entitlement behavior until the administrator saves explicit choices.
  return [STRICT_PLAN_POLICY, ...PLAN_RESOURCES.filter(([key]) => !restrictedFeature(value, `${key}.read`)).flatMap(([key]) => [`menu:${key}`, ...PLAN_ACTIONS.map(action => `${key}.${action}`)])];
}
