"use client";

import { tenantDateTimeFormatter, tenantTimeZone } from "@/lib/client-timezone";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErpIcon } from "@/components/erp/erp-icon";
import { ErpModal } from "@/components/erp/modal-portal";
import styles from "./bank-reconciliation-center.module.css";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const integer = new Intl.NumberFormat("pt-BR");
const shortDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const fullDate = tenantDateTimeFormatter({ dateStyle: "medium", timeStyle: "short" });
const CATEGORIES = ["Vendas", "Serviços", "Fornecedores", "Impostos", "Folha", "Logística", "Tarifas bancárias", "Transferências", "Investimentos", "Outros"];
const isoDay = (offset = 0) => { const value = new Date(); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10); };

type Account = { id: number; code: string; name: string; institutionName: string | null; agency: string | null; accountNumberLast4: string | null; currentBalanceCents: number; color: string };
type Title = { id: number; type: "receivable" | "payable"; description: string; documentNumber: string | null; amount: number; paidAmount: number; remainingCents: number; dueAt: string; status: string; party: string | null };
type Suggestion = Title & { confidence: number; exact: boolean; recommended: boolean; days: number; reasons: string[] };
type Allocation = { id: number; amountCents: number; status: string; title: Omit<Title, "remainingCents" | "party"> & { customer: { name: string; tradeName: string | null } | null; supplier: { name: string; tradeName: string | null } | null } };
type BankTransaction = {
  id: number; importId: number; accountId: number; externalId: string; occurredAt: string; description: string; amountCents: number;
  bankReference: string | null; documentNumber: string | null; category: string | null; status: "pending" | "reconciled" | "ignored";
  resolutionType: string | null; resolutionReason: string | null; reconciliationSequence: number; version: number; reconciledBy: string | null;
  reconciledAt: string | null; account: { id: number; code: string; name: string; color: string };
  statementImport: { id: number; fileName: string; format: string; importedAt: string }; matchedTitle: Title | null;
  allocations: Allocation[]; suggestions: Suggestion[];
};
type StatementImport = { id: number; accountId: number; fileName: string; format: string; fileSize: number; rowCount: number; importedRowCount: number; duplicateRowCount: number; totalCreditCents: number; totalDebitCents: number; periodStart: string | null; periodEnd: string | null; status: string; importedBy: string; importedAt: string; account: { id: number; code: string; name: string; color: string } };
type Trend = { date: string; creditsCents: number; debitsCents: number; pending: number; reconciled: number; ignored: number };
type Data = {
  generatedAt: string; window: { from: string; to: string }; accounts: Account[]; imports: StatementImport[]; titles: Title[]; transactions: BankTransaction[]; trend: Trend[];
  summary: { pending: number; pendingCents: number; pendingCreditsCents: number; pendingDebitsCents: number; reconciled: number; reconciledCents: number; ignored: number; automation: number; rate: number; creditsCents: number; debitsCents: number };
  importSummary: { files: number; rows: number; duplicates: number }; pagination: { page: number; pageSize: number; total: number; pages: number };
};
type Filters = { search: string; status: string; direction: string; accountId: string; from: string; to: string; pageSize: string };
type AllocationDraft = { titleId: string; amount: string };
type Modal =
  | { kind: "reconcile"; transaction: BankTransaction; requestId: string }
  | { kind: "resolve"; action: "ignore" | "reopen"; transaction: BankTransaction; requestId: string }
  | { kind: "inspect"; transaction: BankTransaction }
  | { kind: "import" }
  | { kind: "auto"; requestId: string };
type Preview = { format: string; fileSize: number; rowCount: number; uniqueRows: number; internalDuplicates: number; periodStart: string; periodEnd: string; totalCreditCents: number; totalDebitCents: number; sample: Array<{ externalId: string; occurredAt: string; description: string; amountCents: number }> };

const DEFAULT_FILTERS: Filters = { search: "", status: "pending", direction: "all", accountId: "", from: isoDay(-44), to: isoDay(), pageSize: "50" };

