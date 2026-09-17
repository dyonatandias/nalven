import Link from "next/link";
import { planMenuAllows } from "@/lib/erp/plan-features";
import { redirect } from "@/lib/site/server-navigation";
import { controlDb } from "@/db/control";
import { tenantDb } from "@/db/tenant";
import { currentMembership, currentUser } from "@/lib/auth";
import { matches } from "@/lib/erp/permissions";
import { ERP_MODULES, erpRoute, type ErpPage } from "@/lib/erp/modules";
import ErpClient from "./erp-client";

export default async function ErpShell({ initialPage }: { initialPage: ErpPage }) {
  const user = await currentUser();
  if (!user) return await redirect("/login");
  if (user.role === "superadmin") return await redirect("/admin");
  const membership = await currentMembership(user);
  if (!membership) return await redirect("/cadastro");
  const database = await controlDb.tenantDatabase.findUnique({ where: { organizationId: membership.organizationId } });
  if (!database || database.status !== "active") return <main className="tenant-activating"><div><span>NALVEN</span><h1>Preparando seu ambiente</h1><p>O banco isolado da organização está na fila de provisionamento automático. Você pode acompanhar a ativação em Minha Conta.</p><Link href="/portal">Voltar para Minha Conta</Link></div></main>;
  const tenant = await tenantDb(membership.organizationId);
  const [role, preferences, profile] = await Promise.all([membership.role === "owner" ? null : tenant.tenantRole.findFirst({ where: { key: membership.role, active: true } }), tenant.tenantSettings.findUnique({ where: { id: 1 }, select: { accentColor: true, interfaceDensity: true, defaultSidebarMode: true, logoMediaId: true, timezone: true } }), tenant.tenantUserProfile.findUnique({ where: { userId: user.id }, select: { status: true, accessExpiresAt: true, updatedAt: true, activeBranch: { select: { id: true, code: true, name: true, timezone: true } } } })]);
  if (membership.role !== "owner" && profile && (profile.status !== "active" || (profile.accessExpiresAt && profile.accessExpiresAt <= new Date()))) return await redirect("/portal");
  const permissions = membership.role === "owner" ? ["*"] : Array.isArray(role?.permissions) ? role.permissions.filter((item): item is string => typeof item === "string") : [];
  const allowedPages = ERP_MODULES.filter(module => planMenuAllows(membership.organization.modules, module.id) && matches(permissions, `${module.id}.read`)).map(module => module.id);
  if (!allowedPages.includes(initialPage)) return await redirect(allowedPages.length ? erpRoute(allowedPages[0]) : "/portal");
  return <ErpClient initialPage={initialPage} allowedPages={allowedPages} user={{ id: user.id, cacheVersion: `${membership.role}:${role?.updatedAt.toISOString() || "owner"}:${profile?.updatedAt.toISOString() || "none"}`, name: user.name, email: user.email }} organization={{ id: membership.organizationId, name: membership.organization.name, status: membership.organization.status, trialEndsAt: membership.organization.trialEndsAt, timezone: preferences?.timezone || "America/Sao_Paulo", accentColor: preferences?.accentColor || "#168151", interfaceDensity: preferences?.interfaceDensity || "comfortable", defaultSidebarMode: preferences?.defaultSidebarMode || "expanded", logoMediaId: preferences?.logoMediaId || null, activeBranch: profile?.activeBranch || null }} organizations={user.memberships.filter(item => item.status === "active").map(item => ({ id: item.organizationId, name: item.organization.name, role: item.role }))} />;
}
