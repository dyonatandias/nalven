import { publicPlanWhere } from "@/lib/admin-plan-policy";
import { controlDb } from "@/db/control";
import { unexpectedErrorResponse } from "@/lib/http-security";
import { publicJson, publicPlanSelect } from "../_shared";

export async function GET() {
  try {
    const plans = await controlDb.plan.findMany({ where: publicPlanWhere, select: publicPlanSelect, orderBy: { monthlyPrice: "asc" } });
    return publicJson({ plans });
  } catch (error) { return unexpectedErrorResponse("public.plans", error); }
}
