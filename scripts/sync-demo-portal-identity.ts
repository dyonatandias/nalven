import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { controlDb } from "../db/control";
import { billingClient } from "../lib/billing/client";
import { object } from "../lib/billing/portal-data";
async function main(){
 if(process.env.NALVEN_SYNC_DEMO_PORTAL!=="1")throw Error("Explicit demo identity synchronization required");
 const org=await controlDb.organization.findUniqueOrThrow({where:{id:"org-demo"}});
 if(org.planId!=="fashion-demo")throw Error("Unexpected demo scope");
 const before=await billingClient.customer(org.slug),installation=object(before.installation),metadata=object(installation.metadata);
 if(metadata.demo!==true || metadata.synthetic_document!==true)throw Error("Only synthetic demo customer identity can be updated by this script");
 await writeFile("/root/nalven-portal-20260906/customer-identity-before.json",JSON.stringify(before));
 await billingClient.updateCustomer(org.slug,{nome_fantasia:org.name,razao_social:"Vitrine Moda — Demonstração",tenant:{nome:org.name}},randomUUID());
 const after=await billingClient.customer(org.slug),customer=object(after.customer);
 console.log(JSON.stringify({tradeName:customer.nome_fantasia,legalName:customer.razao_social,installation:object(after.installation).nome}));
 if(customer.nome_fantasia!==org.name)throw Error("Remote identity was not synchronized");
 await controlDb.auditLog.create({data:{action:"portal.demo_identity_synchronized",entityType:"organization",entityId:org.id}});
 await controlDb.$disconnect();
}
main().catch(e=>{console.error(e.message);process.exit(1)});
