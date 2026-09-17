"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { tenantTimeZone } from "@/lib/client-timezone";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErpIcon } from "@/components/erp/erp-icon";
import styles from "./business-intelligence-dashboard.module.css";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });

type VariationKey = "revenue" | "orders" | "average_ticket" | "items" | "customers" | "gross_profit" | "gross_margin";
type MixRow = { label: string; revenue: number; orders: number; share: number };
type DashboardData = {
  context: { branch: { id: number; code: string; name: string; timezone: string; defaultWarehouse: { id: number; name: string } | null }; generated_at: string };
  period: { date_min: string; date_max: string; previous_min: string; previous_max: string; days: number; timezone: string };
  summary: {
    revenue: number; orders: number; average_ticket: number; items: number; customers: number; cogs: number; gross_profit: number; gross_margin: number;
    comparison: Record<VariationKey, number | null>;
  };
  performance: {
    daily_average: number; projected_30_days: number;
    best_day: { date: string; revenue: number; orders: number; items: number } | null;
    timeline: Array<{ date: string; revenue: number; orders: number; items: number }>;
    weekdays: Array<{ label: string; revenue: number; orders: number }>;
  };
  rankings: {
    products: Array<{ product_id: number | null; product: string; quantity: number; revenue: number }>;
    customers: MixRow[]; payments: MixRow[]; channels: MixRow[];
  };
  inventory: {
    sku_count: number; physical_units: number; available_units: number; reserved_units: number; value: number;
    low_count: number; out_count: number; coverage_days: number | null;
    critical: Array<{ id: number; name: string; sku: string; unit: string; physical: number; reserved: number; available: number; minimum: number; value: number; gap: number }>;
  };
  pipeline: Array<{ status: string; label: string; count: number; value: number }>;
  recent: Array<{ id: string; number: string; customer: string; channel: string; payment_method: string; status: string; total: number; created_at: string }>;
  criteria: { revenue: string; margin: string; stock: string };
};

