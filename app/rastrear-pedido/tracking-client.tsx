"use client";
/* eslint-disable @next/next/no-img-element */
import { setTenantTimeZone, tenantTimeZone } from "@/lib/client-timezone";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type PublicOrder = { timezone: string; number: string; status: string; createdAt: string; customerName: string; subtotal: number; discount: number; freightAmount: number; total: number; refundedTotal: number; paymentTitle?: string | null; deliveryCity?: string | null; deliveryState?: string | null; items: Array<{ id: number; nameSnapshot: string; skuSnapshot?: string | null; imageSnapshot?: string | null; quantity: number; unitPrice: number; total: number }>; tracking?: { trackingNumber: string; carrier?: string | null; trackingUrl?: string | null; events: Array<{ id: number; description: string; location?: string | null; occurredAt: string }> } | null; notes: Array<{ id: number; content: string; author: string; createdAt: string }>; history: Array<{ id: number; toStatus: string; createdAt: string }>; returns: Array<{ id: number; status: string; reason: string; description: string; requestedAt: string }> };
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }), statuses: Record<string, string> = { draft: "Rascunho", approved: "Aprovado", pending: "Pedido recebido", processing: "Pagamento confirmado", "on-hold": "Em espera", preparing: "Em separação", shipped: "Enviado", "out-delivery": "Saiu para entrega", delivered: "Entregue", completed: "Concluído", cancelled: "Cancelado", refunded: "Reembolsado", failed: "Falha no pagamento" };

