"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErpIcon } from "@/components/erp/erp-icon";
import { ErpModal } from "@/components/erp/modal-portal";
import styles from "./planning-control-center.module.css";

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("pt-BR");
const date = tenantDateTimeFormatter({ dateStyle: "short" });
const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
type Tab = "overview" | "budgets" | "goals" | "quality";
type Filters = { year: number; scenario: string; basis: string; branchId: string; costCenterId: string; budgetId: string };
type Month = { month: number; revenueCents: number; deductionsCents: number; cogsCents: number; operatingExpenseCents: number;
  financialResultCents: number; incomeTaxCents: number; resultCents: number; budgetRevenueCents: number; budgetCogsCents: number;
  budgetExpenseCents: number; budgetResultCents: number };
type Center = { id: number; name: string; code: string; active: boolean; createdAt: string };
type BudgetLine = { id: number; costCenterId: number; month: number; revenueCents: number; cogsCents: number;
  expenseCents: number; notes: string | null; costCenter: Center };
type Budget = { id: number; name: string; year: number; scenario: string; status: string; version: number; notes: string | null;
  approvedBy: string | null; approvedAt: string | null; updatedAt: string; lines: BudgetLine[] };
type GoalUpdate = { id: number; value: number; note: string | null; createdBy: string; createdAt: string };
type Goal = { id: number; title: string; metric: string; unit: string; direction: string; target: number; current: number;
  baseline: number; owner: string | null; weight: number; notes: string | null; startedAt: string; dueAt: string;
  status: string; progress: number; achieved: boolean; overdue: boolean; updates: GoalUpdate[] };
type Category = { key: string; label: string; group: string; inferred: boolean; amountCents: number; count: number };
type Detail = { id: string; date: string; description: string; source: string; group: string; amountCents: number;
  category: string; branch: string | null; costCenter: string | null };
type Data = { generatedAt: string; filters: Filters; activeBudgetId: number | null; months: Month[]; centers: Center[];
  branches: Array<{ id: number; code: string; name: string }>; budgets: Budget[]; goals: Goal[]; categories: Category[]; details: Detail[];
  summary: { revenueCents: number; deductionsCents: number; cogsCents: number; operatingExpenseCents: number;
    financialResultCents: number; incomeTaxCents: number; grossProfitCents: number; resultCents: number; grossMargin: number;
    operatingMargin: number; varianceCents: number; attainment: number; elapsedMonths: number;
    budget: { revenueCents: number; cogsCents: number; expenseCents: number; resultCents: number };
    forecast: { revenueCents: number; resultCents: number } };
  dataQuality: { inferredCategories: number; uncategorizedEntries: number; salesWithoutCostCenter: number;
    budgetMonthCoverage: number; budgetCenterCoverage: number; activeCenters: number } };
type Modal = { mode: "center"; center?: Center } | { mode: "budget"; budget?: Budget } | { mode: "goal" } |
  { mode: "progress"; goal: Goal } | { mode: "clone"; budget: Budget };

