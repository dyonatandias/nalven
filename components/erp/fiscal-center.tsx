"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErpModal } from "@/components/erp/modal-portal";
import styles from "./fiscal-center.module.css";

type Branch = {
  id: number;
  code: string;
  name: string;
  document: string;
  settings?: { fiscalEnvironment: string } | null;
};
type FiscalEvent = { id: number; type: string; code?: string | null; description: string; actor: string; createdAt: string };
type FiscalOperation = {
  id: number;
  branchId: number;
  documentId?: number | null;
  type: string;
  status: string;
  priority: string;
  reason?: string | null;
  details?: unknown;
  correlationId: string;
  requestedBy: string;
  requestedAt: string;
  dueAt: string;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  resolution?: string | null;
  branch: Pick<Branch, "id" | "code" | "name">;
  document?: { type: string; series: number; number: number; recipient: string; status: string } | null;
};
type LegacyDocument = {
  id: number;
  branchId: number;
  type: string;
  series: number;
  number: number;
  status: string;
  environment: string;
  sourceType: string;
  sourceId: string;
  recipient: string;
  amount: number;
  amountCents: number;
  accessKey?: string | null;
  protocol?: string | null;
  rejectionCode?: string | null;
  rejectionMessage?: string | null;
  issuedAt?: string | null;
  cancelledAt?: string | null;
  attemptCount: number;
  lastQueuedAt?: string | null;
  slaDueAt?: string | null;
  createdAt: string;
  updatedAt: string;
  events: FiscalEvent[];
  operations: FiscalOperation[];
  branch: Pick<Branch, "id" | "code" | "name">;
};
type Certificate = {
  id: number;
  name: string;
  branchId: number;
  fingerprint: string;
  expiresAt: string;
  active: boolean;
  createdAt: string;
  branch: { code: string; name: string };
};
type PosDocument = {
  id: string;
  status: string;
  documentModel: string;
  environment: string;
  provider: string;
  series?: number | null;
  number?: number | null;
  accessKey?: string | null;
  authorizationProtocol?: string | null;
  rejectionCode?: string | null;
  rejectionMessage?: string | null;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
  branch: Pick<Branch, "id" | "code" | "name">;
  sale: { id: number; saleNumber: string; customer: string };
  attempts: Array<{ operation: string; state: string; dispatchCount: number; outcomeUnknown: boolean; failureCode?: string | null; createdAt: string }>;
  artifacts: Array<{ type: string; mimeType: string; createdAt: string }>;
  integrityIncidents: Array<{ kind: string; status: string; productionBlocking: boolean; createdAt: string }>;
};
type Inbound = {
  id: number;
  documentType: string;
  accessKey?: string | null;
  issuerName?: string | null;
  issuerDocument?: string | null;
  number?: string | null;
  series?: string | null;
  issueDate?: string | null;
  total?: number | null;
  status: string;
  classification: string;
  manifestationStatus: string;
  manifestationDeadline?: string | null;
  detectedAt: string;
  branch: Pick<Branch, "id" | "code" | "name">;
};
type Source = { id: number; branchId?: number | null; number: string; customerName: string; total: number; completedAt?: string | null; issuedTypes: string[] };
type Readiness = {
  branchId: number;
  branchName: string;
  status: string;
  score: number;
  issues: string[];
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
};
type FiscalData = {
  documents: LegacyDocument[];
  certificates: Certificate[];
  branches: Branch[];
  sources: Source[];
  posFiscal: PosDocument[];
  inbound: Inbound[];
  operations: FiscalOperation[];
  readiness: Readiness[];
  connectors: Array<{ id: string; branchId: number; type: string; provider: string; status: string; lastHealthOk?: boolean | null; lastCheckedAt?: string | null }>;
  cursors: Array<{ id: number; branchId: number; source: string; environment: string; enabled: boolean; status: string; lastSuccessAt?: string | null; nextSyncAt?: string | null; consecutiveFailures: number }>;
  trend: Array<{ date: string; total: number; authorized: number; rejected: number; amount: number }>;
  capabilities: { canWrite: boolean };
  generatedAt: string;
  pagination: { page: number; limit: number; total: number; pages: number };
  summary: {
    authorized: number; queued: number; rejected: number; outboundTotal: number; outboundAmount: number;
    authorizationRate: number; certificateAlerts: number; activeCertificates: number; posTotal: number;
    posAuthorized: number; posAttention: number; posAmount: number; posIncidents: number;
    inboundTotal: number; inboundReview: number; inboundAmount: number; branchesReady: number;
    branchesTotal: number; pendingOperations: number; overdueOperations: number;
  };
};
type Tab = "overview" | "operations" | "outbound" | "pos" | "inbound" | "certificates";
type ModalState =
  | { kind: "certificate" }
  | { kind: "document" }
  | { kind: "invalidation" }
  | { kind: "operation"; operation: string; document: LegacyDocument };

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = tenantDateTimeFormatter({ dateStyle: "short", timeStyle: "short" });
const shortDate = tenantDateTimeFormatter();
const labels: Record<string, string> = {
  draft: "Rascunho", queued: "Na fila", processing: "Processando", authorized: "Autorizado",
  rejected: "Rejeitado", contingency: "Contingência", cancelled: "Cancelado", created: "Criado",
  unknown: "Resultado incerto", manual_review: "Revisão manual", detected: "Detectado", review: "Em análise",
  imported: "Importado", ignored: "Ignorado", nfce: "NFC-e", nfe: "NF-e", nfse: "NFS-e",
  pending: "Pendente", completed: "Concluída", withdrawn: "Retirada", active: "Ativo", inactive: "Inativo",
  expired: "Vencido", issuance: "Emissão", retry: "Reprocessamento", status_query: "Reconsulta",
  cancellation: "Cancelamento", correction: "Carta de correção", invalidation: "Inutilização",
  request_issuance: "Emissão solicitada", urgent: "Urgente", normal: "Normal",
};

