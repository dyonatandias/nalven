"use client";
import { useState } from "react";
import Link from "next/link";

type Organization = { id: string; name: string; document?: string; ownerName?: string; email?: string; status: string; planId?: string; mrr?: number };
const statuses: Record<string,string> = { active:"Ativa", trial:"Em teste", provisioning:"Em provisionamento", past_due:"Em atraso", suspended:"Suspensa", canceled:"Cancelada" };
export default function OrganizationsTable({rows,plans}:{rows:Organization[];plans:{id:string;name:string}[]}) {
  const [query,setQuery]=useState(""), [status,setStatus]=useState("");
  const normalize=(value:string)=>value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  const filtered=rows.filter(row=>(!status||row.status===status)&&normalize([row.name,row.document,row.ownerName,row.email,row.id].join(" ")).includes(normalize(query)));
  return <section className="control-panel"><div className="table-tools">
    <input aria-label="Buscar organização" placeholder="Empresa, documento ou responsável…" value={query} onChange={event=>setQuery(event.target.value)}/>
    <select aria-label="Situação da organização" value={status} onChange={event=>setStatus(event.target.value)}><option value="">Todas as situações</option>{[...new Set(rows.map(row=>row.status))].map(value=><option key={value} value={value}>{statuses[value]||value}</option>)}</select>
    <span role="status">{filtered.length} de {rows.length} organizações</span>
  </div><div className="admin-table-wrap" role="region" aria-label="Lista de organizações" tabIndex={0}><table><thead><tr>{["Organização","Documento","Responsável","E-mail","Plano","Situação","Receita mensal","Ações"].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
    <tbody>{filtered.map(row=><tr key={row.id}><td>{row.name}</td><td>{row.document||"—"}</td><td>{row.ownerName||"—"}</td><td>{row.email||"—"}</td><td>{plans.find(plan=>plan.id===row.planId)?.name||row.planId||"—"}</td><td>{statuses[row.status]||row.status}</td><td>{new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(row.mrr)||0)}</td><td><Link href={`/admin/organizacoes/${encodeURIComponent(row.id)}`} aria-label={`Visualizar organização ${row.name}`}>Visualizar organização →</Link></td></tr>)}</tbody></table></div>
    {!filtered.length&&<div className="empty-state"><h3>{rows.length?"Nenhuma organização encontrada":"Nenhuma organização cadastrada"}</h3><p>{rows.length?"Ajuste a busca ou a situação selecionada.":"As organizações cadastradas aparecerão aqui."}</p></div>}
  </section>;
}
