import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";

test("rotas públicas mantêm prova de acesso, isolamento, limites e projeção de dados", async t => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={active:true,domain:false,tenantReads:0,locks:[],creates:[],rateCounts:new Map(),rateBlocked:false,order:null,review:null,reviewCreated:null,openReturnOnLock:false,mediaPublished:true,asset:null,fileReads:0,statSize:5};`,
    "@/db/control": `import {state} from "test:state";
      const limits={
        findUnique:async ({where})=>state.rateBlocked?{count:10000,expiresAt:new Date(Date.now()+60000)}:state.rateCounts.get(where.id)||null,
        upsert:async ({where,create})=>state.rateCounts.set(where.id,create),
        update:async ({where})=>{state.rateCounts.get(where.id).count++;}
      };
      export const controlDb={
        apiRateLimit:limits,$executeRaw:async()=>1,$transaction:async fn=>fn(controlDb),
        organizationDomain:{findFirst:async args=>{if(!args.where.organization.status.in.includes('active'))throw Error('Missing domain status guard');return state.domain&&state.active?{organizationId:'org-a'}:null;}},
        organization:{findFirst:async args=>state.active&&args.where.slug==='demo'?{id:'org-a'}:null},
        mediaAsset:{findUnique:async()=>state.asset},seoEntry:{findMany:async()=>[]},
        blogPost:{count:async()=>state.mediaPublished?1:0},glossaryTerm:{count:async()=>0},
        plan:{findMany:async args=>{if(!args.select)throw Error('Explicit public plan projection required');if(args.where.code?.not!==null||args.where.active!==true)throw Error('Plans without a Billing code must not be public');return [{id:'basic',name:'Basic',monthlyPrice:10,annualPrice:100,seats:1,modules:[],active:true}];}},
        siteContent:{findMany:async args=>{if(!args.where.public||!args.select)throw Error('Public content selection required');return[{key:'title',value:'Página pública'}];}},
        announcement:{findMany:async args=>{if(args.where.audience!=='all'||!args.select)throw Error('Public announcement scope required');return[];}}
      };`,
    "@/db": `import {state} from "test:state";export {controlDb} from "@/db/control";
      function project(value,args){
        if(value===null||value===undefined)return value;
        if(Array.isArray(value)){let rows=value;if(args?.where?.customerVisible)rows=rows.filter(row=>row.customerVisible);return rows.map(row=>project(row,args));}
        if(!args?.select&&!args?.include)return value;
        const out=args.select?{}:{...value};
        for(const [key,rule] of Object.entries(args.select||args.include)){if(rule)out[key]=rule===true?value[key]:project(value[key],rule);}return out;
      }
      const db={
        salesOrder:{findFirst:async args=>{const order=state.order;return !order||args.where.number&&args.where.number!==order.number||order.deletedAt?null:project(order,args);}},
        orderReturn:{create:async ({data})=>{const row={id:100,status:'pending',...data,items:data.items.create};state.creates.push(row);state.order.returns.push(row);return row;}},
        orderNotificationQueue:{create:async()=>({id:1})},
        orderReviewRequest:{findUnique:async args=>state.review&&state.review.token===args.where.token?project(state.review,args):null,update:async()=>{state.review.state='completed';return state.review;}},
        productReview:{create:async ({data})=>{state.reviewCreated=data;const review={id:200,...data,createdAt:new Date()};state.review.review=review;return review;},aggregate:async()=>({_avg:{rating:5},_count:{_all:1}})},
        product:{update:async()=>({id:1})},
        $queryRaw:async (sql,...values)=>{state.locks.push(sql.join('?'));if(state.openReturnOnLock&&sql.join('').includes('sales_orders'))state.order.returns=[{id:999,status:'pending',items:[]}];return[{id:values[0]}];},
        $transaction:async fn=>fn(db)
      };
      export const tenantDb=async id=>{state.tenantReads++;if(id!=='org-a')throw Error('Unexpected organization');return db;};`,
    "node:fs/promises": `import {state} from "test:state";
      export const realpath=async value=>value;
      export const stat=async()=>({isFile:()=>true,size:state.statSize});
      export const readFile=async()=>{state.fileReads++;return Buffer.from('image');};`,
  };
  const bundled = await build({
    stdin: { contents: `export {POST as track} from "./app/api/public/pedidos/rastreio/route";
      export {GET as reviewGet,POST as reviewPost} from "./app/api/public/avaliacoes/[token]/route";
      export {GET as media} from "./app/api/public/media/[id]/route";
      export {GET as plans} from "./app/api/public/plans/route";
      export {GET as site} from "./app/api/public/site/route";
      export {safePublicUrl} from "./app/api/public/_shared";export {state} from "test:state";`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "public-route-fixtures", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js" }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
  type FixtureOrder = ReturnType<typeof orderFixture>;
  type FixtureReview = ReturnType<typeof reviewFixture>;
  const { state, track, reviewGet, reviewPost, media, plans, site, safePublicUrl } = routeModule.exports as {
    state: { active: boolean; domain: boolean; tenantReads: number; locks: string[]; creates: unknown[]; rateCounts: Map<string, unknown>; rateBlocked: boolean; order: FixtureOrder | null; review: FixtureReview | null; reviewCreated: { authorName: string } | null; openReturnOnLock: boolean; mediaPublished: boolean; asset: { id: string; mimeType: string; path: string; sizeBytes: number } | null; fileReads: number; statSize: number };
    track: Handler; reviewGet: Handler; reviewPost: Handler; media: Handler; plans: () => Promise<Response>; site: () => Promise<Response>; safePublicUrl: (value: string) => string | null;
  };
  function reset() { Object.assign(state, { active: true, domain: false, tenantReads: 0, locks: [], creates: [], rateCounts: new Map(), rateBlocked: false, order: orderFixture(), review: reviewFixture(), reviewCreated: null, openReturnOnLock: false, mediaPublished: true, asset: { id: "public-image-123", mimeType: "image/png", path: "/var/lib/nalven/uploads/public.png", sizeBytes: 5 }, fileReads: 0, statSize: 5 }); }
  const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => new Request(`https://nalven.com.br${path}?loja=demo`, { method: "POST", headers: { "content-type": "application/json", origin: "https://nalven.com.br", ...headers }, body: JSON.stringify(body) });
  const query = (extra: Record<string, unknown> = {}) => post("/api/public/pedidos/rastreio", { orderNumber: "PED-1", email: "cliente@example.invalid", ...extra });
  const token = "valid-review-token-123456";
  const context = { params: Promise.resolve({ token }) };
  const reviewRequest = () => new Request("https://nalven.com.br/api/public/avaliacoes/token?loja=demo");
  const returnBody = { action: "return", reason: "outro", description: "Solicitação de teste isolado", items: [{ orderItemId: 1, quantity: 1 }] };

  await t.test("não enumera pedido sem prova correta e não entrega dados de outra loja", async () => {
    reset(); const invalid = await track(query({ email: "incorreto@example.invalid" }));
    state.order = null; const absent = await track(query());
    assert.equal(invalid.status,404); assert.equal(absent.status,404); assert.deepEqual(await invalid.json(),await absent.json());
    reset(); state.domain=true; state.active=false;
    assert.equal((await track(query())).status,404); assert.equal(state.tenantReads,0);
  });
  await t.test("resposta autorizada é privada, sem chaves/IDs internos e sem URLs executáveis", async () => {
    reset(); const response = await track(query()); const body = await response.json();
    assert.equal(response.status,200); assert.match(response.headers.get("cache-control")||"",/private.*no-store/);
    assert.equal(body.order.orderKey,undefined); assert.equal(body.order.customerEmail,undefined);
    assert.equal(body.order.tracking.salesOrderId,undefined); assert.equal(body.order.tracking.events[0].trackingId,undefined);
    assert.equal(body.order.tracking.trackingUrl,null); assert.equal(body.order.items[0].imageSnapshot,null);
    assert.equal(body.order.notes.length,1); assert.equal(body.order.notes[0].author,undefined);
    for (const url of ["javascript:alert(1)","data:text/html,unsafe","//external.invalid/x","/\\external.invalid/x","https://user:password@example.invalid"]) assert.equal(safePublicUrl(url),null,url);
  });
  await t.test("leitura rejeita JSON excessivo, origem externa e operação inválida antes do tenant", async () => {
    reset(); assert.equal((await track(query({ extra:"x".repeat(32769) }))).status,413); assert.equal(state.tenantReads,0);
    assert.equal((await track(post("/api/public/pedidos/rastreio",{}, {origin:"https://external.invalid"}))).status,403);
    assert.equal((await track(query({action:"delete"}))).status,400);
  });
  await t.test("devolução recusa item repetido/nulo e revalida solicitação concorrente após lock", async () => {
    reset(); assert.equal((await track(query({...returnBody,items:[{orderItemId:1,quantity:1},{orderItemId:1,quantity:1}]}))).status,422); assert.equal(state.creates.length,0);
    assert.equal((await track(query({...returnBody,items:[null]}))).status,422);
    state.openReturnOnLock=true; assert.equal((await track(query(returnBody))).status,409); assert.equal(state.creates.length,0);
    assert.ok(state.locks.some(sql=>/sales_orders.*FOR UPDATE/.test(sql)));
    reset(); assert.equal((await track(query(returnBody))).status,201); assert.equal(state.creates.length,1);
    assert.equal((await track(query(returnBody))).status,409); assert.equal(state.creates.length,1);
  });
  await t.test("payloads não convertem booleanos, listas ou objetos em campos comerciais válidos", async () => {
    for (const items of [[{orderItemId:true,quantity:1}],[{orderItemId:1,quantity:true}]]) {
      reset(); assert.equal((await track(query({...returnBody,items}))).status,422); assert.equal(state.creates.length,0);
    }
    for (const description of [{text:"conteúdo inesperado"},["conteúdo inesperado"]]) {
      reset(); assert.equal((await track(query({...returnBody,description}))).status,400); assert.equal(state.creates.length,0);
    }
    for (const invalid of [{rating:true},{rating:[5]},{title:["título"]},{content:{text:"comentário inválido"}}]) {
      reset(); const response=await reviewPost(post(`/api/public/avaliacoes/${token}`,{rating:5,title:"Teste",content:"Comentário de teste válido",...invalid}),context);
      assert.equal(response.status,422); assert.equal(state.reviewCreated,null);
    }
  });
  await t.test("convites variáveis compartilham limite IP e convites removidos/revogados não revelam compra", async () => {
    reset(); state.rateBlocked=true;
    const limited=await reviewGet(reviewRequest(),{params:Promise.resolve({token:"malformed"})});
    assert.equal(limited.status,429); assert.ok(limited.headers.get("retry-after")); assert.equal(state.tenantReads,0);
    reset(); state.review!.salesOrder.deletedAt=new Date(); assert.equal((await reviewGet(reviewRequest(),context)).status,404);
    reset(); state.review!.state="revoked"; assert.equal((await reviewGet(reviewRequest(),context)).status,404);
  });
  await t.test("avaliação publica somente primeiro nome e recusa segunda avaliação com conflito controlado", async () => {
    reset(); const response=await reviewGet(reviewRequest(),context); assert.equal((await response.json()).request.customerName,"Cliente");
    const send=()=>reviewPost(post(`/api/public/avaliacoes/${token}`,{rating:5,title:"Teste",content:"Produto com avaliação de teste"}),context);
    assert.equal((await send()).status,201); assert.equal(state.reviewCreated?.authorName,"Cliente");
    assert.equal((await send()).status,409);
    assert.ok(state.locks.some(sql=>/order_review_requests.*FOR UPDATE/.test(sql)));
    assert.ok(state.locks.some(sql=>/products.*FOR UPDATE/.test(sql)));
  });
  await t.test("mídia revalida publicação antes de304 e recusa arquivo grande, caminho externo e MIME ativo", async () => {
    reset(); const args={params:Promise.resolve({id:"public-image-123"})};
    const response=await media(new Request("https://nalven.com.br/api/public/media/public-image-123"),args);
    assert.equal(response.status,200); assert.equal(response.headers.get("x-content-type-options"),"nosniff");
    const cachedRequest=new Request("https://nalven.com.br/api/public/media/public-image-123",{headers:{"if-none-match":response.headers.get("etag")!}});
    assert.equal((await media(cachedRequest,args)).status,304);
    state.mediaPublished=false; assert.equal((await media(cachedRequest,args)).status,404);
    reset(); state.asset!.sizeBytes=8*1024*1024+1; assert.equal((await media(cachedRequest,args)).status,404); assert.equal(state.fileReads,0);
    reset(); state.asset!.path="/etc/private"; assert.equal((await media(cachedRequest,args)).status,404); assert.equal(state.fileReads,0);
    reset(); state.asset!.mimeType="image/svg+xml"; assert.equal((await media(cachedRequest,args)).status,404);
  });
  await t.test("planos e conteúdo público têm projeções deliberadas e cache revalidável", async () => {
    reset(); for(const handler of [plans,site]) {const response=await handler(); assert.equal(response.status,200); assert.match(response.headers.get("cache-control")||"",/must-revalidate/); assert.equal(response.headers.get("x-content-type-options"),"nosniff");}
  });
});

