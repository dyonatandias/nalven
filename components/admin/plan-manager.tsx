"use client";
import { useEffect, useState } from "react";
import styles from "./plan-manager.module.css";

type Plan = { id: string; code: string | null; name: string; monthlyPrice: number; cardMonthlyPrice: number | null; annualPrice: number; seats: number; active: boolean; billingModules: unknown; lastSyncedAt: string | null; _count?: { organizations: number } };
type Catalog = { plans: Plan[] };
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function validPlan(item: Plan) {
  return item && typeof item.id === "string" && typeof item.name === "string" && typeof item.active === "boolean"
    && typeof item.monthlyPrice === "number" && Number.isFinite(item.monthlyPrice) && typeof item.annualPrice === "number" && Number.isFinite(item.annualPrice)
    && Number.isInteger(item.seats) && item.seats > 0;
}

export default function PlanManager({ initialPlanId = "" }: { initialPlanId?: string } = {}) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/admin/plans", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível carregar os planos.");
        const data = await response.json();
        if (!data || !Array.isArray(data.plans) || !data.plans.every(validPlan)) throw new Error("Catálogo de planos inválido.");
        if (!controller.signal.aborted) { setCatalog(data); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    }
    void load(); return () => controller.abort();
  }, [revision]);
  async function syncCatalog() {
    setSyncing(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/admin/billing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "catalog_sync" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível sincronizar o catálogo com o Billing.");
      setNotice("Catálogo sincronizado com o Billing.");
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setSyncing(false); }
  }
  return <div className={`management ${styles.root}`}>
    <header><div><h1>Planos</h1><p>O catálogo (código, nome, preço e módulos) vem do Billing Expresso. NALVEN não cria nem edita planos — atribuições e condições comerciais individuais são feitas no Billing.</p></div>
      <button type="button" disabled={syncing} onClick={syncCatalog}>{syncing ? "Sincronizando…" : "Sincronizar catálogo"}</button>
    </header>
    {error && <div role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Tentar novamente</button></div>}
    {notice && <p role="status">{notice}</p>}
    {!catalog ? !error && <p role="status">Carregando planos…</p> : <section className={styles.panel} aria-label="Catálogo de planos">
      <div className={styles.catalog}>{catalog.plans.map(item => <article key={item.id} className={`${styles.planCard} ${item.id === initialPlanId ? styles.planCardHighlight : ""}`}>
        <span>{item.code ? `Código ${item.code}` : "Sem código Billing — precisa de revisão manual"} · {item.active ? "Disponível" : "Indisponível"}</span>
        <strong>{item.name}</strong>
        <span>{currency.format(item.monthlyPrice)} / mês{item.cardMonthlyPrice ? ` (${currency.format(item.cardMonthlyPrice)} no cartão)` : ""}</span>
        <small>{item.seats} usuários · {item._count?.organizations || 0} organizações</small>
        {item.lastSyncedAt && <small>Sincronizado em {new Date(item.lastSyncedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</small>}
      </article>)}</div>
      {!catalog.plans.length && <p className={styles.empty}>Nenhum plano sincronizado ainda. Use &ldquo;Sincronizar catálogo&rdquo;.</p>}
    </section>}
  </div>;
}