export function BankReconciliationCenter() {
  const [data, setData] = useState<Data | null>(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [draft, setDraft] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<"queue" | "resolved" | "imports" | "analytics">("queue");
  const [modal, setModal] = useState<Modal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: filters.pageSize });
    Object.entries(filters).forEach(([key, value]) => value && params.set(key, value));
    return params.toString();
  }, [filters, page]);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller; setLoading(true); setError("");
    try {
      const response = await fetch(`/api/erp/reconciliation?${query}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Não foi possível carregar a conciliação bancária.");
      setData(payload);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "Não foi possível carregar a conciliação bancária.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [query]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => { window.clearTimeout(timer); requestRef.current?.abort(); }; }, [load]);

  async function command(payload: Record<string, unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/erp/reconciliation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "A operação não pôde ser concluída.");
      setModal(null); setNotice(success); await load(); return result;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "A operação não pôde ser concluída."); return null; }
    finally { setBusy(false); }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setFilters(draft); setPage(1); }
  function changeTab(next: typeof tab) {
    setTab(next); setPage(1);
    if (next === "queue") { setDraft((value) => ({ ...value, status: "pending" })); setFilters((value) => ({ ...value, status: "pending" })); }
    if (next === "resolved") { setDraft((value) => ({ ...value, status: "reconciled" })); setFilters((value) => ({ ...value, status: "reconciled" })); }
  }
  async function exportCsv() {
    setError("");
    try {
      const params = new URLSearchParams(query); params.set("format", "csv");
      const response = await fetch(`/api/erp/reconciliation?${params}`);
      if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || "Não foi possível exportar o relatório."); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url;
      link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "conciliacao-bancaria.csv";
      link.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível exportar o relatório."); }
  }

  if (!data && loading) return <Skeleton />;
  if (!data) return <ErrorState message={error} retry={() => void load()} />;
  const account = data.accounts.find((item) => String(item.id) === filters.accountId);

  return <div className={styles.workspace}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}><span>TESOURARIA E CONTROLE</span><h1>Conciliação bancária</h1><p>Transforme extratos em lançamentos confiáveis, liquide títulos e trate divergências com rastreabilidade ponta a ponta.</p></div>
      <div className={styles.heroPosition}><small>{account ? account.name : "Saldo das contas bancárias"}</small><strong>{money.format((account ? account.currentBalanceCents : data.accounts.reduce((sum, item) => sum + item.currentBalanceCents, 0)) / 100)}</strong><span>{data.summary.rate.toLocaleString("pt-BR")} % conciliado no período</span><time dateTime={data.generatedAt}>Atualizado {relativeTime(data.generatedAt)}</time></div>
      <nav aria-label="Atalhos da tesouraria"><Link href="/erp/contas-caixas"><ErpIcon name="accounts" />Contas e caixas</Link><Link href="/erp/contas-pagar-receber"><ErpIcon name="finance" />Pagar e receber</Link><Link href="/erp/fechamento-caixa"><ErpIcon name="cash-close" />Fechamento de caixa</Link></nav>
    </header>

    {notice && <div className={styles.notice} role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Fechar aviso">×</button></div>}
    {error && <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Fechar erro">×</button></div>}

    <section className={styles.kpis} aria-label="Indicadores da conciliação">
      <Metric label="A conciliar" value={integer.format(data.summary.pending)} detail={money.format(data.summary.pendingCents / 100)} tone={data.summary.pending ? "amber" : "green"} />
      <Metric label="Entradas pendentes" value={money.format(data.summary.pendingCreditsCents / 100)} detail="Créditos ainda sem baixa" tone="green" />
      <Metric label="Saídas pendentes" value={money.format(data.summary.pendingDebitsCents / 100)} detail="Débitos ainda sem vínculo" tone="red" />
      <Metric label="Taxa conciliada" value={`${data.summary.rate.toLocaleString("pt-BR")}%`} detail={`${integer.format(data.summary.reconciled)} resolvido(s)`} tone={data.summary.rate >= 90 ? "green" : "blue"} />
      <Metric label="Automatizáveis" value={integer.format(data.summary.automation)} detail="Correspondências de alta confiança" tone={data.summary.automation ? "blue" : "neutral"} />
      <Metric label="Ignorados" value={integer.format(data.summary.ignored)} detail="Com justificativa registrada" tone="neutral" />
    </section>

    {data.summary.automation > 0 && filters.status === "pending" && <section className={styles.opportunity}>
      <div><b>✓</b><span><strong>{data.summary.automation} correspondência(s) pronta(s) para revisão automática</strong><small>Somente valor exato e evidências inequívocas são processados; conflitos permanecem pendentes.</small></span></div>
      <button type="button" onClick={() => setModal({ kind: "auto", requestId: crypto.randomUUID() })}>Revisar automação</button>
    </section>}

    <div className={styles.tabRow}>
      <div role="tablist" aria-label="Visões da conciliação">
        <button role="tab" aria-selected={tab === "queue"} onClick={() => changeTab("queue")}>Fila de conciliação</button>
        <button role="tab" aria-selected={tab === "resolved"} onClick={() => changeTab("resolved")}>Resolvidos</button>
        <button role="tab" aria-selected={tab === "imports"} onClick={() => changeTab("imports")}>Importações</button>
        <button role="tab" aria-selected={tab === "analytics"} onClick={() => changeTab("analytics")}>Análises</button>
      </div>
      <div><button type="button" onClick={() => void exportCsv()}>Exportar CSV</button><button className={styles.primary} type="button" disabled={!data.accounts.length} onClick={() => setModal({ kind: "import" })}>+ Importar extrato</button></div>
    </div>

    {(tab === "queue" || tab === "resolved") && <>
      <form className={styles.filters} onSubmit={applyFilters}>
        <label className={styles.search}><span>Buscar</span><input value={draft.search} maxLength={100} onChange={(event) => setDraft({ ...draft, search: event.target.value })} placeholder="Descrição, documento, ID ou conta" /></label>
        <Select label="Situação" value={draft.status} change={(status) => setDraft({ ...draft, status })} options={tab === "queue" ? [["pending", "Pendentes"]] : [["reconciled", "Conciliados"], ["ignored", "Ignorados"], ["all", "Todos os movimentos"]]} />
        <Select label="Direção" value={draft.direction} change={(direction) => setDraft({ ...draft, direction })} options={[["all", "Entradas e saídas"], ["credit", "Somente entradas"], ["debit", "Somente saídas"]]} />
        <Select label="Conta" value={draft.accountId} change={(accountId) => setDraft({ ...draft, accountId })} options={[["", "Todas as contas"], ...data.accounts.map((item) => [String(item.id), `${item.code} · ${item.name}`])]} />
        <label><span>De</span><input type="date" value={draft.from} max={draft.to} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label><span>Até</span><input type="date" value={draft.to} min={draft.from} max={isoDay()} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <Select label="Por página" value={draft.pageSize} change={(pageSize) => setDraft({ ...draft, pageSize })} options={[["25", "25 movimentos"], ["50", "50 movimentos"], ["100", "100 movimentos"]]} />
        <div className={styles.filterActions}><button type="button" onClick={() => { const next = { ...DEFAULT_FILTERS, status: tab === "queue" ? "pending" : "reconciled" }; setDraft(next); setFilters(next); setPage(1); }}>Limpar</button><button className={styles.primary} type="submit">Aplicar</button></div>
      </form>
      <TransactionList data={data} loading={loading} open={setModal} page={page} setPage={setPage} />
    </>}

    {tab === "imports" && <ImportsView data={data} open={() => setModal({ kind: "import" })} />}
    {tab === "analytics" && <AnalyticsView data={data} />}

    {modal?.kind === "reconcile" && <ReconcileDialog modal={modal} titles={data.titles} busy={busy} close={() => setModal(null)} submit={(payload) => command(payload, "Movimento conciliado e razão financeiro atualizado.")} />}
    {modal?.kind === "resolve" && <ResolutionDialog modal={modal} busy={busy} close={() => setModal(null)} submit={(payload) => command(payload, modal.action === "ignore" ? "Movimento ignorado com justificativa registrada." : "Movimento reaberto e efeitos financeiros estornados.")} />}
    {modal?.kind === "inspect" && <InspectDialog transaction={modal.transaction} close={() => setModal(null)} reopen={() => setModal({ kind: "resolve", action: "reopen", transaction: modal.transaction, requestId: crypto.randomUUID() })} />}
    {modal?.kind === "import" && <ImportDialog accounts={data.accounts} busy={busy} close={() => setModal(null)} command={command} />}
    {modal?.kind === "auto" && <AutomationDialog modal={modal} accounts={data.accounts} recommended={data.summary.automation} busy={busy} close={() => setModal(null)} submit={(payload) => command(payload, "Correspondências inequívocas foram conciliadas; exceções permaneceram na fila.")} />}
  </div>;
}

function TransactionList({ data, loading, open, page, setPage }: { data: Data; loading: boolean; open: (modal: Modal) => void; page: number; setPage: (value: number | ((current: number) => number)) => void }) {
  return <section className={styles.listPanel} aria-busy={loading}>
    <header><div><span>MOVIMENTOS DO EXTRATO</span><h2>{data.pagination.total} movimento(s) no recorte</h2><p>Valores e títulos são validados novamente dentro da transação financeira.</p></div>{loading && <small>Atualizando…</small>}</header>
    <div className={styles.tableScroll}><table><thead><tr><th>Data / conta</th><th>Movimento</th><th>Valor</th><th>Correspondência</th><th>Situação</th><th><span className={styles.srOnly}>Ações</span></th></tr></thead><tbody>{data.transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} open={open} />)}</tbody></table></div>
    <div className={styles.mobileList}>{data.transactions.map((transaction) => <TransactionCard key={transaction.id} transaction={transaction} open={open} />)}</div>
    {!data.transactions.length && <Empty title="Nenhum movimento encontrado" text="Ajuste o período e os filtros ou importe um novo extrato bancário." />}
    <footer className={styles.pagination}><span>Página {data.pagination.page} de {data.pagination.pages}</span><div><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</button><button type="button" disabled={page >= data.pagination.pages || loading} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></footer>
  </section>;
}

function TransactionRow({ transaction, open }: { transaction: BankTransaction; open: (modal: Modal) => void }) {
  const suggestion = transaction.suggestions[0];
  return <tr><td><strong>{shortDate.format(new Date(transaction.occurredAt))}</strong><small><i style={{ background: transaction.account.color }} />{transaction.account.code} · {transaction.account.name}</small></td><td><button type="button" className={styles.transactionName} onClick={() => open({ kind: "inspect", transaction })}><strong>{transaction.description}</strong><small>{transaction.documentNumber || transaction.bankReference || transaction.externalId}</small></button></td><td><strong className={transaction.amountCents > 0 ? styles.positive : styles.negative}>{transaction.amountCents > 0 ? "+" : "−"}{money.format(Math.abs(transaction.amountCents) / 100)}</strong><small>{transaction.amountCents > 0 ? "Entrada" : "Saída"}</small></td><td>{suggestion ? <span className={styles.match}><b>{suggestion.confidence}%</b><span><strong>{suggestion.documentNumber || suggestion.description}</strong><small>{suggestion.party || "Sem contraparte"} · {suggestion.reasons.join(", ")}</small></span></span> : transaction.allocations.length ? <span className={styles.match}><b>✓</b><span><strong>{transaction.allocations.map((item) => item.title.documentNumber || item.title.description).join(" · ")}</strong><small>{transaction.resolutionReason}</small></span></span> : <span className={styles.noMatch}>{transaction.category || "Sem correspondência"}</span>}</td><td><Status value={transaction.status} type={transaction.resolutionType} /></td><td><ActionMenu transaction={transaction} open={open} /></td></tr>;
}

function TransactionCard({ transaction, open }: { transaction: BankTransaction; open: (modal: Modal) => void }) {
  const suggestion = transaction.suggestions[0];
  return <article className={styles.transactionCard}><header><span><i style={{ background: transaction.account.color }} />{transaction.account.code} · {shortDate.format(new Date(transaction.occurredAt))}</span><Status value={transaction.status} type={transaction.resolutionType} /></header><button className={styles.cardMain} type="button" onClick={() => open({ kind: "inspect", transaction })}><strong>{transaction.description}</strong><small>{transaction.documentNumber || transaction.bankReference || transaction.externalId}</small></button><div className={transaction.amountCents > 0 ? styles.positive : styles.negative}><b>{transaction.amountCents > 0 ? "+" : "−"}{money.format(Math.abs(transaction.amountCents) / 100)}</b><span>{transaction.amountCents > 0 ? "Entrada" : "Saída"}</span></div>{suggestion && <p><b>{suggestion.confidence}% de confiança</b> · {suggestion.documentNumber || suggestion.description}</p>}<ActionButtons transaction={transaction} open={open} /></article>;
}

function ActionMenu({ transaction, open }: { transaction: BankTransaction; open: (modal: Modal) => void }) {
  return <details className={styles.actionMenu}><summary aria-label={`Ações de ${transaction.description}`}>•••</summary><div><button type="button" onClick={() => open({ kind: "inspect", transaction })}>Ver detalhes</button>{transaction.status === "pending" ? <><button type="button" onClick={() => open({ kind: "reconcile", transaction, requestId: crypto.randomUUID() })}>Conciliar</button><button className={styles.dangerText} type="button" onClick={() => open({ kind: "resolve", action: "ignore", transaction, requestId: crypto.randomUUID() })}>Ignorar com motivo</button></> : <button type="button" onClick={() => open({ kind: "resolve", action: "reopen", transaction, requestId: crypto.randomUUID() })}>Reabrir e estornar</button>}</div></details>;
}
function ActionButtons({ transaction, open }: { transaction: BankTransaction; open: (modal: Modal) => void }) {
  return <footer><button type="button" onClick={() => open({ kind: "inspect", transaction })}>Detalhes</button>{transaction.status === "pending" ? <><button type="button" onClick={() => open({ kind: "resolve", action: "ignore", transaction, requestId: crypto.randomUUID() })}>Ignorar</button><button className={styles.primary} type="button" onClick={() => open({ kind: "reconcile", transaction, requestId: crypto.randomUUID() })}>Conciliar</button></> : <button type="button" onClick={() => open({ kind: "resolve", action: "reopen", transaction, requestId: crypto.randomUUID() })}>Reabrir</button>}</footer>;
}

function ReconcileDialog({ modal, titles, busy, close, submit }: { modal: Extract<Modal, { kind: "reconcile" }>; titles: Title[]; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<unknown> }) {
  const suggested = modal.transaction.suggestions[0];
  const [mode, setMode] = useState<"title" | "manual">(suggested ? "title" : "manual");
  const [allocations, setAllocations] = useState<AllocationDraft[]>(suggested ? [{ titleId: String(suggested.id), amount: decimalAmount(Math.abs(modal.transaction.amountCents)) }] : [{ titleId: "", amount: decimalAmount(Math.abs(modal.transaction.amountCents)) }]);
  const compatible = titles.filter((title) => title.type === (modal.transaction.amountCents > 0 ? "receivable" : "payable"));
  const allocated = allocations.reduce((sum, item) => sum + inputCents(item.amount), 0); const target = Math.abs(modal.transaction.amountCents); const difference = target - allocated;
  function update(index: number, patch: Partial<AllocationDraft>) { setAllocations((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  function selectSuggestion(suggestion: Suggestion) { setMode("title"); setAllocations([{ titleId: String(suggestion.id), amount: decimalAmount(target) }]); }
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await submit({ action: "reconcile", transactionId: modal.transaction.id, requestId: modal.requestId, reason: form.get("reason"), category: mode === "manual" ? form.get("category") : null, allocations: mode === "title" ? allocations.map((item) => ({ titleId: item.titleId, amount: item.amount })) : [] }); }
  return <ErpModal className={styles.modal} close={close} label="Conciliar movimento bancário"><form onSubmit={save}>
    <DialogHeader eyebrow="CONCILIAÇÃO ASSISTIDA" title={modal.transaction.description} text={`${modal.transaction.account.name} · ${shortDate.format(new Date(modal.transaction.occurredAt))}`} close={close} />
    <div className={styles.amountBanner}><span><small>Movimento</small><strong className={modal.transaction.amountCents > 0 ? styles.positive : styles.negative}>{modal.transaction.amountCents > 0 ? "+" : "−"}{money.format(target / 100)}</strong></span><span><small>ID bancário</small><strong>{modal.transaction.externalId}</strong></span></div>
    {modal.transaction.suggestions.length > 0 && <section className={styles.suggestions}><header><strong>Sugestões explicáveis</strong><small>Escolha uma ou faça o rateio manualmente.</small></header>{modal.transaction.suggestions.slice(0, 3).map((suggestion) => <button type="button" key={suggestion.id} className={allocations[0]?.titleId === String(suggestion.id) ? styles.selectedSuggestion : ""} onClick={() => selectSuggestion(suggestion)}><b>{suggestion.confidence}%</b><span><strong>{suggestion.documentNumber || suggestion.description}</strong><small>{suggestion.party || "Sem contraparte"} · saldo {money.format(suggestion.remainingCents / 100)}</small><em>{suggestion.reasons.join(" · ")}</em></span>{suggestion.recommended && <i>Recomendada</i>}</button>)}</section>}
    <div className={styles.modeSwitch} role="radiogroup" aria-label="Tipo de conciliação"><button type="button" role="radio" aria-checked={mode === "title"} onClick={() => setMode("title")}>Vincular título / ratear</button><button type="button" role="radio" aria-checked={mode === "manual"} onClick={() => setMode("manual")}>Classificar sem título</button></div>
    <div className={styles.formGrid}>
      {mode === "title" ? <div className={styles.allocations}>{allocations.map((allocation, index) => <div key={index}><label><span>Título {index + 1}</span><select required value={allocation.titleId} onChange={(event) => update(index, { titleId: event.target.value })}><option value="">Selecione um título</option>{compatible.filter((title) => !allocations.some((item, itemIndex) => itemIndex !== index && item.titleId === String(title.id))).map((title) => <option key={title.id} value={title.id}>{title.documentNumber || title.description} · {money.format(title.remainingCents / 100)}</option>)}</select></label><label><span>Valor alocado</span><input required inputMode="decimal" value={allocation.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label>{allocations.length > 1 && <button type="button" onClick={() => setAllocations((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remover título ${index + 1}`}>×</button>}</div>)}<footer><button type="button" disabled={allocations.length >= 10} onClick={() => setAllocations((items) => [...items, { titleId: "", amount: decimalAmount(Math.max(0, difference)) }])}>+ Adicionar título</button><span className={difference === 0 ? styles.balanced : styles.unbalanced}>{difference === 0 ? "Rateio fechado" : `Diferença ${money.format(difference / 100)}`}</span></footer></div> : <label className={styles.wide}><span>Categoria</span><select name="category" required defaultValue=""><option value="">Selecione a classificação</option>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>}
      <label className={styles.wide}><span>Justificativa</span><textarea name="reason" required minLength={8} maxLength={500} rows={3} defaultValue={mode === "title" ? "Conciliação conferida com o extrato bancário." : "Movimento classificado após conferência do extrato."} /></label>
    </div>
    <p className={styles.formHint}>A confirmação registra o lançamento na conta, atualiza o saldo e, quando houver títulos, cria as baixas correspondentes numa única transação.</p>
    <footer><button type="button" onClick={close}>Cancelar</button><button className={styles.primary} disabled={busy || (mode === "title" && difference !== 0)}>{busy ? "Processando…" : "Confirmar conciliação"}</button></footer>
  </form></ErpModal>;
}

