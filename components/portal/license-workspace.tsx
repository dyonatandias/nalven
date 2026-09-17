"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { licenseDate as normalizeLicenseDate, portalLicenseDiagnostic, type LicenseDate, type LicenseLimit, type LicenseResource, type PortalLicenseData } from "@/lib/billing/portal-license-data";
import styles from "./license-workspace.module.css";

const CACHE_MS = 15_000;
const PAGE_SIZE = 12;
type ResourceFilter = "all" | LicenseResource["availability"];
type Order = "name" | "status";
type CachedLicense = { data: PortalLicenseData; receivedAt: number };

export function LicenseWorkspace({ organizationId, active = true }: { organizationId: string; active?: boolean }) {
  return <LicenseWorkspaceContent key={organizationId} organizationId={organizationId} active={active} />;
}

function LicenseWorkspaceContent({ organizationId, active }: { organizationId: string; active: boolean }) {
  const [data, setData] = useState<PortalLicenseData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorStatus, setErrorStatus] = useState(0);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ResourceFilter>("all");
  const [order, setOrder] = useState<Order>("name");
  const [page, setPage] = useState(1);
  const [retryWait, setRetryWait] = useState(0);
  const request = useRef<AbortController | null>(null);
  const cache = useRef<CachedLicense | null>(null);
  const retryUntil = useRef(0);
  const activeRef = useRef(active);
  const exporting = useRef(false);

  const load = useCallback(async (force = false) => {
    if (!activeRef.current || Date.now() < retryUntil.current) return;
    if (!force && cache.current && Date.now() - cache.current.receivedAt < CACHE_MS) { setLoading(false); return; }
    if (!force && request.current && !request.current.signal.aborted) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const timer = window.setTimeout(() => controller.abort("timeout"), 20_000);
    setLoading(true); setError(""); setErrorStatus(0);
    try {
      const response = await fetch(`/api/portal/license${force ? "?refresh=1" : ""}`, { cache: "no-store", headers: { "x-organization-id": organizationId }, signal: controller.signal });
      const body: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted && controller.signal.reason === "timeout") throw new LicenseRequestError("A consulta demorou mais que o esperado.", 408);
      if (controller.signal.aborted || request.current !== controller || !activeRef.current) return;
      if (!response.ok) {
        const seconds = retrySeconds(response.headers.get("retry-after"));
        if (seconds) { retryUntil.current = Date.now() + seconds * 1000; setRetryWait(seconds); }
        throw new LicenseRequestError(isRecord(body) && typeof body.error === "string" ? body.error : "Não foi possível consultar a licença neste momento.", response.status);
      }
      if (!isLicenseData(body)) throw new LicenseRequestError("O serviço retornou uma licença em formato inesperado. Os dados anteriores foram preservados, quando disponíveis.", 502);
      cache.current = { data: body, receivedAt: Date.now() }; setData(body);
    } catch (reason) {
      if (request.current !== controller || !activeRef.current || (controller.signal.aborted && controller.signal.reason !== "timeout")) return;
      if (cache.current) cache.current.receivedAt = 0;
      if (reason instanceof LicenseRequestError) {
        setErrorStatus(reason.status);
        if ([401, 403, 404, 409].includes(reason.status)) { cache.current = null; setData(null); setNotice(""); }
      }
      setError(controller.signal.reason === "timeout" ? "A consulta demorou mais que o esperado. Verifique sua conexão e tente atualizar novamente." : reason instanceof LicenseRequestError ? reason.message : "Não foi possível consultar a licença. Verifique sua conexão e tente novamente.");
    } finally {
      clearTimeout(timer);
      if (request.current === controller) { request.current = null; if (activeRef.current) setLoading(false); }
    }
  }, [organizationId]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) { request.current?.abort(); request.current = null; return; }
    const initialLoad = window.setTimeout(() => void load(), 0);
    const refreshVisible = () => { if (document.visibilityState === "visible" && navigator.onLine) void load(); };
    window.addEventListener("focus", refreshVisible); window.addEventListener("online", refreshVisible); document.addEventListener("visibilitychange", refreshVisible);
    return () => { clearTimeout(initialLoad); activeRef.current = false; request.current?.abort(); request.current = null; window.removeEventListener("focus", refreshVisible); window.removeEventListener("online", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [active, load]);

  useEffect(() => {
    if (!retryWait) return;
    const timer = window.setInterval(() => setRetryWait(Math.max(0, Math.ceil((retryUntil.current - Date.now()) / 1000))), 500);
    return () => clearInterval(timer);
  }, [retryWait]);

  function clearFilters() { setSearch(""); setFilter("all"); setOrder("name"); setPage(1); }
  function changeFilter(next: ResourceFilter) { setFilter(next); setPage(1); }
  function exportDiagnostic() {
    if (!data?.capabilities.canExportDiagnostic || exporting.current) return;
    exporting.current = true; setNotice("");
    try {
      // Only this explicit public projection is downloadable, never the DTO.
      const blob = new Blob([JSON.stringify(portalLicenseDiagnostic(data), null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `nalven-diagnostico-licenca-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice("Diagnóstico gerado sem chaves de licença ou identificação da empresa. Revise o arquivo antes de compartilhar com o atendimento.");
    } catch { setNotice("Não foi possível gerar o diagnóstico neste navegador. Tente novamente ou informe os dados visíveis ao atendimento."); }
    finally { exporting.current = false; }
  }

  const resources = data?.license.resources || [];
  const needle = normalize(search.trim());
  const filtered = resources.filter(resource => (filter === "all" || resource.availability === filter) && (!needle || normalize(`${resource.name} ${resource.code}`).includes(needle))).sort((left, right) => order === "status" ? availabilityOrder(left.availability) - availabilityOrder(right.availability) || left.name.localeCompare(right.name, "pt-BR") : left.name.localeCompare(right.name, "pt-BR"));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const counts = resources.reduce<Record<LicenseResource["availability"], number>>((result, resource) => ({ ...result, [resource.availability]: result[resource.availability] + 1 }), { enabled: 0, disabled: 0, unknown: 0 });
  const retryLabel = retryWait ? `Aguarde ${retryWait}s` : "Tentar novamente";

  return <section className={styles.workspace} aria-label="Licença do ambiente" aria-busy={loading}>
    <header className={styles.heading}>
      <div><h2>Sua licença e seus recursos</h2><p>Consulte a situação da licença, as cotas contratadas e os módulos configurados neste ambiente.</p></div>
      <div className={styles.actions}><button className={styles.button} type="button" disabled={loading || retryWait > 0 || Boolean(data && !data.capabilities.canRefresh)} onClick={() => void load(true)}>{loading ? "Consultando…" : retryWait ? `Aguarde ${retryWait}s` : "Atualizar licença"}</button>{data?.capabilities.canExportDiagnostic && <button className={styles.primary} type="button" onClick={exportDiagnostic}>Exportar diagnóstico</button>}</div>
    </header>
    {notice && <Feedback><p>{notice}</p><button className={styles.button} type="button" onClick={() => setNotice("")} aria-label="Fechar aviso do diagnóstico">Fechar</button></Feedback>}
    {error && <Feedback tone="error"><div><p>{error}</p>{data && <p>Abaixo estão os últimos dados recebidos. Eles podem estar desatualizados.</p>}</div><button className={styles.button} disabled={loading || retryWait > 0} type="button" onClick={() => void load(true)}>{retryLabel}</button></Feedback>}
    {!data ? <div className={styles.panel}>{loading || !error ? <div className={styles.loading} role="status">Consultando a licença deste ambiente…<span /><span /><span /></div> : <Empty title={errorStatus === 404 ? "Licença ainda não disponível" : [401, 403, 409].includes(errorStatus) ? "Consulta de licença não autorizada" : "Consulta de licença indisponível"}>Não tratamos uma falha de consulta como licença ativa, vencida ou sem recursos. Confira a mensagem acima e tente novamente quando possível.</Empty>}</div> : <>
      {data.warnings.map((warning, index) => <Feedback key={`warning-${index}`} tone="warning">{warning}</Feedback>)}
      <section className={styles.summary} aria-label="Situação informada pelo serviço">
        <div><span className={styles.eyebrow}>Licença informada pelo serviço</span><h3>{data.license.plan.name || "Plano não informado"}</h3><div className={styles.statusGroup}><span className={styles.badge} data-tone={statusTone(data.license.status)}>{statusLabel(data.license.status)}</span>{data.license.status === "unknown" && data.license.statusCode && <span className={styles.badge}>Código recebido: {data.license.statusCode}</span>}</div><p>Este quadro mostra os dados recebidos do serviço de licenciamento. O acesso no sistema também depende das configurações do ambiente e das permissões do seu perfil.</p></div>
        <div><span className={styles.eyebrow}>Validação informada pelo serviço</span><p><strong>{data.license.valid === true ? "Licença validada" : data.license.valid === false ? "Licença não validada" : "Resultado de validação não informado"}</strong></p><p>Datas e status são apresentados como recebidos; esta página não calcula uma nova decisão de autorização.</p></div>
      </section>
      <dl className={styles.facts}>
        <Fact title="Válida desde" value={licenseDate(data.license.validFrom)} hint="Início de validade informado pelo serviço." />
        <Fact title="Validade até" value={licenseDate(data.license.validUntil)} hint="Uma data ausente não significa licença sem expiração." />
        <Fact title="Cota de instalações" value={limitLabel(data.license.maxInstallations)} hint="Cota contratada, não quantidade de instalações em uso." />
      </dl>
      <section className={styles.panel} aria-label="Plano do ambiente e plano da licença">
        <header className={styles.panelHeader}><div><h3>Plano e configuração do ambiente</h3><p>Os dados do ambiente e do serviço de licenciamento têm origens diferentes.</p></div><span className={styles.badge} data-tone={data.comparison.plan === "match" ? "green" : data.comparison.plan === "different" ? "amber" : undefined}>{data.comparison.plan === "match" ? "Códigos de plano correspondem" : data.comparison.plan === "different" ? "Códigos de plano divergem" : "Comparação não disponível"}</span></header>
        <div className={styles.comparison}>
          <article><h4>Plano configurado no ambiente</h4><strong>{data.applicationPlan.name || "Não informado"}</strong><p>Código remoto esperado: {data.applicationPlan.expectedRemoteCode || "Não informado"}</p></article>
          <article><h4>Plano informado pela licença</h4><strong>{data.license.plan.name || "Não informado"}</strong><p>Código recebido: {data.license.plan.code || "Não informado"}</p></article>
        </div>
        {data.comparison.plan === "different" && <div className={styles.source}><p className={styles.hint}>Os códigos informados não correspondem. Isso não prova um bloqueio nem altera seu plano. Confira a configuração com o atendimento antes de solicitar mudanças.</p></div>}
        <details className={styles.source}><summary>Módulos configurados no ambiente · {data.applicationPlan.modules.filter(module => module.enabled).length} habilitados</summary><p>Configuração local do ambiente. Módulos não são equivalentes, um a um, aos recursos e às cotas do serviço de licenciamento.</p><dl>{data.applicationPlan.modules.map(module => <div key={module.id}><dt>{module.name}</dt><dd>{module.enabled ? "Habilitado no ambiente" : "Não habilitado no ambiente"}</dd></div>)}</dl></details>
      </section>
      <section className={styles.panel} aria-label="Recursos da licença">
        <header className={styles.panelHeader}><div><h3>Recursos e cotas da licença</h3><p>Consulte também os recursos bloqueados ou sem confirmação. Cotas não representam consumo: não há medição de uso nesta consulta.</p></div></header>
        {data.license.resourcesKnown ? <>
          <div className={styles.toolbar} role="search" aria-label="Filtrar recursos da licença">
            <Field label="Buscar recurso" id="license-search"><input id="license-search" type="search" maxLength={200} value={search} placeholder="Nome ou código do recurso" onChange={event => { setSearch(event.target.value); setPage(1); }} /></Field>
            <Field label="Disponibilidade na licença" id="license-filter"><select id="license-filter" value={filter} onChange={event => changeFilter(event.target.value as ResourceFilter)}><option value="all">Todos os recursos</option><option value="enabled">Habilitados</option><option value="disabled">Bloqueados</option><option value="unknown">Sem confirmação</option></select></Field>
            <Field label="Ordenar recursos" id="license-sort"><select id="license-sort" value={order} onChange={event => { setOrder(event.target.value as Order); setPage(1); }}><option value="name">Nome do recurso</option><option value="status">Disponibilidade</option></select></Field>
          </div>
          <div className={styles.filterSummary}><p>{filtered.length} de {resources.length} recurso(s) informado(s)</p>{(search || filter !== "all") && <button className={styles.button} type="button" onClick={clearFilters}>Limpar filtros</button>}<div className={styles.counters} aria-label="Contagem dos recursos recebidos">{(["enabled", "disabled", "unknown"] as const).map(state => <button className={styles.counter} type="button" key={state} aria-pressed={filter === state} onClick={() => changeFilter(filter === state ? "all" : state)}>{availabilityLabel(state)} · {counts[state]}</button>)}</div></div>
          {visible.length ? <ul className={styles.resources} aria-label="Lista de recursos">{visible.map((resource, index) => <ResourceCard key={`${resource.code}:${index}`} resource={resource} />)}</ul> : <Empty title={resources.length ? "Nenhum recurso corresponde aos filtros" : "Nenhum recurso listado pelo serviço"}>{resources.length ? "Altere a busca ou limpe os filtros para consultar os demais recursos." : "A consulta não retornou recursos. Isso não informa, por si só, quais funcionalidades seu perfil pode acessar."}</Empty>}
          {pageCount > 1 && <footer className={styles.pager}><span>Página {currentPage} de {pageCount}</span><div><button className={styles.button} type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Página anterior</button><button className={styles.button} type="button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Próxima página</button></div></footer>}
        </> : <Empty title="Recursos não informados">O serviço não forneceu uma lista de recursos válida. Não é possível concluir que o ambiente está sem recursos ou que todos estão liberados.</Empty>}
        <details className={styles.source}><summary>Como interpretar as cotas</summary><p>Um limite numérico é a cota informada, não o uso atual. Zero significa cota zero. “Sem cota numérica” indica que não foi atribuída uma quantidade neste campo; não é uma promessa de capacidade ilimitada. “Não informado” significa que não há informação suficiente.</p></details>
      </section>
      <section className={styles.panel} aria-label="Limites adicionais da licença"><header className={styles.panelHeader}><div><h3>Limites adicionais</h3><p>Valores informados separadamente pelo serviço, sem estimativas de uso.</p></div></header>{data.license.limitsKnown ? data.license.limits.length ? <ul className={styles.resources} aria-label="Lista de limites adicionais">{data.license.limits.map((metric, index) => <li key={`${metric.code}:${index}`} className={styles.resource}><h4>{metric.name || metric.code}</h4><code>{metric.code}</code><p>{limitLabel(metric.limit, metric.unit)}</p></li>)}</ul> : <Empty title="Nenhum limite adicional listado">O serviço retornou uma lista vazia de limites adicionais.</Empty> : <Empty title="Limites adicionais não informados">Não há dados suficientes para exibir outras cotas desta licença.</Empty>}</section>
      <details className={`${styles.panel} ${styles.source}`}><summary>Origem e atualização dos dados</summary><dl><div><dt>Origem da licença</dt><dd>Serviço de licenciamento · Billing Headless</dd></div><div><dt>Consultado no serviço em</dt><dd>{dateTime(data.source.checkedAt)}</dd></div><div><dt>Resposta preparada em</dt><dd>{dateTime(data.generatedAt)}</dd></div>{data.license.graceUntil && <div><dt>Carência informada pelo serviço</dt><dd>{licenseDate(data.license.graceUntil)} · sem inferência de autorização</dd></div>}<div><dt>Modo da consulta</dt><dd>{data.source.cached ? "Consulta recente reutilizada pelo servidor" : "Consulta recebida do serviço"}</dd></div></dl><p>Ao retornar a esta área, uma consulta recebida nos últimos 15 segundos pode ser reutilizada apenas na memória desta página. “Atualizar licença” solicita uma nova consulta. Nenhum dado é salvo no armazenamento do navegador.</p></details>
    </>}
  </section>;
}

function ResourceCard({ resource }: { resource: LicenseResource }) { return <li className={styles.resource}><header><div><h4>{resource.name || resource.code}</h4><code>{resource.code}</code></div><span className={styles.badge} data-tone={resource.availability === "enabled" ? "green" : resource.availability === "disabled" ? "amber" : undefined}>{availabilityLabel(resource.availability)}</span></header><dl><div><dt>Cota informada</dt><dd>{limitLabel(resource.limit)}</dd></div><div><dt>Habilitação recebida</dt><dd>{resource.enabled === true ? "Sim" : resource.enabled === false ? "Não" : "Não informada"}</dd></div>{resource.origin && <div><dt>Origem informada</dt><dd>{resource.origin}</dd></div>}</dl>{resource.limit.kind === "finite" && resource.limit.value === 0 && <p>Este recurso tem cota zero na licença, mesmo se a habilitação recebida estiver marcada como “Sim”.</p>}</li>; }
function Fact({ title, value, hint }: { title: string; value: string; hint: string }) { return <div className={styles.fact}><dt>{title}</dt><dd>{value}</dd><p>{hint}</p></div>; }
function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) { return <div className={styles.field}><label htmlFor={id}>{label}</label>{children}</div>; }
function Feedback({ children, tone }: { children: ReactNode; tone?: "error" | "warning" }) { return <div className={`${styles.feedback} ${tone ? styles[tone] : ""}`} role={tone === "error" ? "alert" : "status"}>{children}</div>; }
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className={styles.empty}><h3>{title}</h3><p>{children}</p></div>; }
function normalize(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR"); }
function availabilityLabel(value: LicenseResource["availability"]) { return value === "enabled" ? "Habilitado" : value === "disabled" ? "Bloqueado na licença" : "Sem confirmação"; }
function availabilityOrder(value: LicenseResource["availability"]) { return value === "disabled" ? 0 : value === "unknown" ? 1 : 2; }
function statusLabel(value: PortalLicenseData["license"]["status"]) { return ({ active: "Ativa", expired: "Vencida", suspended: "Suspensa", cancelled: "Cancelada", pending: "Pendente", inactive: "Inativa", unknown: "Status não confirmado" })[value]; }
function statusTone(value: PortalLicenseData["license"]["status"]) { return value === "active" ? "green" : ["expired", "suspended", "cancelled", "inactive"].includes(value) ? "red" : value === "pending" ? "amber" : undefined; }
function limitLabel(limit: LicenseLimit, unit?: string | null) { return limit.kind === "finite" && typeof limit.value === "number" && Number.isFinite(limit.value) ? `${limit.value.toLocaleString("pt-BR")}${unit ? ` ${unit}` : ""}` : limit.kind === "no_quota" ? "Sem cota numérica" : "Não informado"; }
function licenseDate(value: LicenseDate) {
  if (value.kind !== "date" || !value.value) return value.kind === "not_defined" ? "Data não definida pelo serviço" : "Não informada";
  const dateOnly = value.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const naive = value.value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  return naive ? `${naive[3]}/${naive[2]}/${naive[1]} ${naive[4]} (fuso não informado)` : dateTime(value.value);
}
function dateTime(value: string) { return Number.isFinite(Date.parse(value)) ? `${new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone(), dateStyle: "short", timeStyle: "short" })} (Brasília)` : "Não informada"; }
function retrySeconds(value: string | null) { if (!value) return 0; const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000); return Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function nullableText(value: unknown) { return value === null || typeof value === "string"; }
function isLimit(value: unknown) { return isRecord(value) && typeof value.kind === "string" && (value.kind === "finite" ? typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0 && value.value <= Number.MAX_SAFE_INTEGER : ["no_quota", "unknown"].includes(value.kind) && value.value === null); }
function isDate(value: unknown) { return isRecord(value) && typeof value.kind === "string" && (value.kind === "date" ? typeof value.value === "string" && value.value.length <= 64 && normalizeLicenseDate(value.value).kind === "date" : ["not_defined", "unknown"].includes(value.kind) && value.value === null); }
function isLicenseData(value: unknown): value is PortalLicenseData {
  if (!isRecord(value) || !isRecord(value.license) || !isRecord(value.applicationPlan) || !isRecord(value.source) || !isRecord(value.capabilities) || !isRecord(value.comparison)) return false;
  const license = value.license, plan = value.applicationPlan;
  return typeof license.status === "string" && ["active", "expired", "suspended", "cancelled", "pending", "inactive", "unknown"].includes(license.status) && nullableText(license.statusCode) && (license.valid === null || typeof license.valid === "boolean")
    && isDate(license.validFrom) && isDate(license.validUntil) && (license.graceUntil === undefined || isDate(license.graceUntil)) && isLimit(license.maxInstallations) && isRecord(license.plan) && nullableText(license.plan.name) && nullableText(license.plan.code)
    && typeof license.resourcesKnown === "boolean" && Array.isArray(license.resources) && license.resources.length <= 2000 && license.resources.every(resource => isRecord(resource) && typeof resource.code === "string" && typeof resource.name === "string" && (resource.enabled === null || typeof resource.enabled === "boolean") && typeof resource.availability === "string" && ["enabled", "disabled", "unknown"].includes(resource.availability) && isLimit(resource.limit) && nullableText(resource.origin))
    && typeof license.limitsKnown === "boolean" && Array.isArray(license.limits) && license.limits.length <= 2000 && license.limits.every(metric => isRecord(metric) && typeof metric.code === "string" && typeof metric.name === "string" && isLimit(metric.limit) && nullableText(metric.unit))
    && typeof plan.id === "string" && typeof plan.name === "string" && nullableText(plan.expectedRemoteCode) && Array.isArray(plan.modules) && plan.modules.every(module => isRecord(module) && typeof module.id === "string" && typeof module.name === "string" && typeof module.enabled === "boolean")
    && typeof value.comparison.plan === "string" && ["match", "different", "unknown"].includes(value.comparison.plan) && value.source.name === "billing_headless" && typeof value.source.checkedAt === "string" && typeof value.source.cached === "boolean"
    && typeof value.capabilities.canRefresh === "boolean" && typeof value.capabilities.canExportDiagnostic === "boolean" && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === "string") && typeof value.generatedAt === "string";
}
class LicenseRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
