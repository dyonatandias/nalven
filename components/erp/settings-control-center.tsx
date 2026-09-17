"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import { BRAZIL_TIME_ZONES } from "@/lib/timezone";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { MediaPicker, type MediaAsset } from "./media-library";
import { ErpModal } from "./modal-portal";
import styles from "./settings-control-center.module.css";

type Settings = {
  id: number;
  organizationName: string;
  tradeName: string | null;
  locale: string;
  currency: string;
  timezone: string;
  defaultPaymentMethod: string;
  defaultCustomerName: string;
  requireCustomer: boolean;
  lowStockAlerts: boolean;
  operationalEmail: string | null;
  dailySummary: boolean;
  notifyLowStock: boolean;
  auditRetentionDays: number;
  logoMediaId: string | null;
  logoMedia: MediaAsset | null;
  accentColor: string;
  interfaceDensity: "comfortable" | "compact";
  defaultSidebarMode: "expanded" | "compact";
  operationalPhone: string | null;
  autoGenerateSku: boolean;
  allowNegativeStock: boolean;
  quoteValidityDays: number;
  maxDiscountPercent: number;
  posCloseToleranceCents: number;
  dailySummaryTime: string;
  notifyOverdueTitles: boolean;
  notifyNewSales: boolean;
  quoteFooter: string | null;
  receiptFooter: string | null;
  termsAndConditions: string | null;
  dataProtectionEmail: string | null;
  version: number;
  updatedAt: string;
};
type Draft = Omit<
  Settings,
  "id" | "logoMedia" | "version" | "updatedAt"
>;
type ReadinessItem = {
  id: string;
  label: string;
  detail: string;
  state: "ready" | "attention" | "blocked";
  href: string;
};
type HistoryItem = {
  id: string;
  action: string;
  version: number | null;
  actor: string;
  correlationId: string | null;
  changedFields: Array<{ field: string; label: string }>;
  createdAt: string;
};
type SettingsData = {
  generatedAt: string;
  settings: Settings;
  permissions: { canWrite: boolean };
  readiness: {
    score: number;
    state: "ready" | "attention" | "blocked";
    ready: number;
    attention: number;
    blocked: number;
    items: ReadinessItem[];
  };
  summary: {
    activeBranches: number;
    activeProfiles: number;
    activeIntegrations: number;
    healthyIntegrations: number;
    recentChanges: number;
    reportSettingsConfigured: boolean;
  };
  history: HistoryItem[];
};
type Tab =
  | "overview"
  | "identity"
  | "operations"
  | "notifications"
  | "documents"
  | "governance";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Visão geral" },
  { id: "identity", label: "Empresa e aparência" },
  { id: "operations", label: "Vendas e estoque" },
  { id: "notifications", label: "Notificações" },
  { id: "documents", label: "Documentos" },
  { id: "governance", label: "Governança" },
];
const IMPACTS = [
  { title: "Identidade", detail: "Cabeçalho, comprovantes, documentos e comunicação", tab: "identity" as Tab },
  { title: "Comercial", detail: "Orçamentos, descontos e identificação do cliente", tab: "operations" as Tab },
  { title: "Estoque", detail: "SKU, saldo negativo e alertas operacionais", tab: "operations" as Tab },
  { title: "Comunicação", detail: "Destinatário, agenda e eventos autorizados", tab: "notifications" as Tab },
  { title: "Governança", detail: "Retenção, LGPD, concorrência e rastreabilidade", tab: "governance" as Tab },
];

