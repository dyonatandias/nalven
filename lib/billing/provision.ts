import type {Prisma} from '@/generated/control/client';
import {controlDb} from '@/db/control';
import {encryptSecret} from '@/lib/secrets';
import {billingClient,BillingError} from './client';
import type {CustomerInput} from './types';
import { BILLING_CONFLICT_MESSAGE, customerIdentityError } from './customer-identity';

const STALE_MINUTES=10;

export async function processBillingJobs(limit=10){
  await recoverStaleBillingJobs();
  const jobs=await controlDb.billingProvisionJob.findMany({where:{status:{in:['pending','retry']},nextAttemptAt:{lte:new Date()}},orderBy:{createdAt:'asc'},take:limit});
  const results=[];
  for(const job of jobs)results.push(await processBillingJob(job.id));
  return results;
}

export async function recoverStaleBillingJobs(){
  const stale=new Date(Date.now()-STALE_MINUTES*60_000);
  return controlDb.billingProvisionJob.updateMany({where:{status:'processing',OR:[{lockedAt:null},{lockedAt:{lt:stale}}]},data:{status:'retry',nextAttemptAt:new Date(),lockedAt:null,lastError:'Execução anterior interrompida; retomada automática.',errorCode:'STALE_JOB'}});
}

export async function retryBillingProvision(organizationId:string){
  const job=await controlDb.billingProvisionJob.findFirst({where:{organizationId},orderBy:{createdAt:'desc'}});
  if(!job)throw new Error('Esta organização ainda não possui dados completos de onboarding para o Billing.');
  if(job.errorCode === 'HTTP_409')throw new BillingError(BILLING_CONFLICT_MESSAGE,409);
  if(job.status === 'processing')throw new BillingError('Provisionamento já está em execução.',409);
  await controlDb.billingProvisionJob.update({where:{id:job.id},data:{status:'pending',nextAttemptAt:new Date(),finishedAt:null,lockedAt:null,lastError:null,errorCode:null,requestId:null}});
  await controlDb.billingAccount.updateMany({where:{organizationId},data:{remoteStatus:'pending',lastError:null}});
  return controlDb.billingProvisionJob.findUniqueOrThrow({where:{id:job.id}});
}

export async function unblockBillingJobs(db:Pick<Prisma.TransactionClient,'billingProvisionJob'>=controlDb){
  return db.billingProvisionJob.updateMany({where:{status:'blocked'},data:{status:'pending',nextAttemptAt:new Date(),lastError:null,errorCode:null}});
}

export async function processBillingJob(id:string){
  const now=new Date();
  const claimed=await controlDb.billingProvisionJob.updateMany({where:{id,status:{in:['pending','retry']}},data:{status:'processing',attempts:{increment:1},lockedAt:now,lastAttemptAt:now}});
  if(!claimed.count)return{id,status:'skipped'};
  const job=await controlDb.billingProvisionJob.findUniqueOrThrow({where:{id}});
  const payload=job.payload as unknown as CustomerInput;
  try{
    if(job.errorCode === 'HTTP_409')throw new BillingError(BILLING_CONFLICT_MESSAGE,409);
    const organization = await controlDb.organization.findUnique({where:{id:job.organizationId},select:{id:true,document:true,email:true}});
    const identityAccount = await controlDb.billingAccount.findUnique({where:{organizationId:job.organizationId},select:{externalId:true}});
    if(!organization)throw new BillingError('Organização não encontrada.',404);
    const identityError = customerIdentityError(payload,organization,identityAccount?.externalId);
    if(identityError)throw new BillingError(identityError,422);
    let response:Record<string,unknown>;
    let existing=false;
    try{response=await billingClient.customer(payload.external_id);existing=true}catch(error){if(!(error instanceof BillingError)||error.status!==404)throw error;response=await billingClient.createCustomer(payload,`job-${job.id}`)}
    let licenseKey=findLicenseKey(response);
    const account=await controlDb.billingAccount.findUnique({where:{organizationId:job.organizationId}});
    if(existing&&!account?.licenseSecret){const rotated=await billingClient.rotateLicense(payload.external_id,`job-${job.id}-license-recovery`);licenseKey=findLicenseKey(rotated)}
    if(!licenseKey&&!account?.licenseSecret)throw new BillingError('Billing vinculou o cliente, mas não entregou a chave de licença recuperável.',503);
    await completeJob(job.id,job.organizationId,payload,response,licenseKey);
    return{id,status:'completed',mode:existing?'relinked':'created'};
  }catch(error){
    return handleFailure(job.id,job.organizationId,job.attempts,error);
  }
}

