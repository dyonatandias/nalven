import Link from "next/link";
import AuditManager from "@/components/admin/audit-manager";
import OrganizationBilling from "@/components/admin/organization-billing";
import OrganizationProfile from "@/components/admin/organization-profile";
import { UserAccessCenter } from "@/components/erp/user-access-center";
import OrganizationPlan from "@/components/admin/organization-plan";
import OrganizationFiscal from "@/components/admin/organization-fiscal";
import { controlDb } from "@/db/control";
import { currentUser } from "@/lib/auth";
import { notFound, redirect } from "@/lib/site/server-navigation";

export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentUser();
  if (!actor) return redirect("/login");
  if (actor.role !== "superadmin") return redirect("/portal");
  const { id } = await params;
  const organization = await controlDb.organization.findUnique({
    where: { id },
    select: {
      id: true, name: true, document: true, ownerName: true, email: true, status: true, createdAt: true, updatedAt: true,
      plan: { select: { id: true, name: true, seats: true } },
      database: { select: { status: true, schemaVersion: true } },
      billingAccount: { select: { paymentMethod: true, subscriptionStatus: true, licenseStatus: true, lastSyncedAt: true } },
    },
  });
  if (!organization) return notFound();
  return <div className="management">
    <header><div><Link href="/admin/organizacoes">← Organizações</Link><h1>{organization.name}</h1><p>Gestão individual da organização</p></div></header>
    <nav aria-label="Seções da organização">{[["cadastro", "Cadastro"], ["fiscal", "Dados fiscais"], ["plano", "Plano e licença"], ["usuarios", "Usuários"], ["financeiro", "Financeiro externo"], ["historico", "Histórico"]].map(([anchor, label]) => <a key={anchor} href={`#${anchor}`}>{label}</a>)}</nav>
    <section id="cadastro" className="management-section"><h2>Cadastro da organização</h2><OrganizationProfile organization={{ id: organization.id, name: organization.name, ownerName: organization.ownerName, email: organization.email, document: organization.document, updatedAt: organization.updatedAt.toISOString() }} /><dl><dt>Situação</dt><dd>{label(organization.status)}</dd><dt>Cadastro</dt><dd>{date(organization.createdAt)}</dd></dl></section>
    <section id="plano" className="management-section"><h2>Plano e licença</h2><dl><dt>Plano contratado</dt><dd>{organization.plan.name}</dd><dt>Limite de usuários</dt><dd>{organization.plan.seats}</dd><dt>Licença sincronizada</dt><dd>{label(organization.billingAccount?.licenseStatus)}</dd><dt>Assinatura externa</dt><dd>{label(organization.billingAccount?.subscriptionStatus)}</dd><dt>Última sincronização</dt><dd>{date(organization.billingAccount?.lastSyncedAt)}</dd></dl><div className="table-tools"><Link href={`/admin/planos?plan=${encodeURIComponent(organization.plan.id)}`}>Configurar plano contratado</Link><Link href={`/admin/planos?organization=${encodeURIComponent(organization.id)}`}>Criar plano exclusivo para esta organização</Link></div><OrganizationPlan key={organization.id} organizationId={organization.id} /></section>
    <OrganizationFiscal key={organization.id} organizationId={organization.id} />
    <section id="usuarios" className="management-section"><UserAccessCenter key={organization.id} organizationId={organization.id} /></section>
    <OrganizationBilling key={organization.id} organizationId={organization.id} />
    <section id="historico" className="management-section"><AuditManager key={organization.id} organizationId={organization.id} /></section>
  </div>;
}

function date(value?: Date | null) { return value ? value.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Não disponível"; }
function label(value?: string | null) {
  const labels: Record<string, string> = { active: "Ativo", trial: "Em teste", provisioning: "Em provisionamento", past_due: "Em atraso", suspended: "Suspenso", canceled: "Cancelado", disabled: "Bloqueado", pending: "Pendente", paid: "Pago", owner: "Proprietário", admin: "Administrador", member: "Membro", pix: "Pix", boleto: "Boleto", credit_card: "Cartão de crédito" };
  return value ? labels[value] || value : "Não disponível";
}
