"use client";
import { tenantTimeZone } from "@/lib/client-timezone";
import { usePlanFeatures } from "./plan-features";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ErpModal } from "@/components/erp/modal-portal";
import styles from "./integration-center.module.css";

const TABS = [
  ["visao-geral", "Visão geral"],
  ["conexoes", "Conexões"],
  ["roteamento", "Roteamento"],
  ["webhooks", "Webhooks"],
  ["operacoes", "Operações"],
  ["governanca", "Governança"],
] as const;
const TAB_KEYS = new Set(TABS.map(([key]) => key));
const LEGACY: Record<string, string> = {
  geral: "visao-geral",
  mensagens: "conexoes",
  webhook: "webhooks",
  email: "conexoes",
  smtp: "conexoes",
  otp: "conexoes",
  ia: "conexoes",
  monitoramento: "operacoes",
  "fila-metricas": "operacoes",
  "notificacoes-externas": "operacoes",
};
const SPECIALIZED = ["shipping", "marketplace", "storage_s3", "crm"];

type Provider = {
  id: string;
  family: string;
  label: string;
  description: string;
  credentialSchema: Field[];
  supportsTest: boolean;
};
type Field = {
  key: string;
  label: string;
  type: string;
  secret?: boolean;
  required?: boolean;
  options?: string[];
  placeholder?: string;
};
type Credential = {
  id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  sandbox: boolean;
  isDefault: boolean;
  revision: number;
  ownerLabel?: string;
  expiresAt?: string;
  lastRotatedAt?: string;
  config: Record<string, unknown>;
  secretMetadata: Record<string, unknown>;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastTestMessage?: string;
};
type Routing = {
  context: string;
  providerId: string;
  fallbackProviderId: string;
  enabled: boolean;
  revision: number;
  config: Record<string, unknown>;
};

