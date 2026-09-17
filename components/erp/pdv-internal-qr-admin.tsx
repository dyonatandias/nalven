"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useRef, useState } from "react";

type QrKind = "customer" | "held_cart" | "coupon" | "gift_card" | "order" | "receipt";
type QrTarget = { id: string; label: string };
type QrRecord = { id: string; branchId: number; kind: QrKind; reference: string; keyId: string; status: string; expiresAt: string; revokedAt: string | null; revokeReason: string | null; createdAt: string };
type QrData = { branchId: number; issuances: QrRecord[]; targets: Record<QrKind, QrTarget[]> };

const labels: Record<QrKind, string> = { customer: "Cliente", held_cart: "Carrinho suspenso", coupon: "Cupom", gift_card: "Gift card", order: "Pedido", receipt: "Recibo" };
const kinds: QrKind[] = ["customer", "held_cart", "coupon", "gift_card", "receipt"];

export function PdvInternalQrAdmin({ branchId }: { branchId: number }) {
  const [data, setData] = useState<QrData | null>(null);
  const [kind, setKind] = useState<QrKind>("customer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [token, setToken] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/erp/pdv/internal-qrs?branchId=${branchId}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível carregar os QR internos.");
      setData(body as QrData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os QR internos.");
    }
  }, [branchId]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void load()); return () => window.cancelAnimationFrame(frame); }, [load]);

  async function mutate(logicalId: string, payload: Record<string, unknown>) {
    if (busy) return null;
    const signature = JSON.stringify(payload), current = attempts.current[logicalId];
    const attempt = current?.signature === signature ? current : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true); setError(""); setNotice(""); setToken("");
    try {
      const response = await fetch("/api/erp/pdv/internal-qrs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível gerir o QR interno.");
      delete attempts.current[logicalId];
      const revealed = stringValue(body.token);
      if (revealed) setToken(revealed);
      else if (payload.action === "qr.issue" && body.replayed === true) setNotice("O QR já foi emitido, mas o token não pode ser reexibido. Revogue o registro e emita outro se ele não foi entregue.");
      else setNotice("QR interno revogado.");
      await load();
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerir o QR interno.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <section className="pos-admin-create"><h3>QR internos assinados</h3><p>{error || "Carregando QR internos…"}</p></section>;
  const targets = data.targets[kind] || [];

  return <section className="pos-value-admin" aria-labelledby="pos-internal-qr-title">
    <header><div><h3 id="pos-internal-qr-title">QR internos assinados</h3><p>Cliente, carrinho, cupom, vale e recibo com escopo de filial, expiração, rotação de chave e revogação. Pedido permanece bloqueado até a conversão possuir claim atômico.</p></div></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {notice && <p className="tenant-success" role="status">{notice}</p>}
    {token && <aside className="pos-admin-secret" role="status"><div><strong>Token do QR (exibição única)</strong><small>Copie para o emissor ou impressão de QR autorizada. O servidor guarda apenas o hash e o replay não devolve o token.</small><code>{token}</code></div><button type="button" onClick={() => void navigator.clipboard.writeText(token).then(() => setNotice("Token copiado."), () => setError("Não foi possível copiar automaticamente."))}>Copiar</button><button type="button" onClick={() => setToken("")}>Ocultar</button></aside>}

    <form className="pos-admin-row" onSubmit={event => {
      event.preventDefault(); const element = event.currentTarget, form = new FormData(element), entityId = String(form.get("entityId") || "");
      const expiresAt = localIso(form.get("expiresAt"));
      void mutate("qr.issue", { action: "qr.issue", branchId, kind, reference: `${kind}:${entityId}`, expiresAt }).then(result => { if (result) element.reset(); });
    }}><strong>Emitir QR</strong><label>Tipo<select name="kind" value={kind} onChange={event => setKind(event.target.value as QrKind)} disabled={busy}>{kinds.map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label><label>Destino<select key={kind} name="entityId" required disabled={busy || !targets.length}><option value="">Selecione</option>{targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label><label>Expiração<input key={`expiry:${kind}`} name="expiresAt" type="datetime-local" defaultValue={defaultExpiry(kind)} required disabled={busy} /></label><button className="primary" disabled={busy || !targets.length}>Emitir</button>{!targets.length && <small>Não há destinos ativos desse tipo na filial.</small>}</form>

    <div className="pos-admin-list">{data.issuances.map(qr => <article key={qr.id}><header><div><h4>{labels[qr.kind]} · {qr.reference.slice(qr.reference.indexOf(":") + 1)}</h4><small>{qr.status} · chave {qr.keyId} · emitido {formatDate(qr.createdAt)} · expira {formatDate(qr.expiresAt)}</small></div>{qr.status === "active" && <button type="button" disabled={busy} onClick={() => { const reason = window.prompt("Motivo da revogação (mínimo de 8 caracteres):", "Substituição controlada do QR"); if (reason?.trim()) void mutate(`qr.revoke:${qr.id}`, { action: "qr.revoke", qrId: qr.id, reason: reason.trim() }); }}>Revogar</button>}</header>{qr.revokeReason && <p>Motivo: {qr.revokeReason}</p>}</article>)}{!data.issuances.length && <p className="tenant-empty">Nenhum QR interno emitido nesta filial.</p>}</div>
  </section>;
}

function defaultExpiry(kind: QrKind) {
  const duration = kind === "held_cart" ? 60 * 60_000 : kind === "coupon" || kind === "order" ? 7 * 86_400_000 : 365 * 86_400_000;
  const value = new Date(Date.now() + duration), local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function localIso(value: FormDataEntryValue | null) { const result = new Date(String(value || "")); if (!Number.isFinite(result.valueOf())) throw new Error("Expiração inválida."); return result.toISOString(); }
function formatDate(value: string) { return new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone() }); }
async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
