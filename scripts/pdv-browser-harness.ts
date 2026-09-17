/** Isolated UI harness: tests intercept APIs; no application data is changed. */
import { createServer } from "node:http";
import { build } from "esbuild";

const assets = await build({
  entryPoints: ["tests/fixtures/pdv-browser-app.tsx"], bundle: true, write: false,
  outdir: "/tmp/nalven-pdv-browser-assets", jsx: "automatic", platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "pdv-next", setup(plugin) {
    plugin.onResolve({ filter: /^next\/(link|image)$/ }, args => ({ path: args.path, namespace: "pdv-next" }));
    plugin.onLoad({ filter: /.*/, namespace: "pdv-next" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents: args.path === "next/link"
      ? 'export default function Link({children,...props}) { return <a {...props}>{children}</a>; }'
      : 'export default function Image({unoptimized,priority,...props}) { return <img {...props}/>; }' }));
  } }],
});
const server = createServer((request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1:4186").pathname;
  response.setHeader("cache-control", "no-store");
  if (path.startsWith("/api/")) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "API não simulada no teste do PDV." }));
    return;
  }
  if (path === "/pdv.js" || path === "/pdv.css") {
    const extension = path.endsWith(".js") ? ".js" : ".css";
    response.setHeader("content-type", extension === ".js" ? "text/javascript" : "text/css");
    response.end(assets.outputFiles!.find(file => file.path.endsWith(extension))!.text);
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pdv.css"><title>PDV — teste isolado</title></head><body><div id="app"></div><script src="/pdv.js"></script></body></html>');
});
server.listen(4186, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
