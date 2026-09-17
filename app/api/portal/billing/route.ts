import { billingList, detailPayload, object, publicPortalData, visibleLicenseResources } from "@/lib/billing/portal-data";
import { tenantDb } from "@/db/tenant";
import { matches } from "@/lib/erp/permissions";
import { ERP_MODULES } from "@/lib/erp/modules";
import { planAllows } from "@/lib/erp/plan-features";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { AuthError, authErrorResponse, currentMembership, currentUser } from "@/lib/auth";
import { billingClient, BillingError } from "@/lib/billing/client";
import { controlDb } from "@/db/control";
import type { Prisma } from "@/generated/control/client";
import { enforceControlRateLimit, privateJson, readJsonObject, assertTrustedMutation } from "@/lib/http-security";
import { executeSupportCommand, readSupportDetail, supportContext, supportFailure } from "@/lib/billing/support-service";
import { SupportDataError, SupportInputError } from "@/lib/billing/support-data";

export async function GET(request: Request) {
  try {
    const { externalId, organizationId } = await tenant();
    const query = new URL(request.url).searchParams;
    const resource = query.get("resource");

    if (resource && !["invoice", "contract", "ticket"].includes(resource)) throw new PortalInputError("Recurso inválido.");
    if (resource === "invoice") return privateJson(publicPortalData(detailPayload(await billingClient.invoice(externalId, required(query.get("id"))), "invoice")));
    if (resource === "contract") return privateJson(publicPortalData(detailPayload(await billingClient.contract(externalId, required(query.get("token"))), "contract")));
    if (resource === "ticket") {
      try {
      const { ticket } = await readSupportDetail(await supportContext(request), query.get("token"));
      return privateJson({ token: ticket.token, titulo: ticket.title, descricao: ticket.description, categoria: ticket.category, prioridade: ticket.priority, status: ticket.status, created_at: ticket.createdAt, updated_at: ticket.updatedAt, messages: ticket.messages.map(message => ({ id: message.id, autor_nome: message.authorName, autor_tipo: message.authorType === "client" ? "cliente" : message.authorType === "support" ? "atendente" : "sistema", mensagem: message.body, created_at: message.createdAt, anexos: message.attachments.map(file => ({ id: file.id, nome_original: file.name, mime_type: file.mimeType, tamanho: file.size })) })) });
      } catch (error) { return supportFailure(error); }
    }

    const organization = await controlDb.organization.findUniqueOrThrow({where: {id: organizationId}, include: {plan: true}});
    const access = await assertTenantPermission(organizationId,"billing.read");
    const [portalResult, fiscalResult, catalogResult] = await Promise.allSettled([
      billingClient.portal(externalId), billingClient.fiscalDocuments(externalId), billingClient.catalog()
    ]);
    const errors: Record<string,string> = {};
    const remote = (result: PromiseSettledResult<Record<string,unknown>>, key: string) => {
      if(result.status === "fulfilled") return result.value;
      errors[key] = "Não foi possível consultar este serviço agora. Tente atualizar novamente.";
      return null;
    };
    const portal = remote(portalResult,"portal"), fiscal = remote(fiscalResult,"fiscal"), catalog=remote(catalogResult,"catalog");
    let documents: unknown[] | null = null;
    if(fiscal) {try {documents=billingList(fiscal);}catch {errors.fiscal="Resposta fiscal inválida. Tente novamente mais tarde.";}}
    const services=planAllows(organization.modules,"service-orders"), marketplaces=planAllows(organization.modules,"marketplaces");
    const license=object(portal?.license);
    const modules = ERP_MODULES.filter(module => planAllows(organization.modules, module.id)).map(module => ({id:module.id, name:module.id === "products" && !services ? "Produtos" : module.label}));
    const snapshot = publicPortalData({...portal, license: {...license, recursos:visibleLicenseResources(license.recursos,services,marketplaces)}, fiscal_documents:documents, catalog,
      organization: {name:organization.name,status:organization.status},
      application_plan:{name:organization.plan.name,modules}, capabilities:{canWrite:matches(access.permissions,"billing.write")},
      section_errors:errors, generated_at:new Date().toISOString()});
    if(portal) await controlDb.billingAccount.update({where:{externalId},data:{portalCache:snapshot as Prisma.InputJsonValue,lastError:Object.keys(errors).length?"Consulta parcial do portal":null}});
    return privateJson(snapshot);

  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 64 * 1024 });
    const context = await tenant(true);
    await enforceControlRateLimit(controlDb, `portal:${context.userId}:billing`, 60, 60);
    const body = await readJsonObject(request, 64 * 1024);
    const action = String(body.action || "");
    let result: unknown;

    if (action === "charge") {
      result = await billingClient.charge(context.externalId, required(body.invoiceId), chargePayload(body.payload), command(body.commandId));
    } else if (action === "contract_otp") {
      result = await billingClient.contractOtp(context.externalId, required(body.token), command(body.commandId));
    } else if (action === "contract_sign") {
      if(body.accepted!==true)throw new PortalInputError("Confirme a leitura e o aceite dos termos.");
      result = await billingClient.signContract(context.externalId, required(body.token), otp(body.otp), command(body.commandId));
    } else if (action === "ticket_create") {
      try { result = await executeSupportCommand(await supportContext(request, true), body); } catch (error) { return supportFailure(error); }
    } else if (action === "ticket_reply") {
      try { result = await executeSupportCommand(await supportContext(request, true), body); } catch (error) { return supportFailure(error); }
    } else if (action === "customer_update") {
      const payload=customerPayload(body.payload);
      result = await billingClient.updateCustomer(context.externalId, payload, command(body.commandId));
      await controlDb.organization.update({where:{id:context.organizationId},data:{name:payload.nome_fantasia}});
      const db=await tenantDb(context.organizationId);
      await db.tenantSettings.updateMany({where:{id:1},data:{tradeName:payload.nome_fantasia,organizationName:payload.nome_fantasia}});
    } else if (action === "subscription_update") {
      result = await billingClient.updateSubscription(context.externalId, subscriptionPayload(body.payload), command(body.commandId));
    } else {
      throw new PortalInputError("Ação inválida.");
    }

    await controlDb.auditLog.create({
      data: { userId: context.userId, action: `portal.billing.${action}`, entityType: "organization", entityId: context.organizationId }
    });
    return privateJson({ ok: true, result });
  } catch (error) {
    return failure(error);
  }
}

