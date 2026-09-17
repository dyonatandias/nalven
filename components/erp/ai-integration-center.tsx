"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErpModal } from "./modal-portal";
import styles from "./ai-integration-center.module.css";

type Policy = {
  enabled: boolean;
  routing_mode: "platform" | "byok" | "hybrid";
  default_model: string;
  allowed_models: string[];
  redact_pii: boolean;
  log_prompts: false;
  max_tokens: number;
  reasoning_effort: "low" | "medium" | "high";
  monthly_budget: number;
  monthly_request_limit: number;
  alert_threshold_pct: number;
  per_feature_limits: Record<string, number>;
  consumers: Record<string, boolean>;
};
type Credential = {
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
  apiKeyConfigured: boolean;
  config: { project_id: string; organization_id: string };
  createdAt: string;
};
type Feature = {
  id: string;
  label: string;
  area: string;
  description: string;
  enabled: boolean;
  limit: number;
  requests: number;
  units: number;
  cost: number;
};
type UsageRow = {
  id: string;
  feature: string;
  featureLabel: string;
  model: string;
  status: string;
  keySource: string;
  units: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
  createdAt: string;
};
type AiCenterData = {
  generatedAt: string;
  permissions: { canWrite: boolean };
  policy: Policy;
  revision: number;
  readiness: {
    state: "ready" | "attention" | "blocked";
    blockers: string[];
    warnings: string[];
    platformAvailable: boolean;
    activeByok: number;
    healthyByok: number;
  };
  summary: {
    requests: number;
    completed: number;
    failed: number;
    incomplete: number;
    inProgress: number;
    successRate: number | null;
    units: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    averageLatencyMs: number;
    p95LatencyMs: number;
  };
  budget: {
    requests: number;
    requestLimit: number;
    cost: number;
    limit: number;
    remaining: number | null;
    usedPct: number | null;
    projectedCost: number;
    inputTokens: number;
    outputTokens: number;
  };
  breakdown: {
    daily: Array<{
      date: string;
      requests: number;
      completed: number;
      failed: number;
      tokens: number;
      cost: number;
    }>;
    statuses: Array<{ status: string; count: number }>;
    features: Array<{
      feature: string;
      label: string;
      requests: number;
      units: number;
      cost: number;
    }>;
    models: Array<{
      model: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }>;
    keySources: Array<{ keySource: string; count: number }>;
  };
  features: Feature[];
  credentials: Credential[];
  recent: UsageRow[];
  pagination: { page: number; limit: number; total: number; pages: number };
  filterOptions: { features: string[]; models: string[] };
};
type Tab = "overview" | "policy" | "features" | "credentials" | "usage" | "playground";

const TAB_LABELS: Record<Tab, string> = {
  overview: "Visão geral",
  policy: "Política e limites",
  features: "Recursos",
  credentials: "Chaves OpenAI",
  usage: "Uso e auditoria",
  playground: "Laboratório",
};

