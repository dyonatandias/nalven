import { createHash } from "node:crypto";
import {Prisma} from '@/generated/control/client';
import {controlDb} from '@/db/control';
import type {BillingWebhookPayload} from '@/lib/billing/types';
import {verifyBillingWebhook} from '@/lib/billing/webhook';
import {getVaultSecret,VAULT_KEYS} from '@/lib/vault';
import {clientAddress,enforceControlRateLimit,HttpSecurityError,httpSecurityErrorResponse,privateJson,readBodyBytes} from '@/lib/http-security';

export async function POST(request:Request){
  try{
    if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return privateJson({success:false,error:'Content-Type inválido'},{status:415});
    await enforceControlRateLimit(controlDb,`billing-webhook:${clientAddress(request)}`,300,60);
    const secret=await getVaultSecret(VAULT_KEYS.billingWebhook);
    if(!secret)return privateJson({success:false,error:'Webhook não configurado'},{status:503});
    const raw=Buffer.from(await readBodyBytes(request,256*1024));
    const signature=request.headers.get('x-billing-signature')||'';
    const webhookId=request.headers.get('x-webhook-id')||'';
    if(signature.length>256||!verifyBillingWebhook(raw,signature,secret))return privateJson({success:false,error:'Assinatura inválida'},{status:401});
    if(!/^[A-Za-z0-9._:-]{8,200}$/.test(webhookId))return privateJson({success:false,error:'X-Webhook-Id inválido'},{status:400});
    let event:BillingWebhookPayload;
    try{event=JSON.parse(raw.toString('utf8'))}catch{return privateJson({success:false,error:'JSON inválido'},{status:400})}
    if(!event||typeof event!=='object'||!validField(event.event,100)||!validField(event.instance_id,200)||!validField(event.ocorrido_em,100))return privateJson({success:false,error:'Envelope incompleto'},{status:400});
    const signedId=createHash("sha256").update(raw).digest("hex");
    await controlDb.$transaction(async db=>{
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-webhook:${signedId}`}))`;
      const existing=await db.billingWebhookEvent.findFirst({where:{OR:[{webhookId:signedId},{payload:{equals:event as Prisma.InputJsonValue}}]}});
      if(existing)return;
      await db.billingWebhookEvent.create({data:{webhookId:signedId,event:event.event,externalId:event.instance_id,correlationId:event.correlation_id,payload:event as Prisma.InputJsonValue}});
      const linkedAccount=await db.billingAccount.findUnique({where:{externalId:event.instance_id}});
      const organization=await db.organization.findUnique({where:{id:linkedAccount?.organizationId || event.instance_id}});
      const existingAccount=linkedAccount || (organization ? await db.billingAccount.findUnique({where:{organizationId:organization.id}}) : null);
      if(organization && (!existingAccount || existingAccount.externalId === event.instance_id)){
        const subscriptionStatus=statusFor(event.event);
        // Runtime authorization has its own timestamp. Invalidate that snapshot
        // atomically with the event, including license/resource-only changes.
        await db.billingAccount.upsert({where:{organizationId:organization.id},update:{...(subscriptionStatus?{subscriptionStatus}:{}),entitlementCache:Prisma.DbNull,lastSyncedAt:null,lastError:null},create:{organizationId:organization.id,externalId:event.instance_id,modules:[],subscriptionStatus}});
        if(subscriptionStatus)await db.organization.update({where:{id:organization.id},data:{status:orgStatus(subscriptionStatus)}});
      }
      await db.billingWebhookEvent.update({where:{webhookId:signedId},data:{processedAt:new Date()}});
    });
  }catch(error){
    if(error instanceof HttpSecurityError)return httpSecurityErrorResponse(error);
    if(typeof error==='object'&&error&&'code'in error&&error.code==='P2002')return privateJson({success:true,duplicate:true});
    console.error('billing-webhook',{error:error instanceof Error?error.name:typeof error});
    return privateJson({success:false,error:'Falha ao persistir evento'},{status:500});
  }
  return privateJson({success:true});
}

function statusFor(event:string){if(event==='assinatura.suspensa'||event==='fatura.vencida')return 'suspended';if(event==='assinatura.reativada'||event==='fatura.paga'||event==='pagamento.confirmado')return 'active';if(event==='assinatura.cancelada')return 'cancelled';return null}
function orgStatus(status:string){return status==='active'?'active':status==='suspended'?'past_due':'suspended'}
function validField(value:unknown,maximum:number):value is string{return typeof value==='string'&&value.length>=1&&value.length<=maximum&&!/[\r\n\0]/.test(value)}
