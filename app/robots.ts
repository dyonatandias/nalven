import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site/seo";
export const dynamic = "force-dynamic";
export default async function robots(): Promise<MetadataRoute.Robots> {
  return {rules:[{userAgent:"*",allow:"/",disallow:["/api/","/_next/"]}],sitemap:`${await siteOrigin()}/sitemap.xml`};
}
