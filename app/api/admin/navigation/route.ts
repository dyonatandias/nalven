import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { enforceControlRateLimit, privateJson, readJsonObject } from "@/lib/http-security";
import { NavigationInputError, assertNoRedirectCycle, localPath, LOGIN_ALIASES, PUBLIC_PAGES, reservedPath } from "@/lib/site/paths";
import { siteOrigin } from "@/lib/site/seo";

export async function GET(request: Request) {
  try {
    await requireUser("superadmin");
    const params=new URL(request.url).searchParams;
    const days=Number(params.get("days") || 7);
    if (![1,7,30].includes(days)) return privateJson({error:"Período inválido."},{status:400});
    const since=new Date(Date.now()-days*86400000);
    const [rules, counts, paths, recent, seo, origin, posts, terms] = await Promise.all([
      controlDb.siteRedirect.findMany({orderBy:{source:"asc"}}),
      controlDb.routeEvent.groupBy({by:["status"],where:{createdAt:{gte:since}},_count:true}),
      controlDb.routeEvent.groupBy({by:["path","status","destination"],where:{createdAt:{gte:since}},_count:true,_max:{createdAt:true},orderBy:{_count:{path:"desc"}},take:100}),
      controlDb.routeEvent.findMany({where:{createdAt:{gte:since}},orderBy:{createdAt:"desc"},take:100,select:{id:true,path:true,destination:true,status:true,createdAt:true}}),
      controlDb.seoEntry.findMany({orderBy:{path:"asc"}}),siteOrigin(),
      controlDb.blogPost.findMany({where:{status:"published"},select:{slug:true,seoTitle:true,title:true,seoDescription:true,excerpt:true}}),
      controlDb.glossaryTerm.findMany({where:{status:"published"},select:{slug:true,term:true,definition:true}}),
    ]);
    const pages=[...PUBLIC_PAGES.map(path=>({path,title:"",description:""})),...posts.map(row=>({path:`/blog/${row.slug}`,title:row.seoTitle||row.title,description:row.seoDescription||row.excerpt})),...terms.map(row=>({path:`/glossario/${row.slug}`,title:row.term,description:row.definition}))];
    const coverage=pages.map(page=>{const entry=seo.find(row=>row.path===page.path);return {path:page.path,title:entry?.title||page.title,description:entry?.description||page.description,canonical:entry?.canonical||`${origin}${page.path}`,robots:entry?.robots||"index,follow",redirect:rules.find(row=>row.active&&row.source===page.path)?.destination||null}});
    return privateJson({rules,counts,paths,recent,coverage,origin,aliases:LOGIN_ALIASES,days,retentionDays:30,generatedAt:new Date().toISOString()});
  } catch(error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor=await requireUser("superadmin");
    await enforceControlRateLimit(controlDb,`admin:${actor.id}:navigation`,30,60);
    const body=await readJsonObject(request,8192);
    let source:string,destination:string;
    try {
      source=localPath(body.source); destination=localPath(body.destination);
      if (source==="/"||reservedPath(source)) throw new NavigationInputError("A origem é uma rota protegida ou reservada.");
      if (reservedPath(destination)) throw new NavigationInputError("O destino deve ser uma página pública de conteúdo.");
      if (![301,302,307,308].includes(Number(body.status))) throw new NavigationInputError("Status HTTP inválido.");
      if (typeof body.active!=="boolean") throw new NavigationInputError("Informe se a regra está ativa.");
    } catch(error) { return privateJson({error:error instanceof NavigationInputError?error.message:"Regra inválida."},{status:400}); }
    // A single lock serializes the graph check and write, preventing concurrent cycles.
    const result=await controlDb.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('site-redirects'))`;
      const rules=await tx.siteRedirect.findMany({where:{active:true}});
      if (body.active) assertNoRedirectCycle(source,destination,rules);
      const target=PUBLIC_PAGES.includes(destination)||
        destination.startsWith("/blog/")&&await tx.blogPost.count({where:{slug:destination.slice(6),status:"published"}})>0||
        destination.startsWith("/glossario/")&&await tx.glossaryTerm.count({where:{slug:destination.slice(11),status:"published"}})>0;
      if (!target) throw new NavigationInputError("O destino deve ser uma página publicada existente.");
      const data={destination,status:Number(body.status),active:body.active as boolean};
      const rule=await tx.siteRedirect.upsert({where:{source},update:data,create:{source,...data}});
      await tx.auditLog.create({data:{userId:actor.id,action:"navigation.redirect.save",entityType:"site_redirect",entityId:source,metadata:data}});
      return rule;
    }).catch(error=>{if(error instanceof NavigationInputError)return {error:error.message};throw error});
    return privateJson(result,{status:"error" in result?400:200});
  } catch(error) { return authErrorResponse(error); }
}
