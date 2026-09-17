import {randomUUID} from 'node:crypto';
import {controlDb} from '@/db/control';
import {AuthError,authErrorResponse,requireUser} from '@/lib/auth';
import {billingClient,billingSettings,BillingError,type BillingSettings} from '@/lib/billing/client';
import {fingerprintSecret,generateWebhookSecret,setVaultSecret,vaultMetadata,VAULT_KEYS} from '@/lib/vault';
import {processBillingJob,retryBillingProvision,unblockBillingJobs} from '@/lib/billing/provision';
import {billingAccountFor,reconcileBilling,syncBillingOrganization} from '@/lib/billing/sync';
import {verifyPassword} from '@/lib/password';
import {enforceControlRateLimit,privateJson,readJsonObject} from '@/lib/http-security';
import { validatePublicHttpsUrl } from '@/lib/integrations/security';
import { validBillingHeadlessUrl } from '@/lib/billing/endpoint-policy';

export async function GET(){
  try{
    await requireUser('superadmin');
    const [accounts,events,jobs,settings,secrets,credentialConfigured]=await Promise.all([
      controlDb.billingAccount.findMany({select:{id:true,organizationId:true,externalId:true,planCode:true,paymentMethod:true,subscriptionStatus:true,remoteStatus:true,lastSyncedAt:true,lastError:true,organization:{select:{name:true,status:true}}},orderBy:{updatedAt:'desc'}}),
      controlDb.billingWebhookEvent.findMany({select:{webhookId:true,event:true,externalId:true,receivedAt:true},orderBy:{receivedAt:'desc'},take:100}),
      controlDb.billingProvisionJob.findMany({select:{id:true,organizationId:true,status:true,attempts:true,nextAttemptAt:true,lastError:true,errorCode:true},orderBy:{createdAt:'desc'},take:100}),
      billingSettings(),vaultMetadata('billing'),billingClient.configured()
    ]);
    const secret=(key:string)=>secrets.find(item=>item.key===key)||null;
    return privateJson({configuration:{...settings,credentialConfigured,credential:secret(VAULT_KEYS.billingApi),webhookConfigured:Boolean(secret(VAULT_KEYS.billingWebhook)),webhook:secret(VAULT_KEYS.billingWebhook),webhookUrl:`${settings.publicAppUrl.replace(/\/$/,'')}/api/webhooks/billing`},accounts,events,jobs});
  }catch(e){return authErrorResponse(e)}
}

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const actor=await requireUser('superadmin');
    await enforceControlRateLimit(controlDb,`admin:${actor.id}:billing`,30,60);
    const b=await readJsonObject(request,64*1024);
    const action=String(b.action||'');
    let result:unknown;
    if(action==='configuration.save')return privateJson({ok:true,result:await saveConfiguration(b,actor)});
    else if(action==='webhook.import'){
      await confirmSensitive(actor.passwordHash,b.currentPassword);
      const value=validWebhookSecret(b.webhookSecret);
      assertExpectedFingerprint(value,b.expectedFingerprint);
      const metadata=await saveWebhookSecret(value,actor.id,action);
      return privateJson({ok:true,result:{metadata}});
    }
    else if(action==='webhook.rotate'){
      if(b.confirm!==true)throw new Error('Confirme a rotação do segredo do webhook.');
      await confirmSensitive(actor.passwordHash,b.currentPassword);
      const value=generateWebhookSecret();
      const metadata=await saveWebhookSecret(value,actor.id,action);
      return privateJson({ok:true,result:{oneTimeSecret:value,metadata}});
    }else if(action==='test')result={catalog:await billingClient.catalog(),paymentConfig:await billingClient.paymentConfig()};
    else if(action==='sync'){const id=required(b.organizationId);result=await syncBillingOrganization(id)}
    else if(action==='retry_provision'){const job=await retryBillingProvision(required(b.organizationId));result=await processBillingJob(job.id)}
    else if(action==='subscription'){const account=await billingAccountFor(required(b.organizationId));result=await billingClient.updateSubscription(account.externalId,{plano_codigo:required(b.planCode),forma_pagamento:required(b.paymentMethod),modulos:Array.isArray(b.modules)?b.modules:[],dia_vencimento:Number(b.dueDay||10)},randomUUID());await syncBillingOrganization(account.organizationId)}
    else if(action==='subscription_action'){const account=await billingAccountFor(required(b.organizationId));result=await billingClient.subscriptionAction(account.externalId,{acao:required(b.subscriptionAction),motivo:String(b.reason||'')},randomUUID());await syncBillingOrganization(account.organizationId)}
    else if(action==='reconcile')result=await reconcileBilling();
    else throw new Error('Ação inválida.');
    await controlDb.auditLog.create({data:{userId:actor.id,action:`billing.${action}`,entityType:'billing',metadata:{organizationId:b.organizationId||null}}});
    if(result && typeof result === 'object' && 'status' in result && result.status === 'failed' && 'error' in result)return privateJson({error:result.error},{status:'errorCode' in result && result.errorCode === 'HTTP_409'?409:422});
    return privateJson({ok:true,result});
  }catch(e){if(e instanceof BillingError)return privateJson({error:e.message,requestId:e.requestId},{status:e.status});if(e instanceof BillingInputError)return privateJson({error:e.message},{status:400});return authErrorResponse(e)}
}

