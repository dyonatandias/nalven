import { PrismaPg } from "@prisma/adapter-pg";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient as ControlClient } from "../generated/control/client";
import { PrismaClient as TenantClient } from "../generated/tenant/client";
import { hashPassword } from "../lib/password";

if (process.env.NALVEN_ALLOW_DEMO_USER_SEED !== "1") throw new Error("Defina NALVEN_ALLOW_DEMO_USER_SEED=1 para confirmar o seed demonstrativo de usuários.");
const controlUrl = process.env.CONTROL_DATABASE_URL, tenantUrl = process.env.TENANT_DATABASE_URL;
if (!controlUrl || !tenantUrl) throw new Error("CONTROL_DATABASE_URL e TENANT_DATABASE_URL são obrigatórias.");
const control = new ControlClient({ adapter: new PrismaPg({ connectionString: controlUrl }) });
const tenant = new TenantClient({ adapter: new PrismaPg({ connectionString: tenantUrl }) });

const people = [
  { email: "ana.comercial@demo.nalven.com.br", name: "Ana Martins", role: "sales", status: "active", jobTitle: "Executiva de vendas", department: "Comercial", phone: "(49) 99910-1101", lastLoginDays: 0, reviewDays: 12, session: true, canSell: true, canManageStock: false, canIssueFiscal: false },
  { email: "bruno.estoque@demo.nalven.com.br", name: "Bruno Oliveira", role: "stock", status: "active", jobTitle: "Coordenador de estoque", department: "Suprimentos", phone: "(49) 99910-1102", lastLoginDays: 3, reviewDays: 35, session: true, canSell: false, canManageStock: true, canIssueFiscal: false },
  { email: "carla.financeiro@demo.nalven.com.br", name: "Carla Ribeiro", role: "finance", status: "active", jobTitle: "Analista financeira", department: "Financeiro", phone: "(49) 99910-1103", lastLoginDays: 18, reviewDays: 104, session: false, canSell: false, canManageStock: false, canIssueFiscal: true },
  { email: "diego.auditoria@demo.nalven.com.br", name: "Diego Alves", role: "viewer", status: "disabled", jobTitle: "Auditor externo", department: "Auditoria", phone: "(49) 99910-1104", lastLoginDays: 82, reviewDays: 140, session: false, canSell: false, canManageStock: false, canIssueFiscal: false },
] as const;

