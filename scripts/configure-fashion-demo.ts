/** Explicit, guarded conversion of the sole demo tenant. Back up both databases before running. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { controlDb } from "../db/control";
import { tenantDb } from "../db/tenant";
import { ERP_MODULES } from "../lib/erp/modules";
import { preparePosT2CatalogBoundary, createPosT2BoundaryIdempotencyKey } from "../lib/erp/pos-t2-boundary";
import { Prisma } from "../generated/tenant/client";

const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g, "");
const categories = ["Camisetas", "Camisas", "Calças", "Acessórios", "Bolsas", "Jeans", "Vestidos", "Blusas", "Moda fitness", "Jaquetas", "Tricô", "Moda íntima", "Meias", "Cintos", "Coleção primavera", "Outlet", "Bermudas"];
const names = ["Camiseta básica algodão", "Camisa social Oxford", "Calça jeans slim", "Cinto casual ajustável", "Camiseta oversized urbana", "Vestido midi floral", "Blusa canelada feminina", "Calça pantalona linho", "Jaqueta jeans clássica", "Bermuda sarja masculina", "Saia midi plissada", "Camisa linho manga curta", "Top fitness sustentação", "Legging cintura alta", "Moletom canguru unissex", "Cardigan tricot leve", "Vestido longo estampado", "Camiseta gola V", "Calça alfaiataria feminina", "Short jeans feminino", "Polo piquet masculina", "Blazer casual feminino", "Regata básica feminina", "Camisa flanela xadrez", "Calça jogger moletom", "Jaqueta corta-vento", "Suéter tricot masculino", "Vestido chemise", "Saia jeans curta", "Blusa manga bufante", "Bermuda chino masculina", "Camiseta infantil estampada", "Conjunto infantil algodão", "Vestido infantil laço", "Calça legging infantil", "Short esportivo masculino", "Regata fitness masculina", "Top cropped canelado", "Calça wide leg jeans", "Camisa feminina acetinada", "Pijama feminino algodão", "Pijama masculino malha", "Meia cano médio trio", "Cueca boxer algodão", "Calcinha cintura alta", "Sutiã sem aro", "Bolsa transversal compacta", "Bolsa tote lona", "Cinto couro sintético", "Boné aba curva", "Lenço estampado", "Echarpe leve", "Carteira compacta", "Camiseta listrada", "Vestido malha casual", "Calça cargo unissex"];
const colors=["Preto","Off-white","Azul","Terracota","Verde","Rosa"];
const palette=["#303038","#e6dfd2","#657e9c","#b86e54","#667b65","#c88e9d"];
function categoryFor(name:string){if(/Cinto|Boné|Lenço|Echarpe|Carteira/.test(name))return "Acessórios";if(/Bolsa/.test(name))return "Bolsas";if(/Vestido/.test(name))return "Vestidos";if(/fitness|Legging|esportivo/.test(name))return "Moda fitness";if(/Pijama|Cueca|Calcinha|Sutiã/.test(name))return "Moda íntima";if(/Meia/.test(name))return "Meias";if(/Jaqueta|Blazer|corta-vento/.test(name))return "Jaquetas";if(/tricot|Suéter|Cardigan/.test(name))return "Tricô";if(/Calça|Short|Saia/.test(name))return "Calças";if(/Bermuda/.test(name))return "Bermudas";if(/Camisa /.test(name))return "Camisas";if(/Camiseta|Polo|Regata/.test(name))return "Camisetas";return "Blusas";}
function garment(name:string,color:string){
 const pants=/Calça|Legging|Bermuda|Short|Cueca/.test(name),dress=/Vestido|Saia/.test(name),bag=/Bolsa|Carteira/.test(name),accessory=/Cinto|Lenço|Echarpe|Meia|Boné/.test(name);
 const shape= pants?'<path d="M210 145h220l-20 350h-82l-10-225-12 225h-82z"/><path d="M210 170h220M318 145v125" fill="none" stroke="#fff" stroke-opacity=".35"/>':dress?'<path d="M270 130h100l30 100-30 50 100 215H170l100-215-30-50z"/><path d="M270 280h100M280 135q40 65 80 0" fill="none" stroke="#fff" stroke-opacity=".35"/>':bag?'<rect x="200" y="230" width="240" height="230" rx="22"/><path d="M255 240v-60a65 65 0 0 1 130 0v60" fill="none" stroke="currentColor" stroke-width="20"/><path d="M215 310h210" stroke="#fff" stroke-opacity=".35"/>':accessory?'<path d="M175 240q145-80 290 0v110q-145-80-290 0z"/><rect x="295" y="230" width="65" height="75" rx="7" fill="none" stroke="#d7b77c" stroke-width="9"/>':'<path d="M250 145l-100 55 45 100 45-22v217h160V278l45 22 45-100-100-55q-70 55-140 0z"/><path d="M250 145q70 65 140 0M245 465h150" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="4"/>';
 return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><rect width="640" height="640" fill="#f4f0e9"/><ellipse cx="320" cy="520" rx="160" ry="16" fill="#ded8cf"/><g fill="${color}" color="${color}" stroke="${color}" stroke-linejoin="round">${shape}</g><text x="320" y="585" text-anchor="middle" font-family="sans-serif" font-size="16" letter-spacing="5" fill="#74685c">VITRINE MODA</text></svg>`;
}
async function main(){
 if(process.env.NALVEN_CONFIGURE_FASHION_DEMO!=="1")throw Error("Conversão não autorizada por variável explícita.");
 await readFile("/root/nalven-fashion-demo/tenant-before.dump"); await readFile("/root/nalven-fashion-demo/control-before.dump");
 const org=await controlDb.organization.findUniqueOrThrow({where:{id:"org-demo"}});
 const user=await controlDb.user.findUniqueOrThrow({where:{email:"demo@nalven.com.br"}});
 if(await controlDb.organization.count()!==1 || org.slug!=="demo")throw Error("Escopo diferente da demo única.");
 const db=await tenantDb(org.id);
 const source=JSON.parse(await readFile("/root/nalven-fashion-demo/source.json","utf8")) as {products:Array<{id:number;name:string;sku:string}>;categories:Array<{id:number;name:string}>;suppliers:Array<{id:number;name:string}>;customers:Array<{id:number;name:string;type:string}>};
 if(source.products.length!==56)throw Error("Catálogo mudou; revisar o mapeamento antes de executar.");
 const replacements:Array<[string,string]>=[["Auto Mais Peças","Vitrine Moda — Demo"],["Auto Mais","Vitrine Moda"],["Expresso Parts","Vitrine Essentials"],["NALVEN Demo","Vitrine Collection"]];
 const categoryIds=new Map<string,number>();
 await db.$transaction(async tx=>{
 await tx.$executeRaw`UPDATE categories SET slug = 'fashion-migration-' || id, name = 'Fashion migration ' || id`;
 for(const [i,c] of source.categories.sort((a,b)=>a.id-b.id).entries()){
  const name=categories[i]; categoryIds.set(name,c.id); replacements.push([c.name,name]);
  await tx.category.update({where:{id:c.id},data:{name,slug:slug(name),code:`MODA-${c.id}`,type:"product",parentId:null,description:`${name} para compor looks e renovar o guarda-roupa. Coleção demonstrativa de varejo de moda.`,seoTitle:`${name} | Vitrine Moda`,seoDescription:`Conheça nossa seleção de ${name.toLowerCase()}, com controle de disponibilidade por loja.`,seoNoindex:true}});
 }
 await tx.tenantSettings.update({where:{id:1},data:{organizationName:"Vitrine Moda — Demo",tradeName:"Vitrine Moda",accentColor:"#83624a",quoteFooter:"Vitrine Moda · Proposta sujeita à disponibilidade de cor e tamanho.",receiptFooter:"Obrigada por escolher a Vitrine Moda! Guarde seu comprovante.",logoMediaId:null}});
 },{timeout:30000});
 const root="/var/lib/nalven/uploads/tenants/org-demo/media";await mkdir(root,{recursive:true});
 for(const [i,old] of source.products.entries()){
 const name=names[i],sku=`VM-${String(old.id).padStart(4,"0")}`,mediaId=`fashion-demo-product-${old.id}`,storageKey=`${createHash("sha256").update(`fashion-demo-product-${old.id}`).digest("hex")}.png`;
 const buffer=await sharp(Buffer.from(garment(name,palette[i%palette.length]))).png().toBuffer();await writeFile(`${root}/${storageKey}`,buffer,{mode:0o640});
 replacements.push([old.name,name],[old.sku,sku]);
 await db.$transaction(async tx=>{
 const p=await tx.product.findUniqueOrThrow({where:{id:old.id},include:{variations:{orderBy:{id:"asc"}},attributes:{include:{options:true}}}});
 const boundary=await preparePosT2CatalogBoundary(tx,{action:"put_graph",productId:p.id,expectedProductRevision:p.posRevision,expectedProductConfigHash:p.posConfigHash,productProjection:{active:p.active,gtinSnapshot:p.gtin,manageStock:p.manageStock,nameLabel:name,productType:"product",skuSnapshot:sku,status:p.status,unit:"UN"},variations:p.variations.map((v,j)=>({enabled:v.enabled,expectedConfigHash:v.posConfigHash,expectedRevision:v.posRevision,gtinSnapshot:v.gtin,manageStock:v.manageStock,ordinal:j,skuSnapshot:`${sku}-${String(j+1).padStart(2,"0")}`,status:v.status,variationId:v.id})),actorUserId:user.id,idempotencyKey:createPosT2BoundaryIdempotencyKey()});
 await tx.tenantMediaAsset.upsert({where:{id:mediaId},create:{id:mediaId,name,originalName:storageKey,storageKey,mimeType:"image/png",kind:"image",sizeBytes:buffer.length,checksum:createHash("sha256").update(buffer).digest("hex"),altText:`Ilustração de ${name.toLowerCase()}`,description:"Imagem ilustrativa do catálogo demonstrativo de moda.",tags:["moda","demo"],folder:"Catálogo de moda",source:"upload",uploadedById:user.id,uploadedByName:"Configuração da demonstração"},update:{name,storageKey,originalName:storageKey,altText:`Ilustração de ${name.toLowerCase()}`,sizeBytes:buffer.length,checksum:createHash("sha256").update(buffer).digest("hex")}});
 const cat=categoryFor(name),description=`${name}. Peça da coleção Vitrine Moda para combinações do dia a dia. Consulte as opções de cor, tamanho e disponibilidade por filial. Dados e imagem ilustrativos para apresentação do sistema.`;
 await tx.product.update({where:{id:p.id},data:{name,sku,type:"product",unit:"UN",fiscalType:"product",virtual:false,downloadable:false,slug:slug(name),category:cat,categoryId:categoryIds.get(cat),description,shortDescription:name,seoTitle:`${name} | Vitrine Moda`,seoDescription:description.slice(0,175),seoFocusKeyword:name,seoSchemaType:"Product",seoNoindex:true,seoCanonical:null,model:name,mpn:null,imageMediaId:mediaId,seoOgImageMediaId:mediaId,videoUrl:null,videoMediaId:null,videoThumbnailMediaId:null,externalUrl:null,ncm:null,cest:null,additionalInvoiceInfo:"Catálogo demonstrativo de vestuário; classificação fiscal pendente de validação.",posRevision:boundary.productRevision,posConfigHash:boundary.productConfigHash}});
 await tx.productImage.deleteMany({where:{productId:p.id}});await tx.productImage.create({data:{productId:p.id,mediaAssetId:mediaId,position:0,altText:name}});
 await tx.productCategoryLink.deleteMany({where:{productId:p.id}});await tx.productCategoryLink.create({data:{productId:p.id,categoryId:categoryIds.get(cat)!,primary:true}});
 await tx.productAttribute.deleteMany({where:{productId:p.id}});
 if(p.variations.length){
 const sizeOptions=p.variations.map((_,j)=>["P","M","G","GG","XG","XXG"][j%6]);
 await tx.productAttribute.create({data:{productId:p.id,name:"Tamanho",slug:"tamanho",variation:true,options:{create:[...new Set(sizeOptions)].map((size,j)=>({name:size,value:size,position:j}))}}});
 await tx.productAttribute.create({data:{productId:p.id,name:"Cor",slug:"cor",variation:true,options:{create:[{name:colors[i%6],value:colors[i%6],color:palette[i%6],position:0}]}}});
 for(const [j,v] of p.variations.entries()){
 const b=boundary.variations.find(x=>x.variationId===v.id)!;
 await tx.productVariation.update({where:{id:v.id},data:{sku:`${sku}-${String(j+1).padStart(2,"0")}`,attributes:[{name:"Tamanho",value:sizeOptions[j]},{name:"Cor",value:colors[i%6]}],description:`${name} · ${colors[i%6]} · ${sizeOptions[j]}`,imageMediaId:mediaId,videoUrl:null,posRevision:b.revision,posConfigHash:b.configHash}});
 await tx.productVariationImage.deleteMany({where:{variationId:v.id}});await tx.productVariationImage.create({data:{variationId:v.id,mediaAssetId:mediaId,position:0}});
 }
 }
 },{timeout:30000,isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
 }
 const supplierNames=["Trama Brasil Confecções","Serra Sul Moda","Rota Têxtil Atacado","Horizonte Vestuário","Malharia Catarinense","Expresso Logística","Gestão Digital Sistemas","Costura Planalto","Fios e Cores Têxtil","Energia Comercial Sul","Denim Premium Brasil","Importadora Coleções","Log Prime Operações","Certifica Consultoria","Malhas Nacional","Embalagens Vale Verde","Cloud Gestão","Aviamentos Horizonte","Recicla Têxtil Ambiental","Moda Estrada","Seguros Operacionais","Serra Azul Confecções","Dados & Gestão","Facilities Oeste","Transporte Expresso Norte","Coleção Urbana","Algodão Sul","Suprimentos Pioneira"];
 for(const [i,s] of source.suppliers.entries()){const name=supplierNames[i]+" Ltda.";replacements.push([s.name,name]);await db.supplier.update({where:{id:s.id},data:{name,tradeName:name.replace(" Ltda.",""),category:"goods",notes:"Fornecedor demonstrativo da operação de varejo de moda."}});}
 for(const c of source.customers){if(/Transport|Frota|Agropecu|Oficina|Distribuidora|Cooperativa|Auto|Serviços Técnicos|Logística|Construtora|Sintético|E2E/.test(c.name)){const name=c.name.includes("E2E")?"Beatriz Almeida":`Boutique ${["Primavera","Estilo","Aurora","Encanto","Essência","Luar"][c.id%6]} ${c.id}`;replacements.push([c.name,name]);await db.customer.update({where:{id:c.id},data:{name,tradeName:name,segment:c.name.includes("E2E")?"standard":"wholesale",notes:"Cliente demonstrativo de varejo de moda."}});}}
 const modules=ERP_MODULES.map(m=>m.id).filter(id=>!["service-orders","contracts","marketplaces"].includes(id));
 const oldPlan=await controlDb.plan.findUniqueOrThrow({where:{id:org.planId}});
 await controlDb.plan.upsert({where:{id:"fashion-demo"},create:{id:"fashion-demo",name:"Demo · Loja de roupas",monthlyPrice:oldPlan.monthlyPrice,annualPrice:oldPlan.annualPrice,seats:oldPlan.seats,modules,active:false},update:{modules,name:"Demo · Loja de roupas"}});
 await controlDb.organization.update({where:{id:org.id},data:{name:"Vitrine Moda — Demo",planId:"fashion-demo",modules}});
 await writeFile("/root/nalven-fashion-demo/replacements.json",JSON.stringify(replacements));
 console.log(JSON.stringify({organization:org.id,products:names.length,modules:modules.length,plan:"fashion-demo"}));
 await db.$disconnect();await controlDb.$disconnect();
}
main().catch(error=>{console.error(error.message);process.exit(1)});
