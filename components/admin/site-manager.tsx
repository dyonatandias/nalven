"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { isFeatureList, isSiteContentValue, siteGroups, type Feature } from "@/lib/admin-site-content";

type Content = { key: string; group: string; label: string; type: string; value: unknown; public: boolean; updatedAt: string };
export default function SiteManager() {
  const [content, setContent] = useState<Content[]>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/site", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Não foi possível carregar o conteúdo do site.");
        const result = await response.json();
        if (!Array.isArray(result.content)) throw new Error("Conteúdo recebido inválido.");
        if (!controller.signal.aborted) { setContent(result.content); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    })();
    return () => controller.abort();
  }, [revision]);
  return <div className="management"><header><div><h1>Site público</h1><p>Edite os textos e os recursos da página inicial. As alterações salvas e marcadas como públicas entram no site.</p><Link href="/admin/planos">Gerenciar planos e permissões →</Link></div><a href="/" target="_blank" rel="noopener noreferrer">Abrir site</a></header>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Tentar novamente</button></p>}
    {!content ? !error && <p role="status">Carregando conteúdo…</p> : content.length === 0 ? <p>Nenhum conteúdo cadastrado.</p> : [...new Set(content.map(item => item.group))].map(group => <section className="management-section" key={group}><h2>{siteGroups[group] || group}</h2><div className="editor-grid">{content.filter(item => item.group === group).map(item => <ContentForm key={`${item.key}:${item.updatedAt}`} item={item} onSaved={() => { setNotice(`${item.label}: conteúdo salvo e auditado.`); setRevision(value => value + 1); }} />)}</div></section>)}
  </div>;
}

function ContentForm({ item, onSaved }: { item: Content; onSaved: () => void }) {
  const [value, setValue] = useState(item.value);
  const [published, setPublished] = useState(item.public);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const supported = isSiteContentValue(item.key, item.type, item.value);
  return <form className="edit-card" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/admin/site", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: item.key, value, public: published, updatedAt: item.updatedAt }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar.");
      setNotice("Conteúdo salvo e auditado."); onSaved();
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); }
  }}><fieldset disabled={busy || !supported}><legend>{item.label}</legend>
    {!supported ? <p>Este bloco precisa de revisão de formato antes da edição. O conteúdo existente foi preservado.</p> : item.key === "features.items" && isFeatureList(value) ? <FeatureFields value={value} onChange={setValue} /> : <label>{item.label}{item.type === "textarea" ? <textarea maxLength={10000} value={value as string} onChange={event => setValue(event.target.value)} /> : <input maxLength={500} value={value as string} onChange={event => setValue(event.target.value)} />}</label>}
    <label><input type="checkbox" checked={published} onChange={event => setPublished(event.target.checked)} />Publicado no site</label><button>{busy ? "Salvando…" : "Salvar conteúdo"}</button></fieldset>{notice && <p role="status">{notice}</p>}
  </form>;
}

function FeatureFields({ value, onChange }: { value: Feature[]; onChange: (value: Feature[]) => void }) {
  function change(index: number, patch: Partial<Feature>) { onChange(value.map((item, position) => position === index ? { ...item, ...patch } : item)); }
  function move(index: number, offset: number) { const items = [...value]; [items[index], items[index + offset]] = [items[index + offset], items[index]]; onChange(items); }
  return <div>{value.map((item, index) => <fieldset key={index}><legend>Recurso {index + 1}</legend><label>Título do recurso {index + 1}<input required maxLength={160} value={item.title} onChange={event => change(index, { title: event.target.value })} /></label><label>Descrição do recurso {index + 1}<textarea required maxLength={2000} value={item.description} onChange={event => change(index, { description: event.target.value })} /></label><div className="table-tools"><button type="button" disabled={index === 0} onClick={() => move(index, -1)}>Subir recurso {index + 1}</button><button type="button" disabled={index === value.length - 1} onClick={() => move(index, 1)}>Descer recurso {index + 1}</button><button type="button" onClick={() => onChange(value.filter((_, position) => position !== index))}>Remover recurso {index + 1}</button></div></fieldset>)}<button type="button" disabled={value.length >= 50} onClick={() => onChange([...value, { title: "", description: "" }])}>Adicionar recurso</button></div>;
}
