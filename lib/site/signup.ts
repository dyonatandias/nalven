import { controlDb } from "@/db/control";
import { HttpSecurityError } from "@/lib/http-security";
export async function signupConfiguration(){
 const [signup,saas]=await Promise.all([controlDb.systemSetting.findUnique({where:{key:"signup"}}),controlDb.systemSetting.findUnique({where:{key:"saas"}})]);
 const config=signup?.value as {paymentMethods?:string[];dueDay?:number}|null;
 const platform=saas?.value as {domain?:string;trialDays?:number}|null;
 if(!config||!Array.isArray(config.paymentMethods)||!config.paymentMethods.length||config.paymentMethods.some(method=>!['pix','boleto'].includes(method))||!Number.isInteger(config.dueDay)||config.dueDay!<1||config.dueDay!>28||!platform?.domain||!/^[a-z0-9.-]+$/.test(platform.domain)||!Number.isInteger(platform.trialDays)||platform.trialDays!<0||platform.trialDays!>90)throw new HttpSecurityError("Contratação indisponível: configuração comercial incompleta.",503);
 return {paymentMethods:config.paymentMethods,dueDay:config.dueDay!,trialDays:platform.trialDays!,origin:`https://${platform.domain}`};
}
