"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Metric = { value: number; previous: number | null; change: number | null };
type Dashboard = {
  generatedAt: string;
  period: string;
  coverage: { requestedFrom: string | null; requestedTo: string; availableFrom: string | null; availableTo: string | null; from: string | null; to: string | null; complete: boolean };
  metrics: { views: Metric; visitors: Metric; sessions: Metric; avgDurationSeconds: Metric; devices: Record<"desktop" | "mobile" | "tablet", number>; uniquenessMode: "exact" | "daily_sum" };
  realtime: { visitors: number; sessions: number; pages: Array<{ pageType: string; sessions: number }> };
  trends: Array<{ key: string; label: string; views: number; visitors: number }>;
  pages: Array<{ path: string; pageType: string; views: number; visitors: number }>;
  referrers: Array<{ source: string; views: number; visitors: number }>;
  funnel: Array<{ key: string; label: string; count: number; rateToNext: number | null }>;
  settings: { enabled: boolean; trackAdmins: boolean; rawRetentionDays: number; dailyRetentionDays: number; heartbeatIntervalSeconds: number; timezone: string };
};

const periods = [["today", "Hoje"], ["7d", "7 dias"], ["30d", "30 dias"], ["90d", "90 dias"], ["all", "Todo período"]];
const pageLabels: Record<string, string> = { home: "Início", signup: "Cadastro", login: "Login", blog: "Blog", glossary: "Glossário", tracking: "Rastreio", recovery: "Recuperação", page: "Página", other: "Outra" };