export function IntegrationCenter() {
  const features = usePlanFeatures();
  const [tab, setTab] = useState("visao-geral"),
    [hydrated, setHydrated] = useState(false),
    [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [lastUpdated, setLastUpdated] = useState<Date>(),
    [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const boundaryAttempts = useRef<
    Record<string, { signature: string; key: string }>
  >({});
  useEffect(() => {
    const url = new URL(window.location.href),
      requested = url.searchParams.get("tab") || "visao-geral",
      resolved =
        LEGACY[requested] ||
        (TAB_KEYS.has(requested as never) ? requested : "visao-geral");
    setTab(resolved);
    setHydrated(true);
    if (resolved !== requested) {
      url.searchParams.set("tab", resolved);
      window.history.replaceState({}, "", url);
    }
    load();
  }, []);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setCooldowns((current) =>
          Object.fromEntries(
            Object.entries(current).map(([key, value]) => [
              key,
              Math.max(0, value - 1),
            ]),
          ),
        ),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  async function load() {
    setError("");
    setRefreshing(true);
    const endpoints = [
      "/api/erp/integrations/overview",
      "/api/erp/integrations/providers",
      "/api/erp/integrations/credentials",
      "/api/erp/integrations/routing",
      "/api/erp/integrations/settings",
      "/api/erp/integrations/health/last",
      "/api/erp/integrations/monitor/status",
      "/api/erp/integrations/metrics?range=24h",
      "/api/erp/integrations/queue?per_page=50",
      "/api/erp/integrations/audit?limit=50",
      "/api/erp/integrations/opt-outs",
      "/api/erp/webhooks",
      "/api/erp/integrations/storage/migration",
      "/api/erp/integrations/otp/metrics?range=24h",
      "/api/erp/integrations/inbound",
    ];
    const results = await Promise.allSettled(
      endpoints.map(async (endpoint) => {
        const response = await fetch(endpoint, { cache: "no-store" }),
          body = await response.json();
        if (!response.ok)
          throw new Error(body.error || `Falha ao carregar ${endpoint}.`);
        return body;
      }),
    );
    const bodies = results.map((result) =>
      result.status === "fulfilled" ? result.value : undefined,
    );
    const failures = results.filter((result) => result.status === "rejected");
    setData((current: any) => ({
      overview: bodies[0]?.overview ?? current?.overview,
      providers: bodies[1]?.providers ?? current?.providers ?? [],
      credentials: bodies[2]?.credentials ?? current?.credentials ?? [],
      routing: bodies[3]?.routing ?? current?.routing ?? [],
      settings: bodies[4]?.settings ?? current?.settings ?? {},
      health: bodies[5]?.results ?? current?.health ?? [],
      monitor: bodies[6] ?? current?.monitor ?? { states: [], settings: {} },
      metrics: bodies[7] ?? current?.metrics ?? emptyMetrics(),
      queue: bodies[8]?.queue ?? current?.queue ?? [],
      queuePagination: bodies[8]?.pagination ?? current?.queuePagination,
      audit: bodies[9]?.audit ?? current?.audit ?? [],
      optOuts: bodies[10]?.opt_outs ?? current?.optOuts ?? [],
      webhooks: bodies[11]?.endpoints ?? current?.webhooks ?? [],
      deliveries: bodies[11]?.deliveries ?? current?.deliveries ?? [],
      migrations: bodies[12]?.migrations ?? current?.migrations ?? [],
      otpMetrics: bodies[13] ?? current?.otpMetrics ?? emptyOtpMetrics(),
      inbound: bodies[14]?.events ?? current?.inbound ?? [],
    }));
    setRefreshing(false);
    if (failures.length)
      setError(
        `${failures.length} bloco(s) não responderam. Os demais dados continuam disponíveis; tente atualizar novamente.`,
      );
    else setLastUpdated(new Date());
  }
  function navigate(next: string) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.pushState({}, "", url);
  }
  async function mutate(
    url: string,
    body?: unknown,
    method = "POST",
    success = "Alterações salvas.",
  ) {
    const record =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const isWebhookBoundary =
      (url === "/api/erp/webhooks" ||
        /^\/api\/erp\/webhooks\/[^/]+$/u.test(url)) &&
      record.action !== "test";
    const signature = `${method}:${url}:${JSON.stringify(record)}`,
      previous = boundaryAttempts.current[url];
    const attempt = isWebhookBoundary
      ? previous?.signature === signature
        ? previous
        : { signature, key: crypto.randomUUID() }
      : null;
    if (attempt) boundaryAttempts.current[url] = attempt;
    const requestBody = attempt
      ? { ...record, idempotencyKey: attempt.key }
      : body;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
          method,
          headers:
            requestBody === undefined
              ? undefined
              : { "content-type": "application/json" },
          body:
            requestBody === undefined ? undefined : JSON.stringify(requestBody),
        }),
        result = await response.json();
      if (!response.ok) {
        setError(result.error || "Não foi possível concluir.");
        return result;
      }
      if (attempt) delete boundaryAttempts.current[url];
      setNotice(success);
      window.setTimeout(() => setNotice(""), 3500);
      await load();
      return result;
    } catch {
      setError("A operação não respondeu. Verifique a conexão e tente novamente.");
      return { error: "network" };
    } finally {
      setBusy(false);
    }
  }
  async function test(providerId: string, credentialId?: string) {
    const key = credentialId || providerId;
    if (cooldowns[key]) return;
    setCooldowns((value) => ({ ...value, [key]: 10 }));
    await mutate(
      `/api/erp/integrations/health/${providerId}`,
      { credential_id: credentialId },
      "POST",
      "Teste concluído.",
    );
  }
  if (!data)
    return (
      <div className={styles.loading}>
        {error || "Carregando catálogo, credenciais e estado das integrações…"}
      </div>
    );
  const provider = (id: string) =>
    data.providers.find((item: Provider) => item.id === id);
  const cards = (ids: string[]) =>
    ids.map((id) => (
      <ProviderCard
        key={id}
        provider={provider(id)}
        credentials={data.credentials.filter(
          (item: Credential) => item.providerId === id,
        )}
        busy={busy}
        cooldowns={cooldowns}
        save={(payload) =>
          mutate(`/api/erp/integrations/credentials/${id}`, payload)
        }
        test={(credentialId) => test(id, credentialId)}
        remove={(credentialId) =>
          mutate(
            `/api/erp/integrations/credentials/${credentialId}`,
            undefined,
            "DELETE",
            "Conta removida.",
          )
        }
        connect={
          id === "marketplace"
            ? async (credential) => {
                const platform = String(
                    credential.config.platform || "marketplace",
                  ),
                  result = await mutate(
                    `/api/erp/integrations/${encodeURIComponent(platform)}/auth`,
                    { credential_id: credential.id },
                    "POST",
                    "Autorização OAuth iniciada.",
                  );
                if (result?.authorization_url)
                  window.location.assign(result.authorization_url);
              }
            : undefined
        }
      />
    ));
  return (
    <div className={styles.root}>
      <header className={styles.hero}>
        <div>
          <p>CENTRAL DE INTEGRAÇÕES</p>
          <h2>Operação conectada, segura e observável</h2>
          <span>
            Conexões, rotas, webhooks, filas e governança em uma única torre de controle.
          </span>
        </div>
        <div className={styles.heroActions}>
          {lastUpdated && <small>Atualizado {lastUpdated.toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone(), hour: "2-digit", minute: "2-digit" })}</small>}
          <button onClick={load} disabled={refreshing}>{refreshing ? "Atualizando…" : "Atualizar dados"}</button>
          <button className={styles.primary} disabled={busy} onClick={() => mutate("/api/erp/integrations/health/all", {}, "POST", "Diagnóstico concluído.")}>Executar diagnóstico</button>
        </div>
      </header>
      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}
      <nav className={styles.tabs} aria-label="Áreas de integração">
        {TABS.map(([key, label]) => (
          <button
            className={tab === key ? styles.active : ""}
            onClick={() => navigate(key)}
            key={key}
          >
            {label}
          </button>
        ))}
      </nav>
      <label className={styles.mobileTabs}>
        Área
        <select
          value={tab}
          disabled={!hydrated}
          onChange={(event) => navigate(event.target.value)}
        >
          {TABS.map(([key, label]) => (
            <option value={key} key={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div hidden={tab !== "visao-geral"} className={styles.stack}>
        <OverviewPanel data={data} navigate={navigate} />
      </div>
      <div hidden={tab !== "conexoes"} className={styles.stack}>
        <ConnectionInventory providers={data.providers} credentials={data.credentials} />
        <section className={styles.grid}>
          <DedicatedArea
            href="/erp/pagamentos-recebimentos"
            title="Pagamentos e recebimentos"
            description="Provedores, contas, capacidades e roteamento por filial e caixa."
          />
          <DedicatedArea
            href="/erp/emails-transacionais"
            title="E-mails transacionais"
            description="SMTP, OTP e catálogo versionado de mensagens."
          />
          <DedicatedArea
            href="/erp/inteligencia-artificial"
            title="Inteligência artificial"
            description="OpenAI gerenciada ou BYOK, modelos, limites e uso."
          />
        </section>
        <section>
          <Heading
            title="Demais integrações"
            text={features.marketplaces ? "Frete, marketplace OAuth, armazenamento/CDN e CRM usam o mesmo contrato seguro." : "Frete, armazenamento/CDN e CRM. Use API e webhooks para conectar seu sistema integrador."}
          />
          <div className={styles.grid}>{cards(SPECIALIZED.filter(id => id !== "marketplace" || features.marketplaces))}</div>
        </section>
        <div className={styles.grid}>
          <SettingsCard
            title="Frete"
            description="Serviços, markup, cache e tarifa de continuidade."
            section="shipping"
            value={data.settings.shipping}
            revision={data.settings.revision}
            mutate={mutate}
            busy={busy}
          />
          <SettingsCard
            title="Armazenamento"
            description="Offload, retenção local e migração reversível."
            section="storage"
            value={data.settings.storage}
            revision={data.settings.revision}
            mutate={mutate}
            busy={busy}
          />
          <StorageMigration
            rows={data.migrations}
            mutate={mutate}
            busy={busy}
          />
        </div>
      </div>
      <div hidden={tab !== "roteamento"} className={styles.stack}>
        <RoutingCards routing={data.routing} providers={data.providers} mutate={mutate} busy={busy} />
      </div>
      <div hidden={tab !== "webhooks"}>
        <WebhooksPanel
          rows={data.webhooks}
          deliveries={data.deliveries}
          mutate={mutate}
          busy={busy}
        />
      </div>
      <div hidden={tab !== "operacoes"} className={styles.stack}>
        <MonitorPanel
          data={data.monitor}
          health={data.health}
          mutate={mutate}
          busy={busy}
        />
        <QueuePanel data={data} mutate={mutate} busy={busy} />
      </div>
      <div hidden={tab !== "governanca"}>
        <GovernancePanel data={data} />
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  credentials,
  busy,
  cooldowns,
  save,
  test,
  remove,
  connect,
}: {
  provider: Provider;
  credentials: Credential[];
  busy: boolean;
  cooldowns: Record<string, number>;
  save: (body: unknown) => Promise<any>;
  test: (credentialId?: string) => void;
  remove: (id: string) => Promise<any>;
  connect?: (credential: Credential) => void;
}) {
  const [selectedId, setSelectedId] = useState(credentials[0]?.id || "new"),
    [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (
      selectedId !== "new" &&
      !credentials.some((item) => item.id === selectedId)
    )
      setSelectedId(credentials[0]?.id || "new");
  }, [credentials, selectedId]);
  const credential = credentials.find((item) => item.id === selectedId);
  const cooldown = credential ? cooldowns[credential.id] || 0 : 0;
  if (!provider) return null;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      fields: Record<string, unknown> = {};
    for (const field of provider.credentialSchema) {
      const value = form.get(field.key);
      fields[field.key] =
        field.type === "number"
          ? Number(value || 0)
          : field.type === "boolean"
            ? value === "on"
            : value;
    }
    const result = await save({
      id: credential?.id,
      revision: credential?.revision,
      label: form.get("label"),
      owner_label: form.get("ownerLabel"),
      expires_at: form.get("expiresAt"),
      enabled: form.get("enabled") === "on",
      sandbox: form.get("sandbox") === "on",
      isDefault: form.get("isDefault") === "on",
      fields,
    });
    if (result?.credential?.id) setSelectedId(result.credential.id);
  }
  return (
    <section className={styles.card}>
      <header>
        <div>
          <h3>{provider.label}</h3>
          <p>{provider.description}</p>
        </div>
        <Status ok={credential?.lastTestOk} configured={Boolean(credential)} />
      </header>
      {credentials.length > 0 && (
        <label>
          Conta
          <select
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {credentials.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label || "Conta sem nome"}
                {item.isDefault ? " · padrão" : ""}
              </option>
            ))}
            <option value="new">+ Nova conta</option>
          </select>
        </label>
      )}
      <form key={credential?.id || "new"} onSubmit={submit}>
        <label className={styles.toggle}>
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={credential?.enabled}
          />
          <span>
            <strong>Ativar provider</strong>
            <small>Desligado não participa do roteamento automático.</small>
          </span>
        </label>
        <div className={styles.fields}>
          <label>
            Rótulo da conta
            <input
              name="label"
              defaultValue={
                credential?.label || `Conta ${credentials.length + 1}`
              }
            />
          </label>
          <label>
            Responsável interno
            <input
              name="ownerLabel"
              defaultValue={credential?.ownerLabel || ""}
              maxLength={120}
              placeholder="Equipe ou pessoa responsável"
            />
          </label>
          <label>
            Validade da credencial
            <input
              name="expiresAt"
              type="date"
              defaultValue={credential?.expiresAt?.slice(0, 10) || ""}
            />
          </label>
          {provider.credentialSchema.map((field) => (
            <FieldInput key={field.key} field={field} credential={credential} />
          ))}
          <label className={styles.check}>
            <input
              name="sandbox"
              type="checkbox"
              defaultChecked={credential?.sandbox}
            />{" "}
            Ambiente sandbox
          </label>
          <label className={styles.check}>
            <input
              name="isDefault"
              type="checkbox"
              defaultChecked={credential?.isDefault || !credentials.length}
            />{" "}
            Conta padrão
          </label>
        </div>
        <footer>
          <button
            type="button"
            onClick={() => test(credential?.id)}
            disabled={busy || cooldown > 0 || !credential}
          >
            {cooldown ? `Testar em ${cooldown}s` : "Testar conexão"}
          </button>
          {connect && credential && (
            <button
              type="button"
              onClick={() => connect(credential)}
              disabled={busy}
            >
              Conectar OAuth
            </button>
          )}
          {credential && (
            <button
              type="button"
              className={styles.danger}
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
            >
              Excluir
            </button>
          )}
          <button className={styles.primary} disabled={busy}>
            Salvar {credential ? "conta" : "nova conta"}
          </button>
        </footer>
      </form>
      {credential?.lastTestMessage && (
        <div
          className={
            credential.lastTestOk ? styles.resultOk : styles.resultError
          }
        >
          {credential.lastTestMessage}
          {credential.lastTestAt
            ? ` · ${new Date(credential.lastTestAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}`
            : ""}
        </div>
      )}
      {credential && (
        <div className={styles.lifecycle}>
          <span>Versão {credential.revision}</span>
          <span>{credential.ownerLabel || "Sem responsável definido"}</span>
          <span>
            {credential.lastRotatedAt
              ? `Rotacionada ${new Date(credential.lastRotatedAt).toLocaleDateString("pt-BR", { timeZone: tenantTimeZone() })}`
              : "Rotação ainda não registrada"}
          </span>
        </div>
      )}
      {confirmDelete && credential && (
        <ConfirmDialog
          title="Revogar credencial"
          text={`A conta “${credential.label || provider.label}” será desativada e preservada no histórico de auditoria.`}
          confirmLabel="Revogar credencial"
          busy={busy}
          close={() => setConfirmDelete(false)}
          confirm={async () => {
            await remove(credential.id);
            setConfirmDelete(false);
          }}
        />
      )}
    </section>
  );
}

