"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useRef, useState } from "react";

type Approval = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  status: string;
  requesterName: string;
  approverName: string | null;
  reason: string;
  context: unknown;
  decisionReason: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

const actionLabels: Record<string, string> = {
  "cash.withdrawal": "Sangria",
  "sale.cancel": "Cancelamento de venda",
  "return.create": "Devolução",
  "discount.override": "Desconto excepcional",
  "session.close.divergence": "Divergência de fechamento",
  "payment.manual_reference": "Referência manual de pagamento",
};

export function PdvApprovalDialog({ sessionId, onClose }: { sessionId?: number; onClose(): void }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [canApprove, setCanApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestAttempt = useRef({ signature: "", key: crypto.randomUUID() });

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/approvals?status=all", { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível carregar as aprovações.");
      setApprovals(Array.isArray(body.approvals) ? body.approvals as Approval[] : []);
      setCanApprove(body.canApprove === true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as aprovações.");
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function post(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/erp/pdv/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(text(body.error) || "Não foi possível concluir a aprovação.");
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a aprovação.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function request(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget, form = new FormData(element);
    const approvalAction = String(form.get("approvalAction") || "");
    const enteredEntityId = String(form.get("entityId") || "").trim();
    const entityId = enteredEntityId || (sessionId && ["cash.withdrawal", "session.close.divergence"].includes(approvalAction) ? String(sessionId) : null);
    const payload = { action: "approval.request", approvalAction, entityId, reason: form.get("reason"), expiryMinutes: Number(form.get("expiryMinutes") || 10), context: sessionId ? { sessionId } : {} };
    const signature = JSON.stringify(payload);
    if (requestAttempt.current.signature !== signature) requestAttempt.current = { signature, key: crypto.randomUUID() };
    const succeeded = await post({ ...payload, idempotencyKey: requestAttempt.current.key });
    if (succeeded) {
      requestAttempt.current = { signature: "", key: crypto.randomUUID() };
      element.reset();
      setNotice("Pedido enviado ao supervisor.");
    }
  }

  async function decide(approvalId: string, decision: "approved" | "rejected") {
    const decisionReason = decision === "rejected" ? window.prompt("Informe o motivo da rejeição:") : null;
    if (decision === "rejected" && !decisionReason) return;
    if (await post({ action: "approval.decide", approvalId, decision, decisionReason })) setNotice(decision === "approved" ? "Operação aprovada." : "Pedido rejeitado.");
  }

  async function stepUpDecide(event: React.FormEvent<HTMLFormElement>, approvalId: string) {
    event.preventDefault();
    const element = event.currentTarget, form = new FormData(element);
    const password = String(form.get("supervisorPassword") || "");
    const succeeded = await post({
      action: "approval.step-up.decide",
      approvalId,
      email: form.get("supervisorEmail"),
      password,
      decision: form.get("decision"),
      decisionReason: form.get("decisionReason"),
    });
    const passwordInput = element.elements.namedItem("supervisorPassword");
    if (passwordInput instanceof HTMLInputElement) passwordInput.value = "";
    if (succeeded) {
      element.reset();
      setNotice("Decisão registrada com a identidade do supervisor.");
    }
  }

  return <div className="tenant-modal pos-dialog pos-approval-dialog" role="dialog" aria-modal="true" aria-labelledby="pos-approval-title"><div>
    <header><div><h2 id="pos-approval-title">Aprovações do PDV</h2><p>O solicitante e o aprovador devem ser pessoas diferentes. A aprovação expira e só pode ser usada uma vez.</p></div><button type="button" autoFocus onClick={onClose}>Fechar</button></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {notice && <p className="tenant-success" role="status">{notice}</p>}
    <form className="pos-approval-request" onChange={() => { requestAttempt.current = { signature: "", key: crypto.randomUUID() }; }} onSubmit={(event) => void request(event)}>
      <label>Operação<select name="approvalAction" disabled={busy} defaultValue="cash.withdrawal"><option value="cash.withdrawal">Sangria</option><option value="sale.cancel">Cancelamento de venda</option><option value="session.close.divergence">Divergência de fechamento</option></select></label>
      <label>ID da operação<input name="entityId" disabled={busy} placeholder={sessionId ? `Turno atual: ${sessionId}` : "Venda ou turno"} /></label>
      <label>Validade<select name="expiryMinutes" disabled={busy} defaultValue="10"><option value="5">5 minutos</option><option value="10">10 minutos</option><option value="15">15 minutos</option><option value="30">30 minutos</option></select></label>
      <label className="wide">Justificativa<textarea name="reason" minLength={8} maxLength={500} required disabled={busy} /></label>
      <button className="primary" disabled={busy}>Solicitar aprovação</button>
    </form>
    <div className="pos-approval-list">{approvals.map((approval) => {
      const requiresStepUp = ["payment.manual_reference", "sale.cancel", "return.create"].includes(approval.action);
      return <article key={approval.id}>
      <header><div><strong>{actionLabels[approval.action] || approval.action}</strong><small>{approval.requesterName} · {new Date(approval.createdAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small></div><b className={`status-${approval.status}`}>{approval.status}</b></header>
      <p>{approval.reason}</p><ApprovalContextSummary approval={approval} /><code>{approval.id}</code>{approval.entityId && <span>Operação: {approval.entityId}</span>}
      {approval.approverName && <small>Decidido por {approval.approverName}{approval.decisionReason ? ` · ${approval.decisionReason}` : ""}</small>}
      {approval.consumedAt && <small>Utilizada em {new Date(approval.consumedAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small>}
      <footer><button type="button" disabled={busy} onClick={() => void navigator.clipboard?.writeText(approval.id).then(() => setNotice("ID copiado."))}>Copiar ID</button>{canApprove && !requiresStepUp && approval.status === "pending" && <><button type="button" disabled={busy} className="primary" onClick={() => void decide(approval.id, "approved")}>Aprovar</button><button type="button" disabled={busy} onClick={() => void decide(approval.id, "rejected")}>Rejeitar</button></>}</footer>
      {(!canApprove || requiresStepUp) && approval.status === "pending" && <form className="pos-approval-step-up" autoComplete="off" onSubmit={(event) => void stepUpDecide(event, approval.id)}>
        <strong>Supervisor presente</strong><small>As credenciais são verificadas no servidor e não são armazenadas no PDV.</small>
        <label>E-mail do supervisor<input name="supervisorEmail" type="email" required maxLength={320} autoComplete="off" disabled={busy} /></label>
        <label>Senha do supervisor<input name="supervisorPassword" type="password" required maxLength={256} autoComplete="off" disabled={busy} /></label>
        <label>Decisão<select name="decision" defaultValue="approved" disabled={busy}><option value="approved">Aprovar</option><option value="rejected">Rejeitar</option></select></label>
        <label>Motivo da rejeição<input name="decisionReason" maxLength={500} disabled={busy} /></label>
        <button className="primary" disabled={busy}>Confirmar identidade e decidir</button>
      </form>}
    </article>;
    })}</div>
    {!approvals.length && <p className="tenant-empty">Nenhum pedido visível.</p>}
  </div></div>;
}

function ApprovalContextSummary({ approval }: { approval: Approval }) {
  const context = record(approval.context);
  if (!context) return null;
  const details: Array<[string, string]> = [];
  if (approval.action === "payment.manual_reference") {
    push(details, "Valor", money(context.amountCents));
    push(details, "Forma", paymentMethod(context.method));
    push(details, "Instituição", safeText(context.provider));
    push(details, "Final da referência", safeText(context.referenceLastFour));
    push(details, "Horário alegado no comprovante", dateTime(context.occurredAt));
    push(details, "Parcela do pagamento", oneBased(context.paymentIndex));
    push(details, "Caixa", integerText(context.registerId));
    push(details, "Turno", integerText(context.sessionId));
    push(details, "Rascunho", safeText(context.saleDraftId));
    push(details, "Cotação", shortHash(context.quoteHash));
  } else if (approval.action === "discount.override") {
    push(details, "Venda bruta", money(context.grossCents));
    push(details, "Desconto manual", money(context.manualDiscountCents));
    push(details, "Percentual", basisPoints(context.basisPoints));
    push(details, "Turno", integerText(context.sessionId));
  } else if (approval.action === "session.close.divergence") {
    push(details, "Turno", integerText(context.sessionId));
    push(details, "Diferença máxima", money(context.maximumDifferenceCents));
  } else if (approval.action === "sale.cancel") {
    const sale = record(context.sale), operation = record(context.operation);
    push(details, "Venda", safeText(sale?.saleNumber));
    push(details, "Total a restituir", money(operation?.refundTotalCents));
    push(details, "Itens da venda", integerText(Array.isArray(sale?.items) ? sale.items.length : null));
    push(details, "Caixa", integerText(operation?.registerId));
    push(details, "Turno", integerText(operation?.processingSessionId));
    push(details, "Hash do conteúdo", shortHash(context.contentHash));
  } else if (approval.action === "return.create") {
    const sale = record(context.sale), operation = record(context.operation);
    const selectedItems = Array.isArray(operation?.items) ? operation.items : [];
    const destinations = [...new Set(selectedItems.map((item) => safeText(record(item)?.disposition)).filter(Boolean))].join(", ");
    push(details, "Venda", safeText(sale?.saleNumber));
    push(details, "Total a restituir", money(operation?.refundTotalCents));
    push(details, "Itens selecionados", integerText(selectedItems.length));
    push(details, "Destinos", destinations);
    push(details, "Motivo", safeText(operation?.reasonCode));
    push(details, "Inicia troca", operation?.exchangeRequested === true ? "Sim" : "Não");
    push(details, "Caixa", integerText(operation?.registerId));
    push(details, "Turno", integerText(operation?.processingSessionId));
    push(details, "Hash do conteúdo", shortHash(context.contentHash));
  }
  if (!details.length) return null;
  return <section className="pos-approval-context" aria-label="Contexto autoritativo da aprovação"><strong>Confira antes de decidir</strong><dl>{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>;
}

async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function safeText(value: unknown) { const result = typeof value === "string" ? value.trim() : ""; return result && result.length <= 160 ? result : ""; }
function integerText(value: unknown) { return Number.isSafeInteger(value) ? String(value) : ""; }
function oneBased(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0 ? String(Number(value) + 1) : ""; }
function shortHash(value: unknown) { const result = safeText(value); return /^[a-f0-9]{64}$/.test(result) ? `${result.slice(0, 12)}…` : ""; }
function money(value: unknown) { return Number.isSafeInteger(value) ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) / 100) : ""; }
function basisPoints(value: unknown) { return Number.isSafeInteger(value) ? `${(Number(value) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : ""; }
function dateTime(value: unknown) { const raw = safeText(value), parsed = new Date(raw); return raw && Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString("pt-BR", { timeZone: tenantTimeZone() }) : ""; }
function paymentMethod(value: unknown) { const labels: Record<string, string> = { pix: "Pix", credit: "Crédito", debit: "Débito", voucher: "Voucher" }; return labels[safeText(value)] || ""; }
function push(target: Array<[string, string]>, label: string, value: string) { if (value) target.push([label, value]); }
