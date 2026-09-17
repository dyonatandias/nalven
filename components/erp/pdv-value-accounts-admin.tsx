"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useRef, useState } from "react";
import { PdvValueLiabilityAdmin } from "@/components/erp/pdv-value-liability-admin";

type Branch = { id: number; code: string; name: string };
type Customer = { id: number; name: string };
type Program = { id: string; branchId: number; name: string; kind: "loyalty_points" | "cashback"; status: string; earnUnits: number; spendCents: number; redeemCentsPerUnit: number; expiresAfterDays: number | null };
type Entry = { id: string; type: string; amountUnits: string; balanceDeltaUnits: string; reservedDeltaUnits: string; balanceBeforeUnits: string; balanceAfterUnits: string; referenceType: string; referenceId: string; actor: string; reason: string | null; createdAt: string; reversed: boolean };
type Reservation = { id: string; amountUnits: string; state: string; referenceType: string; referenceId: string; expiresAt: string; completedAt: string | null };
type Account = {
  id: string; branchId: number; customerId: number | null; programId: string | null; kind: "loyalty_points" | "cashback" | "gift_card" | "store_credit"; unit: "points" | "cents";
  label: string; status: string; codeLastFour: string | null; balanceUnits: string; reservedUnits: string; availableUnits: string; expiresAt: string | null;
  customer: Customer | null; program: Pick<Program, "id" | "name" | "kind" | "status"> | null; entries: Entry[]; reservations: Reservation[];
};
type ValueData = { branchId: number; branches: Branch[]; customers: Customer[]; programs: Program[]; accounts: Account[] };

