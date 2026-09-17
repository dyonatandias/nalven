import type { Metadata } from "next";
import { cache } from "react";
import { headers } from "next/headers";
import { controlDb } from "@/db/control";

export const siteOrigin = cache(async () => {
  const setting = await controlDb.systemSetting.findUnique({ where: { key: "saas" } });
  const value = setting?.value as { domain?: string } | null;
  if (!value?.domain || !/^[a-z0-9.-]+$/.test(value.domain)) throw new Error("Configure o domínio público em saas.domain.");
  return new URL(`https://${value.domain}`).origin;
});

export const seoEntry = cache((path: string) => controlDb.seoEntry.findUnique({ where: { path } }));

export async function pageMetadata(path: string, content?: { title: string; description: string; image?: string | null; article?: boolean }): Promise<Metadata> {
  const [entry, origin] = await Promise.all([seoEntry(path), siteOrigin()]);
  const title = entry?.title || content?.title;
  const description = entry?.description || content?.description;
  if (!title || !description) throw new Error(`Metadados não configurados: ${path}`);
  const canonical = entry?.canonical || `${origin}${path}`;
  const images = [entry?.imageUrl || content?.image || `${origin}/opengraph-image`];
  return {
    title: { absolute: title }, description,
    alternates: { canonical },
    robots: { index: !entry?.robots.includes("noindex"), follow: !entry?.robots.includes("nofollow") },
    openGraph: { title, description, url: canonical, type: content?.article ? "article" : "website", locale: "pt_BR", siteName: "NALVEN", images },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

export async function StructuredData({ path, data }: { path: string; data?: Record<string, unknown> }) {
  const [entry, h] = await Promise.all([seoEntry(path), headers()]);
  const schema = entry?.schemaJson || data;
  if (!schema) return null;
  return <script type="application/ld+json" nonce={h.get("x-nonce") || undefined} dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") }}/>;
}