export function SettingsControlCenter() {
  const router = useRouter();
  const [data, setData] = useState<SettingsData>();
  const [draft, setDraft] = useState<Draft>();
  const [logo, setLogo] = useState<MediaAsset | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<HistoryItem>();
  const [confirmation, setConfirmation] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/erp/settings", { cache: "no-store" });
      const body = (await response.json()) as SettingsData & { error?: string };
      if (!response.ok)
        throw new Error(body.error || "Não foi possível carregar as configurações.");
      setData(body);
      setDraft(toDraft(body.settings));
      setLogo(body.settings.logoMedia || null);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível carregar as configurações.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const dirty = useMemo(
    () => Boolean(data && draft && stable(draft) !== stable(toDraft(data.settings))),
    [data, draft],
  );

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setNotice("");
  }

  async function save(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!draft || !data || !data.permissions.canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/erp/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, version: data.settings.version }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error || "Não foi possível salvar as configurações.");
      await load();
      router.refresh();
      setNotice("Configurações salvas, aplicadas e registradas na auditoria.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível salvar as configurações.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!restoreTarget || !data || confirmation !== "RESTAURAR") return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "restore",
          eventId: restoreTarget.id,
          version: data.settings.version,
          confirmation,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error || "Não foi possível restaurar a versão.");
      setRestoreTarget(undefined);
      setConfirmation("");
      await load();
      router.refresh();
      setNotice("Versão histórica restaurada como uma nova revisão auditável.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível restaurar a versão.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data)
    return <div className={styles.loading}>Carregando central de configurações…</div>;
  if (!data || !draft)
    return (
      <section className={styles.error} role="alert">
        <strong>Não foi possível abrir a central</strong>
        <span>{error || "A configuração não está disponível."}</span>
        <button type="button" onClick={() => void load()}>Tentar novamente</button>
      </section>
    );

  const canWrite = data.permissions.canWrite;
  const notificationEvents = [
    draft.dailySummary,
    draft.notifyLowStock,
    draft.notifyOverdueTitles,
    draft.notifyNewSales,
  ].filter(Boolean).length;

  return (
    <div className={styles.root}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Governança da organização</p>
          <h2>Central de configurações</h2>
          <p className={styles.heroDescription}>
            Controle identidade, experiência, regras comerciais, alertas,
            documentos e políticas de dados com impacto visível e histórico
            versionado.
          </p>
        </div>
        <div className={styles.heroActions}>
          <button type="button" onClick={() => void load()} disabled={busy || loading}>
            Atualizar diagnóstico
          </button>
          <details className={styles.actionMenu}>
            <summary>Ações</summary>
            <div>
              <a href="/api/erp/settings?format=json" download>Exportar configuração</a>
              <Link href="/erp/atividades-auditoria">Abrir auditoria</Link>
              <Link href="/erp/empresas-filiais">Configurar filiais</Link>
              <button
                type="button"
                disabled={!dirty}
                onClick={() => {
                  setDraft(toDraft(data.settings));
                  setLogo(data.settings.logoMedia || null);
                  setNotice("Alterações locais descartadas.");
                }}
              >
                Descartar alterações
              </button>
            </div>
          </details>
        </div>
      </section>

      <div className={styles.liveRegion} aria-live="polite">
        {notice && <div className={styles.notice}>{notice}</div>}
        {error && <div className={styles.error}>{error}</div>}
        {!canWrite && (
          <div className={styles.info}>
            Seu acesso é somente leitura. Solicite a permissão de configurações
            a um administrador para alterar políticas.
          </div>
        )}
      </div>

      <nav className={styles.tabs} aria-label="Áreas das configurações">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? styles.activeTab : undefined}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <form onSubmit={(event) => void save(event)}>
        {tab === "overview" && (
          <div className={styles.stack}>
            <section className={styles.readiness} data-state={data.readiness.state}>
              <div>
                <p className={styles.eyebrow}>Prontidão operacional</p>
                <h3>{readinessTitle(data.readiness.state)}</h3>
                <p>
                  {data.readiness.ready} áreas prontas, {data.readiness.attention} em
                  atenção e {data.readiness.blocked} bloqueadas.
                </p>
              </div>
              <div className={styles.score} aria-label={`${data.readiness.score}% de prontidão`}>
                <strong>{data.readiness.score}%</strong>
                <span>configurado</span>
              </div>
            </section>

            <section className={styles.metrics} aria-label="Resumo administrativo">
              <Metric label="Versão ativa" value={`v${data.settings.version}`} detail={dateTime(data.settings.updatedAt)} />
              <Metric label="Filiais ativas" value={String(data.summary.activeBranches)} detail="Escopo operacional" />
              <Metric label="Usuários ativos" value={String(data.summary.activeProfiles)} detail="Perfis vigentes" />
              <Metric label="Integrações" value={`${data.summary.healthyIntegrations}/${data.summary.activeIntegrations}`} detail="Homologadas / ativas" />
              <Metric label="Alterações · 30 dias" value={String(data.summary.recentChanges)} detail="Eventos auditáveis" />
            </section>

            <SectionHeading title="Mapa de prontidão" detail="Cada diagnóstico leva diretamente à central responsável pela correção." />
            <section className={styles.readinessGrid}>
              {data.readiness.items.map((item) => (
                <Link href={item.href} key={item.id} data-state={item.state}>
                  <span className={styles.statusDot} aria-hidden="true" />
                  <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                  <b>{stateLabel(item.state)}</b>
                </Link>
              ))}
            </section>

            <SectionHeading title="Onde estas políticas são aplicadas" detail="Visão rápida do alcance de cada grupo de preferências." />
            <section className={styles.impactGrid}>
              {IMPACTS.map((item) => (
                <button type="button" key={item.title} onClick={() => setTab(item.tab)}>
                  <strong>{item.title}</strong><span>{item.detail}</span><b>Revisar →</b>
                </button>
              ))}
            </section>
          </div>
        )}

        <fieldset className={styles.editor} disabled={!canWrite || busy}>
          {tab === "identity" && (
            <div className={styles.twoColumns}>
              <section className={styles.card}>
                <CardHeader index="01" title="Identidade e localização" detail="Informações compartilhadas pelas telas, documentos e rotinas da organização." />
                <div className={styles.fields}>
                  <Field label="Nome da organização" wide>
                    <input value={draft.organizationName} maxLength={160} required onChange={(event) => update("organizationName", event.target.value)} />
                  </Field>
                  <Field label="Nome fantasia">
                    <input value={draft.tradeName || ""} maxLength={160} onChange={(event) => update("tradeName", event.target.value || null)} />
                  </Field>
                  <Field label="Telefone operacional">
                    <input value={draft.operationalPhone || ""} maxLength={30} inputMode="tel" placeholder="(49) 3333-0000" onChange={(event) => update("operationalPhone", event.target.value || null)} />
                  </Field>
                  <Field label="Idioma">
                    <input value="Português (Brasil)" disabled />
                  </Field>
                  <Field label="Moeda">
                    <input value="Real brasileiro (BRL)" disabled />
                  </Field>
                  <Field label="Fuso padrão da organização" wide>
                    <select value={draft.timezone} onChange={(event) => update("timezone", event.target.value)}>
                      {BRAZIL_TIME_ZONES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <small>Usado por notificações e rotinas gerais. Cada filial pode definir o próprio fuso operacional.</small>
                  </Field>
                  <div className={styles.wide}>
                    <MediaPicker
                      value={logo}
                      onChange={(asset) => {
                        setLogo(asset);
                        update("logoMediaId", asset?.id || null);
                      }}
                      acceptKind="image"
                      label="Logotipo da organização"
                    />
                  </div>
                </div>
              </section>
              <section className={styles.card}>
                <CardHeader index="02" title="Aparência e navegação" detail="Preferências aplicadas ao shell do ERP após salvar e atualizar a página." />
                <div className={styles.fields}>
                  <fieldset className={styles.colorControl}>
                    <legend>Cor principal</legend>
                    <div className={styles.colorField}>
                      <input aria-label="Selecionar cor principal" type="color" value={draft.accentColor} onChange={(event) => update("accentColor", event.target.value)} />
                      <input aria-label="Código hexadecimal da cor principal" value={draft.accentColor} pattern="#[0-9a-fA-F]{6}" maxLength={7} onChange={(event) => update("accentColor", event.target.value)} />
                    </div>
                  </fieldset>
                  <Field label="Densidade da interface">
                    <select value={draft.interfaceDensity} onChange={(event) => update("interfaceDensity", event.target.value as Draft["interfaceDensity"])}>
                      <option value="comfortable">Confortável</option><option value="compact">Compacta</option>
                    </select>
                  </Field>
                  <Field label="Menu lateral padrão" wide>
                    <select value={draft.defaultSidebarMode} onChange={(event) => update("defaultSidebarMode", event.target.value as Draft["defaultSidebarMode"])}>
                      <option value="expanded">Expandido</option><option value="compact">Compacto</option>
                    </select>
                  </Field>
                </div>
                <BrandPreview draft={draft} logo={logo} />
              </section>
            </div>
          )}

          {tab === "operations" && (
            <div className={styles.twoColumns}>
              <section className={styles.card}>
                <CardHeader index="01" title="Política comercial" detail="Limites consumidos pelo backend de orçamentos, pedidos e PDV." />
                <div className={styles.fields}>
                  <Field label="Pagamento padrão">
                    <select value={draft.defaultPaymentMethod} onChange={(event) => update("defaultPaymentMethod", event.target.value)}>
                      {['Pix', 'Dinheiro', 'Cartão', 'Boleto'].map((item) => <option key={item}>{item}</option>)}
                    </select>
                  </Field>
                  <Field label="Cliente padrão">
                    <input value={draft.defaultCustomerName} maxLength={160} required onChange={(event) => update("defaultCustomerName", event.target.value)} />
                  </Field>
                  <Field label="Validade do orçamento (dias)">
                    <input type="number" min={1} max={180} value={draft.quoteValidityDays} onChange={(event) => update("quoteValidityDays", Number(event.target.value))} />
                  </Field>
                  <Field label="Desconto máximo (%)">
                    <input type="number" min={0} max={100} step="0.01" value={draft.maxDiscountPercent} onChange={(event) => update("maxDiscountPercent", Number(event.target.value))} />
                  </Field>
                  <Field label="Tolerância de fechamento (centavos)" hint="Acima deste total absoluto, o caixa exige aprovação independente." wide>
                    <input type="number" min={0} max={1_000_000_000} step={1} value={draft.posCloseToleranceCents} onChange={(event) => update("posCloseToleranceCents", Number(event.target.value))} />
                  </Field>
                  <Toggle checked={draft.requireCustomer} title="Exigir identificação do cliente" detail="Impede concluir a venda sem um cliente informado." onChange={(value) => update("requireCustomer", value)} />
                </div>
              </section>
              <section className={styles.card}>
                <CardHeader index="02" title="Política de catálogo e estoque" detail="Regras transacionais usadas ao cadastrar itens e movimentar saldos." />
                <div className={styles.toggleStack}>
                  <Toggle checked={draft.lowStockAlerts} title="Exibir alertas de estoque baixo" detail="Destaca itens que atingiram o saldo mínimo configurado." onChange={(value) => update("lowStockAlerts", value)} />
                  <Toggle checked={draft.autoGenerateSku} title="Gerar SKU automaticamente" detail="Cria um código seguro quando o cadastro não fornecer SKU." onChange={(value) => update("autoGenerateSku", value)} />
                  <Toggle danger checked={draft.allowNegativeStock} title="Permitir estoque negativo" detail="Autoriza saídas mesmo sem saldo. Use apenas com processo de acerto definido." onChange={(value) => update("allowNegativeStock", value)} />
                </div>
                {draft.allowNegativeStock && <div className={styles.warning}>Estoque negativo está permitido. Pedidos podem consumir itens sem disponibilidade e exigem conciliação operacional.</div>}
                <div className={styles.quickLinks}>
                  <Link href="/erp/configuracoes-pdv">Políticas avançadas do PDV</Link>
                  <Link href="/erp/empresas-filiais">Regras por filial</Link>
                  <Link href="/erp/inventario-depositos">Depósitos e inventário</Link>
                </div>
              </section>
            </div>
          )}

          {tab === "notifications" && (
            <div className={styles.twoColumns}>
              <section className={styles.card}>
                <CardHeader index="01" title="Destino e agenda" detail="Defina o canal operacional e a janela usada pelas rotinas autorizadas." />
                <div className={styles.fields}>
                  <Field label="E-mail operacional" hint="Não é uma credencial; o envio depende de uma conta SMTP homologada." wide>
                    <input type="email" maxLength={254} value={draft.operationalEmail || ""} placeholder="operacao@empresa.com.br" onChange={(event) => update("operationalEmail", event.target.value || null)} />
                  </Field>
                  <Field label="Horário do resumo diário">
                    <input type="time" value={draft.dailySummaryTime} onChange={(event) => update("dailySummaryTime", event.target.value)} />
                  </Field>
                  <Field label="Fuso da agenda">
                    <input value={draft.timezone} disabled />
                  </Field>
                </div>
                <div className={styles.deliveryStatus} data-ready={Boolean(draft.operationalEmail && notificationEvents)}>
                  <strong>{notificationEvents} eventos autorizados</strong>
                  <span>{draft.operationalEmail ? `Destino: ${draft.operationalEmail}` : "Defina um destinatário para liberar o fluxo."}</span>
                </div>
              </section>
              <section className={styles.card}>
                <CardHeader index="02" title="Eventos operacionais" detail="A habilitação autoriza o evento; a entrega depende do canal transacional." />
                <div className={styles.toggleStack}>
                  <Toggle checked={draft.dailySummary} title="Resumo diário" detail={`Consolidado operacional previsto para ${draft.dailySummaryTime}.`} onChange={(value) => update("dailySummary", value)} />
                  <Toggle checked={draft.notifyLowStock} title="Estoque abaixo do mínimo" detail="Sinaliza itens que precisam de reposição." onChange={(value) => update("notifyLowStock", value)} />
                  <Toggle checked={draft.notifyOverdueTitles} title="Títulos vencidos" detail="Inclui pendências do contas a pagar e receber." onChange={(value) => update("notifyOverdueTitles", value)} />
                  <Toggle checked={draft.notifyNewSales} title="Novas vendas" detail="Autoriza aviso a cada venda concluída." onChange={(value) => update("notifyNewSales", value)} />
                </div>
                <div className={styles.quickLinks}>
                  <Link href="/erp/emails-transacionais">Configurar SMTP e templates</Link>
                  <Link href="/erp/automacoes">Revisar automações</Link>
                </div>
              </section>
            </div>
          )}

          {tab === "documents" && (
            <div className={styles.twoColumns}>
              <section className={styles.card}>
                <CardHeader index="01" title="Textos padronizados" detail="Conteúdo aplicado em propostas, comprovantes e condições comerciais." />
                <div className={styles.fields}>
                  <TextAreaField label="Rodapé dos orçamentos" value={draft.quoteFooter || ""} maximum={1000} onChange={(value) => update("quoteFooter", value || null)} />
                  <TextAreaField label="Rodapé dos comprovantes" value={draft.receiptFooter || ""} maximum={1000} onChange={(value) => update("receiptFooter", value || null)} />
                  <TextAreaField label="Termos e condições" value={draft.termsAndConditions || ""} maximum={5000} rows={8} onChange={(value) => update("termsAndConditions", value || null)} />
                </div>
              </section>
              <section className={styles.card}>
                <CardHeader index="02" title="Prévia do documento" detail="Simulação visual; dados fiscais e numeração são definidos por filial." />
                <DocumentPreview draft={draft} />
                <div className={styles.quickLinks}>
                  <Link href="/erp/orcamentos-pedidos">Abrir orçamentos</Link>
                  <Link href="/erp/central-fiscal">Configuração fiscal</Link>
                  <Link href="/erp/biblioteca">Biblioteca de arquivos</Link>
                </div>
              </section>
            </div>
          )}

          {tab === "governance" && (
            <div className={styles.twoColumns}>
              <section className={styles.card}>
                <CardHeader index="01" title="Segurança e dados" detail="Política organizacional de retenção e canal formal de privacidade." />
                <div className={styles.fields}>
                  <Field label="Retenção da auditoria (dias)" hint="Entre 1 e 10 anos. Salvar esta política não apaga eventos existentes." wide>
                    <input type="number" min={365} max={3650} value={draft.auditRetentionDays} onChange={(event) => update("auditRetentionDays", Number(event.target.value))} />
                  </Field>
                  <Field label="E-mail do encarregado de dados (LGPD)" wide>
                    <input type="email" maxLength={254} value={draft.dataProtectionEmail || ""} placeholder="privacidade@empresa.com.br" onChange={(event) => update("dataProtectionEmail", event.target.value || null)} />
                  </Field>
                </div>
                <div className={styles.securityNote}>
                  <strong>Credenciais ficam fora desta tela</strong>
                  <p>Segredos usam o cofre cifrado da central de integrações. A exportação contém apenas preferências não secretas.</p>
                </div>
                <div className={styles.quickLinks}>
                  <Link href="/erp/privacidade-lgpd">Programa LGPD</Link>
                  <Link href="/erp/usuarios">Papéis e acessos</Link>
                  <Link href="/erp/integracoes">Cofre de integrações</Link>
                </div>
              </section>
              <section className={styles.card}>
                <CardHeader index="02" title="Histórico de versões" detail="Restaure uma revisão anterior sem apagar a trilha existente." />
                <div className={styles.historyList}>
                  {data.history.length ? data.history.map((item) => (
                    <article key={item.id}>
                      <div>
                        <strong>{item.action === "tenant_settings.restored" ? "Versão restaurada" : "Configuração atualizada"}</strong>
                        <span>{item.actor} · {dateTime(item.createdAt)}</span>
                        <small>{item.changedFields.length ? item.changedFields.slice(0, 4).map((field) => field.label).join(" · ") : "Revisão registrada"}{item.changedFields.length > 4 ? ` +${item.changedFields.length - 4}` : ""}</small>
                      </div>
                      <button type="button" disabled={!canWrite || item.version === data.settings.version} onClick={() => setRestoreTarget(item)}>
                        Restaurar
                      </button>
                    </article>
                  )) : <p className={styles.empty}>Nenhuma alteração versionada foi registrada.</p>}
                </div>
              </section>
            </div>
          )}
        </fieldset>

        {tab !== "overview" && (
          <footer className={styles.saveBar}>
            <div>
              <strong>{dirty ? "Alterações ainda não salvas" : `Versão ${data.settings.version} sincronizada`}</strong>
              <small>{dirty ? "Revise os campos e publique uma nova versão." : `Última atualização em ${dateTime(data.settings.updatedAt)}.`}</small>
            </div>
            <div>
              <button type="button" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(data.settings)); setLogo(data.settings.logoMedia || null); }}>Descartar</button>
              <button className={styles.primary} type="submit" disabled={!dirty || !canWrite || busy}>{busy ? "Salvando…" : "Salvar e aplicar"}</button>
            </div>
          </footer>
        )}
      </form>

      {restoreTarget && (
        <ErpModal
          label="Restaurar versão histórica"
          close={() => { if (!busy) { setRestoreTarget(undefined); setConfirmation(""); } }}
          className={styles.modalLayer}
        >
          <section className={styles.modal}>
            <header>
              <div><span>CONTROLE DE VERSÃO</span><h2>Restaurar configuração</h2><p>A revisão selecionada será aplicada como uma nova versão. O histórico atual será preservado.</p></div>
              <button type="button" aria-label="Fechar" disabled={busy} onClick={() => { setRestoreTarget(undefined); setConfirmation(""); }}>×</button>
            </header>
            <div className={styles.restoreSummary}>
              <strong>Revisão de {dateTime(restoreTarget.createdAt)}</strong>
              <span>{restoreTarget.actor} · {restoreTarget.changedFields.length} campos alterados</span>
            </div>
            <label>
              <span>Digite RESTAURAR para confirmar</span>
              <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} />
            </label>
            <footer>
              <button type="button" disabled={busy} onClick={() => { setRestoreTarget(undefined); setConfirmation(""); }}>Cancelar</button>
              <button className={styles.danger} type="button" disabled={busy || confirmation !== "RESTAURAR"} onClick={() => void restore()}>{busy ? "Restaurando…" : "Restaurar como nova versão"}</button>
            </footer>
          </section>
        </ErpModal>
      )}
    </div>
  );
}

