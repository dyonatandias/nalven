import { controlDb } from "@/db/control";

export async function GET() {
  try {
    await controlDb.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", application: "nalven", database: "ok", timestamp: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "degraded", application: "nalven", database: "unavailable", timestamp: new Date().toISOString() }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
