import {controlDb} from '@/db/control';
import {assertTenantLicensed,LicenseDeniedError} from '@/lib/billing/license';

export async function assertTenantWriteAccess(organizationId:string){
  const organization=await controlDb.organization.findUnique({where:{id:organizationId}});
  if(!organization)throw new LicenseDeniedError('Organização não encontrada.');
  if(['past_due','suspended'].includes(organization.status))throw new LicenseDeniedError('A organização está suspensa. Regularize a assinatura em Minha Conta.');
  const billing=await controlDb.billingAccount.findUnique({where:{organizationId}});
  if(billing?.remoteStatus==='linked'&&billing.licenseSecret)return assertTenantLicensed(organizationId);
  const today=new Date().toISOString().slice(0,10);
  if(organization.trialEndsAt&&organization.trialEndsAt>=today)return{trial:true,expiresAt:organization.trialEndsAt};
  throw new LicenseDeniedError('O período de teste terminou e a ativação financeira ainda não foi concluída. Acesse Minha Conta.');
}