async function tenant(write = false) {
  const user = await currentUser();
  if (!user) throw new AuthError(401);
  const membership = await currentMembership(user);
  if (!membership) throw new AuthError(403);
  await assertTenantPermission(membership.organizationId, write ? "billing.write" : "billing.read");
  const account = await controlDb.billingAccount.upsert({
    where: { organizationId: membership.organizationId },
    update: {},
    create: { organizationId: membership.organizationId, externalId: membership.organizationId, modules: [] }
  });
  return { ...account, userId: user.id };
}

function customerPayload(value: unknown) {
  const input = record(value);
  return {
    nome_fantasia: limited(input.nome_fantasia, 2, 180),
    responsavel: {
      nome: limited(input.responsavel_nome, 2, 180),
      email: email(input.responsavel_email),
      telefone: limited(input.responsavel_telefone, 8, 24)
    },
    endereco: {
      cep: limited(input.cep, 8, 10),
      logradouro: limited(input.logradouro, 2, 180),
      numero: limited(input.numero, 1, 30),
      complemento: String(input.complemento || "").trim().slice(0, 120),
      bairro: limited(input.bairro, 2, 120),
      cidade: limited(input.cidade, 2, 120),
      estado: limited(input.estado, 2, 2).toUpperCase()
    }
  };
}

function subscriptionPayload(value: unknown) {
  const input = record(value);
  const method = String(input.forma_pagamento || "");
  if (!["pix", "boleto", "cartao"].includes(method)) throw new PortalInputError("Forma de pagamento inválida.");
  const dueDay = Number(input.dia_vencimento);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) throw new PortalInputError("O vencimento deve ficar entre os dias 1 e 28.");
  return {
    plano_codigo: limited(input.plano_codigo, 2, 50),
    forma_pagamento: method,
    modulos: Array.isArray(input.modulos) ? input.modulos.map(String).filter(Boolean).slice(0, 50) : [],
    dia_vencimento: dueDay
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PortalInputError("Dados inválidos.");
  return value as Record<string, unknown>;
}
function required(value: unknown) { const text = String(value || "").trim(); if (!text || text.length>200 || /[\r\n\0]/.test(text)) throw new PortalInputError("Parâmetro obrigatório inválido."); return text; }
function limited(value: unknown, min: number, max: number) { const text = String(value || "").trim(); if (text.length < min || text.length > max) throw new PortalInputError("Revise os campos obrigatórios."); return text; }
function email(value: unknown) { const text = limited(value, 5, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new PortalInputError("E-mail inválido."); return text; }
function command(value: unknown) { const id=String(value||"");if(!/^[a-zA-Z0-9_-]{16,120}$/.test(id))throw new PortalInputError("Identificador da operação inválido.");return id; }
function otp(value:unknown) {const code=String(value||"");if(!/^\d{6,8}$/.test(code))throw new PortalInputError("Informe o código de 6 a 8 dígitos.");return code;}
function chargePayload(value:unknown) {const data=record(value);if(!["pix","boleto","cartao"].includes(String(data.metodo)))throw new PortalInputError("Método inválido.");return {metodo:data.metodo,gateway:data.metodo==="cartao"?"mercado_pago":"inter",reemitir:false};}

function failure(error: unknown) { if (error instanceof SupportInputError || error instanceof SupportDataError) return supportFailure(error); if (error instanceof BillingError) return privateJson({ error: error.status >= 500 ? "Serviço financeiro temporariamente indisponível." : error.message, requestId: error.requestId }, { status: error.status }); if (error instanceof PortalInputError) return privateJson({ error: error.message }, { status: 400 }); return authErrorResponse(error); }
class PortalInputError extends Error {}
