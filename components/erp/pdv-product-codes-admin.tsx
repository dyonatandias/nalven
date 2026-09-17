"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Variation = { id: number; sku: string | null; gtin: string | null; attributes: unknown };
type Product = { id: number; name: string; sku: string; unit: string; variations: Variation[] };
type ProductCode = {
  id: number; productId: number; variationId: number | null; scope: "global" | "branch"; code: string; normalizedCode: string; symbology: string;
  packageQuantity: number; unit: string | null; packageLabel: string | null; priority: number; active: boolean;
  product: { name: string; sku: string; unit: string }; variation: { sku: string | null; attributes: unknown } | null;
};
type VariableRule = {
  id: string; branchId: number; name: string; status: string; prefix: string; totalLength: number; productCodeStart: number; productCodeLength: number;
  lookupSymbology: string; valueStart: number; valueLength: number; valueMode: "quantity" | "total_price"; valueScale: number;
  measurementUnit: string; checkDigitAlgorithm: "gtin" | "none"; priority: number;
};
type Data = { branchId: number; products: Product[]; codes: ProductCode[]; rules: VariableRule[] };
const symbologies = ["gtin", "ean13", "ean8", "upca", "code128", "code39", "qr", "plu", "sku", "internal", "unknown"];

export function PdvProductCodesAdmin({ branchId, onChanged }: { branchId: number; onChanged(): Promise<void> }) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/erp/pdv/product-codes?branchId=${branchId}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível carregar códigos e regras.");
      setData(body as Data);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar códigos e regras."); }
  }, [branchId]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void load()); return () => window.cancelAnimationFrame(frame); }, [load]);

  async function mutate(logicalId: string, payload: Record<string, unknown>, success: string) {
    if (busy) return false;
    const signature = JSON.stringify(payload), current = attempts.current[logicalId];
    const attempt = current?.signature === signature ? current : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/erp/pdv/product-codes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível salvar o cadastro.");
      delete attempts.current[logicalId];
      setNotice(success);
      await Promise.all([load(), onChanged()]);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar o cadastro.");
      return false;
    } finally { setBusy(false); }
  }

  if (!data) return <section className="pos-admin-create"><h3>Códigos, embalagens e PLU</h3><p>{error || "Carregando códigos…"}</p></section>;
  return <section className="pos-value-admin" aria-labelledby="pos-product-code-admin-title">
    <header><div><h3 id="pos-product-code-admin-title">Códigos, embalagens e etiquetas variáveis</h3><p>O servidor reaplica escopo, multiplicador e regra PLU ao cotar e concluir a venda. Drivers de balança e homologação de hardware permanecem externos.</p></div></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {notice && <p className="tenant-success" role="status">{notice}</p>}
    <CodeForm branchId={branchId} products={data.products} busy={busy} onSubmit={payload => mutate("product_code.create", { action: "product_code.create", ...payload }, "Código cadastrado.")} />
    <div className="pos-admin-list">{data.codes.map(code => <article key={code.id}><header><div><h4>{code.code} · {code.product.name}</h4><small>{code.symbology} · {code.scope} · ×{formatNumber(code.packageQuantity)} {code.unit || code.product.unit}{code.packageLabel ? ` · ${code.packageLabel}` : ""} · {code.active ? "ativo" : "inativo"}</small></div>{code.active && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Desativar o código ${code.code}? Novas leituras deixarão de resolver.`)) void mutate(`product_code.deactivate:${code.id}`, { action: "product_code.deactivate", branchId, codeId: code.id }, "Código desativado."); }}>Desativar</button>}</header>
      {code.active && <CodeForm branchId={branchId} products={data.products} busy={busy} code={code} onSubmit={payload => mutate(`product_code.update:${code.id}`, { action: "product_code.update", codeId: code.id, ...payload }, "Código atualizado.")} />}
    </article>)}</div>

    <RuleForm branchId={branchId} busy={busy} onSubmit={payload => mutate("variable_code_rule.create", { action: "variable_code_rule.create", ...payload }, "Regra variável criada.")} />
    <div className="pos-admin-list">{data.rules.map(rule => <article key={rule.id}><header><div><h4>{rule.name} · prefixo {rule.prefix}</h4><small>{rule.valueMode === "quantity" ? "quantidade" : "preço total"} ÷ {rule.valueScale} · PLU [{rule.productCodeStart}..{rule.productCodeStart + rule.productCodeLength - 1}] · valor [{rule.valueStart}..{rule.valueStart + rule.valueLength - 1}] · {rule.status}</small></div>{rule.status === "active" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Desativar a regra ${rule.name}? Etiquetas dependentes deixarão de resolver.`)) void mutate(`variable_code_rule.deactivate:${rule.id}`, { action: "variable_code_rule.deactivate", branchId, ruleId: rule.id }, "Regra desativada."); }}>Desativar</button>}</header>
      {rule.status === "active" && <RuleForm branchId={branchId} busy={busy} rule={rule} onSubmit={payload => mutate(`variable_code_rule.update:${rule.id}`, { action: "variable_code_rule.update", ruleId: rule.id, ...payload }, "Regra atualizada.")} />}
    </article>)}</div>
  </section>;
}

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;