export default function TrackingClient({ storeSlug, initialNumber, orderKey }: { storeSlug: string; initialNumber: string; orderKey: string }) {
  const endpoint = useMemo(() => `/api/public/pedidos/rastreio${storeSlug ? `?loja=${encodeURIComponent(storeSlug)}` : ""}`, [storeSlug]);
  const [order, setOrder] = useState<PublicOrder | null>(null), [credentials, setCredentials] = useState({ number: initialNumber, email: "", key: orderKey }), [error, setError] = useState(""), [busy, setBusy] = useState(false), [returnOpen, setReturnOpen] = useState(false), [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const returnPendingRef = useRef(false);
  const loadOrder = useCallback(async (number: string, email: string, key = "") => {
    if (returnPendingRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setBusy(true); setError(""); setOrder(null); setReturnOpen(false); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ orderNumber: number, email, orderKey: key }) });
      const body = await response.json(); if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || "Não foi possível consultar o pedido.");
      setTenantTimeZone(body.order.timezone); setCredentials({ number, email, key }); setOrder(body.order);
    } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Falha na consulta."); }
    finally { if (requestRef.current === controller) { requestRef.current = null; setBusy(false); } }
  }, [endpoint]);
  // The initial signed link is an external input; loading it is the synchronization performed by this effect.
  useEffect(() => {
    // Keep the signed link functional without leaving its capability in the
    // address bar, browser history entries or subsequent same-origin referrals.
    if (orderKey) { const url = new URL(window.location.href); url.searchParams.delete("chave"); window.history.replaceState(window.history.state, "", url); }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialNumber && orderKey) void loadOrder(initialNumber, "", orderKey);
    return () => { requestRef.current?.abort(); };
  }, [initialNumber, orderKey, loadOrder]);
  async function query(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await loadOrder(String(form.get("orderNumber")), String(form.get("email"))); }
  async function requestReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!order || returnPendingRef.current) return;
    returnPendingRef.current = true; setBusy(true); setError("");
    const form = new FormData(event.currentTarget), items = order.items.map((item) => ({ orderItemId: item.id, quantity: Number(form.get(`item-${item.id}`) || 0) })).filter((item) => item.quantity > 0);
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "return", orderNumber: credentials.number, email: credentials.email, orderKey: credentials.key, reason: form.get("reason"), description: form.get("description"), items }) });
      const body = await response.json();
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) setOrder(null); throw new Error(body.error); }
      setNotice("Solicitação enviada. Você receberá as próximas atualizações por e-mail."); setReturnOpen(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha na solicitação."); }
    finally { returnPendingRef.current = false; setBusy(false); }
  }
  return <main className="tracking-page"><header><Link href="/" className="tracking-logo">NAL<span>VEN</span></Link><Link href="/login">Área da empresa</Link></header><section className="tracking-hero"><span>ACOMPANHAMENTO SEGURO</span><h1>Rastreie seu pedido</h1><p>Informe o número e o mesmo e-mail usado na compra. O número sozinho nunca libera dados pessoais.</p><form onSubmit={query}><label>Número do pedido<input name="orderNumber" defaultValue={credentials.number} placeholder="PED-2026-00000001" required/></label><label>E-mail da compra<input name="email" type="email" placeholder="voce@exemplo.com.br" required/></label><button disabled={busy}>{busy ? "Consultando…" : "Consultar pedido"}</button></form>{error && <div className="tracking-alert error">{error}</div>}{notice && <div className="tracking-alert success">{notice}</div>}</section>{order && <section className="tracking-result"><header><div><small>PEDIDO</small><h2>{order.number}</h2><p>{order.customerName} · {new Date(order.createdAt).toLocaleDateString("pt-BR", { timeZone: tenantTimeZone() })}</p></div><b>{statuses[order.status] || order.status}</b></header><div className="tracking-steps">{order.history.map((item) => <article key={item.id}><i>✓</i><strong>{statuses[item.toStatus] || item.toStatus}</strong><small>{new Date(item.createdAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small></article>)}</div><div className="tracking-grid"><section><h3>Itens</h3>{order.items.map((item) => <article className="tracking-item" key={item.id}>{item.imageSnapshot ? <img src={item.imageSnapshot} alt=""/> : <span>NV</span>}<div><strong>{item.nameSnapshot}</strong><small>{item.skuSnapshot} · {item.quantity} unidade(s)</small></div><b>{money.format(item.total)}</b></article>)}<div className="tracking-totals"><span>Subtotal <b>{money.format(order.subtotal)}</b></span><span>Frete <b>{money.format(order.freightAmount)}</b></span><span>Desconto <b>− {money.format(order.discount)}</b></span><strong>Total <b>{money.format(order.total)}</b></strong></div></section><aside><h3>Entrega e rastreio</h3>{order.tracking ? <div className="tracking-code"><small>{order.tracking.carrier || "Transportadora"}</small><strong>{order.tracking.trackingNumber}</strong>{order.tracking.trackingUrl && <a href={order.tracking.trackingUrl} target="_blank" rel="noopener noreferrer">Abrir rastreio oficial</a>}{order.tracking.events.map((event) => <p key={event.id}>{event.description}<small>{new Date(event.occurredAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small></p>)}</div> : <p>O código aparecerá aqui assim que o envio for registrado.</p>}<p>Destino: {[order.deliveryCity, order.deliveryState].filter(Boolean).join("/") || "retirada na loja"}</p><button onClick={() => setReturnOpen((value) => !value)}>Solicitar devolução</button></aside></div>{returnOpen && <form className="tracking-return" onSubmit={requestReturn}><h3>Solicitar devolução</h3><p>Informe a quantidade de cada item. Use zero para itens que permanecerão com você.</p><div>{order.items.map((item) => <label key={item.id}><span>{item.nameSnapshot}<small>Comprado: {item.quantity}</small></span><input type="number" name={`item-${item.id}`} min="0" max={item.quantity} step="0.0001" defaultValue="0" aria-label={`Quantidade de ${item.nameSnapshot}`}/></label>)}</div><label>Motivo<select name="reason" required><option value="">Selecione</option><option value="produto_defeituoso">Produto com defeito</option><option value="produto_errado">Produto errado</option><option value="produto_danificado">Danificado no transporte</option><option value="nao_atendeu_expectativas">Não atendeu às expectativas</option><option value="desistencia">Desistência da compra</option><option value="outro">Outro motivo</option></select></label><label>Descrição<textarea name="description" minLength={10} maxLength={4000} required/></label><button disabled={busy}>Enviar solicitação</button></form>}</section>}<footer>© 2026 NALVEN · Consulta protegida e dados limitados ao titular</footer></main>;
}
