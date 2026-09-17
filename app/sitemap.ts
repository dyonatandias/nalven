import type { MetadataRoute } from "next";
import { controlDb } from "@/db/control";
import { siteOrigin } from "@/lib/site/seo";
import { PUBLIC_PAGES } from "@/lib/site/paths";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [origin, entries, posts, terms, redirects] = await Promise.all([
    siteOrigin(), controlDb.seoEntry.findMany(),
    controlDb.blogPost.findMany({where:{status:"published"},select:{slug:true,updatedAt:true}}),
    controlDb.glossaryTerm.findMany({where:{status:"published"},select:{slug:true,updatedAt:true}}),
    controlDb.siteRedirect.findMany({where:{active:true},select:{source:true}}),
  ]);
  const excluded=new Set(redirects.map(row=>row.source));
  const metadata=new Map(entries.map(row=>[row.path,row]));
  const pages=[...PUBLIC_PAGES.map(path=>({path,updatedAt:metadata.get(path)?.updatedAt})), ...posts.map(row=>({path:`/blog/${row.slug}`,updatedAt:row.updatedAt})),...terms.map(row=>({path:`/glossario/${row.slug}`,updatedAt:row.updatedAt}))];
  return pages.filter(page=>{const seo=metadata.get(page.path);return !excluded.has(page.path)&&!seo?.robots.includes("noindex")&&(!seo?.canonical||seo.canonical===`${origin}${page.path}`||page.path==="/"&&seo.canonical===origin)}).map(page=>({url:`${origin}${page.path}`,lastModified:page.updatedAt}));
}
