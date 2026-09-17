import { timingSafeEqual } from "node:crypto";
import { syncDueDfeSources } from "@/lib/erp/dfe-distribution";

export async function POST(request: Request) {
  const expected = process.env.NALVEN_INTERNAL_JOB_TOKEN || "";
  const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const expectedBuffer = Buffer.from(expected), receivedBuffer = Buffer.from(received);
  if (!expected || expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return Response.json({ error: "Não autorizado" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const summary = await syncDueDfeSources(20);
  return Response.json({ summary }, { headers: { "cache-control": "no-store" } });
}
