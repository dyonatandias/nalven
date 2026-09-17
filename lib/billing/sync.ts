import {Prisma} from '@/generated/control/client';
import {controlDb} from '@/db/control';
import {billingClient,BillingError} from './client';
import {processBillingJob,processBillingJobs,retryBillingProvision} from './provision';

export async function billingAccountFor(organizationId:string){const org=await controlDb.organization.findUnique({where:{id:organizationId}});if(!org)throw new Error('Organização não encontrada.');return controlDb.billingAccount.upsert({where:{organizationId},update:{},create:{organizationId,externalId:org.id,modules:[],remoteStatus:'pending'}})}

export async function syncBillingOrganization(organizationId:string,repair=true):Promise<unknown>{
  const account=await billingAccountFor(organizationId);
  let customer:Record<string,unknown>;
  try{customer=await billingClient.customer(account.externalId)}catch(error){
    if(!(error instanceof BillingError)||error.status!==404||!repair){await controlDb.billingAccount.update({where:{id:account.id},data:{lastCheckedAt:new Date(),lastError:error instanceof Error?error.message:'Falha ao sincronizar'}});throw error}
    await controlDb.billingAccount.update({where:{id:account.id},data:{remoteStatus:'missing',lastCheckedAt:new Date(),lastError:'Vínculo não encontrado no Billing; provisionamento reaberto.'}});
    const job=await retryBillingProvision(organizationId);
    const result=await processBillingJob(job.id);
    if(result.status==='completed'){customer=await billingClient.customer(account.externalId);return pullLinkedResources(account.id,account.externalId,customer)}
    return{provisioning:result};
  }
  return pullLinkedResources(account.id,account.externalId,customer);
}

export async function reconcileBilling(){
  const run=await controlDb.billingSyncRun.create({data:{kind:'full',status:'running',cursor:'0'}});
  let cursor='0',processed=0;
  const seen=new Set<string>();
  try{
    await processBillingJobs(25);
    do{
      const page=await billingClient.listCustomers(cursor);
      for(const item of page.items){
        const externalId=String(item.external_id||'');
        if(!externalId)continue;
        seen.add(externalId);
        const account=await controlDb.billingAccount.findUnique({where:{externalId}});
        if(account){await syncBillingOrganization(account.organizationId,false);processed++}
      }
      cursor=page.next_cursor||'';
      await controlDb.billingSyncRun.update({where:{id:run.id},data:{cursor,processed}});
      if(!page.has_more)break;
    }while(cursor);
    const local=await controlDb.billingAccount.findMany({select:{organizationId:true,externalId:true}});
    let requeued=0;
    for(const account of local){if(!seen.has(account.externalId)){try{await retryBillingProvision(account.organizationId);requeued++}catch{/* onboarding incompleto exige correção manual */}}}
    const jobs=await processBillingJobs(25);
    await controlDb.billingSyncRun.update({where:{id:run.id},data:{status:'completed',processed,finishedAt:new Date(),cursor:null}});
    return{processed,requeued,jobs};
  }catch(error){await controlDb.billingSyncRun.update({where:{id:run.id},data:{status:'failed',processed,error:error instanceof Error?error.message:'Erro',finishedAt:new Date(),cursor}});throw error}
}

async function pullLinkedResources(accountId:string,externalId:string,customer:Record<string,unknown>){
  const [subscription,license,portal]=await Promise.all([billingClient.subscription(externalId),billingClient.license(externalId),billingClient.portal(externalId)]);
  const c=customer as Record<string,unknown>,s=subscription as Record<string,unknown>;
  const l=license.license&&typeof license.license==='object'&&!Array.isArray(license.license)?license.license as Record<string,unknown>:{};
  const licenseStatus=typeof l.status==='string'&&/^[a-zA-Z_-]{1,60}$/.test(l.status)?l.status:null;
  return controlDb.billingAccount.update({where:{id:accountId},data:{billingCustomerId:text(c.id||c.cliente_id)||null,planCode:text(s.plano_codigo||s.plano)||null,paymentMethod:text(s.forma_pagamento)||null,modules:(Array.isArray(s.modulos)?s.modulos:[]) as Prisma.InputJsonValue,subscriptionStatus:text(s.status)||null,licenseStatus,entitlementCache:Prisma.DbNull,portalCache:portal as Prisma.InputJsonValue,lastSyncedAt:new Date(),lastCheckedAt:new Date(),provisionedAt:new Date(),remoteStatus:'linked',lastError:null}})
}
function text(value:unknown){return value==null?'':String(value)}
