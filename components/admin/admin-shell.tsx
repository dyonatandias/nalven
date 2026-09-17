"use client";
import Link from "next/link"; import {usePathname,useRouter} from "next/navigation"; import {useEffect,useRef,useState} from "react"; import {Icon} from "./icons";
type Item=[string,string,string];type Group={label:string;items:Item[]};
const groups:Group[]=[
  {label:"SAAS",items:[["/admin","Visão geral","home"],["/admin/organizacoes","Organizações","building"],["/admin/planos","Planos","file"],["/admin/usuarios","Usuários","users"],["/admin/configuracoes","Configurações","settings"],["/admin/ambientes","Ambientes dos tenants","database"]]},
  {label:"BILLING EXPRESSO",items:[["/admin/integracoes","Financeiro externo","card"],["/admin/licencas","Licenças","file"]]},
  {label:"COMUNICAÇÃO",items:[["/admin/email","E-mail e SMTP","settings"],["/admin/modelos-email","Modelos de e-mail","file"],["/admin/comunicados","Comunicados","file"]]},
  {label:"OPERAÇÕES",items:[["/admin/webhooks","Webhooks","activity"],["/admin/backups","Backups","archive"],["/admin/exportacoes","Exportações","download"],["/admin/provisionamento","Provisionamento","activity"],["/admin/sistema","Sistema","settings"],["/admin/auditoria","Auditoria","file"]]},
  {label:"CONTEÚDO",items:[["/admin/site","Site público","file"],["/admin/analytics","Analytics do site","activity"],["/admin/gestao","Gestão da plataforma","file"],["/admin/biblioteca","Biblioteca","image"],["/admin/seo","SEO","search"],["/admin/navegacao","Redirects e erros 404","activity"],["/admin/blog","Blog","file"],["/admin/glossario","Glossário","book"]]}
];
export default function AdminShell({user,children}:{user:{name:string;email:string};children:React.ReactNode}) {
  const path=usePathname(),router=useRouter();
  const [profile,setProfile]=useState(false),[mobile,setMobile]=useState(false),[error,setError]=useState(""),[leaving,setLeaving]=useState(false);
  const sidebar=useRef<HTMLElement>(null), menu=useRef<HTMLButtonElement>(null), profileArea=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const close=(event:KeyboardEvent)=>{if(event.key==="Escape"){setMobile(false);setProfile(false);if(matchMedia("(max-width:760px)").matches)menu.current?.focus();else profileArea.current?.querySelector<HTMLButtonElement>(".profile-trigger")?.focus();}};
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!profileArea.current?.contains(event.target))setProfile(false);};
    document.addEventListener("keydown",close);document.addEventListener("pointerdown",outside);
    return ()=>{document.removeEventListener("keydown",close);document.removeEventListener("pointerdown",outside);};
  },[]);
  useEffect(()=>{
    const panel=sidebar.current; if(!panel)return;
    const media=matchMedia("(max-width:760px)");
    const update=()=>{panel.inert=media.matches&&!mobile;};
    const resize=()=>{if(!media.matches)setMobile(false);update();};
    update();media.addEventListener("change",resize);
    if(!mobile)return ()=>media.removeEventListener("change",resize);
    const previous=document.body.style.overflow;document.body.style.overflow="hidden";
    panel.querySelector<HTMLElement>("button,a")?.focus();
    const trap=(event:KeyboardEvent)=>{
      if(event.key!=="Tab"||!media.matches)return;
      const elements=Array.from(panel.querySelectorAll<HTMLElement>("a[href],button")).filter(item=>item.getClientRects().length);
      const first=elements[0],last=elements.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    panel.addEventListener("keydown",trap);
    return ()=>{document.body.style.overflow=previous;media.removeEventListener("change",resize);panel.removeEventListener("keydown",trap);};
  },[mobile]);
  function closeMenus(){setMobile(false);setProfile(false);}
  async function logout(){
    setLeaving(true);setError("");
    try{const response=await fetch("/api/auth/logout",{method:"POST"});if(!response.ok)throw new Error("Não foi possível encerrar a sessão. Tente novamente.");router.replace("/login");router.refresh();}
    catch(cause){setError(cause instanceof Error?cause.message:"Falha de conexão.");setLeaving(false);}
  }
  return <div className="control-shell">
    <a className="admin-skip-link" href="#admin-content">Ir para o conteúdo</a>
    <aside ref={sidebar} id="admin-navigation" aria-label="Menu administrativo" className={mobile?"control-sidebar open":"control-sidebar"}>
      <div className="control-brand"><span className="brand-symbol">N</span><div><strong>NALVEN</strong><small>Administração SaaS</small></div><button aria-label="Fechar menu" onClick={()=>{setMobile(false);menu.current?.focus();}}>×</button></div>
      <nav className="control-nav" aria-label="Administração">{groups.map(group=><section key={group.label}><small>{group.label}</small>{group.items.map(([href,label,icon])=>{
        const active=path===href||(href!=="/admin"&&path.startsWith(href+"/"));
        return <Link href={href} className={active?"active":""} aria-current={active?"page":undefined} onClick={closeMenus} key={href}><Icon name={icon}/><span>{label}</span></Link>;
      })}</section>)}</nav>
      <footer><Link href="/admin/sistema" onClick={closeMenus}>Consultar estado do sistema ↗</Link><small>Saúde e integrações verificadas no painel</small></footer>
    </aside>
    <div className="control-workspace"><header className="control-header">
      <button ref={menu} className="mobile-menu" aria-label="Abrir menu" aria-controls="admin-navigation" aria-expanded={mobile} onClick={()=>setMobile(!mobile)}>☰</button>
      <div><small>PAINEL NALVEN</small><strong>{title(path)}</strong></div>
      <div ref={profileArea} className="header-actions"><Link href="/" target="_blank" rel="noopener noreferrer">Ver site ↗</Link>
        <button className="profile-trigger" aria-label="Menu da conta" aria-expanded={profile} aria-controls="admin-profile" onClick={()=>setProfile(!profile)}><span>{user.name.slice(0,2).toUpperCase()}</span><div><strong>{user.name}</strong><small>Superadministrador</small></div></button>
        {profile&&<div id="admin-profile" className="profile-popover"><div><strong>{user.name}</strong><small>{user.email}</small></div><Link href="/admin/perfil" onClick={closeMenus}>Meu perfil</Link><Link href="/admin/auditoria" onClick={closeMenus}>Auditoria administrativa</Link><button disabled={leaving} onClick={()=>void logout()}>{leaving?"Encerrando…":"Encerrar sessão"}</button></div>}
      </div></header>
      <div id="admin-content" tabIndex={-1} className="control-content">{error&&<div role="alert" className="module-error">{error}</div>}{children}</div>
      <footer className="control-footer"><span>© {new Date().getFullYear()} NALVEN</span><span>Financeiro: Billing Expresso · Operação: NALVEN</span></footer>
    </div>{mobile&&<button className="sidebar-scrim" aria-label="Fechar menu administrativo" tabIndex={-1} onClick={()=>{setMobile(false);menu.current?.focus();}}/>}
  </div>;
}
function title(path:string){return groups.flatMap(g=>g.items).find(([href])=>href===path)?.[1]||({"/admin/perfil":"Meu perfil"} as Record<string,string>)[path]||"Administração"}
