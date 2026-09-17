"use client";

import { tenantDateTimeFormatter, tenantTimeZone } from "@/lib/client-timezone";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  analyzeTransactionalTemplate,
  EMAIL_STATUS_META,
  renderTransactionalTemplate,
} from "@/lib/erp/transactional-email-center";
import styles from "./transactional-email-center.module.css";

type Version = {
  id: string;
  version: number;
  status: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  publishedAt: string | null;
  createdAt: string;
  deliveryCount: number;
};
type Definition = {
  id: string;
  eventKey: string;
  label: string;
  category: string;
  description: string;
  variables: string[];
  critical: boolean;
  enabled: boolean;
  versions: Version[];
};
type Delivery = {
  id: string;
  eventId: string;
  eventKey: string;
  recipientMasked: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  version: number | null;
  remoteMessageId: string | null;
  error: string | null;
  retryable: boolean;
  nextAttemptAt: string;
  sentAt: string | null;
  createdAt: string;
};
type SmtpAccount = {
  id: string;
  label: string;
  enabled: boolean;
  revision: number;
  ownerLabel: string | null;
  expiresAt: string | null;
  lastRotatedAt: string | null;
  sandbox: boolean;
  isDefault: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  passwordConfigured: boolean;
  config: {
    host: string;
    port: number;
    encryption: string;
    username: string;
    from_email: string;
    from_name: string;
    timeout_sec: number;
  };
};
type CenterData = {
  generatedAt: string;
  permissions: { canWrite: boolean; canManageSmtp: boolean };
  summary: {
    total: number;
    sent: number;
    pending: number;
    failed: number;
    dead: number;
    deliveryRate: number | null;
    averageAttempts: number;
    published: number;
    catalog: number;
  };
  readiness: {
    state: string;
    blockers: string[];
    activeSmtp: number;
    healthySmtp: number;
    secureSmtp: number;
    unpublished: number;
    criticalUnpublished: number;
  };
  breakdown: {
    statuses: Array<{
      status: string;
      label: string;
      tone: string;
      count: number;
    }>;
    daily: Array<{
      date: string;
      sent: number;
      failed: number;
      pending: number;
      total: number;
    }>;
    events: Array<{
      eventKey: string;
      label: string;
      category: string;
      count: number;
    }>;
    categories: Array<{ category: string; count: number }>;
  };
  operations: { oldestBacklogMinutes: number; retryable: number };
  definitions: Definition[];
  deliveries: Delivery[];
  pagination: { page: number; limit: number; total: number; pages: number };
  smtp: SmtpAccount[];
  catalogSize: number;
};
type Tab = "overview" | "catalog" | "deliveries" | "smtp";