function CodeForm({ branchId, products, code, busy, onSubmit }: { branchId: number; products: Product[]; code?: ProductCode; busy: boolean; onSubmit: Submit }) {
  const [productId, setProductId] = useState(code?.productId || products[0]?.id || 0);
  const product = products.find(item => item.id === productId);
  return <form className="pos-admin-row" onSubmit={event => { event.preventDefault(); const element = event.currentTarget, form = new FormData(element); void onSubmit({
    branchId, productId, variationId: nullableInteger(form.get("variationId")), scope: form.get("scope"), code: form.get("code"), symbology: form.get("symbology"),
    packageQuantity: decimal(form.get("packageQuantity")), unit: nullableText(form.get("unit")), packageLabel: nullableText(form.get("packageLabel")), priority: integer(form.get("priority")),
  }).then(ok => { if (ok && !code) element.reset(); }); }}>
    <strong>{code ? "Editar código" : "Novo código"}</strong>
    <label>Produto<select name="productId" value={productId || ""} onChange={event => setProductId(Number(event.target.value))} required disabled={busy}>{products.map(item => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}</select></label>
    <label>Variação<select key={productId} name="variationId" defaultValue={code?.productId === productId ? code.variationId || "" : ""} disabled={busy}><option value="">Produto principal</option>{product?.variations.map(variation => <option key={variation.id} value={variation.id}>{variation.sku || variation.gtin || `Variação ${variation.id}`}</option>)}</select></label>
    <label>Escopo<select name="scope" defaultValue={code?.scope || "branch"} disabled={busy}><option value="branch">Esta filial</option><option value="global">Toda organização</option></select></label>
    <label>Código<input name="code" defaultValue={code?.code || ""} maxLength={256} required disabled={busy} /></label>
    <label>Simbologia<select name="symbology" defaultValue={code?.symbology || "internal"} disabled={busy}>{symbologies.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>Multiplicador<input name="packageQuantity" type="number" min="0.001" max="999999" step="0.001" defaultValue={code?.packageQuantity || 1} required disabled={busy} /></label>
    <label>Unidade<input name="unit" defaultValue={code?.unit || product?.unit || "UN"} maxLength={20} disabled={busy} /></label>
    <label>Embalagem<input name="packageLabel" defaultValue={code?.packageLabel || ""} placeholder="Caixa com 12" maxLength={80} disabled={busy} /></label>
    <label>Prioridade<input name="priority" type="number" min="-1000" max="1000" step="1" defaultValue={code?.priority || 0} required disabled={busy} /></label>
    <button className={!code ? "primary" : undefined} disabled={busy || !products.length}>{code ? "Salvar código" : "Cadastrar código"}</button>
  </form>;
}

function RuleForm({ branchId, rule, busy, onSubmit }: { branchId: number; rule?: VariableRule; busy: boolean; onSubmit: Submit }) {
  return <form className="pos-admin-row" onSubmit={event => { event.preventDefault(); const element = event.currentTarget, form = new FormData(element); void onSubmit({
    branchId, name: form.get("name"), prefix: form.get("prefix"), totalLength: integer(form.get("totalLength")), productCodeStart: integer(form.get("productCodeStart")),
    productCodeLength: integer(form.get("productCodeLength")), lookupSymbology: form.get("lookupSymbology"), valueStart: integer(form.get("valueStart")), valueLength: integer(form.get("valueLength")),
    valueMode: form.get("valueMode"), valueScale: integer(form.get("valueScale")), measurementUnit: form.get("measurementUnit"), checkDigitAlgorithm: form.get("checkDigitAlgorithm"), priority: integer(form.get("priority")),
  }).then(ok => { if (ok && !rule) element.reset(); }); }}>
    <strong>{rule ? "Editar regra variável" : "Nova regra de etiqueta/PLU"}</strong>
    <label>Nome<input name="name" defaultValue={rule?.name || ""} minLength={2} maxLength={160} required disabled={busy} /></label>
    <label>Prefixo<input name="prefix" defaultValue={rule?.prefix || "20"} pattern="[0-9]{1,12}" required disabled={busy} /></label>
    <label>Tamanho total<input name="totalLength" type="number" min="4" max="64" defaultValue={rule?.totalLength || 13} required disabled={busy} /></label>
    <label>Início PLU (base 0)<input name="productCodeStart" type="number" min="0" max="63" defaultValue={rule?.productCodeStart ?? 2} required disabled={busy} /></label>
    <label>Tamanho PLU<input name="productCodeLength" type="number" min="1" max="20" defaultValue={rule?.productCodeLength || 5} required disabled={busy} /></label>
    <label>Simbologia PLU<select name="lookupSymbology" defaultValue={rule?.lookupSymbology || "plu"} disabled={busy}><option value="plu">plu</option><option value="sku">sku</option><option value="internal">internal</option></select></label>
    <label>Início valor (base 0)<input name="valueStart" type="number" min="0" max="63" defaultValue={rule?.valueStart ?? 7} required disabled={busy} /></label>
    <label>Tamanho valor<input name="valueLength" type="number" min="1" max="20" defaultValue={rule?.valueLength || 5} required disabled={busy} /></label>
    <label>Conteúdo<select name="valueMode" defaultValue={rule?.valueMode || "quantity"} disabled={busy}><option value="quantity">Quantidade</option><option value="total_price">Preço total em centavos</option></select></label>
    <label>Divisor<select name="valueScale" defaultValue={rule?.valueScale || 1000} disabled={busy}><option value="1">1</option><option value="10">10</option><option value="100">100</option><option value="1000">1000</option></select></label>
    <label>Unidade medida<input name="measurementUnit" defaultValue={rule?.measurementUnit || "KG"} maxLength={20} required disabled={busy} /></label>
    <label>Dígito verificador<select name="checkDigitAlgorithm" defaultValue={rule?.checkDigitAlgorithm || "gtin"} disabled={busy}><option value="gtin">GTIN/EAN</option><option value="none">Sem validação</option></select></label>
    <label>Prioridade<input name="priority" type="number" min="-1000" max="1000" defaultValue={rule?.priority || 0} required disabled={busy} /></label>
    <button className={!rule ? "primary" : undefined} disabled={busy}>{rule ? "Salvar regra" : "Criar regra"}</button>
  </form>;
}

async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function nullableText(value: FormDataEntryValue | null) { const result = String(value || "").trim(); return result || null; }
function integer(value: FormDataEntryValue | null) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Informe um número inteiro válido."); return result; }
function nullableInteger(value: FormDataEntryValue | null) { return value == null || value === "" ? null : integer(value); }
function decimal(value: FormDataEntryValue | null) { const result = Number(value); if (!Number.isFinite(result)) throw new Error("Informe um multiplicador válido."); return result; }
function formatNumber(value: number) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(value); }