function ResolutionDialog({ modal, busy, close, submit }: { modal: Extract<Modal, { kind: "resolve" }>; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<unknown> }) {
  const reopening = modal.action === "reopen";
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await submit({ action: modal.action, transactionId: modal.transaction.id, requestId: modal.requestId, reason: form.get("reason") }); }
  return <ErpModal className={styles.modal} close={close} label={reopening ? "Reabrir movimento" : "Ignorar movimento"}><form className={styles.smallModal} onSubmit={save}>
    <DialogHeader eyebrow={reopening ? "ESTORNO CONTROLADO" : "TRATAMENTO DE EXCEÇÃO"} title={reopening ? "Reabrir conciliação" : "Ignorar movimento"} text={modal.transaction.description} close={close} />
    <div className={styles.formGrid}><div className={`${styles.warningBox} ${styles.wide}`}>{reopening ? "A reabertura estorna o lançamento da conta e eventuais baixas de títulos, preservando todo o histórico." : "O movimento permanecerá no histórico e não afetará o saldo contábil. Informe um motivo verificável."}</div><label className={styles.wide}><span>{reopening ? "Motivo da reabertura" : "Motivo para ignorar"}</span><textarea name="reason" rows={4} minLength={8} maxLength={500} required autoFocus placeholder={reopening ? "Ex.: título vinculado incorretamente; será revisado pela tesouraria." : "Ex.: transferência entre contas já registrada pelo módulo de tesouraria."} /></label></div>
    <footer><button type="button" onClick={close}>Cancelar</button><button className={reopening ? styles.dangerAction : styles.primary} disabled={busy}>{busy ? "Processando…" : reopening ? "Reabrir e estornar" : "Ignorar movimento"}</button></footer>
  </form></ErpModal>;
}

function ImportDialog({ accounts, busy, close, command }: { accounts: Account[]; busy: boolean; close: () => void; command: (payload: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const [file, setFile] = useState<{ name: string; content: string } | null>(null); const [accountId, setAccountId] = useState(""); const [preview, setPreview] = useState<Preview | null>(null); const [localError, setLocalError] = useState(""); const [previewing, setPreviewing] = useState(false); const inputRef = useRef<HTMLInputElement>(null);
  async function receive(selected?: File) { setLocalError(""); setPreview(null); if (!selected) return setFile(null); if (selected.size > 2_000_000) { setFile(null); return setLocalError("O arquivo excede o limite de 2 MB."); } if (!/\.(csv|ofx)$/i.test(selected.name)) { setFile(null); return setLocalError("Selecione um arquivo CSV ou OFX."); } setFile({ name: selected.name, content: await selected.text() }); }
  async function previewFile() { if (!file) return; setPreviewing(true); setLocalError(""); try { const response = await fetch("/api/erp/reconciliation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", fileName: file.name, content: file.content }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Não foi possível validar o extrato."); setPreview(payload.preview); } catch (reason) { setLocalError(reason instanceof Error ? reason.message : "Não foi possível validar o extrato."); } finally { setPreviewing(false); } }
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!file || !preview) return; await command({ action: "import", accountId, fileName: file.name, content: file.content }, "Extrato importado; duplicidades foram identificadas sem criar lançamentos repetidos."); }
  return <ErpModal className={styles.modal} close={close} label="Importar extrato bancário"><form onSubmit={save}>
    <DialogHeader eyebrow="IMPORTAÇÃO SEGURA" title="Importar extrato" text="CSV e OFX com validação antes da gravação e deduplicação por conta." close={close} />
    <div className={styles.formGrid}><label className={styles.wide}><span>Conta bancária</span><select required value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Selecione a conta de destino</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></label><button className={`${styles.dropzone} ${styles.wide}`} type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void receive(event.dataTransfer.files[0]); }}><ErpIcon name="finance" /><strong>{file?.name || "Arraste o extrato aqui ou clique para escolher"}</strong><small>CSV ou OFX · até 5.000 movimentos · máximo de 2 MB</small></button><input ref={inputRef} className={styles.fileInput} type="file" accept=".csv,.ofx,text/csv,application/x-ofx" onChange={(event) => void receive(event.target.files?.[0])} />{localError && <div className={`${styles.inlineError} ${styles.wide}`} role="alert">{localError}</div>}{file && !preview && <button className={`${styles.previewButton} ${styles.wide}`} type="button" disabled={previewing} onClick={() => void previewFile()}>{previewing ? "Validando…" : "Validar e visualizar extrato"}</button>}{preview && <PreviewPanel preview={preview} />}</div>
    <p className={styles.formHint}>CSV esperado: data; descrição; valor; ID externo. Valores positivos representam entradas e negativos representam saídas. Cabeçalhos em português e inglês são aceitos.</p>
    <footer><button type="button" onClick={close}>Cancelar</button><button className={styles.primary} disabled={busy || !preview || !accountId}>{busy ? "Importando…" : "Importar movimentos válidos"}</button></footer>
  </form></ErpModal>;
}

