"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Warehouse = { id: number; code: string; name: string; primary: boolean };
type Product = { id: number; sku: string; name: string; manageStock: boolean; variations: Array<{ id: number; sku?: string | null; manageStock: string; attributes: unknown }> };
type Lot = {
  id: string; warehouseId: number; productId: number; variationId: number | null; lotCode: string | null; serialNumber: string | null;
  manufacturedOn: string | null; expiresOn: string | null; bucketKey: "sellable" | "quarantine"; status: string;
  quantity: number; reservedQuantity: number; receivedAt: string; movementCount: number;
  warehouse: { id: number; code: string; name: string }; product: { id: number; sku: string; name: string }; variation?: { id: number; sku?: string | null } | null;
};
type InventoryData = { branch: { id: number; name: string }; warehouses: Warehouse[]; products: Product[]; lots: Lot[] };

export function PdvInventoryAdmin({ branchId, onChanged }: { branchId: number; onChanged(): Promise<void> }) {
  const [data, setData] = useState<InventoryData | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>({});

  const load = useCallback(async () => {
    const parameters = new URLSearchParams({ branchId: String(branchId) });
    if (warehouseId) parameters.set("warehouseId", warehouseId);
    if (status) parameters.set("status", status);
    if (query.trim()) parameters.set("q", query.trim());
    setError("");
    try {
      const response = await fetch(`/api/erp/pdv/inventory?${parameters}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível consultar lotes e séries.");
      setData(body as InventoryData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar lotes e séries.");
    }
  }, [branchId, warehouseId, status, query]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function mutate(logicalId: string, payload: Record<string, unknown>, success: string) {
    if (busy) return false;
    const complete = { ...payload, branchId }, signature = JSON.stringify(complete);
    const current = attempts.current[logicalId], attempt = current?.signature === signature ? current : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/erp/pdv/inventory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...complete, idempotencyKey: attempt.key }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível movimentar o estoque rastreado.");
      delete attempts.current[logicalId];
      setNotice(success);
      await Promise.all([load(), onChanged()]);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível movimentar o estoque rastreado.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const catalog = useMemo(() => data?.products.flatMap(product => [
    ...(product.manageStock ? [{ value: `p:${product.id}`, label: `${product.name} · ${product.sku} (produto pai)` }] : []),
    ...product.variations.filter(variation => variation.manageStock === "true").map(variation => ({ value: `v:${product.id}:${variation.id}`, label: `${product.name} · ${variation.sku || `variação ${variation.id}`}` })),
  ]) || [], [data?.products]);

  return <section className="pos-admin-inventory" aria-label="Lotes, séries e validade">
    <header><div><h3>Lotes, séries e validade</h3><p>Recebimento e mudanças de estado append-only, com saldo agregado e ledger atômicos.</p></div></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {notice && <p className="tenant-success" role="status">{notice}</p>}
    {!data ? <p role="status">Carregando estoque rastreado…</p> : <>
      <form className="pos-admin-row" onSubmit={event => {
        event.preventDefault();
        const element = event.currentTarget, form = new FormData(element), selection = parseSelection(String(form.get("catalog") || ""));
        if (!selection) { setError("Selecione um produto ou variação com estoque próprio."); return; }
        const payload = {
          action: "inventory.receive", warehouseId: numberValue(form.get("warehouseId")), ...selection,
          lotCode: nullableText(form.get("lotCode")), serialNumber: nullableText(form.get("serialNumber")), quantity: decimalValue(form.get("quantity")),
          manufacturedOn: nullableText(form.get("manufacturedOn")), expiresOn: nullableText(form.get("expiresOn")), note: nullableText(form.get("note")),
        };
        void mutate("inventory.receive", payload, "Recebimento rastreado concluído.").then(ok => { if (ok) element.reset(); });
      }}>
        <strong>Receber/cadastrar</strong>
        <label>Depósito<select name="warehouseId" required disabled={busy}><option value="">Selecione</option>{data.warehouses.map(item => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</select></label>
        <label>Produto/variação<select name="catalog" required disabled={busy}><option value="">Selecione</option>{catalog.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label>Lote<input name="lotCode" maxLength={160} disabled={busy} /></label>
        <label>Série<input name="serialNumber" maxLength={200} disabled={busy} /></label>
        <label>Quantidade<input name="quantity" type="number" min="0.000001" max="999999" step="0.000001" required disabled={busy} /></label>
        <label>Fabricação<input name="manufacturedOn" type="date" disabled={busy} /></label>
        <label>Validade<input name="expiresOn" type="date" disabled={busy} /></label>
        <label>Referência<input name="note" maxLength={300} disabled={busy} placeholder="NF, recebimento, observação" /></label>
        <button className="primary" disabled={busy || !catalog.length || !data.warehouses.length}>Receber</button>
      </form>

      <form className="pos-admin-row" onSubmit={event => { event.preventDefault(); void load(); }}>
        <strong>Consultar</strong>
        <label>Depósito<select value={warehouseId} onChange={event => setWarehouseId(event.target.value)} disabled={busy}><option value="">Todos</option>{data.warehouses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Status<select value={status} onChange={event => setStatus(event.target.value)} disabled={busy}><option value="">Todos</option><option value="available">Disponível</option><option value="quarantine">Quarentena</option><option value="expired">Vencido</option><option value="blocked">Bloqueado</option><option value="depleted">Esgotado</option></select></label>
        <label>Busca<input value={query} onChange={event => setQuery(event.target.value)} maxLength={100} disabled={busy} placeholder="Produto, SKU, lote ou série" /></label>
        <button disabled={busy}>Atualizar</button>
      </form>

      <div className="pos-admin-list">{data.lots.map(lot => {
        const available = Math.max(0, lot.quantity - lot.reservedQuantity);
        return <article key={lot.id}>
          <header><div><h4>{lot.product.name}{lot.variation?.sku ? ` · ${lot.variation.sku}` : ""}</h4><small>{lot.serialNumber ? `Série ${lot.serialNumber}` : `Lote ${lot.lotCode}`} · {lot.warehouse.name} · bucket {lot.bucketKey} · {lot.status}</small></div><b>{formatQuantity(lot.quantity)} saldo físico · {formatQuantity(lot.reservedQuantity)} reservado · {formatQuantity(available)} disponível</b></header>
          <p>Fabricação {formatDate(lot.manufacturedOn)} · validade {formatDate(lot.expiresOn)} · recebido {new Date(lot.receivedAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })} · {lot.movementCount} movimentos</p>
          <div className="pos-admin-children">
            {lot.bucketKey === "sellable" && lot.status === "available" && available > 0 && <LotActionForm lot={lot} action="inventory.quarantine" label="Quarentenar" busy={busy} maximum={available} mutate={mutate} />}
            {lot.bucketKey === "quarantine" && lot.status === "quarantine" && available > 0 && <LotActionForm lot={lot} action="inventory.release" label="Liberar" busy={busy} maximum={available} mutate={mutate} />}
            {["available", "quarantine", "expired", "blocked"].includes(lot.status) && available > 0 && <LotActionForm lot={lot} action="inventory.discard" label="Descartar" busy={busy} maximum={available} mutate={mutate} destructive />}
          </div>
        </article>;
      })}{!data.lots.length && <p className="tenant-empty">Nenhum lote ou série encontrado.</p>}</div>
    </>}
  </section>;
}

function LotActionForm({ lot, action, label, busy, maximum, destructive, mutate }: { lot: Lot; action: "inventory.quarantine" | "inventory.release" | "inventory.discard"; label: string; busy: boolean; maximum: number; destructive?: boolean; mutate(logicalId: string, payload: Record<string, unknown>, success: string): Promise<boolean> }) {
  return <form className="pos-admin-row" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget), quantity = decimalValue(form.get("quantity")), reason = String(form.get("reason") || "").trim();
    if (destructive && !window.confirm(`Descartar ${formatQuantity(quantity)} de ${lot.serialNumber || lot.lotCode}? Esta movimentação não apaga o histórico.`)) return;
    void mutate(`${action}:${lot.id}`, { action, lotId: lot.id, quantity, reason }, action === "inventory.quarantine" ? "Saldo segregado em quarentena." : action === "inventory.release" ? "Saldo liberado para venda." : "Saldo descartado com histórico preservado.");
  }}><strong>{label}</strong><label>Quantidade<input name="quantity" type="number" min="0.000001" max={maximum} step="0.000001" defaultValue={lot.serialNumber ? 1 : maximum} required disabled={busy} /></label><label>Motivo<input name="reason" minLength={4} maxLength={300} required disabled={busy} /></label><button disabled={busy}>{label}</button></form>;
}

function parseSelection(value: string) {
  const parts = value.split(":");
  if (parts[0] === "p" && positive(parts[1])) return { productId: Number(parts[1]), variationId: null };
  if (parts[0] === "v" && positive(parts[1]) && positive(parts[2])) return { productId: Number(parts[1]), variationId: Number(parts[2]) };
  return null;
}
function positive(value?: string) { const result = Number(value); return Number.isSafeInteger(result) && result > 0; }
function numberValue(value: FormDataEntryValue | null) { return Number(value); }
function decimalValue(value: FormDataEntryValue | null) { return Number(String(value || "").replace(",", ".")); }
function nullableText(value: FormDataEntryValue | null) { const result = String(value || "").trim(); return result || null; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function formatDate(value: string | null) { return value ? new Date(`${value}T00:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "não informada"; }
function formatQuantity(value: number) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 }).format(value); }
async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } }
