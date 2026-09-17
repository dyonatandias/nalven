import { publicPlanWhere } from "@/lib/admin-plan-policy";
import { controlDb } from "@/db/control";
import { unexpectedErrorResponse } from "@/lib/http-security";
import { publicJson, publicPlanSelect } from "../_shared";

export async function GET() {
  try {
  const now = new Date();
  const [content, plans, announcements] = await Promise.all([
    controlDb.siteContent.findMany({ where: { public: true }, select: { key: true, value: true }, orderBy: [{ group: "asc" }, { sortOrder: "asc" }] }),
    controlDb.plan.findMany({ where: publicPlanWhere, select: publicPlanSelect, orderBy: { monthlyPrice: "asc" } }),
    controlDb.announcement.findMany({ where: { active: true, audience: "all", AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] }, select: { id: true, title: true, message: true, audience: true, level: true, active: true, startsAt: true, endsAt: true, createdAt: true }, orderBy: { createdAt: "desc" } })
  ]);
  return publicJson({ content: Object.fromEntries(content.map((item) => [item.key, item.value])), plans, announcements });
  } catch (error) { return unexpectedErrorResponse("public.site", error); }
}