function PreviewPanel({ preview }: { preview: Preview }) { return <section className={`${styles.preview} ${styles.wide}`}><header><span><strong>{preview.rowCount} linha(s)</strong><small>{preview.format.toUpperCase()} · {formatBytes(preview.fileSize)}</small></span><span><strong>{shortDate.format(new Date(preview.periodStart))} — {shortDate.format(new Date(preview.periodEnd))}</strong><small>{preview.internalDuplicates} duplicidade(s) dentro do arquivo</small></span></header><dl><div><dt>Entradas</dt><dd className={styles.positive}>{money.format(preview.totalCreditCents / 100)}</dd></div><div><dt>Saídas</dt><dd className={styles.negative}>{money.format(preview.totalDebitCents / 100)}</dd></div><div><dt>Linhas únicas</dt><dd>{preview.uniqueRows}</dd></div></dl><div>{preview.sample.slice(0, 5).map((item) => <article key={item.externalId}><span><strong>{item.description}</strong><small>{shortDate.format(new Date(item.occurredAt))} · {item.externalId}</small></span><b className={item.amountCents > 0 ? styles.positive : styles.negative}>{money.format(item.amountCents / 100)}</b></article>)}</div></section>; }

function AutomationDialog({ modal, accounts, recommended, busy, close, submit }: { modal: Extract<Modal, { kind: "auto" }>; accounts: Account[]; recommended: number; busy: boolean; close: () => void; submit: (payload: Record<string, unknown>) => Promise<unknown> }) {
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await submit({ action: "auto_reconcile", requestId: modal.requestId, accountId: form.get("accountId") || null, limit: form.get("limit") }); }
  return <ErpModal className={styles.modal} close={close} label="Automatizar conciliações"><form className={styles.smallModal} onSubmit={save}><DialogHeader eyebrow="AUTOMAÇÃO CONSERVADORA" title={`Processar até ${recommended} sugestão(ões)`} text="Somente correspondências únicas, de valor exato e alta confiança serão conciliadas." close={close} /><div className={styles.formGrid}><label><span>Conta</span><select name="accountId"><option value="">Todas as contas</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.code} · {account.name}</option>)}</select></label><label><span>Limite desta execução</span><select name="limit" defaultValue="25"><option value="10">10 movimentos</option><option value="25">25 movimentos</option><option value="50">50 movimentos</option></select></label><div className={`${styles.safeBox} ${styles.wide}`}>Movimentos ambíguos, títulos já alterados ou conflitos concorrentes são preservados na fila para revisão humana.</div></div><footer><button type="button" onClick={close}>Cancelar</button><button className={styles.primary} disabled={busy || !recommended}>{busy ? "Processando…" : "Executar automação"}</button></footer></form></ErpModal>;
}