class BillingInputError extends Error{}

async function saveConfiguration(body:Record<string,unknown>,actor:{id:string;passwordHash:string}){
  // Changing the destination can redirect an existing credential; always reconfirm.
  await confirmSensitive(actor.passwordHash,body.currentPassword);
  const current=await billingSettings();
  const settings:BillingSettings={
    baseUrl:secureUrl(body.baseUrl,current.baseUrl),
    headlessBaseUrl:secureUrl(body.headlessBaseUrl,current.headlessBaseUrl),
    publicAppUrl:secureUrl(body.publicAppUrl,current.publicAppUrl),
    productCode:slug(body.productCode,current.productCode),
    appVersion:shortText(body.appVersion,current.appVersion,30),
    licenseTimeoutMs:current.licenseTimeoutMs,
    licenseCacheSeconds:current.licenseCacheSeconds,
  };
  if(!validBillingHeadlessUrl(settings.headlessBaseUrl))throw new BillingInputError('Use a API headless /api/v1/saas. Rotas legadas /api/external não são permitidas.');
  try {
    await Promise.all([
      validatePublicHttpsUrl(settings.baseUrl),
      validatePublicHttpsUrl(settings.headlessBaseUrl),
      validatePublicHttpsUrl(settings.publicAppUrl),
    ]);
  } catch {
    throw new BillingInputError('As URLs devem usar HTTPS e resolver somente para endereços públicos.');
  }
  const apiKey=String(body.apiKey||'').trim();
  // Validate sensitive input before making any configuration change.
  if(apiKey){
    if(!apiKey.startsWith('skp_nalven_')||apiKey.length<20)throw new BillingInputError('A chave deve ser uma credencial permanente skp_nalven_ válida.');
    assertExpectedFingerprint(apiKey,body.apiKeyFingerprint);
  }
  return controlDb.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890126)`;
    await tx.systemSetting.upsert({where:{key:'billing'},update:{value:settings},create:{key:'billing',value:settings}});
    const credential=apiKey?await setVaultSecret(VAULT_KEYS.billingApi,apiKey,'billing',actor.id,tx):null;
    if(apiKey)await unblockBillingJobs(tx);
    await tx.auditLog.create({data:{userId:actor.id,action:'billing.configuration.save',entityType:'billing',metadata:{credentialChanged:Boolean(apiKey)}}});
    return{settings,credential};
  });
}

async function saveWebhookSecret(value:string,actorId:string,action:string){
  return controlDb.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890126)`;
    const metadata=await setVaultSecret(VAULT_KEYS.billingWebhook,value,'billing',actorId,tx);
    await tx.auditLog.create({data:{userId:actorId,action:`billing.${action}`,entityType:'billing'}});
    return metadata;
  });
}

function required(v:unknown){const s=String(v||'').trim();if(!s)throw new Error('Campo obrigatório ausente.');return s}
function secureUrl(value:unknown,fallback:string){const raw=String(value||fallback).trim();try{const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password)throw new Error();return raw.replace(/\/$/,'')}catch{throw new BillingInputError('As URLs da integração devem usar HTTPS sem credenciais embutidas.')}}
function slug(value:unknown,fallback:string){const raw=String(value||fallback).trim();if(!/^[a-z0-9_-]{2,50}$/.test(raw))throw new Error('Código do produto inválido.');return raw}
function shortText(value:unknown,fallback:string,max:number){const raw=String(value||fallback).trim();if(!raw||raw.length>max)throw new Error('Versão inválida.');return raw}
async function confirmSensitive(passwordHash:string,value:unknown){const password=String(value||'');if(!password||!await verifyPassword(password,passwordHash))throw new AuthError(403)}
function validWebhookSecret(value:unknown){const secret=String(value||'').trim();if(secret.length<32||secret.length>512||/[\r\n\0]/.test(secret))throw new BillingInputError('Segredo HMAC inválido. Use a exibição única gerada pelo Billing.');return secret}
function assertExpectedFingerprint(secret:string,value:unknown){const expected=String(value||'').trim().toLowerCase();if(!expected)return;if(!/^[a-f0-9]{16}$/.test(expected))throw new BillingInputError('O fingerprint deve conter os 16 caracteres exibidos no Billing.');if(fingerprintSecret(secret)!==expected)throw new BillingInputError('Fingerprint divergente. O segredo não foi alterado.')}
function assertSameOrigin(request:Request){const origin=request.headers.get('origin');if(!origin)return;const host=request.headers.get('x-forwarded-host')||request.headers.get('host');if(!host||new URL(origin).host!==host)throw new AuthError(403)}