function orderFixture() {
  return { id:1,number:"PED-1",orderKey:"private-key-123",status:"completed",deletedAt:null as Date|null,customerId:1,customerName:"Cliente Nome Privado",customerEmail:"cliente@example.invalid",createdAt:new Date(),completedAt:new Date(),subtotal:20,discount:0,freightAmount:0,total:20,refundedTotal:0,paymentTitle:"Cartão",paymentMethod:"card",deliveryCity:"São Paulo",deliveryState:"SP",
    items:[{id:1,nameSnapshot:"Produto",skuSnapshot:"SKU",imageSnapshot:"javascript:alert(1)",quantity:2,unitPrice:10,total:20}],
    tracking:{id:55,salesOrderId:1,trackingNumber:"BR123",carrier:"Transportadora",trackingUrl:"javascript:alert(1)",status:"delivered",statusLabel:"Entregue",events:[{id:66,trackingId:55,description:"Entregue",location:"São Paulo",occurredAt:new Date()}]},
    notesTimeline:[{id:1,content:"Nota pública",author:"Nome funcionário",createdAt:new Date(),customerVisible:true},{id:2,content:"Nota interna",author:"Nome funcionário",createdAt:new Date(),customerVisible:false}],
    history:[{id:1,fromStatus:"processing",toStatus:"completed",createdAt:new Date()}],returns:[] as Array<{id:number;status:string;items:Array<{orderItemId:number;quantity:number}>}> };
}
function reviewFixture() {return {id:1,token:"valid-review-token-123456",state:"pending",expiresAt:new Date(Date.now()+86400000),salesOrderId:1,orderItemId:1,salesOrder:orderFixture(),orderItem:{productId:1,product:{id:1,name:"Produto",slug:"produto"}},review:null as null|Record<string,unknown>};}

test("páginas com capacidade são não indexáveis e clientes não reutilizam PII de consultas antigas", () => {
  for(const file of ["app/rastrear-pedido/page.tsx","app/avaliar/[token]/page.tsx"]) assert.match(readFileSync(file,"utf8"),/referrer: "no-referrer"/);
  for(const file of ["app/rastrear-pedido/page.tsx","app/avaliar/[token]/page.tsx"]) assert.match(readFileSync(file,"utf8"),/Client key=/);
  const tracking=readFileSync("app/rastrear-pedido/tracking-client.tsx","utf8");
  assert.match(tracking,/setOrder\(null\)/); assert.match(tracking,/searchParams\.delete\("chave"\)/); assert.match(tracking,/controller\.signal\.aborted/);
  assert.match(readFileSync("app/avaliar/[token]/review-client.tsx","utf8"),/aria-pressed=\{value === rating\}/);
});
