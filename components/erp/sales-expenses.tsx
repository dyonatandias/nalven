"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ErpModal } from "@/components/erp/modal-portal";
import styles from "./sales-expenses.module.css";

type SaleItem = { id: number; productName: string; skuSnapshot?: string | null; quantity: number; unit: string; unitPriceCents: number; discountCents: number; totalCents: number; returnedQuantity: number };
type Payment = { id: string; method: string; status: string; amountCents: number; tenderedCents: number; changeCents: number; cardBrand?: string | null; cardLastFour?: string | null; installments: number };
type Sale = { id: number; saleNumber: string; customer: string; seller: string; paymentMethod: string; status: string; subtotalCents: number; discountCents: number; surchargeCents: number; totalCents: number; changeCents: number; notes?: string | null; createdAt: string; items: SaleItem[]; payments: Payment[] };
type Settlement = { id: number; amount: number; interest: number; discount: number; method: string; notes?: string | null; settledBy: string; settledAt: string };
type Expense = { id: number; description: string; supplierId?: number | null; documentNumber?: string | null; sourceType: string; amount: number; paidAmount: number; dueAt: string; status: string; paidAt?: string | null; notes?: string | null; createdAt: string; supplier?: { id: number; name: string; tradeName?: string | null } | null; settlements: Settlement[] };
type Data = { branch: { id: number; code: string; name: string } | null; sales: Sale[]; expenses: Expense[]; suppliers: Array<{ id: number; name: string; tradeName?: string | null }>; summary: { grossSalesCents: number; salesCount: number; averageTicketCents: number; expensesCents: number; paidExpensesCents: number; overdueCents: number; netCents: number } };
type Tab = "overview" | "sales" | "expenses";

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const date = tenantDateTimeFormatter({ dateStyle: "short" });
const dateTime = tenantDateTimeFormatter({ dateStyle: "short", timeStyle: "short" });

