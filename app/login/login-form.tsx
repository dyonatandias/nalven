"use client";

import Link from "next/link";
import { type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthField, AuthMessage, AuthPasswordField, AuthScreen, authFailure, authJson, authStyles as styles, useAuthSubmission } from "@/components/auth/auth-ui";
import { safeInviteReturnTo } from "@/components/auth/safe-return";

export default function LoginForm({ returnTo, passwordChanged = false }: { returnTo?: string; passwordChanged?: boolean }) {
  const router = useRouter();
  const { busy, error, setError, begin, finish } = useAuthSubmission();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!begin()) return;
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: String(form.get("email") || "").trim(), password: form.get("password"), remember: form.get("remember") === "on" }) });
      const data = await authJson(response, "Não foi possível entrar. Tente novamente.");
      if (!data.user || typeof data.user !== "object" || !("role" in data.user)) throw new Error("Não foi possível confirmar o acesso. Tente novamente.");
      // Keep submission locked until this authentication navigation completes.
      router.replace(data.user.role === "superadmin" ? "/admin" : safeInviteReturnTo(returnTo) || "/erp");
      router.refresh();
    } catch (reason) { setError(authFailure(reason, "Falha de conexão. Verifique sua rede e tente novamente.")); finish(); }
  }
  return <AuthScreen split kicker="ACESSO SEGURO" title="Bem-vindo de volta" description="Entre com os dados da sua conta para continuar." footer={<>Ainda não tem conta? <Link href="/cadastro">Criar conta</Link></>}>
    {passwordChanged && <AuthMessage kind="success" focus={false}>Senha alterada. Entre com sua nova senha.</AuthMessage>}
    {safeInviteReturnTo(returnTo) && <AuthMessage kind="info" focus={false}>Entre com o e-mail que recebeu o convite. Depois, confirme sua entrada na organização.</AuthMessage>}
    <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      <AuthField label="E-mail" name="email" type="email" required autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} placeholder="voce@empresa.com.br" disabled={busy} />
      <AuthPasswordField label="Senha" disabled={busy} />
      <div className={styles.options}><label className={styles.checkbox}><input name="remember" type="checkbox" disabled={busy} />Permanecer conectado por 30 dias</label><Link className={styles.link} href="/esqueci-senha">Esqueci minha senha</Link></div>
      <small className={styles.hint}>Em um computador compartilhado, deixe essa opção desmarcada.</small>
      {error && <AuthMessage>{error}</AuthMessage>}
      <button className={styles.submit} disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
    </form>
  </AuthScreen>;
}