export function PlanningControlCenter() {
  const currentYear = new Date().getUTCFullYear();
  const [filters, setFilters] = useState<Filters>({ year: currentYear, scenario: "base", basis: "accrual", branchId: "", costCenterId: "", budgetId: "" });
  const [data, setData] = useState<Data | null>(null), [tab, setTab] = useState<Tab>("overview"),
    [modal, setModal] = useState<Modal | null>(null), [busy, setBusy] = useState(false),
    [error, setError] = useState(""), [notice, setNotice] = useState("");
  const query = useMemo(() => { const parameters = new URLSearchParams({ year: String(filters.year), scenario: filters.scenario, basis: filters.basis });
    if (filters.branchId) parameters.set("branchId", filters.branchId); if (filters.costCenterId) parameters.set("costCenterId", filters.costCenterId);
    if (filters.budgetId) parameters.set("budgetId", filters.budgetId); return parameters.toString(); }, [filters]);
  const load = useCallback(async () => { setError(""); try { const response = await fetch(`/api/erp/planning?${query}`, { cache: "no-store" });
    const body = await response.json() as Data & { error?: string }; if (!response.ok) throw new Error(body.error || "Não foi possível carregar o planejamento."); setData(body); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível carregar o planejamento."); } }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/erp/planning?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json() as Data & { error?: string };
        if (!response.ok) throw new Error(body.error || "Não foi possível carregar o planejamento."); return body; })
      .then((body) => { setData(body); setError(""); })
      .catch((caught: unknown) => { if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Não foi possível carregar o planejamento."); });
    return () => controller.abort();
  }, [query]);
  async function command(payload: Record<string, unknown>, success: string) { setBusy(true); setError(""); setNotice("");
    try { const response = await fetch("/api/erp/planning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as { error?: string }; if (!response.ok) throw new Error(body.error || "Não foi possível concluir a operação.");
      setNotice(success); setModal(null); await load(); return true; } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível concluir a operação."); return false; }
    finally { setBusy(false); } }
  if (!data && !error) return <PlanningSkeleton />;
  if (!data) return <div className={styles.errorState}><span>!</span><h2>Planejamento indisponível</h2><p>{error}</p><button onClick={() => void load()}>Tentar novamente</button></div>;
  const activeBudget = data.budgets.find((budget) => budget.id === data.activeBudgetId) || null;
  const exportUrl = `/api/erp/planning?${query}&format=csv`;
  return <div className={styles.workspace}>
    <section className={styles.hero}>
      <div><span>CONTROLADORIA · PLANEJAMENTO GERENCIAL</span><h1>DRE, orçamento e metas</h1>
        <p>Decida com resultado por competência, cenários aprováveis, projeção anual e metas com responsáveis.</p>
        <nav aria-label="Atalhos financeiros"><Link href="/erp/contas-pagar-receber"><ErpIcon name="finance" />Contas a pagar e receber</Link>
          <Link href="/erp/contas-caixas"><ErpIcon name="accounts" />Tesouraria</Link><Link href="/erp/relatorios"><ErpIcon name="reports" />Relatórios</Link></nav></div>
      <div className={styles.heroStatus}><small>ORÇAMENTO EM ANÁLISE</small><strong>{activeBudget?.name || "Nenhum cenário selecionado"}</strong>
        <span><i className={activeBudget ? styles.goodDot : styles.warnDot} />{activeBudget ? `${statusLabel(activeBudget.status)} · versão ${activeBudget.version}` : "Crie e aprove um orçamento"}</span>
        <b>Atualizado {date.format(new Date(data.generatedAt))}</b></div>
    </section>
    {(error || notice) && <div className={error ? styles.errorBanner : styles.noticeBanner} role="status"><span>{error ? "!" : "✓"}</span>{error || notice}<button onClick={() => { setError(""); setNotice(""); }} aria-label="Fechar aviso">×</button></div>}
    <section className={styles.filterBar} aria-label="Filtros do planejamento">
      <label>Ano<div className={styles.yearStepper}><button onClick={() => setFilters((value) => ({ ...value, year: value.year - 1, budgetId: "" }))} aria-label="Ano anterior">‹</button>
        <input type="number" min="2020" max="2100" value={filters.year} onChange={(event) => setFilters((value) => ({ ...value, year: Number(event.target.value), budgetId: "" }))} />
        <button onClick={() => setFilters((value) => ({ ...value, year: value.year + 1, budgetId: "" }))} aria-label="Próximo ano">›</button></div></label>
      <label>Cenário<select value={filters.scenario} onChange={(event) => setFilters((value) => ({ ...value, scenario: event.target.value, budgetId: "" }))}>
        <option value="base">Base</option><option value="optimistic">Otimista</option><option value="conservative">Conservador</option></select></label>
      <label>Regime<select value={filters.basis} onChange={(event) => setFilters((value) => ({ ...value, basis: event.target.value }))}>
        <option value="accrual">Competência</option><option value="cash">Caixa liquidado</option></select></label>
      <label>Filial<select value={filters.branchId} onChange={(event) => setFilters((value) => ({ ...value, branchId: event.target.value }))}><option value="">Todas as filiais</option>
        {data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
      <label>Centro de custo<select value={filters.costCenterId} onChange={(event) => setFilters((value) => ({ ...value, costCenterId: event.target.value }))}><option value="">Todos os centros</option>
        {data.centers.filter((center) => center.active).map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}</select></label>
      <div className={styles.filterActions}><a href={exportUrl}><ErpIcon name="reports" />Exportar CSV</a><button onClick={() => void load()} aria-label="Atualizar dados">↻</button></div>
    </section>
    <section className={styles.kpis}>
      <Metric label="Receita líquida" value={money(data.summary.revenueCents - data.summary.deductionsCents)} detail={`${number.format(data.summary.attainment)}% do orçamento anual`} tone="green" />
      <Metric label="Lucro bruto" value={money(data.summary.grossProfitCents)} detail={`Margem bruta ${number.format(data.summary.grossMargin)}%`} />
      <Metric label="Resultado líquido" value={money(data.summary.resultCents)} detail={`Margem ${number.format(data.summary.operatingMargin)}%`} tone={data.summary.resultCents < 0 ? "red" : "green"} />
      <Metric label="Desvio do orçamento" value={signedMoney(data.summary.varianceCents)} detail={`Planejado ${money(data.summary.budget.resultCents)}`} tone={data.summary.varianceCents < 0 ? "red" : "green"} />
      <Metric label="Projeção anual" value={money(data.summary.forecast.resultCents)} detail={`Receita projetada ${money(data.summary.forecast.revenueCents)}`} />
    </section>
    <section className={styles.insights}>
      <article><span>◎</span><div><strong>{data.summary.elapsedMonths ? `${data.summary.elapsedMonths}/12 competências apuradas` : "Exercício futuro"}</strong><small>Projeção anualizada com base no período realizado.</small></div></article>
      <article><span>▤</span><div><strong>{data.dataQuality.budgetMonthCoverage}/12 meses orçados</strong><small>{data.dataQuality.budgetCenterCoverage} de {data.dataQuality.activeCenters} centros cobertos.</small></div></article>
      <article className={data.dataQuality.inferredCategories ? styles.warningInsight : ""}><span>◇</span><div><strong>{data.dataQuality.inferredCategories} classificações sugeridas</strong><small>Revise as regras para elevar a confiabilidade da DRE.</small></div></article>
    </section>
    <section className={styles.tabBar}><div role="tablist" aria-label="Visões do planejamento">
      {(["overview", "budgets", "goals", "quality"] as Tab[]).map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{tabLabel(item)}
        {item === "goals" && <b>{data.goals.filter((goal) => goal.status === "active").length}</b>}{item === "quality" && data.dataQuality.inferredCategories > 0 && <b>{data.dataQuality.inferredCategories}</b>}</button>)}</div>
      <div><button onClick={() => setModal({ mode: "center" })}>+ Centro</button><button onClick={() => setModal({ mode: "goal" })}>+ Meta</button>
        <button className={styles.primary} disabled={!data.centers.some((center) => center.active)} onClick={() => setModal({ mode: "budget" })}>+ Orçamento</button></div></section>
    {tab === "overview" && <Overview data={data} activeBudget={activeBudget} />}
    {tab === "budgets" && <Budgets data={data} activeBudget={activeBudget} setFilters={setFilters} open={setModal} command={command} busy={busy} />}
    {tab === "goals" && <Goals goals={data.goals} open={setModal} command={command} busy={busy} />}
    {tab === "quality" && <Quality data={data} open={setModal} command={command} busy={busy} />}
    {modal?.mode === "center" && <CenterModal value={modal.center} busy={busy} close={() => setModal(null)} submit={(payload) => command(payload, modal.center ? "Centro de custo atualizado." : "Centro de custo criado.")} />}
    {modal?.mode === "budget" && <BudgetModal budget={modal.budget} centers={data.centers.filter((center) => center.active)} year={filters.year} scenario={filters.scenario} busy={busy} close={() => setModal(null)} submit={(payload) => command(payload, modal.budget ? "Competências atualizadas." : "Orçamento criado como rascunho.")} />}
    {modal?.mode === "goal" && <GoalModal busy={busy} year={filters.year} close={() => setModal(null)} submit={(payload) => command(payload, "Meta criada e atribuída.")} />}
    {modal?.mode === "progress" && <ProgressModal goal={modal.goal} busy={busy} close={() => setModal(null)} submit={(payload) => command(payload, "Progresso registrado no histórico.")} />}
    {modal?.mode === "clone" && <CloneModal budget={modal.budget} busy={busy} close={() => setModal(null)} submit={(payload) => command(payload, "Cenário clonado como rascunho.")} />}
  </div>;
}

function Overview({ data, activeBudget }: { data: Data; activeBudget: Budget | null }) {
  const max = Math.max(1, ...data.months.flatMap((month) => [Math.abs(month.resultCents), Math.abs(month.budgetResultCents)]));
  return <div className={styles.overviewGrid}>
    <section className={styles.panel}><header><div><span>EVOLUÇÃO MENSAL</span><h2>Resultado realizado × planejado</h2></div><div className={styles.legend}><span><i className={styles.actualSwatch} />Realizado</span><span><i className={styles.budgetSwatch} />Orçado</span></div></header>
      <div className={styles.chart} role="img" aria-label="Gráfico mensal de resultado realizado e orçado">{data.months.map((month) => <div key={month.month} title={`${months[month.month - 1]}: realizado ${money(month.resultCents)}, orçado ${money(month.budgetResultCents)}`}>
        <span><i className={month.resultCents < 0 ? styles.negativeBar : styles.actualBar} style={{ height: `${Math.max(3, Math.abs(month.resultCents) / max * 100)}%` }} />
          <i className={styles.budgetBar} style={{ height: `${Math.max(3, Math.abs(month.budgetResultCents) / max * 100)}%` }} /></span><small>{months[month.month - 1]}</small></div>)}</div></section>
    <section className={`${styles.panel} ${styles.drePanel}`}><header><div><span>DRE GERENCIAL</span><h2>Acumulado de {data.filters.year}</h2></div><em>{data.filters.basis === "cash" ? "Caixa" : "Competência"}</em></header>
      <dl><DreRow label="(+) Receita bruta" value={data.summary.revenueCents} /><DreRow label="(-) Deduções e tributos" value={-data.summary.deductionsCents} />
        <DreRow label="(=) Receita líquida" value={data.summary.revenueCents - data.summary.deductionsCents} strong />
        <DreRow label="(-) CMV / custos diretos" value={-data.summary.cogsCents} /><DreRow label="(=) Lucro bruto" value={data.summary.grossProfitCents} strong />
        <DreRow label="(-) Despesas operacionais" value={-data.summary.operatingExpenseCents} /><DreRow label="(-) Resultado financeiro" value={-data.summary.financialResultCents} />
        <DreRow label="(-) IR / CSLL" value={-data.summary.incomeTaxCents} /><DreRow label="(=) Resultado líquido" value={data.summary.resultCents} total /></dl>
      <footer><span>Orçamento ativo</span><strong>{activeBudget?.name || "Não definido"}</strong></footer></section>
    <section className={`${styles.panel} ${styles.monthTable}`}><header><div><span>ORÇADO × REALIZADO</span><h2>Comparativo por competência</h2></div></header><div className={styles.tableScroll}><table><thead><tr><th>Mês</th><th>Receita</th><th>CMV</th><th>Despesas</th><th>Resultado</th><th>Orçado</th><th>Desvio</th></tr></thead>
      <tbody>{data.months.map((month) => <tr key={month.month}><td><strong>{months[month.month - 1]}</strong></td><td>{money(month.revenueCents)}</td><td>{money(month.cogsCents)}</td>
        <td>{money(month.operatingExpenseCents + month.financialResultCents + month.incomeTaxCents + month.deductionsCents)}</td><td className={month.resultCents < 0 ? styles.red : styles.green}>{money(month.resultCents)}</td>
        <td>{money(month.budgetResultCents)}</td><td className={month.resultCents - month.budgetResultCents < 0 ? styles.red : styles.green}>{signedMoney(month.resultCents - month.budgetResultCents)}</td></tr>)}</tbody></table></div></section>
    <section className={`${styles.panel} ${styles.detailsPanel}`}><header><div><span>DRILL-DOWN</span><h2>Composição do resultado</h2></div><small>{data.details.length} lançamentos exibidos</small></header>
      {data.details.length ? <div>{data.details.slice(0, 16).map((item) => <article key={item.id}><i className={item.amountCents >= 0 ? styles.goodDot : styles.warnDot} /><span><strong>{item.description}</strong><small>{date.format(new Date(item.date))} · {item.category} · {item.costCenter || "Sem centro"}</small></span><em>{item.source}</em><b className={item.amountCents < 0 ? styles.red : styles.green}>{signedMoney(item.amountCents)}</b></article>)}</div> : <Empty title="Nenhum lançamento no período" text="Ajuste o ano, filial ou regime para consultar outra janela." />}</section>
  </div>;
}

function Budgets({ data, activeBudget, setFilters, open, command, busy }: { data: Data; activeBudget: Budget | null;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>; open: (modal: Modal) => void;
  command: (payload: Record<string, unknown>, success: string) => Promise<boolean>; busy: boolean }) {
  return <div className={styles.budgetWorkspace}><section className={styles.budgetCards}>
    {data.budgets.length ? data.budgets.map((budget) => { const totals = budget.lines.reduce((sum, line) => ({ revenue: sum.revenue + line.revenueCents,
      costs: sum.costs + line.cogsCents + line.expenseCents }), { revenue: 0, costs: 0 }); return <article key={budget.id} className={budget.id === activeBudget?.id ? styles.selectedBudget : ""}>
        <header><div><span>{scenarioLabel(budget.scenario)} · v{budget.version}</span><h2>{budget.name}</h2></div><i className={statusClass(budget.status)}>{statusLabel(budget.status)}</i></header>
        <dl><div><dt>Receita</dt><dd>{money(totals.revenue)}</dd></div><div><dt>Resultado</dt><dd>{money(totals.revenue - totals.costs)}</dd></div><div><dt>Cobertura</dt><dd>{new Set(budget.lines.map((line) => line.month)).size}/12 meses</dd></div></dl>
        <p>{budget.notes || "Sem premissas documentadas."}</p><footer><button onClick={() => setFilters((value) => ({ ...value, budgetId: String(budget.id) }))}>Analisar</button>
          <details className={styles.actionMenu}><summary aria-label={`Ações de ${budget.name}`}>•••</summary><div>{budget.status === "draft" && <><button onClick={() => open({ mode: "budget", budget })}>Editar competências</button><button disabled={busy} onClick={() => void command({ action: "budget.status", id: budget.id, status: "approved" }, "Orçamento aprovado.")}>Aprovar</button></>}
            {budget.status === "approved" && <><button disabled={busy} onClick={() => void command({ action: "budget.status", id: budget.id, status: "active" }, "Orçamento ativado como referência.")}>Ativar referência</button><button disabled={busy} onClick={() => void command({ action: "budget.status", id: budget.id, status: "draft" }, "Orçamento reaberto para revisão.")}>Reabrir</button></>}
            {budget.status !== "archived" && <button disabled={busy} onClick={() => void command({ action: "budget.status", id: budget.id, status: "archived" }, "Orçamento arquivado.")}>Arquivar</button>}
            {budget.status === "archived" && <button disabled={busy} onClick={() => void command({ action: "budget.status", id: budget.id, status: "draft" }, "Orçamento restaurado como rascunho.")}>Restaurar</button>}
            <button onClick={() => open({ mode: "clone", budget })}>Clonar cenário</button></div></details></footer></article>; }) : <Empty title="Nenhum orçamento neste cenário" text="Crie um orçamento mensal por centro de custo e encaminhe-o para aprovação." />}
  </section>
  {activeBudget && <section className={styles.panel}><header><div><span>MATRIZ ORÇAMENTÁRIA</span><h2>{activeBudget.name}</h2></div><small>{activeBudget.lines.length} competências · {new Set(activeBudget.lines.map((line) => line.costCenterId)).size} centros</small></header>
    <div className={styles.tableScroll}><table><thead><tr><th>Centro</th><th>Mês</th><th>Receita</th><th>CMV</th><th>Despesas</th><th>Resultado</th></tr></thead><tbody>{activeBudget.lines.map((line) => <tr key={line.id}><td><strong>{line.costCenter.name}</strong><small>{line.costCenter.code}</small></td><td>{months[line.month - 1]}</td><td>{money(line.revenueCents)}</td><td>{money(line.cogsCents)}</td><td>{money(line.expenseCents)}</td><td className={line.revenueCents - line.cogsCents - line.expenseCents < 0 ? styles.red : styles.green}>{money(line.revenueCents - line.cogsCents - line.expenseCents)}</td></tr>)}</tbody></table></div></section>}
  </div>;
}

function Goals({ goals, open, command, busy }: { goals: Goal[]; open: (modal: Modal) => void;
  command: (payload: Record<string, unknown>, success: string) => Promise<boolean>; busy: boolean }) {
  const weighted = goals.filter((goal) => !["cancelled"].includes(goal.status)).reduce((sum, goal) => sum + goal.progress * goal.weight, 0),
    weights = goals.filter((goal) => !["cancelled"].includes(goal.status)).reduce((sum, goal) => sum + goal.weight, 0);
  return <div className={styles.goalsWorkspace}><section className={styles.goalSummary}><div><span>ÍNDICE PONDERADO</span><strong>{number.format(weights ? weighted / weights : 0)}%</strong><small>Progresso combinado conforme o peso de cada objetivo.</small></div>
    <dl><div><dt>Ativas</dt><dd>{goals.filter((goal) => goal.status === "active").length}</dd></div><div><dt>Atingidas</dt><dd>{goals.filter((goal) => goal.status === "achieved").length}</dd></div><div><dt>Atrasadas</dt><dd>{goals.filter((goal) => goal.overdue).length}</dd></div></dl></section>
    <section className={styles.goalGrid}>{goals.length ? goals.map((goal) => <article key={goal.id} className={goal.overdue ? styles.overdueGoal : ""}><header><div><span>{goal.metric} · peso {goal.weight}%</span><h2>{goal.title}</h2></div><i className={statusClass(goal.status)}>{statusLabel(goal.status)}</i></header>
      <div className={styles.progressHead}><strong>{goalValue(goal.current, goal.unit)}</strong><span>de {goalValue(goal.target, goal.unit)}</span></div><div className={styles.progressBar}><i style={{ width: `${goal.progress}%` }} /></div>
      <p><span>{number.format(goal.progress)}% concluído</span><span>{goal.owner || "Sem responsável"}</span></p><dl><div><dt>Início</dt><dd>{date.format(new Date(goal.startedAt))}</dd></div><div><dt>Prazo</dt><dd>{date.format(new Date(goal.dueAt))}</dd></div><div><dt>Atualizações</dt><dd>{integer.format(goal.updates.length)}</dd></div></dl>
      {goal.updates[0] && <blockquote>“{goal.updates[0].note || "Progresso atualizado"}”<small>{goal.updates[0].createdBy} · {date.format(new Date(goal.updates[0].createdAt))}</small></blockquote>}
      <footer>{!["achieved", "cancelled"].includes(goal.status) && <button className={styles.primary} onClick={() => open({ mode: "progress", goal })}>Atualizar progresso</button>}
        <details className={styles.actionMenu}><summary aria-label={`Ações de ${goal.title}`}>•••</summary><div>{goal.status === "active" && <button disabled={busy} onClick={() => void command({ action: "goal.status", id: goal.id, status: "paused" }, "Meta pausada.")}>Pausar</button>}
          {goal.status === "paused" && <button disabled={busy} onClick={() => void command({ action: "goal.status", id: goal.id, status: "active" }, "Meta retomada.")}>Retomar</button>}
          {!['cancelled', 'achieved'].includes(goal.status) && <button disabled={busy} onClick={() => void command({ action: "goal.status", id: goal.id, status: "cancelled" }, "Meta cancelada.")}>Cancelar</button>}</div></details></footer></article>) : <Empty title="Nenhuma meta neste exercício" text="Crie objetivos mensuráveis, atribua responsáveis e acompanhe o histórico de evolução." />}</section></div>;
}

function Quality({ data, open, command, busy }: { data: Data; open: (modal: Modal) => void;
  command: (payload: Record<string, unknown>, success: string) => Promise<boolean>; busy: boolean }) {
  return <div className={styles.qualityGrid}><section className={styles.panel}><header><div><span>CLASSIFICAÇÃO DRE</span><h2>Regras por categoria financeira</h2></div><small>{data.categories.length} categorias no período</small></header>
    {data.categories.length ? <div className={styles.categoryList}>{data.categories.map((category) => <article key={category.key}><span><strong>{category.label}</strong><small>{category.count} lançamentos · {money(category.amountCents)} {category.inferred ? "· classificação sugerida" : "· regra confirmada"}</small></span>
      <select aria-label={`Classificação de ${category.label}`} value={category.group} disabled={busy} onChange={(event) => void command({ action: "rule.upsert", categoryLabel: category.label, dreGroup: event.target.value }, "Classificação atualizada e DRE recalculada.")}>
        <option value="revenue">Receita</option><option value="deductions">Deduções</option><option value="cogs">CMV / custo direto</option><option value="operating_expense">Despesa operacional</option><option value="financial_result">Resultado financeiro</option><option value="income_tax">IR / CSLL</option><option value="excluded">Excluir da DRE</option></select></article>)}</div> : <Empty title="Sem categorias no período" text="As categorias aparecerão quando houver títulos financeiros na janela selecionada." />}</section>
    <section className={styles.panel}><header><div><span>ESTRUTURA GERENCIAL</span><h2>Centros de custo</h2></div><button onClick={() => open({ mode: "center" })}>+ Novo centro</button></header><div className={styles.centerList}>{data.centers.map((center) => <article key={center.id}><i className={center.active ? styles.goodDot : styles.mutedDot} /><span><strong>{center.name}</strong><small>{center.code} · {center.active ? "Ativo" : "Inativo"}</small></span><button onClick={() => open({ mode: "center", center })}>Editar</button></article>)}</div></section>
    <section className={`${styles.panel} ${styles.auditPanel}`}><header><div><span>CONFIABILIDADE</span><h2>Pontos de atenção</h2></div></header><div>
      <AuditItem good={!data.dataQuality.inferredCategories} title="Classificações confirmadas" detail={data.dataQuality.inferredCategories ? `${data.dataQuality.inferredCategories} categorias usam sugestão automática.` : "Todas as categorias do período possuem regra explícita."} />
      <AuditItem good={!data.dataQuality.uncategorizedEntries} title="Categorias preenchidas" detail={data.dataQuality.uncategorizedEntries ? `${data.dataQuality.uncategorizedEntries} lançamentos financeiros sem categoria.` : "Nenhum lançamento sem categoria na seleção."} />
      <AuditItem good={!data.dataQuality.salesWithoutCostCenter} title="Rateio comercial" detail={data.dataQuality.salesWithoutCostCenter ? `${data.dataQuality.salesWithoutCostCenter} vendas entram sem centro de custo por limitação da origem.` : "Seleção sem vendas não rateadas."} />
      <AuditItem good={data.dataQuality.budgetMonthCoverage === 12} title="Cobertura orçamentária" detail={`${data.dataQuality.budgetMonthCoverage} de 12 competências e ${data.dataQuality.budgetCenterCoverage} centros cobertos.`} /></div></section></div>;
}

function CenterModal({ value, busy, close, submit }: { value?: Center; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget);
    await submit({ action: value ? "center.update" : "center.create", ...(value ? { id: value.id } : {}), name: form.get("name"), code: form.get("code"), active: form.get("active") !== "false" }); }
  return <ModalFrame title={value ? "Editar centro de custo" : "Novo centro de custo"} eyebrow="ESTRUTURA GERENCIAL" close={close} busy={busy} onSubmit={save}>
    <div className={styles.formGrid}><label>Nome<input name="name" required maxLength={100} defaultValue={value?.name} /></label><label>Código<input name="code" required maxLength={30} defaultValue={value?.code} placeholder="COMERCIAL-SP" /></label>
      {value && <label className={styles.wide}>Situação<select name="active" defaultValue={String(value.active)}><option value="true">Ativo</option><option value="false">Inativo</option></select></label>}</div></ModalFrame>;
}

function BudgetModal({ budget, centers, year, scenario, busy, close, submit }: { budget?: Budget; centers: Center[]; year: number; scenario: string;
  busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  const [centerId, setCenterId] = useState(String(budget?.lines[0]?.costCenterId || centers[0]?.id || ""));
  const initialRows = useCallback((id: string) => Array.from({ length: 12 }, (_, index) => { const line = budget?.lines.find((item) => item.costCenterId === Number(id) && item.month === index + 1);
    return { month: index + 1, revenue: line ? line.revenueCents / 100 : 0, cogs: line ? line.cogsCents / 100 : 0, expense: line ? line.expenseCents / 100 : 0 }; }), [budget]);
  const [rows, setRows] = useState(() => initialRows(centerId));
  function changeCenter(value: string) { setCenterId(value); setRows(initialRows(value)); }
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget), lines = rows.map((row) => ({ ...row, costCenterId: centerId }));
    await submit(budget ? { action: "budget.lines", id: budget.id, lines } : { action: "budget.create", name: form.get("name"), year: form.get("year"), scenario: form.get("scenario"), notes: form.get("notes"), lines }); }
  const total = rows.reduce((sum, row) => ({ revenue: sum.revenue + Number(row.revenue), costs: sum.costs + Number(row.cogs) + Number(row.expense) }), { revenue: 0, costs: 0 });
  return <ModalFrame title={budget ? `Editar ${budget.name}` : "Novo orçamento anual"} eyebrow="CENÁRIO E PREMISSAS" close={close} busy={busy} onSubmit={save} large>
    <div className={styles.formGrid}>{!budget && <><label>Nome<input name="name" required maxLength={120} defaultValue={`Orçamento ${scenarioLabel(scenario)} ${year}`} /></label><label>Ano<input name="year" type="number" min="2020" max="2100" defaultValue={year} required /></label><label>Cenário<select name="scenario" defaultValue={scenario}><option value="base">Base</option><option value="optimistic">Otimista</option><option value="conservative">Conservador</option></select></label></>}
      <label>Centro de custo<select value={centerId} onChange={(event) => changeCenter(event.target.value)} required>{centers.map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}</select></label>
      {!budget && <label className={styles.wide}>Premissas<textarea name="notes" rows={2} maxLength={1000} placeholder="Crescimento esperado, inflação, contratações e demais premissas…" /></label>}</div>
    <div className={styles.budgetEditor}><header><strong>Competências mensais</strong><span>Resultado anual previsto <b>{currency.format(total.revenue - total.costs)}</b></span></header>
      <div className={styles.budgetRows}><div className={styles.budgetHeading}><span>Mês</span><span>Receita</span><span>CMV</span><span>Despesas</span><span>Resultado</span></div>{rows.map((row, index) => <div key={row.month}><strong>{months[row.month - 1]}</strong>
        {(["revenue", "cogs", "expense"] as const).map((field) => <label key={field}><span className={styles.srOnly}>{field} em {months[row.month - 1]}</span><input type="number" min="0" max="1000000000000" step="0.01" value={row[field]} onChange={(event) => setRows((values) => values.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: Number(event.target.value) } : item))} /></label>)}
        <b>{currency.format(Number(row.revenue) - Number(row.cogs) - Number(row.expense))}</b></div>)}</div></div></ModalFrame>;
}

