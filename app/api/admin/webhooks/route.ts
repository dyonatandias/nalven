import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { privateJson } from "@/lib/http-security";

export async function GET(request: Request) {
  try {
    await requireUser("superadmin");
    const page = Math.min(10000, Math.max(1, Number.parseInt(new URL(request.url).searchParams.get("page") || "1", 10) || 1));
    const [records, total] = await controlDb.$transaction([
      controlDb.webhookEndpoint.findMany({ select: { id: true, name: true, url: true, createdAt: true, lastAt: true, lastStatus: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50, skip: (page - 1) * 50 }),
      controlDb.webhookEndpoint.count(),
    ]);
    return privateJson({ records, total, page, pageSize: 50 });
  } catch (error) { return authErrorResponse(error); }
}