export function PdvValueAccountsAdmin({ branchId, onChanged }: { branchId: number; onChanged(): Promise<void> }) {
  const [data, setData] = useState<ValueData | null>(null);
  const [issueKind, setIssueKind] = useState<Account["kind"]>("loyalty_points");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [giftCode, setGiftCode] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/erp/pdv/value-accounts?branchId=${branchId}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível carregar fidelidade e valores.");
      setData(body as ValueData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar fidelidade e valores.");
    }
  }, [branchId]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void load()); return () => window.cancelAnimationFrame(frame); }, [load]);

  async function mutate(logicalId: string, payload: Record<string, unknown>, success: string) {
    if (busy) return null;
    const signature = JSON.stringify(payload), current = attempts.current[logicalId];
    const attempt = current?.signature === signature ? current : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true); setError(""); setNotice(""); setGiftCode("");
    try {
      const response = await fetch("/api/erp/pdv/value-accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível movimentar o valor.");
      delete attempts.current[logicalId];
      const revealed = stringValue(body.giftCode);
      if (revealed) setGiftCode(revealed);
      else if (payload.action === "value.account.issue" && payload.kind === "gift_card" && body.replayed === true) setNotice("O gift card já foi emitido, mas o código não pode ser reexibido. Emita outro somente se este não foi entregue.");
      else setNotice(success);
      await Promise.all([load(), onChanged()]);
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível movimentar o valor.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <section className="pos-admin-create"><h3>Fidelidade e valores</h3><p>{error || "Carregando contas…"}</p></section>;
  const compatiblePrograms = data.programs.filter(program => program.kind === issueKind && program.status === "active");

  return <section className="pos-value-admin" aria-labelledby="pos-value-admin-title">
    <header><div><h3 id="pos-value-admin-title">Fidelidade, gift card e crédito-loja</h3><p>Contas por filial com reservas, estornos compensatórios e ledger imutável. Valores monetários são centavos inteiros.</p></div></header>
    {error && <p className="tenant-error" role="alert">{error}</p>}
    {notice && <p className="tenant-success" role="status">{notice}</p>}
    {giftCode && <aside className="pos-admin-secret" role="status"><div><strong>Código do gift card (exibição única)</strong><small>Copie agora. O replay nunca devolverá o código; o PIN informado também não é armazenado em texto aberto.</small><code>{giftCode}</code></div><button type="button" onClick={() => void navigator.clipboard.writeText(giftCode).then(() => setNotice("Código copiado."), () => setError("Não foi possível copiar automaticamente."))}>Copiar</button><button type="button" onClick={() => setGiftCode("")}>Ocultar</button></aside>}

    <PdvValueLiabilityAdmin branchId={branchId} />

    <form className="pos-admin-row" onSubmit={event => {
      event.preventDefault(); const element = event.currentTarget, form = new FormData(element);
      void mutate("value.program.create", {
        action: "value.program.create", branchId, name: form.get("name"), kind: form.get("kind"), earnUnits: requiredInteger(form.get("earnUnits")),
        spendCents: requiredInteger(form.get("spendCents")), redeemCentsPerUnit: requiredInteger(form.get("redeemCentsPerUnit")), expiresAfterDays: nullableInteger(form.get("expiresAfterDays")),
      }, "Programa criado.").then(result => { if (result) element.reset(); });
    }}><strong>Novo programa</strong><label>Nome<input name="name" minLength={2} maxLength={160} required disabled={busy} /></label><label>Tipo<select name="kind" disabled={busy}><option value="loyalty_points">Pontos</option><option value="cashback">Cashback</option></select></label><label>Ganha unidades<input name="earnUnits" type="number" min="1" step="1" defaultValue="1" required disabled={busy} /></label><label>A cada centavos<input name="spendCents" type="number" min="1" step="1" defaultValue="100" required disabled={busy} /></label><label>Resgate centavos/unidade<input name="redeemCentsPerUnit" type="number" min="1" step="1" defaultValue="1" required disabled={busy} /></label><label>Validade em dias<input name="expiresAfterDays" type="number" min="1" step="1" disabled={busy} /></label><button className="primary" disabled={busy}>Criar programa</button></form>

    <div className="pos-admin-list">{data.programs.map(program => <article key={program.id}><header><div><h4>{program.name}</h4><small>{program.kind === "loyalty_points" ? "Pontos" : "Cashback"} · {program.earnUnits} unidade(s) a cada {formatCents(program.spendCents)} · resgate {formatCents(program.redeemCentsPerUnit)}/unidade · {program.status}</small></div>{program.status === "active" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Desativar ${program.name}? Contas existentes permanecem com saldo, mas novas emissões serão bloqueadas.`)) void mutate(`value.program.deactivate:${program.id}`, { action: "value.program.deactivate", programId: program.id }, "Programa desativado."); }}>Desativar</button>}</header></article>)}</div>

    <form className="pos-admin-row" onSubmit={event => {
      event.preventDefault(); const element = event.currentTarget, form = new FormData(element), kind = String(form.get("kind")) as Account["kind"];
      void mutate("value.account.issue", {
        action: "value.account.issue", branchId, kind, label: form.get("label"), initialUnits: requiredInteger(form.get("initialUnits")),
        customerId: nullableInteger(form.get("customerId")), programId: nullableString(form.get("programId")), expiresAt: isoDate(form.get("expiresAt")), pin: nullableString(form.get("pin")),
      }, "Conta emitida.").then(result => { if (result) element.reset(); });
    }}><strong>Emitir conta</strong><label>Tipo<select name="kind" value={issueKind} onChange={event => setIssueKind(event.target.value as Account["kind"])} disabled={busy}><option value="loyalty_points">Pontos</option><option value="cashback">Cashback</option><option value="gift_card">Gift card</option><option value="store_credit">Crédito-loja</option></select></label><label>Identificação<input name="label" minLength={2} maxLength={160} required disabled={busy} /></label><label>Cliente<select name="customerId" required={issueKind !== "gift_card"} disabled={busy}><option value="">{issueKind === "gift_card" ? "Sem vínculo" : "Selecione"}</option>{data.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>{["loyalty_points", "cashback"].includes(issueKind) && <label>Programa<select name="programId" required disabled={busy}><option value="">Selecione</option>{compatiblePrograms.map(program => <option key={program.id} value={program.id}>{program.name}</option>)}</select></label>}<label>Saldo inicial ({issueKind === "loyalty_points" ? "pontos" : "centavos"})<input name="initialUnits" type="number" min={issueKind === "gift_card" ? 1 : 0} step="1" defaultValue={issueKind === "gift_card" ? 1000 : 0} required disabled={busy} /></label><label>Expiração<input name="expiresAt" type="datetime-local" disabled={busy} /></label>{issueKind === "gift_card" && <label>PIN (6–12 dígitos)<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{6,12}" minLength={6} maxLength={12} autoComplete="new-password" required disabled={busy} /></label>}<button className="primary" disabled={busy}>Emitir</button></form>

    <div className="pos-admin-list">{data.accounts.map(account => <AccountEditor key={account.id} account={account} busy={busy} mutate={mutate} />)}{!data.accounts.length && <p className="tenant-empty">Nenhuma conta de valor nesta filial.</p>}</div>
  </section>;
}

type Mutate = (logicalId: string, payload: Record<string, unknown>, success: string) => Promise<Record<string, unknown> | null>;

function AccountEditor({ account, busy, mutate }: { account: Account; busy: boolean; mutate: Mutate }) {
  const unitLabel = account.unit === "cents" ? "centavos" : "pontos";
  return <article><header><div><h4>{account.label}</h4><small>{kindLabel(account.kind)} · {account.customer?.name || "sem cliente"}{account.codeLastFour ? ` · •••• ${account.codeLastFour}` : ""} · {account.status}</small></div><b>{formatUnits(account.availableUnits, account.unit)} disponível · {formatUnits(account.reservedUnits, account.unit)} reservado</b></header><p>Saldo total {formatUnits(account.balanceUnits, account.unit)} · expira {formatDate(account.expiresAt)} · programa {account.program?.name || "não aplicável"}</p>
    {account.status === "active" && <>
      <form className="pos-admin-row" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget), action = form.get("action"); void mutate(`${action}:${account.id}`, { action, branchId: account.branchId, accountId: account.id, amountUnits: requiredInteger(form.get("amountUnits")), reason: form.get("reason") }, "Saldo movimentado."); }}><strong>Crédito/débito</strong><label>Ação<select name="action" disabled={busy}><option value="value.account.credit">Creditar</option><option value="value.account.debit">Debitar</option></select></label><label>Valor ({unitLabel})<input name="amountUnits" type="number" min="1" step="1" required disabled={busy} /></label><label>Motivo<input name="reason" minLength={4} maxLength={500} required disabled={busy} /></label><button disabled={busy}>Movimentar</button></form>
      <form className="pos-admin-row" onSubmit={event => { event.preventDefault(); const element = event.currentTarget, form = new FormData(element); void mutate(`value.reservation.create:${account.id}`, { action: "value.reservation.create", branchId: account.branchId, accountId: account.id, amountUnits: requiredInteger(form.get("amountUnits")), referenceType: form.get("referenceType"), referenceId: form.get("referenceId"), expiresAt: isoDate(form.get("expiresAt")), reason: form.get("reason") }, "Saldo reservado.").then(result => { if (result) element.reset(); }); }}><strong>Reservar</strong><label>Valor ({unitLabel})<input name="amountUnits" type="number" min="1" step="1" required disabled={busy} /></label><label>Tipo referência<input name="referenceType" defaultValue="sale_draft" minLength={1} maxLength={80} required disabled={busy} /></label><label>Referência<input name="referenceId" maxLength={160} required disabled={busy} /></label><label>Expiração<input name="expiresAt" type="datetime-local" defaultValue={defaultReservationExpiry()} required disabled={busy} /></label><label>Motivo<input name="reason" minLength={4} maxLength={500} required disabled={busy} /></label><button disabled={busy}>Reservar</button></form>
    </>}
    <div className="pos-admin-children">{account.reservations.filter(reservation => reservation.state === "active").map(reservation => <section key={reservation.id}><span>Reserva {formatUnits(reservation.amountUnits, account.unit)} · {reservation.referenceType}/{reservation.referenceId} · expira {formatDateTime(reservation.expiresAt)}</span><button type="button" disabled={busy} onClick={() => void mutate(`value.reservation.capture:${reservation.id}`, { action: "value.reservation.capture", branchId: account.branchId, reservationId: reservation.id, referenceType: reservation.referenceType, referenceId: reservation.referenceId, reason: "Captura administrativa da reserva" }, "Reserva capturada.")}>Capturar</button><button type="button" disabled={busy} onClick={() => void mutate(`value.reservation.release:${reservation.id}`, { action: "value.reservation.release", branchId: account.branchId, reservationId: reservation.id, referenceType: reservation.referenceType, referenceId: reservation.referenceId, reason: "Liberação administrativa da reserva" }, "Reserva liberada.")}>Liberar</button></section>)}</div>
    <div className="pos-admin-children">{account.entries.map(entry => <section key={entry.id}><span>{entry.type} · {signedUnits(entry.balanceDeltaUnits, account.unit)} saldo / {signedUnits(entry.reservedDeltaUnits, account.unit)} reserva · {formatDateTime(entry.createdAt)} · {entry.reason || entry.referenceId}</span>{!entry.reversed && ["issue", "credit", "debit", "capture"].includes(entry.type) && BigInt(entry.amountUnits) > BigInt(0) && <form className="pos-admin-row" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (window.confirm("Criar lançamento compensatório? O histórico original permanecerá intacto.")) void mutate(`value.entry.reverse:${entry.id}`, { action: "value.entry.reverse", branchId: account.branchId, entryId: entry.id, reason: form.get("reason") }, "Estorno compensatório concluído."); }}><label>Motivo do estorno<input name="reason" minLength={4} maxLength={500} required disabled={busy} /></label><button disabled={busy}>Estornar</button></form>}</section>)}</div>
    {account.status === "active" && account.expiresAt && new Date(account.expiresAt) <= new Date() && BigInt(account.reservedUnits) === BigInt(0) && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Expirar esta conta e remover o saldo disponível por lançamento imutável?")) void mutate(`value.account.expire:${account.id}`, { action: "value.account.expire", branchId: account.branchId, accountId: account.id, reason: "Expiração administrativa conforme vigência" }, "Conta expirada."); }}>Processar expiração</button>}
  </article>;
}

async function responseBody(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function requiredInteger(value: FormDataEntryValue | null) { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new Error("Informe um valor inteiro válido."); return result; }
function nullableInteger(value: FormDataEntryValue | null) { return value == null || value === "" ? null : requiredInteger(value); }
function nullableString(value: FormDataEntryValue | null) { const result = String(value || "").trim(); return result || null; }
function isoDate(value: FormDataEntryValue | null) { const source = String(value || ""); if (!source) return null; const result = new Date(source); if (!Number.isFinite(result.getTime())) throw new Error("Data inválida."); return result.toISOString(); }
function defaultReservationExpiry() { const value = new Date(Date.now() + 15 * 60_000), local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function formatUnits(value: string, unit: Account["unit"]) { const amount = Number(value); return unit === "cents" ? formatCents(amount) : `${new Intl.NumberFormat("pt-BR").format(amount)} pts`; }
function signedUnits(value: string, unit: Account["unit"]) { const amount = BigInt(value); return `${amount > BigInt(0) ? "+" : ""}${formatUnits(value, unit)}`; }
function formatCents(value: number) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100); }
function formatDate(value: string | null) { return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: tenantTimeZone() }) : "sem validade"; }
function formatDateTime(value: string) { return new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone() }); }
function kindLabel(kind: Account["kind"]) { return kind === "loyalty_points" ? "Pontos" : kind === "cashback" ? "Cashback" : kind === "gift_card" ? "Gift card" : "Crédito-loja"; }