async function main() {
  const [identity] = await tenant.$queryRawUnsafe<Array<{ database: string; role: string }>>("SELECT current_database() AS database, current_user AS role");
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime") throw new Error("O seed de usuários só pode executar em nalven_t_demo com a credencial runtime.");
  const organization = await control.organization.findUnique({ where: { slug: "demo" } });
  if (!organization) throw new Error("Organização demo não encontrada.");
  const owner = await control.membership.findFirst({ where: { organizationId: organization.id, role: "owner" }, include: { user: true } });
  if (!owner) throw new Error("Proprietário da organização demo não encontrado.");
  const branches = await tenant.branch.findMany({ where: { status: "active" }, orderBy: [{ primary: "desc" }, { id: "asc" }] });
  const primaryBranch = branches[0];
  if (!primaryBranch) throw new Error("A organização demo precisa de ao menos uma filial ativa.");
  const roles = await tenant.tenantRole.findMany();
  const roleByKey = new Map(roles.map(role => [role.key, role]));
  for (const person of people) {
    const role = roleByKey.get(person.role);
    if (!role) throw new Error(`Perfil ${person.role} não encontrado.`);
    const passwordHash = await hashPassword(randomBytes(48).toString("base64url"));
    const lastLoginAt = new Date(Date.now() - person.lastLoginDays * 86_400_000);
    const user = await control.user.upsert({
      where: { email: person.email },
      update: { name: person.name, status: "active", emailVerifiedAt: new Date("2026-06-02T12:00:00.000Z"), lastLoginAt, passwordHash },
      create: { name: person.name, email: person.email, status: "active", role: "user", emailVerifiedAt: new Date("2026-06-02T12:00:00.000Z"), lastLoginAt, passwordHash },
    });
    const membership = await control.membership.upsert({ where: { userId_organizationId: { userId: user.id, organizationId: organization.id } }, update: { role: person.role, status: person.status }, create: { userId: user.id, organizationId: organization.id, role: person.role, status: person.status } });
    const profile = await tenant.tenantUserProfile.upsert({
      where: { userId: user.id },
      update: { roleId: role.id, displayName: person.name, email: person.email, status: person.status, jobTitle: person.jobTitle, department: person.department, phone: person.phone, accessExpiresAt: person.email.startsWith("carla") ? new Date(Date.now() + 42 * 86_400_000) : null, lastAccessReviewAt: new Date(Date.now() - person.reviewDays * 86_400_000), accessReviewedBy: owner.userId, activeBranchId: person.status === "active" ? primaryBranch.id : null, lastSyncedAt: new Date() },
      create: { userId: user.id, roleId: role.id, displayName: person.name, email: person.email, status: person.status, jobTitle: person.jobTitle, department: person.department, phone: person.phone, accessExpiresAt: person.email.startsWith("carla") ? new Date(Date.now() + 42 * 86_400_000) : null, lastAccessReviewAt: new Date(Date.now() - person.reviewDays * 86_400_000), accessReviewedBy: owner.userId, activeBranchId: person.status === "active" ? primaryBranch.id : null },
    });
    await tenant.branchUserAccess.deleteMany({ where: { userProfileId: profile.id } });
    if (person.status === "active") await tenant.branchUserAccess.create({ data: { branchId: primaryBranch.id, userProfileId: profile.id, primary: true, canSell: person.canSell, canManageStock: person.canManageStock, canIssueFiscal: person.canIssueFiscal } });
    const tokenHash = createHash("sha256").update(`demo-user-session:${person.email}`).digest("hex");
    if (person.session) await control.session.upsert({ where: { tokenHash }, update: { userId: user.id, expiresAt: new Date(Date.now() + 10 * 86_400_000), ipAddress: person.email.startsWith("ana") ? "177.52.18.91" : "189.44.31.27", userAgent: person.email.startsWith("ana") ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0" : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15" }, create: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 10 * 86_400_000), ipAddress: "177.52.18.91", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0" } });
    else await control.session.deleteMany({ where: { tokenHash } });
    const exists = await tenant.tenantAuditEvent.findFirst({ where: { action: "membership.updated", entityType: "membership", entityId: membership.id } });
    if (!exists) await tenant.tenantAuditEvent.create({ data: { actorId: owner.userId, action: "membership.updated", entityType: "membership", entityId: membership.id, correlationId: `demo-user-${person.role}`, afterData: { source: "demo_seed", roleKey: person.role, status: person.status, department: person.department } } });
  }
  const inviteRows = [
    { id: "demo-invite-pending", email: "elisa.operacoes@demo.nalven.com.br", name: "Elisa Nunes", roleKey: "sales", status: "pending", expiresAt: new Date(Date.now() + 5 * 86_400_000), acceptedAt: null, revokedAt: null },
    { id: "demo-invite-expired", email: "felipe.temporario@demo.nalven.com.br", name: "Felipe Lima", roleKey: "viewer", status: "pending", expiresAt: new Date(Date.now() - 3 * 86_400_000), acceptedAt: null, revokedAt: null },
    { id: "demo-invite-revoked", email: "gabriela.parceira@demo.nalven.com.br", name: "Gabriela Costa", roleKey: "finance", status: "revoked", expiresAt: new Date(Date.now() + 2 * 86_400_000), acceptedAt: null, revokedAt: new Date(Date.now() - 2 * 86_400_000) },
  ];
  for (const item of inviteRows) {
    await control.organizationInvite.upsert({ where: { id: item.id }, update: { email: item.email, name: item.name, roleKey: item.roleKey, status: item.status, expiresAt: item.expiresAt, acceptedAt: item.acceptedAt, revokedAt: item.revokedAt, invitedById: owner.userId, tokenHash: createHash("sha256").update(randomBytes(48)).digest("hex") }, create: { ...item, organizationId: organization.id, invitedById: owner.userId, tokenHash: createHash("sha256").update(randomBytes(48)).digest("hex") } });
  }
  console.log(JSON.stringify({ organization: organization.slug, users: people.length + 1, invites: inviteRows.length, branches: branches.length }));
}

main().finally(async () => { await Promise.all([control.$disconnect(), tenant.$disconnect()]); });
