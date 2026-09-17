"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Data = { organization: { id: string; planId: string; updatedAt: string; activeUsers?: number }; plans: { id: string; name: string; seats: number; visibility: string }[] };
export default function OrganizationPlan({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [data, setData] = useState<Data>();
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/plan`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível carregar os planos desta organização.");
        const result = await response.json();
        if (!Array.isArray(result.plans) || result.organization?.id !== organizationId || typeof result.organization.updatedAt !== "string") throw new Error("Resposta de planos inválida.");
        if (!controller.signal.aborted) { setData(result); setSelected(result.organization.planId); setConfirmed(false); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) { setData(undefined); setError(cause instanceof Error ? cause.message : "Falha de conexão."); } }
    })();
    return () => controller.abort();
  }, [organizationId, revision]);
  return <div><h3>Atribuir plano de recursos</h3><p>Altera os recursos e menus do NALVEN conforme o plano. Não altera valores, assinatura ou situação financeira no Billing externo, nem reativa licença suspensa.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && Number.isInteger(data.organization.activeUsers) && <p>{data.organization.activeUsers} usuários ativos, incluindo o proprietário. O plano escolhido precisa comportar esses acessos. Convites pendentes não reservam vagas.</p>}
    <button disabled={busy} onClick={() => setRevision(value => value + 1)}>Recarregar planos da organização</button>
    {!data ? !error && <p role="status">Carregando planos disponíveis…</p> : <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(""); setNotice("");
      try {
        const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: selected, updatedAt: data.organization.updatedAt, confirm: confirmed }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Não foi possível atribuir o plano.");
        setNotice("Plano atribuído e registrado no histórico. A cobrança externa não foi alterada."); setRevision(value => value + 1); router.refresh();
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
      finally { setBusy(false); }
    }}><fieldset disabled={busy}><legend>Plano da organização</legend><label>Plano disponível<select required value={selected} onChange={event => { setSelected(event.target.value); setConfirmed(false); }}>{!data.plans.some(plan => plan.id === selected) && <option value="">Selecione um plano ativo</option>}{data.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.visibility === "private" ? "Exclusivo deste cliente" : "Público"} · {plan.seats} usuários</option>)}</select></label><label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirmo a alteração dos recursos e menus deste cliente, sem mudar a cobrança externa.</label><button disabled={!confirmed || !data.plans.some(plan => plan.id === selected)}>{busy ? "Atribuindo…" : "Atribuir plano"}</button></fieldset></form>}
  </div>;
}
