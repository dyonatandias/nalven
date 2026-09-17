import {controlDb} from '../db/control';
import {setVaultSecret,VAULT_KEYS} from '../lib/vault';

async function main(){
  const current=await controlDb.systemSetting.findUnique({where:{key:'billing'}});
  const value={
    baseUrl:process.env.BILLING_BASE_URL||'https://sistema.agenciaexpresso.com.br/api/v1',
    headlessBaseUrl:process.env.BILLING_HEADLESS_BASE_URL||'https://sistema.agenciaexpresso.com.br/api/v1/saas',
    publicAppUrl:'https://nalven.com.br',
    productCode:process.env.NALVEN_PRODUCT_CODE||'nalven',
    appVersion:process.env.NALVEN_APP_VERSION||'0.9.0',
    licenseTimeoutMs:Number(process.env.NALVEN_LICENSE_TIMEOUT_MS||5000),
    licenseCacheSeconds:Number(process.env.NALVEN_LICENSE_CACHE_SECONDS||300),
    ...((current?.value||{}) as Record<string,unknown>),
  };
  await controlDb.systemSetting.upsert({where:{key:'billing'},update:{value},create:{key:'billing',value}});
  if(process.env.NALVEN_PRODUCT_API_KEY)await setVaultSecret(VAULT_KEYS.billingApi,process.env.NALVEN_PRODUCT_API_KEY,'billing');
  if(process.env.NALVEN_WEBHOOK_SECRET)await setVaultSecret(VAULT_KEYS.billingWebhook,process.env.NALVEN_WEBHOOK_SECRET,'billing');
  const migrated=await controlDb.vaultSecret.findMany({where:{category:'billing'},select:{key:true,fingerprint:true}});
  console.log(JSON.stringify({settings:'billing',secrets:migrated}));
}

main().finally(()=>controlDb.$disconnect());
