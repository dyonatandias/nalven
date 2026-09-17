"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useState } from "react";

type PersistedApplication = {
  id: string; version: number; state: string; reservationExpiresAt: string; saleId: number | null; paymentId: string | null;
  failureClass: string | null; blockedCode: string | null;
};
type ManualCase = {
  id: string; version: number; state: string; amountCents: number; currency: string; provider: string; method: string;
  referenceLastFour: string; caseExpiresAt: string; updatedAt: string; makerName: string;
  register: { id: number; code: string; name: string }; application: PersistedApplication | null;
};
type Queue = { hardOff: boolean; cases: ManualCase[]; branch: { id: number; code: string; name: string } };
type LiveApplication = {
  applicationId: string; applicationVersion: number; caseId: string; caseVersionAfterReserve: number;
  state: "pending" | "claimed" | "applied" | "blocked"; currentlyApplicable: boolean; reservationExpiresAt: string;
  saleId: number | null; paymentId: string | null; failureClass: string | null; blockedCode: string | null;
};
type Attempt = { signature: string; key: string; expectedCaseVersion: number };

export function PdvManualApplicationsAdmin({ branchId }: { branchId: number }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [live, setLive] = useState<Record<string, LiveApplication>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const [clock, setClock] = useState(0);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`/api/erp/pdv/manual-applications?branchId=${branchId}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(message(body.error) || "Não foi possível carregar a fila T2-02.");
      setQueue(body as unknown as Queue);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a fila T2-02.");
    }
  }, [branchId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  useEffect(() => {
    const update = () => setClock(Date.now());
    const frame = window.requestAnimationFrame(update);
    const timer = window.setInterval(update, 30_000);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, []);

  async function reserve(item: ManualCase) {
    const signature = `${item.id}:${item.version}`;
    const previous = attempts[item.id];
    const attempt = previous?.signature === signature ? previous : { signature, key: idempotencyKey(), expectedCaseVersion: item.version };
    setAttempts(current => ({ ...current, [item.id]: attempt }));
    await execute(item, "reserve", attempt);
  }

  async function probe(item: ManualCase) {
    const attempt = attempts[item.id];
    if (!attempt) {
      setError("A chave da tentativa original não está nesta sessão. Consulte o status pelo ID da aplicação; não crie uma sondagem aproximada.");
      return;
    }
    await execute(item, "probe", attempt);
  }

  async function execute(item: ManualCase, action: "reserve" | "probe", attempt: Attempt) {
    if (busy) return;
    setBusy(`${action}:${item.id}`); setError(""); setNotice("");
    try {
      const response = await fetch("/api/erp/pdv/manual-applications", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, caseId: item.id, expectedCaseVersion: attempt.expectedCaseVersion, idempotencyKey: attempt.key }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(message(body.error) || "A operação T2-02 não foi concluída.");
      const outcome = message(body.outcome), application = object(body.application) as LiveApplication | null;
      if (application?.applicationId) setLive(current => ({ ...current, [application.applicationId]: application }));
      if (outcome === "committed_same_request" || outcome === "committed") {
        setAttempts(current => { const next = { ...current }; delete next[item.id]; return next; });
        setNotice(body.replayed ? "Reserva já confirmada anteriormente; o mesmo resultado foi recuperado sem prolongar o prazo." : outcome === "committed_same_request" ? "A sondagem confirmou o commit da mesma solicitação." : "Recursos reservados e aplicação pendente criada.");
      } else if (outcome === "authoritatively_absent") {
        setNotice("A autoridade confirmou ausência do commit. Você pode repetir Reserva usando a mesma chave desta tentativa.");
      } else {
        setNotice("O commit continua desconhecido. Não repita com outra chave; use Sondar commit novamente.");
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A operação T2-02 não foi concluída.");
    } finally { setBusy(""); }
  }

  async function status(applicationId: string) {
    if (busy) return;
    setBusy(`status:${applicationId}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/erp/pdv/manual-applications?applicationId=${encodeURIComponent(applicationId)}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(message(body.error) || "Não foi possível consultar a aplicação.");
      if (body.status === "not_found") {
        setNotice("Aplicação não encontrada ou não autorizada no contexto atual.");
      } else {
        const application = object(body.application) as LiveApplication | null;
        if (application?.applicationId) setLive(current => ({ ...current, [application.applicationId]: application }));
        setNotice("Status autoritativo atualizado.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar a aplicação.");
    } finally { setBusy(""); }
  }

  if (!queue) return <section className="pos-admin-create"><h3>Finalização manual T2-02</h3><p role="status">{error || "Carregando casos e disponibilidade…"}</p></section>;

  return <section className="pos-admin-list" aria-label="Finalização manual T2-02">
    <header><div><h3>Finalização manual T2-02</h3><small>Reserva serializável de estoque, promoção e cupom; status e sondagem de commit autoritativos</small></div><button type="button" disabled={Boolean(busy)} onClick={() => void load()}>Atualizar fila</button></header>
    {queue.hardOff && <p className="tenant-error" role="status"><strong>Hard-off:</strong> nenhum gate de reconciliação ativo nesta filial. A tela não habilita gate, perfil nem apply.</p>}
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {notice && <p className="tenant-success" role="status">{notice}</p>}
    {!queue.cases.length && <p>Nenhum caso confirmado ou em aplicação nesta filial.</p>}
    <div className="pos-admin-children">{queue.cases.map(item => {
      const application = item.application ? live[item.application.id] || persistedStatus(item.application, item.id) : null;
      const attempt = attempts[item.id];
      const isExpired = clock > 0 && (application ? Date.parse(application.reservationExpiresAt) <= clock : Date.parse(item.caseExpiresAt) <= clock);
      const canReserve = item.state === "confirmed_paid" && !item.application && !queue.hardOff && !isExpired;
      return <article key={item.id}>
        <header><div><strong>{money(item.amountCents, item.currency)} · {item.provider} · {item.method}</strong><small>Caso {item.id} · v{item.version} · {item.state} · ••••{item.referenceLastFour}</small><small>{item.register.name} ({item.register.code}) · registrado por {item.makerName} · atualizado {new Date(item.updatedAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small></div><span className={`purchase-status ${isExpired ? "cancelled" : item.state === "applied" ? "received" : "draft"}`}>{isExpired ? "expirado" : item.state}</span></header>
        {application && <div className="pos-admin-row"><span>Aplicação <code>{application.applicationId}</code></span><span>Estado <strong>{application.state}</strong> · v{application.applicationVersion}</span><span>Aplicável <strong>{application.currentlyApplicable ? "sim" : "não"}</strong></span><span>Reserva até <strong>{new Date(application.reservationExpiresAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</strong></span>{application.saleId && <span>Venda <strong>{application.saleId}</strong></span>}{application.failureClass && <span>Falha <strong>{application.failureClass}</strong>{application.blockedCode ? ` · ${application.blockedCode}` : ""}</span>}</div>}
        <div className="pos-admin-row">
          {canReserve && <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void reserve(item)}>{busy === `reserve:${item.id}` ? "Reservando…" : "Reservar recursos"}</button>}
          {attempt && !item.application && <button type="button" disabled={Boolean(busy)} onClick={() => void probe(item)}>{busy === `probe:${item.id}` ? "Sondando…" : "Sondar commit"}</button>}
          {item.application && <button type="button" disabled={Boolean(busy)} onClick={() => void status(item.application!.id)}>{busy === `status:${item.application.id}` ? "Consultando…" : "Consultar status"}</button>}
          {!canReserve && !item.application && <small>{queue.hardOff ? "Reserva indisponível enquanto o hard-off estiver ativo." : isExpired ? "O caso expirou antes da reserva." : "Somente casos confirmed_paid sem aplicação podem ser reservados."}</small>}
        </div>
      </article>;
    })}</div>
  </section>;
}

function persistedStatus(value: PersistedApplication, caseId: string): LiveApplication {
  return {
    applicationId: value.id, applicationVersion: value.version, caseId, caseVersionAfterReserve: 0,
    state: value.state as LiveApplication["state"], currentlyApplicable: false, reservationExpiresAt: value.reservationExpiresAt,
    saleId: value.saleId, paymentId: value.paymentId, failureClass: value.failureClass, blockedCode: value.blockedCode,
  };
}

function idempotencyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function money(cents: number, currency: string) {
  try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(cents / 100); }
  catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

function message(value: unknown) { return typeof value === "string" ? value : ""; }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
