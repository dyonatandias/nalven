import { timingSafeEqual } from "node:crypto";
import { HttpSecurityError } from "@/lib/http-security";

export function assertInternalJob(request: Request) {
  const expected = process.env.NALVEN_INTERNAL_JOB_TOKEN || "";
  const received = /^Bearer ([\x21-\x7e]{32,512})$/.exec(request.headers.get("authorization") || "")?.[1] || "";
  const a = Buffer.from(expected), b = Buffer.from(received);
  if (a.length < 32 || a.length > 512 || a.length !== b.length || !timingSafeEqual(a, b))
    throw new HttpSecurityError("Não autorizado", 401);
}