export function SalesExpenses() {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [saleStatus, setSaleStatus] = useState("");
  const [expenseStatus, setExpenseStatus] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detail, setDetail] = useState<{ kind: "sale"; item: Sale } | { kind: "expense"; item: Expense } | null>(null);
  const [expenseModal, setExpenseModal] = useState(false);
  const [settle, setSettle] = useState<Expense | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setMessage(null);
    const query = new URLSearchParams({ from, to });
    if (appliedSearch) query.set("search", appliedSearch);
    if (saleStatus) query.set("saleStatus", saleStatus);
    if (expenseStatus) query.set("expenseStatus", expenseStatus);
    try {
      const response = await fetch(`/api/erp/sales-expenses?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar os dados.");
      setData(body);
    } catch (error) { setMessage({ kind: "error", text: error instanceof Error ? error.message : "Falha ao carregar." }); }
    finally { setLoading(false); }
  }, [from, to, appliedSearch, saleStatus, expenseStatus]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);
  const submitSearch = (event: FormEvent) => { event.preventDefault(); setAppliedSearch(search.trim()); };
  const mutate = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/erp/sales-expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível concluir.");
      setMessage({ kind: "success", text: success }); await load(); return true;
    } catch (error) { setMessage({ kind: "error", text: error instanceof Error ? error.message : "Não foi possível concluir." }); return false; }
    finally { setBusy(false); }
  };
  const recentSales = useMemo(() => data?.sales.slice(0, 5) || [], [data]);
  const urgentExpenses = useMemo(() => (data?.expenses || []).filter(item => item.status !== "paid" && item.status !== "cancelled").slice(0, 5), [data]);
  const filtersActive = Boolean(appliedSearch || saleStatus || expenseStatus || from !== monthStart() || to !== today());
  const resetFilters = () => { setSearch(""); setAppliedSearch(""); setSaleStatus(""); setExpenseStatus(""); setFrom(monthStart()); setTo(today()); };

  return <div className={styles.page}>
    <section className={styles.hero}>
      <div><span className={styles.eyebrow}>COMERCIAL E OPERAÇÃO</span><h1>Vendas e despesas</h1><p>Acompanhe o que entrou, registre o que saiu e entenda o resultado do período.</p></div>
      <div className={styles.heroActions}><span className={styles.branch}>Filial de vendas: <strong>{data?.branch?.name || "—"}</strong></span><button className={styles.primary} onClick={() => setExpenseModal(true)}>+ Nova despesa</button></div>
    </section>

    <nav className={styles.tabs} aria-label="Áreas de vendas e despesas">
      <button className={tab === "overview" ? styles.activeTab : ""} onClick={() => setTab("overview")}>Visão geral</button>
      <button className={tab === "sales" ? styles.activeTab : ""} onClick={() => setTab("sales")}>Vendas <span>{data?.sales.length || 0}</span></button>
      <button className={tab === "expenses" ? styles.activeTab : ""} onClick={() => setTab("expenses")}>Despesas <span>{data?.expenses.length || 0}</span></button>
    </nav>

    <button type="button" className={styles.filterToggle} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><span>⌕</span> Buscar e filtrar{filtersActive && <i />}</button>
    <form className={`${styles.filters} ${filtersOpen ? styles.filtersOpen : ""}`} onSubmit={submitSearch}>
      <label className={styles.search}><span>Buscar</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Venda, cliente, despesa ou documento" /></label>
      <label><span>De</span><input type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} /></label>
      <label><span>Até</span><input type="date" value={to} min={from} max={today()} onChange={event => setTo(event.target.value)} /></label>
      {tab === "sales" && <label><span>Situação</span><select value={saleStatus} onChange={event => setSaleStatus(event.target.value)}><option value="">Todas</option><option value="completed">Concluídas</option><option value="partially_refunded">Parcialmente devolvidas</option><option value="refunded">Devolvidas</option><option value="cancelled">Canceladas</option></select></label>}
      {tab === "expenses" && <label><span>Situação</span><select value={expenseStatus} onChange={event => setExpenseStatus(event.target.value)}><option value="">Todas</option><option value="open">Em aberto</option><option value="partial">Parcialmente pagas</option><option value="paid">Pagas</option><option value="cancelled">Canceladas</option></select></label>}
      <div className={styles.filterActions}>{filtersActive && <button type="button" className={styles.clearFilters} onClick={resetFilters}>Limpar</button>}<button type="submit" className={styles.secondary}>Aplicar filtros</button></div>
    </form>

    {message && <div className={`${styles.notice} ${message.kind === "error" ? styles.error : styles.success}`} role="status"><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label="Fechar aviso">×</button></div>}
    {loading ? <Loading /> : !data ? <Empty title="Não foi possível exibir esta área" text="Revise o aviso acima e tente novamente." action={<button onClick={() => void load()}>Tentar novamente</button>} /> : <>
      {tab === "overview" && <>
        <section className={styles.kpis}>
          <Kpi label="Vendas concluídas" value={money(data.summary.grossSalesCents)} detail={`${data.summary.salesCount} venda(s) no período`} tone="green" />
          <Kpi label="Ticket médio" value={money(data.summary.averageTicketCents)} detail="Média por venda válida" />
          <Kpi label="Despesas registradas" value={money(data.summary.expensesCents)} detail={`${money(data.summary.paidExpensesCents)} já pagos`} tone="red" />
          <Kpi label="Resultado estimado" value={money(data.summary.netCents)} detail="Vendas menos despesas registradas" tone={data.summary.netCents >= 0 ? "green" : "red"} />
        </section>
        {data.summary.overdueCents > 0 && <div className={styles.warning}><strong>{money(data.summary.overdueCents)} em despesas vencidas</strong><span>Abra “Despesas” para verificar e registrar os pagamentos.</span><button onClick={() => setTab("expenses")}>Ver despesas</button></div>}
        <section className={styles.twoColumns}>
          <Panel title="Vendas mais recentes" subtitle="Registradas pelo PDV" action={<button onClick={() => setTab("sales")}>Ver todas</button>}><SaleList items={recentSales} onOpen={item => setDetail({ kind: "sale", item })} compact /></Panel>
          <Panel title="Próximas despesas" subtitle="Contas abertas por vencimento" action={<button onClick={() => setTab("expenses")}>Ver todas</button>}><ExpenseList items={urgentExpenses} onOpen={item => setDetail({ kind: "expense", item })} onSettle={setSettle} compact /></Panel>
        </section>
        <section className={styles.explainer}><div><strong>Como este resultado é calculado?</strong><p>Somamos as vendas válidas da filial ativa e subtraímos as despesas registradas na organização durante o período. O Financeiro continua sendo o local para contas bancárias, conciliação e fluxo de caixa completo.</p></div><div><strong>Escopo dos dados</strong><p>As vendas pertencem à filial selecionada. As despesas ainda são organizacionais, pois podem atender mais de uma filial.</p></div></section>
      </>}
      {tab === "sales" && <Panel title="Histórico de vendas" subtitle={`${data.sales.length} registro(s) no período`}><SaleList items={data.sales} onOpen={item => setDetail({ kind: "sale", item })} /></Panel>}
      {tab === "expenses" && <Panel title="Despesas" subtitle="Registros operacionais; conciliação e contas bancárias ficam no Financeiro" action={<button className={styles.primarySmall} onClick={() => setExpenseModal(true)}>+ Nova despesa</button>}><ExpenseList items={data.expenses} onOpen={item => setDetail({ kind: "expense", item })} onSettle={setSettle} /></Panel>}
    </>}

    {detail?.kind === "sale" && <SaleDetail sale={detail.item} close={() => setDetail(null)} />}
    {detail?.kind === "expense" && <ExpenseDetail expense={detail.item} close={() => setDetail(null)} settle={() => { setSettle(detail.item); setDetail(null); }} cancel={async () => { if (await mutate({ action: "cancel_expense", id: detail.item.id }, "Despesa cancelada.")) setDetail(null); }} busy={busy} />}
    {expenseModal && <ExpenseForm suppliers={data?.suppliers || []} close={() => setExpenseModal(false)} busy={busy} submit={async payload => { if (await mutate({ action: "create_expense", ...payload }, "Despesa registrada.")) setExpenseModal(false); }} />}
    {settle && <SettlementForm expense={settle} close={() => setSettle(null)} busy={busy} submit={async payload => { if (await mutate({ action: "settle_expense", id: settle.id, ...payload }, "Pagamento registrado.")) setSettle(null); }} />}
  </div>;
}

function Kpi({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "green" | "red" }) { return <article className={`${styles.kpi} ${tone ? styles[tone] : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>; }
function Panel({ title, subtitle, action, children }: { title: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode }) { return <section className={styles.panel}><header><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</header>{children}</section>; }
function Loading() { return <div className={styles.loading}><i /><span>Carregando vendas e despesas…</span></div>; }
function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) { return <div className={styles.empty}><b>⌁</b><strong>{title}</strong><p>{text}</p>{action}</div>; }

function SaleList({ items, onOpen, compact = false }: { items: Sale[]; onOpen: (item: Sale) => void; compact?: boolean }) {
  if (!items.length) return <Empty title="Nenhuma venda encontrada" text="As vendas concluídas no PDV aparecerão aqui." />;
  return <div className={`${styles.list} ${compact ? styles.compact : ""}`}>{items.map(item => <button className={styles.row} onClick={() => onOpen(item)} key={item.id}>
    <span className={styles.avatar}>V</span><span className={styles.rowContent}><strong>Venda {item.saleNumber}</strong><small>{item.customer || "Consumidor final"} · {dateTime.format(new Date(item.createdAt))}</small><span className={styles.rowMeta}><Status value={item.status} kind="sale" /><span>{item.items.length} {item.items.length === 1 ? "item" : "itens"}</span></span></span>
    <span className={styles.rowValue}><small>Total</small><strong>{money(item.totalCents)}</strong></span><span className={styles.chevron}>›</span>
  </button>)}</div>;
}

function ExpenseList({ items, onOpen, onSettle, compact = false }: { items: Expense[]; onOpen: (item: Expense) => void; onSettle: (item: Expense) => void; compact?: boolean }) {
  if (!items.length) return <Empty title="Nenhuma despesa encontrada" text="Registre uma despesa para acompanhar as saídas da operação." />;
  return <div className={`${styles.list} ${compact ? styles.compact : ""}`}>{items.map(item => <div className={styles.row} key={item.id}>
    <button className={styles.rowOpen} onClick={() => onOpen(item)}><span className={`${styles.avatar} ${styles.expenseAvatar}`}>D</span><span className={styles.rowContent}><strong>{item.description}</strong><small>{item.supplier?.tradeName || item.supplier?.name || "Sem fornecedor"} · vence {formatDate(item.dueAt)}</small><span className={styles.rowMeta}><Status value={expenseState(item)} kind="expense" /><span>{item.documentNumber || sourceLabel(item.sourceType)}</span></span></span><span className={styles.rowValue}><small>Saldo</small><strong>{currency.format(item.amount - item.paidAmount)}</strong></span></button>
    {["open", "partial"].includes(item.status) && <button className={styles.payButton} onClick={() => onSettle(item)}>Registrar pagamento</button>}
  </div>)}</div>;
}

function Status({ value, kind }: { value: string; kind: "sale" | "expense" }) { const label = kind === "sale" ? ({ completed: "Concluída", cancelled: "Cancelada", refunded: "Devolvida", partially_refunded: "Devolução parcial" }[value] || value) : ({ open: "Em aberto", partial: "Parcial", paid: "Paga", cancelled: "Cancelada", overdue: "Vencida" }[value] || value); return <span className={`${styles.status} ${styles[`status_${value}`] || ""}`}>{label}</span>; }

function SaleDetail({ sale, close }: { sale: Sale; close: () => void }) { return <ErpModal close={close} label={`Detalhes da venda ${sale.saleNumber}`} className={styles.modalLayer}><div className={styles.modal}>
  <ModalHeader eyebrow="VENDA" title={`Venda ${sale.saleNumber}`} subtitle={`${dateTime.format(new Date(sale.createdAt))} · ${sale.seller}`} close={close} />
  <div className={styles.modalBody}><div className={styles.detailGrid}><Info label="Cliente" value={sale.customer || "Consumidor final"} /><Info label="Situação" value={<Status value={sale.status} kind="sale" />} /><Info label="Pagamento informado" value={paymentLabel(sale.paymentMethod)} /><Info label="Itens" value={String(sale.items.length)} /></div>
  <h3>Produtos</h3><div className={styles.detailList}>{sale.items.map(item => <div key={item.id}><span><strong>{item.productName}</strong><small>{item.skuSnapshot || "Sem SKU"} · {item.quantity} {item.unit} × {money(item.unitPriceCents)}</small></span><b>{money(item.totalCents)}</b></div>)}</div>
  {!!sale.payments.length && <><h3>Pagamentos</h3><div className={styles.detailList}>{sale.payments.map(item => <div key={item.id}><span><strong>{paymentLabel(item.method)}</strong><small>{item.cardBrand ? `${item.cardBrand} final ${item.cardLastFour || "—"}` : item.status} {item.installments > 1 ? `· ${item.installments}x` : ""}</small></span><b>{money(item.amountCents)}</b></div>)}</div></>}
  <div className={styles.totals}><span>Subtotal <b>{money(sale.subtotalCents)}</b></span><span>Descontos <b>− {money(sale.discountCents)}</b></span>{sale.surchargeCents > 0 && <span>Acréscimos <b>{money(sale.surchargeCents)}</b></span>}<strong>Total <b>{money(sale.totalCents)}</b></strong></div>{sale.notes && <Info label="Observação" value={sale.notes} />}</div>
  <footer className={styles.modalFooter}><button onClick={close}>Fechar</button></footer>
  </div></ErpModal>; }

function ExpenseDetail({ expense, close, settle, cancel, busy }: { expense: Expense; close: () => void; settle: () => void; cancel: () => void; busy: boolean }) { const remaining = expense.amount - expense.paidAmount; const [confirmCancel, setConfirmCancel] = useState(false); return <ErpModal close={close} label="Detalhes da despesa" className={styles.modalLayer}><div className={styles.modal}>
  <ModalHeader eyebrow="DESPESA" title={expense.description} subtitle={`Criada em ${date.format(new Date(expense.createdAt))}`} close={close} />
  <div className={styles.modalBody}><div className={styles.detailGrid}><Info label="Situação" value={<Status value={expenseState(expense)} kind="expense" />} /><Info label="Vencimento" value={date.format(new Date(expense.dueAt))} /><Info label="Fornecedor" value={expense.supplier?.tradeName || expense.supplier?.name || "Não informado"} /><Info label="Documento" value={expense.documentNumber || "Não informado"} /></div><div className={styles.totals}><span>Valor original <b>{currency.format(expense.amount)}</b></span><span>Valor pago <b>{currency.format(expense.paidAmount)}</b></span><strong>Saldo <b>{currency.format(remaining)}</b></strong></div>{expense.notes && <Info label="Observação" value={expense.notes} />}{!!expense.settlements.length && <><h3>Pagamentos registrados</h3><div className={styles.detailList}>{expense.settlements.map(item => <div key={item.id}><span><strong>{paymentLabel(item.method)}</strong><small>{dateTime.format(new Date(item.settledAt))} · {item.settledBy}</small></span><b>{currency.format(item.amount)}</b></div>)}</div></>}</div>
  {confirmCancel && <div className={styles.confirmBar} role="alert"><div><strong>Cancelar esta despesa?</strong><small>O registro ficará no histórico e não poderá receber pagamentos.</small></div><button disabled={busy} onClick={() => setConfirmCancel(false)}>Voltar</button><button className={styles.dangerSolid} disabled={busy} onClick={cancel}>{busy ? "Cancelando…" : "Confirmar cancelamento"}</button></div>}
  <footer className={styles.modalFooter}>{expense.status === "open" && !expense.settlements.length && !confirmCancel && <button className={styles.danger} disabled={busy} onClick={() => setConfirmCancel(true)}>Cancelar despesa</button>}<span /><button onClick={close}>Fechar</button>{["open", "partial"].includes(expense.status) && !confirmCancel && <button className={styles.primary} onClick={settle}>Registrar pagamento</button>}</footer>
  </div></ErpModal>; }

function ExpenseForm({ suppliers, close, submit, busy }: { suppliers: Data["suppliers"]; close: () => void; submit: (payload: Record<string, unknown>) => void; busy: boolean }) { const [step, setStep] = useState(1); const [form, setForm] = useState({ description: "", amount: "", dueAt: today(), supplierId: "", documentNumber: "", notes: "" }); const change = (key: keyof typeof form, value: string) => setForm(old => ({ ...old, [key]: value })); return <ErpModal close={close} label="Nova despesa" className={styles.modalLayer}><div className={styles.modal}>
  <ModalHeader eyebrow={`NOVA DESPESA · PASSO ${step} DE 2`} title={step === 1 ? "O que precisa ser pago?" : "Revise antes de salvar"} subtitle={step === 1 ? "Informe os dados principais. Os demais campos são opcionais." : "Confira o valor e o vencimento desta despesa."} close={close} />
  <div className={styles.steps}><i className={styles.stepDone} /><i className={step === 2 ? styles.stepDone : ""} /></div>
  <form className={styles.modalBody} onSubmit={event => { event.preventDefault(); if (step === 1) setStep(2); else submit({ ...form, amount: decimal(form.amount), supplierId: form.supplierId ? Number(form.supplierId) : null }); }}>
    {step === 1 ? <div className={styles.formGrid}><label className={styles.full}><span>Descrição *</span><input required minLength={3} maxLength={240} value={form.description} onChange={event => change("description", event.target.value)} placeholder="Ex.: conta de energia da loja" /></label><label><span>Valor *</span><div className={styles.moneyInput}><b>R$</b><input required inputMode="decimal" value={form.amount} onChange={event => change("amount", event.target.value)} placeholder="0,00" /></div></label><label><span>Vencimento *</span><input required type="date" value={form.dueAt} onChange={event => change("dueAt", event.target.value)} /></label><label><span>Fornecedor</span><select value={form.supplierId} onChange={event => change("supplierId", event.target.value)}><option value="">Não informar</option>{suppliers.map(item => <option key={item.id} value={item.id}>{item.tradeName || item.name}</option>)}</select></label><label><span>Número do documento</span><input maxLength={100} value={form.documentNumber} onChange={event => change("documentNumber", event.target.value)} placeholder="Nota, boleto ou referência" /></label><label className={styles.full}><span>Observação</span><textarea maxLength={1000} value={form.notes} onChange={event => change("notes", event.target.value)} placeholder="Informação útil para quem fará o pagamento" /></label></div> : <div className={styles.review}><div><span>Despesa</span><strong>{form.description}</strong></div><div><span>Valor</span><strong>{currency.format(decimal(form.amount))}</strong></div><div><span>Vencimento</span><strong>{date.format(new Date(`${form.dueAt}T12:00:00Z`))}</strong></div><p>Depois de salvar, esta despesa também ficará disponível no módulo Financeiro.</p></div>}
    <footer className={styles.modalFooter}>{step === 2 ? <button type="button" onClick={() => setStep(1)}>Voltar e corrigir</button> : <button type="button" onClick={close}>Cancelar</button>}<span /><button type="submit" className={styles.primary} disabled={busy || !form.description.trim() || decimal(form.amount) <= 0}>{busy ? "Salvando…" : step === 1 ? "Revisar despesa" : "Confirmar e salvar"}</button></footer>
  </form></div></ErpModal>; }

function SettlementForm({ expense, close, submit, busy }: { expense: Expense; close: () => void; submit: (payload: Record<string, unknown>) => void; busy: boolean }) { const remaining = Math.round((expense.amount - expense.paidAmount) * 100) / 100; const [amount, setAmount] = useState(remaining.toFixed(2).replace(".", ",")); const [interest, setInterest] = useState("0,00"); const [discount, setDiscount] = useState("0,00"); const [method, setMethod] = useState("pix"); const [notes, setNotes] = useState(""); const paid = decimal(amount), interestValue = decimal(interest), discountValue = decimal(discount), valid = paid > 0 && interestValue >= 0 && discountValue >= 0 && paid + discountValue <= remaining; return <ErpModal close={close} label="Registrar pagamento" className={styles.modalLayer}><div className={`${styles.modal} ${styles.smallModal}`}><ModalHeader eyebrow="PAGAMENTO" title="Registrar pagamento" subtitle={expense.description} close={close} /><form className={styles.modalBody} onSubmit={event => { event.preventDefault(); submit({ amount: paid, interest: interestValue, discount: discountValue, method, notes }); }}><div className={styles.balance}><span>Saldo desta despesa</span><strong>{currency.format(remaining)}</strong></div><div className={styles.formGrid}><label><span>Valor pago *</span><div className={styles.moneyInput}><b>R$</b><input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></div></label><label><span>Forma de pagamento *</span><select value={method} onChange={event => setMethod(event.target.value)}><option value="pix">Pix</option><option value="cash">Dinheiro</option><option value="bank_transfer">Transferência</option><option value="boleto">Boleto</option><option value="card">Cartão</option><option value="other">Outra</option></select></label><label><span>Juros cobrados</span><div className={styles.moneyInput}><b>R$</b><input inputMode="decimal" value={interest} onChange={event => setInterest(event.target.value)} /></div></label><label><span>Desconto concedido</span><div className={styles.moneyInput}><b>R$</b><input inputMode="decimal" value={discount} onChange={event => setDiscount(event.target.value)} /></div></label><label className={styles.full}><span>Observação</span><textarea value={notes} maxLength={1000} onChange={event => setNotes(event.target.value)} placeholder="Referência, conta usada ou informação para auditoria" /></label></div><div className={styles.settlementSummary}><span>Saída financeira <b>{currency.format(paid + interestValue)}</b></span><span>Saldo após a baixa <b>{currency.format(Math.max(0, remaining - paid - discountValue))}</b></span></div><p className={styles.help}>Pagamento parcial mantém o saldo restante em aberto. Juros aumentam a saída financeira; desconto reduz o saldo sem aumentar o pagamento.</p><footer className={styles.modalFooter}><button type="button" onClick={close}>Cancelar</button><span /><button className={styles.primary} disabled={busy || !valid}>{busy ? "Registrando…" : "Confirmar pagamento"}</button></footer></form></div></ErpModal>; }

function ModalHeader({ eyebrow, title, subtitle, close }: { eyebrow: string; title: string; subtitle: string; close: () => void }) { return <header className={styles.modalHeader}><div><span>{eyebrow}</span><h2>{title}</h2><p>{subtitle}</p></div><button onClick={close} aria-label="Fechar">×</button></header>; }
function Info({ label, value }: { label: string; value: React.ReactNode }) { return <div className={styles.info}><span>{label}</span><strong>{value}</strong></div>; }
function money(cents: number) { return currency.format(cents / 100); }
function expenseState(item: Expense) { return item.status !== "paid" && item.status !== "cancelled" && new Date(item.dueAt) < new Date(today() + "T00:00:00") ? "overdue" : item.status; }
function sourceLabel(value: string) { return ({ manual: "Manual", manual_expense: "Manual", purchase_order: "Compra", recurring: "Recorrente" }[value] || "Sistema"); }
function formatDate(value: string) { const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value; return date.format(new Date(normalized)); }
function paymentLabel(value: string) { return ({ pix: "Pix", cash: "Dinheiro", money: "Dinheiro", card: "Cartão", credit: "Crédito", debit: "Débito", bank_transfer: "Transferência", boleto: "Boleto", other: "Outra" }[value] || value || "Não informado"); }
function decimal(value: string) { const clean = value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."); const number = Number(clean); return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0; }
function today() { return new Date().toISOString().slice(0, 10); }
function monthStart() { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10); }
