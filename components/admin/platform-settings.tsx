"use client";
import { useEffect, useState } from "react";
type Data = { name: string; domain: string; trialDays: number; dueDay: number; paymentMethods: string[]; versions: { saas: string | null; signup: string | null } };
export default function PlatformSettings() {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => { try {
      const response = await fetch("/api/admin/platform-settings", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Não foi possível carregar as configurações da plataforma.");
      const result = await response.json();
      if (!Array.isArray(result.paymentMethods) || !result.versions) throw new Error("Configuração inválida.");
      if (!controller.signal.aborted) { setData(result); setError(""); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha de conexão."); } })();
    return () => controller.abort();
  }, [revision]);
  return <div className="management"><header><div><h1>Configurações da plataforma</h1><p>Identificação pública e regras de novas contratações. Não altera assinaturas existentes nem emite cobranças.</p></div><button disabled={busy} onClick={() => setRevision(value => value + 1)}>Recarregar configurações</button></header>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!data ? !error && <p role="status">Carregando configurações…</p> : <form key={`${data.versions.saas}:${data.versions.signup}`} className="control-panel" onSubmit={async event => {
      event.preventDefault(); const form = event.currentTarget, fields = new FormData(form); setBusy(true); setError(""); setNotice("");
      try {
        const response = await fetch("/api/admin/platform-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: fields.get("name"), domain: fields.get("domain"), trialDays: Number(fields.get("trialDays")), dueDay: Number(fields.get("dueDay")), paymentMethods: fields.getAll("paymentMethods"), versions: data.versions, currentPassword: fields.get("password") }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "Não foi possível salvar.");
        setNotice("Configurações salvas e auditadas."); setRevision(value => value + 1);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
      finally { (form.elements.namedItem("password") as HTMLInputElement).value = ""; setBusy(false); }
    }}><fieldset disabled={busy}><legend>Identificação e contratação</legend><div className="editor-grid"><label>Nome da plataforma<input name="name" required maxLength={160} defaultValue={data.name} /></label><label>Domínio público<input name="domain" required maxLength={253} defaultValue={data.domain} placeholder="exemplo.com.br" /></label><label>Dias de teste<input name="trialDays" type="number" min={0} max={90} required defaultValue={data.trialDays} /></label><label>Dia de vencimento externo<input name="dueDay" type="number" min={1} max={28} required defaultValue={data.dueDay} /></label></div><p>Alterar o domínio afeta os endereços públicos gerados. DNS, certificado e servidor não são configurados por este formulário.</p><fieldset><legend>Formas de pagamento oferecidas no cadastro</legend>{["pix", "boleto"].map(method => <label key={method}><input name="paymentMethods" type="checkbox" value={method} defaultChecked={data.paymentMethods.includes(method)} />{method === "pix" ? "Pix" : "Boleto"}</label>)}</fieldset><label>Sua senha administrativa<input name="password" type="password" autoComplete="current-password" required /></label><button>{busy ? "Salvando…" : "Salvar configurações"}</button></fieldset></form>}
  </div>;
}
