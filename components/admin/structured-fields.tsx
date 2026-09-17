"use client";
import { useState } from "react";

export type StructuredValue = null | string | number | boolean | StructuredValue[] | { [key: string]: StructuredValue };
const labels: Record<string, string> = { "@context": "Vocabulário", "@type": "Tipo de conteúdo", name: "Nome", description: "Descrição", url: "Endereço", image: "Imagem", logo: "Logotipo", author: "Autor", publisher: "Publicador", mainEntity: "Conteúdo principal", acceptedAnswer: "Resposta", text: "Texto", headline: "Título", datePublished: "Data de publicação", dateModified: "Data de atualização" };
export default function StructuredFields({ value, onChange, label = "Dados estruturados", depth = 0, objectRoot = false }: { value: StructuredValue; onChange: (value: StructuredValue) => void; label?: string; depth?: number; objectRoot?: boolean }) {
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState("");
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  function changeType(next: string) {
    if (next === type) return;
    if (value !== null && value !== "" && !window.confirm("Mudar o tipo substitui o valor deste campo. Continuar?")) return;
    onChange(next === "object" ? {} : next === "array" ? [] : next === "number" ? 0 : next === "boolean" ? false : next === "null" ? null : "");
  }
  if (depth > 20) return <p>Conteúdo de alta complexidade preservado. Revise a estrutura antes de alterar este nível.</p>;
  return <fieldset className="edit-card"><legend>{labels[label] || label}</legend><label>Formato de {labels[label] || label}<select value={type} onChange={event => changeType(event.target.value)}>{!objectRoot && <><option value="string">Texto</option><option value="number">Número</option><option value="boolean">Sim ou não</option><option value="array">Lista de itens</option></>}<option value="object">Grupo de campos</option><option value="null">Sem valor</option></select></label>
    {typeof value === "string" && <label>{labels[label] || label}<input value={value} onChange={event => onChange(event.target.value)} /></label>}
    {typeof value === "number" && <label>{labels[label] || label}<input type="number" step="any" value={value} onChange={event => { const number = event.target.valueAsNumber; if (Number.isFinite(number)) onChange(number); }} /></label>}
    {typeof value === "boolean" && <label><input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)} />{labels[label] || label}</label>}
    {Array.isArray(value) && <>{value.map((item, index) => <div key={index}><StructuredFields value={item} depth={depth + 1} label={`Item ${index + 1}`} onChange={next => onChange(value.map((current, position) => position === index ? next : current))} /><button type="button" onClick={() => onChange(value.filter((_, position) => position !== index))}>Remover item {index + 1}</button><button type="button" disabled={index === 0} onClick={() => { const items = [...value]; [items[index - 1], items[index]] = [items[index], items[index - 1]]; onChange(items); }}>Subir item {index + 1}</button></div>)}<button type="button" onClick={() => onChange([...value, ""])}>Adicionar item</button></>}
    {value !== null && typeof value === "object" && !Array.isArray(value) && <>{Object.entries(value).map(([key, item]) => <div key={key}><StructuredFields value={item} depth={depth + 1} label={key} onChange={next => onChange(Object.fromEntries(Object.entries(value).map(([name, current]) => [name, name === key ? next : current])))} /><button type="button" onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)))}>Remover campo {labels[key] || key}</button></div>)}<label>Nome do novo campo<input value={newKey} maxLength={100} onChange={event => setNewKey(event.target.value)} placeholder="Ex.: name, description, author" /></label><button type="button" onClick={() => { const key = newKey.trim(); if (!/^[@a-zA-Z][a-zA-Z0-9_:@.-]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || Object.hasOwn(value, key)) { setError("Informe um nome de campo válido e ainda não utilizado."); return; } onChange(Object.fromEntries([...Object.entries(value), [key, ""]])); setNewKey(""); setError(""); }}>Adicionar campo</button>{error && <p role="alert">{error}</p>}</>}
  </fieldset>;
}
