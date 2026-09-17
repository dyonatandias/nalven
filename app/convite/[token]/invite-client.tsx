"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthField, AuthMessage, AuthPasswordField, AuthScreen, authFailure, authJson, authPasswordError, authStyles as styles, useAuthSubmission } from "@/components/auth/auth-ui";

type Invite = { email: string; name?: string | null; roleKey: string; organization: string; expiresAt: string; existingAccount: boolean };

export default function InviteClient({ token }: { token: string }) {
  const router = useRouter();
  const [invite, setInvite] = useState<Invite>();
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const { busy, error, setError, begin, finish } = useAuthSubmission();
  const validToken = /^[A-Za-z0-9_-]{40,100}$/.test(token);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setInvite(undefined); setLoadError(""); setLoading(true);
      try {
        if (!validToken) throw new Error("Este convite é inválido. Peça um novo link ao administrador da organização.");
        const body = await authJson(await fetch(`/api/auth/invite?token=${encodeURIComponent(token)}`, { cache: "no-store", signal: controller.signal }), "Convite indisponível. Peça um novo link ao administrador.");
        const record = body.invite;
        if (!record || typeof record !== "object" || !("email" in record) || typeof record.email !== "string" || !("organization" in record) || typeof record.organization !== "string" || !("expiresAt" in record) || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))) throw new Error("Não foi possível validar este convite. Tente novamente.");
        if (!controller.signal.aborted) setInvite(record as Invite);
      } catch (reason) { if (!controller.signal.aborted) setLoadError(authFailure(reason, "Falha de conexão ao validar o convite. Verifique sua rede e tente novamente.")); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [token, validToken, attempt]);
  async function accept(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!invite || !validToken || !begin()) return;
    const form = event ? new FormData(event.currentTarget) : new FormData();
    const passwordError = event ? authPasswordError(form) : "";
    if (passwordError) { setError(passwordError); finish(); return; }
    try {
      await authJson(await fetch("/api/auth/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: form.get("name"), password: form.get("password") }) }), "Não foi possível aceitar o convite.");
      // Invitation acceptance has one destination; never execute a server URL.
      router.replace("/erp"); router.refresh();
    } catch (reason) { setError(authFailure(reason, "Não foi possível confirmar o acesso. Verifique sua conexão e tente entrar antes de repetir.")); finish(); }
  }
  return <AuthScreen kicker="CONVITE PARA ORGANIZAÇÃO" title={invite?.organization || (loading ? "Validando convite" : "Convite indisponível")} description={invite ? <>Você foi convidado como <strong>{roleName(invite.roleKey)}</strong>.</> : undefined} footer={<Link href="/login">Voltar para o login</Link>}>
    {loading && <div className={styles.status} role="status">Validando seu convite com segurança…</div>}
    {loadError && <div className={styles.actions}><AuthMessage>{loadError}</AuthMessage>{validToken && <button className={styles.secondary} onClick={() => setAttempt(current => current + 1)} type="button">Tentar novamente</button>}</div>}
    {invite && <><dl className={styles.summary}><div><dt>E-mail autorizado</dt><dd>{invite.email}</dd></div><div><dt>Validade do convite</dt><dd>{new Date(invite.expiresAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</dd></div></dl>
      {invite.existingAccount ? <div className={styles.actions} aria-busy={busy}><p className={styles.hint}>Este e-mail já possui uma conta. Entre com o e-mail autorizado e retorne a este convite para confirmar o acesso.</p><Link className={styles.secondary} href={`/login?returnTo=${encodeURIComponent(`/convite/${token}`)}`}>Entrar na conta convidada</Link>{error && <AuthMessage>{error}</AuthMessage>}<button type="button" className={styles.submit} onClick={() => void accept()} disabled={busy}>{busy ? "Confirmando acesso…" : "Já entrei · aceitar convite"}</button></div>
        : <form className={styles.form} onSubmit={accept} aria-busy={busy}>
          <AuthField name="name" label="Nome completo" defaultValue={invite.name || ""} minLength={2} maxLength={160} autoComplete="name" required disabled={busy} />
          <AuthPasswordField label="Nova senha" newPassword disabled={busy} />
          <AuthPasswordField label="Confirmar senha" name="confirmation" newPassword confirmation disabled={busy} />
          {error && <AuthMessage>{error}</AuthMessage>}
          <button className={styles.submit} disabled={busy}>{busy ? "Criando acesso…" : "Aceitar convite e entrar"}</button>
        </form>}
    </>}
  </AuthScreen>;
}
function roleName(value: string) { return ({ admin: "Administrador", sales: "Vendas e atendimento", stock: "Suprimentos e operações", finance: "Financeiro", viewer: "Consulta" } as Record<string, string>)[value] || value; }
