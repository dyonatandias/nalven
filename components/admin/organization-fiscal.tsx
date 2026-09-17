"use client";
import { useEffect, useState } from "react";

type Branch = { id: number; name: string; legalName: string; document: string; stateRegistration: string | null; stateRegistrationExempt: boolean; municipalRegistration: string | null; activityCode: string | null; zip: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null; primary: boolean; status: string };
type Data = { branches: Branch[]; total: number; page: number; pageSize: number };
function validBranch(value: unknown): value is Branch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const branch = value as Record<string, unknown>;
  return Number.isSafeInteger(branch.id) && Number(branch.id) > 0 &&
    ["name", "legalName", "document", "status"].every(key => typeof branch[key] === "string") &&
    ["primary", "stateRegistrationExempt"].every(key => typeof branch[key] === "boolean") &&
    ["stateRegistration", "municipalRegistration", "activityCode", "zip", "street", "number", "complement", "district", "city", "state"].every(key => branch[key] == null || typeof branch[key] === "string");
}
export default function OrganizationFiscal({ organizationId }: { organizationId: string }) {
  const [resultState, setResultState] = useState<{ key: string; data?: Data; error?: string }>();
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const requestKey = JSON.stringify([organizationId, page, revision]);
  const current = resultState?.key === requestKey ? resultState : undefined;
  const data = current?.data, error = current?.error;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/fiscal?page=${page}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível consultar os dados fiscais desta organização. Verifique a disponibilidade do ambiente e tente novamente.");
        const result = await response.json();
        if (!result || !Array.isArray(result.branches) || !result.branches.every(validBranch) || result.branches.length > 25 || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 25) throw new Error("Resposta fiscal inválida.");
        if (!controller.signal.aborted) setResultState({ key: requestKey, data: result });
      } catch (cause) { if (!controller.signal.aborted) setResultState({ key: requestKey, error: cause instanceof Error ? cause.message : "Falha de conexão." }); }
    })();
    return () => controller.abort();
  }, [organizationId, page, requestKey]);
  return <section id="fiscal" className="management-section"><h2>Dados fiscais das unidades</h2><p>Consulta ao cadastro de unidades no banco desta organização. Não altera documentos nem o cadastro de cobrança externa.</p>
    {error && <p role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Recarregar dados fiscais</button></p>}
    {!data ? !error && <p role="status">Consultando unidades…</p> : <><div className="editor-grid">{data.branches.map(branch => <article className="edit-card" key={branch.id}><h3>{branch.name}{branch.primary ? " · Unidade principal" : ""}</h3><dl><dt>Razão social</dt><dd>{branch.legalName}</dd><dt>Documento fiscal</dt><dd>{branch.document}</dd><dt>Inscrição estadual</dt><dd>{branch.stateRegistrationExempt ? "Isenta" : branch.stateRegistration || "Não informada"}</dd><dt>Inscrição municipal</dt><dd>{branch.municipalRegistration || "Não informada"}</dd><dt>Atividade econômica</dt><dd>{branch.activityCode || "Não informada"}</dd><dt>Endereço</dt><dd>{[branch.street, branch.number, branch.complement, branch.district, branch.city, branch.state, branch.zip].filter(Boolean).join(", ") || "Não informado"}</dd><dt>Situação</dt><dd>{branch.status === "active" ? "Ativa" : branch.status === "inactive" ? "Inativa" : branch.status}</dd></dl></article>)}</div>{!data.branches.length && <p>Nenhuma unidade cadastrada neste ambiente.</p>}<div className="table-tools"><button disabled={data.page <= 1} onClick={() => setPage(value => value - 1)}>Unidades anteriores</button><span>{data.total} unidades · página {data.page}</span><button disabled={data.page * data.pageSize >= data.total} onClick={() => setPage(value => value + 1)}>Próximas unidades</button></div></>}
  </section>;
}
