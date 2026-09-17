import Link from "next/link";
import styles from "./not-found.module.css";

export default function NotFound() {
  return <main className={styles.page}>
    <header><Link href="/" aria-label="NALVEN — início">NAL<span>VEN</span></Link><Link href="/login">Acessar minha conta ↗</Link></header>
    <section className={styles.content}>
      <div className={styles.art} aria-hidden="true"><span>4</span><i>↗</i><span>4</span></div>
      <p className={styles.eyebrow}>PÁGINA NÃO ENCONTRADA</p>
      <h1>Vamos encontrar<br/>o caminho de volta.</h1>
      <p>Este endereço pode ter mudado ou não existir mais. Sua próxima etapa está logo abaixo.</p>
      <div className={styles.actions}><Link href="/">Voltar ao início <span>→</span></Link><Link href="/login">Entrar no NALVEN</Link></div>
      <nav aria-label="Explore o site"><Link href="/blog">Blog e guias ↗</Link><Link href="/glossario">Glossário de gestão ↗</Link></nav>
    </section>
    <footer><span>NALVEN · Gestão conectada</span><span>Erro 404</span></footer>
  </main>;
}
