import { signupConfiguration } from "@/lib/site/signup";
import { canAssignPlan } from "@/lib/admin-plan-policy";
import { billingSettings } from "@/lib/billing/client";
import { controlDb } from "@/db/control";
import { createSession } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { isValidNewPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import type { Prisma } from "@/generated/control/client";
import { incrementFunnelStep } from "@/lib/analytics/service";
import { randomUUID } from "node:crypto";
import {
  assertTrustedMutation,
  clientAddress,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
  readJsonObject,
  unexpectedErrorResponse,
} from "@/lib/http-security";
import { isValidTaxDocument } from "@/lib/erp/customer-input";

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 32_768 });
    const ip = clientAddress(request);
    await enforceControlRateLimit(controlDb, `signup:ip:${ip}`, 5, 3600);
    const body = await readJsonObject(request, 32_768);
    const configuration=await signupConfiguration();
    const billing=await billingSettings();
    const email = limited(body.email, 254).toLowerCase();
    const name = limited(body.name, 160), company = limited(body.company, 180);
    const password = typeof body.password === "string" ? body.password : "";
    const document = digits(body.document), responsibleCpf = digits(body.responsibleCpf);
    const state = limited(body.state, 2).toUpperCase(), zip = digits(body.zip);
    const paymentMethod = limited(body.paymentMethod, 20);
    if (!configuration.paymentMethods.includes(paymentMethod)) return privateJson({ error: "Método de pagamento indisponível." }, { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || !company || !password || !isValidTaxDocument(document) || responsibleCpf.length !== 11 || !isValidTaxDocument(responsibleCpf) || !/^\d{8}$/.test(zip) || !/^[A-Z]{2}$/.test(state) || !limited(body.street, 180) || !limited(body.number, 30) || !limited(body.city, 120) || digits(body.phone).length < 10) return privateJson({ error: "Revise os dados obrigatórios e os documentos informados." }, { status: 400 });
    if (!isValidNewPassword(password)) return privateJson({ error: PASSWORD_POLICY_MESSAGE }, { status: 400 });
    const planId = typeof body.planId === "string" ? body.planId : "";
    if (!/^[a-z0-9_-]{2,50}$/.test(planId)) return privateJson({ error: "Plano inválido" }, { status: 400 });
    const plan = await controlDb.plan.findUnique({ where: { id: planId } });
    if (!plan || !canAssignPlan(plan)) return privateJson({ error: "Plano inválido" }, { status: 400 });
    const planCode=configuration.billingPlanCodes[plan.id];
    if (!planCode || !/^[a-z0-9_-]{2,100}$/.test(planCode)) return privateJson({error:"Plano sem correspondência no sistema de cobrança."},{status:503});
    if (body.dueDay !== undefined && typeof body.dueDay !== "string" && typeof body.dueDay !== "number") return privateJson({error:"Dia do vencimento inválido."},{status:400});
    const paymentDueDay=Number(body.dueDay ?? configuration.dueDay);
    if (!Number.isInteger(paymentDueDay) || paymentDueDay<1 || paymentDueDay>28) return privateJson({error:"Dia do vencimento inválido."},{status:400});
    const passwordHash = await hashPassword(password);
    const suffix = randomUUID().slice(0, 8); const slug=`${slugify(company)}-${suffix}`;
    const result = await controlDb.$transaction(async (db) => {
      const organization = await db.organization.create({ data: { id: `org-${randomUUID()}`, slug, name: company, document, ownerName: name, email, planId: plan.id, status: "provisioning", modules: plan.modules as Prisma.InputJsonValue, trialEndsAt: new Date(Date.now() + configuration.trialDays * 86400000).toISOString().slice(0, 10) } });
      const user = await db.user.create({ data: { name, email, passwordHash, role: "user" } });
      await db.membership.create({ data: { userId: user.id, organizationId: organization.id, role: "owner" } });
      await db.provisioningJob.create({ data: { organizationId: organization.id } });
      await db.billingAccount.create({data:{organizationId:organization.id,externalId:organization.id,planCode:planCode,paymentMethod,modules:[]}});
      const billingJob=await db.billingProvisionJob.create({data:{organizationId:organization.id,payload:{external_id:organization.id,razao_social:company,nome_fantasia:company,tipo_pessoa:document.length>11?'PJ':'PF',documento:document,responsavel:{nome:name,email,telefone:limited(body.phone,24),cpf:responsibleCpf},endereco:{cep:zip,logradouro:limited(body.street,180),numero:limited(body.number,30),bairro:limited(body.district,120),cidade:limited(body.city,120),estado:state},plano_codigo:planCode,forma_pagamento:paymentMethod,modulos:[],dia_vencimento:paymentDueDay,tenant:{nome:`${company} — NALVEN`,url:`${configuration.origin}/erp`,ambiente:'producao',versao:billing.appVersion,metadata:{organization_id:organization.id}}}}});
      await db.auditLog.create({ data: { userId: user.id, action: "organization.signup", entityType: "organization", entityId: organization.id } });
      return { user, organization, billingJob };
    });
    await incrementFunnelStep("signup_completed").catch(() => undefined);
    await createSession(result.user.id, result.organization.id, false, result.user.passwordHash);
    return privateJson({ user: { id: result.user.id, name: result.user.name, email: result.user.email }, organization: { id: result.organization.id, name: result.organization.name, slug: result.organization.slug, status: result.organization.status } }, { status: 201 });
  } catch (error) {
    if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return privateJson({ error: "Não foi possível concluir o cadastro com esses dados. Se já possui uma conta, entre ou recupere sua senha.", code: "SIGNUP_CONFLICT" }, { status: 409 });
    return unexpectedErrorResponse("auth.signup", error);
  }
}
function digits(value:unknown){return typeof value === "string" ? value.replace(/\D/g,'') : ""}function limited(value:unknown,max:number){const text=typeof value === "string" ? value.trim() : "";return text.length<=max?text:""}
// The provisioner accepts at most 45 characters, including the nine-character suffix.
function slugify(value:string){return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,36).replace(/-$/,'')||'empresa'}
