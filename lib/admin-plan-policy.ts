type AssignablePlan = { active: boolean; code: string | null };

export const publicPlanWhere = { active: true, code: { not: null } } as const;

export function canAssignPlan(plan: AssignablePlan | null) {
  return !!plan?.active && plan.code !== null;
}
