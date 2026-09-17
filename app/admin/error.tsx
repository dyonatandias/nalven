"use client";
import Link from "next/link";

export default function AdminError({reset}:{reset:()=>void}) {
  return <section className="control-panel empty-state" role="alert">
    <h1>Não foi possível abrir esta área</h1>
    <p>Ocorreu uma falha ao carregar o painel. Tente novamente.</p>
    <button onClick={reset}>Tentar novamente</button>
    <p><Link href="/admin">Voltar à visão geral</Link></p>
  </section>;
}
