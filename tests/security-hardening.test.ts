import { assertInternalJob } from "../lib/internal-jobs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy, config } from "../proxy";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "../lib/password";
import { isValidNewPassword } from "../lib/password-policy";
import { readIntegrationJson } from "../lib/integrations/http";
import {
  HttpSecurityError,
  readJsonObject,
  readMultipartForm,
} from "../lib/http-security";
import { isPublicIp, pinnedLookup } from "../lib/integrations/security";

const root = fileURLToPath(new URL("..", import.meta.url));

test("todas as APIs passam pelo proxy mesmo com prefetch, extensões ou biblioteca", () => {
  for (const url of ["/api/auth/logout", "/api/erp/library", "/api/erp/library/a/file", "/api/media/secret.png", "/api/webhooks/integrations/a/b.svg"]) {
    for (const headers of [{}, { purpose: "prefetch", "next-router-prefetch": "1" }]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url, headers }), true, url);
    }
  }
});

test("cookie de sessão exige comprovação de mesma origem também dentro da rota", async () => {
  for (const fetchSite of ["same-site", "none", "invalid", ""]) {
    await assert.rejects(readJsonObject(new Request("https://nalven.com.br/api/test", {
      method: "POST", headers: { cookie: "nalven_session=x", "content-type": "application/json", ...(fetchSite ? { "sec-fetch-site": fetchSite } : {}) }, body: "{}",
    })), (error) => error instanceof HttpSecurityError && error.status === 403);
  }
});

test("leitores recusam tipo JSON disfarçado e multipart sem Content-Length acima do limite", async () => {
  await assert.rejects(readJsonObject(new Request("https://nalven.com.br/api/test", {
    method: "POST", headers: { "content-type": "application/json-evil" }, body: "{}",
  })), (error) => error instanceof HttpSecurityError && error.status === 415);
  const form = new FormData();
  form.set("file", new Blob(["x".repeat(2048)]), "test.txt");
  const encoded = new Request("https://nalven.com.br/api/test", { method: "POST", body: form });
  await assert.rejects(readMultipartForm(new Request(encoded.url, { method: "POST", headers: encoded.headers, body: await encoded.arrayBuffer() }), 1024),
    (error) => error instanceof HttpSecurityError && error.status === 413);
  const valid = new FormData(); valid.set("name", "teste");
  assert.equal((await readMultipartForm(new Request("https://nalven.com.br/api/test", { method: "POST", body: valid }), 1024)).get("name"), "teste");
  await assert.rejects(readIntegrationJson(new Request("https://nalven.com.br/api/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(262144) }),
  })), { status: 413 });
});

test("senhas têm limite central e comparação resistente a hashes malformados", async () => {
  const encoded = await hashPassword("SenhaTesteForte123!");
  assert.equal(await verifyPassword("SenhaTesteForte123!", encoded), true);
  assert.equal(await verifyPassword("senha incorreta", encoded), false);
  assert.equal(await verifyPassword("SenhaTesteForte123!", DUMMY_PASSWORD_HASH), false);
  assert.equal(await verifyPassword("SenhaTesteForte123!", "scrypt:YQ==:YQ=="), false);
  assert.equal(await verifyPassword("x".repeat(257), encoded), false);
  await assert.rejects(hashPassword("x".repeat(257)), /máximo/);
});

test("política compartilhada não converte tipos e respeita os mesmos limites nos novos cadastros", () => {
  for (const invalid of [null, 123456789012, {}, ["SenhaForte123!"], "a".repeat(12), "SENHAFORTE123", "SenhaSemNumero", "Senha123", `Aa1${"x".repeat(254)}`])
    assert.equal(isValidNewPassword(invalid), false);
  assert.equal(isValidNewPassword("SenhaForte123"), true);
  assert.equal(isValidNewPassword(`Aa1${"x".repeat(253)}`), true);
});

test("rotas públicas sensíveis não expõem referrer nem permitem cache, inclusive tokens com extensão", async () => {
  for (const path of ["/login", "/cadastro", "/esqueci-senha", "/redefinir-senha/token.svg", "/convite/token.png", "/avaliar/token.webp", "/rastrear-pedido", "/portal?area=suporte"]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path }), true, path);
    const response = await proxy(new NextRequest(`https://nalven.com.br${path}`));
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
    assert.match(response.headers.get("cache-control") || "", /private, no-store/, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.match(response.headers.get("x-robots-tag") || "", /noindex/, path);
  }
});

