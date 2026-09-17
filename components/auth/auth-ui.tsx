"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import styles from "./auth-ui.module.css";
import { isValidNewPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";

export { styles as authStyles };

export function AuthScreen({ title, description, kicker, children, footer, wide = false, split = false }: {
  title: string; description?: ReactNode; kicker: string; children: ReactNode; footer?: ReactNode; wide?: boolean; split?: boolean;
}) {
  const card = <section className={`${styles.card} ${wide ? styles.wide : ""}`} aria-labelledby="auth-title">
    {!split && <AuthBrand />}
    <header className={styles.heading}><small>{kicker}</small><h1 id="auth-title">{title}</h1>{description && <p>{description}</p>}</header>
    {children}
    {footer && <div className={styles.footer}>{footer}</div>}
  </section>;
  return <main className={`${styles.page} ${split ? styles.split : ""}`}>
    {split ? <><aside className={styles.brandPanel}><AuthBrand /><div><h2>Seu negócio inteiro, em um só lugar.</h2><p>Operação, estoque, vendas e finanças com acesso seguro e dados separados por organização.</p></div><small>© {new Date().getFullYear()} NALVEN</small></aside><div className={styles.formPanel}>{card}</div></> : card}
  </main>;
}

function AuthBrand() { return <Link className={styles.brand} href="/" aria-label="NALVEN — página inicial">NAL<span>VEN</span></Link>; }

export function AuthMessage({ children, kind = "error", focus = true }: { children: ReactNode; kind?: "error" | "success" | "info"; focus?: boolean }) {
  const message = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) message.current?.focus(); }, [children, focus]);
  return <div ref={message} className={`${styles.message} ${styles[kind]}`} role={kind === "error" ? "alert" : "status"} tabIndex={-1}>{children}</div>;
}

export function AuthField({ label, hint, className = "", ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; className?: string }) {
  const id = useId();
  return <div className={`${styles.field} ${className}`}><label htmlFor={id}>{label}</label><input {...input} id={id} aria-describedby={hint ? `${id}-hint` : input["aria-describedby"]} />{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}

export const NEW_PASSWORD_HINT = PASSWORD_POLICY_MESSAGE;
export const NEW_PASSWORD_PATTERN = "(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{12,256}";

export function AuthPasswordField({ label, name = "password", disabled, newPassword = false, confirmation = false }: {
  label: string; name?: string; disabled?: boolean; newPassword?: boolean; confirmation?: boolean;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  return <div className={styles.field}>
    <label htmlFor={id}>{label}</label>
    <div className={styles.password}><input id={id} name={name} type={shown ? "text" : "password"} autoComplete={newPassword ? "new-password" : "current-password"} minLength={newPassword ? 12 : undefined} maxLength={256} pattern={newPassword ? NEW_PASSWORD_PATTERN : undefined} title={newPassword ? NEW_PASSWORD_HINT : undefined} required disabled={disabled} autoCapitalize="none" spellCheck={false} aria-describedby={[newPassword && !confirmation ? `${id}-hint` : "", capsLock ? `${id}-caps` : ""].filter(Boolean).join(" ") || undefined} onKeyUp={event => setCapsLock(event.getModifierState("CapsLock"))} onKeyDown={event => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} />
      <button type="button" aria-controls={id} aria-pressed={shown} aria-label={`${shown ? "Ocultar" : "Mostrar"} ${label.toLocaleLowerCase("pt-BR")}`} disabled={disabled} onClick={() => setShown(current => !current)}>{shown ? "Ocultar" : "Mostrar"}</button>
    </div>
    {newPassword && !confirmation && <small id={`${id}-hint`}>{NEW_PASSWORD_HINT}</small>}
    {capsLock && <small id={`${id}-caps`} role="status">Caps Lock está ativado.</small>}
  </div>;
}

export function useAuthSubmission() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function begin() { if (pending.current) return false; pending.current = true; setBusy(true); setError(""); return true; }
  function finish() { pending.current = false; setBusy(false); }
  return { busy, error, setError, begin, finish };
}

export async function authJson(response: Response, fallback: string): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error(response.status === 429 ? "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente." : fallback); }
  if (!response.ok) {
    if (response.status === 429) throw new Error("Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.");
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : fallback;
    throw new Error(message);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(fallback);
  return data as Record<string, unknown>;
}

export function authFailure(error: unknown, fallback: string) { return error instanceof Error && error.name !== "TypeError" ? error.message : fallback; }

export function authPasswordError(form: FormData) {
  if (!isValidNewPassword(form.get("password"))) return PASSWORD_POLICY_MESSAGE;
  return form.get("password") !== form.get("confirmation") ? "As senhas não coincidem. Confira a confirmação." : "";
}
