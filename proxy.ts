import { assertRequestOrigin, HttpSecurityError } from "./lib/http-security";
import { randomUUID } from "node:crypto";
import { controlDb } from "./db/control";
import { loginAlias, reservedPath } from "./lib/site/paths";
import { recordNavigation } from "./lib/site/navigation";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_API_BODY = 10 * 1024 * 1024;
const LIBRARY_API = /^\/api\/erp\/library(?:\/|$)/;
const SENSITIVE_PUBLIC_PAGE = /^\/(?:login|cadastro|esqueci-senha|redefinir-senha|convite|avaliar|rastrear-pedido|portal)(?:\/|$)/i;
const PRIVATE_API_PREFIXES = [
  "/api/admin",
  "/api/auth",
  "/api/erp",
  "/api/internal",
  "/api/portal",
  "/api/pos-agent",
  "/api/saas",
  "/api/webhooks",
];

export async function proxy(request: NextRequest, event?: NextFetchEvent) {
  const requestId = trustedRequestId(request.headers.get("x-request-id"));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const pathname = request.nextUrl.pathname;
  requestHeaders.set("x-route-path", pathname);
  if (["GET", "HEAD"].includes(request.method) && !pathname.startsWith("/api/")) {
    let destination: string | undefined;
    let status: 301 | 302 | 307 | 308 = 308;
    if (loginAlias(pathname)) destination = "/login";
    else if (!reservedPath(pathname)) {
      const rule = await controlDb.siteRedirect.findUnique({ where: { source: pathname } });
      if (rule?.active) { destination = rule.destination; status = rule.status as typeof status; }
    }
    if (destination) {
      const target = request.nextUrl.clone();
      target.pathname = destination;
      target.search = "";
      const response = NextResponse.redirect(target, status);
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("x-request-id", requestId);
      if (request.method === "GET" && !request.headers.has("next-router-prefetch"))
        event?.waitUntil(recordNavigation(requestId, pathname, status, destination));
      return response;
    }
  }
  if (pathname.startsWith("/api/")) {
    const rejected = validateApiMutation(request, requestId);
    if (rejected) return rejected;
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    applyApiHeaders(response.headers, pathname, requestId);
    return response;
  }

  const nonce = Buffer.from(randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("permissions-policy", permissionsPolicy());
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("x-request-id", requestId);
  if (reservedPath(pathname)) response.headers.set("x-robots-tag", "noindex, nofollow");
  if (SENSITIVE_PUBLIC_PAGE.test(pathname)) {
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("pragma", "no-cache");
  }
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/redefinir-senha/:path*",
    "/convite/:path*",
    "/avaliar/:path*",
    {
      source:
        "/((?!_next/static|_next/image|api/erp/library(?:/|$)|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)",
    },
  ],
};

function validateApiMutation(request: NextRequest, requestId: string) {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return null;
  try {
    assertRequestOrigin(request);
  } catch (error) {
    if (error instanceof HttpSecurityError) return rejected(error.message, error.status, requestId);
    throw error;
  }
  const maximum = LIBRARY_API.test(request.nextUrl.pathname) ? 101 * 1024 * 1024 : MAX_API_BODY;

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0)
      return rejected("Tamanho do payload inválido.", 400, requestId);
    if (length > maximum)
      return rejected("Payload excede o limite permitido.", 413, requestId);
    if (length > 0 && !request.headers.get("content-type"))
      return rejected("Content-Type obrigatório.", 415, requestId);
  }
  return null;
}

function applyApiHeaders(headers: Headers, pathname: string, requestId: string) {
  if (PRIVATE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    headers.set("cache-control", "private, no-store, max-age=0");
    headers.set("pragma", "no-cache");
  }
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", permissionsPolicy());
  headers.set("x-permitted-cross-domain-policies", "none");
  headers.set("x-request-id", requestId);
}

function rejected(error: string, status: number, requestId: string) {
  return NextResponse.json(
    { error, requestId },
    {
      status,
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    },
  );
}

function trustedRequestId(value: string | null) {
  return value && /^[a-zA-Z0-9._-]{8,128}$/.test(value) ? value : randomUUID();
}

function contentSecurityPolicy(nonce: string) {
  const developmentEval =
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}

function permissionsPolicy() {
  return [
    "camera=(self)",
    "microphone=()",
    "geolocation=()",
    "payment=(self)",
    "usb=(self)",
    "serial=(self)",
    "hid=(self)",
  ].join(", ");
}