function InspectDialog({ transaction, close, reopen }: { transaction: BankTransaction; close: () => void; reopen: () => void }) {
  return <ErpModal className={styles.modal} close={close} label="Detalhes do movimento"><section className={styles.detailModal}><DialogHeader eyebrow="RASTREABILIDADE DO MOVIMENTO" title={transaction.description} text={`${transaction.account.code} · ${transaction.account.name}`} close={close} /><div className={styles.detailBody}><div className={styles.detailAmount}><span><small>Valor</small><strong className={transaction.amountCents > 0 ? styles.positive : styles.negative}>{transaction.amountCents > 0 ? "+" : "−"}{money.format(Math.abs(transaction.amountCents) / 100)}</strong></span><Status value={transaction.status} type={transaction.resolutionType} /></div><dl><Detail label="Data do banco" value={shortDate.format(new Date(transaction.occurredAt))} /><Detail label="ID externo" value={transaction.externalId} /><Detail label="Documento" value={transaction.documentNumber || "—"} /><Detail label="Referência bancária" value={transaction.bankReference || "—"} /><Detail label="Arquivo de origem" value={transaction.statementImport.fileName} /><Detail label="Importado em" value={fullDate.format(new Date(transaction.statementImport.importedAt))} /><Detail label="Categoria" value={transaction.category || "—"} /><Detail label="Sequência" value={String(transaction.reconciliationSequence)} /></dl>{transaction.resolutionReason && <section className={styles.auditNote}><strong>Decisão registrada</strong><p>{transaction.resolutionReason}</p><small>{transaction.reconciledBy || "Responsável não informado"}{transaction.reconciledAt ? ` · ${fullDate.format(new Date(transaction.reconciledAt))}` : ""}</small></section>}{transaction.allocations.length > 0 && <section className={styles.linkedTitles}><strong>Títulos vinculados</strong>{transaction.allocations.map((allocation) => <article key={allocation.id}><span><b>{allocation.title.documentNumber || allocation.title.description}</b><small>{allocation.title.description}</small></span><strong>{money.format(allocation.amountCents / 100)}</strong></article>)}</section>}</div><footer><button type="button" onClick={close}>Fechar</button>{transaction.status !== "pending" && <button type="button" onClick={reopen}>Reabrir movimento</button>}</footer></section></ErpModal>;
}

