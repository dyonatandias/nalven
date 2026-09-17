"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const fields = [
  ["settlementId", "Liquidação", "settlement_id"], ["transactionId", "Transação", "transaction_id"], ["kind", "Tipo", "kind"],
  ["grossCents", "Bruto", "gross_cents"], ["feeCents", "Taxa", "fee_cents"], ["netCents", "Líquido", "net_cents"],
  ["occurredAt", "Ocorrência", "occurred_at"], ["settledAt", "Liquidação em", "settled_at"],
] as const;

type Layout = { id: string; provider: string; name: string; status: string; version: number; delimiter: string; amountMode: string; decimalSeparator: string; dateMode: string; matchWindowHours: number };
type Batch = { id: string; provider: string; status: string; version: number; rowCount: number; matchedCount: number; issueCount: number; productionBlocking: boolean; totals: { grossCents: string; feeCents: string; netCents: string }; periodStart: string; periodEnd: string; createdAt: string; layoutName: string; latestRun: { issueCodes: Record<string, number>; issueDetailsTruncated: boolean } | null };
type Report = { generatedAt: string; summary: { pending: number; currentIssueCount: number; issueHistory: Array<{ code: string; count: number }>; byProvider: Array<{ provider: string; batchCount: number; netCents: string; issueCount: number }> }; layouts: Layout[]; batches: Batch[] };

