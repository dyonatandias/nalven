/** Feature restrictions are evaluated before owner/role permissions. */
export const STRICT_PLAN_POLICY = "@policy:v1";
export function planAllows(modules: unknown, resource: string) {
  if (!Array.isArray(modules)) return false;
  if (modules.includes(STRICT_PLAN_POLICY)) return modules.includes(`${resource}.read`) || modules.includes(`${resource}.*`);
  return modules.includes("*") || modules.includes(resource);
}
export function restrictedFeature(modules: unknown, permission: string) {
  const resource = permission.split(".")[0];
  if (Array.isArray(modules) && modules.includes(STRICT_PLAN_POLICY)) return !modules.includes(permission) && !modules.includes(`${resource}.*`);
  return ["service-orders", "contracts", "marketplaces"].includes(resource) && !planAllows(modules, resource);
}

export function planMenuAllows(modules: unknown, resource: string) {
  return Array.isArray(modules) && modules.includes(STRICT_PLAN_POLICY)
    ? modules.includes(`menu:${resource}`) && !restrictedFeature(modules, `${resource}.read`)
    : !restrictedFeature(modules, `${resource}.read`);
}