function FieldInput({
  field,
  credential,
}: {
  field: Field;
  credential?: Credential;
}) {
  const [visible, setVisible] = useState(false),
    value = credential?.config?.[field.key],
    preview = String(
      credential?.secretMetadata?.[`${field.key}_preview`] || "",
    );
  if (field.type === "select")
    return (
      <label>
        {field.label}
        <select
          name={field.key}
          defaultValue={String(value || field.options?.[0] || "")}
        >
          {field.options?.map((item) => (
            <option value={item} key={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
    );
  if (field.type === "boolean")
    return (
      <label className={styles.check}>
        <input
          name={field.key}
          type="checkbox"
          defaultChecked={value === true}
        />{" "}
        {field.label}
      </label>
    );
  return (
    <label>
      {field.label}
      {field.required && " *"}
      <input
        name={field.key}
        type={
          field.secret && !visible
            ? "password"
            : field.type === "number"
              ? "number"
              : field.type === "password"
                ? "text"
                : field.type
        }
        step={field.type === "number" ? "any" : undefined}
        defaultValue={field.secret ? "" : String(value ?? "")}
        placeholder={
          field.secret && preview
            ? `${preview} · vazio mantém`
            : field.placeholder
        }
        autoComplete={field.secret ? "new-password" : undefined}
      />
      {field.secret && (
        <small>
          <button type="button" onClick={() => setVisible((value) => !value)}>
            {visible ? "Ocultar valor digitado" : "Mostrar valor digitado"}
          </button>
        </small>
      )}
    </label>
  );
}

function RoutingCards({
  routing,
  providers,
  mutate,
  busy,
}: {
  routing: Routing[];
  providers: Provider[];
  mutate: any;
  busy: boolean;
}) {
  return (
    <section>
      <Heading
        title="Roteamento por contexto"
        text="Falhas de transporte podem usar fallback; rejeições de negócio não são reenviadas."
      />
      <div className={styles.routing}>
        {routing.map((route) => (
          <form
            key={route.context}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              mutate(`/api/erp/integrations/routing/${route.context}`, {
                revision: route.revision,
                enabled: form.get("enabled") === "on",
                provider: form.get("provider"),
                fallback_provider: form.get("fallback"),
              });
            }}
          >
            <header>
              <strong>{contextLabel(route.context)}</strong>
              <span>
                {["checkout", "login", "register", "password_reset"].includes(
                  route.context,
                )
                  ? "OTP"
                  : "Mensageria"}
              </span>
            </header>
            <label className={styles.check}>
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={route.enabled}
              />{" "}
              Ativo
            </label>
            <label>
              Primário
              <select name="provider" defaultValue={route.providerId || "auto"}>
                <option value="auto">Automático</option>
                {providers
                  .filter((item) => item.family === "messaging")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Fallback
              <select
                name="fallback"
                defaultValue={route.fallbackProviderId ?? ""}
              >
                <option value="">Escolher automaticamente</option>
                <option value="_none">Sem fallback</option>
                {providers
                  .filter((item) => item.family === "messaging")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </label>
            <button className={styles.primary} disabled={busy}>
              Salvar rota
            </button>
          </form>
        ))}
      </div>
    </section>
  );
}

function SettingsCard({
  title,
  description,
  section,
  value,
  revision,
  mutate,
  busy,
}: {
  title: string;
  description: string;
  section: string;
  value: Record<string, unknown>;
  revision: number;
  mutate: any;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2)),
    [validation, setValidation] = useState(""),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(JSON.stringify(value, null, 2));
  }, [value, dirty]);
  const changeDraft = (next: string) => {
    setDraft(next);
    setValidation("");
    setDirty(true);
  };
  return (
    <section className={styles.card}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {dirty && <span className={styles.status}>Rascunho</span>}
      </header>
      <PrimitiveSettingsFields draft={draft} onChange={changeDraft} />
      <details>
        <summary>Configuração avançada JSON</summary>
        <label className={styles.jsonLabel}>
          JSON validado
          <textarea
            value={draft}
            onChange={(event) => changeDraft(event.target.value)}
            spellCheck={false}
          />
        </label>
      </details>
      {validation && <div className={styles.error}>{validation}</div>}
      <footer>
        <button
          className={styles.primary}
          disabled={busy}
          onClick={async () => {
            try {
              const result = await mutate(
                `/api/erp/integrations/settings/${section}`,
                { settings: JSON.parse(draft), revision },
              );
              if (!result?.error) setDirty(false);
            } catch {
              setValidation(
                "O JSON desta seção está inválido. Corrija a sintaxe antes de salvar.",
              );
            }
          }}
        >
          Salvar seção
        </button>
      </footer>
    </section>
  );
}

function PrimitiveSettingsFields({
  draft,
  onChange,
}: {
  draft: string;
  onChange: (value: string) => void;
}) {
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(draft);
  } catch {
    return null;
  }
  const entries = Object.entries(values).filter(
    ([, value]) =>
      value === null || ["string", "number", "boolean"].includes(typeof value),
  );
  const update = (key: string, value: unknown) =>
    onChange(JSON.stringify({ ...values, [key]: value }, null, 2));
  return (
    <div className={styles.fields}>
      {entries.map(([key, value]) =>
        value === null ? (
          <label key={key}>
            {settingLabel(key)}
            <select
              value="auto"
              onChange={(event) =>
                update(
                  key,
                  event.target.value === "auto"
                    ? null
                    : event.target.value === "true",
                )
              }
            >
              <option value="auto">Automático</option>
              <option value="true">Ligado</option>
              <option value="false">Desligado</option>
            </select>
          </label>
        ) : typeof value === "boolean" ? (
          <label className={styles.check} key={key}>
            <input
              type="checkbox"
              checked={value}
              onChange={(event) => update(key, event.target.checked)}
            />{" "}
            {settingLabel(key)}
          </label>
        ) : (
          <label key={key}>
            {settingLabel(key)}
            {String(key).includes("template") ? (
              <textarea
                value={String(value)}
                onChange={(event) => update(key, event.target.value)}
              />
            ) : (
              <input
                type={typeof value === "number" ? "number" : "text"}
                step={typeof value === "number" ? "any" : undefined}
                value={String(value)}
                onChange={(event) =>
                  update(
                    key,
                    typeof value === "number"
                      ? Number(event.target.value)
                      : event.target.value,
                  )
                }
              />
            )}
          </label>
        ),
      )}
    </div>
  );
}

