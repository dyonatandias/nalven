type StatusGroup = { status: string; _count: number };
type SystemData = {
  host?: { node?: string; uptimeSeconds?: number; totalMemory?: number; freeMemory?: number; loadAverage?: number[] };
  sessions?: number; users?: number; databases?: number;
  organizations?: StatusGroup[]; jobs?: StatusGroup[]; integrations?: StatusGroup[];
};
const labels: Record<string, string> = { active: "Ativos", trial: "Em teste", provisioning: "Em provisionamento", past_due: "Em atraso", suspended: "Suspensos", canceled: "Cancelados", pending: "Pendentes", processing: "Em processamento", completed: "Concluídos", retry: "Aguardando nova tentativa", failed: "Com falha", connected: "Conectadas", disabled: "Desativadas", error: "Com erro", pending_configuration: "Aguardando configuração" };

export default function SystemOverview({ data }: { data: SystemData }) {
  const host = data.host;
  const number = (value?: number) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("pt-BR") : "Não disponível";
  const memory = (value?: number) => typeof value === "number" ? `${(value / 1024 ** 3).toFixed(2)} GB` : "Não disponível";
  const metrics = [
    ["Versão do Node.js", host?.node || "Não disponível"],
    ["Tempo desde a inicialização do host", host?.uptimeSeconds == null ? "Não disponível" : `${Math.floor(host.uptimeSeconds / 86400)} dias e ${Math.floor(host.uptimeSeconds / 3600) % 24} horas`],
    ["Memória total do host", memory(host?.totalMemory)], ["Memória livre do host", memory(host?.freeMemory)],
    ["Usuários cadastrados", number(data.users)], ["Sessões não expiradas", number(data.sessions)], ["Bancos de clientes ativos", number(data.databases)],
    ["Carga média do host (1 / 5 / 15 min)", host?.loadAverage?.map(value => value.toFixed(2)).join(" / ") || "Não disponível"],
  ];
  return <><section className="system-cards" aria-label="Indicadores do sistema">{metrics.map(([title, value]) => <article key={title}><small>{title}</small><strong>{value}</strong></article>)}</section>
    <p>Indicadores consultados no servidor. Estes valores não substituem a verificação dos serviços ou o teste de restauração de backups.</p>
    {[["Organizações", data.organizations], ["Provisionamento", data.jobs], ["Integrações", data.integrations]].map(([title, groups]) => <section className="control-panel" key={String(title)}><h2>{String(title)}</h2><dl>{(Array.isArray(groups) ? groups as StatusGroup[] : []).map(group => <div key={group.status}><dt>{labels[group.status] || group.status}</dt><dd>{number(group._count)}</dd></div>)}</dl>{(!Array.isArray(groups) || !groups.length) && <p>Nenhum registro disponível.</p>}</section>)}</>;
}