export function FiscalCenter() {
  const [data, setData] = useState<FiscalData>();
  const [tab, setTab] = useState<Tab>("overview");
  const [filters, setFilters] = useState({ search: "", status: "", type: "", environment: "", branchId: "", from: "", to: "" });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<ModalState | null>(null);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const query = queryString(applied, page);
      const response = await fetch(`/api/erp/fiscal?${query}`, { cache: "no-store" });
      const body = await response.json() as FiscalData & { error?: string };
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar a central fiscal.");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar a central fiscal.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applied, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function command(payload: Record<string, unknown>, success: string, key: string) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/erp/fiscal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Não foi possível concluir a operação.");
      setNotice(success);
      await load(true);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível concluir a operação.");
      return false;
    } finally {
      setBusy("");
    }
  }

  const eligibleSources = useMemo(
    () => data?.sources.filter((source) => source.branchId && source.issuedTypes.length < 3) || [],
    [data],
  );
  if (loading && !data) return <FiscalLoading />;
  if (!data) return <section className={styles.fatal}><h2>Central fiscal indisponível</h2><p>{error}</p><button onClick={() => void load()}>Tentar novamente</button></section>;

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: "overview", label: "Visão geral", count: data.summary.branchesTotal },
    { id: "operations", label: "Fila operacional", count: data.summary.pendingOperations },
    { id: "outbound", label: "Emissões", count: data.summary.outboundTotal },
    { id: "pos", label: "PDV fiscal", count: data.summary.posTotal },
    { id: "inbound", label: "DF-e recebidos", count: data.summary.inboundTotal },
    { id: "certificates", label: "Certificados A1", count: data.certificates.length },
  ];
  const referenceTime = Date.parse(data.generatedAt);
  const exportUrl = `/api/erp/fiscal?${queryString(applied, 1, "csv")}`;

  return <div className={styles.workspace}>
    <section className={styles.hero}>
      <div>
        <span className={styles.eyebrow}>CONTROLE FISCAL UNIFICADO</span>
        <h2>Central Fiscal</h2>
        <p>Operação de saída, PDV, documentos recebidos, certificados, SLA e integridade fiscal por filial — com rastreabilidade do pedido ao retorno do conector.</p>
      </div>
      <div className={styles.heroActions}>
        <a href={exportUrl}>Exportar CSV</a>
        <button disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "Atualizando…" : "Atualizar"}</button>
        {data.capabilities.canWrite && <button onClick={() => setModal({ kind: "invalidation" })}>Inutilizar faixa</button>}
        {data.capabilities.canWrite && <button className={styles.primary} disabled={!eligibleSources.length} onClick={() => setModal({ kind: "document" })}>Novo documento</button>}
      </div>
    </section>

    <div className={styles.live} aria-live="polite">
      {error && <div className={styles.error} role="alert"><b>!</b><span>{error}</span><button aria-label="Fechar erro" onClick={() => setError("")}>×</button></div>}
      {notice && <div className={styles.notice}><b>✓</b><span>{notice}</span><button aria-label="Fechar aviso" onClick={() => setNotice("")}>×</button></div>}
    </div>

    <section className={styles.metrics} aria-label="Indicadores fiscais">
      <Metric label="Taxa de autorização" value={`${formatNumber(data.summary.authorizationRate)}%`} detail={`${data.summary.authorized + data.summary.posAuthorized} documentos autorizados`} tone="success" />
      <Metric label="Valor fiscal de saída" value={money.format(data.summary.outboundAmount + data.summary.posAmount)} detail="Pedidos comerciais e vendas do PDV" />
      <Metric label="Fila operacional" value={String(data.summary.pendingOperations)} detail={`${data.summary.overdueOperations} fora do SLA`} tone={data.summary.overdueOperations ? "danger" : "info"} />
      <Metric label="Exceções fiscais" value={String(data.summary.rejected + data.summary.posAttention + data.summary.posIncidents)} detail="Rejeições, incertezas e integridade" tone="warning" />
      <Metric label="DF-e recebidos" value={String(data.summary.inboundTotal)} detail={`${data.summary.inboundReview} aguardando análise`} tone="info" />
      <Metric label="Filiais prontas" value={`${data.summary.branchesReady}/${data.summary.branchesTotal}`} detail="Cadastro, certificado, conector e DF-e" tone={data.summary.branchesReady === data.summary.branchesTotal ? "success" : "warning"} />
    </section>

    <nav className={styles.tabs} aria-label="Áreas da central fiscal">
      {tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? styles.active : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><span>{item.label}</span><b>{item.count}</b></button>)}
    </nav>

    {tab === "overview" && <Overview data={data} openCertificates={() => setTab("certificates")} />}
    {tab === "operations" && <Operations data={data} busy={busy} referenceTime={referenceTime} withdraw={(id) => void command({ action: "operation.withdraw", operationId: id }, "Solicitação retirada antes do processamento.", `withdraw-${id}`)} openInvalidation={() => setModal({ kind: "invalidation" })} />}
    {tab === "outbound" && <Outbound data={data} filters={filters} setFilters={setFilters} apply={() => { setPage(1); setApplied(filters); }} clear={() => { const empty = { search: "", status: "", type: "", environment: "", branchId: "", from: "", to: "" }; setFilters(empty); setApplied(empty); setPage(1); }} page={page} setPage={setPage} busy={busy} queue={(id) => void command({ action: "queue", documentId: id }, "Emissão solicitada e encaminhada à fila do conector.", `queue-${id}`)} operate={(operation, document) => setModal({ kind: "operation", operation, document })} />}
    {tab === "pos" && <PosFiscal items={data.posFiscal} />}
    {tab === "inbound" && <InboundDocuments items={data.inbound} referenceTime={referenceTime} />}
    {tab === "certificates" && <Certificates data={data} referenceTime={referenceTime} busy={busy} add={() => setModal({ kind: "certificate" })} toggle={(certificate) => void command({ action: "certificate.toggle", certificateId: certificate.id }, certificate.active ? "Certificado desativado." : "Certificado ativado e os demais da filial desativados.", `certificate-${certificate.id}`)} />}

    <footer className={styles.updated}>Atualizado em {dateTime.format(new Date(data.generatedAt))} · consulta privada, sem cache</footer>
    {modal && <FiscalDialog state={modal} data={data} close={() => setModal(null)} busy={Boolean(busy)} submit={async (payload) => {
      const success = modalSuccess(modal);
      const action = modal.kind === "certificate" ? "certificate.save" : modal.kind === "document" ? "document.create" : "operation.request";
      const ok = await command({ action, ...(modal.kind === "operation" ? { operation: modal.operation, documentId: modal.document.id } : modal.kind === "invalidation" ? { operation: "invalidation" } : {}), ...payload }, success, `modal-${modal.kind}`);
      if (ok) setModal(null);
    }} />}
  </div>;
}

