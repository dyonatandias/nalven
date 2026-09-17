"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type OrganizationProfileData = { id: string; name: string; ownerName: string; email: string; document: string; updatedAt: string };
export default function OrganizationProfile({ organization }: { organization: OrganizationProfileData }) {
  const router = useRouter();
  const [version, setVersion] = useState(organization.updatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  return <form onSubmit={async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organization.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, updatedAt: version }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar o cadastro.");
      setVersion(result.updatedAt); setNotice("Cadastro salvo e registrado no histórico."); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); }
  }}><fieldset disabled={busy}><legend>Dados cadastrais no NALVEN</legend><div className="editor-grid"><label>Razão social / nome<input name="name" required maxLength={160} defaultValue={organization.name} /></label><label>Responsável<input name="ownerName" required maxLength={160} defaultValue={organization.ownerName} /></label><label>E-mail de contato<input name="email" type="email" required maxLength={254} defaultValue={organization.email} /></label><label>Documento fiscal<input value={organization.document} readOnly /></label></div><p>Esta edição não altera o documento fiscal, a conta de acesso do responsável ou os dados de cobrança no sistema externo.</p><button>{busy ? "Salvando…" : "Salvar cadastro"}</button></fieldset>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</form>;
}
