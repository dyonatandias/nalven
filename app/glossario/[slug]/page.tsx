import Link from "next/link";
import { notFound } from "@/lib/site/server-navigation";
import { controlDb } from "@/db/control";
import { pageMetadata, StructuredData, siteOrigin } from "@/lib/site/seo";
export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const term = await controlDb.glossaryTerm.findUnique({ where: { slug } });
  if (!term || term.status !== "published") return { robots: { index: false, follow: false } };
  return pageMetadata(`/glossario/${slug}`, { title: `${term.term} | Glossário NALVEN`, description: term.definition.slice(0, 300) });
}
export default async function Term({ params }: Props) {
  const { slug } = await params;
  const term = await controlDb.glossaryTerm.findUnique({ where: { slug } });
  if (!term || term.status !== "published") return await notFound();
  return <main className="article-page"><StructuredData path={`/glossario/${slug}`} data={{ "@context":"https://schema.org", "@type":"DefinedTerm", name:term.term, description:term.definition, url:`${await siteOrigin()}/glossario/${slug}`, inDefinedTermSet:`${await siteOrigin()}/glossario` }}/><Link href="/glossario">← Todos os termos</Link><article><p className="kicker">GLOSSÁRIO NALVEN</p><h1>{term.term}</h1><p className="lead">{term.definition}</p></article><Link href="/blog">Explore os guias de gestão →</Link></main>;
}
