"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useState } from "react";

type LiabilityRow = {
  kind: string;
  unit: "points" | "cents";
  status: string;
  aging: "age_0_30" | "age_31_90" | "age_91_365" | "age_over_365";
  accountCount: number;
  balanceUnits: string;
  reservedUnits: string;
  availableUnits: string;
  faceValueCents: string;
  reservedFaceValueCents: string;
  availableFaceValueCents: string;
};

type DueRow = { kind: string; unit: "points" | "cents"; count: number; amountUnits: string; faceValueCents: string };
type LiabilityReport = {
  branchId: number;
  asOf: string;
  agingThresholdDays: { recentDays: number; mediumDays: number; longDays: number };
  totals: { accountCount: number; points: string; cents: string; faceValueCents: string; reservedFaceValueCents: string; availableFaceValueCents: string };
  rows: LiabilityRow[];
  due: { reservations: DueRow[]; accounts: DueRow[]; reservationCount: number; accountCount: number };
  lastSweep: null | { at: string; releasedReservations: number; expiredAccounts: number; remainingDueReservations: number; remainingDueAccounts: number; hasMore: boolean };
};

export function PdvValueLiabilityAdmin({ branchId }: { branchId: number }) {
  const [report, setReport] = useState<LiabilityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/erp/pdv/value-accounts/liability?branchId=${branchId}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível consultar o passivo de valores.");
      const next = body.report;
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Resposta inválida do passivo de valores.");
      setReport(next as LiabilityReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar o passivo de valores.");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  return <section className="pos-observability" aria-labelledby="pos-value-liability-title">
    <header><div><h3 id="pos-value-liability-title">Passivo de valores</h3><p>Agregado por natureza, estado e idade, sem dados de cliente ou credenciais. Valor de face usa a conversão de resgate configurada.</p></div><button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {!report ? <p role="status">{loading ? "Calculando passivo…" : "Sem relatório carregado."}</p> : <>
      <p className="pos-observability-meta">Posição em {dateTime(report.asOf)} · aging desde a emissão · processamento automático {report.lastSweep ? dateTime(report.lastSweep.at) : "ainda não observado"}.</p>
      <div className="pos-observability-cards">
        <article><strong>{report.totals.accountCount}</strong><span>contas com passivo</span><small>{units(report.totals.points, "points")} · {money(report.totals.cents)}</small></article>
        <article><strong>{money(report.totals.faceValueCents)}</strong><span>valor de face</span><small>{money(report.totals.availableFaceValueCents)} disponível</small></article>
        <article className={report.due.reservationCount ? "has-signal" : "healthy"}><strong>{report.due.reservationCount}</strong><span>reservas a liberar</span><small>{money(sumFace(report.due.reservations))} de face</small></article>
        <article className={report.due.accountCount ? "has-signal" : "healthy"}><strong>{report.due.accountCount}</strong><span>contas a expirar</span><small>{money(sumFace(report.due.accounts))} de face</small></article>
      </div>
      <details><summary>Passivo por natureza, estado e aging ({report.rows.length})</summary><div className="pos-observability-details">{report.rows.map(row => <article key={`${row.kind}:${row.status}:${row.aging}`}>
        <code>{kindLabel(row.kind)} · {row.status} · {agingLabel(row.aging)}</code><strong>{money(row.faceValueCents)}</strong>
        <small>{row.accountCount} conta(s) · {units(row.balanceUnits, row.unit)} saldo · {units(row.reservedUnits, row.unit)} reservado</small>
      </article>)}{!report.rows.length && <p className="tenant-empty">Nenhum saldo passivo nesta filial.</p>}</div></details>
      <p className="pos-observability-thresholds">Buckets: 0–{report.agingThresholdDays.recentDays}, {report.agingThresholdDays.recentDays + 1}–{report.agingThresholdDays.mediumDays}, {report.agingThresholdDays.mediumDays + 1}–{report.agingThresholdDays.longDays} e mais de {report.agingThresholdDays.longDays} dias. Pontos permanecem em unidades inteiras; o valor de face não é uma provisão contábil.</p>
    </>}
  </section>;
}

function sumFace(rows: DueRow[]) { return rows.reduce((sum, row) => sum + BigInt(row.faceValueCents), BigInt(0)).toString(); }
function units(value: string, unit: "points" | "cents") { return unit === "cents" ? money(value) : `${new Intl.NumberFormat("pt-BR").format(BigInt(value))} pts`; }
function money(value: string) { const amount = BigInt(value), negative = amount < BigInt(0), absolute = negative ? -amount : amount, whole = absolute / BigInt(100), fraction = String(absolute % BigInt(100)).padStart(2, "0"); return `${negative ? "-" : ""}R$ ${new Intl.NumberFormat("pt-BR").format(whole)},${fraction}`; }
function kindLabel(value: string) { return value === "loyalty_points" ? "Pontos" : value === "cashback" ? "Cashback" : value === "gift_card" ? "Gift card" : value === "store_credit" ? "Crédito-loja" : "Natureza inválida"; }
function agingLabel(value: LiabilityRow["aging"]) { return value === "age_0_30" ? "0–30 dias" : value === "age_31_90" ? "31–90 dias" : value === "age_91_365" ? "91–365 dias" : ">365 dias"; }
function dateTime(value: string) { return new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone() }); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