export function PdvReconciliationAdmin({ branchId }: { branchId: number }) {
  const [report, setReport] = useState<Report | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/erp/pdv/reconciliation?branchId=${branchId}&limit=25`, { cache: "no-store" }), body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível carregar a conciliação.");
      setReport((body.report || null) as Report | null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar a conciliação."); }
  }, [branchId]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void load()); return () => window.cancelAnimationFrame(frame); }, [load]);

  async function command(logicalId: string, payload: Record<string, unknown>, success: string) {
    if (busy) return false;
    const signature = JSON.stringify(payload), previous = attempts.current[logicalId], attempt = previous?.signature === signature ? previous : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/erp/pdv/reconciliation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível concluir a conciliação.");
      delete attempts.current[logicalId]; setNotice(success); await load(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a conciliação."); return false; }
    finally { setBusy(false); }
  }

  async function createLayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget, form = new FormData(element), columns = Object.fromEntries(fields.map(([key]) => [key, form.get(`column.${key}`)]));
    const kindMapping = { payment: aliases(form.get("paymentKinds")), refund: aliases(form.get("refundKinds")), chargeback: aliases(form.get("chargebackKinds")) };
    const ok = await command("layout.create", {
      action: "layout.create", branchId, provider: form.get("provider"), name: form.get("name"), delimiter: form.get("delimiter"), amountMode: form.get("amountMode"), decimalSeparator: form.get("decimalSeparator"), dateMode: form.get("dateMode"), matchWindowHours: Number(form.get("matchWindowHours")), columns, kindMapping,
    }, "Layout criado.");
    if (ok) element.reset();
  }

  async function importBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget, form = new FormData(element), file = form.get("file");
    if (!(file instanceof File) || file.size < 1 || file.size > 768 * 1024) { setError("Selecione um CSV de até 768 KiB."); return; }
    const ok = await command(`batch.import:${form.get("layoutId")}:${file.size}`, { action: "batch.import", branchId, layoutId: form.get("layoutId"), csv: await file.text() }, "Arquivo importado e confrontado.");
    if (ok) element.reset();
  }

  if (!report) return <section className="pos-admin-create"><h3>Conciliação de adquirentes</h3><p role="status">{error || "Carregando lotes e layouts…"}</p></section>;
  const activeLayouts = report.layouts.filter(layout => layout.status === "active");
  return <section className="pos-admin-list" aria-label="Conciliação de adquirentes">
    <header><div><h3>Conciliação de adquirentes</h3><small>Lotes persistentes, reprocessamento CAS e referências externas mascaradas</small></div><a href={`/api/erp/pdv/reconciliation?branchId=${branchId}&limit=50&format=csv`} download>Relatório CSV</a></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}{notice && <p className="tenant-success" role="status">{notice}</p>}
    <div className="pos-admin-row"><span>Pendentes: <strong>{report.summary.pending}</strong></span><span>Layouts: <strong>{activeLayouts.length}</strong></span><span>Lotes: <strong>{report.batches.length}</strong></span><span>Issues atuais: <strong>{report.summary.currentIssueCount}</strong></span></div>

    <details><summary>Novo layout de arquivo</summary><form className="pos-admin-row" onSubmit={createLayout}>
      <label>Nome<input name="name" required minLength={2} maxLength={120} disabled={busy} /></label><label>Provider<input name="provider" required pattern="[a-z0-9][a-z0-9._-]+" maxLength={80} disabled={busy} /></label>
      <label>Delimitador<select name="delimiter" defaultValue="," disabled={busy}><option value=",">Vírgula</option><option value=";">Ponto e vírgula</option><option value={"\t"}>Tab</option></select></label>
      <label>Valores<select name="amountMode" defaultValue="integer_cents" disabled={busy}><option value="integer_cents">Centavos inteiros</option><option value="decimal">Decimal</option></select></label>
      <label>Decimal<select name="decimalSeparator" defaultValue="." disabled={busy}><option value=".">Ponto</option><option value=",">Vírgula</option></select></label>
      <label>Datas<select name="dateMode" defaultValue="iso8601" disabled={busy}><option value="iso8601">ISO-8601 UTC</option><option value="epoch_millis">Epoch em ms</option></select></label>
      <label>Janela (h)<input name="matchWindowHours" type="number" min={0} max={168} defaultValue={24} required disabled={busy} /></label>
      {fields.map(([key, label, defaultValue]) => <label key={key}>Coluna {label}<input name={`column.${key}`} defaultValue={defaultValue} required maxLength={80} disabled={busy} /></label>)}
      <label>Tipos pagamento<input name="paymentKinds" defaultValue="payment" required disabled={busy} /></label><label>Tipos estorno<input name="refundKinds" defaultValue="refund" required disabled={busy} /></label><label>Tipos chargeback<input name="chargebackKinds" defaultValue="chargeback" required disabled={busy} /></label>
      <button className="primary" disabled={busy}>Criar layout</button>
    </form></details>

    <form className="pos-admin-row" onSubmit={importBatch}><strong>Importar CSV</strong><label>Layout<select name="layoutId" required disabled={busy || !activeLayouts.length}><option value="">Selecione</option>{activeLayouts.map(layout => <option value={layout.id} key={layout.id}>{layout.provider} · {layout.name} · v{layout.version}</option>)}</select></label><label>Arquivo<input name="file" type="file" accept=".csv,text/csv" required disabled={busy || !activeLayouts.length} /></label><button className="primary" disabled={busy || !activeLayouts.length}>Importar e confrontar</button><small>Até 768 KiB/10.000 linhas. O arquivo bruto e seu nome não são armazenados.</small></form>

    <div className="pos-admin-children">{report.layouts.map(layout => <article key={layout.id}><header><div><strong>{layout.provider} · {layout.name}</strong><small>{layout.status} · v{layout.version} · janela {layout.matchWindowHours}h · {layout.amountMode}</small></div>{layout.status === "active" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Desativar o layout ${layout.name}?`)) void command(`layout.deactivate:${layout.id}:${layout.version}`, { action: "layout.deactivate", layoutId: layout.id, expectedVersion: layout.version }, "Layout desativado."); }}>Desativar</button>}</header></article>)}</div>

    <div className="pos-admin-children">{report.batches.map(batch => <article key={batch.id}><header><div><strong>{batch.provider} · {batch.layoutName}</strong><small>Lote {batch.id} · {batch.status} · v{batch.version} · {batch.rowCount} linhas · {new Date(batch.createdAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small></div><button type="button" disabled={busy} onClick={() => { if (window.confirm(`${batch.status === "pending" ? "Processar" : "Reprocessar"} o lote ${batch.id} sobre a versão ${batch.version}?`)) void command(`batch.reprocess:${batch.id}:${batch.version}`, { action: "batch.reprocess", batchId: batch.id, expectedVersion: batch.version }, batch.status === "pending" ? "Lote processado." : "Lote reprocessado."); }}>{batch.status === "pending" ? "Processar" : "Reprocessar"}</button></header>
      <div className="pos-admin-row"><span>Confrontados <strong>{batch.matchedCount}</strong></span><span>Issues <strong>{batch.issueCount}</strong></span><span>Bloqueio <strong>{batch.productionBlocking ? "sim" : "não"}</strong></span><span>Líquido <strong>{money(batch.totals.netCents)}</strong></span></div>
      {batch.latestRun && <small>{Object.entries(batch.latestRun.issueCodes).map(([code, count]) => `${code}: ${count}`).join(" · ") || "Sem divergências"}{batch.latestRun.issueDetailsTruncated ? " · recorte limitado" : ""}</small>}
    </article>)}</div>
  </section>;
}

function aliases(value: FormDataEntryValue | null) { return String(value || "").split(",").map(item => item.trim()).filter(Boolean); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function money(value: string) {
  try { const cents = BigInt(value), negative = cents < BigInt(0), absolute = negative ? -cents : cents; return `${negative ? "−" : ""}R$ ${(absolute / BigInt(100)).toString()},${(absolute % BigInt(100)).toString().padStart(2, "0")}`; }
  catch { return "—"; }
}