function ImportsView({ data, open }: { data: Data; open: () => void }) { return <section className={styles.importsPanel}><header><div><span>HISTÓRICO IMUTÁVEL</span><h2>Arquivos processados</h2><p>{data.importSummary.files} arquivo(s), {integer.format(data.importSummary.rows)} movimento(s) aceito(s) e {integer.format(data.importSummary.duplicates)} duplicidade(s).</p></div><button className={styles.primary} type="button" onClick={open}>+ Nova importação</button></header><div>{data.imports.map((item) => <article key={item.id}><header><i style={{ background: item.account.color }} /><span><strong>{item.fileName}</strong><small>{item.account.code} · {item.account.name}</small></span><em>{item.format.toUpperCase()}</em></header><dl><Detail label="Período" value={item.periodStart && item.periodEnd ? `${shortDate.format(new Date(item.periodStart))} — ${shortDate.format(new Date(item.periodEnd))}` : "—"} /><Detail label="Processados" value={integer.format(item.importedRowCount)} /><Detail label="Duplicados" value={integer.format(item.duplicateRowCount)} /><Detail label="Entradas" value={money.format(item.totalCreditCents / 100)} /><Detail label="Saídas" value={money.format(item.totalDebitCents / 100)} /><Detail label="Tamanho" value={formatBytes(item.fileSize)} /></dl><footer><span>Importado por {item.importedBy}</span><time dateTime={item.importedAt}>{fullDate.format(new Date(item.importedAt))}</time></footer></article>)}</div>{!data.imports.length && <Empty title="Nenhum extrato importado" text="Importe o primeiro arquivo CSV ou OFX para iniciar a conciliação." />}</section>; }

