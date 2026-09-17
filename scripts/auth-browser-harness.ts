/** Loopback-only frontend harness. No database, credentials, email delivery or
 * signup service is imported; browser tests intercept every authentication API.
 */
import { createServer } from "node:http";
import { build } from "esbuild";

const assets = await build({
  entryPoints: ["tests/fixtures/auth-browser-app.tsx"], bundle: true, write: false,
  outdir: "/tmp/nalven-auth-browser-assets", jsx: "automatic", platform: "browser",
  conditions: ["browser", "import", "style"],
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "auth-next-navigation", setup(plugin) {
    plugin.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "auth-next" }));
    plugin.onLoad({ filter: /.*/, namespace: "auth-next" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents: args.path === "next/link"
      ? 'import React from "react"; export default function Link({children,...props}) { return <a {...props}>{children}</a>; }'
      : 'export const usePathname = () => location.pathname; export const useRouter = () => ({replace(path) { history.replaceState({},"",path); window.dispatchEvent(new Event("auth-test-navigation")); }, refresh() {}});' }));
  } }],
});
const server = createServer((request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1:4180").pathname;
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  if (path.startsWith("/api/")) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Authentication API must be mocked by the browser test." }));
    return;
  }
  if (path === "/auth-app.js" || path === "/auth-app.css") {
    const extension = path.endsWith(".js") ? ".js" : ".css";
    response.setHeader("content-type", extension === ".js" ? "text/javascript" : "text/css");
    response.end(assets.outputFiles!.find(file => file.path.endsWith(extension))!.text);
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/auth-app.css"><title>Autenticação — teste isolado</title></head><body><div id="app"></div><script src="/auth-app.js"></script></body></html>');
});
server.listen(4180, "127.0.0.1", () => console.log("Auth browser harness: http://127.0.0.1:4180"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
