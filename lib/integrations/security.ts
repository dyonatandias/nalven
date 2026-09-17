import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { IntegrationError, safeHttpsSyntax } from "./core";

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata.aws.internal"]);

export async function validatePublicHttpsUrl(value: string) {
  if (!safeHttpsSyntax(value)) throw new IntegrationError("Somente URLs HTTPS sem credenciais embutidas são permitidas.");
  const url = new URL(value);
  if (BLOCKED_HOSTS.has(url.hostname.toLowerCase()) || url.hostname.toLowerCase().endsWith(".local")) throw new IntegrationError("Destino interno não permitido.");
  if (url.port && url.port !== "443" && !(Number(url.port) >= 1024 && Number(url.port) <= 65535)) throw new IntegrationError("Porta de destino não permitida.");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicIp(item.address))) throw new IntegrationError("O host precisa resolver exclusivamente para endereços públicos.");
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export async function resolvePublicHost(hostname: string) {
  const clean = hostname.trim().toLowerCase();
  if (!clean || BLOCKED_HOSTS.has(clean) || clean.endsWith(".local")) throw new IntegrationError("Destino interno não permitido.");
  const addresses = isIP(clean) ? [{ address: clean, family: isIP(clean) }] : await lookup(clean, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicIp(item.address))) throw new IntegrationError("O host precisa resolver exclusivamente para endereços públicos.");
  return addresses[0];
}

export async function safeRequest(value: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; redirects?: number } = {}) {
  const redirects = options.redirects ?? 0;
  if (redirects > 3) throw new IntegrationError("O destino excedeu o limite de redirecionamentos.");
  const pinned = await validatePublicHttpsUrl(value);
  const response = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpsRequest(pinned.url, {
      method: options.method || "GET",
      headers: options.headers,
      timeout: Math.min(10000, Math.max(1000, options.timeoutMs || 10000)),
      servername: pinned.url.hostname,
      lookup: pinnedLookup(pinned.address, pinned.family),
    }, (res) => {
      const chunks: Buffer[] = [], limit = 256 * 1024;
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          res.destroy(new IntegrationError("A resposta remota excedeu 256 KB.", 502));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers as Record<string, string | string[] | undefined>, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  const location = firstHeader(response.headers.location);
  if (response.status >= 300 && response.status < 400 && location) {
    const nextUrl = new URL(location, pinned.url);
    const changedOrigin = nextUrl.origin !== pinned.url.origin;
    if (changedOrigin && (options.body || Object.keys(options.headers || {}).some(name => /authorization|cookie|token|secret|key|signature/i.test(name))))
      throw new IntegrationError("Redirecionamento com dados sensíveis para outra origem bloqueado.", 502);
    const becomesGet = response.status === 303 || ((response.status === 301 || response.status === 302) && (options.method || "GET").toUpperCase() === "POST");
    const headers = sanitizeRedirectHeaders(options.headers, changedOrigin, becomesGet);
    return safeRequest(nextUrl.toString(), { ...options, headers, method: becomesGet ? "GET" : options.method, body: becomesGet ? undefined : options.body, redirects: redirects + 1 });
  }
  return response;
}

export async function safeBinaryRequest(
  value: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    timeoutMs?: number;
    redirects?: number;
    maximumResponseBytes?: number;
  } = {},
) {
  const redirects = options.redirects ?? 0;
  if (redirects > 3)
    throw new IntegrationError("O destino excedeu o limite de redirecionamentos.");
  const maximumResponseBytes = options.maximumResponseBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1)
    throw new IntegrationError("Limite de resposta remota inválido.", 500);
  const pinned = await validatePublicHttpsUrl(value);
  const response = await new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve, reject) => {
    const req = httpsRequest(
      pinned.url,
      {
        method: options.method || "GET",
        headers: options.headers,
        timeout: Math.min(15000, Math.max(1000, options.timeoutMs || 15000)),
        servername: pinned.url.hostname,
        lookup: pinnedLookup(pinned.address, pinned.family),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximumResponseBytes) {
            res.destroy(
              new IntegrationError("A resposta remota excedeu o limite permitido.", 502),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  const location = firstHeader(response.headers.location);
  if (response.status >= 300 && response.status < 400 && location) {
    const nextUrl = new URL(location, pinned.url);
    const changedOrigin = nextUrl.origin !== pinned.url.origin;
    if (changedOrigin && (options.body || Object.keys(options.headers || {}).some(name => /authorization|cookie|token|secret|key|signature/i.test(name))))
      throw new IntegrationError("Redirecionamento com dados sensíveis para outra origem bloqueado.", 502);
    const method = (options.method || "GET").toUpperCase();
    const becomesGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    return safeBinaryRequest(nextUrl.toString(), {
      ...options,
      headers: sanitizeRedirectHeaders(options.headers, changedOrigin, becomesGet),
      method: becomesGet ? "GET" : options.method,
      body: becomesGet ? undefined : options.body,
      redirects: redirects + 1,
    });
  }
  return response;
}

function firstHeader(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }

export function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

export function sanitizeRedirectHeaders(headers: Record<string, string> = {}, changedOrigin: boolean, dropBody: boolean) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const normalized = name.toLowerCase();
    if (dropBody && ["content-type", "content-length"].includes(normalized)) return false;
    return !changedOrigin || !["authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token", "api-key"].includes(normalized);
  }));
}

const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const)
  specialV6.addSubnet(address, prefix, "ipv6");

export function isPublicIp(address: string) {
  // Parse numerically: string prefixes miss expanded loopback and mapped IPv4.
  const family = isIP(address);
  if (family === 6)
    return !address.includes("%") && publicV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
  if (family !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && c === 0 || b === 0 && c === 2 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
