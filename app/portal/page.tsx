import Link from "next/link";
import { currentMembership, currentUser, AuthError } from "@/lib/auth";
import { redirect } from "next/navigation";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { controlDb, tenantDb } from "@/db";
import { BRAZIL_TIME_ZONE } from "@/lib/timezone";
import PortalClient from "./portal-client";
import "./portal.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Portal do cliente | NALVEN", robots: { index:false, follow:false }, referrer: "no-referrer" as const };
export default async function Portal({searchParams}:{searchParams:Promise<{area?:string}>}) {
 const user=await currentUser();if(!user)redirect("/login");if(user.role==="superadmin")redirect("/admin");
 const membership=await currentMembership(user);if(!membership)redirect("/cadastro");
 try {await assertTenantPermission(membership.organizationId,"billing.read");}catch(error){if(!(error instanceof AuthError))throw error;return <main className="tenant-activating"><h1>Acesso financeiro restrito</h1><p>Solicite ao administrador a permissão de consulta ao portal.</p><Link href="/erp">Voltar ao sistema</Link></main>;}
 const database=await controlDb.tenantDatabase.findUnique({where:{organizationId:membership.organizationId},select:{status:true}});
 const timezone=database?.status==="active"?(await tenantDb(membership.organizationId)).tenantSettings.findUnique({where:{id:1},select:{timezone:true}}).then(settings=>settings?.timezone||BRAZIL_TIME_ZONE):BRAZIL_TIME_ZONE;
 const {area}=await searchParams;
 return <PortalClient key={`${user.id}:${membership.organizationId}`} initialTab={["conta","assinatura","faturas","contratos","fiscal","suporte","licenca"].includes(area||"")?area:"conta"} user={{name:user.name,email:user.email}} organization={{id:membership.organizationId,name:membership.organization.name,status:membership.organization.status,timezone:await timezone}}/>;
}