function CardHeader({ index, title, detail }: { index: string; title: string; detail: string }) {
  return <header className={styles.cardHeader}><i>{index}</i><div><h3>{title}</h3><p>{detail}</p></div></header>;
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return <header className={styles.sectionHeading}><div><h3>{title}</h3><p>{detail}</p></div></header>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={wide ? styles.wide : undefined}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Toggle({ checked, title, detail, danger, onChange }: { checked: boolean; title: string; detail: string; danger?: boolean; onChange: (value: boolean) => void }) {
  return <label className={styles.toggle} data-danger={danger || undefined}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true" /><div><strong>{title}</strong><small>{detail}</small></div></label>;
}

function TextAreaField({ label, value, maximum, rows = 4, onChange }: { label: string; value: string; maximum: number; rows?: number; onChange: (value: string) => void }) {
  return <label className={styles.wide}><span>{label}<small>{value.length}/{maximum}</small></span><textarea value={value} maxLength={maximum} rows={rows} onChange={(event) => onChange(event.target.value)} /></label>;
}

function BrandPreview({ draft, logo }: { draft: Draft; logo: MediaAsset | null }) {
  const initials = (draft.tradeName || draft.organizationName).split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <div className={styles.brandPreview} style={{ "--preview-accent": draft.accentColor } as React.CSSProperties}><aside>{logo ? <span className={styles.previewLogo} style={{ backgroundImage: `url(${JSON.stringify(logo.url).slice(1, -1)})` }} /> : <span>{initials}</span>}<i /><i /><i /></aside><div className={styles.previewContent}><span>Prévia da navegação</span><strong>{draft.tradeName || draft.organizationName}</strong><p>Exemplo de conteúdo com densidade {draft.interfaceDensity === "compact" ? "compacta" : "confortável"}.</p><button type="button">Ação principal</button></div></div>;
}

function DocumentPreview({ draft }: { draft: Draft }) {
  return <div className={styles.documentPreview}><header><div><small>ORÇAMENTO</small><strong>{draft.tradeName || draft.organizationName}</strong></div><b>R$ 1.249,90</b></header><div><span>Cliente</span><strong>{draft.defaultCustomerName}</strong></div><div className={styles.fakeLines}><i /><i /><i /></div>{draft.termsAndConditions && <p>{draft.termsAndConditions}</p>}<footer>{draft.quoteFooter || "Rodapé do orçamento ainda não definido."}</footer></div>;
}

function toDraft(settings: Settings): Draft {
  return {
    organizationName: settings.organizationName,
    tradeName: settings.tradeName,
    locale: settings.locale,
    currency: settings.currency,
    timezone: settings.timezone,
    defaultPaymentMethod: settings.defaultPaymentMethod,
    defaultCustomerName: settings.defaultCustomerName,
    requireCustomer: settings.requireCustomer,
    lowStockAlerts: settings.lowStockAlerts,
    operationalEmail: settings.operationalEmail,
    dailySummary: settings.dailySummary,
    notifyLowStock: settings.notifyLowStock,
    auditRetentionDays: settings.auditRetentionDays,
    logoMediaId: settings.logoMediaId,
    accentColor: settings.accentColor,
    interfaceDensity: settings.interfaceDensity,
    defaultSidebarMode: settings.defaultSidebarMode,
    operationalPhone: settings.operationalPhone,
    autoGenerateSku: settings.autoGenerateSku,
    allowNegativeStock: settings.allowNegativeStock,
    quoteValidityDays: settings.quoteValidityDays,
    maxDiscountPercent: settings.maxDiscountPercent,
    posCloseToleranceCents: settings.posCloseToleranceCents,
    dailySummaryTime: settings.dailySummaryTime,
    notifyOverdueTitles: settings.notifyOverdueTitles,
    notifyNewSales: settings.notifyNewSales,
    quoteFooter: settings.quoteFooter,
    receiptFooter: settings.receiptFooter,
    termsAndConditions: settings.termsAndConditions,
    dataProtectionEmail: settings.dataProtectionEmail,
  };
}

function stable(value: unknown) { return JSON.stringify(value); }
function stateLabel(value: ReadinessItem["state"]) { return value === "ready" ? "Pronto" : value === "blocked" ? "Bloqueado" : "Atenção"; }
function readinessTitle(value: SettingsData["readiness"]["state"]) { return value === "ready" ? "Organização pronta para operar" : value === "blocked" ? "Há bloqueios que exigem ação" : "Configuração funcional com pontos de atenção"; }
function dateTime(value: string) { return tenantDateTimeFormatter({ dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