function WebhooksPanel({
  rows,
  deliveries,
  mutate,
  busy,
}: {
  rows: any[];
  deliveries: any[];
  mutate: any;
  busy: boolean;
}) {
  const [secret, setSecret] = useState(""),
    [confirmation, setConfirmation] = useState<null | {
      title: string;
      text: string;
      label: string;
      action: () => Promise<void>;
    }>(null);
  return (
    <div className={styles.stack}>
      <section className={styles.card}>
        <header>
          <div>
            <h3>Novo endpoint</h3>
            <p>
              Segredo HMAC exibido uma única vez. Tópico imutável após a
              criação.
            </p>
          </div>
        </header>
        {secret && (
          <div className={styles.notice}>
            <strong>Copie o segredo agora:</strong>
            <br />
            <code>{secret}</code>{" "}
            <button onClick={() => navigator.clipboard.writeText(secret)}>
              Copiar
            </button>
            <button onClick={() => setSecret("")}>Já salvei</button>
          </div>
        )}
        <form
          className={styles.inlineForm}
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget),
              result = await mutate("/api/erp/webhooks", {
                name: form.get("name"),
                topic: form.get("topic"),
                delivery_url: form.get("url"),
              });
            if (result?.secret) setSecret(result.secret);
          }}
        >
          <label>
            Nome
            <input name="name" required />
          </label>
          <label>
            Tópico
            <select name="topic">
              <option>order.created</option>
              <option>order.updated</option>
              <option>order.deleted</option>
              <option>product.created</option>
              <option>product.updated</option>
              <option>product.deleted</option>
              <option>customer.created</option>
              <option>customer.updated</option>
              <option>customer.deleted</option>
              <option>coupon.created</option>
              <option>coupon.updated</option>
              <option>coupon.deleted</option>
            </select>
          </label>
          <label>
            URL HTTPS
            <input
              name="url"
              type="url"
              required
              placeholder="https://seu-sistema.com/webhooks/nalven"
            />
          </label>
          <button className={styles.primary} disabled={busy}>
            Criar endpoint
          </button>
        </form>
      </section>
      <section className={styles.card}>
        <header>
          <div>
            <h3>Endpoints de saída</h3>
            <p>
              Assinatura SHA-256, anti-replay, deduplicação e entrega
              at-least-once.
            </p>
          </div>
        </header>
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tópico</th>
                <th>Destino</th>
                <th>Status</th>
                <th>Entregas</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.topic}</td>
                  <td>{row.deliveryUrl}</td>
                  <td>
                    <Status ok={row.status === "active"} configured />
                  </td>
                  <td>{row._count?.deliveries || 0}</td>
                  <td>
                    <details className={styles.actionMenu}>
                      <summary>Ações</summary>
                      <div>
                    <button
                      onClick={() =>
                        mutate(
                          `/api/erp/webhooks/${row.id}`,
                          { action: "test" },
                          "POST",
                          "Webhook testado.",
                        )
                      }
                    >
                      Testar
                    </button>
                    <button
                      onClick={() => setConfirmation({
                        title: "Rotacionar segredo do webhook",
                        text: "O consumidor precisará trocar o segredo imediatamente. O valor atual deixará de validar novas entregas.",
                        label: "Rotacionar segredo",
                        action: async () => {
                          const result = await mutate(
                            `/api/erp/webhooks/${row.id}`,
                            { action: "rotate_secret", confirm: true },
                            "POST",
                            "Segredo rotacionado.",
                          );
                          if (result?.secret) setSecret(result.secret);
                        },
                      })}
                    >
                      Rotacionar segredo
                    </button>
                    <button
                      className={styles.danger}
                      onClick={() => setConfirmation({
                        title: "Desativar webhook",
                        text: `O endpoint “${row.name}” deixará de receber eventos e sua versão permanecerá na auditoria.`,
                        label: "Desativar webhook",
                        action: async () => { await mutate(`/api/erp/webhooks/${row.id}`, undefined, "DELETE", "Webhook desativado."); },
                      })}
                    >
                      Excluir
                    </button>
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={styles.card}>
        <header>
          <div>
            <h3>Últimas entregas</h3>
            <p>
              Payload, resposta, latência e reenvio manual para investigar
              falhas.
            </p>
          </div>
        </header>
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                <th>Evento</th>
                <th>Endpoint</th>
                <th>Estado</th>
                <th>HTTP</th>
                <th>Latência</th>
                <th>Resposta</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.eventId}</code>
                    <br />
                    <small>{row.topic}</small>
                  </td>
                  <td>{row.endpoint?.name}</td>
                  <td>{row.state}</td>
                  <td>{row.responseCode || "—"}</td>
                  <td>
                    {row.durationMs == null ? "—" : `${row.durationMs} ms`}
                  </td>
                  <td>
                    <details>
                      <summary>Ver</summary>
                      <pre>
                        {JSON.stringify(
                          { payload: row.payload, response: row.responseBody },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </td>
                  <td>
                    {row.state !== "delivered" ? (
                      <details className={styles.actionMenu}>
                        <summary>Ações</summary>
                        <div>
                      <button
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            `/api/erp/webhooks/deliveries/${row.id}`,
                            { action: "retry" },
                            "POST",
                            "Entrega reenviada.",
                          )
                        }
                      >
                        Reenviar
                      </button>
                        </div>
                      </details>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {confirmation && <ConfirmDialog title={confirmation.title} text={confirmation.text} confirmLabel={confirmation.label} busy={busy} close={() => setConfirmation(null)} confirm={async () => { await confirmation.action(); setConfirmation(null); }} />}
    </div>
  );
}

