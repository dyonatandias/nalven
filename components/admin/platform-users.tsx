"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type User = { id: string; name: string; email: string; status: string; updatedAt: string; lastLoginAt: string | null };
type Data = { users: User[]; total: number; page: number; pageSize: number; actorId: string };
export default function PlatformUsers() {
  const [data, setData] = useState<Data>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState({ q: "", page: 1 });
  const [selected, setSelected] = useState<User | null | undefined>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/admin/users?${new URLSearchParams({ q: filter.q, page: String(filter.page) })}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível carregar os usuários da plataforma.");
        const result = await response.json();
        if (!Array.isArray(result.users) || !Number.isInteger(result.total) || result.pageSize !== 50) throw new Error("Lista de usuários inválida.");
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) { setData(undefined); setError(cause instanceof Error ? cause.message : "Falha de conexão."); } }
    }
    void load(); return () => controller.abort();
  }, [filter, revision]);
  return <div className="management"><header><div><h1>Usuários da plataforma</h1><p>Administradores do SaaS. Usuários e vínculos dos clientes ficam na página de cada organização.</p><Link href="/admin/organizacoes">Gerenciar usuários de uma organização →</Link></div><button onClick={() => { setSelected(null); setNotice(""); }}>Novo administrador</button></header>
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Tentar novamente</button></div>}
    {selected !== undefined && <UserForm key={selected?.id || "new"} user={selected} own={selected?.id === data?.actorId} onCancel={() => setSelected(undefined)} onSaved={() => { setSelected(undefined); setNotice("Alteração salva e auditada."); setRevision(value => value + 1); }} />}
    <section className="control-panel"><form className="table-tools" onSubmit={event => { event.preventDefault(); setFilter({ q: query, page: 1 }); }}><input aria-label="Buscar administradores" placeholder="Nome ou e-mail" value={query} onChange={event => setQuery(event.target.value)} /><button>Buscar</button></form>
      {!data ? !error && <p role="status">Carregando administradores…</p> : <><div className="admin-table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Acesso à plataforma</th><th>Última entrada</th><th>Ações</th></tr></thead><tbody>{data.users.map(user => <tr key={user.id}><td>{user.name}{user.id === data.actorId ? " (você)" : ""}</td><td>{user.email}</td><td>{user.status === "active" ? "Ativo" : "Bloqueado"}</td><td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Nenhuma entrada registrada"}</td><td><button aria-label={`Gerenciar administrador ${user.name}`} onClick={() => { setSelected(user); setNotice(""); }}>Gerenciar</button></td></tr>)}</tbody></table></div>{!data.users.length && <p>Nenhum administrador encontrado.</p>}<div className="table-tools"><button disabled={data.page <= 1} onClick={() => setFilter(value => ({ ...value, page: value.page - 1 }))}>Anterior</button><span>{data.total} administradores · página {data.page}</span><button disabled={data.page * data.pageSize >= data.total} onClick={() => setFilter(value => ({ ...value, page: value.page + 1 }))}>Próxima</button></div></>}
    </section></div>;
}

function UserForm({ user, own, onCancel, onSaved }: { user: User | null; own: boolean; onCancel: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="management-section" onSubmit={async event => {
    event.preventDefault(); const form = event.currentTarget;
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") || (user ? "update" : "create");
    setBusy(true); setError("");
    try {
      const fields = Object.fromEntries(new FormData(form));
      const response = await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, action, id: user?.id, updatedAt: user?.updatedAt, status: own ? "active" : fields.status }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar.");
      form.reset();
      if (own && action === "revoke_sessions") {
        // Full navigation discards authenticated client state after session revocation.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login"); return;
      }
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { const password = form.elements.namedItem("currentPassword") as HTMLInputElement | null; if (password) password.value = ""; setBusy(false); }
  }}><h2>{user ? `Gerenciar ${user.name}` : "Novo administrador do SaaS"}</h2><p>Este acesso permite administrar toda a plataforma. Confirme sua senha para concluir.</p><fieldset disabled={busy}><legend>Dados do administrador</legend><div className="editor-grid"><label>Nome<input name="name" required maxLength={160} defaultValue={user?.name} /></label><label>E-mail<input name="email" type="email" required maxLength={254} defaultValue={user?.email} disabled={!!user} /></label>{!user && <label>Senha inicial do novo administrador<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" /></label>}{user && <label>Situação<select name="status" defaultValue={user.status} disabled={own}><option value="active">Ativo</option><option value="disabled">Bloqueado</option></select></label>}<label>Sua senha administrativa<input name="currentPassword" type="password" required autoComplete="current-password" /></label></div><div className="table-tools"><button value={user ? "update" : "create"}>Salvar administrador</button>{user && <button value="revoke_sessions">Encerrar todas as sessões</button>}<button type="button" onClick={onCancel}>Cancelar</button></div></fieldset>{error && <p role="alert">{error}</p>}</form>;
}
