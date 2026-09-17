import { publicPlanWhere } from "@/lib/admin-plan-policy";
import { pageMetadata, StructuredData, siteOrigin } from "@/lib/site/seo";
import Link from "next/link";
import { controlDb } from "@/db";

export const dynamic = "force-dynamic";

export const generateMetadata = () => pageMetadata("/");

export default async function Home() {
  const [plans, rows, announcements] = await Promise.all([controlDb.plan.findMany({ where: publicPlanWhere, orderBy: { monthlyPrice: "asc" } }), controlDb.siteContent.findMany({ where: { public: true } }), controlDb.announcement.findMany({ where:{active:true,audience:"all",AND:[{OR:[{startsAt:null},{startsAt:{lte:new Date()}}]},{OR:[{endsAt:null},{endsAt:{gte:new Date()}}]}]},orderBy:{createdAt:"desc"},take:5})]);
  const content = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const text = (key: string) => String(content[key] ?? "");
  const features = Array.isArray(content["features.items"]) ? content["features.items"] as Array<{ title: string; description: string }> : [];
  return <main className="public-page"><StructuredData path="/" data={{ "@context": "https://schema.org", "@type": "Organization", name: text("brand.name"), url: await siteOrigin() }}/><header className="public-nav"><Link href="/" className="public-logo">NAL<span>VEN</span></Link><nav><a href="#recursos">Recursos</a><a href="#planos">Planos</a><Link href="/blog">Blog</Link><Link href="/glossario">Glossário</Link><Link href="/login">Entrar</Link><Link className="cta" href="/cadastro">Começar grátis</Link></nav></header>
    {announcements.map(item=><aside key={item.id} className="public-announcement" role="status"><strong>{item.title}</strong><p>{item.message}</p></aside>)}<section className="hero"><p className="kicker">{text("hero.eyebrow")}</p><h1>{text("hero.title")}</h1><p>{text("hero.description")}</p><div><Link className="cta large" href="/cadastro">{text("hero.primaryCta")}</Link><a className="secondary" href="#planos">{text("hero.secondaryCta")}</a></div></section>
    <section id="recursos" className="feature-grid">{features.map((item)=><article key={item.title}><span>✓</span><h2>{item.title}</h2><p>{item.description}</p></article>)}</section>
    <section id="planos" className="plans"><p className="kicker">{text("plans.eyebrow")}</p><h2>{text("plans.title")}</h2><div className="plan-grid">{plans.map(p=><article key={p.id}><h3>{p.name}</h3><strong>R$ {p.monthlyPrice.toLocaleString("pt-BR")}</strong><small>/mês</small><p>Até {p.seats} usuários incluídos</p><Link href={`/cadastro?plano=${p.id}`}>Começar agora</Link></article>)}</div></section>
    <footer>{text("footer.text")}</footer></main>;
}