function GoalModal({ busy, year, close, submit }: { busy: boolean; year: number; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); await submit({ action: "goal.create", ...values }); }
  return <ModalFrame title="Nova meta gerencial" eyebrow="OBJETIVO MENSURÁVEL" close={close} busy={busy} onSubmit={save}>
    <div className={styles.formGrid}><label className={styles.wide}>Meta<input name="title" required maxLength={160} placeholder="Elevar margem operacional" /></label><label>Indicador<input name="metric" required maxLength={80} placeholder="Margem operacional" /></label>
      <label>Responsável<input name="owner" maxLength={120} placeholder="Nome ou área" /></label><label>Unidade<select name="unit"><option value="currency">Moeda</option><option value="percent">Percentual</option><option value="number">Número</option></select></label>
      <label>Direção<select name="direction"><option value="increase">Aumentar</option><option value="decrease">Reduzir</option></select></label><label>Linha de base<input name="baseline" type="number" min="0" step="0.01" defaultValue="0" required /></label>
      <label>Realizado atual<input name="current" type="number" min="0" step="0.01" defaultValue="0" required /></label><label>Alvo<input name="target" type="number" min="0" step="0.01" required /></label>
      <label>Peso (%)<input name="weight" type="number" min="1" max="100" defaultValue="100" required /></label><label>Início<input name="startedAt" type="date" defaultValue={`${year}-01-01`} required /></label>
      <label>Prazo<input name="dueAt" type="date" defaultValue={`${year}-12-31`} required /></label><label className={styles.wide}>Contexto<textarea name="notes" maxLength={1000} rows={3} placeholder="Por que esta meta importa e como será medida?" /></label></div></ModalFrame>;
}

function ProgressModal({ goal, busy, close, submit }: { goal: Goal; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await submit({ action: "goal.progress", id: goal.id, value: form.get("value"), note: form.get("note") }); }
  return <ModalFrame title="Atualizar progresso" eyebrow={goal.title.toUpperCase()} close={close} busy={busy} onSubmit={save}>
    <div className={styles.formGrid}><div className={`${styles.goalContext} ${styles.wide}`}><span>Atual</span><strong>{goalValue(goal.current, goal.unit)}</strong><small>Alvo {goalValue(goal.target, goal.unit)} · {number.format(goal.progress)}% concluído</small></div>
      <label className={styles.wide}>Novo realizado<input name="value" type="number" min="0" step="0.01" defaultValue={goal.current} required /></label><label className={styles.wide}>Evidência ou comentário<textarea name="note" rows={3} maxLength={500} required placeholder="Explique a evolução e registre a fonte do indicador…" /></label></div></ModalFrame>;
}

function CloneModal({ budget, busy, close, submit }: { budget: Budget; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); await submit({ action: "budget.clone", id: budget.id, ...values }); }
  return <ModalFrame title="Clonar cenário" eyebrow={`ORIGEM · ${budget.name}`} close={close} busy={busy} onSubmit={save}><div className={styles.formGrid}>
    <label className={styles.wide}>Nome<input name="name" required maxLength={120} defaultValue={`${budget.name} · cópia`} /></label><label>Ano<input name="year" type="number" min="2020" max="2100" defaultValue={budget.year + 1} required /></label>
    <label>Cenário<select name="scenario" defaultValue={budget.scenario}><option value="base">Base</option><option value="optimistic">Otimista</option><option value="conservative">Conservador</option></select></label><label className={styles.wide}>Premissas<textarea name="notes" rows={3} maxLength={1000} defaultValue={budget.notes || ""} /></label></div></ModalFrame>;
}

