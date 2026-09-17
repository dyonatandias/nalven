"use client";

import type { ReactNode } from "react";
import styles from "./operations-suite-frame.module.css";

type ModuleKey = "orders" | "crm" | "contracts" | "service-orders" | "purchases" | "inventory" | "production";
type Config = { eyebrow: string; title: string; description: string; phases: string[]; accent: string };

const configs: Record<ModuleKey, Config> = {
  orders: { eyebrow: "RECEITA E FULFILLMENT", title: "Orçamentos e pedidos", description: "Da proposta ao pagamento, separação, entrega e pós-venda, com histórico e estoque protegidos.", phases: ["Orçar", "Aprovar", "Separar", "Entregar"], accent: "#28a66b" },
  crm: { eyebrow: "PIPELINE COMERCIAL", title: "CRM e oportunidades", description: "Priorize o funil, compromissos e previsão ponderada sem perder o histórico de cada negociação.", phases: ["Captar", "Qualificar", "Propor", "Ganhar"], accent: "#4d8fc4" },
  contracts: { eyebrow: "RECEITA RECORRENTE", title: "Contratos e recorrência", description: "Gerencie vigência, SLA, reajustes, competências e títulos financeiros com rastreabilidade.", phases: ["Contratar", "Ativar", "Faturar", "Renovar"], accent: "#7b6bc1" },
  "service-orders": { eyebrow: "SERVIÇOS E OFICINA", title: "Ordens de serviço", description: "Planeje atendimento, checklist, peças, execução e faturamento em uma sequência operacional única.", phases: ["Diagnosticar", "Executar", "Conferir", "Faturar"], accent: "#db8b32" },
  purchases: { eyebrow: "ABASTECIMENTO", title: "Compras e cotações", description: "Controle fornecedores, custos, aprovações, recebimentos parciais e reflexos financeiros e de estoque.", phases: ["Cotar", "Aprovar", "Comprar", "Receber"], accent: "#288f83" },
  inventory: { eyebrow: "SALDO E RASTREABILIDADE", title: "Inventário e depósitos", description: "Saldos físicos, reservas, contagens, transferências e razão imutável por depósito.", phases: ["Armazenar", "Contar", "Transferir", "Auditar"], accent: "#168151" },
  production: { eyebrow: "PLANEJAMENTO E CUSTO", title: "Produção e kits", description: "Fichas técnicas, consumo de insumos, perdas, rendimento e custo real do produto acabado.", phases: ["Compor", "Planejar", "Consumir", "Produzir"], accent: "#b46e32" },
};

export function OperationsSuiteFrame({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const config = configs[module];
  return <div className={styles.frame} style={{ "--suite-accent": config.accent } as React.CSSProperties}>
    {module !== "production" && <header className={styles.hero}>
      <div className={styles.heroCopy}><span>{config.eyebrow}</span><h1>{config.title}</h1><p>{config.description}</p></div>
      <ol className={styles.flow}>{config.phases.map((phase, index) => <li key={phase}><b>{String(index + 1).padStart(2, "0")}</b><span>{phase}</span></li>)}</ol>
    </header>}
    <section className={styles.content}>{children}</section>
  </div>;
}
