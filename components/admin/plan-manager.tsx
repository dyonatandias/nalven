"use client";
import { useEffect, useState } from "react";
import { editablePlanModules } from "@/lib/admin-plan-catalog";
import { planGrantSummary, searchText } from "@/lib/admin-plan-builder";
import { STRICT_PLAN_POLICY } from "@/lib/erp/plan-features";
import PlanResourceEditor from "./plan-resource-editor";
import styles from "./plan-manager.module.css";

type Plan = { id: string; name: string; monthlyPrice: number; annualPrice: number; seats: number; active: boolean; visibility: "public" | "private"; ownerOrganizationId: string | null; modules: unknown; updatedAt?: string; _count?: { organizations: number } };
type Catalog = { plans: Plan[]; organizations: { id: string; name: string }[] };
const empty: Plan = { id: "", name: "", monthlyPrice: 0, annualPrice: 0, seats: 1, active: true, visibility: "private", ownerOrganizationId: null, modules: [STRICT_PLAN_POLICY] };
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function validPlan(item: Plan) {
  return item && typeof item.id === "string" && typeof item.name === "string" && typeof item.active === "boolean"
    && ["public", "private"].includes(item.visibility) && (item.ownerOrganizationId === null || typeof item.ownerOrganizationId === "string")
    && typeof item.monthlyPrice === "number" && Number.isFinite(item.monthlyPrice) && typeof item.annualPrice === "number" && Number.isFinite(item.annualPrice)
    && Number.isInteger(item.seats) && item.seats > 0 && (!item.updatedAt || typeof item.updatedAt === "string")
    && (item._count === undefined || (item._count && Number.isInteger(item._count.organizations) && item._count.organizations >= 0));
}

export default function PlanManager({ initialPlanId = "", initialOrganizationId = "" }: { initialPlanId?: string; initialOrganizationId?: string } = {}) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [selected, setSelected] = useState<string>(initialPlanId);
  const [savedNotice, setSavedNotice] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Plan>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [editorRevision, setEditorRevision] = useState(0);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function select(id: string, duplicate?: Plan) {
    if (saving || (dirty && !window.confirm("Descartar as alterações não salvas deste plano?"))) return;
    setDirty(false); setSelected(id); setSavedNotice("");
    setDraft(duplicate ? { ...duplicate, id: "", name: `${duplicate.name} — cópia`.slice(0, 160), visibility: "private", ownerOrganizationId: initialOrganizationId || null, updatedAt: undefined, _count: undefined } : undefined);
    setEditorRevision(value => value + 1);
  }
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/admin/plans", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível carregar os planos.");
        const data = await response.json();
        if (!data || !Array.isArray(data.plans) || !Array.isArray(data.organizations) || !data.plans.every(validPlan) || !data.organizations.every((item: Catalog["organizations"][number]) => item && typeof item.id === "string" && typeof item.name === "string")) throw new Error("Catálogo de planos inválido.");
        if (!controller.signal.aborted) { setCatalog(data); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    }
    void load(); return () => controller.abort();
  }, [revision]);
  const plan = catalog?.plans.find(item => item.id === selected);
  const visiblePlans = catalog?.plans.filter(item => (filter === "all" || (filter === "inactive" ? !item.active : item.visibility === filter)) && searchText(`${item.name} ${item.id} ${catalog.organizations.find(org => org.id === item.ownerOrganizationId)?.name || ""}`).includes(searchText(query))) || [];
  return <div className={`management ${styles.root}`}><header><div><h1>Planos</h1><p>Organize sua oferta e configure a experiência de cada cliente. Cobranças são realizadas no sistema externo.</p></div></header>
    {error && <div role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Tentar novamente</button></div>}
    {savedNotice && <p role="status">{savedNotice}</p>}
    {!catalog ? !error && <p role="status">Carregando planos…</p> : <><section className={styles.panel} aria-label="Catálogo de planos"><div className={styles.sectionTitle}><div><h2>Catálogo</h2><p>{catalog.plans.filter(item => item.visibility === "public").length} de 3 planos públicos · {catalog.plans.filter(item => item.visibility === "private").length} exclusivos</p></div><button type="button" disabled={saving} onClick={() => select("")}>Novo plano</button></div>
      <div className={styles.filters}><label>Buscar plano<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Nome, código ou cliente" /></label><label>Exibir<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Todos os planos</option><option value="public">Públicos</option><option value="private">Exclusivos</option><option value="inactive">Indisponíveis</option></select></label><label>Plano<select disabled={saving} aria-label="Plano para gerenciar" value={selected} onChange={event => select(event.target.value)}><option value="">Novo plano exclusivo</option>{catalog.plans.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      <div className={styles.catalog}>{visiblePlans.map(item => <button type="button" key={item.id} disabled={saving} aria-pressed={selected === item.id} className={styles.planCard} onClick={() => select(item.id)}><span>{item.visibility === "public" ? "Público" : "Exclusivo"} · {item.active ? "Disponível" : "Indisponível"}</span><strong>{item.name}</strong><span>{currency.format(item.monthlyPrice)} / mês</span><small>{item.seats} usuários · {item._count?.organizations || 0} organizações</small>{item.ownerOrganizationId && <small>{catalog.organizations.find(org => org.id === item.ownerOrganizationId)?.name || "Cliente exclusivo"}</small>}</button>)}</div>
      {!catalog.plans.length && <p className={styles.empty}>Seu catálogo está vazio. Crie o primeiro plano abaixo.</p>}
      {!!catalog.plans.length && !visiblePlans.length && <p className={styles.empty}>Nenhum plano corresponde aos filtros.</p>}
    </section>
      {selected && !plan ? <p role="alert">O plano solicitado não foi encontrado. Selecione outro plano ou crie um novo.</p> : <><div className={styles.editorHeading}><span>{dirty ? "Alterações não salvas" : "Editor de plano"}</span>{plan && <button type="button" disabled={saving} onClick={() => select("", plan)}>Duplicar para outro cliente</button>}{dirty && <button type="button" disabled={saving} onClick={() => select(selected)}>Descartar alterações</button>}</div><PlanForm key={`${selected}:${plan?.updatedAt || "new"}:${editorRevision}`} plan={plan || draft || { ...empty, ownerOrganizationId: initialOrganizationId || null }} organizations={catalog.organizations} publicCount={catalog.plans.filter(item => item.visibility === "public").length} onDirty={setDirty} onBusy={setSaving} onSaved={saved => { setDirty(false); setDraft(undefined); setCatalog(current => current ? { ...current, plans: [...current.plans.filter(item => item.id !== saved.id), saved] } : current); setSavedNotice("Plano salvo e permissões das organizações vinculadas atualizadas."); setSelected(saved.id); setRevision(value => value + 1); }} /></>}
    </>}
  </div>;
}