export default function AnalyticsDashboard() {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/analytics?period=${period}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar o analytics.");
      setData(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar os dados."); }
    finally { setLoading(false); setRefreshing(false); }
  }, [period]);

  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/admin/analytics?view=realtime", { cache: "no-store" });
        const body = await response.json();
        if (response.ok) setData((current) => current ? { ...current, realtime: body.realtime, generatedAt: body.generatedAt } : current);
      } catch { /* Mantém o último estado conhecido. */ }
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice(""); setRefreshing(true);
    const form = new FormData(event.currentTarget);
    const payload = { enabled: form.get("enabled") === "on", trackAdmins: form.get("trackAdmins") === "on", rawRetentionDays: Number(form.get("rawRetentionDays")), dailyRetentionDays: Number(form.get("dailyRetentionDays")), heartbeatIntervalSeconds: Number(form.get("heartbeatIntervalSeconds")), timezone: String(form.get("timezone")) };
    try {
      const response = await fetch("/api/admin/analytics", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Não foi possível salvar.");
      setData((current) => current ? { ...current, settings: body.settings } : current); setNotice("Configurações salvas.");
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Falha ao salvar."); }
    finally { setRefreshing(false); }
  }

  if (loading) return <AnalyticsSkeleton/>;
  if (error || !data) return <div className="analytics-error"><strong>Os dados não puderam ser carregados.</strong><p>{error}</p><button onClick={() => void load()}>Tentar novamente</button></div>;
  const totalDevices = Object.values(data.metrics.devices).reduce((sum, value) => sum + value, 0);
  const maxFunnel = Math.max(1, ...data.funnel.map((item) => item.count));
  return <div className="analytics-page">
    <div className="module-heading"><div><p>AQUISIÇÃO E CONTEÚDO</p><h1>Analytics do site</h1><span>Entenda como visitantes descobrem a NALVEN e avançam até a criação da conta.</span></div><div className="page-actions"><button onClick={() => setSettingsOpen(!settingsOpen)}>Configurações</button><button className="primary" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "Atualizando…" : "Atualizar"}</button></div></div>
    {settingsOpen && <form className="analytics-settings" onSubmit={saveSettings}><header><div><h2>Coleta e retenção</h2><p>Dados brutos identificáveis ficam somente durante a janela curta de recuperação.</p></div><button type="button" onClick={() => setSettingsOpen(false)}>×</button></header><div className="analytics-settings-grid"><label className="analytics-check"><input name="enabled" type="checkbox" defaultChecked={data.settings.enabled}/><span><strong>Coleta ativa</strong><small>Ao desligar, eventos novos são descartados; o histórico permanece.</small></span></label><label className="analytics-check"><input name="trackAdmins" type="checkbox" defaultChecked={data.settings.trackAdmins}/><span><strong>Contar superadministradores</strong><small>Desativado por padrão para não contaminar o tráfego real.</small></span></label><label>Retenção bruta (dias)<input name="rawRetentionDays" type="number" min="1" max="30" defaultValue={data.settings.rawRetentionDays}/><small>Também define a janela máxima de recuperação após falha do agregador.</small></label><label>Retenção agregada (dias)<input name="dailyRetentionDays" type="number" min="30" max="3650" defaultValue={data.settings.dailyRetentionDays}/></label><label>Heartbeat (segundos)<input name="heartbeatIntervalSeconds" type="number" min="10" max="120" defaultValue={data.settings.heartbeatIntervalSeconds}/></label><label>Fuso horário<input name="timezone" defaultValue={data.settings.timezone}/></label></div><footer>{notice && <span>{notice}</span>}<button className="primary" disabled={refreshing}>Salvar configurações</button></footer></form>}
    <div className="analytics-toolbar"><div>{periods.map(([key, label]) => <button className={period === key ? "active" : ""} onClick={() => setPeriod(key)} key={key}>{label}</button>)}</div><span>{refreshing ? "Atualizando dados…" : `Atualizado às ${new Date(data.generatedAt).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}`}</span></div>
    <Coverage coverage={data.coverage}/>
    {!data.settings.enabled && <div className="analytics-disabled">A coleta está desativada. O histórico abaixo continua disponível.</div>}
    <section className="realtime-card"><span className={data.realtime.visitors ? "live-dot active" : "live-dot"}/><div><strong>{formatNumber(data.realtime.visitors)} online agora</strong><small>{data.realtime.sessions} sessões ativas nos últimos 10 minutos</small></div><div className="realtime-pages">{data.realtime.pages.slice(0, 5).map((item) => <span key={item.pageType}>{pageLabels[item.pageType] || item.pageType} <b>{item.sessions}</b></span>)}</div></section>
    <section className="analytics-metrics"><MetricCard label="Visualizações" metric={data.metrics.views}/><MetricCard label={data.metrics.uniquenessMode === "exact" ? "Visitantes únicos" : "Visitantes (soma diária)"} metric={data.metrics.visitors}/><MetricCard label="Sessões" metric={data.metrics.sessions}/><MetricCard label="Duração média" metric={data.metrics.avgDurationSeconds} duration/></section>
    <section className="analytics-panel trend-panel"><header><div><h2>Tendência de acesso</h2><p>Visualizações e visitantes ao longo do período.</p></div><div className="chart-legend"><span className="views"/>Visualizações <span className="visitors"/>Visitantes</div></header><TrendChart points={data.trends}/></section>
    <div className="analytics-columns"><section className="analytics-panel"><header><div><h2>Funil de aquisição</h2><p>Volumes agregados por etapa; não representa uma sequência individual.</p></div></header><div className="funnel-list">{data.funnel.map((item) => <div key={item.key}><div><strong>{item.label}</strong><b>{formatNumber(item.count)}</b></div><span><i style={{ width: `${item.count / maxFunnel * 100}%` }}/></span>{item.rateToNext !== null && <small>{formatPercent(item.rateToNext)} avançam para a próxima etapa</small>}</div>)}</div></section><section className="analytics-panel"><header><div><h2>Dispositivos</h2><p>Experiência usada pelos visitantes.</p></div></header><div className="device-list">{(["mobile", "desktop", "tablet"] as const).map((key) => <div key={key}><span><b className={key}/></span><strong>{key === "mobile" ? "Celular" : key === "desktop" ? "Desktop" : "Tablet"}</strong><em>{totalDevices ? formatPercent(data.metrics.devices[key] / totalDevices * 100) : "—"}</em><small>{formatNumber(data.metrics.devices[key])} visualizações</small></div>)}</div></section></div>
    <div className="analytics-columns"><Ranking title="Páginas mais acessadas" subtitle="Conteúdo e jornadas com maior interesse" items={data.pages.map((item) => ({ key: item.path, label: item.path, badge: pageLabels[item.pageType] || item.pageType, value: item.views, secondary: `${formatNumber(item.visitors)} visitantes` }))}/><Ranking title="Origens de tráfego" subtitle="Domínios de referência, sem armazenar URLs completas" items={data.referrers.map((item) => ({ key: item.source, label: item.source === "direct" ? "Acesso direto" : item.source, value: item.views, secondary: `${formatNumber(item.visitors)} visitantes` }))}/></div>
  </div>;
}