function StorageMigration({
  rows,
  mutate,
  busy,
}: {
  rows: any[];
  mutate: any;
  busy: boolean;
}) {
  const active = rows.find((row) => ["running", "paused"].includes(row.status));
  return (
    <section className={styles.card}>
      <header>
        <div>
          <h3>Migração de mídia</h3>
          <p>
            Upload verificável, progresso persistente e remoção local somente
            após retenção.
          </p>
        </div>
      </header>
      {active ? (
        <>
          <p>
            <strong>{active.status}</strong> · {active.processed}/{active.total}{" "}
            processados · {active.failed} falhas
          </p>
          <progress max={Math.max(1, active.total)} value={active.processed} />{" "}
          <button
            disabled={busy}
            onClick={() =>
              mutate("/api/erp/integrations/storage/migration", {
                id: active.id,
                action: active.status === "paused" ? "resume" : "pause",
              })
            }
          >
            {active.status === "paused" ? "Retomar" : "Pausar"}
          </button>
        </>
      ) : (
        <button
          className={styles.primary}
          disabled={busy}
          onClick={() =>
            mutate(
              "/api/erp/integrations/storage/migration",
              { action: "start" },
              "POST",
              "Migração iniciada.",
            )
          }
        >
          Iniciar migração
        </button>
      )}
    </section>
  );
}

