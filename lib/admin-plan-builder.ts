import { STRICT_PLAN_POLICY } from "./erp/plan-features";

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
