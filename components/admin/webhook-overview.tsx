"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Data = { records: { id: string; name: string; url: string; createdAt: string; lastAt: string | null; lastStatus: number | null }[]; total: number; page: number; pageSize: number };
export default function WebhookOverview() {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/webhooks?page=${page}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível consultar os registros de webhook.");
        const result = await response.json();
        if (!Array.isArray(result.records) || !Number.isInteger(result.total) || result.pageSize !== 50) throw new Error("Resposta de webhooks inválida.");
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) { setData(undefined); setError(cause instanceof Error ? cause.message : "Falha de conexão."); } }
    })();
    return () => controller.abort();
  }, [page, revision]);
  return <div className="management"><header><div><h1>Webhooks</h1><p>Recebimento financeiro, integrações dos clientes e registros antigos da plataforma.</p></div></header>
    <section className="control-panel"><h2>Recebimento do Billing externo</h2><p>O receptor financeiro valida a assinatura dos eventos recebidos. Credenciais, configuração e eventos recentes ficam na integração financeira.</p><Link href="/admin/integracoes">Gerenciar receptor financeiro →</Link></section>
    <section className="control-panel"><h2>Integrações das organizações</h2><p>Os webhooks operacionais pertencem ao banco de cada cliente e são administrados na área de integrações do respectivo ERP. Não usam os registros centrais abaixo.</p><Link href="/admin/organizacoes">Consultar organizações →</Link></section>
    <section className="control-panel"><h2>Cadastros antigos de saída da plataforma</h2><p role="note">Estes registros não possuem serviço de entrega implementado. Não há garantia de envio. Novos cadastros e ativações estão indisponíveis; os registros existentes foram preservados para revisão.</p>
      {error && <p role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Recarregar registros</button></p>}
      {!data ? !error && <p role="status">Carregando registros…</p> : <><div className="admin-table-wrap"><table><thead><tr><th>Nome</th><th>Destino cadastrado</th><th>Último registro de entrega</th><th>Resposta registrada</th></tr></thead><tbody>{data.records.map(record => <tr key={record.id}><td>{record.name}</td><td>{record.url}</td><td>{record.lastAt ? new Date(record.lastAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Nenhum"}</td><td>{record.lastStatus ?? "Não disponível"}</td></tr>)}</tbody></table></div>{!data.records.length && <p>Nenhum cadastro antigo encontrado.</p>}<div className="table-tools"><button disabled={data.page <= 1} onClick={() => setPage(value => value - 1)}>Anterior</button><span>{data.total} registros · página {data.page}</span><button disabled={data.page * 50 >= data.total} onClick={() => setPage(value => value + 1)}>Próxima</button></div></>}
    </section>
  </div>;
}
