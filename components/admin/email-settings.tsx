"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { FormEvent, useEffect, useState } from "react";
type Data = {
  configured: boolean;
  vault: Array<{ key: string; maskedValue: string; fingerprint: string }>;
  recent: Array<{
    id: string;
    recipient: string;
    template: string;
    status: string;
    attempts: number;
  }>;
  summary: { pending: number };
};
export default function EmailSettings() {
  const [data, setData] = useState<Data>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const response = await fetch("/api/admin/email", { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível carregar a configuração de e-mail.");
      setData(await response.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha de conexão.");
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
    const response = await fetch("/api/admin/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      result = await response.json();
    if (!response.ok)
      return setError(result.error || "Não foi possível concluir.");
    setNotice(
      payload.action === "test"
        ? "E-mail de teste enviado."
        : payload.action === "retry"
          ? `${result.sent} mensagem(ns) enviada(s).`
          : "Configuração protegida salva.",
    );
    await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha de conexão.");
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    command({
      action: "save",
      host: form.get("host"),
      port: form.get("port"),
      encryption: form.get("encryption"),
      username: form.get("username"),
      password: form.get("password"),
      from: form.get("from"),
    });
  }
  const meta = (key: string) => data?.vault.find((item) => item.key === key);
  return (
    <section className="control-panel vault-panel email-vault-panel">
      <header>
        <div>
          <small>E-MAIL TRANSACIONAL</small>
          <h2>SMTP da plataforma</h2>
          <p>
            Recuperação de senha e notificações administrativas saem
            exclusivamente por SMTP. Segredos permanecem cifrados no servidor.
          </p>
        </div>
        <span className="vault-badge">
          {data?.configured ? "Configurado" : "Configuração necessária"}
        </span>
      </header>
      {notice && <div className="tenant-notice save-notice">{notice}</div>}
      {error && <div className="tenant-error" role="alert">{error} <button onClick={()=>void load()}>Recarregar configuração</button></div>}
      <form className="billing-settings-form" onSubmit={save}>
        <label>
          Servidor SMTP
          <input
            name="host"
            required
            placeholder={
              meta("email.smtp_host")?.maskedValue || "smtp.exemplo.com"
            }
          />
        </label>
        <label>
          Porta
          <input
            name="port"
            type="number"
            min="1"
            max="65535"
            required
            defaultValue="587"
            placeholder={meta("email.smtp_port")?.maskedValue}
          />
        </label>
        <label>
          Criptografia
          <select name="encryption" defaultValue="tls">
            <option value="tls">STARTTLS</option>
            <option value="ssl">SSL/TLS direto</option>
            <option value="none">Sem TLS</option>
          </select>
        </label>
        <label>
          Remetente
          <input
            name="from"
            type="email"
            required
            placeholder={
              meta("email.from_address")?.maskedValue || "acesso@nalven.com.br"
            }
          />
        </label>
        <label>
          Usuário
          <input
            name="username"
            autoComplete="username"
            placeholder={meta("email.smtp_username")?.maskedValue || "Opcional"}
          />
        </label>
        <label className="secret-field">
          Senha SMTP
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={
              meta("email.smtp_password")
                ? "Já configurada · deixe vazio para manter"
                : "Senha SMTP"
            }
          />
          <small>
            {meta("email.smtp_password")
              ? `Fingerprint ${meta("email.smtp_password")?.fingerprint}.`
              : "Cifrada com AES-256-GCM."}
          </small>
        </label>
        <div className="billing-form-actions">
          <button className="primary" disabled={busy}>
            Salvar no cofre
          </button>
          <button
            type="button"
            disabled={busy || !data?.configured}
            onClick={() => command({ action: "test" })}
          >
            Enviar teste
          </button>
          <button
            type="button"
            disabled={busy || !data?.summary.pending}
            onClick={() => command({ action: "retry" })}
          >
            Reprocessar fila ({data?.summary.pending || 0})
          </button>
        </div>
      </form>
      {Boolean(data?.recent.length) && (
        <div className="email-outbox-list">
          <strong>Últimas entregas</strong>
          {data?.recent.map((item) => (
            <div key={item.id}>
              <span>{item.recipient}</span>
              <small>{item.template}</small>
              <em className={`sync-status ${item.status}`}>{item.status}</em>
              <small>{item.attempts} tentativa(s)</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
