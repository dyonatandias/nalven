"use client";
import { useEffect, useState } from "react";
import { displayMoney } from "@/lib/billing/portal-data";

type Invoice = { id: string; description: string; amount: number | null; dueAt: string | null; paidAt: string | null; status: string | null };
type Result = { linked: boolean; checkedAt?: string; payment?: { paymentMethod: string | null; subscriptionStatus: string | null; availableMethods: string[] } | null; invoices?: Invoice[] | null; errors?: { payment: string | null; invoices: string | null } };
const labels: Record<string, string> = { pix: "Pix", boleto: "Boleto", cartao: "Cartão", credit_card: "Cartão de crédito", active: "Ativa", ativa: "Ativa", canceled: "Cancelada", cancelada: "Cancelada", pending: "Pendente", pendente: "Pendente", paid: "Paga", paga: "Paga", vencida: "Vencida", overdue: "Vencida", suspended: "Suspensa", past_due: "Em atraso" };
function label(value?: string | null) { return value ? labels[value] || value : "Não informado pelo sistema externo"; }
function date(value: string | null | undefined) { if (!value) return "—"; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "Data indisponível"; }

export default function OrganizationBilling({ organizationId }: { organizationId: string }) {
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true); setError(""); setResult(undefined); setPage(1);
      try {
        const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/billing`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível consultar o financeiro desta organização.");
        const data = await response.json();
        const nullableText = (value: unknown) => value === null || typeof value === "string";
        if (typeof data.linked !== "boolean" || (data.linked && (
          typeof data.checkedAt !== "string" || !Number.isFinite(Date.parse(data.checkedAt)) ||
          !data.errors || !nullableText(data.errors.payment) || !nullableText(data.errors.invoices) ||
          (data.invoices !== null && (!Array.isArray(data.invoices) || !data.invoices.every((row: Invoice) => row && typeof row.id === "string" && typeof row.description === "string" && (row.amount === null || (typeof row.amount === "number" && Number.isFinite(row.amount))) && nullableText(row.dueAt) && nullableText(row.paidAt) && nullableText(row.status)))) ||
          (data.payment !== null && (!data.payment || !nullableText(data.payment.paymentMethod) || !nullableText(data.payment.subscriptionStatus) || !Array.isArray(data.payment.availableMethods) || !data.payment.availableMethods.every((method: unknown) => typeof method === "string")))
        ))) throw new Error("Resposta financeira inválida.");
        if (!controller.signal.aborted) setResult(data);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [organizationId, revision]);
  const invoices = result?.invoices;
  return <section id="financeiro" className="management-section"><h2>Financeiro externo</h2>
    <p>Cobranças e pagamentos são gerenciados pelo sistema externo. Esta consulta não emite, altera nem baixa cobranças.</p>
    <div className="table-tools"><a href="https://agenciexpress.com.br" target="_blank" rel="noopener noreferrer">Abrir sistema de cobrança ↗</a><button disabled={loading} onClick={() => setRevision(value => value + 1)}>Atualizar financeiro</button></div>
    {loading && <p role="status">Consultando sistema financeiro externo…</p>}
    {error && <p role="alert">{error}</p>}
    {result && !result.linked && <p>Esta organização ainda não possui vínculo com o sistema de cobrança.</p>}
    {result?.linked && <>
      <p>Consulta realizada em {result.checkedAt ? new Date(result.checkedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}. Os dados abaixo são retornados pelo Billing, não por registros de cobrança locais.</p>
      {result.errors?.payment && <p role="alert">{result.errors.payment} Use Atualizar financeiro para tentar novamente.</p>}
      {result.payment && <dl><dt>Forma de pagamento da assinatura</dt><dd>{label(result.payment.paymentMethod)}</dd><dt>Assinatura externa</dt><dd>{label(result.payment.subscriptionStatus)}</dd><dt>Meios disponíveis</dt><dd>{result.payment.availableMethods.map(label).join(" · ") || "Não informados pelo sistema externo"}</dd></dl>}
      <h3>Faturas retornadas pelo sistema externo</h3>
      {result.errors?.invoices && <p role="alert">{result.errors.invoices} O histórico está indisponível; isso não significa ausência de faturas.</p>}
      {invoices && <><p>{invoices.length} faturas nesta consulta. A abrangência do histórico depende da resposta do sistema externo.</p><div className="admin-table-wrap"><table><thead><tr><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Pagamento</th><th>Situação</th></tr></thead><tbody>{invoices.slice((page - 1) * 25, page * 25).map(invoice => <tr key={invoice.id}><td>{invoice.description}</td><td>{displayMoney(invoice.amount)}</td><td>{date(invoice.dueAt)}</td><td>{date(invoice.paidAt)}</td><td>{label(invoice.status)}</td></tr>)}</tbody></table></div>{!invoices.length && <p>Nenhuma fatura retornada nesta consulta.</p>}
        {invoices.length > 25 && <div className="table-tools"><button disabled={page === 1} onClick={() => setPage(value => value - 1)}>Anterior</button><span>Página {page} de {Math.ceil(invoices.length / 25)}</span><button disabled={page * 25 >= invoices.length} onClick={() => setPage(value => value + 1)}>Próxima</button></div>}</>}
    </>}
  </section>;
}
