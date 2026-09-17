"use client";
import { useRef, useState, type ReactNode } from "react";
export function DownloadLink({href,children,organizationId}:{href:string;children:ReactNode;organizationId?:string}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const working=useRef(false);
 const safeHref=localDownloadUrl(href);
 async function download(event:React.MouseEvent<HTMLAnchorElement>){
  event.preventDefault();if(working.current || !safeHref)return;working.current=true;setBusy(true);setError("");
  try {
   const response=await fetch(safeHref,{cache:"no-store",headers:organizationId?{"x-organization-id":organizationId}:undefined});
   if(!response.ok || response.headers.get("content-type")?.includes("application/json")){
    let message="Não foi possível baixar o arquivo.";try {const body=await response.json();if(body.error)message=body.error;}catch{}throw new Error(message);
   }
   const blob=await response.blob();if(!blob.size)throw new Error("O arquivo retornado está vazio.");
   const disposition=response.headers.get("content-disposition")||"";
   const encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
   let decoded="";try{decoded=encoded?decodeURIComponent(encoded):"";}catch{}
   const name=(decoded||disposition.match(/filename="?([^";]+)/i)?.[1])||`documento.${blob.type.includes("xml")?"xml":blob.type.includes("pdf")?"pdf":"bin"}`;
   const url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=name.replace(/[\\/\r\n]/g,"-");document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch(e){setError(e instanceof Error?e.message:"Não foi possível baixar o arquivo.");}finally{working.current=false;setBusy(false);}
 }
 return <span className="portal-download"><a href={safeHref||undefined} onClick={download} aria-disabled={busy||!safeHref}>{busy?"Baixando…":children}</a>{(error||!safeHref)&&<small role="alert">{error||"Link de arquivo indisponível."}</small>}</span>;
}
function localDownloadUrl(value:string){try{if(!value.startsWith("/")||/[\\\r\n]/.test(value))return null;const url=new URL(value,"https://portal.invalid");return url.origin==="https://portal.invalid"&&url.pathname==="/api/portal/billing/files"?url.pathname+url.search:null;}catch{return null;}}
