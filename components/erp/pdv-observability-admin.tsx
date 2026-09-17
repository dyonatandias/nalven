"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useState } from "react";

type Summary = {
  sessions: { openStale: number; closingStale: number };
  payments: { pending: number; unknown: number; manualReview: number };
  paymentIntegrity: { openProductionBlocking: number };
  printJobs: { queued: number; processing: number; failed: number; expiredLeases: number };
  terminals: { stale: number; offline: number; revoked: number };
  devices: { offline: number; error: number };
  offlineSync: { rejected: number; conflict: number; processingStale: number };
  inventoryLots: { quarantineWithBalance: number; expiredWithBalance: number };
  promotions: { counterMismatch: number; limitExceeded: number; perCustomerLimitExceeded: number };
};
type OperationalResource = { type: string; id: string };
type Incident = { resource: OperationalResource; incident?: string; incidents?: string[]; status?: string; state?: string; ageMinutes?: number | null; terminalId?: string; registerId?: number | null; saleId?: number; sessionId?: number; amountCents?: number; expectedAmountCents?: number; reportedAmountCents?: number; expectedCurrency?: string; reportedCurrency?: string; productionBlocking?: boolean; expiresOn?: string | null };
type RecentSession = {
  id: number; number: string; registerId: number | null; operatorProfileId: number | null; status: string; openedAt: string; closedAt: string | null;
  differenceCents: number | null; absoluteDifferenceCents: number | null; sales: { count: number; amountCents: number; byStatus: Array<{ status: string; count: number; amountCents: number }> };
  payments: Array<{ type: string; method: string; status: string; count: number; amountCents: number }>;
  cashEvents: Array<{ type: string; count: number; amountCents: number }>;
};
type ObservabilityData = {
  generatedAt: string; businessDate: string; window: { from: string; to: string; hours: number };
  thresholds: Record<string, number>; limits: { detail: number; diagnosticScan: number };
  summary: Summary; recentSessions: RecentSession[]; truncated: Record<string, boolean>;
  details: { sessions: Incident[]; payments: Incident[]; paymentIntegrity: Incident[]; printJobs: Incident[]; terminals: Incident[]; devices: Incident[]; sync: Incident[]; lots: Incident[]; promotions: Incident[] };
};

