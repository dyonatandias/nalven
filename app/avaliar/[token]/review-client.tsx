"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

type ReviewData = { state: string; orderNumber: string; customerName: string; expiresAt: string; product: { name: string; slug: string }; review?: { rating: number; title?: string | null; content: string } | null };

export default function ReviewClient({ token, storeSlug: store }: { token: string; storeSlug: string }) {
  const [data, setData] = useState<ReviewData | null>(null), [rating, setRating] = useState(5), [error, setError] = useState(""), [done, setDone] = useState(false), [busy, setBusy] = useState(true);
  const submitPendingRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/public/avaliacoes/${encodeURIComponent(token)}?loja=${encodeURIComponent(store)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json(); if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error); setData(body.request);
    }).catch((caught) => { if (!controller.signal.aborted) { setData(null); setError(caught instanceof Error ? caught.message : "Não foi possível carregar."); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [token, store]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitPendingRef.current) return;
    submitPendingRef.current = true; setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch(`/api/public/avaliacoes/${encodeURIComponent(token)}?loja=${encodeURIComponent(store)}`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...values, rating }) });
      const body = await response.json();
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) setData(null); throw new Error(body.error); }
      setDone(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível enviar."); }
    finally { submitPendingRef.current = false; setBusy(false); }
  }
  if (busy && !data) return <main className="review-page"><section><p role="status">Carregando convite seguro…</p></section></main>;
  if (error && !data) return <main className="review-page"><section><h1>Este convite não está disponível</h1><p role="alert">{error}</p><Link href="/">Voltar ao site</Link></section></main>;
  if (done || data?.review) return <main className="review-page"><section><span>AVALIAÇÃO VERIFICADA</span><h1>Obrigado pela sua avaliação</h1><p>Sua experiência ajuda outros clientes e melhora nosso atendimento.</p><Link href="/">Continuar navegando</Link></section></main>;
  return <main className="review-page"><form onSubmit={submit} aria-busy={busy}><span>COMPRA VERIFICADA · {data?.orderNumber}</span><h1>Avalie {data?.product.name}</h1><p>Olá, {data?.customerName}. Conte como foi sua experiência com este produto.</p><fieldset disabled={busy}><legend>Sua nota</legend><div>{[1,2,3,4,5].map((value) => <button type="button" className={value <= rating ? "active" : ""} aria-label={`${value} estrela${value > 1 ? "s" : ""}`} aria-pressed={value === rating} onClick={() => setRating(value)} key={value}>★</button>)}</div></fieldset><label>Título<input name="title" maxLength={120} placeholder="Resuma sua experiência"/></label><label>Comentário<textarea name="content" minLength={10} maxLength={3000} required placeholder="O que você mais gostou? O produto atendeu às expectativas?"/></label>{error && <p className="review-error" role="alert">{error}</p>}<button className="review-submit" disabled={busy}>{busy ? "Enviando…" : "Publicar avaliação"}</button><small>Somente seu primeiro nome será exibido. Seu e-mail não será publicado.</small></form></main>;
}
