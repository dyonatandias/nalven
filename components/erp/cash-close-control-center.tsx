"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErpIcon } from "@/components/erp/erp-icon";
import { ErpModal } from "@/components/erp/modal-portal";
import styles from "./cash-close-control-center.module.css";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const number = new Intl.NumberFormat("pt-BR");
const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const date = tenantDateTimeFormatter({ dateStyle: "short" });
const dateTime = tenantDateTimeFormatter({ dateStyle: "short", timeStyle: "short" });
const initialTo = () => new Date().toISOString().slice(0, 10);
const initialFrom = () => { const value = new Date(); value.setUTCDate(value.getUTCDate() - 29); return value.toISOString().slice(0, 10); };

type Filters = { search: string; status: string; branchId: string; registerId: string; operatorProfileId: string; divergentOnly: boolean; from: string; to: string; sort: string; page: number; pageSize: number };
type Blockers = { heldSales: number; payments: number; paymentIntents: number; paymentPlans: number; manualReferences: number; orderClaims: number; integrityIncidents: number };
type Session = {
  id: number; number: string; status: string; businessDate: string; registerName: string;
  register: { id: number; code: string; name: string; status: string; branch: { id: number; code: string; name: string; timezone: string } } | null;
  operator: { id: number; displayName: string; status: string } | null; terminal: { id: string; code: string; name: string; status: string; lastSeenAt: string | null } | null;
  openedBy: string; closedBy: string | null; openedAt: string; closedAt: string | null; suspendedAt: string | null;
  suspendedBy: string | null; suspendedReason: string | null; openingNotes: string | null; closeNotes: string | null;
  openingAmountCents: number; expectedAmountCents: number | null; closingAmountCents: number | null;
  differenceCents: number | null; absoluteDifferenceCents: number | null; expectedMasked: boolean;
  salesCents: number; salesCount: number; suppliesCents: number; withdrawalsCents: number; lastLedgerBalanceCents: number | null;
  closeApproval: { id: string; status: string; requesterName: string; approverName: string | null; reason: string; decisionReason: string | null; createdAt: string; decidedAt: string | null; consumedAt: string | null } | null;
  paymentCounts: Array<{ id: number; method: string; provider: string; expectedCents: number; declaredCents: number; differenceCents: number; countedAt: string }>;
  blockers: Blockers;
  events: Array<{ id: number; type: string; amountCents: number; signedAmountCents: number; description: string; actor: string; approvedBy: string | null; reasonCode: string | null; paymentMethod: string | null; createdAt: string }>;
  cashLedger: Array<{ id: string; sequence: number; entryType: string; amountCents: number; deltaCents: number; balanceAfterCents: number | null; referenceType: string; reasonCode: string; description: string; occurredAt: string }>;
  custody: Array<{ id: string; sealNumber: string; amountCents: number; sealedAt: string; state: string; incident: { id: string; differenceCents: number; reasonCode: string; description: string; openedAt: string; resolved: boolean } | null }>;
};
type Ranking = { id: number | null; name: string; sessions: number; salesCents: number; differenceCents: number; exact: number };
type Data = {
  generatedAt: string; policy: { closeToleranceCents: number; blindClose: boolean };
  scope: { branches: Array<{ id: number; code: string; name: string; status: string }>; registers: Array<{ id: number; code: string; name: string; branchId: number; status: string }>; operators: Array<{ id: number; displayName: string; status: string }> };
  summary: { open: number; closing: number; suspended: number; closed: number; salesCents: number; salesCount: number; suppliesCents: number; withdrawalsCents: number; netCashMovementCents: number; differenceCents: number; absoluteDifferenceCents: number; divergent: number; exactRate: number; averageDurationMinutes: number; blockingSessions: number; custodyIncidents: number };
  tenderSummary: Array<{ method: string; sessions: number; expectedCents: number; declaredCents: number; differenceCents: number }>;
  trend: Array<{ date: string; salesCents: number; differenceCents: number; closed: number; divergent: number }>;
  ranking: { registers: Ranking[]; operators: Ranking[] }; items: Session[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
};

const DEFAULT_FILTERS: Filters = { search: "", status: "", branchId: "", registerId: "", operatorProfileId: "", divergentOnly: false, from: initialFrom(), to: initialTo(), sort: "recent", page: 1, pageSize: 25 };

export function CashCloseControlCenter() {
  const [draft, setDraft] = useState(DEFAULT_FILTERS);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [data, setData] = useState<Data>();
  const [detail, setDetail] = useState<Session>();
  const [tab, setTab] = useState<"sessions" | "reconciliation" | "performance" | "custody">("sessions");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const query = useMemo(() => filterParams(filters), [filters]);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/erp/cash-close?${query}`, { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar os fechamentos.");
      setData(body); setDetail((current) => current ? body.items.find((item: Session) => item.id === current.id) : undefined);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Não foi possível carregar os fechamentos.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [load]);

  function submit(event: FormEvent) { event.preventDefault(); setFilters({ ...draft, page: 1 }); }
  function reset() { const next = { ...DEFAULT_FILTERS, from: initialFrom(), to: initialTo() }; setDraft(next); setFilters(next); }
  function page(value: number) { const next = { ...filters, page: value }; setFilters(next); setDraft(next); }

  if (!data && loading) return <Loading />;
  if (!data) return <ErrorState message={error} retry={() => void load()} />;
  const maxTrend = Math.max(1, ...data.trend.map((item) => item.salesCents));
  const activeRegisters = draft.branchId ? data.scope.registers.filter((item) => String(item.branchId) === draft.branchId) : data.scope.registers;
  const custody = data.items.flatMap((session) => session.custody.map((bag) => ({ session, bag })));

  return <div className={styles.workspace}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}><span>TESOURARIA DE LOJA · CONFERÊNCIA CEGA</span><h1>Fechamento de caixa</h1><p>Acompanhe turnos, divergências, meios de pagamento, bloqueios e custódia sem romper os controles do PDV.</p></div>
      <div className={styles.heroPulse}><small>CONFORMIDADE NO PERÍODO</small><strong>{percent.format(data.summary.exactRate)}%</strong><span>{data.summary.exactRate === 100 ? "Todos os fechamentos exatos" : `${number.format(data.summary.divergent)} fora da tolerância`}</span><time>Atualizado {dateTime.format(new Date(data.generatedAt))}</time></div>
      <nav aria-label="Atalhos de fechamento"><Link href="/erp/pdv"><ErpIcon name="pdv" />Operar no PDV</Link><Link href="/erp/configuracoes-pdv"><ErpIcon name="settings" />Políticas do PDV</Link><Link href="/erp/conciliacao-bancaria"><ErpIcon name="finance" />Conciliação bancária</Link></nav>
    </header>
    {error && <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => void load()} aria-label="Tentar novamente">↻</button></div>}
    <section className={styles.kpis} aria-label="Indicadores de fechamento">
      <Metric label="Turnos em curso" value={String(data.summary.open + data.summary.closing + data.summary.suspended)} detail={`${data.summary.open} abertos · ${data.summary.closing} fechando · ${data.summary.suspended} suspensos`} tone="blue" />
      <Metric label="Vendas do período" value={cash(data.summary.salesCents)} detail={`${number.format(data.summary.salesCount)} vendas vinculadas`} tone="green" />
      <Metric label="Diferença absoluta" value={cash(data.summary.absoluteDifferenceCents)} detail={`Saldo líquido ${cash(data.summary.differenceCents)}`} tone={data.summary.divergent ? "red" : "green"} />
      <Metric label="Fechamentos" value={String(data.summary.closed)} detail={`${data.summary.divergent} fora da tolerância`} tone={data.summary.divergent ? "amber" : "green"} />
      <Metric label="Movimento manual" value={cash(data.summary.netCashMovementCents)} detail={`${cash(data.summary.suppliesCents)} entra · ${cash(data.summary.withdrawalsCents)} sai`} tone="neutral" />
      <Metric label="Duração média" value={duration(data.summary.averageDurationMinutes)} detail={`Tolerância ${cash(data.policy.closeToleranceCents)}`} tone="neutral" />
    </section>
    {(data.summary.blockingSessions > 0 || data.summary.custodyIncidents > 0) && <section className={styles.attention}>
      <div><b>!</b><span><strong>Atenção operacional necessária</strong><small>{data.summary.blockingSessions} turno(s) com pendências para fechar · {data.summary.custodyIncidents} incidente(s) de custódia em aberto nesta página</small></span></div>
      <button type="button" onClick={() => { setDraft({ ...draft, status: "open" }); setFilters({ ...filters, status: "open", page: 1 }); setTab("sessions"); }}>Ver turnos</button>
    </section>}
    <div className={styles.tabRow}>
      <div role="tablist" aria-label="Visões do fechamento">
        <Tab active={tab === "sessions"} onClick={() => setTab("sessions")}>Turnos</Tab><Tab active={tab === "reconciliation"} onClick={() => setTab("reconciliation")}>Conferência</Tab><Tab active={tab === "performance"} onClick={() => setTab("performance")}>Desempenho</Tab><Tab active={tab === "custody"} onClick={() => setTab("custody")}>Custódia e auditoria</Tab>
      </div>
      <div><button type="button" onClick={() => void load()} disabled={loading}>↻ Atualizar</button><a href={`/api/erp/cash-close?${filterParams({ ...filters, page: 1 })}&format=csv`}>↓ Exportar CSV</a></div>
    </div>
    <form className={styles.filters} onSubmit={submit}>
      <label className={styles.search}><span>Buscar turno, caixa ou responsável</span><input value={draft.search} onChange={(event) => setDraft({ ...draft, search: event.target.value })} placeholder="Ex.: CX-2026, Caixa 02, Ana" /></label>
      <label><span>De</span><input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} required /></label>
      <label><span>Até</span><input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} required /></label>
      <label><span>Filial</span><select value={draft.branchId} onChange={(event) => setDraft({ ...draft, branchId: event.target.value, registerId: "" })}><option value="">Todas acessíveis</option>{data.scope.branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>Caixa</span><select value={draft.registerId} onChange={(event) => setDraft({ ...draft, registerId: event.target.value })}><option value="">Todos</option>{activeRegisters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>Operador</span><select value={draft.operatorProfileId} onChange={(event) => setDraft({ ...draft, operatorProfileId: event.target.value })}><option value="">Todos</option>{data.scope.operators.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <label><span>Situação</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="">Todas</option><option value="open">Aberto</option><option value="closing">Em fechamento</option><option value="suspended">Suspenso</option><option value="closed">Fechado</option><option value="reconciled">Conciliado</option><option value="reopened">Reaberto</option></select></label>
      <label><span>Ordenar</span><select value={draft.sort} onChange={(event) => setDraft({ ...draft, sort: event.target.value })}><option value="recent">Mais recentes</option><option value="oldest">Mais antigos</option><option value="difference_desc">Maior divergência</option></select></label>
      <label className={styles.check}><input type="checkbox" checked={draft.divergentOnly} onChange={(event) => setDraft({ ...draft, divergentOnly: event.target.checked, status: event.target.checked ? "closed" : draft.status })} /><span>Somente fora da tolerância</span></label>
      <div className={styles.filterActions}><button type="button" onClick={reset}>Limpar</button><button type="submit" className={styles.primary}>Aplicar filtros</button></div>
    </form>
    {tab === "sessions" && <SessionsView data={data} loading={loading} open={setDetail} page={page} />}
    {tab === "reconciliation" && <ReconciliationView data={data} open={setDetail} />}
    {tab === "performance" && <PerformanceView data={data} maxTrend={maxTrend} />}
    {tab === "custody" && <CustodyView entries={custody} open={setDetail} />}
    {detail && <Detail session={detail} tolerance={data.policy.closeToleranceCents} close={() => setDetail(undefined)} />}
  </div>;
}

function SessionsView({ data, loading, open, page }: { data: Data; loading: boolean; open: (item: Session) => void; page: (value: number) => void }) {
  return <section className={`${styles.panel} ${loading ? styles.dimmed : ""}`}><header><div><span>CONTROLE DE TURNOS</span><h2>Operação e histórico</h2><p>Valores esperados permanecem ocultos enquanto o turno não estiver fechado.</p></div><small>{number.format(data.pagination.total)} resultado(s)</small></header>
    {data.items.length ? <><div className={styles.tableScroll}><table><thead><tr><th>Turno / data</th><th>Filial / caixa</th><th>Operador</th><th>Situação</th><th>Vendas</th><th>Conferência</th><th>Pendências</th><th><span className={styles.srOnly}>Ação</span></th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><button className={styles.linkButton} type="button" onClick={() => open(item)}><strong>{item.number}</strong><small>{date.format(new Date(item.businessDate))}</small></button></td><td><strong>{item.register?.branch.name || "Sem filial"}</strong><small>{item.register?.name || item.registerName}</small></td><td><strong>{item.operator?.displayName || item.openedBy}</strong><small>{duration(openMinutes(item))}</small></td><td><Status value={item.status} /></td><td><strong>{cash(item.salesCents)}</strong><small>{item.salesCount} venda(s)</small></td><td>{item.expectedMasked ? <span className={styles.masked}>Oculto até o fechamento</span> : <><strong className={differenceClass(item.differenceCents)}>{signedCash(item.differenceCents)}</strong><small>declarado {cash(item.closingAmountCents)}</small></>}</td><td><Blocker value={item.blockers} /></td><td><button className={styles.inspect} type="button" onClick={() => open(item)} aria-label={`Ver detalhes de ${item.number}`}>Ver →</button></td></tr>)}</tbody></table></div><div className={styles.mobileList}>{data.items.map((item) => <article key={item.id}><header><Status value={item.status} /><small>{date.format(new Date(item.businessDate))}</small></header><button type="button" onClick={() => open(item)}><strong>{item.number}</strong><span>{item.register?.name || item.registerName} · {item.operator?.displayName || item.openedBy}</span></button><dl><div><dt>Vendas</dt><dd>{cash(item.salesCents)}</dd></div><div><dt>Diferença</dt><dd>{item.expectedMasked ? "Protegida" : signedCash(item.differenceCents)}</dd></div></dl><footer><Blocker value={item.blockers} /><button type="button" onClick={() => open(item)}>Ver detalhes</button></footer></article>)}</div><Pagination value={data.pagination} onChange={page} /></> : <Empty title="Nenhum turno encontrado" text="Ajuste os filtros ou opere uma abertura de turno no PDV." />}
  </section>;
}

function ReconciliationView({ data, open }: { data: Data; open: (item: Session) => void }) {
  const closed = data.items.filter((item) => ["closed", "reconciled"].includes(item.status));
  return <div className={styles.analyticsGrid}><section className={styles.panel}><header><div><span>MEIOS DE PAGAMENTO</span><h2>Esperado x declarado</h2><p>Consolidação somente de turnos encerrados no período.</p></div></header><div className={styles.tenderList}>{data.tenderSummary.map((item) => <article key={item.method}><div><b>{method(item.method)}</b><small>{item.sessions} conferência(s)</small></div><dl><div><dt>Esperado</dt><dd>{cash(item.expectedCents)}</dd></div><div><dt>Declarado</dt><dd>{cash(item.declaredCents)}</dd></div><div><dt>Diferença</dt><dd className={differenceClass(item.differenceCents)}>{signedCash(item.differenceCents)}</dd></div></dl></article>)}{!data.tenderSummary.length && <Empty title="Sem conferências no período" text="A composição por meio aparecerá após o primeiro fechamento." />}</div></section>
    <section className={styles.panel}><header><div><span>DIVERGÊNCIAS</span><h2>Fechamentos para revisar</h2><p>Ordenados pela diferença absoluta nesta página.</p></div></header><div className={styles.reviewList}>{closed.sort((a, b) => (b.absoluteDifferenceCents || 0) - (a.absoluteDifferenceCents || 0)).map((item) => <button type="button" key={item.id} onClick={() => open(item)}><span><strong>{item.number}</strong><small>{item.register?.name || item.registerName} · {item.operator?.displayName || item.openedBy}</small></span><b className={differenceClass(item.differenceCents)}>{signedCash(item.differenceCents)}</b></button>)}{!closed.length && <Empty title="Nenhum fechamento nesta página" text="Selecione outro período ou avance na paginação." />}</div></section>
  </div>;
}

function PerformanceView({ data, maxTrend }: { data: Data; maxTrend: number }) {
  return <div className={styles.analyticsGrid}><section className={`${styles.panel} ${styles.trendPanel}`}><header><div><span>EVOLUÇÃO DIÁRIA</span><h2>Vendas e qualidade do fechamento</h2><p>Volume vinculado aos turnos no intervalo selecionado.</p></div></header><div className={styles.chart} aria-label="Vendas diárias">{data.trend.map((item) => <div key={item.date} title={`${date.format(new Date(`${item.date}T12:00:00Z`))}: ${cash(item.salesCents)}`}><span><i style={{ height: `${Math.max(4, item.salesCents / maxTrend * 100)}%` }} /></span><small>{item.date.slice(5).replace("-", "/")}</small><em className={item.divergent ? styles.badDot : styles.goodDot}>{item.closed}</em></div>)}</div><div className={styles.legend}><span><i /> Vendas</span><span><i className={styles.goodDot} /> Fechamentos exatos</span><span><i className={styles.badDot} /> Com divergência</span></div></section><RankingPanel title="Desempenho por caixa" items={data.ranking.registers} /><RankingPanel title="Desempenho por operador" items={data.ranking.operators} /></div>;
}

function RankingPanel({ title, items }: { title: string; items: Ranking[] }) { const max = Math.max(1, ...items.map((item) => item.salesCents)); return <section className={styles.panel}><header><div><span>COMPARATIVO</span><h2>{title}</h2><p>Volume, sessões e diferença absoluta.</p></div></header><div className={styles.ranking}>{items.map((item, index) => <article key={`${item.id}-${item.name}`}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{item.name}</strong><small>{item.sessions} turno(s) · {item.exact} exato(s)</small><i><u style={{ width: `${item.salesCents / max * 100}%` }} /></i></span><div><strong>{cash(item.salesCents)}</strong><small>dif. {cash(item.differenceCents)}</small></div></article>)}{!items.length && <Empty title="Sem dados comparáveis" text="Amplie o período para gerar o ranking." />}</div></section>; }

function CustodyView({ entries, open }: { entries: Array<{ session: Session; bag: Session["custody"][number] }>; open: (item: Session) => void }) { return <section className={styles.panel}><header><div><span>CADEIA DE CUSTÓDIA</span><h2>Malotes, lacres e incidentes</h2><p>Acompanhe o estado mais recente e volte à razão do turno.</p></div><small>{entries.length} malote(s) nesta página</small></header><div className={styles.custodyGrid}>{entries.map(({ session, bag }) => <article key={bag.id} className={bag.incident && !bag.incident.resolved ? styles.incident : ""}><header><span>LACRE</span><Status value={bag.state} /></header><h3>{bag.sealNumber}</h3><strong>{cash(bag.amountCents)}</strong><p>{session.number} · {session.register?.name || session.registerName}</p><small>Selado em {dateTime.format(new Date(bag.sealedAt))}</small>{bag.incident && <div><b>{bag.incident.resolved ? "Incidente resolvido" : "Incidente em aberto"}</b><span>{signedCash(bag.incident.differenceCents)} · {bag.incident.description}</span></div>}<button type="button" onClick={() => open(session)}>Abrir trilha do turno →</button></article>)}{!entries.length && <Empty title="Nenhum malote no recorte" text="Malotes e incidentes criados pelo PDV aparecerão aqui com sua cadeia de custódia." />}</div></section>; }

function Detail({ session, tolerance, close }: { session: Session; tolerance: number; close: () => void }) {
  const blockers = blockerEntries(session.blockers);
  return <ErpModal close={close} className={styles.modal} label={`Detalhes do turno ${session.number}`}><article><header><div><span>TRILHA DO TURNO</span><h2>{session.number}</h2><p>{session.register?.branch.name || "Sem filial"} · {session.register?.name || session.registerName} · {session.operator?.displayName || session.openedBy}</p></div><button type="button" onClick={close} aria-label="Fechar">×</button></header><section className={styles.detailSummary}><div><small>Fundo inicial</small><strong>{cash(session.openingAmountCents)}</strong></div><div><small>Vendas</small><strong>{cash(session.salesCents)}</strong></div><div><small>Esperado</small><strong>{session.expectedMasked ? "Oculto até o fechamento" : cash(session.expectedAmountCents)}</strong></div><div><small>Diferença</small><strong className={differenceClass(session.differenceCents)}>{session.expectedMasked ? "Pendente" : signedCash(session.differenceCents)}</strong></div></section><dl className={styles.detailMeta}><div><dt>Situação</dt><dd><Status value={session.status} /></dd></div><div><dt>Período</dt><dd>{dateTime.format(new Date(session.openedAt))} → {session.closedAt ? dateTime.format(new Date(session.closedAt)) : "em andamento"}</dd></div><div><dt>Terminal</dt><dd>{session.terminal ? `${session.terminal.name} · ${session.terminal.status}` : "Não vinculado"}</dd></div><div><dt>Tolerância</dt><dd>{cash(tolerance)}</dd></div></dl>
    {blockers.length > 0 && <section className={styles.detailSection}><header><div><span>PENDÊNCIAS DE FECHAMENTO</span><h3>Resolva no PDV operacional</h3></div></header><div className={styles.chips}>{blockers.map(([label, count]) => <span key={label}><b>{count}</b>{label}</span>)}</div></section>}
    <section className={styles.detailSection}><header><div><span>CONFERÊNCIA CEGA</span><h3>Contagem por meio</h3></div></header>{session.expectedMasked ? <div className={styles.blind}><b>◉</b><span><strong>Valores protegidos</strong><small>O esperado só é revelado depois que a contagem é enviada pelo fluxo seguro do PDV.</small></span></div> : <div className={styles.paymentGrid}>{session.paymentCounts.map((item) => <article key={item.id}><header><strong>{method(item.method)}</strong><small>{item.provider || "Sem provedor"}</small></header><dl><div><dt>Esperado</dt><dd>{cash(item.expectedCents)}</dd></div><div><dt>Declarado</dt><dd>{cash(item.declaredCents)}</dd></div><div><dt>Diferença</dt><dd className={differenceClass(item.differenceCents)}>{signedCash(item.differenceCents)}</dd></div></dl></article>)}{!session.paymentCounts.length && <Empty title="Contagem não registrada" text="Este fechamento não possui decomposição por meio de pagamento." />}</div>}</section>
    {session.closeApproval && <section className={styles.approval}><span>APROVAÇÃO INDEPENDENTE</span><strong>{statusLabel(session.closeApproval.status)}</strong><p>{session.closeApproval.reason}</p><small>Solicitada por {session.closeApproval.requesterName}{session.closeApproval.approverName ? ` · decidida por ${session.closeApproval.approverName}` : ""}</small></section>}
    <section className={styles.detailSection}><header><div><span>EVENTOS OPERACIONAIS</span><h3>Suprimentos e sangrias</h3></div></header><div className={styles.timeline}>{session.events.map((event) => <article key={event.id}><i /><span><strong>{event.type === "supply" ? "Suprimento" : event.type === "withdrawal" ? "Sangria" : event.type}</strong><small>{event.description} · {event.actor}{event.approvedBy ? ` · aprovado por ${event.approvedBy}` : ""}</small></span><div><b className={differenceClass(event.signedAmountCents)}>{signedCash(event.signedAmountCents)}</b><time>{dateTime.format(new Date(event.createdAt))}</time></div></article>)}{!session.events.length && <Empty title="Sem movimentações manuais" text="Nenhum suprimento ou sangria foi registrado neste turno." />}</div></section>
    <section className={styles.detailSection}><header><div><span>RAZÃO IMUTÁVEL</span><h3>Lançamentos de numerário</h3></div></header><div className={styles.ledger}>{session.cashLedger.map((entry) => <article key={entry.id}><b>#{entry.sequence}</b><span><strong>{entryType(entry.entryType)}</strong><small>{entry.description} · {entry.reasonCode}</small></span><div><strong className={differenceClass(entry.deltaCents)}>{signedCash(entry.deltaCents)}</strong><small>{dateTime.format(new Date(entry.occurredAt))}</small></div></article>)}{!session.cashLedger.length && <Empty title="Razão sem lançamentos" text="Turnos antigos podem não possuir razão canônica de numerário." />}</div></section>
    {(session.openingNotes || session.closeNotes || session.suspendedReason) && <section className={styles.notes}><strong>Observações</strong>{session.openingNotes && <p><b>Abertura:</b> {session.openingNotes}</p>}{session.closeNotes && <p><b>Fechamento:</b> {session.closeNotes}</p>}{session.suspendedReason && <p><b>Suspensão:</b> {session.suspendedReason}</p>}</section>}
    <footer><button type="button" onClick={() => window.print()}>Imprimir relatório</button><Link href="/erp/pdv">Abrir PDV operacional</Link><button type="button" onClick={close} className={styles.primary}>Concluir</button></footer></article></ErpModal>;
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <article className={`${styles.metric} ${styles[tone] || ""}`}><header><span>{label}</span><i /></header><strong>{value}</strong><small>{detail}</small></article>; }
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" role="tab" aria-selected={active} onClick={onClick}>{children}</button>; }
function Status({ value }: { value: string }) { return <span className={`${styles.status} ${styles[`status_${value}`] || ""}`}>{statusLabel(value)}</span>; }
function Blocker({ value }: { value: Blockers }) { const total = blockerTotal(value); return total ? <span className={styles.blocker}><b>{total}</b> pendência(s)</span> : <span className={styles.ready}>Pronto</span>; }
function Pagination({ value, onChange }: { value: Data["pagination"]; onChange: (page: number) => void }) { return <footer className={styles.pagination}><span>Página {value.page} de {value.pages} · {value.total} registro(s)</span><div><button type="button" disabled={value.page <= 1} onClick={() => onChange(value.page - 1)}>← Anterior</button><button type="button" disabled={value.page >= value.pages} onClick={() => onChange(value.page + 1)}>Próxima →</button></div></footer>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className={styles.empty}><span>○</span><strong>{title}</strong><p>{text}</p></div>; }
function Loading() { return <div className={styles.skeleton} aria-label="Carregando fechamento de caixa"><header /><section>{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</section><div className={styles.skeletonBody} /></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className={styles.errorState}><span>!</span><h2>Não foi possível abrir o fechamento</h2><p>{message}</p><button type="button" onClick={retry}>Tentar novamente</button></div>; }
function filterParams(filters: Filters) { const params = new URLSearchParams({ from: filters.from, to: filters.to, page: String(filters.page), pageSize: String(filters.pageSize), sort: filters.sort }); for (const key of ["search", "status", "branchId", "registerId", "operatorProfileId"] as const) if (filters[key]) params.set(key, filters[key]); if (filters.divergentOnly) params.set("divergentOnly", "true"); return params.toString(); }
function cash(cents: number | null) { return money.format((cents || 0) / 100); }
function signedCash(cents: number | null) { const value = cents || 0; return `${value > 0 ? "+" : value < 0 ? "−" : ""}${cash(Math.abs(value))}`; }
function duration(minutes: number) { if (minutes < 60) return `${minutes} min`; const hours = Math.floor(minutes / 60); const rest = minutes % 60; return rest ? `${hours}h ${rest}min` : `${hours}h`; }
function openMinutes(item: Session) { return Math.max(0, Math.round(((item.closedAt ? new Date(item.closedAt) : new Date()).valueOf() - new Date(item.openedAt).valueOf()) / 60_000)); }
function blockerTotal(value: Blockers) { return Object.values(value).reduce((sum, count) => sum + count, 0); }
function blockerEntries(value: Blockers) { const labels: Record<keyof Blockers, string> = { heldSales: "vendas suspensas", payments: "pagamentos pendentes", paymentIntents: "intenções não resolvidas", paymentPlans: "planos ativos", manualReferences: "provas manuais", orderClaims: "pedidos em uso", integrityIncidents: "incidentes bloqueantes" }; return (Object.entries(value) as Array<[keyof Blockers, number]>).filter(([, count]) => count > 0).map(([key, count]) => [labels[key], count] as const); }
function differenceClass(value: number | null) { return (value || 0) < 0 ? styles.negativeText : (value || 0) > 0 ? styles.warningText : styles.positiveText; }
function statusLabel(value: string) { return ({ open: "Aberto", closing: "Em fechamento", suspended: "Suspenso", closed: "Fechado", reconciled: "Conciliado", reopened: "Reaberto", pending: "Pendente", approved: "Aprovado", consumed: "Consumido", denied: "Negado", sealed: "Lacrado", transferred: "Transferido", received: "Recebido", deposited: "Depositado" } as Record<string, string>)[value] || value.replaceAll("_", " "); }
function method(value: string) { return ({ cash: "Dinheiro", pix: "Pix", credit: "Crédito", debit: "Débito", voucher: "Voucher", store_credit: "Crédito da loja" } as Record<string, string>)[value] || value.replaceAll("_", " "); }
function entryType(value: string) { return ({ opening: "Abertura", sale_cash: "Venda em dinheiro", supply: "Suprimento", withdrawal: "Sangria", refund_cash: "Estorno em dinheiro", reversal: "Reversão", custody_seal: "Lacre de custódia" } as Record<string, string>)[value] || value.replaceAll("_", " "); }
