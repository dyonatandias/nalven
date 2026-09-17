"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useRef, useState } from "react";

type Product = { id: number; name: string; sku: string; type: string; unit: string; variations: Array<{ id: number; sku: string | null; attributes: unknown }> };
type Component = { productId: number; variationId: number | null; quantity: number; product?: { name: string; sku: string; unit: string }; variation?: { sku: string | null } | null };
type Bom = { id: string; kitProductId: number; kitVariationId: number | null; version: number; name: string; status: string; effectiveFrom: string | null; components: Component[]; updatedAt: string };
type Data = { products: Product[]; boms: Bom[] };
type DraftLine = { key: string; target: string; quantity: string };

export function PdvKitsAdmin({ branchId, onChanged }: { branchId: number; onChanged(): Promise<void> }) {
  const [data, setData] = useState<Data | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null), [kitTarget, setKitTarget] = useState(""), [name, setName] = useState(""), [effectiveFrom, setEffectiveFrom] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ key: crypto.randomUUID(), target: "", quantity: "1" }]);
  const attempts = useRef<Record<string, { signature: string; key: string }>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/erp/pdv/kits?branchId=${branchId}`, { cache: "no-store" }), body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível carregar as composições.");
      setData(body as unknown as Data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as composições."); }
  }, [branchId]);
  useEffect(() => { const frame = requestAnimationFrame(() => void load()); return () => cancelAnimationFrame(frame); }, [load]);

  async function mutate(logicalId: string, payload: Record<string, unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    const signature = JSON.stringify(payload), prior = attempts.current[logicalId], idempotencyKey = prior?.signature === signature ? prior.key : `kit:${logicalId}:${crypto.randomUUID()}`;
    attempts.current[logicalId] = { signature, key: idempotencyKey };
    try {
      const response = await fetch("/api/erp/pdv/kits", { method: "POST", headers: { "content-type": "application/json", "x-pos-request": "1" }, body: JSON.stringify({ ...payload, idempotencyKey }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível alterar a composição.");
      delete attempts.current[logicalId]; setNotice(success); await Promise.all([load(), onChanged()]); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a composição."); return false; }
    finally { setBusy(false); }
  }

  function resetDraft() { setEditingId(null); setKitTarget(""); setName(""); setEffectiveFrom(""); setLines([{ key: crypto.randomUUID(), target: "", quantity: "1" }]); }
  function edit(bom: Bom) {
    setEditingId(bom.id); setKitTarget(targetValue(bom.kitProductId, bom.kitVariationId)); setName(bom.name); setEffectiveFrom(toLocalInput(bom.effectiveFrom));
    setLines(bom.components.map(component => ({ key: crypto.randomUUID(), target: targetValue(component.productId, component.variationId), quantity: String(component.quantity) })));
  }
  async function save() {
    const target = parseTarget(kitTarget), components = lines.map(line => ({ ...parseTarget(line.target), quantity: Number(line.quantity) }));
    if (!target || components.some(component => !component || !Number.isFinite(component.quantity) || component.quantity <= 0)) { setError("Informe kit, componentes e quantidades válidos."); return; }
    const payload = { action: editingId ? "kit.update" : "kit.create", branchId, ...(editingId ? { bomId: editingId } : {}), kitProductId: target.productId, kitVariationId: target.variationId, name, effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : null, components };
    if (await mutate(editingId ? `update:${editingId}` : "create", payload, editingId ? "Rascunho atualizado." : "Nova versão criada em rascunho.")) resetDraft();
  }

  const targets = data ? productTargets(data.products) : [];
  return <section className="pos-admin-create" aria-label="Composição de kits">
    <h3>Kits e componentes</h3><p>A venda mantém o preço do kit; o servidor expande e baixa os componentes do depósito. Versões ativadas ficam imutáveis para auditoria.</p>
    {error && <p className="tenant-error" role="alert">{error}</p>}{notice && <p className="tenant-success" role="status">{notice}</p>}
    <div className="pos-admin-row">
      <label>Produto kit<select value={kitTarget} onChange={event => setKitTarget(event.target.value)} disabled={busy || Boolean(editingId)}><option value="">Selecione</option>{targets.filter(target => target.product.type === "kit").map(target => <option key={target.value} value={target.value}>{target.label}</option>)}</select></label>
      <label>Nome da versão<input value={name} onChange={event => setName(event.target.value)} maxLength={160} disabled={busy} /></label>
      <label>Vigência<input type="datetime-local" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} disabled={busy} /></label>
      {editingId && <button type="button" onClick={resetDraft} disabled={busy}>Cancelar edição</button>}
    </div>
    {lines.map((line, index) => <div className="pos-admin-row" key={line.key}>
      <strong>Componente {index + 1}</strong><label>Produto/variação<select value={line.target} onChange={event => setLines(current => current.map(item => item.key === line.key ? { ...item, target: event.target.value } : item))} disabled={busy}><option value="">Selecione</option>{targets.map(target => <option key={target.value} value={target.value}>{target.label}</option>)}</select></label>
      <label>Qtd. por kit<input type="number" min="0.000001" max="9007199254" step="0.000001" value={line.quantity} onChange={event => setLines(current => current.map(item => item.key === line.key ? { ...item, quantity: event.target.value } : item))} disabled={busy} /></label>
      <button type="button" disabled={busy || lines.length === 1} onClick={() => setLines(current => current.filter(item => item.key !== line.key))}>Remover</button>
    </div>)}
    <div className="pos-admin-row"><button type="button" onClick={() => setLines(current => [...current, { key: crypto.randomUUID(), target: "", quantity: "1" }])} disabled={busy || lines.length >= 100}>Adicionar componente</button><button type="button" className="primary" onClick={() => void save()} disabled={busy || !kitTarget || !name.trim()}>Salvar rascunho</button></div>
    <div className="pos-admin-list">{data?.boms.map(bom => <article key={bom.id}><header><div><h3>{bom.name}</h3><small>v{bom.version} · {bom.status} · {bom.components.length} componentes{bom.effectiveFrom ? ` · vigente em ${new Date(bom.effectiveFrom).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}` : ""}</small></div><div>{bom.status === "draft" && <><button type="button" disabled={busy} onClick={() => edit(bom)}>Editar</button><button type="button" disabled={busy} onClick={() => void mutate(`activate:${bom.id}`, { action: "kit.activate", branchId, bomId: bom.id }, "Versão ativada; a anterior foi preservada como retirada.")}>Ativar</button></>}{bom.status === "active" && <button type="button" disabled={busy} onClick={() => { if (confirm(`Desativar ${bom.name}? O produto kit ficará indisponível se não houver outra composição ativa.`)) void mutate(`retire:${bom.id}`, { action: "kit.retire", branchId, bomId: bom.id }, "Composição retirada de vigência."); }}>Desativar</button>}</div></header><p>{bom.components.map(component => `${component.product?.name || component.productId}${component.variation?.sku ? ` (${component.variation.sku})` : ""} × ${component.quantity}`).join(" · ")}</p></article>)}</div>
  </section>;
}

function productTargets(products: Product[]) { return products.flatMap(product => [{ value: targetValue(product.id, null), label: `${product.name} · ${product.sku}`, product }, ...product.variations.map(variation => ({ value: targetValue(product.id, variation.id), label: `${product.name} · ${variation.sku || `variação ${variation.id}`}`, product }))]); }
function targetValue(productId: number, variationId: number | null) { return `${productId}:${variationId ?? 0}`; }
function parseTarget(value: string) { const [productId, variationId] = value.split(":").map(Number); return Number.isSafeInteger(productId) && productId > 0 && Number.isSafeInteger(variationId) && variationId >= 0 ? { productId, variationId: variationId || null } : null; }
function toLocalInput(value: string | null) { if (!value) return ""; const date = new Date(value), offset = date.getTimezoneOffset() * 60_000; return new Date(date.valueOf() - offset).toISOString().slice(0, 16); }
async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
