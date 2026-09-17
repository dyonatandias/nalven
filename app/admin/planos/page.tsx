import PlanManager from "@/components/admin/plan-manager";
export default async function PlansPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const params = await searchParams;
  return <PlanManager initialPlanId={params.plan} />;
}
