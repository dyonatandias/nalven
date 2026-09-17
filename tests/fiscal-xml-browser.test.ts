import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

test("XML abre como texto seguro em desktop e celular e fecha com Escape", async () => {
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {useState} from 'react'; import {FiscalXmlViewer} from './components/erp/fiscal-xml-viewer'; function App(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Visualizar XML</button>{open&&<FiscalXmlViewer documentId={12} close={()=>setOpen(false)}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, outfile: "/tmp/fiscal-viewer.js", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const javascript = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) { response.setHeader("content-type", "application/xml"); response.end('<NFSe><emit><xNome>Fornecedor teste</xNome></emit><script>window.xmlExecuted=true</script></NFSe>'); }
    else if (request.url === "/app.js") { response.setHeader("content-type", "text/javascript"); response.end(javascript); }
    else { response.setHeader("content-type", "text/html"); response.end(`<html><head><style>${css}.erp-modal-layer{position:fixed;inset:0;display:grid;place-items:center;background:#0008}.modal-close-area{display:none}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server unavailable");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: "Visualizar XML", exact: true }).click();
      await page.getByLabel("Conteúdo XML").waitFor();
      assert.match(await page.getByLabel("Conteúdo XML").innerText(), /Fornecedor teste/);
      assert.equal(await page.evaluate(() => "xmlExecuted" in window), false);
      assert.equal(await page.getByRole("link", { name: "Baixar original" }).count(), 1);
      const box = await page.getByLabel("Conteúdo XML").boundingBox();
      assert.ok(box && box.width <= width);
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
