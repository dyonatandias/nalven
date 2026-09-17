import { controlDb } from "../db/control";
import { tenantDb } from "../db/tenant";
import { preparePosT2CatalogBoundary, createPosT2BoundaryIdempotencyKey } from "../lib/erp/pos-t2-boundary";
async function main(){
 if(process.env.NALVEN_CONFIGURE_FASHION_DEMO!=="1")throw Error("Explicit demo conversion required");
 const org=await controlDb.organization.findUniqueOrThrow({where:{id:"org-demo"}});if(org.planId!=="fashion-demo")throw Error("Fashion plan required");
 const actor=await controlDb.user.findUniqueOrThrow({where:{email:"demo@nalven.com.br"}}),db=await tenantDb(org.id);
 await db.$transaction(async tx=>{
  const before=await tx.product.findMany({select:{id:true,price:true,cost:true}});
  await tx.$executeRaw`UPDATE products SET price = CASE WHEN name LIKE 'Meia%' THEN 24.90 WHEN name LIKE 'Calcinha%' OR name LIKE 'Cueca%' THEN 29.90 WHEN name LIKE 'Sutiã%' THEN 69.90 WHEN name LIKE 'Cinto%' OR name LIKE 'Boné%' OR name LIKE 'Lenço%' THEN 49.90 WHEN name LIKE 'Bolsa%' THEN 159.90 WHEN name LIKE 'Carteira%' THEN 59.90 WHEN name LIKE 'Vestido%' THEN 179.90 WHEN name LIKE 'Jaqueta%' OR name LIKE 'Blazer%' THEN 249.90 WHEN name LIKE 'Calça%' THEN 149.90 WHEN name LIKE 'Bermuda%' OR name LIKE 'Short%' OR name LIKE 'Saia%' THEN 99.90 WHEN name LIKE 'Camisa %' THEN 119.90 WHEN name LIKE 'Camiseta%' OR name LIKE 'Regata%' THEN 59.90 ELSE 89.90 END`;
  await tx.$executeRaw`UPDATE products SET regular_price=price,sale_price=NULL,cash_price=price,installment_price=price,minimum_sale_price=round((price*0.8)::numeric,2),cost=round((price*0.45)::numeric,2),cogs_value=round((price*0.45)::numeric,2),stock_status=CASE WHEN stock>0 THEN 'instock' ELSE 'outofstock' END`;
  await tx.$executeRaw`UPDATE product_variations v SET regular_price=p.price,sale_price=NULL FROM products p WHERE v.product_id=p.id`;
  await tx.$executeRaw`UPDATE branch_products SET price_override=NULL,cost_override=NULL`;
  await tx.serviceContract.updateMany({where:{status:"active"},data:{status:"paused"}});
  await tx.automationRule.updateMany({where:{name:{contains:"E2E"}},data:{name:"Aviso de reposição de coleção"}});
  for(const p of await tx.product.findMany({where:{manageStock:false},include:{variations:true}})){
   const boundary=await preparePosT2CatalogBoundary(tx,{action:"put_graph",productId:p.id,expectedProductRevision:p.posRevision,expectedProductConfigHash:p.posConfigHash,productProjection:{active:p.active,gtinSnapshot:p.gtin,manageStock:true,nameLabel:p.name,productType:p.type,skuSnapshot:p.sku,status:p.status,unit:p.unit},variations:p.variations.map((v,j)=>({enabled:v.enabled,expectedConfigHash:v.posConfigHash,expectedRevision:v.posRevision,gtinSnapshot:v.gtin,manageStock:v.manageStock,ordinal:j,skuSnapshot:v.sku,status:v.status,variationId:v.id})),actorUserId:actor.id,idempotencyKey:createPosT2BoundaryIdempotencyKey()});
   await tx.product.update({where:{id:p.id},data:{manageStock:true,posRevision:boundary.productRevision,posConfigHash:boundary.productConfigHash}});
  }
  await tx.tenantAuditEvent.create({data:{actorId:actor.id,action:"demo.retail_prices_configured",entityType:"organization",entityId:org.id,beforeData:before,afterData:{pricing:"Clothing retail demonstration",historicSalesAmounts:"preserved",serviceContracts:"paused"}}});
 },{timeout:30000,isolationLevel:"Serializable"});
 console.log("Retail prices configured; service contracts paused; inventory tracking enabled.");await db.$disconnect();await controlDb.$disconnect();
}
main().catch(e=>{console.error(e.message);process.exit(1)});
