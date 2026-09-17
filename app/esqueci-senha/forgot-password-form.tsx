"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthField, AuthMessage, AuthScreen, authFailure, authJson, authStyles as styles, useAuthSubmission } from "@/components/auth/auth-ui";

export default function ForgotPasswordForm() {
  const { busy, error, setError, begin, finish } = useAuthSubmission();
  const [sent, setSent] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!begin()) return;
    const form = new FormData(event.currentTarget);
    try {
      await authJson(await fetch("/api/auth/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: String(form.get("email") || "").trim() }) }), "Não foi possível solicitar a recuperação. Tente novamente.");
      setSent(true);
    } catch (reason) { setError(authFailure(reason, "Falha de conexão. Verifique sua rede e tente novamente.")); }
    finally { finish(); }
  }
  return <AuthScreen kicker="RECUPERAÇÃO DE ACESSO" title="Esqueceu sua senha?" description="Informe seu e-mail. Se ele estiver cadastrado, enviaremos um link seguro válido por 30 minutos." footer={<Link href="/login">Voltar para o login</Link>}>
    {sent ? <div className={styles.actions}>
      <AuthMessage kind="success">Se o e-mail estiver cadastrado, você receberá as instruções para redefinir a senha.</AuthMessage>
      <p className={styles.hint}>Verifique também a pasta de spam. Por segurança, esta mensagem não confirma a existência de uma conta.</p>
      <button type="button" className={styles.secondary} onClick={() => setSent(false)}>Usar outro e-mail</button>
    </div> : <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      <AuthField label="E-mail" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} placeholder="voce@empresa.com.br" required disabled={busy} />
      {error && <AuthMessage>{error}</AuthMessage>}
      <button className={styles.submit} disabled={busy}>{busy ? "Enviando…" : "Enviar instruções"}</button>
    </form>}
  </AuthScreen>;
}
