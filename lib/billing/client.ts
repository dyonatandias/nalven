import { controlDb } from "@/db/control";
import { licensePolicy } from "./license-policy";
import { getVaultSecret, VAULT_KEYS } from "@/lib/vault";
import { safeRequest } from "@/lib/integrations/security";
import type { BillingEnvelope, CustomerInput } from "./types";
import { billingCommandKey as key } from "./idempotency";
import { validBillingHeadlessUrl } from "./endpoint-policy";

export class BillingError extends Error {
  constructor(message: string, public status: number, public requestId?: string, public retryAfter?: number) { super(message); if(status<400 || status>599)this.status=502; }
}

export class BillingClient {
  async configured() { return (await getVaultSecret(VAULT_KEYS.billingApi))?.startsWith("skp_nalven_") === true; }

  async request<T>(path: string, init: RequestInit = {}, idempotencyKey?: string): Promise<T> {
    const apiKey = await getVaultSecret(VAULT_KEYS.billingApi);
    if (!apiKey?.startsWith("skp_nalven_")) throw new BillingError("Credencial permanente do Billing não configurada.", 503);
    const baseUrl = await billingBaseUrl();
    let response: Awaited<ReturnType<typeof safeRequest>>;
    try {
      const body = typeof init.body === "string" || Buffer.isBuffer(init.body) ? init.body : undefined;
      if (init.body && body === undefined) throw new Error("unsupported_body");
      response = await safeRequest(`${baseUrl}${path}`, {
        method: init.method,
        body,
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}), ...Object.fromEntries(new Headers(init.headers)) },
        timeoutMs: 10000,
      });
    } catch { throw new BillingError("Billing indisponível ou timeout.", 503); }
    const retryText = first(response.headers["retry-after"]).trim(), retrySeconds = Number(retryText);
    const retryAfter = /^\d+$/.test(retryText) && Number.isSafeInteger(retrySeconds) && retrySeconds > 0 ? retrySeconds : undefined;
    const contentType = first(response.headers["content-type"]).split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new BillingError(`Resposta inesperada do Billing (${response.status}).`, response.status, undefined, retryAfter);
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); }
    catch { throw new BillingError(`Resposta inválida do Billing (${response.status}).`, response.status === 409 ? 409 : 502, undefined, retryAfter); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new BillingError(`Resposta inválida do Billing (${response.status}).`, response.status === 409 ? 409 : 502, undefined, retryAfter);
    const payload = parsed as BillingEnvelope<T>;
    const requestId = typeof payload.request_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(payload.request_id) ? payload.request_id : undefined;
    if (response.status < 200 || response.status >= 300) {
      const errorText = typeof payload.error === "string" ? payload.error.trim() : "";
      const message = errorText && errorText.length <= 500 && !/[\u0000-\u001f\u007f]/.test(errorText) ? errorText : `Billing HTTP ${response.status}`;
      throw new BillingError(message, response.status, requestId, retryAfter);
    }
    if (payload.success !== true || payload.data === undefined) throw new BillingError(`Resposta inválida do Billing (${response.status}).`, 502, requestId, retryAfter);
    return payload.data;
  }

  catalog(){return this.request<Record<string,unknown>>("/catalogo");}
  paymentConfig(){return this.request<Record<string,unknown>>("/payment-config");}
  listCustomers(cursor="0",updatedSince?:string){const q=new URLSearchParams({cursor,limit:"100"});if(updatedSince)q.set("updated_since",updatedSince);return this.request<{items:Array<Record<string,unknown>>;next_cursor:string|null;has_more:boolean}>(`/clientes?${q}`);}
  createCustomer(input:CustomerInput,commandId:string){return this.request<Record<string,unknown>>("/clientes",{method:"POST",body:JSON.stringify(input)},key(input.external_id,"customer",commandId));}
  customer(id:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}`);}
  updateCustomer(id:string,input:Record<string,unknown>,commandId:string){if("external_id" in input || "instance_id" in input)throw new BillingError("O identificador externo do vínculo é imutável.",422);return this.request<Record<string,unknown>>(`/clientes/${enc(id)}`,{method:"PATCH",body:JSON.stringify(input)},key(id,"customer-update",commandId));}
  subscription(id:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/assinatura`);}
  updateSubscription(id:string,input:Record<string,unknown>,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/assinatura`,{method:"PUT",body:JSON.stringify(input)},key(id,"subscription",commandId));}
  subscriptionAction(id:string,input:Record<string,unknown>,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/assinatura/acoes`,{method:"POST",body:JSON.stringify(input)},key(id,"subscription-action",commandId));}
  portal(id:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/portal`);}
  invoices(id:string,status?:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/faturas${status?`?status=${enc(status)}`:""}`);}
  invoice(id:string,invoiceId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/faturas/${enc(invoiceId)}`);}
  charge(id:string,invoiceId:string,input:Record<string,unknown>,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/faturas/${enc(invoiceId)}/cobrancas`,{method:"POST",body:JSON.stringify(input)},key(id,`invoice-${invoiceId}-charge`,commandId));}
  fiscalDocuments(id:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/documentos-fiscais`);}
  contracts(id:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/contratos`);}
  contract(id:string,token:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/contratos/${enc(token)}`);}
  contractOtp(id:string,token:string,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/contratos/${enc(token)}/otp`,{method:"POST",body:"{}"},key(id,`contract-${token}-otp`,commandId));}
  signContract(id:string,token:string,otp:string,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/contratos/${enc(token)}/assinar`,{method:"POST",body:JSON.stringify({codigo_otp:otp,aceite_termos:true})},key(id,`contract-${token}-sign`,commandId));}
  tickets(id:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/tickets`);}
  createTicket(id:string,input:Record<string,unknown>,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/tickets`,{method:"POST",body:JSON.stringify(input)},key(id,"ticket",commandId));}
  ticket(id:string,token:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/tickets/${enc(token)}`);}
  replyTicket(id:string,token:string,input:Record<string,unknown>,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/tickets/${enc(token)}`,{method:"POST",body:JSON.stringify(input)},key(id,`ticket-${token}-reply`,commandId));}
  license(id:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/licenca`);}
  rotateLicense(id:string,commandId:string){return this.request<Record<string,unknown>>(`/clientes/${enc(id)}/licenca/rotacionar-chave`,{method:"POST",body:"{}"},key(id,"license-rotate",commandId));}
}