function Metric({ label, value, detail, tone = "" }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className={`${styles.metric} ${tone ? styles[tone] : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function Overview({ data, openCertificates }: { data: FiscalData; openCertificates: () => void }) {
  const max = Math.max(1, ...data.trend.map((item) => item.total));
  return <div className={styles.overviewGrid}>
    <section className={styles.panel}>
      <header><div><span>PRONTIDÃO OPERACIONAL</span><h3>Filiais e dependências</h3><p>Cinco verificações para cada ambiente fiscal.</p></div><b>{data.summary.branchesReady}/{data.summary.branchesTotal}</b></header>
      <div className={styles.readiness}>{data.readiness.map((item) => <article key={item.branchId} className={item.status === "ready" ? styles.ready : styles.attention}>
        <div className={styles.readinessTitle}><i>{item.status === "ready" ? "✓" : "!"}</i><span><strong>{item.branchName}</strong><small>{item.score}% de prontidão</small></span><b>{item.score}%</b></div>
        <div className={styles.scoreTrack}><span style={{ width: `${item.score}%` }} /></div>
        <ul>{item.checks.map((check) => <li key={check.key} className={check.ok ? styles.checkOk : styles.checkFail}><b>{check.ok ? "✓" : "!"}</b><span><strong>{check.label}</strong><small>{check.ok ? check.detail : item.issues.find((issue) => issue === check.detail) || check.detail}</small></span></li>)}</ul>
      </article>)}</div>
    </section>

    <section className={`${styles.panel} ${styles.trendPanel}`}>
      <header><div><span>ÚLTIMOS 14 DIAS</span><h3>Volume diário de saída</h3><p>Emissões comerciais e fiscais do PDV.</p></div><b>{data.trend.reduce((sum, day) => sum + day.total, 0)}</b></header>
      <div className={styles.chart} role="img" aria-label="Gráfico de documentos fiscais dos últimos 14 dias">
        {data.trend.map((day) => <div key={day.date} title={`${shortDate.format(new Date(`${day.date}T00:00:00.000Z`))}: ${day.total} documentos, ${day.authorized} autorizados`}><span className={styles.barTotal} style={{ height: `${Math.max(5, day.total * 100 / max)}%` }}><i style={{ height: `${day.total ? day.authorized * 100 / day.total : 0}%` }} /></span><small>{day.date.slice(8)}</small></div>)}
      </div>
      <div className={styles.chartLegend}><span><i className={styles.legendTotal} />Total</span><span><i className={styles.legendAuthorized} />Autorizado</span></div>
    </section>

    <section className={`${styles.panel} ${styles.connectorPanel}`}>
      <header><div><span>INTEGRAÇÕES</span><h3>Saúde dos conectores</h3></div></header>
      <div className={styles.connectorList}>{data.branches.map((branch) => {
        const connector = data.connectors.find((item) => item.branchId === branch.id);
        const cursor = data.cursors.find((item) => item.branchId === branch.id && item.enabled);
        return <article key={branch.id}><div><strong>{branch.code} · {branch.name}</strong><small>{connector?.provider || "Conector de emissão não configurado"}</small></div><Status value={connector?.lastHealthOk ? "active" : "manual_review"} /><div><strong>DF-e {cursor ? statusLabel(cursor.status) : "não configurado"}</strong><small>{cursor?.lastSuccessAt ? `Último sucesso ${dateTime.format(new Date(cursor.lastSuccessAt))}` : "Sem sincronização confirmada"}</small></div></article>;
      })}</div>
    </section>

    <aside className={styles.side}><h3>Controles de segurança</h3><ul>
      <li><b>01</b><span><strong>Segredos protegidos</strong><small>PFX e senha são cifrados e nunca retornam à interface.</small></span></li>
      <li><b>02</b><span><strong>Eventos imutáveis</strong><small>Histórico do documento é apenas anexado e toda mutação possui correlação.</small></span></li>
      <li><b>03</b><span><strong>Numeração serializada</strong><small>Série e número são reservados com bloqueio transacional.</small></span></li>
      <li><b>04</b><span><strong>Resultado externo soberano</strong><small>A interface solicita operações; somente o conector confirma o resultado.</small></span></li>
    </ul>{data.summary.certificateAlerts > 0 && <button onClick={openCertificates}>{data.summary.certificateAlerts} alerta(s) de certificado</button>}</aside>
  </div>;
}

function Operations({ data, busy, referenceTime, withdraw, openInvalidation }: {
  data: FiscalData; busy: string; referenceTime: number; withdraw: (id: number) => void; openInvalidation: () => void;
}) {
  const [status, setStatus] = useState("open");
  const [branchId, setBranchId] = useState("");
  const shown = data.operations.filter((operation) =>
    (!branchId || String(operation.branchId) === branchId)
    && (status === "all" || (status === "open" ? ["pending", "processing"].includes(operation.status) : operation.status === status)));
  return <section className={styles.panel}>
    <header><div><span>ORQUESTRAÇÃO FISCAL</span><h3>Fila de solicitações</h3><p>Prioridade, prazo, vínculo, justificativa e correlação de cada ação.</p></div>{data.capabilities.canWrite && <button className={styles.primaryAction} onClick={openInvalidation}>Solicitar inutilização</button>}</header>
    <div className={styles.queueFilters}><label><span>Situação</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="open">Em aberto</option><option value="all">Todas</option><option value="completed">Concluídas</option><option value="rejected">Rejeitadas</option><option value="withdrawn">Retiradas</option></select></label><label><span>Filial</span><select value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">Todas</option>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>)}</select></label><p><b>{shown.length}</b> solicitações na visão atual</p></div>
    {!shown.length ? <Empty title="Nenhuma solicitação nesta visão" detail="A fila exibirá emissão, reconsulta, contingência, cancelamento, correção e inutilização." /> : <div className={styles.operationList}>{shown.map((operation) => {
      const overdue = ["pending", "processing"].includes(operation.status) && Date.parse(operation.dueAt) < referenceTime;
      const detail = operationDetails(operation.details);
      return <article key={operation.id} className={overdue ? styles.overdue : ""}>
        <div className={styles.operationIcon}>{operation.priority === "urgent" ? "!" : String(operation.id).padStart(2, "0").slice(-2)}</div>
        <div className={styles.operationIdentity}><span>{operation.branch.code} · {statusLabel(operation.type)}</span><strong>{operation.document ? `${operation.document.type.toUpperCase()} ${operation.document.series}/${operation.document.number} · ${operation.document.recipient}` : detail || "Solicitação sem documento vinculado"}</strong><small>{operation.reason || "Sem justificativa"}</small></div>
        <div><small>Solicitada</small><strong>{dateTime.format(new Date(operation.requestedAt))}</strong><span>{operation.requestedBy}</span></div>
        <div><small>Prazo operacional</small><strong className={overdue ? styles.dangerText : ""}>{dateTime.format(new Date(operation.dueAt))}</strong><span>{overdue ? "Fora do SLA" : statusLabel(operation.priority)}</span></div>
        <Status value={operation.status} />
        {data.capabilities.canWrite && operation.status === "pending" && !["issuance", "retry"].includes(operation.type) ? <button disabled={Boolean(busy)} onClick={() => withdraw(operation.id)}>{busy === `withdraw-${operation.id}` ? "Retirando…" : "Retirar"}</button> : <code title={operation.correlationId}>{operation.correlationId.slice(0, 8)}</code>}
      </article>;
    })}</div>}
  </section>;
}

function Outbound({ data, filters, setFilters, apply, clear, page, setPage, busy, queue, operate }: {
  data: FiscalData;
  filters: Record<string, string>;
  setFilters: (value: { search: string; status: string; type: string; environment: string; branchId: string; from: string; to: string }) => void;
  apply: () => void;
  clear: () => void;
  page: number;
  setPage: (value: number) => void;
  busy: string;
  queue: (id: number) => void;
  operate: (operation: string, document: LegacyDocument) => void;
}) {
  const update = (key: string, value: string) => setFilters({ ...filters, [key]: value } as typeof filters & { search: string; status: string; type: string; environment: string; branchId: string; from: string; to: string });
  return <section className={styles.panel}>
    <header><div><span>DOCUMENTOS COMERCIAIS</span><h3>Emissões de saída</h3><p>Filtros por período, ambiente, status, modelo e filial; exportação respeita a visão aplicada.</p></div><b>{data.pagination.total}</b></header>
    <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); apply(); }} role="search">
      <label className={styles.search}><span>Buscar</span><input value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Destinatário, origem, protocolo ou chave" /></label>
      <label><span>Status</span><select value={filters.status} onChange={(event) => update("status", event.target.value)}><option value="">Todos</option>{["draft", "queued", "processing", "authorized", "rejected", "contingency", "cancelled"].map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}</select></label>
      <label><span>Modelo</span><select value={filters.type} onChange={(event) => update("type", event.target.value)}><option value="">Todos</option><option value="nfe">NF-e</option><option value="nfce">NFC-e</option><option value="nfse">NFS-e</option></select></label>
      <label><span>Ambiente</span><select value={filters.environment} onChange={(event) => update("environment", event.target.value)}><option value="">Todos</option><option value="production">Produção</option><option value="homologation">Homologação</option></select></label>
      <label><span>Filial</span><select value={filters.branchId} onChange={(event) => update("branchId", event.target.value)}><option value="">Todas</option>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>)}</select></label>
      <label><span>De</span><input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => update("from", event.target.value)} /></label>
      <label><span>Até</span><input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => update("to", event.target.value)} /></label>
      <div className={styles.filterActions}><button type="button" onClick={clear}>Limpar</button><button className={styles.filterPrimary}>Aplicar filtros</button></div>
    </form>
    {!data.documents.length ? <Empty title="Nenhum documento encontrado" detail="Ajuste os filtros ou prepare um documento a partir de um pedido concluído." /> : <div className={styles.documentList}>{data.documents.map((document) => <DocumentCard key={document.id} document={document} busy={busy} queue={queue} operate={operate} />)}</div>}
    <div className={styles.pagination}><button disabled={page <= 1} onClick={() => setPage(page - 1)}>← Anterior</button><span>Página {page} de {data.pagination.pages} · {data.pagination.total} resultado(s)</span><button disabled={page >= data.pagination.pages} onClick={() => setPage(page + 1)}>Próxima →</button></div>
  </section>;
}

function DocumentCard({ document, busy, queue, operate }: { document: LegacyDocument; busy: string; queue: (id: number) => void; operate: (operation: string, document: LegacyDocument) => void }) {
  const operations = availableOperations(document);
  const pending = document.operations.filter((operation) => ["pending", "processing"].includes(operation.status));
  return <article className={styles.documentCard}>
    <header><div><span>{document.branch.code} · {document.type.toUpperCase()} · {document.environment === "production" ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}</span><h4>{document.recipient}</h4><small>Série {String(document.series).padStart(3, "0")} · Número {String(document.number).padStart(9, "0")} · {document.attemptCount} tentativa(s)</small></div><Status value={document.status} /></header>
    <div className={styles.documentFacts}><span><small>Valor</small><strong>{money.format(document.amountCents / 100)}</strong></span><span><small>Emissão</small><strong>{document.issuedAt ? dateTime.format(new Date(document.issuedAt)) : "Não autorizada"}</strong></span><span><small>Protocolo</small><strong>{document.protocol || "—"}</strong></span><span><small>Chave</small><strong title={document.accessKey || undefined}>{mask(document.accessKey)}</strong></span><span><small>Fila / SLA</small><strong>{document.slaDueAt ? dateTime.format(new Date(document.slaDueAt)) : "—"}</strong></span></div>
    {document.rejectionMessage && <p className={styles.rejection}><b>{document.rejectionCode || "Última rejeição"}</b><span>{document.rejectionMessage}</span></p>}
    {pending.length > 0 && <div className={styles.pendingStrip}>{pending.map((operation) => <span key={operation.id}>{statusLabel(operation.type)} · {statusLabel(operation.status)}</span>)}</div>}
    <details><summary>Histórico e rastreabilidade ({document.events.length} eventos)</summary><ol>{document.events.map((event) => <li key={event.id}><span><strong>{statusLabel(event.type)}</strong><small>{event.description} · {event.actor}</small></span><time>{dateTime.format(new Date(event.createdAt))}</time></li>)}</ol></details>
    <footer><small>Origem {document.sourceType} #{document.sourceId} · atualizado {dateTime.format(new Date(document.updatedAt))}</small><div className={styles.cardActions}>{document.status === "draft" && <button disabled={Boolean(busy)} onClick={() => queue(document.id)}>{busy === `queue-${document.id}` ? "Enviando…" : "Solicitar emissão"}</button>}{operations.length > 0 && <label><span className={styles.srOnly}>Ações para {document.recipient}</span><select aria-label={`Ações para ${document.recipient}`} value="" disabled={Boolean(busy)} onChange={(event) => { if (event.target.value) operate(event.target.value, document); }}><option value="">Mais ações…</option>{operations.map((operation) => <option key={operation} value={operation}>{statusLabel(operation)}</option>)}</select></label>}</div></footer>
  </article>;
}

function PosFiscal({ items }: { items: PosDocument[] }) {
  return <section className={styles.panel}><header><div><span>TRANSMISSÃO HOMOLOGADA</span><h3>Documentos fiscais do PDV</h3><p>Retorno real do provedor, tentativas, artefatos e incidentes de integridade.</p></div><b>{items.length} recentes</b></header>
    {!items.length ? <Empty title="Nenhuma emissão fiscal do PDV" detail="A central exibirá documentos quando um perfil fiscal e um conector homologado processarem vendas." /> : <div className={styles.compactList}>{items.map((item) => <article key={item.id} className={item.integrityIncidents.length ? styles.compactDanger : ""}>
      <div className={styles.compactIdentity}><i className={item.integrityIncidents.length ? styles.dangerDot : ""}>{item.documentModel.toUpperCase()}</i><span><strong>{item.sale.saleNumber} · {item.sale.customer}</strong><small>{item.branch.code} · {item.provider} · {dateTime.format(new Date(item.createdAt))}</small></span></div>
      <span><small>Valor</small><strong>{money.format(item.totalCents / 100)}</strong></span>
      <span><small>Numeração</small><strong>{item.series && item.number ? `${item.series}/${item.number}` : "Provedor"}</strong></span>
      <span><small>Última tentativa</small><strong>{item.attempts[0]?.outcomeUnknown ? "Resultado incerto" : item.attempts[0] ? statusLabel(item.attempts[0].state) : "—"}</strong></span>
      <span><small>Artefatos</small><strong>{item.artifacts.length ? item.artifacts.map((artifact) => artifact.type.toUpperCase()).join(" · ") : "Nenhum"}</strong></span>
      <Status value={item.integrityIncidents.length ? "manual_review" : item.status} />
      {(item.rejectionMessage || item.integrityIncidents.length > 0 || item.attempts.length > 0) && <details><summary>Diagnóstico fiscal</summary>{item.rejectionMessage && <p><b>{item.rejectionCode || "Rejeição"}</b> {item.rejectionMessage}</p>}<ul>{item.integrityIncidents.map((incident) => <li key={`${incident.kind}-${incident.createdAt}`}>Incidente {statusLabel(incident.kind)} · {incident.productionBlocking ? "bloqueia produção" : "não bloqueante"}</li>)}{item.attempts.map((attempt) => <li key={`${attempt.operation}-${attempt.createdAt}`}>{statusLabel(attempt.operation)} · {statusLabel(attempt.state)} · {attempt.dispatchCount} despacho(s){attempt.failureCode ? ` · ${attempt.failureCode}` : ""}</li>)}</ul></details>}
    </article>)}</div>}
  </section>;
}

function InboundDocuments({ items, referenceTime }: { items: Inbound[]; referenceTime: number }) {
  return <section className={styles.panel}><header><div><span>DF-e RECEBIDOS</span><h3>Documentos contra o CNPJ</h3><p>Triagem resumida com alerta de manifestação; conferência e escrituração seguem na Entrada NF-e.</p></div><Link href="/erp/entrada-nfe">Abrir Entrada NF-e →</Link></header>
    {!items.length ? <Empty title="Nenhum DF-e detectado" detail="Configure o recebimento por filial e consulte o ambiente da SEFAZ." /> : <div className={styles.compactList}>{items.map((item) => {
      const deadline = item.manifestationDeadline ? Date.parse(item.manifestationDeadline) : null;
      const urgent = deadline !== null && deadline < referenceTime + 2 * 86_400_000 && !["confirmed", "unknown_operation", "rejected"].includes(item.manifestationStatus);
      return <article key={item.id} className={urgent ? styles.compactWarning : ""}><div className={styles.compactIdentity}><i>{item.documentType.toUpperCase()}</i><span><strong>{item.issuerName || "Emitente não identificado"}</strong><small>{item.branch.code} · Nº {item.number || "—"} · Série {item.series || "—"}</small></span></div><span><small>Emissão</small><strong>{item.issueDate ? shortDate.format(new Date(item.issueDate)) : "—"}</strong></span><span><small>Valor</small><strong>{item.total == null ? "—" : money.format(item.total)}</strong></span><span><small>Manifestação</small><strong>{statusLabel(item.manifestationStatus)}</strong></span><span><small>Prazo</small><strong className={urgent ? styles.dangerText : ""}>{item.manifestationDeadline ? shortDate.format(new Date(item.manifestationDeadline)) : "—"}</strong></span><Status value={item.status} /></article>;
    })}</div>}
  </section>;
}

function Certificates({ data, referenceTime, busy, add, toggle }: { data: FiscalData; referenceTime: number; busy: string; add: () => void; toggle: (certificate: Certificate) => void }) {
  return <section className={styles.panel}><header><div><span>IDENTIDADE DIGITAL</span><h3>Certificados A1 por filial</h3><p>Apenas um certificado pode permanecer ativo por filial; a validade exibida é a informada no cadastro.</p></div>{data.capabilities.canWrite && <button className={styles.primaryAction} onClick={add}>Instalar A1</button>}</header>
    {!data.certificates.length ? <Empty title="Nenhum certificado instalado" detail="Instale um arquivo PFX/P12 para preparar a operação fiscal da filial." /> : <div className={styles.certificateList}>{data.certificates.map((certificate) => {
      const expiry = Date.parse(certificate.expiresAt);
      const expired = expiry < referenceTime;
      const soon = expiry < referenceTime + 30 * 86_400_000;
      return <article key={certificate.id}><div className={styles.certificateIcon}>{expired ? "!" : "A1"}</div><div><strong>{certificate.name}</strong><small>{certificate.branch.code} · {certificate.branch.name}</small><code>SHA-256 {maskFingerprint(certificate.fingerprint)}</code></div><span><small>Validade informada</small><strong className={soon ? styles.warningText : ""}>{shortDate.format(new Date(certificate.expiresAt))}</strong></span><Status value={expired ? "expired" : certificate.active ? "active" : "inactive"} />{data.capabilities.canWrite && <button disabled={Boolean(busy) || expired && !certificate.active} onClick={() => toggle(certificate)}>{busy === `certificate-${certificate.id}` ? "Salvando…" : certificate.active ? "Desativar" : "Ativar"}</button>}</article>;
    })}</div>}
  </section>;
}

function FiscalDialog({ state, data, close, busy, submit }: { state: ModalState; data: FiscalData; close: () => void; busy: boolean; submit: (payload: Record<string, unknown>) => Promise<void> }) {
  const [documentType, setDocumentType] = useState("nfe");
  const [selectedBranch, setSelectedBranch] = useState(String(data.branches[0]?.id || ""));
  const [fileError, setFileError] = useState("");
  const sources = data.sources.filter((source) => String(source.branchId) === selectedBranch && !source.issuedTypes.includes(documentType));
  const title = state.kind === "certificate" ? "Instalar certificado A1" : state.kind === "document" ? "Preparar documento fiscal" : state.kind === "invalidation" ? "Solicitar inutilização de faixa" : statusLabel(state.operation);
  const eyebrow = state.kind === "certificate" ? "IDENTIDADE DIGITAL" : state.kind === "document" ? "NUMERAÇÃO FISCAL" : "OPERAÇÃO CONTROLADA";
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFileError("");
    const form = new FormData(event.currentTarget);
    const values: Record<string, unknown> = Object.fromEntries(form);
    if (state.kind === "certificate") {
      const file = form.get("certificate");
      if (!(file instanceof File) || !file.size) return setFileError("Selecione um arquivo PFX ou P12.");
      if (file.size > 1_100_000) return setFileError("O certificado excede o limite de 1 MB.");
      delete values.certificate;
      values.content = await fileBase64(file);
    }
    await submit(values);
  }
  return <ErpModal close={close} className={styles.modalLayer} label={title}><form className={styles.dialog} onSubmit={(event) => void save(event)}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2><p>{dialogDescription(state)}</p></div><button type="button" aria-label="Fechar" onClick={close}>×</button></header>
    <div className={styles.dialogFields}>
      {state.kind === "certificate" && <><label><span>Nome de identificação</span><input name="name" maxLength={100} required placeholder="A1 Matriz 2027" /></label><label><span>Filial</span><select name="branchId" required>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>)}</select></label><label className={styles.wide}><span>Arquivo PFX ou P12 · máximo 1 MB</span><input name="certificate" type="file" accept=".pfx,.p12,application/x-pkcs12" required /></label><label><span>Senha do certificado</span><input name="password" type="password" autoComplete="new-password" maxLength={300} required /></label><label><span>Validade conferida no certificado</span><input name="expiresAt" type="date" min={data.generatedAt.slice(0, 10)} required /></label>{fileError && <p className={`${styles.inlineError} ${styles.wide}`} role="alert">{fileError}</p>}</>}
      {state.kind === "document" && <><label><span>Filial fiscal</span><select name="branchId" value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} required>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name} · {branch.settings?.fiscalEnvironment === "production" ? "produção" : "homologação"}</option>)}</select></label><label><span>Modelo</span><select name="type" value={documentType} onChange={(event) => setDocumentType(event.target.value)}><option value="nfe">NF-e</option><option value="nfce">NFC-e</option><option value="nfse">NFS-e</option></select></label><label className={styles.wide}><span>Pedido concluído ainda não emitido neste modelo</span><select name="sourceId" required defaultValue=""><option value="">Selecione um pedido</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.number} · {source.customerName} · {money.format(source.total)}</option>)}</select>{!sources.length && <small>Nenhum pedido elegível para esta filial e modelo.</small>}</label></>}
      {state.kind === "operation" && <><div className={`${styles.contextBox} ${styles.wide}`}><span>{state.document.branch.code} · {state.document.type.toUpperCase()} {state.document.series}/{state.document.number}</span><strong>{state.document.recipient}</strong><small>{money.format(state.document.amountCents / 100)} · {statusLabel(state.document.status)}</small></div><label><span>Prioridade operacional</span><select name="priority" defaultValue={state.operation === "contingency" ? "urgent" : "normal"}><option value="normal">Normal</option><option value="urgent">Urgente</option></select></label><label className={styles.wide}><span>Justificativa · 15 a 500 caracteres</span><textarea name="reason" minLength={15} maxLength={500} required placeholder={operationPlaceholder(state.operation)} /></label></>}
      {state.kind === "invalidation" && <><label><span>Filial</span><select name="branchId" required>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>)}</select></label><label><span>Modelo</span><select name="documentType" defaultValue="nfe"><option value="nfe">NF-e</option><option value="nfce">NFC-e</option><option value="nfse">NFS-e</option></select></label><label><span>Série</span><input name="series" type="number" min="1" max="999" required /></label><label><span>Número inicial</span><input name="startNumber" type="number" min="1" max="999999999" required /></label><label><span>Número final · até 10.000 posições</span><input name="endNumber" type="number" min="1" max="999999999" required /></label><label><span>Prioridade operacional</span><select name="priority" defaultValue="normal"><option value="normal">Normal</option><option value="urgent">Urgente</option></select></label><label className={styles.wide}><span>Justificativa · 15 a 500 caracteres</span><textarea name="reason" minLength={15} maxLength={500} required placeholder="Explique por que esta faixa não foi utilizada." /></label></>}
    </div>
    <footer><button type="button" onClick={close}>Cancelar</button><button className={styles.primary} disabled={busy || state.kind === "document" && !sources.length}>{busy ? "Salvando…" : state.kind === "certificate" ? "Instalar com segurança" : state.kind === "document" ? "Reservar numeração" : "Registrar solicitação"}</button></footer>
  </form></ErpModal>;
}

function Status({ value }: { value: string }) {
  const tone = ["authorized", "received", "active", "ready", "completed"].includes(value) ? "ok" : ["rejected", "cancelled", "expired", "manual_review", "unknown"].includes(value) ? "bad" : ["draft", "inactive", "detected", "withdrawn"].includes(value) ? "neutral" : "pending";
  return <em className={`${styles.status} ${styles[tone]}`}><i />{statusLabel(value)}</em>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.empty}><span>FISCAL</span><h3>{title}</h3><p>{detail}</p></div>;
}

function FiscalLoading() {
  return <div className={styles.loading} aria-label="Carregando central fiscal"><span /><div /><div /><div /><p>Consolidando emissões, DF-e, fila e prontidão fiscal…</p></div>;
}

function queryString(filters: Record<string, string>, page: number, format = "") {
  const query = new URLSearchParams({ page: String(page), limit: "12" });
  Object.entries(filters).forEach(([key, value]) => { if (value.trim()) query.set(key, value.trim()); });
  if (format) query.set("format", format);
  return query.toString();
}

function availableOperations(document: LegacyDocument) {
  const pending = new Set(document.operations.filter((operation) => ["pending", "processing"].includes(operation.status)).map((operation) => operation.type));
  if (document.status === "rejected") return pending.has("retry") ? [] : ["retry"];
  if (["queued", "processing"].includes(document.status)) return ["status_query", "contingency"].filter((operation) => !pending.has(operation));
  if (document.status === "contingency") return pending.has("status_query") ? [] : ["status_query"];
  if (document.status === "authorized") return ["cancellation", ...(document.type === "nfe" ? ["correction"] : [])].filter((operation) => !pending.has(operation));
  return [];
}

function dialogDescription(state: ModalState) {
  if (state.kind === "certificate") return "O PFX e a senha são cifrados e nunca retornam pela API. Confira a validade diretamente no certificado.";
  if (state.kind === "document") return "A reserva de série e número é atômica. A autorização depende do retorno assinado do conector homologado.";
  if (state.kind === "invalidation") return "A faixa é validada contra documentos existentes e registrada como solicitação; o conector confirma o resultado externo.";
  return "A solicitação entra na fila com SLA e correlação. O estado fiscal só muda quando houver retorno legítimo do conector.";
}

function modalSuccess(state: ModalState) {
  if (state.kind === "certificate") return "Certificado instalado, cifrado e ativado para a filial.";
  if (state.kind === "document") return "Documento preparado com numeração reservada.";
  if (state.kind === "invalidation") return "Inutilização registrada na fila operacional.";
  return `${statusLabel(state.operation)} registrado(a) na fila operacional.`;
}

function operationPlaceholder(operation: string) {
  return ({ retry: "Descreva a correção realizada antes do reprocessamento.", status_query: "Informe o motivo da reconsulta do estado fiscal.", contingency: "Descreva a indisponibilidade que exige contingência.", cancellation: "Informe o motivo comercial ou operacional do cancelamento.", correction: "Descreva com precisão o texto a corrigir, sem alterar valores ou destinatário." } as Record<string, string>)[operation] || "Informe a justificativa desta operação.";
}

function operationDetails(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const details = value as Record<string, unknown>;
  return details.documentType && details.series && details.startNumber && details.endNumber
    ? `${String(details.documentType).toUpperCase()} · série ${details.series} · ${details.startNumber} a ${details.endNumber}`
    : "";
}

function statusLabel(value: string) { return labels[value] || value.replaceAll("_", " "); }
function mask(value?: string | null) { return value ? `${value.slice(0, 6)}…${value.slice(-6)}` : "—"; }
function maskFingerprint(value: string) { return `${value.slice(0, 8)}…${value.slice(-8)}`; }
function formatNumber(value: number) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value); }
async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
