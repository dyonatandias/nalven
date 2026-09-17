"use client";
import type { ReactNode } from "react";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect, @next/next/no-img-element */
import {useCallback,useEffect,useRef,useState} from 'react'; import Link from 'next/link';
import {validateModuleData} from "@/lib/admin-module-data";
import OrganizationsTable from "@/components/admin/organizations-table";
import SystemOverview from "@/components/admin/system-overview";
const meta:Record<string,[string,string]>={organizacoes:['Organizações','Gerencie clientes, planos, responsáveis e ciclo de vida.'],usuarios:['Usuários','Controle acessos globais, perfis e vínculos.'],bancos:['Bancos isolados','Acompanhe bancos, versões e estado dos tenants.'],faturamento:['Faturamento','Faturas, receita recorrente e inadimplência.'],suporte:['Suporte','Tickets, prioridades, responsáveis e prazos.'],integracoes:['Integrações','Conectores globais e específicos das organizações.'],backups:['Backups','Histórico, tamanho, retenção e restauração.'],exportacoes:['Exportações','Solicitações e arquivos produzidos pelos usuários.'],provisionamento:['Provisionamento','Fila de criação e atualização de ambientes.'],sistema:['Sistema','Saúde do host, runtime e recursos.'],auditoria:['Auditoria','Histórico rastreável de alterações administrativas.'],biblioteca:['Biblioteca de mídia','Upload, seleção e reutilização de arquivos.'],seo:['SEO','Metadados, canonical, robots e dados estruturados.'],blog:['Blog','Conteúdo editorial, rascunhos e publicações.'],glossario:['Glossário','Termos, conceitos e conteúdo de descoberta.'],perfil:['Meu perfil','Dados da conta e sessões administrativas.']};
export default function ModuleView({module}:{module:string}) {
  return <ModuleContent key={module} module={module}/>;
}
function ModuleContent({module}:{module:string}) {
  const [data,setData]=useState<any>(), [error,setError]=useState(""), [busy,setBusy]=useState(false);
  const request=useRef<AbortController | null>(null);
  const load=useCallback(async () => {
    request.current?.abort();
    const controller=new AbortController(); request.current=controller;
    setBusy(true); setError("");
    try {
      const endpoint=["biblioteca","seo","blog","glossario"].includes(module)?`/api/admin/content?resource=${module}`:module==="auditoria"?"/api/admin/audit":module==="sistema"?"/api/admin/system":"/api/saas";
      const response=await fetch(endpoint,{cache:"no-store",signal:controller.signal});
      if (!response.ok) throw new Error(response.status===401?"Sua sessão expirou. Entre novamente.":response.status===403?"Você não tem permissão para acessar este módulo.":"Não foi possível carregar este módulo. Tente novamente.");
      const result=validateModuleData(module,await response.json());
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted) { setData(undefined); setError(cause instanceof Error?cause.message:"Falha de conexão."); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  },[module]);
  useEffect(()=>{void load();return ()=>request.current?.abort();},[load]);
  const [title,description]=meta[module];
  return <><div className="module-heading"><div><p>ADMINISTRAÇÃO</p><h1>{title}</h1><span>{description}</span></div><div className="page-actions">
    {module==="organizacoes"&&<Link href="/admin/gestao?tab=organizacoes">Gerenciar organizações</Link>}
    {module==="biblioteca"&&<label className="primary upload-button">Enviar arquivo<input type="file" onChange={async event=>{
      const input=event.currentTarget, file=input.files?.[0]; if(!file)return;
      try { const form=new FormData();form.set("file",file); const response=await fetch("/api/admin/media",{method:"POST",body:form});if(!response.ok)throw new Error("Falha no upload.");await load(); }
      catch(cause){setError(cause instanceof Error?cause.message:"Falha no upload.");} finally {input.value="";}
    }}/></label>}
    <button disabled={busy} onClick={()=>void load()}>{busy?"Atualizando…":"Atualizar"}</button>
  </div></div>{error&&<div className="module-error" role="alert">{error} <button onClick={()=>void load()}>Tentar novamente</button></div>}
  {!data&&!error?<div className="module-loading" role="status">Carregando dados…</div>:data?<Content module={module} data={data}/>:null}</>;
}
function Content({module,data}:{module:string;data:any}){if(module==='organizacoes')return <OrganizationsTable rows={data.tenants} plans={Array.isArray(data.plans)?data.plans:[]}/>;if(module==='sistema')return <SystemOverview data={data}/>;if(module==='perfil')return <section className="control-panel empty-state"><h2>Perfil administrativo</h2><p>Nome, e-mail e preferências da conta são exibidos no menu superior. Alterações sensíveis exigem confirmação de senha.</p><Link href="/admin/usuarios">Gerenciar usuários</Link></section>;let rows:any[]=[];if(module==='organizacoes')rows=data.tenants;if(module==='usuarios')return <RedirectCard href="/admin/gestao" text="A gestão detalhada de usuários está integrada em Site e planos → Usuários."/>;if(module==='bancos')rows=data.databases;if(module==='faturamento')rows=data.invoices;if(module==='suporte')rows=data.tickets;if(module==='integracoes')rows=data.integrations;if(module==='backups')rows=data.backups;if(module==='exportacoes')rows=data.exports;if(module==='provisionamento')rows=data.jobs;if(module==='auditoria')rows=Array.isArray(data)?data:data.logs||[];if(['biblioteca','seo','blog','glossario'].includes(module))rows=data.items||[];return module==='biblioteca'?<MediaGrid rows={rows}/>:<DataTable rows={rows}/>}
function DataTable({rows}:{rows:any[]}){const [query,setQuery]=useState('');const filtered=rows.filter(row=>JSON.stringify(row).toLowerCase().includes(query.toLowerCase()));const cols=rows.length?Object.keys(rows[0]).filter(k=>!['modules','config','metadata','memberships','domains','plan','database'].includes(k)).slice(0,7):[];return <section className="control-panel"><div className="table-tools"><input placeholder="Filtrar registros…" aria-label="Filtrar registros" value={query} onChange={event=>setQuery(event.target.value)}/><span>{filtered.length} registros</span></div><div className="admin-table-wrap"><table><thead><tr>{cols.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{filtered.map((r,i)=><tr key={r.id||r.key||i}>{cols.map(c=><td key={c}>{format(r[c])}</td>)}</tr>)}</tbody></table>{!rows.length&&<div className="empty-state"><h3>Nenhum registro</h3><p>Não há dados para exibir neste módulo.</p></div>}</div></section>}
function MediaGrid({rows}:{rows:any[]}){return <div className="media-grid">{rows.map(x=><article key={x.id}>{x.mimeType?.startsWith('image/')?<img src={`/api/media/${x.id}`} alt={x.altText||x.name}/>:<div className="file-placeholder">ARQUIVO</div>}<strong>{x.name}</strong><small>{bytes(x.sizeBytes)} · {x.folder}</small><a href={`/api/media/${x.id}`} target="_blank" rel="noreferrer">Abrir arquivo ↗</a></article>)}{!rows.length&&<div className="empty-state"><h3>Biblioteca vazia</h3><p>Envie o primeiro arquivo para começar.</p></div>}</div>}
function RedirectCard({href,text}:{href:string;text:string}){return <section className="control-panel empty-state"><p>{text}</p><Link href={href}>Abrir gestão</Link></section>}function bytes(n:number){if(!n)return '0 B';return `${(n/1024/1024).toFixed(1)} MB`}function format(v:any):ReactNode{if(v==null)return '—';if(Array.isArray(v))return <ul>{v.map((item,index)=><li key={index}>{format(item)}</li>)}</ul>;if(typeof v==='object')return <dl>{Object.entries(v).map(([key,value])=><div key={key}><dt>{key.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ')}</dt><dd>{format(value)}</dd></div>)}</dl>;if(typeof v==='boolean')return v?'Sim':'Não';if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&!Number.isNaN(Date.parse(v)))return new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });return String(v)}