export function TransactionalEmailCenter() {
  const [data, setData] = useState<CenterData>();
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState("30");
  const [status, setStatus] = useState("");
  const [deliveryCategory, setDeliveryCategory] = useState("");
  const [deliveryEvent, setDeliveryEvent] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogCategory, setCatalogCategory] = useState("");
  const [selectedAccount, setSelectedAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days, page: String(page), limit: "25" });
      if (status) params.set("status", status);
      if (deliveryCategory) params.set("category", deliveryCategory);
      if (deliveryEvent) params.set("eventKey", deliveryEvent);
      if (search) params.set("search", search);
      const response = await fetch(`/api/erp/transactional-email?${params}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as CenterData & { error?: string };
      if (!response.ok)
        throw new Error(body.error || "Não foi possível carregar a central.");
      setData(body);
      setSelected((current) =>
        body.definitions.some((item) => item.eventKey === current)
          ? current
          : body.definitions[0]?.eventKey || "",
      );
      setSelectedAccount((current) =>
        current === "new" || body.smtp.some((item) => item.id === current)
          ? current
          : body.smtp[0]?.id || "new",
      );
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Não foi possível carregar a central.",
      );
    } finally {
      setLoading(false);
    }
  }, [days, deliveryCategory, deliveryEvent, page, search, status]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const mutate = useCallback(
    async (payload: Record<string, unknown>, success: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch("/api/erp/transactional-email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await response.json()) as { error?: string; queued?: number };
        if (!response.ok)
          throw new Error(body.error || "Não foi possível concluir a ação.");
        setNotice(
          payload.action === "retry-all"
            ? `${body.queued || 0} entrega(s) reenfileirada(s).`
            : success,
        );
        await load();
        return true;
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Não foi possível concluir a ação.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const integrationRequest = useCallback(
    async (path: string, init: RequestInit, success: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch(`/api/erp/integrations/${path}`, init);
        const body = (await response.json()) as { error?: string };
        if (!response.ok)
          throw new Error(body.error || "Não foi possível concluir a ação SMTP.");
        setNotice(success);
        await load();
        return true;
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Não foi possível concluir a ação SMTP.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const categories = useMemo(
    () => [...new Set(data?.definitions.map((item) => item.category) || [])],
    [data],
  );
  const filteredDefinitions = useMemo(
    () =>
      (data?.definitions || []).filter(
        (item) =>
          (!catalogCategory || item.category === catalogCategory) &&
          (!catalogQuery ||
            `${item.label} ${item.eventKey} ${item.description}`
              .toLocaleLowerCase("pt-BR")
              .includes(catalogQuery.toLocaleLowerCase("pt-BR"))),
      ),
    [catalogCategory, catalogQuery, data],
  );
  const definition = data?.definitions.find((item) => item.eventKey === selected);
  const account = data?.smtp.find((item) => item.id === selectedAccount);

  if (!data && loading)
    return <div className={styles.loading}>Carregando central de e-mails…</div>;
  if (!data)
    return <div className={styles.error}>{error || "Central indisponível."}</div>;

  const exportParams = new URLSearchParams({ days, format: "csv" });
  if (status) exportParams.set("status", status);
  if (deliveryCategory) exportParams.set("category", deliveryCategory);
  if (deliveryEvent) exportParams.set("eventKey", deliveryEvent);
  if (search) exportParams.set("search", search);

  return (
    <div className={styles.root}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>COMUNICAÇÃO · ENTREGABILIDADE</p>
          <h2>Central de e-mails transacionais</h2>
          <p className={styles.heroDescription}>
            Templates versionados, transporte SMTP, fila idempotente e evidências
            operacionais em um único lugar.
          </p>
        </div>
        <div className={styles.heroActions}>
          <button className={styles.button} type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Atualizando…" : "Atualizar"}
          </button>
          <Link className={styles.heroLink} href="/erp/integracoes">
            Monitor de integrações
          </Link>
        </div>
      </header>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}

      <Readiness data={data} onOpenSmtp={() => setTab("smtp")} />
      <Metrics data={data} />

      <nav className={styles.tabs} aria-label="Seções da central">
        {([
          ["overview", "Visão geral"],
          ["catalog", `Catálogo (${data.summary.catalog})`],
          ["deliveries", `Entregas (${data.pagination.total})`],
          ["smtp", `Contas SMTP (${data.smtp.length})`],
        ] as Array<[Tab, string]>).map(([value, label]) => (
          <button
            className={styles.tab}
            type="button"
            role="tab"
            aria-selected={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview data={data} days={days} setDays={setDays} />}
      {tab === "catalog" && (
        <Catalog
          data={data}
          categories={categories}
          filtered={filteredDefinitions}
          selected={selected}
          setSelected={setSelected}
          query={catalogQuery}
          setQuery={setCatalogQuery}
          category={catalogCategory}
          setCategory={setCatalogCategory}
          definition={definition}
          busy={busy}
          mutate={mutate}
        />
      )}
      {tab === "deliveries" && (
        <Deliveries
          data={data}
          categories={categories}
          status={status}
          setStatus={(value) => { setStatus(value); setPage(1); }}
          category={deliveryCategory}
          setCategory={(value) => { setDeliveryCategory(value); setPage(1); }}
          eventKey={deliveryEvent}
          setEventKey={(value) => { setDeliveryEvent(value); setPage(1); }}
          searchDraft={searchDraft}
          setSearchDraft={setSearchDraft}
          applySearch={() => { setSearch(searchDraft.trim()); setPage(1); }}
          clear={() => {
            setStatus("");
            setDeliveryCategory("");
            setDeliveryEvent("");
            setSearchDraft("");
            setSearch("");
            setPage(1);
          }}
          exportHref={`/api/erp/transactional-email?${exportParams}`}
          setPage={setPage}
          busy={busy}
          mutate={mutate}
        />
      )}
      {tab === "smtp" && (
        <Smtp
          data={data}
          selected={selectedAccount}
          setSelected={setSelectedAccount}
          account={account}
          busy={busy}
          request={integrationRequest}
        />
      )}
    </div>
  );
}

function Readiness({ data, onOpenSmtp }: { data: CenterData; onOpenSmtp(): void }) {
  const label =
    data.readiness.state === "ready"
      ? "Operação pronta"
      : data.readiness.state === "blocked"
        ? "Envios bloqueados"
        : "Operação exige atenção";
  return (
    <section className={styles.readiness} data-state={data.readiness.state} aria-live="polite">
      <div>
        <strong>{label}</strong>
        {data.readiness.blockers.length ? (
          <ul>
            {data.readiness.blockers.map((item) => <li key={item}>{item}</li>)}
          </ul>
        ) : (
          <p>SMTP seguro, catálogo publicado e fila sem bloqueios.</p>
        )}
      </div>
      <button className={styles.button} type="button" onClick={onOpenSmtp}>
        Revisar transporte
      </button>
    </section>
  );
}

function Metrics({ data }: { data: CenterData }) {
  const items = [
    ["Entregas no período", number(data.summary.total), "eventos enfileirados"],
    ["Aceitos pelo SMTP", number(data.summary.sent), "não significa leitura"],
    ["Taxa operacional", data.summary.deliveryRate === null ? "—" : `${data.summary.deliveryRate}%`, "aceites sobre finalizados"],
    ["Aguardando", number(data.summary.pending), `${data.operations.oldestBacklogMinutes} min na fila mais antiga`],
    ["Exigem atenção", number(data.summary.failed), `${data.summary.dead} interrompidos`],
    ["Templates publicados", `${data.summary.published}/${data.summary.catalog}`, `${data.readiness.criticalUnpublished} críticos sem publicação`],
  ];
  return (
    <section className={styles.metrics} aria-label="Indicadores de e-mail">
      {items.map(([label, value, hint]) => (
        <article className={styles.metric} key={label}>
          <small>{label}</small>
          <strong>{value}</strong>
          <span>{hint}</span>
        </article>
      ))}
    </section>
  );
}

function Overview({
  data,
  days,
  setDays,
}: {
  data: CenterData;
  days: string;
  setDays(value: string): void;
}) {
  const maximum = Math.max(1, ...data.breakdown.daily.map((item) => item.total));
  const eventMaximum = Math.max(1, ...data.breakdown.events.map((item) => item.count));
  return (
    <div className={styles.overviewGrid}>
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div>
            <h3>Volume e saúde da entrega</h3>
            <p>Mensagens aceitas pelo transporte e falhas registradas por dia.</p>
          </div>
          <label className={styles.field}>
            Período
            <select value={days} onChange={(event) => setDays(event.target.value)}>
              <option value="7">7 dias</option>
              <option value="30">30 dias</option>
              <option value="90">90 dias</option>
            </select>
          </label>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.chart} role="img" aria-label="Entregas e falhas por dia">
            {data.breakdown.daily.map((item, index) => (
              <div
                className={styles.barGroup}
                key={item.date}
                title={`${date(item.date)}: ${item.sent} aceitos, ${item.failed} falhas`}
              >
                <div className={styles.barFailure} style={{ height: `${(item.failed / maximum) * 100}%` }} />
                <div className={styles.bar} style={{ height: `${Math.max(1, (item.sent / maximum) * 100)}%` }} />
                <span>{index % Math.max(1, Math.floor(data.breakdown.daily.length / 6)) === 0 ? item.date.slice(8) : ""}</span>
              </div>
            ))}
          </div>
          <div className={styles.legend}>
            <span><i className={styles.dot} /> Aceitos pelo SMTP</span>
            <span><i className={styles.dotError} /> Falhas</span>
          </div>
        </div>
      </section>
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div>
            <h3>Estados da fila</h3>
            <p>Distribuição operacional do período selecionado.</p>
          </div>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.breakdownList}>
            {data.breakdown.statuses.map((item) => (
              <div className={styles.breakdownItem} key={item.status}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong>{item.label}</strong>
                  <div className={styles.progress}>
                    <span style={{ width: `${data.summary.total ? (item.count / data.summary.total) * 100 : 0}%` }} />
                  </div>
                </div>
                <strong>{number(item.count)}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div>
            <h3>Eventos mais acionados</h3>
            <p>Volume por gatilho transacional, sem exposição de destinatários.</p>
          </div>
        </header>
        <div className={styles.cardBody}>
          {data.breakdown.events.length ? (
            <div className={styles.breakdownList}>
              {data.breakdown.events.map((item) => (
                <div className={styles.breakdownItem} key={item.eventKey}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong>{item.label}</strong>
                    <small>{item.category} · {item.eventKey}</small>
                    <div className={styles.progress}><span style={{ width: `${(item.count / eventMaximum) * 100}%` }} /></div>
                  </div>
                  <strong>{number(item.count)}</strong>
                </div>
              ))}
            </div>
          ) : <Empty title="Sem entregas no período" description="O catálogo está disponível e a atividade aparecerá quando os eventos forem enfileirados." />}
        </div>
      </section>
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div>
            <h3>Checklist de entregabilidade</h3>
            <p>Controles essenciais antes de liberar e-mails reais.</p>
          </div>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.checkList}>
            <Check ok={data.readiness.activeSmtp > 0} label="Conta SMTP ativa e dentro da validade" />
            <Check ok={data.readiness.healthySmtp > 0} label="Teste de conexão aprovado nas últimas 24h" />
            <Check ok={data.readiness.secureSmtp === data.readiness.activeSmtp && data.readiness.activeSmtp > 0} label="Transporte protegido por TLS" />
            <Check ok={data.readiness.criticalUnpublished === 0} label="Eventos críticos possuem versão publicada" />
            <Check ok={data.summary.dead === 0} label="Fila sem entregas interrompidas" />
          </div>
          <p className={styles.heroDescription} style={{ color: "var(--muted)", marginTop: 13 }}>
            SPF, DKIM e DMARC são configurados no DNS e no provedor SMTP. A NALVEN registra o aceite do servidor; abertura e caixa de entrada dependem do provedor contratado.
          </p>
        </div>
      </section>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={styles.checkItem} data-ok={ok}>
      <span className={styles.checkIcon}>{ok ? "✓" : "!"}</span>
      <strong>{label}</strong>
    </div>
  );
}

function Catalog({
  data,
  categories,
  filtered,
  selected,
  setSelected,
  query,
  setQuery,
  category,
  setCategory,
  definition,
  busy,
  mutate,
}: {
  data: CenterData;
  categories: string[];
  filtered: Definition[];
  selected: string;
  setSelected(value: string): void;
  query: string;
  setQuery(value: string): void;
  category: string;
  setCategory(value: string): void;
  definition?: Definition;
  busy: boolean;
  mutate(payload: Record<string, unknown>, success: string): Promise<boolean>;
}) {
  return (
    <div className={styles.catalogGrid}>
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div>
            <h3>Catálogo de eventos</h3>
            <p>{filtered.length} de {data.catalogSize} gatilhos disponíveis.</p>
          </div>
        </header>
        <div className={styles.catalogFilters}>
          <label className={styles.field}>
            Buscar
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="pedido, fiscal, acesso…" />
          </label>
          <label className={styles.field}>
            Categoria
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Todas</option>
              {categories.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </div>
        <div className={styles.eventList}>
          {filtered.map((item) => {
            const published = item.versions.find((version) => version.status === "published");
            return (
              <button
                className={styles.eventButton}
                type="button"
                aria-current={selected === item.eventKey}
                key={item.id}
                onClick={() => setSelected(item.eventKey)}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.eventKey}</small>
                </span>
                <span className={styles.status} data-tone={!item.enabled ? "neutral" : published ? "success" : "warning"}>
                  {!item.enabled ? "inativo" : published ? `v${published.version}` : "sem versão"}
                </span>
              </button>
            );
          })}
          {!filtered.length && <Empty title="Nenhum evento encontrado" description="Revise a busca ou a categoria selecionada." />}
        </div>
      </section>
      {definition ? (
        <TemplateEditor
          key={definition.id}
          definition={definition}
          smtp={data.smtp}
          canWrite={data.permissions.canWrite}
          busy={busy}
          mutate={mutate}
        />
      ) : (
        <section className={styles.card}><Empty title="Selecione um evento" description="Escolha um gatilho para editar e visualizar suas versões." /></section>
      )}
    </div>
  );
}

function TemplateEditor({
  definition,
  smtp,
  canWrite,
  busy,
  mutate,
}: {
  definition: Definition;
  smtp: SmtpAccount[];
  canWrite: boolean;
  busy: boolean;
  mutate(payload: Record<string, unknown>, success: string): Promise<boolean>;
}) {
  const defaultContent = useMemo(
    () => ({
      subject: `${definition.label} · {{organization.name}}`,
      textBody: `Olá {{recipient.name}},\n\n${definition.description}\n\n{{action.url}}`,
      htmlBody: `<p>Olá <strong>{{recipient.name}}</strong>,</p><p>${definition.description}</p><p><a href="{{action.url}}">Ver detalhes</a></p>`,
    }),
    [definition],
  );
  const initial = definition.versions[0];
  const [versionId, setVersionId] = useState(initial?.id || "");
  const [subject, setSubject] = useState(initial?.subject || defaultContent.subject);
  const [htmlBody, setHtmlBody] = useState(initial?.htmlBody || defaultContent.htmlBody);
  const [textBody, setTextBody] = useState(initial?.textBody || defaultContent.textBody);
  const [recipient, setRecipient] = useState("");
  const [credentialId, setCredentialId] = useState(
    smtp.find((item) => item.enabled && item.isDefault)?.id ||
      smtp.find((item) => item.enabled)?.id ||
      "",
  );
  const selectedVersion = definition.versions.find((item) => item.id === versionId);
  const issues = analyzeTransactionalTemplate({
    subject,
    htmlBody,
    textBody,
    allowedVariables: definition.variables,
  });
  const hasError = issues.some((item) => item.level === "error");
  const sample = {
    "organization.name": "Empresa demonstração",
    "recipient.name": "Cliente",
    "action.url": "https://nalven.com.br/erp",
    "event.date": new Date().toLocaleString("pt-BR", { timeZone: tenantTimeZone() }),
  };

  function openVersion(version: Version) {
    setVersionId(version.id);
    setSubject(version.subject);
    setHtmlBody(version.htmlBody);
    setTextBody(version.textBody);
  }
  function resetDraft() {
    setVersionId("");
    setSubject(selectedVersion?.subject || subject || defaultContent.subject);
    setHtmlBody(selectedVersion?.htmlBody || htmlBody || defaultContent.htmlBody);
    setTextBody(selectedVersion?.textBody || textBody || defaultContent.textBody);
  }

  return (
    <section className={styles.card}>
      <div className={styles.editor}>
        <header className={styles.editorHeader}>
          <div>
            <h3>{definition.label}</h3>
            <p>{definition.description}</p>
            <code className={styles.eventCode}>{definition.eventKey}</code>
          </div>
          <span className={styles.status} data-tone={definition.critical ? "danger" : definition.enabled ? "success" : "neutral"}>
            {definition.critical ? "crítico" : definition.enabled ? "ativo" : "inativo"}
          </span>
        </header>

        <div className={styles.toolbar}>
          <button className={styles.button} type="button" onClick={resetDraft}>Criar nova versão</button>
          {canWrite && !definition.critical && (
            <button
              className={styles.button}
              type="button"
              disabled={busy}
              onClick={() => void mutate(
                { action: "toggle", eventKey: definition.eventKey, enabled: !definition.enabled },
                definition.enabled ? "Evento desativado." : "Evento ativado.",
              )}
            >
              {definition.enabled ? "Desativar evento" : "Ativar evento"}
            </button>
          )}
        </div>

        <div className={styles.variables} aria-label="Variáveis permitidas">
          {definition.variables.map((item) => (
            <button
              className={styles.variable}
              type="button"
              title="Copiar variável"
              key={item}
              onClick={() => void navigator.clipboard?.writeText(`{{${item}}}`)}
            >
              {`{{${item}}}`}
            </button>
          ))}
        </div>

        <div className={styles.formGrid}>
          <label className={styles.fullField}>
            Assunto
            <input value={subject} maxLength={240} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <label className={`${styles.fullField} ${styles.codeArea}`}>
            HTML
            <textarea value={htmlBody} onChange={(event) => setHtmlBody(event.target.value)} spellCheck={false} />
          </label>
          <label className={styles.fullField}>
            Texto simples
            <textarea value={textBody} onChange={(event) => setTextBody(event.target.value)} />
          </label>
        </div>

        {!!issues.length && (
          <div className={styles.issues} aria-live="polite">
            {issues.map((issue) => (
              <div className={styles.issue} data-level={issue.level} key={issue.code}>
                {issue.level === "error" ? "Corrigir: " : "Recomendação: "}{issue.message}
              </div>
            ))}
          </div>
        )}

        <div className={styles.buttonRow}>
          <button
            className={styles.primary}
            type="button"
            disabled={busy || hasError || !canWrite}
            onClick={() => void mutate(
              { action: "save", eventKey: definition.eventKey, subject, htmlBody, textBody },
              "Nova versão salva como rascunho.",
            )}
          >
            Salvar como nova versão
          </button>
          {selectedVersion && selectedVersion.status !== "published" && (
            <button
              className={styles.button}
              type="button"
              disabled={busy || hasError || !canWrite}
              onClick={() => void mutate(
                { action: "publish", versionId: selectedVersion.id },
                `Versão ${selectedVersion.version} publicada.`,
              )}
            >
              Publicar v{selectedVersion.version}
            </button>
          )}
          {selectedVersion && selectedVersion.status === "draft" && (
            <button
              className={styles.dangerButton}
              type="button"
              disabled={busy || !canWrite}
              onClick={() => void mutate(
                { action: "archive", versionId: selectedVersion.id },
                `Versão ${selectedVersion.version} arquivada.`,
              )}
            >
              Arquivar rascunho
            </button>
          )}
        </div>

        <div className={styles.preview}>
          <div className={styles.previewSubject}>
            <strong>Assunto:</strong> {renderTransactionalTemplate(subject, sample)}
          </div>
          <iframe
            title={`Prévia de ${definition.label}`}
            sandbox=""
            srcDoc={renderTransactionalTemplate(htmlBody, sample, true)}
          />
        </div>

        <div className={styles.testPanel}>
          <strong>Teste controlado</strong>
          <p className={styles.heroDescription} style={{ color: "var(--muted)", margin: 0 }}>
            Envia exatamente a versão selecionada. O destinatário é cifrado no servidor e aparece apenas mascarado no histórico.
          </p>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              Destinatário
              <input type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="voce@empresa.com.br" />
            </label>
            <label className={styles.field}>
              Conta SMTP
              <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
                <option value="">Padrão ativa</option>
                {smtp.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <div>
            <button
              className={styles.button}
              type="button"
              disabled={busy || hasError || !recipient || !canWrite}
              onClick={() => void mutate(
                { action: "test", eventKey: definition.eventKey, versionId: selectedVersion?.id, credentialId, recipient },
                "Teste aceito pelo servidor SMTP.",
              )}
            >
              Enviar teste desta versão
            </button>
          </div>
        </div>

        <details className={styles.history} open>
          <summary>Histórico de versões ({definition.versions.length})</summary>
          <div className={styles.versionList}>
            {definition.versions.map((version) => (
              <button
                className={styles.versionButton}
                type="button"
                aria-current={version.id === versionId}
                key={version.id}
                onClick={() => openVersion(version)}
              >
                <span>
                  <strong>Versão {version.version}</strong>
                  <small>{dateTime(version.createdAt)} · {number(version.deliveryCount)} entrega(s)</small>
                </span>
                <span className={styles.status} data-tone={version.status === "published" ? "success" : version.status === "draft" ? "warning" : "neutral"}>
                  {version.status === "published" ? "publicada" : version.status === "draft" ? "rascunho" : "arquivada"}
                </span>
              </button>
            ))}
            {!definition.versions.length && <Empty title="Sem versões" description="Use o conteúdo inicial e salve a primeira versão." />}
          </div>
        </details>
      </div>
    </section>
  );
}

function Deliveries({
  data,
  categories,
  status,
  setStatus,
  category,
  setCategory,
  eventKey,
  setEventKey,
  searchDraft,
  setSearchDraft,
  applySearch,
  clear,
  exportHref,
  setPage,
  busy,
  mutate,
}: {
  data: CenterData;
  categories: string[];
  status: string;
  setStatus(value: string): void;
  category: string;
  setCategory(value: string): void;
  eventKey: string;
  setEventKey(value: string): void;
  searchDraft: string;
  setSearchDraft(value: string): void;
  applySearch(): void;
  clear(): void;
  exportHref: string;
  setPage(value: number): void;
  busy: boolean;
  mutate(payload: Record<string, unknown>, success: string): Promise<boolean>;
}) {
  const definitions = category
    ? data.definitions.filter((item) => item.category === category)
    : data.definitions;
  const labels = new Map(data.definitions.map((item) => [item.eventKey, item.label]));
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <div>
          <h3>Fila e histórico de entregas</h3>
          <p>Dados pessoais mascarados, diagnóstico seguro e reprocessamento auditado.</p>
        </div>
        <div className={styles.buttonRow}>
          <a className={styles.button} href={exportHref}>Exportar CSV</a>
          {data.permissions.canWrite && data.operations.retryable > 0 && (
            <button
              className={styles.button}
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Reenfileirar até 100 falhas transitórias?"))
                  void mutate({ action: "retry-all" }, "Falhas reenfileiradas.");
              }}
            >
              Reprocessar falhas
            </button>
          )}
        </div>
      </header>
      <form
        className={styles.filters}
        onSubmit={(event) => { event.preventDefault(); applySearch(); }}
      >
        <label className={styles.field}>
          Buscar referência
          <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="evento, destino mascarado…" />
        </label>
        <label className={styles.field}>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todos</option>
            {Object.entries(EMAIL_STATUS_META).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Categoria
          <select value={category} onChange={(event) => { setCategory(event.target.value); setEventKey(""); }}>
            <option value="">Todas</option>
            {categories.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Evento
          <select value={eventKey} onChange={(event) => setEventKey(event.target.value)}>
            <option value="">Todos</option>
            {definitions.map((item) => <option key={item.id} value={item.eventKey}>{item.label}</option>)}
          </select>
        </label>
        <div className={styles.filterActions}>
          <button className={styles.primary} type="submit">Aplicar busca</button>
          <button className={styles.ghost} type="button" onClick={clear}>Limpar filtros</button>
        </div>
      </form>

      {data.deliveries.length ? (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Evento</th>
                  <th>Destino</th>
                  <th>Status</th>
                  <th>Tentativas</th>
                  <th>Criado</th>
                  <th>Diagnóstico</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((item) => {
                  const meta = EMAIL_STATUS_META[item.status] || { label: item.status, tone: "neutral" as const };
                  return (
                    <tr key={item.id}>
                      <td>
                        <strong>{labels.get(item.eventKey) || item.eventKey}</strong><br />
                        <code>{item.eventId}</code>
                      </td>
                      <td>{item.recipientMasked}</td>
                      <td><span className={styles.status} data-tone={meta.tone}>{meta.label}</span></td>
                      <td>{item.attempts}/{item.maxAttempts}<br /><small>template v{item.version || "—"}</small></td>
                      <td>{dateTime(item.createdAt)}</td>
                      <td className={styles.truncate}>{item.error || (item.sentAt ? `Aceito em ${dateTime(item.sentAt)}` : `Próxima ação ${dateTime(item.nextAttemptAt)}`)}</td>
                      <td>
                        {item.retryable && data.permissions.canWrite ? (
                          <button className={styles.button} type="button" disabled={busy} onClick={() => void mutate({ action: "retry", deliveryId: item.id }, "Entrega reenfileirada.")}>Reenfileirar</button>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={styles.mobileCards}>
            {data.deliveries.map((item) => {
              const meta = EMAIL_STATUS_META[item.status] || { label: item.status, tone: "neutral" as const };
              return (
                <article className={styles.mobileCard} key={item.id}>
                  <div className={styles.mobileCardHeader}>
                    <div><strong>{labels.get(item.eventKey) || item.eventKey}</strong><br /><code className={styles.eventCode}>{item.eventId}</code></div>
                    <span className={styles.status} data-tone={meta.tone}>{meta.label}</span>
                  </div>
                  <div className={styles.mobileCardRow}><span>Destino</span><strong>{item.recipientMasked}</strong></div>
                  <div className={styles.mobileCardRow}><span>Tentativas</span><strong>{item.attempts}/{item.maxAttempts}</strong></div>
                  <div className={styles.mobileCardRow}><span>Data</span><strong>{dateTime(item.createdAt)}</strong></div>
                  {item.error && <div className={styles.error}>{item.error}</div>}
                  {item.retryable && data.permissions.canWrite && (
                    <button className={styles.button} type="button" disabled={busy} onClick={() => void mutate({ action: "retry", deliveryId: item.id }, "Entrega reenfileirada.")}>Reenfileirar</button>
                  )}
                </article>
              );
            })}
          </div>
        </>
      ) : <Empty title="Nenhuma entrega encontrada" description="Não há registros para os filtros e o período selecionados." />}
      <footer className={styles.tableFooter}>
        <span>{number(data.pagination.total)} registro(s) · página {data.pagination.page} de {data.pagination.pages}</span>
        <div className={styles.pagination}>
          <button className={styles.button} type="button" disabled={data.pagination.page <= 1} onClick={() => setPage(data.pagination.page - 1)}>Anterior</button>
          <button className={styles.button} type="button" disabled={data.pagination.page >= data.pagination.pages} onClick={() => setPage(data.pagination.page + 1)}>Próxima</button>
        </div>
      </footer>
    </section>
  );
}

function Smtp({
  data,
  selected,
  setSelected,
  account,
  busy,
  request,
}: {
  data: CenterData;
  selected: string;
  setSelected(value: string): void;
  account?: SmtpAccount;
  busy: boolean;
  request(path: string, init: RequestInit, success: string): Promise<boolean>;
}) {
  return (
    <div className={styles.smtpGrid}>
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div>
            <h3>Contas SMTP</h3>
            <p>Failover usa a conta padrão e depois as contas válidas disponíveis.</p>
          </div>
          {data.permissions.canManageSmtp && (
            <button className={styles.button} type="button" onClick={() => setSelected("new")}>Nova conta</button>
          )}
        </header>
        <div className={styles.accountList} style={{ paddingTop: 14 }}>
          {data.smtp.map((item) => (
            <button
              className={styles.accountButton}
              type="button"
              aria-current={selected === item.id}
              key={item.id}
              onClick={() => setSelected(item.id)}
            >
              <span>
                <strong>{item.label || "Conta SMTP"}</strong>
                <small>{item.config.from_email || "Remetente não informado"}{item.isDefault ? " · padrão" : ""}</small>
              </span>
              <span className={styles.status} data-tone={!item.enabled ? "neutral" : item.lastTestOk ? "success" : "warning"}>
                {!item.enabled ? "inativa" : item.lastTestOk ? "validada" : "testar"}
              </span>
            </button>
          ))}
          {!data.smtp.length && <Empty title="Nenhuma conta" description="Cadastre o transporte antes de liberar envios reais." />}
        </div>
      </section>
      <section className={styles.card}>
        {data.permissions.canManageSmtp ? (
          <SmtpEditor key={account?.id || "new"} account={account} busy={busy} request={request} />
        ) : (
          <div className={styles.cardBody}>
            <Empty title="Configuração protegida" description="Você pode acompanhar a saúde do SMTP, mas apenas administradores de integrações podem alterar credenciais." />
          </div>
        )}
      </section>
    </div>
  );
}

function SmtpEditor({
  account,
  busy,
  request,
}: {
  account?: SmtpAccount;
  busy: boolean;
  request(path: string, init: RequestInit, success: string): Promise<boolean>;
}) {
  return (
    <div className={styles.editor}>
      <header className={styles.editorHeader}>
        <div>
          <h3>{account ? account.label : "Nova conta SMTP"}</h3>
          <p>Senha nunca é devolvida pelo servidor. Deixe o campo vazio para manter a credencial atual.</p>
        </div>
        {account && (
          <span className={styles.status} data-tone={account.enabled ? "success" : "neutral"}>
            {account.enabled ? "ativa" : "inativa"}
          </span>
        )}
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const expires = String(form.get("expires_at") || "");
          void request(
            "credentials/smtp",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: account?.id,
                revision: account?.revision || 0,
                label: form.get("label"),
                enabled: form.get("enabled") === "on",
                isDefault: form.get("is_default") === "on",
                sandbox: form.get("sandbox") === "on",
                owner_label: form.get("owner_label"),
                expires_at: expires ? new Date(`${expires}T23:59:59.999`).toISOString() : null,
                fields: {
                  host: form.get("host"),
                  port: Number(form.get("port") || 587),
                  encryption: form.get("encryption"),
                  username: form.get("username"),
                  password: form.get("password"),
                  from_email: form.get("from_email"),
                  from_name: form.get("from_name"),
                  timeout_sec: Number(form.get("timeout_sec") || 15),
                },
              }),
            },
            account ? "Conta SMTP atualizada." : "Conta SMTP criada.",
          );
        }}
      >
        <div className={styles.formGrid}>
          <label className={styles.field}>Nome da conta<input name="label" required maxLength={120} defaultValue={account?.label || "SMTP transacional"} /></label>
          <label className={styles.field}>Responsável<input name="owner_label" maxLength={120} defaultValue={account?.ownerLabel || ""} placeholder="TI / fornecedor" /></label>
          <label className={styles.field}>Servidor<input name="host" required defaultValue={account?.config.host || ""} autoComplete="off" /></label>
          <label className={styles.field}>Porta<input name="port" type="number" min="1" max="65535" required defaultValue={account?.config.port || 587} /></label>
          <label className={styles.field}>
            Criptografia
            <select name="encryption" defaultValue={account?.config.encryption || "tls"}>
              <option value="tls">STARTTLS</option>
              <option value="ssl">SSL/TLS</option>
              <option value="none">Sem TLS — não recomendado</option>
            </select>
          </label>
          <label className={styles.field}>Timeout (segundos)<input name="timeout_sec" type="number" min="3" max="60" defaultValue={account?.config.timeout_sec || 15} /></label>
          <label className={styles.field}>Usuário<input name="username" defaultValue={account?.config.username || ""} autoComplete="username" /></label>
          <label className={styles.field}>
            Senha
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required={!account?.passwordConfigured && Boolean(account?.config.username)}
              placeholder={account?.passwordConfigured ? "Manter senha protegida" : ""}
            />
          </label>
          <label className={styles.field}>E-mail remetente<input name="from_email" type="email" required defaultValue={account?.config.from_email || ""} /></label>
          <label className={styles.field}>Nome remetente<input name="from_name" required defaultValue={account?.config.from_name || "NALVEN"} /></label>
          <label className={styles.field}>Validade<input name="expires_at" type="date" defaultValue={account?.expiresAt?.slice(0, 10) || ""} /></label>
        </div>
        <label className={styles.toggle}>
          <input name="enabled" type="checkbox" defaultChecked={account?.enabled || false} />
          <span><strong>Conta ativa</strong><br /><small>Somente contas ativas, válidas e não revogadas entram no roteamento.</small></span>
        </label>
        <label className={styles.toggle}>
          <input name="is_default" type="checkbox" defaultChecked={account?.isDefault ?? true} />
          <span><strong>Conta padrão</strong><br /><small>Primeira opção para novos eventos transacionais.</small></span>
        </label>
        <label className={styles.toggle}>
          <input name="sandbox" type="checkbox" defaultChecked={account?.sandbox || false} />
          <span><strong>Ambiente de homologação</strong><br /><small>Identifica a conta como não produtiva para a equipe.</small></span>
        </label>
        <div className={styles.buttonRow}>
          <button className={styles.primary} disabled={busy}>Salvar conta</button>
          {account && (
            <button
              className={styles.button}
              type="button"
              disabled={busy || !account.enabled}
              onClick={() => void request(
                "health/smtp",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ credential_id: account.id }),
                },
                "Teste SMTP concluído.",
              )}
            >
              Testar conexão
            </button>
          )}
          {account && (
            <button
              className={styles.dangerButton}
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Revogar esta conta? A operação não expõe nem recupera a senha."))
                  void request(`credentials/${account.id}`, { method: "DELETE" }, "Conta SMTP revogada.");
              }}
            >
              Revogar conta
            </button>
          )}
        </div>
      </form>
      {account && (
        <div className={styles.testPanel}>
          <strong>Saúde e rotação</strong>
          <div className={styles.checkList}>
            <Check ok={account.passwordConfigured || !account.config.username} label={account.passwordConfigured ? "Senha armazenada de forma protegida" : "Autenticação sem senha configurada"} />
            <Check ok={["tls", "ssl"].includes(account.config.encryption)} label="Transporte protegido por TLS" />
            <Check ok={account.lastTestOk === true} label={account.lastTestAt ? `Último teste: ${dateTime(account.lastTestAt)}` : "Conexão ainda não testada"} />
          </div>
          {account.lastTestMessage && <p>{account.lastTestMessage}</p>}
          <small>Última rotação: {account.lastRotatedAt ? dateTime(account.lastRotatedAt) : "não registrada"}</small>
        </div>
      )}
    </div>
  );
}

function Empty({ title, description }: { title: string; description: string }) {
  return <div className={styles.empty}><strong>{title}</strong><p>{description}</p></div>;
}
function number(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}
function date(value: string) {
  return tenantDateTimeFormatter({ day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00Z`));
}
function dateTime(value: string) {
  return tenantDateTimeFormatter({ day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
