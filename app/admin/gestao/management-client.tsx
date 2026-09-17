import Link from "next/link";

const sections = [
  ["/admin/organizacoes", "Organizações", "Cadastro, plano, usuários, dados fiscais e histórico por cliente."],
  ["/admin/planos", "Planos", "Catálogo público, planos exclusivos e permissões."],
  ["/admin/usuarios", "Usuários da plataforma", "Administradores do SaaS, separados dos usuários dos clientes."],
  ["/admin/configuracoes", "Configurações da plataforma", "Identificação pública e regras de contratação."],
  ["/admin/integracoes", "Financeiro externo", "Integração e credenciais do Billing; sem cobrança interna."],
  ["/admin/licencas", "Licenças", "Validação e política de consulta de autorização de uso."],
  ["/admin/email", "E-mail e SMTP", "Conexão e autenticação do envio transacional."],
  ["/admin/modelos-email", "Modelos de e-mail", "Textos e variáveis das mensagens."],
  ["/admin/comunicados", "Comunicados", "Avisos publicados no site."],
  ["/admin/webhooks", "Webhooks", "Receptor financeiro, fluxos por cliente e registros antigos."],
  ["/admin/site", "Site público", "Textos e recursos da página inicial."],
  ["/admin/auditoria", "Auditoria", "Consulta dos eventos administrativos."],
];
export default function ManagementClient() {
  return <div className="management"><header><div><h1>Gestão da plataforma</h1><p>Cada área possui sua própria página, configuração e histórico.</p></div></header><section className="editor-grid">{sections.map(([href, title, description]) => <article className="edit-card" key={href}><h2><Link href={href}>{title}</Link></h2><p>{description}</p></article>)}</section></div>;
}
