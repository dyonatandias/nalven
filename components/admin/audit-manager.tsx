"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type AuditRow = { id: string; action: string; entityType: string; entityId: string | null; createdAt: string; user: { name: string } | null };
type Result = { logs: AuditRow[]; total: number; page: number; pageSize: number };
const entities: Record<string, string> = { organization: "Organização", user: "Usuário", plan: "Plano", content: "Conteúdo do site", settings: "Configuração", integration: "Integração", template: "Template de e-mail", webhook: "Webhook", announcement: "Comunicado", billing: "Integração financeira" };
const actions: Record<string, string> = { save: "Atualização", create: "Criação", update: "Atualização", delete: "Exclusão", toggle: "Alteração de disponibilidade", sync: "Sincronização", login: "Entrada no sistema", logout: "Saída do sistema" };
const specificActions: Record<string, string> = {
  "organization.save": "Cadastro da organização atualizado",
  "organization.plan_changed": "Plano da organização alterado",
  "organization.membership_updated": "Acesso de usuário atualizado",
  "organization.memberships_updated": "Acessos de usuários atualizados em lote",
  "license.verify": "Licença externa verificada",
  "license.verify_denied": "Verificação da licença externa negada",
  "billing.sync": "Dados financeiros sincronizados",
  "billing.retry_provision": "Provisionamento financeiro reprocessado",
  "billing.subscription": "Assinatura atualizada no sistema externo",
  "billing.subscription_action": "Operação na assinatura externa",
};

export default function AuditManager({ organizationId }: { organizationId?: string }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState({ q: "", entityType: "", from: "", to: "", page: 1 });
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true); setError("");
      try {
        const response = await fetch(`/api/admin/audit?${new URLSearchParams({ q: filter.q, entityType: filter.entityType, from: filter.from, to: filter.to, page: String(filter.page), ...(organizationId ? { organizationId } : {}) })}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 403 ? "Você não tem acesso à auditoria." : "Não foi possível carregar a auditoria.");
        const data = await response.json();
        if (!Array.isArray(data.logs) || !Number.isInteger(data.total) || data.pageSize !== 50 || !data.logs.every((row: AuditRow) => row && typeof row.id === "string" && typeof row.action === "string" && typeof row.entityType === "string" && typeof row.createdAt === "string")) throw new Error("Resposta de auditoria inválida.");
        if (!controller.signal.aborted) setResult(data);
      } catch (cause) { if (!controller.signal.aborted) { setResult(undefined); setError(cause instanceof Error ? cause.message : "Falha de conexão."); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [filter, revision, organizationId]);
  return <><div className="module-heading"><div><p>ADMINISTRAÇÃO</p>{organizationId ? <h2>Histórico administrativo da organização</h2> : <h1>Auditoria</h1>}<span>{organizationId ? "Alterações cadastrais, planos, licenças e operações financeiras registradas para esta organização. Atividades de usuários ficam na central de acessos acima." : "Histórico administrativo com responsável, ação e entidade afetada."}</span></div><button disabled={loading} onClick={() => setRevision(value => value + 1)}>Atualizar</button></div>
    <section className="control-panel"><form className="table-tools" onSubmit={event => { event.preventDefault(); setFilter(value => ({ ...value, q: query, page: 1 })); }}>
      <input aria-label="Buscar na auditoria" placeholder="Responsável, ação ou identificador" value={query} onChange={event => setQuery(event.target.value)} maxLength={160} />
      <label>De (UTC)<input type="date" value={filter.from} max={filter.to || undefined} onChange={event => setFilter(value => ({ ...value, from: event.target.value, page: 1 }))} /></label>
      <label>Até (UTC)<input type="date" value={filter.to} min={filter.from || undefined} onChange={event => setFilter(value => ({ ...value, to: event.target.value, page: 1 }))} /></label>
      <select aria-label="Tipo de registro" value={filter.entityType} onChange={event => setFilter(value => ({ ...value, entityType: event.target.value, page: 1 }))}><option value="">Todos os tipos</option>{Object.entries(entities).filter(([key]) => !organizationId || key === "organization" || key === "billing").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button>Buscar</button>
    </form>
    {error && <div role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Tentar novamente</button></div>}
    {loading ? <p role="status">Carregando auditoria…</p> : result && <><p role="status">{result.total} registros encontrados</p><div className="admin-table-wrap"><table><thead><tr><th>Data</th><th>Responsável</th><th>Ação</th><th>Tipo</th><th>Registro afetado</th></tr></thead><tbody>{result.logs.map(row => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td><td>{row.user?.name || "Sistema"}</td><td>{specificActions[row.action] || actions[row.action.split(".").at(-1) || ""] || row.action}</td><td>{entities[row.entityType] || row.entityType}</td><td>{row.entityType === "organization" && row.entityId ? <Link href={`/admin/organizacoes/${encodeURIComponent(row.entityId)}`}>Visualizar organização</Link> : row.entityId || "Não informado"}</td></tr>)}</tbody></table></div>
      {!result.logs.length && <p>Nenhum registro corresponde aos filtros.</p>}
      <div className="table-tools"><button disabled={filter.page <= 1} onClick={() => setFilter(value => ({ ...value, page: value.page - 1 }))}>Anterior</button><span>Página {result.page} de {Math.max(1, Math.ceil(result.total / result.pageSize))}</span><button disabled={filter.page * result.pageSize >= result.total} onClick={() => setFilter(value => ({ ...value, page: value.page + 1 }))}>Próxima</button></div>
    </>}
    </section></>;
}
