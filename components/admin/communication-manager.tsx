"use client";
import { useEffect, useState } from "react";

type Template = { id: string; name: string; subject: string; body: string; active: boolean };
type Announcement = { id: string; title: string; message: string; active: boolean; audience: string; level: string };
type Data = { templates?: Template[]; announcements?: Announcement[] };
export default function CommunicationManager({ section }: { section: "templates" | "announcements" }) {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/control?section=${section}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível carregar esta página.");
        const result = await response.json();
        if (!Array.isArray(result[section])) throw new Error("Resposta de comunicação inválida.");
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    })();
    return () => controller.abort();
  }, [section, revision]);
  async function send(payload: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar.");
      setNotice("Alteração salva e auditada."); setRevision(value => value + 1); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); return false; }
    finally { setBusy(false); }
  }
  return <div className="management"><header><div><h1>{section === "templates" ? "Modelos de e-mail" : "Comunicados"}</h1><p>{section === "templates" ? "Textos transacionais. A conexão SMTP é configurada na página E-mail e SMTP." : "Avisos publicados no site. Publicar não envia um e-mail."}</p></div></header>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error} <button disabled={busy} onClick={() => setRevision(value => value + 1)}>Recarregar comunicação</button></p>}
    {!data ? !error && <p role="status">Carregando comunicação…</p> : section === "templates" ? <section className="editor-grid">{data.templates?.map(template => <TemplateForm key={template.id} template={template} busy={busy} save={send} />)}{!data.templates?.length && <p>Nenhum modelo cadastrado.</p>}</section> : <>
      <form className="control-panel" onSubmit={async event => { event.preventDefault(); const form = event.currentTarget; if (await send({ action: "announcement.create", ...Object.fromEntries(new FormData(form)) })) form.reset(); }}><h2>Novo comunicado</h2><fieldset disabled={busy}><legend>Conteúdo e destinatários</legend><label>Título<input name="title" required maxLength={160} /></label><label>Mensagem<textarea name="message" required maxLength={5000} /></label><label>Público<select name="audience"><option value="all">Todos (inclui site público)</option></select></label><label>Tipo<select name="level"><option value="info">Informação</option><option value="warning">Aviso</option><option value="error">Alerta</option></select></label><button>Publicar comunicado</button></fieldset></form>
      <section className="control-panel"><h2>Comunicados publicados</h2>{data.announcements?.map(item => <article className="edit-card" key={item.id}><h3>{item.title}</h3><p>{item.message}</p><p>{item.active ? "Ativo" : "Inativo"} · {item.audience === "all" ? "Todos" : "Clientes"}</p><button disabled={busy} onClick={() => void send({ action: "announcement.toggle", id: item.id, active: !item.active })}>{item.active ? "Desativar" : "Ativar"} comunicado</button></article>)}{!data.announcements?.length && <p>Nenhum comunicado cadastrado.</p>}</section>
    </>}
  </div>;
}

function TemplateForm({ template, busy, save }: { template: Template; busy: boolean; save: (payload: Record<string, unknown>) => Promise<boolean> }) {
  return <form className="edit-card" onSubmit={async event => { event.preventDefault(); const fields = new FormData(event.currentTarget); await save({ action: "template.save", id: template.id, name: fields.get("name"), subject: fields.get("subject"), body: fields.get("body"), active: fields.get("active") === "on" }); }}><fieldset disabled={busy}><legend>{template.name}</legend><label>Nome do modelo<input name="name" required maxLength={160} defaultValue={template.name} /></label><label>Assunto<input name="subject" required maxLength={500} defaultValue={template.subject} /></label><label>Texto do e-mail<textarea name="body" required maxLength={50000} defaultValue={template.body} /></label><p>Preserve as variáveis identificadas por chaves duplas no texto.</p><label><input name="active" type="checkbox" defaultChecked={template.active} />Modelo ativo</label><button>Salvar modelo</button></fieldset></form>;
}