function MonitorPanel({
  data,
  health,
  mutate,
  busy,
}: {
  data: any;
  health: any[];
  mutate: any;
  busy: boolean;
}) {
  const states = data.states || health;
  return (
    <div className={styles.stack}>
      <section className={styles.card}>
        <header>
          <div>
            <h3>Monitoramento ativo</h3>
            <p>
              Alertas usam o canal persistente independente da plataforma, nunca
              o provider monitorado.
            </p>
          </div>
          <Status ok={data.effective_enabled} configured />
        </header>
        <div className={styles.healthGrid}>
          {states.map((state: any) => (
            <article key={state.providerId}>
              <Status
                ok={state.status === "up" || state.status === "ok"}
                configured
              />
              <strong>{state.providerId}</strong>
              <small>
                {state.lastCheckAt
                  ? `Última checagem ${new Date(state.lastCheckAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}`
                  : "Nunca testado"}
              </small>
              <span>{state.consecutiveFailures || 0} falhas consecutivas</span>
              <details>
                <summary>Eventos</summary>
                {(Array.isArray(state.events) ? state.events : [])
                  .slice()
                  .reverse()
                  .map((event: any, index: number) => (
                    <small key={`${event.at}-${index}`}>
                      {event.at
                        ? new Date(event.at).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })
                        : "—"}{" "}
                      · {event.status} · {event.message}
                      {event.alert ? " · alerta" : ""}
                    </small>
                  ))}
              </details>
            </article>
          ))}
        </div>
        <footer>
          <button
            disabled={busy}
            onClick={() =>
              mutate(
                "/api/erp/integrations/health/all",
                {},
                "POST",
                "Todas as integrações foram testadas.",
              )
            }
          >
            Testar agora
          </button>
          <button
            className={styles.primary}
            disabled={busy}
            onClick={() =>
              mutate(
                "/api/erp/integrations/monitor/test-alert",
                {},
                "POST",
                "Alerta de teste registrado.",
              )
            }
          >
            Testar alerta
          </button>
        </footer>
      </section>
      <MonitorSettings value={data.settings} revision={data.revision} mutate={mutate} busy={busy} />
    </div>
  );
}
function MonitorSettings({
  value,
  revision,
  mutate,
  busy,
}: {
  value: any;
  revision: number;
  mutate: any;
  busy: boolean;
}) {
  return (
    <form
      className={styles.card}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget),
          enabled = form.get("enabled");
        mutate("/api/erp/integrations/monitor/settings", {
          revision,
          settings: {
            enabled: enabled === "auto" ? null : enabled === "true",
            interval_min: Number(form.get("interval")),
            realert_interval_min: Number(form.get("realert")),
            failure_threshold: Number(form.get("threshold")),
            max_daily_alerts: Number(form.get("daily")),
            events_window: Number(form.get("window")),
          },
        });
      }}
    >
      <header>
        <div>
          <h3>Política anti-flapping</h3>
          <p>Limiar, re-alerta e teto diário trabalham em conjunto.</p>
        </div>
      </header>
      <div className={styles.fields}>
        <label>
          Ativação
          <select
            name="enabled"
            defaultValue={
              value.enabled === null ? "auto" : String(value.enabled)
            }
          >
            <option value="auto">Automático</option>
            <option value="true">Forçado ligado</option>
            <option value="false">Forçado desligado</option>
          </select>
        </label>
        <label>
          Intervalo (min)
          <input
            name="interval"
            type="number"
            min="1"
            defaultValue={value.interval_min}
          />
        </label>
        <label>
          Re-alerta (min)
          <input
            name="realert"
            type="number"
            min="1"
            defaultValue={value.realert_interval_min}
          />
        </label>
        <label>
          Falhas para alertar
          <input
            name="threshold"
            type="number"
            min="1"
            defaultValue={value.failure_threshold}
          />
        </label>
        <label>
          Teto diário
          <input
            name="daily"
            type="number"
            min="1"
            defaultValue={value.max_daily_alerts}
          />
        </label>
        <label>
          Janela de eventos
          <input
            name="window"
            type="number"
            min="1"
            defaultValue={value.events_window}
          />
        </label>
      </div>
      <footer>
        <button className={styles.primary} disabled={busy}>
          Salvar monitor
        </button>
      </footer>
    </form>
  );
}

