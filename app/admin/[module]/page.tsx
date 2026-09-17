import { notFound } from "@/lib/site/server-navigation"; import ModuleView from "./module-view";
const allowed=['organizacoes','usuarios','bancos','faturamento','suporte','integracoes','backups','exportacoes','provisionamento','sistema','auditoria','biblioteca','seo','blog','glossario','perfil'];
export default async function Page({params}:{params:Promise<{module:string}>}){const {module}=await params;if(!allowed.includes(module))return await notFound();return <ModuleView key={module} module={module}/>}
