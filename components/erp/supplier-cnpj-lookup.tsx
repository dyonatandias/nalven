"use client";
import { useState } from "react";

export function SupplierCnpjLookup() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <div><button type="button" disabled={busy} onClick={async event => {
    const form = event.currentTarget.closest("form");
    if (!form) return;
    const document = new FormData(form).get("document");
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/erp/suppliers/cnpj", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Consulta indisponível.");
      if (new FormData(form).get("document") !== document) throw new Error("O documento foi alterado. Consulte novamente.");
      for (const [name, value] of Object.entries(data.fields)) {
        const input = form.elements.namedItem(name);
        if (input instanceof HTMLInputElement && !input.value.trim() && typeof value === "string" && value) input.value = value;
      }
      setMessage("Dados consultados na BrasilAPI. Campos vazios preenchidos; revise e salve. A base pode não refletir alterações recentes.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Falha na consulta."); }
    finally { setBusy(false); }
  }}>{busy ? "Consultando CNPJ…" : "Consultar CNPJ e completar cadastro"}</button><p role="status">{message}</p></div>;
}