function QueuePanel({
  data,
  mutate,
  busy,
}: {
  data: any;
  mutate: any;
  busy: boolean;
}) {
  const otp = data.otpMetrics,
    [metrics, setMetrics] = useState<any>(data.metrics),
    [rows, setRows] = useState<any[]>(data.queue),
    [pagination, setPagination] = useState<any>(data.queuePagination || { page: 1, pages: 1, total: data.queue.length }),
    [filters, setFilters] = useState({ state: "", channel: "", context: "" }),
    [selected, setSelected] = useState<string[]>([]),
    [range, setRange] = useState("24h");
  useEffect(() => {
    setRows(data.queue);
    setPagination(data.queuePagination || { page: 1, pages: 1, total: data.queue.length });
  }, [data.queue, data.queuePagination]);
  useEffect(() => setMetrics(data.metrics), [data.metrics]);
  async function loadQueue(nextFilters = filters, page = 1) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(nextFilters))
      if (value) query.set(key, value);
    query.set("per_page", "30");
    query.set("page", String(page));
    const response = await fetch(`/api/erp/integrations/queue?${query}`),
      body = await response.json();
    if (response.ok) {
      setRows(body.queue);
      setPagination(body.pagination);
      setSelected([]);
    }
  }
  async function filter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget), next = {
      state: String(form.get("state") || ""),
      channel: String(form.get("channel") || ""),
      context: String(form.get("context") || ""),
    };
    setFilters(next);
    await loadQueue(next, 1);
  }
  async function changeRange(next: string) {
    setRange(next);
    const response = await fetch(`/api/erp/integrations/metrics?range=${next}`, { cache: "no-store" });
    if (response.ok) setMetrics(await response.json());
  }
  return (
    <div className={styles.stack}>
      <div className={styles.metrics}>
        <article>
          <small>Envios</small>
          <strong>{metrics.total}</strong>
        </article>
        <article>
          <small>Fila pendente</small>
          <strong>{metrics.pending}</strong>
        </article>
        <article>
          <small>Latência P95</small>
          <strong>{formatDuration(metrics.processing_p95_ms)}</strong>
        </article>
        <article>
          <small>Provider P95</small>
          <strong>{formatDuration(metrics.provider_p95_ms)}</strong>
        </article>
        <article>
          <small>Sucesso</small>
          <strong>{metrics.success}</strong>
        </article>
        <article>
          <small>Falhas</small>
          <strong>{metrics.failed}</strong>
        </article>
        <article>
          <small>Taxa de entrega</small>
          <strong>{(metrics.delivery_rate * 100).toFixed(1)}%</strong>
        </article>
        <article>
          <small>OTP verificados</small>
          <strong>
            {otp.verified}/{otp.sent}
          </strong>
        </article>
        <article>
          <small>Conversão OTP</small>
          <strong>{(otp.conversion_rate * 100).toFixed(1)}%</strong>
        </article>
      </div>
      <section className={styles.card}>
        <header>
          <div>
            <h3>Principais erros</h3>
            <p>Ordenados por frequência para priorizar a causa dominante.</p>
          </div>
          <label className={styles.compactSelect}>Período<select value={range} onChange={(event) => changeRange(event.target.value)}><option value="24h">24 horas</option><option value="7d">7 dias</option><option value="30d">30 dias</option></select></label>
        </header>
        {metrics.top_errors.length ? (
          <ol>
            {metrics.top_errors.map((item: any) => (
              <li key={item.error}>
                <strong>{item.count}×</strong> {item.error}
              </li>
            ))}
          </ol>
        ) : (
          <p>Nenhuma falha no período.</p>
        )}
      </section>
      <section className={styles.card}>
        <header>
          <div>
            <h3>Fila de integrações</h3>
            <p>
              Filtros por estado, canal e contexto; itens mortos podem ser
              reenfileirados.
            </p>
          </div>
        </header>
        <form className={styles.inlineForm} onSubmit={filter}>
          <label>
            Estado
            <select name="state">
              <option value="">Todos</option>
              <option>pending</option>
              <option>processing</option>
              <option>success</option>
              <option>failed</option>
              <option>dead</option>
              <option>cancelled</option>
            </select>
          </label>
          <label>
            Canal
            <input name="channel" placeholder="email, smtp…" />
          </label>
          <label>
            Contexto
            <input name="context" placeholder="checkout…" />
          </label>
          <button>Filtrar</button>
        </form>
        {selected.length > 0 && (
          <div className={styles.batchBar}>
            <strong>{selected.length} selecionado(s)</strong>
            <button disabled={busy} onClick={() => mutate("/api/erp/integrations/queue/batch", { action: "retry", ids: selected }, "POST", "Itens elegíveis reenfileirados.")}>Reenfileirar falhos</button>
            <button className={styles.danger} disabled={busy} onClick={() => mutate("/api/erp/integrations/queue/batch", { action: "cancel", ids: selected }, "POST", "Itens elegíveis cancelados.")}>Cancelar elegíveis</button>
          </div>
        )}
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                <th><span className={styles.srOnly}>Selecionar</span></th>
                <th>Evento</th>
                <th>Contexto</th>
                <th>Canal</th>
                <th>Destino</th>
                <th>Tentativas</th>
                <th>Estado</th>
                <th>Erro/payload</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => (
                <tr key={row.id}>
                  <td><input type="checkbox" aria-label={`Selecionar ${row.eventType}`} checked={selected.includes(row.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></td>
                  <td>{row.eventType}</td>
                  <td>{row.context}</td>
                  <td>{row.channel}</td>
                  <td>{row.recipientMasked || "—"}</td>
                  <td>
                    {row.attempts}/{row.maxAttempts}
                  </td>
                  <td>
                    <Status ok={row.state === "success"} configured />
                  </td>
                  <td>
                    <details>
                      <summary>{row.lastError || "Detalhes"}</summary>
                      <pre>{JSON.stringify(row.payload, null, 2)}</pre>
                    </details>
                  </td>
                  <td>
                    {!["success", "cancelled"].includes(row.state) ? (
                      <details className={styles.actionMenu}>
                        <summary>Ações</summary>
                        <div>
                          {["failed", "dead"].includes(row.state) && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                mutate(
                                  `/api/erp/integrations/queue/${row.id}/retry`,
                                  {},
                                  "POST",
                                  "Item reenfileirado.",
                                )
                              }
                            >
                              Reenviar
                            </button>
                          )}
                          <button
                            className={styles.danger}
                            disabled={busy}
                            onClick={() =>
                              mutate(
                                `/api/erp/integrations/queue/${row.id}`,
                                undefined,
                                "DELETE",
                                "Item cancelado.",
                              )
                            }
                          >
                            Cancelar
                          </button>
                        </div>
                      </details>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className={styles.pagination}>
          <span>{pagination.total || 0} item(ns) · página {pagination.page || 1} de {Math.max(1, pagination.pages || 1)}</span>
          <button disabled={(pagination.page || 1) <= 1} onClick={() => loadQueue(filters, pagination.page - 1)}>Anterior</button>
          <button disabled={(pagination.page || 1) >= (pagination.pages || 1)} onClick={() => loadQueue(filters, pagination.page + 1)}>Próxima</button>
        </footer>
      </section>
    </div>
  );
}

function OverviewPanel({ data, navigate }: { data: any; navigate: (tab: string) => void }) {
  const overview = data.overview || {},
    providers = overview.providers || {},
    health = overview.health || {},
    queue = overview.queue || {},
    webhooks = overview.webhooks || {},
    readiness = overview.readiness === "ready";
  const checks = [
    { label: "Credenciais ativas", ok: (providers.activeCredentials || 0) > 0, action: "conexoes" },
    { label: "Monitor automático", ok: overview.monitorEnabled === true, action: "operacoes" },
    { label: "Providers sem degradação", ok: (health.degraded || 0) === 0, action: "operacoes" },
    { label: "Fila morta zerada", ok: (queue.dead || 0) === 0, action: "operacoes" },
    { label: "Credenciais dentro da validade", ok: (providers.expiringCredentials || 0) === 0, action: "conexoes" },
    { label: "Webhooks sem falhas acumuladas", ok: (webhooks.unhealthy || 0) === 0, action: "webhooks" },
  ];
  return (
    <>
      <section className={`${styles.readiness} ${readiness ? styles.readinessOk : styles.readinessAttention}`}>
        <div>
          <p>PRONTIDÃO OPERACIONAL</p>
          <h3>{readiness ? "Ecossistema pronto para operar" : "Há pontos que pedem atenção"}</h3>
          <span>{readiness ? "As barreiras essenciais estão atendidas." : (overview.blockers || []).join(" · ") || "Revise as verificações abaixo."}</span>
        </div>
        <strong>{checks.filter((item) => item.ok).length}/{checks.length}</strong>
      </section>
      <div className={styles.metrics}>
        <Metric label="Conexões ativas" value={providers.activeCredentials || 0} note={`${providers.configured || 0} providers configurados`} />
        <Metric label="Saúde" value={health.degraded || 0} note="providers degradados" tone={(health.degraded || 0) ? "danger" : "success"} />
        <Metric label="Fila pendente" value={(queue.pending || 0) + (queue.processing || 0)} note={`mais antigo há ${queue.oldestBacklogMinutes || 0} min`} tone={(queue.dead || 0) ? "danger" : "neutral"} />
        <Metric label="Taxa de entrega" value={`${((data.metrics?.delivery_rate || 0) * 100).toFixed(1)}%`} note="últimas 24 horas" />
        <Metric label="Webhooks ativos" value={webhooks.active || 0} note={`${webhooks.unhealthy || 0} com falhas`} tone={(webhooks.unhealthy || 0) ? "warning" : "success"} />
        <Metric label="Eventos recebidos" value={Object.values(overview.inbound || {}).reduce((sum: number, value) => sum + Number(value), 0)} note="últimas 24 horas" />
      </div>
      <section className={styles.card}>
        <header><div><h3>Checklist de produção</h3><p>O que precisa estar saudável antes de depender das integrações em processos críticos.</p></div></header>
        <div className={styles.checkGrid}>
          {checks.map((item) => <button type="button" key={item.label} onClick={() => navigate(item.action)} className={item.ok ? styles.checkOk : styles.checkAttention}><span>{item.ok ? "✓" : "!"}</span><strong>{item.label}</strong><small>{item.ok ? "Em conformidade" : "Revisar agora"}</small></button>)}
        </div>
      </section>
      <section className={styles.grid}>
        <DedicatedArea href="/erp/pagamentos-recebimentos" title="Pagamentos e recebimentos" description="Contas adquirentes, capacidades, conciliação e roteamento por operação." />
        <DedicatedArea href="/erp/emails-transacionais" title="E-mails transacionais" description="Catálogo versionado, entregabilidade, OTP e evidências de envio." />
        <DedicatedArea href="/erp/inteligencia-artificial" title="Inteligência artificial" description="Modelos, orçamento, BYOK e consumo por funcionalidade." />
        <article className={styles.card}><header><div><h3>Atalhos operacionais</h3><p>Acesse rapidamente as áreas que exigem acompanhamento.</p></div></header><div className={styles.quickActions}><button onClick={() => navigate("operacoes")}>Abrir fila e saúde</button><button onClick={() => navigate("roteamento")}>Revisar contingências</button><button onClick={() => navigate("governanca")}>Consultar auditoria</button></div></article>
      </section>
    </>
  );
}

function Metric({ label, value, note, tone = "neutral" }: { label: string; value: string | number; note: string; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return <article className={styles[`metric_${tone}`]}><small>{label}</small><strong>{value}</strong><span>{note}</span></article>;
}

function ConnectionInventory({ providers, credentials }: { providers: Provider[]; credentials: Credential[] }) {
  const [query, setQuery] = useState(""), normalized = query.trim().toLocaleLowerCase("pt-BR"),
    rows = credentials.filter((credential) => {
      const provider = providers.find((item) => item.id === credential.providerId);
      return !normalized || `${credential.label} ${credential.ownerLabel || ""} ${provider?.label || credential.providerId}`.toLocaleLowerCase("pt-BR").includes(normalized);
    });
  return (
    <section className={styles.card}>
      <header><div><h3>Inventário de conexões</h3><p>Responsável, validade, ambiente e último diagnóstico de cada conta.</p></div><label className={styles.search}>Buscar<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Provider, conta ou responsável" /></label></header>
      {rows.length ? <div className={styles.connectionList}>{rows.map((credential) => {
        const provider = providers.find((item) => item.id === credential.providerId), expired = credential.expiresAt && new Date(credential.expiresAt) <= new Date();
        return <article key={credential.id}><div><strong>{credential.label || provider?.label || credential.providerId}</strong><span>{provider?.label || credential.providerId} · {credential.sandbox ? "Sandbox" : "Produção"}</span></div><div><small>Responsável</small><span>{credential.ownerLabel || "Não definido"}</span></div><div><small>Validade</small><span className={expired ? styles.textDanger : ""}>{credential.expiresAt ? new Date(credential.expiresAt).toLocaleDateString("pt-BR", { timeZone: tenantTimeZone() }) : "Sem vencimento"}</span></div><Status ok={credential.enabled && credential.lastTestOk === true && !expired} configured /></article>;
      })}</div> : <EmptyState title="Nenhuma conexão encontrada" text={query ? "Ajuste a busca para localizar outra conta." : "Configure um provider abaixo para começar."} />}
    </section>
  );
}

function GovernancePanel({ data }: { data: any }) {
  return (
    <div className={styles.stack}>
      <section className={styles.grid}>
        <article className={styles.card}>
          <header><div><h3>Preferências e opt-outs</h3><p>Destinos mascarados, canal e origem do bloqueio.</p></div><Link href="/api/erp/integrations/opt-outs?format=csv" prefetch={false}>Exportar CSV</Link></header>
          {data.optOuts.length ? data.optOuts.map((item: any) => <p key={item.id}><strong>{item.contactMasked}</strong> · {item.channel} · {item.source}</p>) : <EmptyState title="Nenhum opt-out" text="Não há bloqueios registrados para os canais integrados." />}
        </article>
        <article className={styles.card}>
          <header><div><h3>Trilha de auditoria</h3><p>Mudanças, testes e ações operacionais com segredos redigidos.</p></div></header>
          {data.audit.length ? data.audit.slice(0, 30).map((item: any) => <details key={item.id}><summary><strong>{item.action}</strong> · {item.targetType}/{item.targetId} · {new Date(item.createdAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</summary><pre>{JSON.stringify({ before: item.beforeData, after: item.afterData, ip: item.ip }, null, 2)}</pre></details>) : <EmptyState title="Auditoria vazia" text="As próximas alterações aparecerão aqui." />}
        </article>
      </section>
      <section className={styles.card}>
        <header><div><h3>Eventos recebidos</h3><p>Retornos deduplicados com conteúdo sensível redigido antes de chegar à interface.</p></div></header>
        {data.inbound.length ? <div className={styles.table}><table><thead><tr><th>Evento</th><th>Provider</th><th>Tópico</th><th>Status</th><th>Recebido</th><th>Erro</th></tr></thead><tbody>{data.inbound.map((item: any) => <tr key={item.id}><td><code>{item.eventId}</code></td><td>{item.providerId}</td><td>{item.topic}</td><td>{item.status}</td><td>{new Date(item.receivedAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</td><td>{item.error || "—"}</td></tr>)}</tbody></table></div> : <EmptyState title="Nenhum evento recebido" text="Callbacks externos aparecerão aqui após validação e deduplicação." />}
      </section>
    </div>
  );
}

function ConfirmDialog({ title, text, confirmLabel, busy, close, confirm }: { title: string; text: string; confirmLabel: string; busy: boolean; close: () => void; confirm: () => Promise<void> }) {
  return <ErpModal close={busy ? () => undefined : close} label={title} className={styles.modalLayer}><section className={styles.modal}><header><div><p>CONFIRMAÇÃO NECESSÁRIA</p><h2>{title}</h2></div><button type="button" onClick={close} aria-label="Fechar">×</button></header><p>{text}</p><footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void confirm()}>{busy ? "Processando…" : confirmLabel}</button></footer></section></ErpModal>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className={styles.empty}><strong>{title}</strong><span>{text}</span></div>;
}

function emptyMetrics() { return { total: 0, success: 0, failed: 0, pending: 0, dead: 0, delivery_rate: 0, processing_p95_ms: 0, provider_p95_ms: 0, top_errors: [], by_channel: [], by_hour: [] }; }
function emptyOtpMetrics() { return { sent: 0, verified: 0, conversion_rate: 0, suspected_fraud: 0, by_context: [] }; }
function formatDuration(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value || 0} ms`; }

function Heading({ title, text }: { title: string; text: string }) {
  return (
    <header className={styles.heading}>
      <h3>{title}</h3>
      <p>{text}</p>
    </header>
  );
}
function DedicatedArea({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <article className={styles.card}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      <footer>
        <Link className={styles.primary} href={href}>
          Abrir área dedicada
        </Link>
      </footer>
    </article>
  );
}
function Status({ ok, configured }: { ok?: boolean; configured?: boolean }) {
  return (
    <span
      className={`${styles.status} ${!configured ? styles.unknown : ok ? styles.ok : styles.bad}`}
    >
      {!configured ? "Não configurado" : ok ? "Operacional" : "Atenção"}
    </span>
  );
}
function contextLabel(value: string) {
  return (
    (
      {
        checkout: "Checkout",
        login: "Login",
        register: "Cadastro",
        password_reset: "Recuperar senha",
        notification: "Notificações",
        payment_link: "Link de pagamento",
        automation: "Automação",
      } as Record<string, string>
    )[value] || value
  );
}
function settingLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
