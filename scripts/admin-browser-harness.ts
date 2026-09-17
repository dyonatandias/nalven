/** Loopback-only frontend harness. Every API is mocked by Playwright: no
 * production credentials, database, e-mails, tickets or uploads are used. */
import { createServer } from "node:http";
import { build } from "esbuild";

const assets = await build({
  entryPoints: { "admin-app": "tests/fixtures/admin-browser-app.tsx" },
  bundle: true, write: false, outdir: "/tmp/nalven-admin-browser-assets", jsx: "automatic", platform: "browser",
  conditions: ["browser", "import", "style"], define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "admin-next-adapters", setup(plugin) {
    plugin.onResolve({ filter: /^next\/(link|navigation|image)$/ }, args => ({ path: args.path, namespace: "admin-next" }));
    plugin.onLoad({ filter: /.*/, namespace: "admin-next" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents:
      args.path === "next/image" ? 'import React from "react"; export default function Image({priority,fill,unoptimized,...props}) { return <img {...props}/>; }' :
      args.path === "next/link" ? 'import React from "react"; export default function Link({children,scroll,prefetch,replace,onClick,...props}) { return <a {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||props.target==="_blank")return;event.preventDefault();history[replace?"replaceState":"pushState"]({},"",props.href);window.dispatchEvent(new Event("portal-test-navigation"));}}>{children}</a>; }' :
      'export const usePathname=()=>location.pathname; export const useSearchParams=()=>new URLSearchParams(location.search); export const useRouter=()=>({push(path){history.pushState({},"",path);window.dispatchEvent(new Event("portal-test-navigation"));},replace(path){history.replaceState({},"",path);window.dispatchEvent(new Event("portal-test-navigation"));},refresh(){},prefetch(){}});'
    }));
  } }],
});
const server = createServer((request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1:4184").pathname;
  response.setHeader("cache-control", "no-store"); response.setHeader("referrer-policy", "no-referrer");
  if (path.startsWith("/api/")) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Admin API must be mocked explicitly by browser tests." })); return; }
  const asset = assets.outputFiles!.find(file => path === `/${file.path.split("/").at(-1)}`);
  if (asset) { response.setHeader("content-type", path.endsWith(".css") ? "text/css" : "text/javascript"); response.end(asset.text); return; }
  const entry = "admin-app";
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/${entry}.css"><title>Suporte — teste isolado</title></head><body><div id="app"></div><script src="/${entry}.js"></script></body></html>`);
});
server.listen(4184, "127.0.0.1", () => console.log("Admin browser harness: http://127.0.0.1:4184"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
