import { publicPlanWhere } from "@/lib/admin-plan-policy";
import { signupConfiguration } from "@/lib/site/signup";
import { controlDb } from "@/db/control";
import SignupForm from "./signup-form";

export const metadata = { title: "Criar conta | NALVEN", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function Cadastro({ searchParams }: { searchParams: Promise<{ plano?: string }> }) {
  let props: Parameters<typeof SignupForm>[0];
  try {
    const [configuration, plans, { plano }] = await Promise.all([
      signupConfiguration(),
      controlDb.plan.findMany({ where: publicPlanWhere, orderBy: { monthlyPrice: "asc" }, select: { id: true, name: true, monthlyPrice: true } }),
      searchParams,
    ]);
    props = { paymentMethods: configuration.paymentMethods, dueDay: configuration.dueDay, plans, selectedPlan: plans.find(plan => plan.id === plano)?.id || plans[0]?.id || "" };
  } catch {
    props = { unavailable: true, paymentMethods: [], dueDay: 1, plans: [], selectedPlan: "" };
  }
  return <SignupForm {...props} />;
}