function PlanForm({ plan, organizations, publicCount, onSaved, onDirty, onBusy }: { plan: Plan; organizations: Catalog["organizations"]; publicCount: number; onSaved: (plan: Plan) => void; onDirty: (value: boolean) => void; onBusy: (value: boolean) => void }) {
  const [value, setValue] = useState({ ...plan, modules: editablePlanModules(plan.modules) });
  const [numbers, setNumbers] = useState({ monthlyPrice: String(plan.monthlyPrice), annualPrice: String(plan.annualPrice), seats: String(plan.seats) });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const summary = planGrantSummary(value.modules);
  const dirty = JSON.stringify(value) !== JSON.stringify({ ...plan, modules: editablePlanModules(plan.modules) }) || Object.entries(numbers).some(([key, number]) => number !== String(plan[key as keyof typeof numbers]));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  return <form className={styles.editor} onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    if ((plan._count?.organizations || 0) > 0 && !window.confirm(`Aplicar estas alterações às ${plan._count?.organizations} organizações vinculadas? Recursos removidos deixam de estar acessíveis após salvar.`)) return;
    setBusy(true); onBusy(true); setError(""); setNotice("");
    try {
      const payload = { ...value, monthlyPrice: Number(numbers.monthlyPrice), annualPrice: Number(numbers.annualPrice), seats: Number(numbers.seats) };
      const response = await fetch("/api/admin/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar o plano.");
      setNotice("Plano salvo. As permissões das organizações vinculadas foram atualizadas."); onSaved({ ...payload, updatedAt: result.plan?.updatedAt || plan.updatedAt });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); onBusy(false); }
  }}>
    <div className={styles.main}>
    <section className={styles.panel}>
    <h2>{plan.id ? `Configurar ${plan.name}` : "Criar plano exclusivo"}</h2>
    <p>As alterações de recursos serão aplicadas a {plan._count?.organizations || 0} organização(ões) vinculada(s). Limites de acesso do usuário continuam valendo dentro do plano.</p>
    {plan.id && !(Array.isArray(plan.modules) && plan.modules.includes(STRICT_PLAN_POLICY)) && <p className={styles.help}>Plano legado: o editor preserva os acessos efetivos atuais. Ao salvar, as permissões passam a ser explícitas; revise a prévia antes de confirmar.</p>}
    <fieldset disabled={busy}><legend>01 · Identificação e disponibilidade</legend><div className={styles.fields}>
      <label>Código<input required value={value.id} disabled={!!plan.id} pattern="[a-z0-9][a-z0-9_-]{1,49}" maxLength={50} onChange={event => setValue({ ...value, id: event.target.value })} /></label>
      <label>Nome<input required value={value.name} maxLength={160} onChange={event => setValue({ ...value, name: event.target.value })} /></label>
      <label>Visibilidade<select value={value.visibility} onChange={event => setValue({ ...value, visibility: event.target.value as Plan["visibility"], ownerOrganizationId: event.target.value === "public" ? null : value.ownerOrganizationId })}><option value="public" disabled={publicCount >= 3 && plan.visibility !== "public"}>Público — visível no site{publicCount >= 3 && plan.visibility !== "public" ? " (limite atingido)" : ""}</option><option value="private">Exclusivo — somente este cliente</option></select></label>
      {value.visibility === "private" && <label>Cliente exclusivo<select required value={value.ownerOrganizationId || ""} onChange={event => setValue({ ...value, ownerOrganizationId: event.target.value })}><option value="">Selecione a organização</option>{organizations.map(org => <option value={org.id} key={org.id}>{org.name}</option>)}</select></label>}
      <label>Referência mensal (R$)<input required type="number" min={0} max={1000000} step="0.01" value={numbers.monthlyPrice} onChange={event => setNumbers({ ...numbers, monthlyPrice: event.target.value })} /></label>
      <label>Referência anual (R$)<input required type="number" min={0} max={1000000} step="0.01" value={numbers.annualPrice} onChange={event => setNumbers({ ...numbers, annualPrice: event.target.value })} /></label>
      <label>Limite de usuários<input required type="number" min={1} max={100000} step={1} value={numbers.seats} onChange={event => setNumbers({ ...numbers, seats: event.target.value })} /><small>Conta vínculos ativos, incluindo o proprietário. Não é possível reduzir abaixo dos acessos ativos de um cliente vinculado.</small></label>
      <label className={styles.check}><input type="checkbox" checked={value.active} onChange={event => setValue({ ...value, active: event.target.checked })} />Disponível para novas atribuições</label>
    </div></fieldset>
    </section>
    <fieldset disabled={busy} className={styles.resourceFieldset}><legend className={styles.srOnly}>Módulos, recursos e menus</legend><PlanResourceEditor modules={value.modules} onChange={modules => setValue(current => ({ ...current, modules }))} /></fieldset>
    </div>
    <aside className={`${styles.panel} ${styles.summary}`} aria-label="Resumo do plano"><span className={styles.eyebrow}>PRÉVIA DO PLANO</span><h2>{value.name || "Seu novo plano"}</h2><p>{value.visibility === "public" ? "Catálogo público" : organizations.find(org => org.id === value.ownerOrganizationId)?.name || "Selecione um cliente"}</p><strong className={styles.price}>{currency.format(Number(numbers.monthlyPrice))}<small> / mês</small></strong><p>{currency.format(Number(numbers.annualPrice))} / ano · {numbers.seats || "—"} usuários</p><dl className={styles.metrics}><div><dt>Consulta</dt><dd>{summary.read}</dd></div><div><dt>Alteração</dt><dd>{summary.write}</dd></div><div><dt>Menus</dt><dd>{summary.menus.length}</dd></div></dl><h3>Menu previsto</h3>{summary.menus.length ? <ul className={styles.menuPreview}>{summary.menus.map(([key, label]) => <li key={key}>{label}</li>)}</ul> : <p>Nenhum menu habilitado.</p>}<small>A prévia considera o plano. Perfil do usuário e licença também limitam o menu final.</small><div className={styles.impact}><strong>{plan._count?.organizations || 0} organizações afetadas</strong><p>Salvar atualiza os acessos vinculados. Os preços são referências; não geram cobrança aqui. Desativar novas atribuições não cancela contratos existentes.</p></div>{!summary.read && <p className={styles.help}>Este plano não permite consultar nenhum recurso do ERP.</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<button className="primary" disabled={busy || (!!plan.id && !dirty)}>{busy ? "Salvando…" : "Salvar plano"}</button><small>{dirty ? "Você tem alterações não salvas." : "Revise os acessos antes de salvar."}</small></aside>
  </form>;
}