export type BillingSettings = { baseUrl:string; headlessBaseUrl:string; publicAppUrl:string; productCode:string; appVersion:string; licenseTimeoutMs:number; licenseCacheSeconds:number };
const defaults:BillingSettings={baseUrl:"https://sistema.agenciaexpresso.com.br/api/v1",headlessBaseUrl:"https://sistema.agenciaexpresso.com.br/api/v1/saas",publicAppUrl:"https://nalven.com.br",productCode:"nalven",appVersion:"0.9.0",licenseTimeoutMs:5000,licenseCacheSeconds:300};
export async function billingSettings():Promise<BillingSettings>{const [setting,policy]=await Promise.all([controlDb.systemSetting.findUnique({where:{key:"billing"}}),controlDb.systemSetting.findUnique({where:{key:"billing_license_policy"}})]);return{...defaults,...((setting?.value||{}) as Partial<BillingSettings>),...(licensePolicy(policy?.value)||{})}}
export async function billingBaseUrl(){const value=(await billingSettings()).headlessBaseUrl;if(!validBillingHeadlessUrl(value))throw new BillingError("Configure a API headless /api/v1/saas. Rotas legadas /api/external não são permitidas.",422);return value.replace(/\/$/,"")}
function enc(value:string){return encodeURIComponent(value);}function first(value:string|string[]|undefined){return Array.isArray(value)?value[0]||"":value||"";}export const billingClient=new BillingClient();
