type AssignablePlan = { active: boolean; visibility: string; ownerOrganizationId: string | null };

export const publicPlanWhere = { active: true, visibility: "public", ownerOrganizationId: null } as const;

export function canAssignPlan(plan: AssignablePlan | null, organizationId?: string) {
  if (!plan?.active) return false;
  if (plan.visibility === "public") return plan.ownerOrganizationId === null;
  return plan.visibility === "private" && !!organizationId && plan.ownerOrganizationId === organizationId;
}