function AnalyticsView({ data }: { data: Data }) {
  const max = Math.max(1, ...data.trend.map((item) => Math.max(item.creditsCents, item.debitsCents)));
  const accounts = data.accounts.map((account) => ({ ...account, pending: data.transactions.filter((item) => item.accountId === account.id && item.status === "pending").length }));
  return <div className={styles.analytics}><section className={styles.chartPanel}><header><div><span>FLUXO DO EXTRATO</span><h2>Entradas e saídas por dia</h2><p>Movimentação bancária no período selecionado.</p></div><div className={styles.legend}><span><i className={styles.creditBar} />Entradas</span><span><i className={styles.debitBar} />Saídas</span></div></header><div className={styles.chart}>{data.trend.slice(-31).map((item) => <div key={item.date} title={`${shortDate.format(new Date(item.date))}: entradas ${money.format(item.creditsCents / 100)}, saídas ${money.format(item.debitsCents / 100)}`}><span><i className={styles.creditBar} style={{ height: `${Math.max(3, item.creditsCents / max * 100)}%` }} /><i className={styles.debitBar} style={{ height: `${Math.max(3, item.debitsCents / max * 100)}%` }} /></span><small>{new Date(item.date).getUTCDate()}</small></div>)}</div>{!data.trend.length && <Empty title="Sem dados no período" text="Amplie o período ou importe extratos para visualizar o fluxo." />}</section><section className={styles.healthPanel}><header><span>CONTAS CONECTADAS</span><h2>Cobertura bancária</h2><p>Posição e pendências visíveis no recorte atual.</p></header><div>{accounts.map((account) => <article key={account.id}><i style={{ background: account.color }} /><span><strong>{account.name}</strong><small>{account.institutionName || account.code}{account.accountNumberLast4 ? ` · final ${account.accountNumberLast4}` : ""}</small></span><div><b>{money.format(account.currentBalanceCents / 100)}</b><small>{account.pending} pendente(s) na página</small></div></article>)}</div></section></div>;
}

function Status({ value, type }: { value: BankTransaction["status"]; type?: string | null }) { const labels = { pending: "Pendente", reconciled: "Conciliado", ignored: "Ignorado" }; const detail = type === "automatic" ? "Automático" : type === "split" ? "Rateado" : type === "manual" ? "Classificado" : null; return <span className={`${styles.status} ${styles[`status_${value}`]}`}>{detail || labels[value]}</span>; }
function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <article className={`${styles.metric} ${styles[tone]}`}><header><span>{label}</span><i /></header><strong title={value}>{value}</strong><small>{detail}</small></article>; }
function Select({ label, value, change, options }: { label: string; value: string; change: (value: string) => void; options: string[][] }) { return <label><span>{label}</span><select value={value} onChange={(event) => change(event.target.value)}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>; }
function DialogHeader({ eyebrow, title, text, close }: { eyebrow: string; title: string; text: string; close: () => void }) { return <header><div><span>{eyebrow}</span><h2>{title}</h2><p>{text}</p></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>; }
function Detail({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className={styles.empty}><span>✓</span><strong>{title}</strong><p>{text}</p></div>; }
function Skeleton() { return <div className={styles.skeleton}><header /><section>{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</section><div className={styles.skeletonBody} /></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className={styles.errorState}><span>!</span><h2>Não foi possível abrir a conciliação</h2><p>{message}</p><button type="button" onClick={retry}>Tentar novamente</button></div>; }
function decimalAmount(cents: number) { return (cents / 100).toFixed(2).replace(".", ","); }
function inputCents(value: string) { const normalized = value.trim().replace(/\./g, "").replace(",", "."); const result = Number(normalized); return Number.isFinite(result) ? Math.round(result * 100) : 0; }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1_048_576).toFixed(1)} MB`; }
function relativeTime(value: string) { const minutes = Math.max(0, Math.round((Date.now() - new Date(value).valueOf()) / 60_000)); return minutes < 1 ? "agora" : minutes < 60 ? `há ${minutes} min` : `às ${new Date(value).toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone(), hour: "2-digit", minute: "2-digit" })}`; }