async function completeJob(id:string,organizationId:string,payload:CustomerInput,response:Record<string,unknown>,licenseKey:string|null){
  const now=new Date();
  await controlDb.$transaction(async db=>{
    const account = await db.billingAccount.findUnique({where:{organizationId},select:{externalId:true}});
    if(account && account.externalId !== payload.external_id)throw new BillingError('O vínculo existente não pode ter seu External ID alterado.',409);
    await db.billingAccount.upsert({where:{organizationId},update:{planCode:payload.plano_codigo,paymentMethod:payload.forma_pagamento,modules:payload.modulos as Prisma.InputJsonValue,portalCache:sanitizeResponse(response) as Prisma.InputJsonValue,lastSyncedAt:now,lastCheckedAt:now,provisionedAt:now,remoteStatus:'linked',lastError:null,...(licenseKey?{licenseSecret:encryptSecret(licenseKey)}:{})},create:{organizationId,externalId:payload.external_id,planCode:payload.plano_codigo,paymentMethod:payload.forma_pagamento,modules:payload.modulos as Prisma.InputJsonValue,portalCache:sanitizeResponse(response) as Prisma.InputJsonValue,lastSyncedAt:now,lastCheckedAt:now,provisionedAt:now,remoteStatus:'linked',licenseSecret:licenseKey?encryptSecret(licenseKey):null}});
    await db.billingProvisionJob.update({where:{id},data:{status:'completed',finishedAt:now,lockedAt:null,nextAttemptAt:now,lastError:null,errorCode:null,requestId:null}});
  });
}

async function handleFailure(id:string,organizationId:string,attempts:number,error:unknown){
  if(isConfigurationFailure(error)){
    const detail=safeError(error);
    await Promise.all([controlDb.billingProvisionJob.update({where:{id},data:{status:'blocked',lockedAt:null,lastError:detail,errorCode:codeFor(error),requestId:error instanceof BillingError?error.requestId:null}}),controlDb.billingAccount.updateMany({where:{organizationId},data:{remoteStatus:'blocked',lastError:detail,lastCheckedAt:new Date()}})]);
    return{id,status:'blocked'};
  }
  if(isPermanentFailure(error)){
    const detail=safeError(error);
    await Promise.all([controlDb.billingProvisionJob.update({where:{id},data:{status:'failed',lockedAt:null,finishedAt:new Date(),lastError:detail,errorCode:codeFor(error),requestId:error instanceof BillingError?error.requestId:null}}),controlDb.billingAccount.updateMany({where:{organizationId},data:{remoteStatus:'failed',lastError:detail,lastCheckedAt:new Date()}})]);
    return{id,status:'failed',error:detail,errorCode:codeFor(error)};
  }
  return scheduleRetry(id,organizationId,attempts,error);
}

async function scheduleRetry(id:string,organizationId:string,attempts:number,error:unknown){
  const retryAfter=error instanceof BillingError?error.retryAfter:undefined;
  const base=Math.min(3600,30*2**Math.min(Math.max(attempts-1,0),7));
  const delay=Math.max(retryAfter||0,Math.round(base*(.85+Math.random()*.3)));
  const detail=safeError(error);
  await Promise.all([controlDb.billingProvisionJob.update({where:{id},data:{status:'retry',lockedAt:null,nextAttemptAt:new Date(Date.now()+delay*1000),lastError:detail,errorCode:codeFor(error),requestId:error instanceof BillingError?error.requestId:null}}),controlDb.billingAccount.updateMany({where:{organizationId},data:{remoteStatus:'retrying',lastError:detail,lastCheckedAt:new Date()}})]);
  return{id,status:'retry',retryInSeconds:delay};
}

function isConfigurationFailure(error:unknown){return error instanceof BillingError&&(error.status===401||error.status===403||(error.status===503&&error.message.includes('Credencial permanente')))}
function isPermanentFailure(error:unknown){return error instanceof BillingError&&(error.status===409||([400,404,422].includes(error.status)&&!error.retryAfter))}
function codeFor(error:unknown){return error instanceof BillingError?`HTTP_${error.status}`:'UNEXPECTED'}
function findLicenseKey(value:unknown):string|null{if(!value||typeof value!=='object')return null;const record=value as Record<string,unknown>;if(typeof record.key==='string'&&record.key.startsWith('lic_'))return record.key;for(const child of Object.values(record)){const found=findLicenseKey(child);if(found)return found}return null}
function sanitizeResponse(value:Record<string,unknown>){const copy=structuredClone(value);removeSecrets(copy);return copy}
function removeSecrets(value:unknown){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value as Record<string,unknown>)){if((key==='key'||key==='chave'||key==='secret')&&typeof child==='string')delete(value as Record<string,unknown>)[key];else removeSecrets(child)}}
function safeError(error:unknown){if(error instanceof BillingError&&error.status===409)return BILLING_CONFLICT_MESSAGE;const text=error instanceof Error?error.message:'Falha desconhecida';return text.replace(/skp_nalven_[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/lic_[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,1000)}