export function BusinessIntelligenceDashboard() {
  const [period, setPeriod] = useState("30d");
  const [dateMin, setDateMin] = useState(shiftDate(-29));
  const [dateMax, setDateMax] = useState(shiftDate(0));
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [showComparison, setShowComparison] = useState(true);
  const [chartMetric, setChartMetric] = useState<"revenue" | "orders">("revenue");
  const [ranking, setRanking] = useState<"products" | "customers">("products");
  const [exporting, setExporting] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (period === "custom") {
      params.set("date_min", dateMin);
      params.set("date_max", dateMax);
    } else params.set("period", period);
    return params.toString();
  }, [dateMax, dateMin, period]);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    fetch(`/api/erp/dashboard?${query}`, { signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Não foi possível carregar o BI.");
        setData(payload);
      })
      .catch(reason => { if (reason.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Não foi possível carregar o BI."); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, version]);

  async function exportSummary() {
    setExporting(true);
    try {
      const response = await fetch(`/api/erp/dashboard?${query}&export=summary`);
      if (!response.ok) { const payload = await response.json(); throw new Error(payload.error); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "dashboard-bi.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível exportar o resumo.");
    } finally {
      setExporting(false);
    }
  }

  if (loading && !data) return <DashboardSkeleton />;
  if (error && !data) return <DashboardError message={error} retry={() => setVersion(value => value + 1)} />;

  return <div className={styles.workspace}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}>
        <span>BUSINESS INTELLIGENCE</span>
        <h2>Visão executiva do negócio</h2>
        <p>Desempenho comercial, rentabilidade estimada e saúde do estoque em uma única leitura.</p>
      </div>
      <div className={styles.context}>
        <small>Contexto operacional</small>
        <strong>{data?.context.branch.name || "Filial ativa"}</strong>
        <span>{data?.context.branch.code || "—"} · {data?.context.branch.defaultWarehouse?.name || "Todos os depósitos"}</span>
        <time dateTime={data?.context.generated_at}>Atualizado {data ? relativeTime(data.context.generated_at) : "agora"}</time>
      </div>
    </header>

    <section className={styles.toolbar} aria-label="Filtros do dashboard">
      <label>Período<select value={period} onChange={event => setPeriod(event.target.value)}><option value="7d">Últimos 7 dias</option><option value="30d">Últimos 30 dias</option><option value="90d">Últimos 90 dias</option><option value="custom">Personalizado</option></select></label>
      {period === "custom" && <><label>De<input required type="date" value={dateMin} max={dateMax} onChange={event => setDateMin(event.target.value)} /></label><label>Até<input required type="date" value={dateMax} min={dateMin} max={shiftDate(0)} onChange={event => setDateMax(event.target.value)} /></label></>}
      <label className={styles.compare}><input type="checkbox" checked={showComparison} onChange={event => setShowComparison(event.target.checked)} /><span>Comparar período anterior</span></label>
      <div className={styles.toolbarActions}><button type="button" onClick={() => setVersion(value => value + 1)} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button><button type="button" onClick={() => void exportSummary()} disabled={exporting || !data}>{exporting ? "Exportando…" : "Exportar resumo"}</button></div>
    </section>
    {error && data && <div className={styles.inlineError} role="alert"><span>{error}</span><button onClick={() => setVersion(value => value + 1)}>Tentar novamente</button></div>}

    {data && <>
      <section className={styles.periodContext}><span>{formatDate(data.period.date_min)} — {formatDate(data.period.date_max)}</span><small>{data.period.days} dias · fuso {data.period.timezone}</small>{showComparison && <em>Comparado com {formatDate(data.period.previous_min)} — {formatDate(data.period.previous_max)}</em>}</section>

      <section className={styles.kpis} aria-label="Indicadores principais">
        <MetricCard label="Receita líquida" value={money.format(data.summary.revenue)} comparison={showComparison ? data.summary.comparison.revenue : undefined} icon="↗" tone="green" detail={`${number.format(data.summary.orders)} pedidos reconhecidos`} />
        <MetricCard label="Lucro bruto estimado" value={money.format(data.summary.gross_profit)} comparison={showComparison ? data.summary.comparison.gross_profit : undefined} icon="◈" tone={data.summary.gross_profit >= 0 ? "blue" : "red"} detail={`CMV atual de ${money.format(data.summary.cogs)}`} />
        <MetricCard label="Margem bruta" value={`${number.format(data.summary.gross_margin)}%`} comparison={showComparison ? data.summary.comparison.gross_margin : undefined} icon="◎" tone={data.summary.gross_margin >= 20 ? "green" : "amber"} detail="Estimativa pelo custo atual" />
        <MetricCard label="Ticket médio" value={money.format(data.summary.average_ticket)} comparison={showComparison ? data.summary.comparison.average_ticket : undefined} icon="▤" tone="blue" detail={`${number.format(data.summary.customers)} clientes identificados`} />
        <MetricCard label="Itens vendidos" value={number.format(data.summary.items)} comparison={showComparison ? data.summary.comparison.items : undefined} icon="□" tone="neutral" detail={`${number.format(data.summary.items / Math.max(1, data.summary.orders))} por pedido`} />
        <MetricCard label="Valor em estoque" value={money.format(data.inventory.value)} icon="▦" tone={data.inventory.low_count ? "amber" : "green"} detail={`${data.inventory.low_count} críticos · ${data.inventory.out_count} esgotados`} />
      </section>

      <section className={styles.insights} aria-label="Leitura executiva">
        <header><div><span>LEITURA AUTOMÁTICA</span><h3>O que merece sua atenção</h3></div><small>Gerado a partir do recorte atual</small></header>
        <div>{buildInsights(data).map(insight => <article className={styles[insight.tone]} key={insight.title}><i aria-hidden="true">{insight.icon}</i><p><strong>{insight.title}</strong><span>{insight.text}</span></p>{insight.href && <Link href={insight.href}>Analisar</Link>}</article>)}</div>
      </section>

      <div className={styles.analyticsGrid}>
        <section className={`${styles.panel} ${styles.timelinePanel}`}>
          <header><div><span>DESEMPENHO NO TEMPO</span><h3>Evolução diária</h3><p>Média de {money.format(data.performance.daily_average)} por dia</p></div><div className={styles.segmented}><button className={chartMetric === "revenue" ? styles.active : ""} onClick={() => setChartMetric("revenue")}>Receita</button><button className={chartMetric === "orders" ? styles.active : ""} onClick={() => setChartMetric("orders")}>Pedidos</button></div></header>
          <Timeline rows={data.performance.timeline} metric={chartMetric} />
          <footer><span><small>Projeção linear · 30 dias</small><strong>{money.format(data.performance.projected_30_days)}</strong></span><span><small>Melhor dia</small><strong>{data.performance.best_day ? `${formatDate(data.performance.best_day.date)} · ${money.format(data.performance.best_day.revenue)}` : "Sem vendas"}</strong></span></footer>
        </section>

        <section className={`${styles.panel} ${styles.weekPanel}`}>
          <header><div><span>PADRÃO SEMANAL</span><h3>Receita por dia da semana</h3><p>Identifique os dias de maior tração</p></div></header>
          <WeekdayBars rows={data.performance.weekdays} />
        </section>
      </div>

      <div className={styles.detailGrid}>
        <section className={`${styles.panel} ${styles.rankingPanel}`}>
          <header><div><span>RANKINGS</span><h3>Quem impulsiona o resultado</h3></div><div className={styles.segmented}><button className={ranking === "products" ? styles.active : ""} onClick={() => setRanking("products")}>Produtos</button><button className={ranking === "customers" ? styles.active : ""} onClick={() => setRanking("customers")}>Clientes</button></div></header>
          {ranking === "products" ? <ProductRanking rows={data.rankings.products} /> : <MixRanking rows={data.rankings.customers} empty="Nenhum cliente identificado no período." />}
          <footer><Link href="/erp/relatorios/vendas">Abrir relatório detalhado</Link></footer>
        </section>

        <section className={`${styles.panel} ${styles.mixPanel}`}>
          <header><div><span>MIX DE RECEITA</span><h3>Canais e pagamentos</h3><p>Concentração do faturamento líquido</p></div></header>
          <MixBlock title="Canais" rows={data.rankings.channels} />
          <MixBlock title="Formas de pagamento" rows={data.rankings.payments} />
        </section>

        <section className={`${styles.panel} ${styles.inventoryPanel}`}>
          <header><div><span>SAÚDE DO ESTOQUE</span><h3>Cobertura e reposição</h3><p>{data.inventory.coverage_days === null ? "Sem consumo suficiente para estimar cobertura" : `Cobertura estimada de ${number.format(data.inventory.coverage_days)} dias`}</p></div><Link href="/erp/movimentacoes-estoque">Movimentar</Link></header>
          <div className={styles.inventoryStats}><span><small>Disponível</small><strong>{number.format(data.inventory.available_units)}</strong></span><span><small>Reservado</small><strong>{number.format(data.inventory.reserved_units)}</strong></span><span><small>SKUs</small><strong>{data.inventory.sku_count}</strong></span></div>
          <div className={styles.criticalList}>{data.inventory.critical.map(item => <Link href={`/erp/movimentacoes-estoque?produto=${item.id}`} key={item.id}><span><strong>{item.name}</strong><small>{item.sku} · mínimo {number.format(item.minimum)} {item.unit}</small></span><b className={item.available <= 0 ? styles.danger : ""}>{number.format(item.available)} {item.unit}</b></Link>)}{!data.inventory.critical.length && <EmptyState text="Todos os itens estão acima do estoque mínimo." />}</div>
        </section>
      </div>

      <div className={styles.bottomGrid}>
        <section className={`${styles.panel} ${styles.pipelinePanel}`}>
          <header><div><span>CARTEIRA COMERCIAL</span><h3>Pipeline de pedidos</h3><p>Volume total por status, além do período selecionado</p></div><Link href="/erp/orcamentos-pedidos">Gerenciar</Link></header>
          <Pipeline rows={data.pipeline} />
        </section>
        <section className={`${styles.panel} ${styles.recentPanel}`}>
          <header><div><span>ÚLTIMAS OPERAÇÕES</span><h3>Vendas no período</h3><p>Registros mais recentes do recorte</p></div></header>
          <div>{data.recent.map(item => <article key={item.id}><i aria-hidden="true">↗</i><span><strong>{item.number} · {item.customer}</strong><small>{item.channel} · {item.payment_method} · {formatDateTime(item.created_at)}</small></span><b>{money.format(item.total)}</b></article>)}{!data.recent.length && <EmptyState text="Nenhuma venda reconhecida neste período." />}</div>
        </section>
      </div>

      <section className={styles.quickActions}>
        <header><div><span>ATALHOS OPERACIONAIS</span><h3>Da análise para a ação</h3></div></header>
        <div>{[["sales", "Vendas e despesas", "Acompanhar receitas e saídas", "/erp/vendas-despesas"], ["products", "Produtos", "Revisar preço e margem", "/erp/produtos-servicos"], ["stock", "Estoque", "Repor ou movimentar itens", "/erp/movimentacoes-estoque"], ["reports", "Relatórios", "Aprofundar indicadores", "/erp/relatorios"]].map(([icon, title, note, href]) => <Link href={href} key={href}><ErpIcon name={icon} /><span><strong>{title}</strong><small>{note}</small></span><b>→</b></Link>)}</div>
      </section>

      <details className={styles.criteria}><summary>Critérios e governança dos indicadores</summary><p><strong>Receita:</strong> {data.criteria.revenue}</p><p><strong>Margem:</strong> {data.criteria.margin}</p><p><strong>Estoque:</strong> {data.criteria.stock}</p></details>
    </>}
  </div>;
}

function MetricCard({ label, value, detail, comparison, icon, tone }: { label: string; value: string; detail: string; comparison?: number | null; icon: string; tone: "green" | "blue" | "amber" | "red" | "neutral" }) {
  return <article className={`${styles.metric} ${styles[tone]}`}><header><span>{label}</span><i aria-hidden="true">{icon}</i></header><strong>{value}</strong><footer><small>{detail}</small>{comparison !== undefined && <Variation value={comparison} />}</footer></article>;
}

function Variation({ value }: { value: number | null }) {
  if (value === null) return <em className={styles.flat}>sem base</em>;
  return <em className={value > 0 ? styles.up : value < 0 ? styles.down : styles.flat}>{value > 0 ? "↑" : value < 0 ? "↓" : "→"} {number.format(Math.abs(value))}%</em>;
}

function Timeline({ rows, metric }: { rows: DashboardData["performance"]["timeline"]; metric: "revenue" | "orders" }) {
  const max = Math.max(1, ...rows.map(row => row[metric]));
  return <div className={styles.timeline} role="img" aria-label={metric === "revenue" ? "Gráfico de receita diária" : "Gráfico de pedidos por dia"}><div>{rows.map((row, index) => { const value = row[metric]; const showLabel = rows.length <= 31 || index === 0 || index === rows.length - 1 || index % 7 === 0; return <span key={row.date} title={`${formatDate(row.date)} · ${metric === "revenue" ? money.format(value) : `${value} pedidos`}`}><i style={{ height: `${Math.max(value ? 5 : 1, value / max * 100)}%` }} /><small>{showLabel ? row.date.slice(5).replace("-", "/") : ""}</small></span>; })}</div></div>;
}

function WeekdayBars({ rows }: { rows: DashboardData["performance"]["weekdays"] }) {
  const max = Math.max(1, ...rows.map(row => row.revenue));
  return <div className={styles.weekBars}>{rows.map(row => <div key={row.label}><span><strong>{row.label.replace(".", "")}</strong><small>{row.orders} ped.</small></span><i><b style={{ width: `${row.revenue / max * 100}%` }} /></i><em>{compactMoney.format(row.revenue)}</em></div>)}</div>;
}

function ProductRanking({ rows }: { rows: DashboardData["rankings"]["products"] }) {
  const max = Math.max(1, ...rows.map(row => row.revenue));
  return <ol className={styles.ranking}>{rows.map((row, index) => <li key={`${row.product_id}-${row.product}`}><b>#{index + 1}</b><span><strong>{row.product}</strong><small>{number.format(row.quantity)} unidades</small><i><em style={{ width: `${row.revenue / max * 100}%` }} /></i></span><strong>{money.format(row.revenue)}</strong></li>)}{!rows.length && <EmptyState text="Nenhum produto vendido no período." />}</ol>;
}

function MixRanking({ rows, empty }: { rows: MixRow[]; empty: string }) {
  return <ol className={styles.ranking}>{rows.map((row, index) => <li key={row.label}><b>#{index + 1}</b><span><strong>{row.label}</strong><small>{row.orders} pedidos · {number.format(row.share)}%</small><i><em style={{ width: `${row.share}%` }} /></i></span><strong>{money.format(row.revenue)}</strong></li>)}{!rows.length && <EmptyState text={empty} />}</ol>;
}

function MixBlock({ title, rows }: { title: string; rows: MixRow[] }) {
  return <div className={styles.mixBlock}><h4>{title}</h4>{rows.slice(0, 5).map(row => <div key={row.label}><span><strong>{row.label}</strong><small>{row.orders} operações</small></span><i><b style={{ width: `${row.share}%` }} /></i><em>{number.format(row.share)}%</em></div>)}{!rows.length && <EmptyState text="Sem dados no período." />}</div>;
}

function Pipeline({ rows }: { rows: DashboardData["pipeline"] }) {
  const max = Math.max(1, ...rows.map(row => row.value));
  return <div className={styles.pipeline}>{rows.slice(0, 8).map(row => <div key={row.status}><span><strong>{row.label}</strong><small>{row.count} registros</small></span><i><b style={{ width: `${row.value / max * 100}%` }} /></i><em>{money.format(row.value)}</em></div>)}{!rows.length && <EmptyState text="Nenhum pedido na carteira comercial." />}</div>;
}

function EmptyState({ text }: { text: string }) { return <div className={styles.empty}><span aria-hidden="true">◇</span><p>{text}</p></div>; }

function DashboardSkeleton() { return <div className={styles.skeleton}><header /><nav /><section>{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</section><div className={styles.skeletonBody} /><div className={styles.skeletonBody} /></div>; }

function DashboardError({ message, retry }: { message: string; retry: () => void }) { return <section className={styles.errorState}><span aria-hidden="true">!</span><h2>Não foi possível carregar o dashboard</h2><p>{message}</p><button onClick={retry}>Tentar novamente</button></section>; }

function buildInsights(data: DashboardData) {
  const insights: Array<{ title: string; text: string; tone: "positive" | "warning" | "critical" | "info"; icon: string; href?: string }> = [];
  const revenueChange = data.summary.comparison.revenue;
  if (revenueChange === null) insights.push({ title: "Nova base de receita", text: "Há faturamento no período, mas a janela anterior não possui base comparável.", tone: "info", icon: "↗", href: "/erp/relatorios/vendas" });
  else if (revenueChange >= 5) insights.push({ title: "Receita em aceleração", text: `O faturamento cresceu ${number.format(revenueChange)}% contra o período anterior.`, tone: "positive", icon: "↑", href: "/erp/relatorios/vendas" });
  else if (revenueChange <= -5) insights.push({ title: "Queda de faturamento", text: `A receita recuou ${number.format(Math.abs(revenueChange))}%. Revise canais, ticket e produtos líderes.`, tone: "critical", icon: "↓", href: "/erp/relatorios/vendas" });
  else insights.push({ title: "Receita estável", text: "A variação ficou dentro de 5% em relação ao período anterior.", tone: "info", icon: "→" });
  if (data.summary.gross_margin < 0) insights.push({ title: "Margem negativa", text: "O custo atual supera a receita líquida estimada no recorte.", tone: "critical", icon: "!", href: "/erp/relatorios" });
  else if (data.summary.gross_margin < 20) insights.push({ title: "Margem sob atenção", text: `A margem estimada está em ${number.format(data.summary.gross_margin)}%. Revise custos e preços.`, tone: "warning", icon: "!", href: "/erp/relatorios" });
  else insights.push({ title: "Margem positiva", text: `A operação preserva ${number.format(data.summary.gross_margin)}% de margem bruta estimada.`, tone: "positive", icon: "✓" });
  if (data.inventory.low_count) insights.push({ title: `${data.inventory.low_count} itens precisam de reposição`, text: `${data.inventory.out_count} estão sem saldo disponível na filial.`, tone: data.inventory.out_count ? "critical" : "warning", icon: "▦", href: "/erp/movimentacoes-estoque" });
  else insights.push({ title: "Estoque sem alertas", text: "Todos os itens controlados estão acima do mínimo configurado.", tone: "positive", icon: "✓" });
  const channel = data.rankings.channels[0];
  if (channel && channel.share >= 65) insights.push({ title: "Receita concentrada em um canal", text: `${channel.label} representa ${number.format(channel.share)}% do faturamento.`, tone: "warning", icon: "◎", href: "/erp/relatorios/vendas" });
  if (data.inventory.coverage_days !== null && data.inventory.coverage_days < 15) insights.push({ title: "Cobertura curta", text: `No ritmo atual, o estoque disponível cobre cerca de ${number.format(data.inventory.coverage_days)} dias.`, tone: "warning", icon: "◷", href: "/erp/movimentacoes-estoque" });
  return insights.slice(0, 4);
}

function shiftDate(days: number) { const date = new Date(); date.setDate(date.getDate() + days); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function formatDate(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR", { timeZone: tenantTimeZone() }); }
function formatDateTime(value: string) { return new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone(), dateStyle: "short", timeStyle: "short" }); }
function relativeTime(value: string) { const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "agora"; if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`; return `às ${new Date(value).toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone(), hour: "2-digit", minute: "2-digit" })}`; }