export function PdvObservabilityAdmin({ branchId }: { branchId: number }) {
  const [windowHours, setWindowHours] = useState("168");
  const [limit, setLimit] = useState("25");
  const [data, setData] = useState<ObservabilityData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const parameters = new URLSearchParams({ branchId: String(branchId), windowHours, limit });
      const response = await fetch(`/api/erp/pdv/observability?${parameters}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível consultar a operação do PDV.");
      setData(body as ObservabilityData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar a operação do PDV.");
    } finally {
      setLoading(false);
    }
  }, [branchId, limit, windowHours]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const cards = data ? summaryCards(data.summary) : [];
  return <section className="pos-observability" aria-labelledby="pos-observability-title">
    <header><div><h3 id="pos-observability-title">Saúde operacional</h3><p>Leitura direta dos estados persistidos. Não substitui monitoramento externo nem cria estimativas.</p></div><button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button></header>
    <div className="pos-observability-filters">
      <label>Janela de eventos<select value={windowHours} onChange={event => setWindowHours(event.target.value)} disabled={loading}><option value="24">24 horas</option><option value="168">7 dias</option><option value="720">30 dias</option></select></label>
      <label>Detalhes por consulta<select value={limit} onChange={event => setLimit(event.target.value)} disabled={loading}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label>
    </div>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {!data ? <p role="status">{loading ? "Carregando sinais operacionais…" : "Sem dados carregados."}</p> : <>
      <p className="pos-observability-meta">Gerado em {formatDateTime(data.generatedAt)} · janela desde {formatDateTime(data.window.from)} · data operacional {formatDate(data.businessDate)} · IDs exibidos são referências internas.</p>
      <div className="pos-observability-cards">{cards.map(card => <article key={card.label} className={card.count ? "has-signal" : "healthy"}><strong>{card.count}</strong><span>{card.label}</span><small>{card.detail}</small></article>)}</div>
      <details open><summary>Turnos recentes agregados ({data.recentSessions.length})</summary><div className="pos-observability-sessions">{data.recentSessions.map(session => <article key={session.id}>
        <header><strong>{session.number}</strong><code>turno {session.id} · caixa {session.registerId ?? "sem vínculo"} · operador {session.operatorProfileId ?? "sem vínculo"}</code><span>{session.status}</span></header>
        <p>{session.sales.count} vendas · {money(session.sales.amountCents)} · {session.sales.byStatus.map(item => `${item.status} ${item.count}`).join(" · ") || "sem vendas"} · abertura {formatDateTime(session.openedAt)}{session.closedAt ? ` · fechamento ${formatDateTime(session.closedAt)}` : ""}</p>
        <div>{session.payments.map(item => <small key={`${item.type}:${item.method}:${item.status}`}>{item.type === "refund" ? "refund" : "pagamento"} {item.method}/{item.status}: {item.count} · {money(item.amountCents)}</small>)}{!session.payments.length && <small>Sem pagamentos persistidos.</small>}</div>
        <div>{session.cashEvents.map(item => <small key={item.type}>{item.type === "supply" ? "suprimento" : "sangria"}: {item.count} · {money(item.amountCents)}</small>)}{!session.cashEvents.length && <small>Sem sangria/suprimento.</small>}</div>
        <footer>Diferença: {session.differenceCents == null ? "não fechada" : money(session.differenceCents)}{session.absoluteDifferenceCents != null ? ` · absoluta ${money(session.absoluteDifferenceCents)}` : ""}</footer>
      </article>)}{!data.recentSessions.length && <p className="tenant-empty">Nenhum turno abriu ou fechou nesta janela.</p>}</div></details>
      <details><summary>Referências operacionais dos sinais</summary><div className="pos-observability-details">{detailGroups(data).map(group => <section key={group.label}><h4>{group.label} ({group.items.length}{group.truncated ? "+" : ""})</h4>{group.items.map((item, index) => <article key={`${item.resource.type}:${item.resource.id}:${index}`}>
        <code>{item.resource.type} · {item.resource.id}</code><strong>{incidentLabel(item)}</strong><small>{incidentContext(item)}</small>
      </article>)}{!group.items.length && <p className="tenant-empty">Sem sinais.</p>}</section>)}</div></details>
      <p className="pos-observability-thresholds">Limiares: turno {data.thresholds.sessionStaleMinutes} min; pagamento em processamento {data.thresholds.paymentPendingMinutes} min; terminal stale/offline {data.thresholds.terminalStaleMinutes}/{data.thresholds.terminalOfflineMinutes} min; sync em processamento {data.thresholds.syncProcessingMinutes} min. Leases de impressão usam o vencimento persistido. Diagnóstico promocional examina no máximo {data.limits.diagnosticScan} registros por conjunto.</p>
    </>}
  </section>;
}

function summaryCards(summary: Summary) {
  return [
    { label: "Turnos antigos", count: summary.sessions.openStale + summary.sessions.closingStale, detail: `${summary.sessions.openStale} open · ${summary.sessions.closingStale} closing` },
    { label: "Pagamentos/refunds", count: summary.payments.pending + summary.payments.unknown + summary.payments.manualReview, detail: `${summary.payments.pending} pending · ${summary.payments.unknown} unknown · ${summary.payments.manualReview} revisão` },
    { label: "Integridade financeira", count: summary.paymentIntegrity.openProductionBlocking, detail: `${summary.paymentIntegrity.openProductionBlocking} incidentes bloqueiam fechamento e handoff` },
    { label: "Impressão", count: summary.printJobs.queued + summary.printJobs.processing + summary.printJobs.failed, detail: `${summary.printJobs.failed} falhas · ${summary.printJobs.expiredLeases} leases expirados` },
    { label: "Terminais", count: summary.terminals.stale + summary.terminals.offline + summary.terminals.revoked, detail: `${summary.terminals.stale} stale · ${summary.terminals.offline} offline · ${summary.terminals.revoked} revogados` },
    { label: "Dispositivos", count: summary.devices.offline + summary.devices.error, detail: `${summary.devices.offline} offline · ${summary.devices.error} erro` },
    { label: "Sync offline", count: summary.offlineSync.rejected + summary.offlineSync.conflict + summary.offlineSync.processingStale, detail: `${summary.offlineSync.rejected} rejeitados · ${summary.offlineSync.conflict} conflitos · ${summary.offlineSync.processingStale} antigos` },
    { label: "Lotes com saldo", count: summary.inventoryLots.quarantineWithBalance + summary.inventoryLots.expiredWithBalance, detail: `${summary.inventoryLots.quarantineWithBalance} quarentena · ${summary.inventoryLots.expiredWithBalance} vencidos` },
    { label: "Promoções/cupons", count: summary.promotions.counterMismatch + summary.promotions.limitExceeded + summary.promotions.perCustomerLimitExceeded, detail: `${summary.promotions.counterMismatch} contadores · ${summary.promotions.limitExceeded} limites · ${summary.promotions.perCustomerLimitExceeded} por cliente` },
  ];
}

function detailGroups(data: ObservabilityData) {
  return [
    { label: "Turnos", items: data.details.sessions, truncated: data.truncated.sessions },
    { label: "Pagamentos e refunds", items: data.details.payments, truncated: data.truncated.payments },
    { label: "Integridade de pagamentos", items: data.details.paymentIntegrity, truncated: data.truncated.paymentIntegrity },
    { label: "Impressão", items: data.details.printJobs, truncated: data.truncated.printJobs },
    { label: "Terminais", items: data.details.terminals, truncated: data.truncated.terminals },
    { label: "Dispositivos", items: data.details.devices, truncated: data.truncated.devices },
    { label: "Sync offline", items: data.details.sync, truncated: data.truncated.sync },
    { label: "Lotes", items: data.details.lots, truncated: data.truncated.lots },
    { label: "Promoções/cupons", items: data.details.promotions, truncated: data.truncated.promotions },
  ];
}

function incidentLabel(item: Incident) { return (item.incidents || [item.incident || item.status || item.state || "sinal"]).join(", ").replaceAll("_", " "); }
function incidentContext(item: Incident) {
  const mismatch = item.expectedAmountCents == null ? null : `esperado ${money(item.expectedAmountCents)} ${item.expectedCurrency || ""} · reportado ${money(item.reportedAmountCents || 0)} ${item.reportedCurrency || ""}`;
  const parts = [item.productionBlocking ? "production blocking" : null, item.ageMinutes == null ? null : `${item.ageMinutes} min`, item.sessionId ? `turno ${item.sessionId}` : null, item.registerId ? `caixa ${item.registerId}` : null, item.terminalId ? `terminal ${item.terminalId}` : null, item.saleId ? `venda ${item.saleId}` : null, item.amountCents == null ? null : money(item.amountCents), mismatch, item.expiresOn ? `validade ${formatDate(item.expiresOn)}` : null];
  return parts.filter(Boolean).join(" · ") || "Consulte o runbook antes de corrigir o estado.";
}
function money(value: number) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100); }
function formatDateTime(value: string) { return new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone() }); }
function formatDate(value: string) { return new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" }); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } }
