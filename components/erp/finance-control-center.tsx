"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ErpIcon } from "@/components/erp/erp-icon";
import { ErpModal } from "@/components/erp/modal-portal";
import styles from "./finance-control-center.module.css";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const compactMoney = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const today = () => new Date().toISOString().slice(0, 10);

type Party = { id: number; name: string; tradeName: string | null; document: string };
type SimpleRecord = { id: number; name: string; code?: string; type?: string; currentBalance?: number; primary?: boolean };
type Settlement = { id: number; amount: number; interest: number; discount: number; fee: number; method: string; status: string; occurredAt: string; settledAt: string; settledBy: string; reversedAt: string | null; reversalReason: string | null; account: { id: number; name: string } | null };
type Title = {
  id: number; type: "payable" | "receivable"; description: string; documentNumber: string | null; sourceType: string;
  amount: number; paidAmount: number; remainingAmount: number; issueAt: string; competenceAt: string | null; dueAt: string;
  status: string; effectiveStatus: string; category: string | null; paymentMethod: string | null; barcode: string | null;
  priority: string; installmentNumber: number | null; installmentCount: number | null; notes: string | null; createdAt: string;
  customer: Party | null; supplier: Party | null; branch: SimpleRecord | null; account: SimpleRecord | null; costCenter: SimpleRecord | null;
  settlements: Settlement[];
};
type FinanceData = {
  items: Title[]; customers: Party[]; suppliers: Party[]; accounts: SimpleRecord[]; costCenters: SimpleRecord[]; branches: SimpleRecord[];
  summary: { receivable: number; payable: number; netOpen: number; accountBalance: number; overdue: number; overdueReceivable: number; overduePayable: number; overdueCount: number; dueToday: number; dueTodayCount: number; next7Inflow: number; next7Outflow: number; collectionRate: number; settled: number };
  aging: Array<{ key: string; label: string; receivable: number; payable: number; count: number }>;
  forecast: Array<{ start: string; end: string; inflow: number; outflow: number; net: number; balance: number }>;
  breakdown: { categories: Breakdown[]; counterparties: Breakdown[] };
  pagination: { page: number; pageSize: number; total: number; pages: number }; generatedAt: string;
};
type Breakdown = { label: string; receivable: number; payable: number; total: number; count: number };
type Tab = "titles" | "forecast" | "aging" | "accounts";
type Modal = { kind: "create"; copy?: Title } | { kind: "edit"; title: Title } | { kind: "settle"; title: Title } | { kind: "detail"; title: Title } | { kind: "reschedule" | "cancel" | "reopen"; title: Title } | { kind: "reverse"; title: Title; settlement: Settlement } | { kind: "batch"; action: "cancel" | "reschedule" | "priority" };
type Filters = { search: string; type: string; status: string; priority: string; branchId: string; accountId: string; costCenterId: string; from: string; to: string; sort: string };
const EMPTY_FILTERS: Filters = { search: "", type: "", status: "", priority: "", branchId: "", accountId: "", costCenterId: "", from: "", to: "", sort: "due_asc" };

export function FinanceControlCenter() {
  const [data, setData] = useState<FinanceData | null>(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<Tab>("titles");
  const [modal, setModal] = useState<Modal | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    Object.entries(filters).forEach(([key, value]) => value && params.set(key, value));
    return params.toString();
  }, [filters, page]);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/erp/finance?${query}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Não foi possível carregar o financeiro.");
      setData(payload);
      setSelected((current) => current.filter((id) => payload.items.some((item: Title) => item.id === id)));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "Não foi possível carregar o financeiro.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); requestRef.current?.abort(); };
  }, [load]);

  async function send(url: string, method: "POST" | "PATCH", payload: Record<string, unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "A operação não pôde ser concluída.");
      setModal(null); setSelected([]); setNotice(success); await load(); return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "A operação não pôde ser concluída.");
      return false;
    } finally { setBusy(false); }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPage(1); setFilters(draft); }
  function clearFilters() { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setPage(1); }
  async function exportCsv() {
    setError("");
    try {
      const response = await fetch(`/api/erp/finance?${query}&format=csv`);
      if (!response.ok) throw new Error("Não foi possível exportar os títulos.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "contas-pagar-receber.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível exportar os títulos."); }
  }
  const allSelected = Boolean(data?.items.length) && data!.items.every((item) => selected.includes(item.id));

  if (!data && loading) return <FinanceSkeleton />;
  if (!data) return <ErrorState message={error} retry={() => void load()} />;

  return <div className={styles.workspace}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}><span>CONTROLE FINANCEIRO</span><h1>Contas a pagar e receber</h1><p>Liquide, projete e priorize compromissos com caixa, centros de custo e trilha de auditoria integrados.</p></div>
      <div className={styles.heroBalance}><small>Posição consolidada em contas</small><strong>{money.format(data.summary.accountBalance)}</strong><span className={data.summary.netOpen >= 0 ? styles.positive : styles.negative}>Saldo futuro {money.format(data.summary.netOpen)}</span><time dateTime={data.generatedAt}>Atualizado {relativeTime(data.generatedAt)}</time></div>
      <nav aria-label="Atalhos financeiros"><Link href="/erp/contas-caixas"><ErpIcon name="accounts" />Contas e caixas</Link><Link href="/erp/conciliacao-bancaria"><ErpIcon name="finance" />Conciliação</Link><Link href="/erp/dre-orcamento-metas"><ErpIcon name="planning" />Planejamento</Link></nav>
    </header>

    {notice && <div className={styles.notice} role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Fechar aviso">×</button></div>}
    {error && <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Fechar erro">×</button></div>}

    <section className={styles.kpis} aria-label="Indicadores financeiros">
      <Metric label="A receber" value={money.format(data.summary.receivable)} detail={`Próximos 7 dias: ${money.format(data.summary.next7Inflow)}`} tone="green" />
      <Metric label="A pagar" value={money.format(data.summary.payable)} detail={`Próximos 7 dias: ${money.format(data.summary.next7Outflow)}`} tone="blue" />
      <Metric label="Vencido" value={money.format(data.summary.overdue)} detail={`${data.summary.overdueCount} título(s) exigem ação`} tone={data.summary.overdue ? "red" : "green"} />
      <Metric label="Vence hoje" value={money.format(data.summary.dueToday)} detail={`${data.summary.dueTodayCount} compromisso(s)`} tone={data.summary.dueToday ? "amber" : "neutral"} />
      <Metric label="Índice de recebimento" value={`${number.format(data.summary.collectionRate)}%`} detail="Valores vencidos já liquidados" tone={data.summary.collectionRate >= 85 ? "green" : "amber"} />
      <Metric label="Saldo em aberto" value={money.format(data.summary.netOpen)} detail="Receber menos pagar" tone={data.summary.netOpen >= 0 ? "green" : "red"} />
    </section>

    {(data.summary.overdueCount > 0 || data.summary.next7Outflow > data.summary.next7Inflow + data.summary.accountBalance) && <section className={styles.attention} aria-label="Alertas prioritários">
      <div><b>!</b><span><strong>Prioridades do caixa</strong><small>{data.summary.overdueCount ? `${data.summary.overdueCount} título(s) vencido(s), sendo ${money.format(data.summary.overdueReceivable)} a receber.` : "Nenhum vencimento em atraso."}</small></span></div>
      <button type="button" onClick={() => { setDraft((value) => ({ ...value, status: "overdue" })); setFilters((value) => ({ ...value, status: "overdue" })); setPage(1); setTab("titles"); }}>Ver pendências</button>
    </section>}

    <div className={styles.tabRow}>
      <div role="tablist" aria-label="Visões financeiras">{([ ["titles", "Títulos"], ["forecast", "Fluxo de caixa"], ["aging", "Aging e concentração"], ["accounts", "Contas"] ] as Array<[Tab, string]>).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
      <div><button type="button" onClick={() => void exportCsv()}>Exportar CSV</button><button className={styles.primary} type="button" onClick={() => setModal({ kind: "create" })}>+ Novo lançamento</button></div>
    </div>

    {tab === "titles" && <>
      <form className={styles.filters} onSubmit={applyFilters}>
        <label className={styles.search}><span>Buscar</span><input value={draft.search} onChange={(event) => setDraft({ ...draft, search: event.target.value })} placeholder="Descrição, documento, cliente ou fornecedor" /></label>
        <FilterSelect label="Tipo" value={draft.type} change={(value) => setDraft({ ...draft, type: value })} options={[["", "Pagar e receber"], ["receivable", "A receber"], ["payable", "A pagar"]]} />
        <FilterSelect label="Status" value={draft.status} change={(value) => setDraft({ ...draft, status: value })} options={[["", "Todos os status"], ["overdue", "Vencidos"], ["open", "Em aberto"], ["partial", "Parciais"], ["paid", "Liquidados"], ["cancelled", "Cancelados"]]} />
        <FilterSelect label="Prioridade" value={draft.priority} change={(value) => setDraft({ ...draft, priority: value })} options={[["", "Todas"], ["urgent", "Urgente"], ["high", "Alta"], ["normal", "Normal"], ["low", "Baixa"]]} />
        <FilterSelect label="Filial" value={draft.branchId} change={(value) => setDraft({ ...draft, branchId: value })} options={[["", "Todas as filiais"], ...data.branches.map((item) => [String(item.id), item.name] as [string, string])]} />
        <FilterSelect label="Conta prevista" value={draft.accountId} change={(value) => setDraft({ ...draft, accountId: value })} options={[["", "Todas as contas"], ...data.accounts.map((item) => [String(item.id), item.name] as [string, string])]} />
        <label><span>De</span><input type="date" value={draft.from} max={draft.to || undefined} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label><span>Até</span><input type="date" value={draft.to} min={draft.from || undefined} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <FilterSelect label="Ordenar" value={draft.sort} change={(value) => setDraft({ ...draft, sort: value })} options={[["due_asc", "Vencimento mais próximo"], ["due_desc", "Vencimento mais distante"], ["amount_desc", "Maior valor"], ["created_desc", "Mais recentes"]]} />
        <div className={styles.filterActions}><button type="button" onClick={clearFilters}>Limpar</button><button className={styles.primary} type="submit">Aplicar filtros</button></div>
      </form>

      {selected.length > 0 && <div className={styles.batchBar}><span><strong>{selected.length}</strong> título(s) selecionado(s)</span><div><button type="button" onClick={() => setModal({ kind: "batch", action: "priority" })}>Alterar prioridade</button><button type="button" onClick={() => setModal({ kind: "batch", action: "reschedule" })}>Reagendar</button><button type="button" className={styles.dangerButton} onClick={() => setModal({ kind: "batch", action: "cancel" })}>Cancelar</button><button type="button" onClick={() => setSelected([])}>Limpar seleção</button></div></div>}

      <section className={styles.listPanel} aria-busy={loading}>
        <header><div><span>CARTEIRA FINANCEIRA</span><h2>Compromissos e recebíveis</h2><p>{data.pagination.total} registro(s) no recorte atual</p></div>{loading && <small>Atualizando…</small>}</header>
        <div className={styles.tableScroll}><table><thead><tr><th className={styles.check}><input type="checkbox" aria-label="Selecionar página" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? data.items.map((item) => item.id) : [])} /></th><th>Lançamento</th><th>Contraparte</th><th>Vencimento</th><th>Valor / saldo</th><th>Status</th><th>Classificação</th><th><span className={styles.srOnly}>Ações</span></th></tr></thead><tbody>{data.items.map((title) => <TitleRow key={title.id} title={title} selected={selected.includes(title.id)} toggle={() => setSelected((current) => current.includes(title.id) ? current.filter((id) => id !== title.id) : [...current, title.id])} open={setModal} />)}</tbody></table></div>
        <div className={styles.mobileList}>{data.items.map((title) => <TitleCard key={title.id} title={title} selected={selected.includes(title.id)} toggle={() => setSelected((current) => current.includes(title.id) ? current.filter((id) => id !== title.id) : [...current, title.id])} open={setModal} />)}</div>
        {!data.items.length && <EmptyState title="Nenhum título encontrado" text="Ajuste os filtros ou crie um novo lançamento financeiro." action={() => setModal({ kind: "create" })} />}
        <footer className={styles.pagination}><span>Página {data.pagination.page} de {data.pagination.pages}</span><div><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Anterior</button><button type="button" disabled={page >= data.pagination.pages || loading} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></footer>
      </section>
    </>}

    {tab === "forecast" && <ForecastView data={data} />}
    {tab === "aging" && <AgingView data={data} />}
    {tab === "accounts" && <AccountsView data={data} />}
    {modal && <FinanceDialog modal={modal} data={data} busy={busy} close={() => setModal(null)} open={setModal} send={send} selected={selected} />}
  </div>;
}

function TitleRow({ title, selected, toggle, open }: { title: Title; selected: boolean; toggle: () => void; open: (modal: Modal) => void }) {
  const party = title.customer || title.supplier;
  return <tr className={selected ? styles.selected : ""}><td className={styles.check}><input type="checkbox" checked={selected} onChange={toggle} aria-label={`Selecionar ${title.description}`} /></td><td><button className={styles.titleButton} type="button" onClick={() => open({ kind: "detail", title })}><span className={`${styles.kind} ${styles[title.type]}`}>{title.type === "receivable" ? "Receber" : "Pagar"}</span><strong>{title.description}</strong><small>{title.documentNumber || "Sem documento"}{title.installmentCount ? ` · ${title.installmentNumber}/${title.installmentCount}` : ""}</small></button></td><td><strong>{party?.tradeName || party?.name || "Sem vínculo"}</strong><small>{title.branch?.name || "Todas as filiais"}</small></td><td><strong className={title.effectiveStatus === "overdue" ? styles.overdueText : ""}>{date(title.dueAt)}</strong><small>{dueLabel(title)}</small></td><td><strong>{money.format(title.amount)}</strong><small>Saldo {money.format(title.remainingAmount)}</small></td><td><Status value={title.effectiveStatus} /></td><td><strong>{title.category || "Sem categoria"}</strong><small>{title.costCenter?.name || "Sem centro de custo"}</small></td><td><ActionMenu title={title} open={open} /></td></tr>;
}

function TitleCard({ title, selected, toggle, open }: { title: Title; selected: boolean; toggle: () => void; open: (modal: Modal) => void }) {
  const party = title.customer || title.supplier;
  return <article className={`${styles.titleCard} ${selected ? styles.selected : ""}`}><header><label><input type="checkbox" checked={selected} onChange={toggle} /><span className={`${styles.kind} ${styles[title.type]}`}>{title.type === "receivable" ? "Receber" : "Pagar"}</span></label><Status value={title.effectiveStatus} /></header><button className={styles.cardMain} type="button" onClick={() => open({ kind: "detail", title })}><strong>{title.description}</strong><small>{party?.tradeName || party?.name || "Sem vínculo"} · {title.documentNumber || "sem documento"}</small></button><dl><div><dt>Vencimento</dt><dd className={title.effectiveStatus === "overdue" ? styles.overdueText : ""}>{date(title.dueAt)}</dd></div><div><dt>Saldo</dt><dd>{money.format(title.remainingAmount)}</dd></div><div><dt>Categoria</dt><dd>{title.category || "—"}</dd></div></dl><ActionButtons title={title} open={open} /></article>;
}

function ActionMenu({ title, open }: { title: Title; open: (modal: Modal) => void }) {
  return <details className={styles.actionMenu}><summary aria-label={`Ações de ${title.description}`}>•••</summary><div><button type="button" onClick={() => open({ kind: "detail", title })}>Ver detalhes</button>{["open", "partial"].includes(title.status) && <button type="button" onClick={() => open({ kind: "settle", title })}>Dar baixa</button>}<button type="button" onClick={() => open({ kind: "edit", title })}>Editar</button>{!["paid", "cancelled"].includes(title.status) && <button type="button" onClick={() => open({ kind: "reschedule", title })}>Reagendar</button>}<button type="button" onClick={() => open({ kind: "create", copy: title })}>Duplicar</button>{title.status === "cancelled" ? <button type="button" onClick={() => open({ kind: "reopen", title })}>Reabrir</button> : title.status !== "paid" && !title.settlements.some((item) => item.status === "posted") && <button className={styles.dangerText} type="button" onClick={() => open({ kind: "cancel", title })}>Cancelar</button>}</div></details>;
}

function ActionButtons({ title, open }: { title: Title; open: (modal: Modal) => void }) {
  return <footer>{["open", "partial"].includes(title.status) && <button className={styles.primary} type="button" onClick={() => open({ kind: "settle", title })}>Dar baixa</button>}<button type="button" onClick={() => open({ kind: "detail", title })}>Detalhes</button><ActionMenu title={title} open={open} /></footer>;
}

function ForecastView({ data }: { data: FinanceData }) {
  const max = Math.max(1, ...data.forecast.flatMap((row) => [row.inflow, row.outflow]));
  return <div className={styles.analyticsGrid}><section className={`${styles.panel} ${styles.forecastPanel}`}><header><div><span>PROJEÇÃO DE 8 SEMANAS</span><h2>Fluxo de caixa previsto</h2><p>Parte do saldo atual e considera os títulos ainda abertos.</p></div><strong>{money.format(data.forecast.at(-1)?.balance || data.summary.accountBalance)}<small>saldo projetado</small></strong></header><div className={styles.forecastChart}>{data.forecast.map((row) => <div key={row.start}><span><i className={styles.inflow} style={{ height: `${Math.max(3, row.inflow / max * 100)}%` }} title={`Entradas ${money.format(row.inflow)}`} /><i className={styles.outflow} style={{ height: `${Math.max(3, row.outflow / max * 100)}%` }} title={`Saídas ${money.format(row.outflow)}`} /></span><small>{date(row.start).slice(0, 5)}</small></div>)}</div><div className={styles.legend}><span><i className={styles.inflow} />Entradas</span><span><i className={styles.outflow} />Saídas</span></div></section><section className={styles.panel}><header><div><span>AGENDA FINANCEIRA</span><h2>Semanas projetadas</h2></div></header><div className={styles.weekList}>{data.forecast.map((row) => <article key={row.start}><span><strong>{date(row.start)} — {date(row.end)}</strong><small>Entrada {money.format(row.inflow)} · saída {money.format(row.outflow)}</small></span><b className={row.net >= 0 ? styles.positiveText : styles.overdueText}>{row.net >= 0 ? "+" : ""}{money.format(row.net)}</b></article>)}</div></section></div>;
}

function AgingView({ data }: { data: FinanceData }) {
  const max = Math.max(1, ...data.aging.map((row) => row.receivable + row.payable));
  return <div className={styles.analyticsGrid}><section className={styles.panel}><header><div><span>AGING LIST</span><h2>Idade dos saldos</h2><p>Concentração por faixa de atraso e valores a vencer.</p></div></header><div className={styles.agingList}>{data.aging.map((row) => <article key={row.key}><header><strong>{row.label}</strong><small>{row.count} título(s)</small></header><div><i className={styles.inflow} style={{ width: `${row.receivable / max * 100}%` }} /><i className={styles.outflow} style={{ width: `${row.payable / max * 100}%` }} /></div><footer><span>A receber {money.format(row.receivable)}</span><span>A pagar {money.format(row.payable)}</span></footer></article>)}</div></section><BreakdownPanel title="Concentração por contraparte" eyebrow="RISCO E RELACIONAMENTO" rows={data.breakdown.counterparties} /><BreakdownPanel title="Categorias financeiras" eyebrow="COMPOSIÇÃO DA CARTEIRA" rows={data.breakdown.categories} /></div>;
}

function BreakdownPanel({ title, eyebrow, rows }: { title: string; eyebrow: string; rows: Breakdown[] }) {
  const max = Math.max(1, ...rows.map((row) => row.total));
  return <section className={styles.panel}><header><div><span>{eyebrow}</span><h2>{title}</h2></div></header><div className={styles.breakdown}>{rows.map((row) => <article key={row.label}><span><strong>{row.label}</strong><small>{row.count} título(s) · {compactMoney.format(row.total)}</small></span><i><b style={{ width: `${row.total / max * 100}%` }} /></i></article>)}{!rows.length && <p>Nenhum saldo para analisar.</p>}</div></section>;
}

function AccountsView({ data }: { data: FinanceData }) {
  return <section className={styles.accountsView}><header><div><span>TESOURARIA INTEGRADA</span><h2>Saldo por conta financeira</h2><p>Baixas com conta informada atualizam estes saldos automaticamente.</p></div><Link href="/erp/contas-caixas">Gerenciar contas →</Link></header><div>{data.accounts.map((account) => <article key={account.id}><ErpIcon name="accounts" /><span><strong>{account.name}</strong><small>{accountType(account.type)}</small></span><b className={(account.currentBalance || 0) < 0 ? styles.overdueText : ""}>{money.format(account.currentBalance || 0)}</b></article>)}{!data.accounts.length && <EmptyState title="Nenhuma conta ativa" text="Cadastre contas bancárias, caixas ou carteiras para conciliar as baixas." />}</div></section>;
}

function FinanceDialog({ modal, data, busy, close, open, send, selected }: { modal: Modal; data: FinanceData; busy: boolean; close: () => void; open: (modal: Modal | null) => void; send: (url: string, method: "POST" | "PATCH", payload: Record<string, unknown>, success: string) => Promise<boolean>; selected: number[] }) {
  if (modal.kind === "create" || modal.kind === "edit") return <TitleForm modal={modal} data={data} busy={busy} close={close} submit={(payload) => modal.kind === "edit" ? send(`/api/erp/finance/${modal.title.id}`, "PATCH", { action: "update", ...payload }, "Título atualizado com sucesso.") : send("/api/erp/finance", "POST", payload, modal.copy ? "Título duplicado com sucesso." : "Lançamento financeiro criado com sucesso.")} />;
  if (modal.kind === "settle") return <SettlementForm title={modal.title} accounts={data.accounts} busy={busy} close={close} submit={(payload) => send(`/api/erp/finance/${modal.title.id}`, "PATCH", { action: "settle", ...payload }, "Baixa registrada e caixa atualizado.")} />;
  if (modal.kind === "detail") return <DetailDialog title={modal.title} close={close} openReverse={(settlement) => open({ kind: "reverse", title: modal.title, settlement })} />;
  if (modal.kind === "reverse") return <ReasonDialog title="Estornar baixa" description={`Esta ação reabrirá o saldo de ${modal.title.description} e desfará o movimento da conta financeira.`} field="reason" busy={busy} close={close} confirm="Confirmar estorno" submit={(payload) => send(`/api/erp/finance/${modal.title.id}`, "PATCH", { action: "reverse_settlement", settlementId: modal.settlement.id, ...payload }, "Baixa estornada e saldo financeiro corrigido.")} />;
  if (modal.kind === "batch") return <BatchDialog modal={modal} count={selected.length} busy={busy} close={close} submit={(payload) => send("/api/erp/finance/batch", "POST", { action: modal.action, ids: selected, ...payload }, `${selected.length} título(s) atualizado(s).`)} />;
  return <ReasonDialog title={modal.kind === "reschedule" ? "Reagendar vencimento" : modal.kind === "reopen" ? "Reabrir título" : "Cancelar título"} description={modal.kind === "reschedule" ? "A nova data ficará registrada na trilha de auditoria." : `Informe o motivo para ${modal.kind === "reopen" ? "reabrir" : "cancelar"} ${modal.title.description}.`} field={modal.kind === "reschedule" ? "reschedule" : "reason"} busy={busy} close={close} confirm={modal.kind === "reschedule" ? "Salvar vencimento" : modal.kind === "reopen" ? "Reabrir" : "Cancelar título"} danger={modal.kind === "cancel"} submit={(payload) => send(`/api/erp/finance/${modal.title.id}`, "PATCH", { action: modal.kind, ...payload }, modal.kind === "reschedule" ? "Vencimento reagendado." : modal.kind === "reopen" ? "Título reaberto." : "Título cancelado.")} />;
}

function TitleForm({ modal, data, busy, close, submit }: { modal: Extract<Modal, { kind: "create" | "edit" }>; data: FinanceData; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  const source = modal.kind === "edit" ? modal.title : modal.copy;
  const [type, setType] = useState(source?.type || "receivable");
  const [seriesMode, setSeriesMode] = useState("single");
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget)); payload.requestId = crypto.randomUUID(); await submit(payload); }
  return <ErpModal close={close} label={modal.kind === "edit" ? "Editar título financeiro" : "Novo lançamento financeiro"} className={styles.modal}><form onSubmit={save}><header><div><span>{modal.kind === "edit" ? "MANUTENÇÃO AUDITADA" : "NOVO COMPROMISSO"}</span><h2>{modal.kind === "edit" ? "Editar título" : modal.copy ? "Duplicar título" : "Novo lançamento"}</h2><p>Classifique corretamente para manter projeções e relatórios confiáveis.</p></div><button type="button" onClick={close} aria-label="Fechar">×</button></header><div className={styles.formGrid}>
    <label><span>Tipo *</span><select name="type" value={type} onChange={(event) => setType(event.target.value as "receivable" | "payable")}><option value="receivable">Conta a receber</option><option value="payable">Conta a pagar</option></select></label>
    <label><span>{type === "receivable" ? "Cliente" : "Fornecedor"}</span><select name={type === "receivable" ? "customerId" : "supplierId"} defaultValue={String(type === "receivable" ? source?.customer?.id || "" : source?.supplier?.id || "")}><option value="">Sem vínculo</option>{(type === "receivable" ? data.customers : data.suppliers).map((item) => <option value={item.id} key={item.id}>{item.tradeName || item.name} · {formatDocument(item.document)}</option>)}</select></label>
    <label className={styles.wide}><span>Descrição *</span><input name="description" required minLength={3} maxLength={240} defaultValue={source?.description || ""} placeholder="Ex.: Mensalidade do contrato de suporte" /></label>
    <label><span>Documento</span><input name="documentNumber" maxLength={100} defaultValue={source?.documentNumber || ""} placeholder="NF, contrato ou referência" /></label>
    <label><span>Categoria</span><input name="category" maxLength={80} defaultValue={source?.category || ""} list="finance-categories" placeholder="Ex.: Serviços, aluguel" /><datalist id="finance-categories">{["Vendas", "Serviços", "Impostos", "Fornecedores", "Folha", "Marketing", "Logística", "Infraestrutura", "Assinaturas"].map((item) => <option key={item}>{item}</option>)}</datalist></label>
    <label><span>Emissão *</span><input name="issueAt" type="date" required defaultValue={source?.issueAt?.slice(0, 10) || today()} /></label>
    <label><span>Competência</span><input name="competenceAt" type="date" defaultValue={source?.competenceAt?.slice(0, 10) || ""} /></label>
    <label><span>Vencimento *</span><input name="dueAt" type="date" required defaultValue={source?.dueAt?.slice(0, 10) || today()} /></label>
    <label><span>{seriesMode === "recurring" ? "Valor por repetição *" : seriesMode === "installments" ? "Valor total *" : "Valor *"}</span><input name="amount" type="number" min="0.01" step="0.01" required defaultValue={source?.amount || ""} /></label>
    <label><span>Filial</span><select name="branchId" defaultValue={String(source?.branch?.id || "")}><option value="">Não definida</option>{data.branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label><span>Conta prevista</span><select name="accountId" defaultValue={String(source?.account?.id || "")}><option value="">Não definida</option>{data.accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label><span>Centro de custo</span><select name="costCenterId" defaultValue={String(source?.costCenter?.id || "")}><option value="">Não definido</option>{data.costCenters.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
    <label><span>Prioridade</span><select name="priority" defaultValue={source?.priority || "normal"}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
    <label><span>Meio previsto</span><select name="paymentMethod" defaultValue={source?.paymentMethod || ""}><option value="">Não definido</option>{paymentOptions()}</select></label>
    <label><span>Código de barras / linha</span><input name="barcode" maxLength={160} defaultValue={source?.barcode || ""} /></label>
    {modal.kind === "create" && <><label><span>Forma do lançamento</span><select name="seriesMode" value={seriesMode} onChange={(event) => setSeriesMode(event.target.value)}><option value="single">Único</option><option value="installments">Parcelado</option><option value="recurring">Recorrente</option></select></label>{seriesMode !== "single" && <><label><span>{seriesMode === "installments" ? "Parcelas" : "Repetições"}</span><input name="installmentCount" type="number" min="2" max={seriesMode === "installments" ? 120 : 60} defaultValue="3" required /></label><label><span>Periodicidade</span><select name="frequency" defaultValue="monthly"><option value="weekly">Semanal</option><option value="monthly">Mensal</option><option value="bimonthly">Bimestral</option><option value="quarterly">Trimestral</option><option value="yearly">Anual</option></select></label></>}</>}
    <label className={styles.wide}><span>Observações</span><textarea name="notes" maxLength={1000} defaultValue={source?.notes || ""} rows={3} /></label>
  </div><footer><button type="button" onClick={close}>Voltar</button><button className={styles.primary} disabled={busy}>{busy ? "Salvando…" : modal.kind === "edit" ? "Salvar alterações" : "Criar lançamento"}</button></footer></form></ErpModal>;
}

function SettlementForm({ title, accounts, busy, close, submit }: { title: Title; accounts: SimpleRecord[]; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await submit(Object.fromEntries(new FormData(event.currentTarget))); }
  return <ErpModal close={close} label="Registrar baixa financeira" className={styles.modal}><form onSubmit={save}><header><div><span>BAIXA COM IMPACTO EM CAIXA</span><h2>{title.description}</h2><p>Saldo principal em aberto: <strong>{money.format(title.remainingAmount)}</strong></p></div><button type="button" onClick={close} aria-label="Fechar">×</button></header><div className={styles.formGrid}><label><span>Valor pago/recebido *</span><input name="amount" type="number" min="0.01" max={title.remainingAmount} step="0.01" defaultValue={title.remainingAmount} required /></label><label><span>Data da ocorrência *</span><input name="occurredAt" type="date" defaultValue={today()} required /></label><label><span>Conta financeira</span><select name="accountId" defaultValue={String(title.account?.id || "")}><option value="">Baixa sem movimento de conta</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {money.format(account.currentBalance || 0)}</option>)}</select></label><label><span>Meio *</span><select name="method" defaultValue={title.paymentMethod || "pix"}>{paymentOptions()}</select></label><label><span>Juros</span><input name="interest" type="number" min="0" step="0.01" defaultValue="0" /></label><label><span>Desconto</span><input name="discount" type="number" min="0" max={title.remainingAmount} step="0.01" defaultValue="0" /></label><label><span>Tarifa</span><input name="fee" type="number" min="0" step="0.01" defaultValue="0" /></label><label className={styles.wide}><span>Observações</span><textarea name="notes" maxLength={1000} rows={3} /></label></div><aside className={styles.formHint}>Ao selecionar uma conta, a baixa criará automaticamente o crédito ou débito correspondente. Descontos reduzem o principal; juros e tarifas compõem o valor de caixa.</aside><footer><button type="button" onClick={close}>Voltar</button><button className={styles.primary} disabled={busy}>{busy ? "Processando…" : "Confirmar baixa"}</button></footer></form></ErpModal>;
}

function DetailDialog({ title, close, openReverse }: { title: Title; close: () => void; openReverse: (settlement: Settlement) => void }) {
  const party = title.customer || title.supplier;
  return <ErpModal close={close} label="Detalhes do título financeiro" className={`${styles.modal} ${styles.detailModal}`}><article><header><div><span>HISTÓRICO DO TÍTULO</span><h2>{title.description}</h2><p>{party?.tradeName || party?.name || "Sem contraparte"} · {title.documentNumber || "sem documento"}</p></div><button type="button" onClick={close} aria-label="Fechar">×</button></header><section className={styles.detailSummary}><div><small>Valor original</small><strong>{money.format(title.amount)}</strong></div><div><small>Saldo aberto</small><strong>{money.format(title.remainingAmount)}</strong></div><div><small>Vencimento</small><strong>{date(title.dueAt)}</strong></div><div><small>Status</small><Status value={title.effectiveStatus} /></div></section><dl className={styles.detailMeta}><div><dt>Categoria</dt><dd>{title.category || "Não informada"}</dd></div><div><dt>Centro de custo</dt><dd>{title.costCenter?.name || "Não informado"}</dd></div><div><dt>Filial</dt><dd>{title.branch?.name || "Não informada"}</dd></div><div><dt>Conta prevista</dt><dd>{title.account?.name || "Não informada"}</dd></div><div><dt>Emissão / competência</dt><dd>{date(title.issueAt)} / {title.competenceAt ? date(title.competenceAt) : "—"}</dd></div><div><dt>Origem</dt><dd>{sourceLabel(title.sourceType)}</dd></div></dl>{title.notes && <div className={styles.notes}><strong>Observações</strong><p>{title.notes}</p></div>}<section className={styles.settlements}><header><div><span>LIQUIDAÇÕES</span><h3>Histórico de baixas</h3></div><b>{title.settlements.length}</b></header>{title.settlements.map((settlement) => <article key={settlement.id} className={settlement.status === "reversed" ? styles.reversed : ""}><span><strong>{money.format(settlement.amount)} · {methodLabel(settlement.method)}</strong><small>{date(settlement.occurredAt)} · {settlement.account?.name || "sem conta"} · por {settlement.settledBy}</small>{(settlement.interest || settlement.discount || settlement.fee) ? <small>Juros {money.format(settlement.interest)} · desconto {money.format(settlement.discount)} · tarifa {money.format(settlement.fee)}</small> : null}{settlement.reversalReason && <small>Estornado: {settlement.reversalReason}</small>}</span>{settlement.status === "posted" && <button type="button" onClick={() => openReverse(settlement)}>Estornar</button>}</article>)}{!title.settlements.length && <p>Nenhuma baixa registrada.</p>}</section><footer><button type="button" onClick={close}>Fechar</button></footer></article></ErpModal>;
}

function ReasonDialog({ title, description, field, busy, close, submit, confirm, danger = false }: { title: string; description: string; field: "reason" | "reschedule"; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean>; confirm: string; danger?: boolean }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await submit(Object.fromEntries(new FormData(event.currentTarget))); }
  return <ErpModal close={close} label={title} className={`${styles.modal} ${styles.smallModal}`}><form onSubmit={save}><header><div><span>ALTERAÇÃO AUDITADA</span><h2>{title}</h2><p>{description}</p></div><button type="button" onClick={close} aria-label="Fechar">×</button></header><div className={styles.formGrid}>{field === "reschedule" && <label><span>Novo vencimento *</span><input name="dueAt" type="date" min={today()} required /></label>}<label className={styles.wide}><span>Motivo *</span><textarea name="reason" minLength={5} maxLength={500} required rows={4} placeholder="Descreva o motivo da alteração" /></label></div><footer><button type="button" onClick={close}>Voltar</button><button className={danger ? styles.dangerAction : styles.primary} disabled={busy}>{busy ? "Processando…" : confirm}</button></footer></form></ErpModal>;
}

function BatchDialog({ modal, count, busy, close, submit }: { modal: Extract<Modal, { kind: "batch" }>; count: number; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<boolean> }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await submit(Object.fromEntries(new FormData(event.currentTarget))); }
  return <ErpModal close={close} label="Ação financeira em lote" className={`${styles.modal} ${styles.smallModal}`}><form onSubmit={save}><header><div><span>AÇÃO EM LOTE</span><h2>{modal.action === "priority" ? "Alterar prioridade" : modal.action === "reschedule" ? "Reagendar títulos" : "Cancelar títulos"}</h2><p>A alteração será aplicada a {count} título(s) e registrada em auditoria.</p></div><button type="button" onClick={close} aria-label="Fechar">×</button></header><div className={styles.formGrid}>{modal.action === "priority" ? <label className={styles.wide}><span>Nova prioridade *</span><select name="priority" defaultValue="high"><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label> : <>{modal.action === "reschedule" && <label><span>Novo vencimento *</span><input name="dueAt" type="date" min={today()} required /></label>}<label className={styles.wide}><span>Motivo *</span><textarea name="reason" minLength={5} maxLength={500} rows={4} required /></label></>}</div><footer><button type="button" onClick={close}>Voltar</button><button className={modal.action === "cancel" ? styles.dangerAction : styles.primary} disabled={busy}>{busy ? "Processando…" : "Aplicar alteração"}</button></footer></form></ErpModal>;
}

function FilterSelect({ label, value, change, options }: { label: string; value: string; change: (value: string) => void; options: Array<[string, string]> }) { return <label><span>{label}</span><select value={value} onChange={(event) => change(event.target.value)}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>; }
function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "green" | "blue" | "red" | "amber" | "neutral" }) { return <article className={`${styles.metric} ${styles[tone]}`}><header><span>{label}</span><i /></header><strong>{value}</strong><small>{detail}</small></article>; }
function Status({ value }: { value: string }) { return <span className={`${styles.status} ${styles[`status_${value}`] || ""}`}>{statusLabel(value)}</span>; }
function EmptyState({ title, text, action }: { title: string; text: string; action?: () => void }) { return <div className={styles.empty}><span>◎</span><strong>{title}</strong><p>{text}</p>{action && <button type="button" onClick={action}>Criar lançamento</button>}</div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className={styles.errorState}><span>!</span><h2>O financeiro não pôde ser carregado</h2><p>{message}</p><button type="button" onClick={retry}>Tentar novamente</button></div>; }
function FinanceSkeleton() { return <div className={styles.skeleton} aria-label="Carregando financeiro"><header /><section>{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</section><div className={styles.skeletonBody} /></div>; }
function paymentOptions() { return <><option value="pix">Pix</option><option value="bank_transfer">Transferência</option><option value="boleto">Boleto</option><option value="card">Cartão</option><option value="direct_debit">Débito automático</option><option value="cash">Dinheiro</option><option value="other">Outro</option></>; }
function statusLabel(value: string) { return ({ open: "Em aberto", partial: "Parcial", paid: "Liquidado", cancelled: "Cancelado", overdue: "Vencido" } as Record<string, string>)[value] || value; }
function methodLabel(value: string) { return ({ pix: "Pix", bank_transfer: "Transferência", boleto: "Boleto", card: "Cartão", direct_debit: "Débito automático", cash: "Dinheiro", other: "Outro" } as Record<string, string>)[value] || value; }
function sourceLabel(value: string) { return ({ manual: "Lançamento manual", purchase_order: "Pedido de compra", sales_order: "Pedido de venda", service_order: "Ordem de serviço", contract_cycle: "Contrato recorrente", purchase_invoice: "Nota fiscal de entrada" } as Record<string, string>)[value] || value.replaceAll("_", " "); }
function accountType(value?: string) { return ({ bank: "Conta bancária", cash: "Caixa", wallet: "Carteira digital" } as Record<string, string>)[value || ""] || "Conta financeira"; }
function date(value: string) { return new Date(value).toLocaleDateString("pt-BR", { timeZone: "UTC" }); }
function dueLabel(title: Title) { if (["paid", "cancelled"].includes(title.status)) return statusLabel(title.status); const days = Math.ceil((new Date(title.dueAt).valueOf() - new Date(`${today()}T00:00:00Z`).valueOf()) / 86_400_000); return days < 0 ? `${Math.abs(days)} dia(s) em atraso` : days === 0 ? "Vence hoje" : `Em ${days} dia(s)`; }
function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).valueOf()) / 60_000)); return minutes < 1 ? "agora" : minutes < 60 ? `há ${minutes} min` : `às ${new Date(value).toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone(), hour: "2-digit", minute: "2-digit" })}`; }
function formatDocument(value: string) { const digits = value.replace(/\D/g, ""); return digits.length === 11 ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : digits.length === 14 ? digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : value; }
