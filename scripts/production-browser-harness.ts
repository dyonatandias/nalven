/** Local browser verification against the actual production UI and transaction services.
 * This server runs only on loopback and only against the explicitly isolated test cluster.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { productionRead } from "../lib/erp/production-query";
import { executeProductionCommand } from "../lib/erp/production-service";
import { safeJson } from "../lib/erp/production-domain";
import { purchaseOrderDetailInclude, receivePurchaseOrder } from "../lib/erp/purchase-receiving";

const socket = process.env.PRODUCTION_TEST_SOCKET;
if (!socket?.startsWith("/tmp/nalven-production-pg."))
  throw new Error("An isolated test cluster is required.");
const db = new PrismaClient({
  adapter: new PrismaPg({
    host: socket,
    port: 55439,
    database: "production_test",
    user: "nalven",
  }),
});
const actor = { id: "browser-test", name: "Operador de teste" };
async function seed() {
  const token = randomUUID().slice(0, 8);
  const branch = await db.branch.create({
    data: {
      code: `BROWSER-${token}`,
      name: "Unidade demonstração",
      legalName: "Produção demonstração",
      document: `BROWSER-${token}`,
    },
  });
  const warehouse = await db.warehouse.create({
    data: {
      code: `BROWSER-${token}`,
      name: "Depósito de produção",
      branchId: branch.id,
    },
  });
  const material = await db.product.create({
    data: {
      name: "Tecido algodão · cru",
      slug: `tecido-${token}`,
      sku: `TEC-${token}`,
      category: "Produção",
      manageStock: true,
      stock: 1000,
      cost: 12.5,
      unit: "m",
    },
  });
  const output = await db.product.create({
    data: {
      name: "Kit de camisetas · coleção essencial",
      slug: `kit-${token}`,
      sku: `KIT-${token}`,
      category: "Produção",
      manageStock: true,
      unit: "un",
    },
  });
  await db.warehouseBalance.create({
    data: { warehouseId: warehouse.id, productId: material.id, quantity: 1000 },
  });
  const call = async (body: Record<string, unknown>) =>
    (await executeProductionCommand(
      db,
      { ...body, idempotencyKey: randomUUID() },
      actor,
    )) as Record<string, unknown>;
  const bom = await call({
    action: "bom.create",
    snapshot: {
      name: "Kit essencial — ficha de corte e montagem",
      code: `ESS-${token}`,
      outputProductId: output.id,
      yieldQuantity: 1,
      items: [{ productId: material.id, quantity: 2, wastePercent: 5 }],
      laborHourlyCents: 2500,
      machineHourlyCents: 1500,
      energyBatchCents: 100,
      overheadBatchCents: 200,
      checklist: [
        "Dimensões conferidas",
        "Costuras conferidas",
        "Embalagem íntegra",
      ],
    },
  });
  await call({ action: "bom.approve", revisionId: bom.revisionId });
  for (let i = 0; i < 6; i++) {
    const created = await call({
      action: "order.create",
      bomId: bom.bomId,
      warehouseId: warehouse.id,
      plannedQuantity: 10 + i * 5,
      priority: i === 0 ? "urgent" : i === 1 ? "high" : "normal",
      assignedTo: i % 2 ? "Equipe de montagem" : "Equipe de corte",
      tags: ["coleção essencial", i % 2 ? "reposição" : "atacado"],
      dueAt: `2026-09-${String(12 + i).padStart(2, "0")}`,
      notes:
        i === 0 ? "Conferir a composição antes de liberar para o cliente." : "",
    });
    if (i > 1)
      await call({
        action: "order.transition",
        orderId: created.orderId,
        version: 0,
        status: "in_progress",
      });
    if (i === 3)
      await call({
        action: "order.transition",
        orderId: created.orderId,
        version: 1,
        status: "paused",
      });
  }
  const supplier = await db.supplier.create({ data: { name: "Fornecedor de teste", document: randomUUID() } });
  return { bomId: bom.bomId, warehouseId: warehouse.id, materialId: material.id, supplierId: supplier.id, token };
}
async function main() {
  const fixture = await seed();
  const assets = await build({
    entryPoints: ["tests/fixtures/production-browser-app.tsx"],
    bundle: true,
    write: false,
    outdir: "/tmp/nalven-production-assets",
    jsx: "automatic",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const js = assets.outputFiles!.find((file) =>
    file.path.endsWith(".js"),
  )!.text;
  const css = assets.outputFiles!.find((file) =>
    file.path.endsWith(".css"),
  )!.text;
  const shellAssets = await build({
    entryPoints: ["tests/fixtures/erp-shell-browser-app.tsx"], bundle: true, write: false,
    conditions: ["browser", "import", "style"],
    outdir: "/tmp/nalven-shell-assets", jsx: "automatic", platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "test-next-navigation", setup(plugin) {
      // Server-only branches in shared validation modules must never execute here.
      plugin.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "node:crypto", namespace: "test-crypto" }));
      plugin.onLoad({ filter: /.*/, namespace: "test-crypto" }, () => ({ contents: 'export const randomUUID = () => crypto.randomUUID(); export const createHash = () => { throw new Error("Server hashing invoked by browser fixture"); };', loader: "js" }));
      plugin.onResolve({ filter: /^next\/(link|navigation|image)$/ }, args => ({ path: args.path, namespace: "test-next" }));
      plugin.onLoad({ filter: /.*/, namespace: "test-next" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents: args.path === "next/link"
        ? `import React from "react"; export default function Link({href,onClick,children,...props}) { return <a {...props} href={href} onClick={event => { onClick?.(event); if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); history.pushState({},"",href); } }}>{children}</a>; }`
        : args.path === "next/image" ? `import React from "react"; export default function Image({fill,priority,unoptimized,...props}) { return <img {...props} />; }`
        : `export const useRouter = () => ({prefetch() {},replace(path) {history.replaceState({},"",path);},push(path) {history.pushState({},"",path);},refresh() {}}); export const usePathname = () => location.pathname; export const useSearchParams = () => new URLSearchParams(location.search);` }));
    } }],
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1:4179");
    if (url.pathname === "/favicon.svg") {
      response.setHeader("content-type", "image/svg+xml");
      response.end(await readFile("public/favicon.svg"));
      return;
    }
    if (url.pathname === "/shell.js" || url.pathname === "/shell.css") {
      const extension = url.pathname.endsWith(".js") ? ".js" : ".css";
      response.setHeader("content-type", extension === ".js" ? "text/javascript" : "text/css");
      response.end(shellAssets.outputFiles!.find(file => file.path.endsWith(extension))!.text);
      return;
    }
    if (url.pathname === "/__shell") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><style>body{margin:0;font:14px system-ui,sans-serif}*{box-sizing:border-box}</style><title>Menu ERP — teste isolado</title></head><body><div id="app"></div><script src="/shell.js"></script></body></html>');
      return;
    }
    if (url.pathname === "/__fixture") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(fixture));
      return;
    }
    if (url.pathname === "/app.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(js);
      return;
    }
    if (url.pathname === "/app.css") {
      response.setHeader("content-type", "text/css");
      response.end(css);
      return;
    }
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Produção — verificação local</title><style>body{margin:0;background:#f3f6f4;font:14px system-ui,sans-serif}#app{max-width:1720px;margin:auto;padding:24px;box-sizing:border-box}@media(max-width:700px){#app{padding:12px}}</style></head><body><main id="app"></main><script src="/app.js"></script></body></html>',
      );
      return;
    }
    const purchaseMatch = url.pathname.match(/^\/api\/erp\/purchases\/(\d+)$/);
    if (url.pathname !== "/api/erp/production/operations" && !purchaseMatch) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    try {
      if (request.method === "GET") {
        if (purchaseMatch) {
          const order = await db.purchaseOrder.findUniqueOrThrow({ where: { id: Number(purchaseMatch[1]) }, include: purchaseOrderDetailInclude });
          const warehouses = await db.warehouse.findMany({ where: { id: fixture.warehouseId }, select: { id: true, name: true } });
          response.end(JSON.stringify(safeJson({ order, warehouses })));
          return;
        }
        response.end(
          JSON.stringify(safeJson(await productionRead(db, url.searchParams))),
        );
        return;
      }
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 1_000_000) throw new Error("Request too large");
      }
      const body = JSON.parse(raw);
      // Test-only submission uses this disposable database, never the production route.
      const result = purchaseMatch
        ? body.action === "submit"
          ? await db.purchaseOrder.update({ where: { id: Number(purchaseMatch[1]), status: "draft" }, data: { status: "ordered" } })
          : await receivePurchaseOrder(db, Number(purchaseMatch[1]), body, actor, fixture.warehouseId)
        : await executeProductionCommand(db, body, actor);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 400;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Falha",
        }),
      );
    }
  });
  server.listen(4179, "127.0.0.1", () =>
    console.log("Production browser harness ready at http://127.0.0.1:4179"),
  );
  const close = () =>
    server.close(() => void db.$disconnect().finally(() => process.exit(0)));
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
main().catch((error) => {
  console.error(error);
  void db.$disconnect();
  process.exitCode = 1;
});
