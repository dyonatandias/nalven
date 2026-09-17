"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Account = { id: string; organizationId: string; licenseStatus: string | null; subscriptionStatus: string | null; lastSyncedAt: string | null; organization: { name: string } };
type Data = { accounts: Account[]; total: number; page: number; pageSize: number; timeoutMs: number; cacheSeconds: number; policyVersion: string | null };
export default function LicenseManager() {
  const [data, setData] = useState<Data>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState({ q: "", page: 1 });
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/licenses?${new URLSearchParams({ q: filter.q, page: String(filter.page) })}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível carregar as licenças.");
        const result = await response.json();
        if (!Array.isArray(result.accounts) || !Number.isInteger(result.total) || result.pageSize !== 50) throw new Error("Resposta de licenças inválida.");
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) { setData(undefined); setError(cause instanceof Error ? cause.message : "Falha de conexão."); } }
    })();
    return () => controller.abort();
  }, [filter, revision]);
  async function verify(account: Account) {
    setBusy(account.id); setNotice("");
    try {
      const response = await fetch("/api/admin/licenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", organizationId: account.organizationId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível validar a licença.");
      setNotice(`${account.organization.name}: ${result.valid ? "licença válida" : "licença inválida"}. Consulta realizada agora no serviço externo.`);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(""); }
  }
  return <div className="management"><header><div><h1>Licenças</h1><p>A autorização de uso é validada no serviço externo. Esta página não emite cobranças nem ativa assinaturas.</p><Link href="/admin/integracoes">Configuração da integração financeira →</Link></div></header>
    {notice && <p role="status">{notice}</p>}
    {data && <LicensePolicyForm key={data.policyVersion || "initial"} data={data} saved={() => { setNotice("Política de licença salva e auditada."); setRevision(value => value + 1); }} />}
    {error && <p role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Tentar novamente</button></p>}
    {!data ? !error && <p role="status">Carregando licenças…</p> : <section className="control-panel"><p>Tempo limite: {data.timeoutMs} ms · validade do cache: {data.cacheSeconds} segundos. “Validar agora” consulta o serviço sem usar uma resposta anterior do cache.</p>
      <form className="table-tools" onSubmit={event => { event.preventDefault(); setFilter({ q: query, page: 1 }); }}><input aria-label="Buscar licenças por organização" value={query} onChange={event => setQuery(event.target.value)} /><button>Buscar</button></form>
      <div className="admin-table-wrap"><table><thead><tr><th>Organização</th><th>Licença sincronizada</th><th>Assinatura externa</th><th>Última sincronização</th><th>Ações</th></tr></thead><tbody>{data.accounts.map(account => <tr key={account.id}><td><Link href={`/admin/organizacoes/${encodeURIComponent(account.organizationId)}`}>{account.organization.name}</Link></td><td>{account.licenseStatus || "Não informada"}</td><td>{account.subscriptionStatus || "Não informada"}</td><td>{account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Não sincronizada"}</td><td><button disabled={!!busy} onClick={() => void verify(account)}>{busy === account.id ? "Validando…" : "Validar agora"}</button></td></tr>)}</tbody></table></div>
      {!data.accounts.length && <p>Nenhuma licença encontrada.</p>}
      <div className="table-tools"><button disabled={data.page <= 1} onClick={() => setFilter(value => ({ ...value, page: value.page - 1 }))}>Anterior</button><span>{data.total} licenças · página {data.page}</span><button disabled={data.page * 50 >= data.total} onClick={() => setFilter(value => ({ ...value, page: value.page + 1 }))}>Próxima</button></div>
    </section>}
  </div>;
}

function LicensePolicyForm({ data, saved }: { data: Data; saved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <form className="control-panel" onSubmit={async event => {
    event.preventDefault(); const form = event.currentTarget, fields = new FormData(form);
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/licenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "policy.save", licenseTimeoutMs: Number(fields.get("timeout")), licenseCacheSeconds: Number(fields.get("cache")), currentPassword: fields.get("password"), policyVersion: data.policyVersion ?? null }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar a política.");
      setMessage("Política salva e auditada."); saved();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { const password = form.elements.namedItem("password") as HTMLInputElement; password.value = ""; setBusy(false); }
  }}><h2>Política de consulta de licença</h2><p>Configuração operacional independente da cobrança. Um cache menor aumenta as consultas ao provedor; não libera uma licença inválida.</p><fieldset disabled={busy}><legend>Tempo limite e cache</legend><label>Tempo limite da consulta (ms)<input name="timeout" type="number" min={1000} max={30000} step={1} required defaultValue={data.timeoutMs} /></label><label>Validade do cache (segundos)<input name="cache" type="number" min={30} max={3600} step={1} required defaultValue={data.cacheSeconds} /></label><label>Sua senha administrativa<input name="password" type="password" autoComplete="current-password" required /></label><button>{busy ? "Salvando…" : "Salvar política de licença"}</button></fieldset>{message && <p role="status">{message}</p>}</form>;
}