export function AiIntegrationCenter() {
  const [data, setData] = useState<AiCenterData>();
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState("30");
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [feature, setFeature] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [keySource, setKeySource] = useState("");
  const [selectedCredential, setSelectedCredential] = useState("new");
  const [revokeTarget, setRevokeTarget] = useState<Credential>();
  const [playgroundResult, setPlaygroundResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days, page: String(page), limit: "25" });
      if (search) params.set("search", search);
      if (feature) params.set("feature", feature);
      if (model) params.set("model", model);
      if (status) params.set("status", status);
      if (keySource) params.set("keySource", keySource);
      const response = await fetch(`/api/erp/ai/usage?${params}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as AiCenterData & { error?: string };
      if (!response.ok)
        throw new Error(body.error || "Não foi possível carregar a central de IA.");
      setData(body);
      setSelectedCredential((current) =>
        current === "new" || body.credentials.some((item) => item.id === current)
          ? current
          : body.credentials[0]?.id || "new",
      );
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível carregar a central de IA.",
      );
    } finally {
      setLoading(false);
    }
  }, [days, feature, keySource, model, page, search, status]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function mutate(
    url: string,
    payload: Record<string, unknown>,
    success: string,
    method = "POST",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        error?: string;
        message?: string;
        success?: boolean;
      };
      if (!response.ok || body.success === false)
        throw new Error(body.error || body.message || "A operação não foi concluída.");
      setNotice(success);
      await load();
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A operação não foi concluída.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(nextPolicy: Policy, success: string) {
    if (!data) return;
    await mutate(
      "/api/erp/integrations/settings/ai",
      { revision: data.revision, settings: nextPolicy },
      success,
    );
  }

  const csvParams = useMemo(() => {
    const params = new URLSearchParams({ days, format: "csv" });
    if (search) params.set("search", search);
    if (feature) params.set("feature", feature);
    if (model) params.set("model", model);
    if (status) params.set("status", status);
    if (keySource) params.set("keySource", keySource);
    return params.toString();
  }, [days, feature, keySource, model, search, status]);

  if (loading && !data)
    return <div className={styles.loading}>Carregando governança e telemetria de IA…</div>;

  return (
    <div className={styles.root}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>PLATAFORMA · INTELIGÊNCIA ARTIFICIAL</p>
          <h2>Controle, custo e confiança para a IA do ERP</h2>
          <p className={styles.heroDescription}>
            OpenAI Responses API com chave gerenciada ou BYOK, limites por recurso,
            privacidade, testes e observabilidade sem expor credenciais no navegador.
          </p>
        </div>
        <div className={styles.heroActions}>
          <button type="button" onClick={() => void load()} disabled={loading || busy}>
            {loading ? "Atualizando…" : "Atualizar dados"}
          </button>
          <Link href="/erp/integracoes">Central de integrações</Link>
        </div>
      </header>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
      {data && !data.permissions.canWrite && (
        <div className={styles.info}>Seu perfil possui acesso somente para consulta.</div>
      )}

      <nav className={styles.tabs} aria-label="Áreas da central de IA">
        {(Object.keys(TAB_LABELS) as Tab[]).map((item) => (
          <button
            type="button"
            key={item}
            className={tab === item ? styles.activeTab : ""}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => setTab(item)}
          >
            {TAB_LABELS[item]}
          </button>
        ))}
      </nav>
      <label className={styles.mobileTabs}>
        Área da central
        <select value={tab} onChange={(event) => setTab(event.target.value as Tab)}>
          {(Object.keys(TAB_LABELS) as Tab[]).map((item) => (
            <option key={item} value={item}>{TAB_LABELS[item]}</option>
          ))}
        </select>
      </label>

      {data && tab === "overview" && <Overview data={data} days={days} setDays={setDays} />}
      {data && tab === "policy" && (
        <PolicyEditor data={data} busy={busy} savePolicy={savePolicy} />
      )}
      {data && tab === "features" && (
        <FeatureControls data={data} busy={busy} savePolicy={savePolicy} />
      )}
      {data && tab === "credentials" && (
        <Credentials
          data={data}
          selected={selectedCredential}
          setSelected={setSelectedCredential}
          busy={busy}
          mutate={mutate}
          requestRevoke={setRevokeTarget}
        />
      )}
      {data && tab === "usage" && (
        <UsageTable
          data={data}
          days={days}
          setDays={(value) => { setDays(value); setPage(1); }}
          searchDraft={searchDraft}
          setSearchDraft={setSearchDraft}
          applySearch={() => { setSearch(searchDraft.trim()); setPage(1); }}
          feature={feature}
          setFeature={(value) => { setFeature(value); setPage(1); }}
          model={model}
          setModel={(value) => { setModel(value); setPage(1); }}
          status={status}
          setStatus={(value) => { setStatus(value); setPage(1); }}
          keySource={keySource}
          setKeySource={(value) => { setKeySource(value); setPage(1); }}
          clearFilters={() => {
            setSearchDraft(""); setSearch(""); setFeature(""); setModel("");
            setStatus(""); setKeySource(""); setPage(1);
          }}
          page={page}
          setPage={setPage}
          csvParams={csvParams}
        />
      )}
      {data && tab === "playground" && (
        <Playground
          data={data}
          busy={busy}
          result={playgroundResult}
          setResult={setPlaygroundResult}
          setBusy={setBusy}
          setError={setError}
          setNotice={setNotice}
          reload={load}
        />
      )}

      {revokeTarget && (
        <ErpModal
          close={() => setRevokeTarget(undefined)}
          className={styles.modalLayer}
          label="Revogar credencial OpenAI"
        >
          <section className={styles.modal}>
            <header>
              <div>
                <p className={styles.eyebrow}>AÇÃO IRREVERSÍVEL</p>
                <h2>Revogar “{revokeTarget.label}”?</h2>
              </div>
              <button type="button" onClick={() => setRevokeTarget(undefined)}>Fechar</button>
            </header>
            <p>
              A chave será desativada e removida do roteamento. O histórico de auditoria
              será preservado e o segredo não poderá ser recuperado.
            </p>
            <footer>
              <button type="button" onClick={() => setRevokeTarget(undefined)}>Cancelar</button>
              <button
                type="button"
                className={styles.danger}
                disabled={busy}
                onClick={async () => {
                  const result = await mutate(
                    "/api/erp/ai/usage",
                    {
                      action: "credential.revoke",
                      credentialId: revokeTarget.id,
                      revision: revokeTarget.revision,
                    },
                    "Credencial revogada com segurança.",
                  );
                  if (result) {
                    setRevokeTarget(undefined);
                    setSelectedCredential("new");
                  }
                }}
              >
                Revogar credencial
              </button>
            </footer>
          </section>
        </ErpModal>
      )}
    </div>
  );
}

function Overview({
  data,
  days,
  setDays,
}: {
  data: AiCenterData;
  days: string;
  setDays: (value: string) => void;
}) {
  const maxRequests = Math.max(1, ...data.breakdown.daily.map((item) => item.requests));
  const readinessItems = [...data.readiness.blockers, ...data.readiness.warnings];
  return (
    <div className={styles.stack}>
      <section className={styles.readiness} data-state={data.readiness.state}>
        <div>
          <p className={styles.eyebrow}>PRONTIDÃO DE PRODUÇÃO</p>
          <h3>
            {data.readiness.state === "ready"
              ? "IA pronta para operação"
              : data.readiness.state === "attention"
                ? "IA operante com pontos de atenção"
                : "IA bloqueada pela política ou credenciais"}
          </h3>
          {readinessItems.length ? (
            <ul>{readinessItems.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : (
            <p>Política, credenciais e limites estão consistentes.</p>
          )}
        </div>
        <span className={styles.readinessScore}>
          {data.readiness.state === "ready" ? "100%" : data.readiness.state === "attention" ? "75%" : "Ação"}
        </span>
      </section>

      <div className={styles.sectionHeading}>
        <div><h3>Desempenho consolidado</h3><p>Indicadores das execuções no período selecionado.</p></div>
        <label>Período
          <select value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="7">7 dias</option><option value="30">30 dias</option><option value="90">90 dias</option>
          </select>
        </label>
      </div>
      <section className={styles.metrics}>
        <Metric label="Requisições" value={number(data.summary.requests)} detail={`${number(data.summary.units)} unidade(s)`} />
        <Metric label="Taxa de sucesso" value={data.summary.successRate == null ? "—" : percent(data.summary.successRate)} detail={`${number(data.summary.failed)} falha(s)`} tone={data.summary.failed ? "warning" : "success"} />
        <Metric label="Tokens processados" value={compact(data.summary.inputTokens + data.summary.outputTokens)} detail={`${compact(data.summary.inputTokens)} entrada · ${compact(data.summary.outputTokens)} saída`} />
        <Metric label="Latência média" value={`${number(data.summary.averageLatencyMs)} ms`} detail={`P95 ${number(data.summary.p95LatencyMs)} ms`} />
        <Metric label="Custo contabilizado" value={money(data.summary.cost)} detail={`Projeção mensal ${money(data.budget.projectedCost)}`} />
        <Metric label="Chaves saudáveis" value={`${data.readiness.healthyByok}/${data.readiness.activeByok}`} detail={data.readiness.platformAvailable ? "Conta gerenciada disponível" : "Conta gerenciada indisponível"} tone={data.readiness.activeByok && !data.readiness.healthyByok ? "warning" : "success"} />
      </section>

      <div className={styles.dashboardGrid}>
        <section className={styles.card}>
          <header><div><h3>Volume diário</h3><p>Concluídas e falhas ao longo do período.</p></div></header>
          <div className={styles.chart} aria-label="Gráfico diário de execuções de IA">
            {data.breakdown.daily.map((item) => (
              <div key={item.date} className={styles.barColumn} title={`${date(item.date)}: ${item.requests} requisições`}>
                <div className={styles.barTrack}>
                  <span className={styles.barFailed} style={{ height: `${(item.failed / maxRequests) * 100}%` }} />
                  <span className={styles.barOk} style={{ height: `${(item.completed / maxRequests) * 100}%` }} />
                </div>
                <small>{new Date(`${item.date}T12:00:00Z`).getUTCDate()}</small>
              </div>
            ))}
          </div>
          <div className={styles.legend}><span><i data-tone="success" />Concluídas</span><span><i data-tone="danger" />Falhas</span></div>
        </section>
        <section className={styles.card}>
          <header><div><h3>Orçamento do mês</h3><p>Consumo contabilizado e projeção pelo ritmo atual.</p></div></header>
          <div className={styles.budgetValue}><strong>{money(data.budget.cost)}</strong><span>{data.budget.limit > 0 ? `de ${money(data.budget.limit)}` : "sem teto monetário"}</span></div>
          <progress max="100" value={data.budget.usedPct || 0} />
          <div className={styles.splitStats}>
            <span><small>Projeção</small><strong>{money(data.budget.projectedCost)}</strong></span>
            <span><small>Requisições</small><strong>{number(data.budget.requests)}{data.budget.requestLimit ? ` / ${number(data.budget.requestLimit)}` : ""}</strong></span>
            <span><small>Saldo</small><strong>{data.budget.remaining == null ? "Ilimitado" : money(data.budget.remaining)}</strong></span>
          </div>
          <p className={styles.caption}>O custo é o valor informado por cada consumidor da API; confirme a cobrança oficial no projeto OpenAI.</p>
        </section>
      </div>

      <div className={styles.dashboardGrid}>
        <Ranking title="Recursos mais usados" rows={data.breakdown.features.map((item) => ({ label: item.label, value: item.requests, detail: money(item.cost) }))} />
        <Ranking title="Modelos em uso" rows={data.breakdown.models.map((item) => ({ label: item.model, value: item.requests, detail: `${compact(item.inputTokens + item.outputTokens)} tokens` }))} />
      </div>

      <section className={styles.checklist}>
        <h3>Checklist de governança</h3>
        <div>
          <Check ok={data.policy.redact_pii} title="Dados pessoais" detail={data.policy.redact_pii ? "Redação automática habilitada" : "Redação automática desativada"} />
          <Check ok={data.policy.log_prompts === false} title="Conteúdo de prompts" detail="Conteúdo não persistido na telemetria" />
          <Check ok={data.policy.allowed_models.includes(data.policy.default_model)} title="Modelos" detail={`${data.policy.allowed_models.length} modelo(s) permitido(s)`} />
          <Check ok={data.policy.monthly_budget > 0 || data.policy.monthly_request_limit > 0} title="Limites" detail={data.policy.monthly_budget > 0 || data.policy.monthly_request_limit > 0 ? "Ao menos um teto mensal configurado" : "Sem teto mensal configurado"} />
        </div>
      </section>
    </div>
  );
}

function PolicyEditor({ data, busy, savePolicy }: { data: AiCenterData; busy: boolean; savePolicy: (policy: Policy, success: string) => Promise<void> }) {
  return (
    <div className={styles.stack}>
      <div className={styles.sectionHeading}><div><h3>Política de execução</h3><p>Defina roteamento, modelos, privacidade e limites globais.</p></div><span>Revisão {data.revision}</span></div>
      <form
        key={`policy-${data.revision}`}
        className={styles.card}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const allowed = String(form.get("allowed_models") || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
          void savePolicy({
            ...data.policy,
            enabled: form.get("enabled") === "on",
            routing_mode: String(form.get("routing_mode")) as Policy["routing_mode"],
            default_model: String(form.get("default_model") || "").trim(),
            allowed_models: allowed,
            redact_pii: form.get("redact_pii") === "on",
            log_prompts: false,
            max_tokens: Number(form.get("max_tokens") || 0),
            reasoning_effort: String(form.get("reasoning_effort")) as Policy["reasoning_effort"],
            monthly_budget: Number(form.get("monthly_budget") || 0),
            monthly_request_limit: Number(form.get("monthly_request_limit") || 0),
            alert_threshold_pct: Number(form.get("alert_threshold_pct") || 80),
          }, "Política de IA atualizada.");
        }}
      >
        <div className={styles.formGrid}>
          <label>Modo de roteamento<select name="routing_mode" defaultValue={data.policy.routing_mode}><option value="platform">Gerenciado pela plataforma</option><option value="byok">Somente chave própria (BYOK)</option><option value="hybrid">BYOK com fallback gerenciado</option></select><small>O híbrido prioriza a chave do tenant.</small></label>
          <label>Modelo padrão<input name="default_model" required defaultValue={data.policy.default_model} /><small>Precisa constar na lista permitida.</small></label>
          <label className={styles.fullField}>Modelos permitidos<textarea name="allowed_models" required rows={3} defaultValue={data.policy.allowed_models.join("\n")} /><small>Um identificador por linha. A disponibilidade depende do projeto OpenAI.</small></label>
          <label>Máximo de tokens de saída<input name="max_tokens" type="number" min="1" max="100000" required defaultValue={data.policy.max_tokens} /></label>
          <label>Esforço de raciocínio<select name="reasoning_effort" defaultValue={data.policy.reasoning_effort}><option value="low">Baixo</option><option value="medium">Médio</option><option value="high">Alto</option></select></label>
          <label>Orçamento mensal contabilizado<input name="monthly_budget" type="number" min="0" max="1000000000" step="0.01" defaultValue={data.policy.monthly_budget} /><small>Use zero para não aplicar teto monetário.</small></label>
          <label>Limite mensal de requisições<input name="monthly_request_limit" type="number" min="0" max="10000000" step="1" defaultValue={data.policy.monthly_request_limit} /><small>Zero significa sem limite global.</small></label>
          <label>Alerta de orçamento (%)<input name="alert_threshold_pct" type="number" min="1" max="100" defaultValue={data.policy.alert_threshold_pct} /></label>
        </div>
        <div className={styles.toggleGrid}>
          <label className={styles.toggle}><input name="enabled" type="checkbox" defaultChecked={data.policy.enabled} /><span><strong>IA habilitada</strong><small>Libera apenas os recursos e modelos permitidos.</small></span></label>
          <label className={styles.toggle}><input name="redact_pii" type="checkbox" defaultChecked={data.policy.redact_pii} /><span><strong>Redigir dados pessoais</strong><small>Substitui e-mail, telefone e CPF antes do envio.</small></span></label>
          <div className={styles.lockedSetting}><strong>Conteúdo de prompts não é registrado</strong><small>A telemetria mantém apenas modelo, tokens, custo, latência e status.</small></div>
        </div>
        <footer><button className={styles.primary} disabled={busy || !data.permissions.canWrite}>Salvar política</button></footer>
      </form>
      <section className={styles.card}>
        <header><div><h3>Como a execução é protegida</h3><p>Controles aplicados no servidor antes de qualquer chamada externa.</p></div></header>
        <ol className={styles.flow}><li>Permissão e disponibilidade do recurso</li><li>Modelo permitido e limites do tenant</li><li>Redação de dados pessoais</li><li>Reserva atômica de orçamento</li><li>Responses API sem retenção</li><li>Telemetria sem conteúdo do prompt</li></ol>
      </section>
    </div>
  );
}

function FeatureControls({ data, busy, savePolicy }: { data: AiCenterData; busy: boolean; savePolicy: (policy: Policy, success: string) => Promise<void> }) {
  return (
    <div className={styles.stack}>
      <div className={styles.sectionHeading}><div><h3>Recursos consumidores</h3><p>Habilite casos de uso e aplique cotas mensais independentes.</p></div><span>{data.features.filter((item) => item.enabled).length} de {data.features.length} habilitados</span></div>
      <form
        key={`features-${data.revision}`}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const consumers = Object.fromEntries(data.features.map((item) => [item.id, form.get(`enabled:${item.id}`) === "on"]));
          const perFeatureLimits = Object.fromEntries(data.features.map((item) => [item.id, Number(form.get(`limit:${item.id}`) || 0)]));
          void savePolicy({ ...data.policy, consumers, per_feature_limits: perFeatureLimits }, "Recursos e cotas atualizados.");
        }}
      >
        <div className={styles.featureGrid}>
          {data.features.map((item) => (
            <article key={item.id} className={styles.featureCard}>
              <header><span>{item.area}</span><label className={styles.switch}><input type="checkbox" name={`enabled:${item.id}`} defaultChecked={item.enabled} aria-label={`Habilitar ${item.label}`} /><i /></label></header>
              <h3>{item.label}</h3><p>{item.description}</p><code>{item.id}</code>
              <div className={styles.featureStats}><span><small>Uso no mês</small><strong>{number(item.requests)}</strong></span><label>Cota mensal<input name={`limit:${item.id}`} type="number" min="0" max="1000000" step="1" defaultValue={item.limit} /></label></div>
            </article>
          ))}
        </div>
        <div className={styles.stickySave}><span>Zero mantém o recurso sem cota individual.</span><button className={styles.primary} disabled={busy || !data.permissions.canWrite}>Salvar recursos</button></div>
      </form>
    </div>
  );
}

function Credentials({ data, selected, setSelected, busy, mutate, requestRevoke }: { data: AiCenterData; selected: string; setSelected: (value: string) => void; busy: boolean; mutate: (url: string, payload: Record<string, unknown>, success: string, method?: string) => Promise<unknown>; requestRevoke: (value: Credential) => void }) {
  const account = data.credentials.find((item) => item.id === selected);
  return (
    <div className={styles.credentialLayout}>
      <aside className={styles.accountList}>
        <header><div><h3>Chaves do tenant</h3><p>{data.credentials.length} cadastrada(s)</p></div><button type="button" onClick={() => setSelected("new")}>Nova chave</button></header>
        {data.credentials.map((item) => (
          <button type="button" key={item.id} className={selected === item.id ? styles.selectedAccount : ""} onClick={() => setSelected(item.id)}>
            <span><strong>{item.label}</strong><small>{item.ownerLabel || "Sem responsável"}</small></span>
            <i data-state={item.enabled ? item.lastTestOk === true ? "ok" : "attention" : "off"}>{item.enabled ? item.lastTestOk === true ? "Ativa" : "Revisar" : "Inativa"}</i>
          </button>
        ))}
        {!data.credentials.length && <p className={styles.empty}>Nenhuma chave própria cadastrada.</p>}
      </aside>
      <section className={styles.card}>
        <header><div><h3>{account ? "Editar chave OpenAI" : "Nova chave OpenAI"}</h3><p>O segredo é criptografado e nunca volta pela API.</p></div>{account?.isDefault && <span className={styles.badge}>Padrão</span>}</header>
        <form
          key={account ? `${account.id}-${account.revision}` : "new"}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void mutate("/api/erp/integrations/credentials/openai", {
              id: account?.id,
              revision: account?.revision,
              label: form.get("label"),
              enabled: form.get("enabled") === "on",
              isDefault: form.get("is_default") === "on",
              sandbox: form.get("sandbox") === "on",
              owner_label: form.get("owner_label"),
              expires_at: form.get("expires_at"),
              fields: { project_id: form.get("project_id"), organization_id: form.get("organization_id"), api_key: form.get("api_key") },
            }, account ? "Credencial OpenAI atualizada." : "Credencial OpenAI cadastrada.");
          }}
        >
          <div className={styles.formGrid}>
            <label>Nome da credencial<input name="label" required maxLength={120} defaultValue={account?.label || "OpenAI do tenant"} /></label>
            <label>Responsável<input name="owner_label" maxLength={120} defaultValue={account?.ownerLabel || ""} placeholder="Equipe ou pessoa responsável" /></label>
            <label>Project ID<input name="project_id" maxLength={200} defaultValue={account?.config.project_id || ""} placeholder="proj_…" /></label>
            <label>Organization ID<input name="organization_id" maxLength={200} defaultValue={account?.config.organization_id || ""} placeholder="org_… (opcional)" /></label>
            <label>API key<input name="api_key" type="password" autoComplete="new-password" required={!account?.apiKeyConfigured} placeholder={account?.apiKeyConfigured ? "Manter chave criptografada atual" : "Cole a chave da API"} /><small>{account?.apiKeyConfigured ? "Preencha somente para rotacionar." : "Obrigatória para ativar BYOK."}</small></label>
            <label>Validade<input name="expires_at" type="date" defaultValue={account?.expiresAt?.slice(0, 10) || ""} /><small>Chaves vencidas são excluídas automaticamente do roteamento.</small></label>
          </div>
          <div className={styles.toggleGrid}>
            <label className={styles.toggle}><input name="enabled" type="checkbox" defaultChecked={account?.enabled || false} /><span><strong>Chave ativa</strong><small>Disponível para o roteamento BYOK.</small></span></label>
            <label className={styles.toggle}><input name="is_default" type="checkbox" defaultChecked={account?.isDefault || !data.credentials.length} /><span><strong>Chave padrão</strong><small>Primeira opção entre as chaves próprias.</small></span></label>
            <label className={styles.toggle}><input name="sandbox" type="checkbox" defaultChecked={account?.sandbox || false} /><span><strong>Identificação de homologação</strong><small>Rótulo operacional; a OpenAI não possui sandbox isolado.</small></span></label>
          </div>
          {account && <CredentialTimeline account={account} />}
          {account?.lastTestMessage && <p className={account.lastTestOk ? styles.resultOk : styles.resultError}>{account.lastTestMessage}</p>}
          <footer>
            {account && <button type="button" className={styles.dangerText} disabled={busy || !data.permissions.canWrite} onClick={() => requestRevoke(account)}>Revogar</button>}
            {account && !account.isDefault && <button type="button" disabled={busy || !data.permissions.canWrite} onClick={() => void mutate("/api/erp/ai/usage", { action: "credential.default", credentialId: account.id, revision: account.revision }, "Credencial definida como padrão.")}>Definir como padrão</button>}
            {account && <button type="button" disabled={busy || !account.enabled || !data.permissions.canWrite} onClick={() => void mutate("/api/erp/integrations/health/openai", { credential_id: account.id }, "Credencial testada com sucesso.")}>Testar conexão</button>}
            <button className={styles.primary} disabled={busy || !data.permissions.canWrite}>{account ? "Salvar alterações" : "Cadastrar chave"}</button>
          </footer>
        </form>
        <p className={styles.caption}>Use uma chave de projeto com o menor conjunto de permissões necessário. A disponibilidade dos modelos é controlada na conta OpenAI.</p>
        <Link className={styles.docsLink} href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Gerenciar chaves na OpenAI ↗</Link>
      </section>
    </div>
  );
}

function UsageTable(props: { data: AiCenterData; days: string; setDays: (value: string) => void; searchDraft: string; setSearchDraft: (value: string) => void; applySearch: () => void; feature: string; setFeature: (value: string) => void; model: string; setModel: (value: string) => void; status: string; setStatus: (value: string) => void; keySource: string; setKeySource: (value: string) => void; clearFilters: () => void; page: number; setPage: (page: number) => void; csvParams: string }) {
  const { data } = props;
  return (
    <div className={styles.stack}>
      <section className={styles.card}>
        <header><div><h3>Uso e rastreabilidade</h3><p>Metadados operacionais sem conteúdo de prompt ou credenciais.</p></div><a className={styles.button} href={`/api/erp/ai/usage?${props.csvParams}`}>Exportar CSV</a></header>
        <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); props.applySearch(); }}>
          <label>Buscar<input value={props.searchDraft} onChange={(event) => props.setSearchDraft(event.target.value)} placeholder="Modelo ou funcionalidade" /></label>
          <label>Período<select value={props.days} onChange={(event) => props.setDays(event.target.value)}><option value="7">7 dias</option><option value="30">30 dias</option><option value="90">90 dias</option></select></label>
          <label>Recurso<select value={props.feature} onChange={(event) => props.setFeature(event.target.value)}><option value="">Todos</option>{data.filterOptions.features.map((item) => <option key={item} value={item}>{data.features.find((feature) => feature.id === item)?.label || item}</option>)}</select></label>
          <label>Modelo<select value={props.model} onChange={(event) => props.setModel(event.target.value)}><option value="">Todos</option>{data.filterOptions.models.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Status<select value={props.status} onChange={(event) => props.setStatus(event.target.value)}><option value="">Todos</option><option value="completed">Concluída</option><option value="failed">Falhou</option><option value="incomplete">Incompleta</option><option value="in_progress">Em processamento</option></select></label>
          <label>Origem<select value={props.keySource} onChange={(event) => props.setKeySource(event.target.value)}><option value="">Todas</option><option value="platform">Gerenciada</option><option value="byok">BYOK</option></select></label>
          <div className={styles.filterActions}><button className={styles.primary}>Aplicar</button><button type="button" onClick={props.clearFilters}>Limpar</button></div>
        </form>
      </section>
      <section className={styles.card}>
        <div className={styles.tableWrap}><table><thead><tr><th>Data</th><th>Recurso</th><th>Modelo</th><th>Status</th><th>Origem</th><th>Tokens</th><th>Latência</th><th>Custo</th></tr></thead><tbody>{data.recent.map((item) => <tr key={item.id}><td>{dateTime(item.createdAt)}</td><td><strong>{item.featureLabel}</strong><small>{item.feature}</small></td><td><code>{item.model}</code></td><td><Status value={item.status} /></td><td>{item.keySource === "byok" ? "BYOK" : "Gerenciada"}</td><td>{number(item.inputTokens + item.outputTokens)}</td><td>{number(item.latencyMs)} ms</td><td>{money(item.cost)}</td></tr>)}</tbody></table></div>
        <div className={styles.mobileCards}>{data.recent.map((item) => <article key={item.id}><header><div><strong>{item.featureLabel}</strong><small>{dateTime(item.createdAt)}</small></div><Status value={item.status} /></header><dl><div><dt>Modelo</dt><dd>{item.model}</dd></div><div><dt>Origem</dt><dd>{item.keySource === "byok" ? "BYOK" : "Gerenciada"}</dd></div><div><dt>Tokens</dt><dd>{number(item.inputTokens + item.outputTokens)}</dd></div><div><dt>Latência</dt><dd>{number(item.latencyMs)} ms</dd></div></dl></article>)}</div>
        {!data.recent.length && <div className={styles.empty}>Nenhuma execução corresponde aos filtros.</div>}
        <footer className={styles.pagination}><span>{number(data.pagination.total)} registro(s) · página {data.pagination.page} de {data.pagination.pages}</span><button type="button" disabled={props.page <= 1} onClick={() => props.setPage(props.page - 1)}>Anterior</button><button type="button" disabled={props.page >= data.pagination.pages} onClick={() => props.setPage(props.page + 1)}>Próxima</button></footer>
      </section>
    </div>
  );
}

function Playground({ data, busy, result, setResult, setBusy, setError, setNotice, reload }: { data: AiCenterData; busy: boolean; result: string; setResult: (value: string) => void; setBusy: (value: boolean) => void; setError: (value: string) => void; setNotice: (value: string) => void; reload: () => Promise<void> }) {
  return (
    <div className={styles.playgroundGrid}>
      <section className={styles.card}>
        <header><div><h3>Laboratório seguro</h3><p>Valide política, modelo, chave e telemetria com uma chamada controlada.</p></div></header>
        <form onSubmit={async (event) => {
          event.preventDefault(); setBusy(true); setError(""); setNotice(""); setResult("");
          const form = new FormData(event.currentTarget);
          try {
            const response = await fetch("/api/erp/ai/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "playground", prompt: form.get("prompt"), instructions: form.get("instructions"), model: form.get("model"), maxOutputTokens: Number(form.get("max_output_tokens") || 600) }) });
            const body = (await response.json()) as { error?: string; result?: { outputText?: string } };
            if (!response.ok) throw new Error(body.error || "O teste não foi concluído.");
            setResult(body.result?.outputText || "A resposta não continha texto."); setNotice("Teste concluído e registrado na telemetria."); await reload();
          } catch (cause) { setError(cause instanceof Error ? cause.message : "O teste não foi concluído."); }
          finally { setBusy(false); }
        }}>
          <div className={styles.formGrid}>
            <label>Modelo<select name="model" defaultValue={data.policy.default_model}>{data.policy.allowed_models.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>Máximo de tokens<input name="max_output_tokens" type="number" min="1" max="4000" defaultValue={Math.min(600, data.policy.max_tokens)} /></label>
            <label className={styles.fullField}>Instruções opcionais<textarea name="instructions" maxLength={4000} rows={3} placeholder="Ex.: Responda em português, de forma objetiva." /></label>
            <label className={styles.fullField}>Prompt de teste<textarea name="prompt" required maxLength={8000} rows={8} placeholder="Descreva uma tarefa sem inserir dados pessoais reais." /></label>
          </div>
          <div className={styles.privacyNote}><strong>Privacidade</strong><span>{data.policy.redact_pii ? "E-mail, telefone e CPF serão redigidos antes do envio." : "A redação está desativada; não use dados reais neste teste."} A requisição usa <code>store: false</code> e o conteúdo não é salvo na telemetria do ERP.</span></div>
          <footer><button className={styles.primary} disabled={busy || !data.permissions.canWrite || !data.policy.enabled}>{busy ? "Executando…" : "Executar teste"}</button></footer>
        </form>
      </section>
      <section className={styles.card}><header><div><h3>Resultado</h3><p>Texto retornado pelo modelo selecionado.</p></div></header>{result ? <pre className={styles.result}>{result}</pre> : <div className={styles.empty}>Execute um teste para visualizar o resultado.</div>}<div className={styles.runChecklist}><Check ok={data.policy.enabled} title="Execução" detail={data.policy.enabled ? "Habilitada" : "Desativada"} /><Check ok={data.readiness.platformAvailable || data.readiness.activeByok > 0} title="Credencial" detail="Chave compatível com o roteamento" /><Check ok={data.policy.consumers["ai.playground"] !== false} title="Laboratório" detail="Recurso permitido pela política" /></div></section>
    </div>
  );
}

function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: string }) { return <article className={styles.metric} data-tone={tone}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>; }
function Ranking({ title, rows }: { title: string; rows: Array<{ label: string; value: number; detail: string }> }) { const max = Math.max(1, ...rows.map((item) => item.value)); return <section className={styles.card}><header><div><h3>{title}</h3><p>Distribuição no período selecionado.</p></div></header><div className={styles.ranking}>{rows.map((item) => <div key={item.label}><span><strong>{item.label}</strong><small>{number(item.value)} · {item.detail}</small></span><i><b style={{ width: `${(item.value / max) * 100}%` }} /></i></div>)}{!rows.length && <p className={styles.empty}>Sem dados no período.</p>}</div></section>; }
function Check({ ok, title, detail }: { ok: boolean; title: string; detail: string }) { return <article className={styles.check} data-ok={ok}><i>{ok ? "✓" : "!"}</i><span><strong>{title}</strong><small>{detail}</small></span></article>; }
function CredentialTimeline({ account }: { account: Credential }) { return <div className={styles.timeline}><span><small>Criada</small><strong>{date(account.createdAt)}</strong></span><span><small>Última rotação</small><strong>{account.lastRotatedAt ? date(account.lastRotatedAt) : "Não registrada"}</strong></span><span><small>Último teste</small><strong>{account.lastTestAt ? dateTime(account.lastTestAt) : "Não realizado"}</strong></span></div>; }
function Status({ value }: { value: string }) { const label: Record<string, string> = { completed: "Concluída", failed: "Falhou", incomplete: "Incompleta", in_progress: "Processando" }; return <span className={styles.status} data-status={value}>{label[value] || value}</span>; }
function number(value: number) { return new Intl.NumberFormat("pt-BR").format(value || 0); }
function compact(value: number) { return new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0); }
function percent(value: number) { return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`; }
function money(value: number) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0); }
function date(value: string) { return tenantDateTimeFormatter().format(new Date(value)); }
function dateTime(value: string) { return tenantDateTimeFormatter({ dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
