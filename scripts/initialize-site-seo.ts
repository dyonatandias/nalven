import { controlDb } from "../db/control";

async function main(){
 const setting=await controlDb.systemSetting.findUniqueOrThrow({where:{key:"saas"}});
 const domain=(setting.value as {domain:string}).domain;
 if(!/^[a-z0-9.-]+$/.test(domain))throw new Error("Domínio inválido.");
 const origin=`https://${domain}`;
 await controlDb.systemSetting.upsert({where:{key:"signup"},update:{},create:{key:"signup",value:{billingPlanCodes:{essential:"essencial",management:"profissional",scale:"omnichannel"},paymentMethods:["pix","boleto"],dueDay:10}}});
 const entries=[{path:"/",title:"NALVEN — Gestão empresarial conectada",description:"ERP modular para vendas, estoque, financeiro, fiscal e operação."},{path:"/blog",title:"Blog de gestão empresarial | NALVEN",description:"Guias sobre gestão integrada, vendas, estoque, finanças e processos empresariais."},{path:"/glossario",title:"Glossário de gestão empresarial | NALVEN",description:"Definições dos termos de ERP, vendas, estoque e gestão empresarial, com páginas próprias para cada conceito."}];
 for(const entry of entries)await controlDb.seoEntry.upsert({where:{path:entry.path},update:{},create:{...entry,canonical:`${origin}${entry.path}`,robots:"index,follow"}});
 const posts=await controlDb.blogPost.findMany({where:{status:"published"}});
 for(const p of posts){const path=`/blog/${p.slug}`;await controlDb.seoEntry.upsert({where:{path},update:{},create:{path,title:p.seoTitle||p.title,description:p.seoDescription||p.excerpt,canonical:`${origin}${path}`}})}
 const terms=await controlDb.glossaryTerm.findMany({where:{status:"published"}});
 for(const t of terms){const path=`/glossario/${t.slug}`;await controlDb.seoEntry.upsert({where:{path},update:{},create:{path,title:`${t.term} | Glossário NALVEN`,description:t.definition.slice(0,300),canonical:`${origin}${path}`}})}
 await controlDb.auditLog.create({data:{action:"site.seo.initialize",entityType:"seo",metadata:{publicPages:entries.length,articles:posts.length,terms:terms.length}}});
 console.log(JSON.stringify({metadataEntries:await controlDb.seoEntry.count(),publishedArticles:posts.length,publishedTerms:terms.length}));
}
main().finally(()=>controlDb.$disconnect());
