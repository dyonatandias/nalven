"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Branch = { id: number; code: string; name: string; status: string };
type Conditions = { productIds?: number[]; categoryIds?: number[]; minimumQuantity?: number; couponRequired?: boolean };
type Effect = { type: "fixed"; discountCents: number } | { type: "percentage"; percentageBasisPoints: number; maximumDiscountCents?: number | null };
type Coupon = { id: string; promotionId: string; codeLastFour: string; status: string; usageLimit: number | null; usedCount: number; expiresAt: string | null; createdAt: string };
type Promotion = {
  id: string; branchId: number | null; name: string; description: string | null; priority: number; status: string;
  startsAt: string; endsAt: string | null; usageLimit: number | null; perCustomerLimit: number | null;
  conditions: Conditions; effect: Effect; redemptionCount: number; coupons?: Coupon[];
};
type PromotionData = { branchId: number; branches: Branch[]; promotions: Promotion[] };

export function PdvPromotionsAdmin({ branchId, onChanged }: { branchId: number; onChanged(): Promise<void> }) {
  const [data, setData] = useState<PromotionData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealedCoupon, setRevealedCoupon] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/erp/pdv/promotions?branchId=${branchId}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível carregar promoções.");
      setData(body as PromotionData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar promoções.");
    }
  }, [branchId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function mutate(logicalId: string, payload: Record<string, unknown>, success: string) {
    if (busy) return null;
    const signature = JSON.stringify(payload), current = attempts.current[logicalId];
    const attempt = current?.signature === signature ? current : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true); setError(""); setNotice(""); setRevealedCoupon("");
    try {
      const response = await fetch("/api/erp/pdv/promotions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível salvar a promoção.");
      delete attempts.current[logicalId];
      const couponCode = stringValue(body.couponCode);
      if (couponCode) setRevealedCoupon(couponCode);
      else if ((payload.action === "coupon.create" || payload.action === "coupon.rotate") && body.replayed === true) setNotice("A operação já foi concluída, mas o código não pode ser reexibido. Rotacione novamente se ele não foi copiado.");
      else setNotice(success);
      await Promise.all([load(), onChanged()]);
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a promoção.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <section className="pos-admin-create"><h3>Promoções e cupons</h3><p>{error || "Carregando promoções…"}</p></section>;

  return <section className="pos-promotion-admin" aria-labelledby="pos-promotion-admin-title">
    <header><div><h3 id="pos-promotion-admin-title">Promoções e cupons</h3><p>Regras exclusivas, calculadas no servidor e auditadas. Valores monetários são inteiros em centavos.</p></div></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {notice && <p className="tenant-success" role="status">{notice}</p>}
    {revealedCoupon && <aside className="pos-admin-secret" role="status"><div><strong>Código do cupom (exibição única)</strong><small>Copie agora. O replay da operação não devolverá este código.</small><code>{revealedCoupon}</code></div><button type="button" onClick={() => void navigator.clipboard.writeText(revealedCoupon).then(() => setNotice("Cupom copiado."), () => setError("Não foi possível copiar automaticamente."))}>Copiar</button><button type="button" onClick={() => setRevealedCoupon("")}>Ocultar</button></aside>}

    <PromotionCreateForm branches={data.branches} defaultBranchId={branchId} busy={busy} mutate={mutate} />
    <div className="pos-promotion-list">{data.promotions.map((promotion) => <PromotionEditor key={promotion.id} promotion={promotion} branches={data.branches} busy={busy} mutate={mutate} />)}</div>
    {!data.promotions.length && <p>Nenhuma promoção global ou desta filial foi cadastrada.</p>}
  </section>;
}

type Mutate = (logicalId: string, payload: Record<string, unknown>, success: string) => Promise<Record<string, unknown> | null>;

function PromotionCreateForm({ branches, defaultBranchId, busy, mutate }: { branches: Branch[]; defaultBranchId: number; busy: boolean; mutate: Mutate }) {
  return <form className="pos-promotion-form" onSubmit={(event) => {
    event.preventDefault(); const element = event.currentTarget, form = new FormData(element);
    void mutate("promotion.create", promotionPayload(form, "promotion.create", branches, defaultBranchId), "Promoção criada.").then((body) => { if (body) element.reset(); });
  }}>
    <h4>Nova promoção</h4><PromotionFields branches={branches} defaultBranchId={defaultBranchId} busy={busy} />
    <button className="primary" disabled={busy}>Criar promoção</button>
  </form>;
}

function PromotionEditor({ promotion, branches, busy, mutate }: { promotion: Promotion; branches: Branch[]; busy: boolean; mutate: Mutate }) {
  return <article>
    <header><div><h4>{promotion.name}</h4><small>{promotion.branchId == null ? "Todas as filiais" : promotionBranchName(promotion, branches)} · {promotion.status} · {promotion.redemptionCount} resgates</small></div>{promotion.status !== "inactive" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Desativar a promoção ${promotion.name}?`)) void mutate(`promotion.deactivate:${promotion.id}`, { action: "promotion.deactivate", promotionId: promotion.id }, "Promoção desativada."); }}>Desativar</button>}</header>
    <form className="pos-promotion-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void mutate(`promotion.update:${promotion.id}`, { promotionId: promotion.id, ...promotionPayload(form, "promotion.update", branches, promotion.branchId) }, "Promoção atualizada."); }}>
      <PromotionFields branches={branches} defaultBranchId={promotion.branchId} promotion={promotion} busy={busy} />
      <button disabled={busy}>Salvar promoção</button>
    </form>
    <CouponCreate promotionId={promotion.id} busy={busy} mutate={mutate} />
    <div className="pos-coupon-list">{promotion.coupons?.map((coupon) => <CouponEditor key={coupon.id} coupon={coupon} busy={busy} mutate={mutate} />)}</div>
  </article>;
}

function PromotionFields({ branches, defaultBranchId, promotion, busy }: { branches: Branch[]; defaultBranchId: number | null; promotion?: Promotion; busy: boolean }) {
  const conditions = promotion?.conditions || {}, effect = promotion?.effect;
  return <>
    <label>Filial<select name="branchId" defaultValue={defaultBranchId ?? ""} disabled={busy}><option value="">Todas as filiais</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
    <label>Nome<input name="name" required minLength={2} maxLength={160} defaultValue={promotion?.name || ""} disabled={busy} /></label>
    <label>Descrição<input name="description" maxLength={1000} defaultValue={promotion?.description || ""} disabled={busy} /></label>
    <label>Status<select name="status" defaultValue={promotion?.status || "draft"} disabled={busy}><option value="draft">Rascunho</option><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>
    <label>Prioridade<input name="priority" type="number" min={-1000000} max={1000000} step="1" defaultValue={promotion?.priority ?? 0} disabled={busy} /></label>
    <label>Início<input name="startsAt" type="datetime-local" required defaultValue={localDateTime(promotion?.startsAt || new Date().toISOString())} disabled={busy} /></label>
    <label>Término<input name="endsAt" type="datetime-local" defaultValue={localDateTime(promotion?.endsAt)} disabled={busy} /></label>
    <label>Limite global<input name="usageLimit" type="number" min="0" step="1" defaultValue={promotion?.usageLimit ?? ""} disabled={busy} /></label>
    <label>Limite por cliente<input name="perCustomerLimit" type="number" min="0" step="1" defaultValue={promotion?.perCustomerLimit ?? ""} disabled={busy} /></label>
    <label>IDs de produtos<input name="productIds" inputMode="numeric" placeholder="12, 34" defaultValue={conditions.productIds?.join(", ") || ""} disabled={busy} /></label>
    <label>IDs de categorias<input name="categoryIds" inputMode="numeric" placeholder="3, 8" defaultValue={conditions.categoryIds?.join(", ") || ""} disabled={busy} /></label>
    <label>Quantidade mínima<input name="minimumQuantity" type="number" min="0.000001" step="0.000001" defaultValue={conditions.minimumQuantity ?? ""} disabled={busy} /></label>
    <label>Exige cupom<select name="couponRequired" defaultValue={conditions.couponRequired ? "yes" : "no"} disabled={busy}><option value="no">Não</option><option value="yes">Sim</option></select></label>
    <label>Tipo de desconto<select name="effectType" defaultValue={effect?.type || "percentage"} disabled={busy}><option value="percentage">Percentual</option><option value="fixed">Valor fixo</option></select></label>
    <label>Percentual (pontos-base)<input name="percentageBasisPoints" type="number" min="1" max="10000" step="1" defaultValue={effect?.type === "percentage" ? effect.percentageBasisPoints : 1000} disabled={busy} /></label>
    <label>Teto (centavos)<input name="maximumDiscountCents" type="number" min="1" step="1" defaultValue={effect?.type === "percentage" ? effect.maximumDiscountCents ?? "" : ""} disabled={busy} /></label>
    <label>Valor fixo (centavos)<input name="discountCents" type="number" min="1" step="1" defaultValue={effect?.type === "fixed" ? effect.discountCents : 100} disabled={busy} /></label>
  </>;
}

function CouponCreate({ promotionId, busy, mutate }: { promotionId: string; busy: boolean; mutate: Mutate }) {
  return <form className="pos-coupon-form" onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget, form = new FormData(element); void mutate(`coupon.create:${promotionId}`, { action: "coupon.create", promotionId, code: form.get("code"), status: "active", usageLimit: nullableInteger(form.get("usageLimit")), expiresAt: isoDate(form.get("expiresAt"), false) }, "Cupom criado.").then((body) => { if (body) element.reset(); }); }}>
    <strong>Novo cupom</strong><label>Código<input name="code" minLength={4} maxLength={64} autoComplete="off" required disabled={busy} /></label><label>Limite<input name="usageLimit" type="number" min="0" step="1" disabled={busy} /></label><label>Expiração<input name="expiresAt" type="datetime-local" disabled={busy} /></label><button disabled={busy}>Criar e revelar</button>
  </form>;
}

function CouponEditor({ coupon, busy, mutate }: { coupon: Coupon; busy: boolean; mutate: Mutate }) {
  return <section>
    <form className="pos-coupon-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void mutate(`coupon.update:${coupon.id}`, { action: "coupon.update", couponId: coupon.id, status: form.get("status"), usageLimit: nullableInteger(form.get("usageLimit")), expiresAt: isoDate(form.get("expiresAt"), false) }, "Cupom atualizado."); }}>
      <strong>•••• {coupon.codeLastFour}</strong><label>Status<select name="status" defaultValue={coupon.status} disabled={busy}><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label><label>Uso<input value={coupon.usedCount} readOnly aria-label="Usos do cupom" /></label><label>Limite<input name="usageLimit" type="number" min="0" step="1" defaultValue={coupon.usageLimit ?? ""} disabled={busy} /></label><label>Expiração<input name="expiresAt" type="datetime-local" defaultValue={localDateTime(coupon.expiresAt)} disabled={busy} /></label><button disabled={busy}>Salvar</button>{coupon.status !== "inactive" && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Desativar este cupom?")) void mutate(`coupon.deactivate:${coupon.id}`, { action: "coupon.deactivate", couponId: coupon.id }, "Cupom desativado."); }}>Desativar</button>}
    </form>
    <form className="pos-coupon-rotate" onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget, form = new FormData(element); if (!window.confirm("Rotacionar o código? O código atual deixará de funcionar imediatamente.")) return; void mutate(`coupon.rotate:${coupon.id}`, { action: "coupon.rotate", couponId: coupon.id, code: form.get("code") }, "Cupom rotacionado.").then((body) => { if (body) element.reset(); }); }}><label>Novo código<input name="code" minLength={4} maxLength={64} autoComplete="off" required disabled={busy} /></label><button disabled={busy}>Rotacionar e revelar</button></form>
  </section>;
}

function promotionPayload(form: FormData, action: "promotion.create" | "promotion.update", branches: Branch[], fallbackBranchId: number | null) {
  const branchId = nullableInteger(form.get("branchId"));
  if (branchId != null && !branches.some((branch) => branch.id === branchId)) throw new Error("Filial inválida.");
  const effectType = String(form.get("effectType"));
  const conditions: Conditions = {};
  const productIds = idList(form.get("productIds")), categoryIds = idList(form.get("categoryIds")), minimumQuantity = nullableDecimal(form.get("minimumQuantity"));
  if (productIds.length) conditions.productIds = productIds;
  if (categoryIds.length) conditions.categoryIds = categoryIds;
  if (minimumQuantity != null) conditions.minimumQuantity = minimumQuantity;
  if (form.get("couponRequired") === "yes") conditions.couponRequired = true;
  const effect = effectType === "fixed"
    ? { type: "fixed", discountCents: requiredInteger(form.get("discountCents")) }
    : { type: "percentage", percentageBasisPoints: requiredInteger(form.get("percentageBasisPoints")), maximumDiscountCents: nullableInteger(form.get("maximumDiscountCents")) };
  return { action, branchId: branchId ?? (form.get("branchId") === "" ? null : fallbackBranchId), name: form.get("name"), description: nullableString(form.get("description")), priority: requiredInteger(form.get("priority")), status: form.get("status"), startsAt: isoDate(form.get("startsAt"), true), endsAt: isoDate(form.get("endsAt"), false), usageLimit: nullableInteger(form.get("usageLimit")), perCustomerLimit: nullableInteger(form.get("perCustomerLimit")), conditions, effect };
}

async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function nullableString(value: FormDataEntryValue | null) { const result = String(value || "").trim(); return result || null; }
function requiredInteger(value: FormDataEntryValue | null) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Informe valores inteiros válidos."); return result; }
function nullableInteger(value: FormDataEntryValue | null) { return value == null || value === "" ? null : requiredInteger(value); }
function nullableDecimal(value: FormDataEntryValue | null) { if (value == null || value === "") return null; const result = Number(value); if (!Number.isFinite(result) || result <= 0) throw new Error("Quantidade mínima inválida."); return result; }
function idList(value: FormDataEntryValue | null) { const source = String(value || "").trim(); if (!source) return []; const ids = [...new Set(source.split(",").map((item) => Number(item.trim())))]; if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("IDs de produto/categoria inválidos."); return ids.sort((a, b) => a - b); }
function isoDate(value: FormDataEntryValue | null, required: boolean) { const source = String(value || ""); if (!source) { if (required) throw new Error("Informe a vigência da promoção."); return null; } const result = new Date(source); if (!Number.isFinite(result.getTime())) throw new Error("Data inválida."); return result.toISOString(); }
function localDateTime(value: string | null | undefined) { if (!value) return ""; const date = new Date(value); if (!Number.isFinite(date.getTime())) return ""; const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function promotionBranchName(promotion: Promotion, branches: Branch[]) { return branches.find((branch) => branch.id === promotion.branchId)?.name || `Filial ${promotion.branchId}`; }