test("IPv6 expandido, mapeado, NAT64 e redes de transição não acessam rede interna", () => {
  for (const address of ["0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:0::1", "3fff::1", "garbage::1", "fe80::1%eth0"]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp("2001:4860:4860::8888"), true);
});

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function routeFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = join(directory, entry.name);
      return entry.isDirectory()
        ? routeFiles(relative)
        : entry.name === "route.ts"
          ? [relative]
          : [];
    },
  );
}

test("proxy global bloqueia CSRF e payloads declarados acima do limite", async () => {
  const crossSite = await proxy(
    new NextRequest("https://nalven.com.br/api/auth/logout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    }),
  );
  assert.equal(crossSite.status, 403);
  assert.match(crossSite.headers.get("cache-control") || "", /no-store/);

  const unprovedSession = await proxy(
    new NextRequest("https://nalven.com.br/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "nalven_session=untrusted",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(unprovedSession.status, 403);

  const oversized = await proxy(
    new NextRequest("https://nalven.com.br/api/auth/login", {
      method: "POST",
      headers: {
        "content-length": String(10 * 1024 * 1024 + 1),
        "content-type": "application/json",
        origin: "https://nalven.com.br",
      },
    }),
  );
  assert.equal(oversized.status, 413);
});

test("proxy aceita mutação comprovadamente same-origin e protege respostas privadas", async () => {
  const response = await proxy(
    new NextRequest("https://nalven.com.br/api/erp/customers", {
      method: "POST",
      headers: {
        cookie: "nalven_session=session",
        "content-type": "application/json",
        origin: "https://nalven.com.br",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(response.headers.get("x-request-id") || "", /^[a-z0-9-]{8,}$/i);
});

test("documentos recebem nonce CSP único e política de isolamento", async () => {
  const first = await proxy(new NextRequest("https://nalven.com.br/erp/dashboard"));
  const second = await proxy(new NextRequest("https://nalven.com.br/erp/dashboard"));
  const firstPolicy = first.headers.get("content-security-policy") || "";
  const secondPolicy = second.headers.get("content-security-policy") || "";
  assert.match(firstPolicy, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  assert.match(firstPolicy, /object-src 'none'/);
  assert.match(firstPolicy, /frame-ancestors 'none'/);
  assert.notEqual(firstPolicy, secondPolicy);
  if (process.env.NODE_ENV !== "development")
    assert.doesNotMatch(firstPolicy, /'unsafe-eval'/);
  assert.equal(first.headers.get("cross-origin-opener-policy"), "same-origin");
});

test("leitor JSON limita o corpo real, valida UTF-8 e exige objeto", async () => {
  await assert.rejects(
    readJsonObject(
      new Request("https://nalven.com.br/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(100) }),
      }),
      32,
    ),
    (error) => error instanceof HttpSecurityError && error.status === 413,
  );
  await assert.rejects(
    readJsonObject(
      new Request("https://nalven.com.br/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      }),
    ),
    (error) => error instanceof HttpSecurityError && error.status === 400,
  );
});

test("classificação de rede bloqueia endereços privados e reservados", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("DNS fixado respeita os contratos single e all do Node", async () => {
  const lookup = pinnedLookup("1.1.1.1", 4);
  const single = await new Promise<{ address: string; family: number }>((resolve, reject) =>
    lookup("example.test", { all: false }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address: String(address), family: Number(family) });
    }),
  );
  assert.deepEqual(single, { address: "1.1.1.1", family: 4 });
  const all = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) =>
    lookup("example.test", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses as Array<{ address: string; family: number }>);
    }),
  );
  assert.deepEqual(all, [{ address: "1.1.1.1", family: 4 }]);
});

test("contrato estático cobre autorização, parsing, uploads e segredos", () => {
  for (const path of routeFiles("app/api/admin"))
    assert.match(source(path), /requireUser\(["']superadmin["']\)/, path);

  const delegatedReports = new Set([
    "app/api/erp/reports/top-sellers/route.ts",
    "app/api/erp/reports/totals/route.ts",
  ]);
  for (const path of routeFiles("app/api/erp")) {
    if (delegatedReports.has(path)) continue;
    if (path === "app/api/erp/production/route.ts") {
      assert.match(source(path), /export\s*\{\s*GET,\s*POST\s*\}\s*from\s*["']\.\/operations\/route["']/);
      const operations = source("app/api/erp/production/operations/route.ts");
      for (const permission of ["production.read", "production.write", "purchases.write", "inventory.write"]) assert.ok(operations.includes(`"${permission}"`), permission);
      assert.match(operations, /assertRequestOrigin\(request\)/);
      assert.match(operations, /assertTenantWriteAccess\(organization\.id\)/);
      continue;
    }
    assert.match(source(path), /assertTenantPermission|reportContext/, path);
  }

  const routes = routeFiles("app/api").map(source).join("\n");
  assert.doesNotMatch(routes, /request\.json\(\)/);
  assert.doesNotMatch(
    routes,
    /error:\s*error instanceof Error\s*\?\s*error\.message/,
  );
  assert.doesNotMatch(source("prisma/control/seed.ts"), /Demo@Nalven|Nalven!Admin/);

  const media = source("app/api/admin/media/route.ts");
  assert.match(media, /requireUser\(["']superadmin["']\)/);
  assert.match(media, /maximumFileBytes/);
  assert.doesNotMatch(media, /image\/svg\+xml/);
  const publicMedia = source("app/api/media/[id]/route.ts");
  assert.match(publicMedia, /requireUser\(["']superadmin["']\)/);
  assert.match(publicMedia, /relative\(root, path\)/);
  assert.match(publicMedia, /child\.startsWith\("\.\."\)/);

  const nginx = source("deploy/nginx.conf");
  assert.match(nginx, /limit_req_zone/);
  assert.match(nginx, /limit_conn_zone/);
  assert.match(nginx, /client_max_body_size 105m/);
  assert.match(source("proxy.ts"), /api\/erp\/library\(\?:\/\|\$\)/);
});

test("rate limit e seed de produção são persistentes e sem defaults conhecidos", () => {
  const schema = source("prisma/control/schema.prisma");
  assert.match(schema, /model ApiRateLimit/);
  assert.match(schema, /@@map\("api_rate_limits"\)/);
  const seed = source("prisma/control/seed.ts");
  assert.match(seed, /requiredSeedSecret\("SUPERADMIN_PASSWORD"\)/);
  assert.match(seed, /requiredSeedSecret\("DEMO_USER_PASSWORD"\)/);
  assert.match(seed, /security\.seed-credentials\.v1/);
  assert.match(seed, /session\.deleteMany/);
  assert.match(seed, /security\.seed_credentials\.rotated/);
  for (const deploy of [
    "deploy/bootstrap-root.sh",
    "deploy/deploy-release.sh",
    "deploy/run-tenant-migration-bundle.sh",
  ]) assert.match(source(deploy), /seed\.env|SUPERADMIN_PASSWORD/, deploy);
});


test("jobs internos exigem Bearer forte e recusam token cru ou ausente", () => {
  const original = process.env.NALVEN_INTERNAL_JOB_TOKEN;
  try {
    const token = "a".repeat(64); process.env.NALVEN_INTERNAL_JOB_TOKEN = token;
    const request = (authorization: string) => new Request("http://127.0.0.1/api/internal/analytics/jobs", { headers: { authorization } });
    assert.doesNotThrow(() => assertInternalJob(request(`Bearer ${token}`)));
    for (const value of ["", token, "Bearer " + "b".repeat(64)])
      assert.throws(() => assertInternalJob(request(value)), (error) => error instanceof HttpSecurityError && error.status === 401);
    process.env.NALVEN_INTERNAL_JOB_TOKEN = "short";
    assert.throws(() => assertInternalJob(request("Bearer short")), HttpSecurityError);
  } finally {
    if (original === undefined) delete process.env.NALVEN_INTERNAL_JOB_TOKEN;
    else process.env.NALVEN_INTERNAL_JOB_TOKEN = original;
  }
});