function MetricCard({ label, metric, duration = false }: { label: string; metric: Metric; duration?: boolean }) { return <article><small>{label}</small><strong>{duration ? formatDuration(metric.value) : formatNumber(metric.value)}</strong>{metric.change === null ? <span className="neutral">Sem base anterior</span> : <span className={metric.change >= 0 ? "positive" : "negative"}>{metric.change >= 0 ? "↑" : "↓"} {formatPercent(Math.abs(metric.change))} vs. período anterior</span>}</article>; }
function Coverage({ coverage }: { coverage: Dashboard["coverage"] }) { if (!coverage.availableFrom || !coverage.from || !coverage.to) return <div className="coverage empty">Ainda não há histórico disponível para este recorte.</div>; return <div className={coverage.complete ? "coverage" : "coverage partial"}>Dados de {formatDate(coverage.from)} até {formatDate(coverage.to)}{!coverage.complete && <span> — cobertura parcial: a coleta não cobre todo o filtro selecionado.</span>}</div>; }
function Ranking({ title, subtitle, items }: { title: string; subtitle: string; items: Array<{ key: string; label: string; badge?: string; value: number; secondary: string }> }) { return <section className="analytics-panel"><header><div><h2>{title}</h2><p>{subtitle}</p></div></header>{items.length ? <div className="analytics-ranking">{items.map((item, index) => <div key={item.key}><i>{index + 1}</i><span><strong title={item.label}>{item.label}</strong><small>{item.secondary}</small></span>{item.badge && <em>{item.badge}</em>}<b>{formatNumber(item.value)}</b></div>)}</div> : <div className="analytics-empty">Nenhum dado no período.</div>}</section>; }
function TrendChart({ points }: { points: Dashboard["trends"] }) { const chart = useMemo(() => { const max = Math.max(1, ...points.flatMap((point) => [point.views, point.visitors])); const coords = (key: "views" | "visitors") => points.map((point, index) => `${points.length === 1 ? 50 : index / (points.length - 1) * 100},${94 - point[key] / max * 84}`).join(" "); return { views: coords("views"), visitors: coords("visitors") }; }, [points]); const labels = points.filter((_, index) => index === 0 || index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 6)) === 0); return <div className="trend-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Gráfico de tendência"><g>{[10,31,52,73,94].map((y) => <line x1="0" x2="100" y1={y} y2={y} key={y}/>)}</g><polyline className="views" points={chart.views}/><polyline className="visitors" points={chart.visitors}/></svg><div>{labels.map((point) => <span key={point.key}>{point.label}</span>)}</div></div>; }
function AnalyticsSkeleton() { return <div className="analytics-skeleton"><div/><section>{Array.from({ length: 4 }, (_, index) => <article key={index}/>)}</section><div className="large"/></div>; }
const formatNumber = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
const formatPercent = (value: number) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`;
const formatDate = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
function formatDuration(value: number) { if (value <= 0) return "—"; const minutes = Math.floor(value / 60), seconds = Math.round(value % 60); return minutes ? `${minutes}m${seconds ? ` ${seconds}s` : ""}` : `${seconds}s`; }