function ModalFrame({ title, eyebrow, close, busy, onSubmit, children, large = false }: { title: string; eyebrow: string; close: () => void; busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: React.ReactNode; large?: boolean }) {
  return <ErpModal close={close} className={styles.modal} label={title}><form className={large ? styles.largeModal : ""} onSubmit={onSubmit}><header><div><span>{eyebrow}</span><h2>{title}</h2></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>{children}<footer><button type="button" onClick={close}>Cancelar</button><button className={styles.primary} disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button></footer></form></ErpModal>;
}
function Metric({ label, value, detail, tone = "" }: { label: string; value: string; detail: string; tone?: string }) { return <article className={styles.metric}><header><span>{label}</span><i className={tone === "green" ? styles.goodDot : tone === "red" ? styles.warnDot : styles.infoDot} /></header><strong className={tone === "red" ? styles.red : ""}>{value}</strong><small>{detail}</small></article>; }
function DreRow({ label, value, strong = false, total = false }: { label: string; value: number; strong?: boolean; total?: boolean }) { return <div className={total ? styles.dreTotal : strong ? styles.dreStrong : ""}><dt>{label}</dt><dd className={value < 0 ? styles.red : ""}>{signedMoney(value)}</dd></div>; }
function AuditItem({ good, title, detail }: { good: boolean; title: string; detail: string }) { return <article><i className={good ? styles.goodDot : styles.warnDot} /><span><strong>{title}</strong><small>{detail}</small></span><b>{good ? "OK" : "REVISAR"}</b></article>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className={styles.empty}><span>◇</span><strong>{title}</strong><p>{text}</p></div>; }
function PlanningSkeleton() { return <div className={styles.skeleton} aria-label="Carregando planejamento"><header /><section>{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</section><div className={styles.skeletonBody} /></div>; }
function money(cents: number) { return currency.format(cents / 100); }
function signedMoney(cents: number) { return `${cents > 0 ? "+" : ""}${money(cents)}`; }
function goalValue(value: number, unit: string) { return unit === "currency" ? currency.format(value) : unit === "percent" ? `${number.format(value)}%` : integer.format(value); }
function scenarioLabel(value: string) { return ({ base: "Base", optimistic: "Otimista", conservative: "Conservador" } as Record<string, string>)[value] || value; }
function statusLabel(value: string) { return ({ draft: "Rascunho", approved: "Aprovado", active: "Ativo", archived: "Arquivado", achieved: "Atingida", paused: "Pausada", cancelled: "Cancelada" } as Record<string, string>)[value] || value; }
function statusClass(value: string) { return ["active", "achieved", "approved"].includes(value) ? styles.statusGood : ["archived", "cancelled"].includes(value) ? styles.statusMuted : styles.statusWarn; }
function tabLabel(value: Tab) { return ({ overview: "Visão executiva", budgets: "Orçamentos", goals: "Metas", quality: "Qualidade e estrutura" } as Record<Tab, string>)[value]; }
