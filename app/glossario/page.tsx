import { pageMetadata, StructuredData } from "@/lib/site/seo";
import { controlDb } from "@/db/control"; import Link from "next/link";
export const dynamic = "force-dynamic";
export const generateMetadata = () => pageMetadata("/glossario");
export default async function Glossario(){const terms=await controlDb.glossaryTerm.findMany({where:{status:'published'},orderBy:{term:'asc'}});return <main className="editorial-page"><StructuredData path="/glossario"/><header><Link href="/" className="public-logo">NAL<span>VEN</span></Link><Link href="/blog">Blog</Link></header><section className="editorial-hero"><p className="kicker">GLOSSÁRIO</p><h1>Termos de gestão sem complicação.</h1></section><section className="glossary-list">{terms.map(x=><article id={x.slug} key={x.id}><h2><Link href={`/glossario/${x.slug}`}>{x.term}</Link></h2><p>{x.definition}</p></article>)}{!terms.length&&<p>Nenhum termo publicado ainda.</p>}</section></main>}
