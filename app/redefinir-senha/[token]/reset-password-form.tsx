"use client";

import Link from "next/link";
import { type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthMessage, AuthPasswordField, AuthScreen, authFailure, authJson, authPasswordError, authStyles as styles, useAuthSubmission } from "@/components/auth/auth-ui";

export default function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const { busy, error, setError, begin, finish } = useAuthSubmission();
  const validToken = /^[A-Za-z0-9_-]{32,256}$/.test(token);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validToken || !begin()) return;
    const form = new FormData(event.currentTarget);
    const passwordError = authPasswordError(form);
    if (passwordError) { setError(passwordError); finish(); return; }
    try {
      await authJson(await fetch("/api/auth/reset-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: form.get("password") }) }), "Não foi possível redefinir sua senha. Solicite um novo link se este expirou.");
      router.replace("/login?senha=alterada");
    } catch (reason) { setError(authFailure(reason, "Falha de conexão. Verifique sua rede e tente novamente.")); finish(); }
  }
  return <AuthScreen kicker="NOVA SENHA" title="Redefina sua senha" description="Escolha uma senha exclusiva. Após a alteração, será necessário entrar novamente nos seus dispositivos." footer={<Link href="/login">Voltar para o login</Link>}>
    {validToken ? <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      <AuthPasswordField label="Nova senha" newPassword disabled={busy} />
      <AuthPasswordField label="Confirmar senha" name="confirmation" newPassword confirmation disabled={busy} />
      {error && <AuthMessage>{error}</AuthMessage>}
      <button className={styles.submit} disabled={busy}>{busy ? "Salvando…" : "Salvar nova senha"}</button>
      <Link className={styles.link} href="/esqueci-senha">Link expirou? Solicitar outro</Link>
    </form> : <div className={styles.actions}><AuthMessage>Este link de recuperação é inválido.</AuthMessage><Link className={styles.secondary} href="/esqueci-senha">Solicitar um novo link</Link></div>}
  </AuthScreen>;
}
