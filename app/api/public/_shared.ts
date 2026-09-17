import { controlDb } from "@/db/control";
import { HttpSecurityError } from "@/lib/http-security";

const platformHosts = new Set(["nalven.com.br", "www.nalven.com.br", "localhost", "127.0.0.1"]);

export async function publicOrganization(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  let hostname: string;
  try { hostname = new URL(`${url.protocol}//${host}`).hostname.toLowerCase(); }
  catch { throw new HttpSecurityError("Loja não identificada.", 404); }
  const domain = await controlDb.organizationDomain.findFirst({
    where: { hostname, organization: { status: { in: ["active", "trial"] } } },
    select: { organizationId: true },
  });
  if (domain) return domain.organizationId;
  const slug = url.searchParams.get("loja");
  if (!platformHosts.has(hostname) || !slug || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug))
    throw new HttpSecurityError("Loja não identificada.", 404);
  const organization = await controlDb.organization.findFirst({
    where: { slug, status: { in: ["active", "trial"] } }, select: { id: true },
  });
  if (!organization) throw new HttpSecurityError("Loja não identificada.", 404);
  return organization.id;
}

export const publicPlanSelect = {
  id: true, name: true, monthlyPrice: true, annualPrice: true,
  seats: true, modules: true, active: true,
} as const;

export function publicJson(value: unknown) {
  return Response.json(value, { headers: {
    "cache-control": "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
  } });
}

export function safePublicUrl(value: string | null | undefined) {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}
