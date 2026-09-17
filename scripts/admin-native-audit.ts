/** Run only against the disposable database and loopback candidate server. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/control/client";
import { PrismaClient as TenantClient } from "../generated/tenant/client";
import { chromium, expect } from "@playwright/test";
import { hashPassword } from "../lib/password";

const connection="postgresql://nalven@127.0.0.1:55439/postgres";
assert.equal(process.env.CONTROL_DATABASE_URL,connection,"This script must never use a production database");
const db=new PrismaClient({adapter:new PrismaPg({connectionString:connection})});
const browser=await chromium.launch();
const base="http://127.0.0.1:4185";
const context=await browser.newContext({baseURL:base});
const errors:string[]=[],failed:string[]=[];
let trackPageFailures=true;
try {
  const storage=await db.$queryRaw<Array<{ directory: string }>>`SELECT current_setting('data_directory') AS directory`;
  assert.match(storage[0]?.directory || "", /^\/tmp\/nalven-[A-Za-z0-9.-]+\/data$/, "Disposable cluster required before any write");
  const tenants=await db.tenantDatabase.findMany({select:{databaseName:true,configKey:true,status:true}});
  assert.ok(tenants.length>0,"Native organization audit requires an isolated tenant database");
  for(const tenant of tenants){
    assert.match(tenant.databaseName,/^nalven_native_[a-z0-9_]+$/,"Never resolve a production tenant database from a test seed");
    assert.match(tenant.configKey,/^native-[a-z0-9-]+$/,"Dedicated test credential file required");
    assert.equal(tenant.status,"active","Tenant must be provisioned before the native audit");
  }
  const password=randomBytes(32).toString("hex");
  const admin=await db.user.update({where:{email:"audit@example.invalid"},data:{passwordHash:await hashPassword(password)}});
  const login=await context.request.post("/api/auth/login",{headers:{origin:base},data:{email:admin.email,password}});
  assert.equal(login.status(),200,"Real login");
  const cookies=await context.cookies();
  const sessions=await db.session.findMany({where:{userId:admin.id},select:{tokenHash:true}});
  assert.ok(cookies.some(cookie=>sessions.some(session=>session.tokenHash===createHash("sha256").update(cookie.value).digest("hex"))),"Candidate server must authenticate against this disposable database");
  const page=await context.newPage();
  page.on("pageerror",error=>errors.push(error.message));
  page.on("response",response=>{if(trackPageFailures&&response.url().includes("/api/")&&response.status()>=400)failed.push(new URL(response.url()).pathname+":"+response.status());});
  await page.route("**/*",route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto("/admin/organizacoes");
  await expect(page.getByRole("cell",{name:"Auto Mais Peças",exact:true})).toBeVisible();
  const links=await page.locator(".control-nav a").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("href")!));
  assert.equal(links.length,25);
  for(const href of links){
    const response=await page.goto(href);
    assert.equal(response?.status(),200,href);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1")).toHaveCount(1);
    assert.ok(!await page.getByText("Não foi possível abrir esta área").count(),href);
    console.log("PASS",href);
  }
  await page.goto("/admin/organizacoes");
  await page.getByRole("link",{name:"Visualizar organização Auto Mais Peças"}).click();
  await expect(page.getByRole("heading",{name:"Auto Mais Peças",exact:true})).toBeVisible();
  // Persist a harmless synthetic contact edit through the real route and verify it.
  const organization=await db.organization.findUniqueOrThrow({where:{id:"org-demo"},select:{updatedAt:true}});
  const saved=await page.evaluate(async updatedAt=>{const response=await fetch("/api/admin/organizations/org-demo",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Auto Mais Peças",email:"audit-contact@example.invalid",updatedAt,ownerName:"Responsável de homologação"})});return response.status;},organization.updatedAt.toISOString());
  assert.equal(saved,200,"Synthetic organization edit");
  assert.equal((await db.organization.findUniqueOrThrow({where:{id:"org-demo"}})).ownerName,"Responsável de homologação");
  // Exercise actual plan routes, database propagation and role boundaries.
  trackPageFailures=false; // Explicit assertions below include expected 400/403/409 responses.
  const post=async(path:string,data:unknown)=>{const status=await page.evaluate(async({path,data})=>(await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)})).status,{path,data});return{status:()=>status};};
  const tenantCheck=new TenantClient({adapter:new PrismaPg({connectionString:"postgresql://nalven@127.0.0.1:5432/nalven_native_demo"})});
  try {
    const mutation={action:"member.update",membershipId:"native-member-link",roleKey:"native-stock",status:"active"};
    assert.equal((await post("/api/admin/organizations/org-demo/users",mutation)).status(),200,"Activate member through real organization route");
    assert.equal((await db.membership.findUniqueOrThrow({where:{id:mutation.membershipId}})).status,"active");
    assert.equal((await tenantCheck.tenantUserProfile.findUniqueOrThrow({where:{userId:"native-member-user"}})).status,"active");
    await db.session.create({data:{userId:"native-member-user",tokenHash:"native-synthetic-session",expiresAt:new Date(Date.now()+3600000)}});
    const auditCount=await db.auditLog.count({where:{action:"organization.membership_updated"}});
    await tenantCheck.$executeRawUnsafe("CREATE FUNCTION native_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$");
    await tenantCheck.$executeRawUnsafe("CREATE TRIGGER native_test_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION native_test_reject_audit()");
    try {
      assert.equal((await post("/api/admin/organizations/org-demo/users",{...mutation,status:"disabled"})).status(),500,"Tenant failure is controlled");
      assert.equal((await db.membership.findUniqueOrThrow({where:{id:mutation.membershipId}})).status,"active","Control change rolled back");
      assert.equal((await tenantCheck.tenantUserProfile.findUniqueOrThrow({where:{userId:"native-member-user"}})).status,"active","Tenant change rolled back");
      assert.equal(await db.session.count({where:{userId:"native-member-user"}}),1,"Session revocation rolled back");
      assert.equal(await db.auditLog.count({where:{action:"organization.membership_updated"}}),auditCount,"No successful audit for failed change");
    } finally {
      await tenantCheck.$executeRawUnsafe("DROP TRIGGER native_test_reject_audit ON audit_events");
      await tenantCheck.$executeRawUnsafe("DROP FUNCTION native_test_reject_audit()");
    }
    assert.equal((await post("/api/admin/organizations/org-demo/users",{action:"member.bulk_update",membershipIds:[mutation.membershipId],status:"disabled"})).status(),200,"Bulk disable after recovery");
    assert.equal((await db.membership.findUniqueOrThrow({where:{id:mutation.membershipId}})).status,"disabled");
    assert.equal((await tenantCheck.tenantUserProfile.findUniqueOrThrow({where:{userId:"native-member-user"}})).status,"disabled");
    assert.equal(await db.session.count({where:{userId:"native-member-user"}}),0);
    console.log("PASS real member activation, tenant-failure rollback, session preservation and bulk disable");
  } finally { await tenantCheck.$disconnect(); }
  const privatePlan={id:"native-exclusive",name:"Plano exclusivo de homologação",monthlyPrice:10,annualPrice:100,seats:1,active:true,visibility:"private",ownerOrganizationId:"org-demo",modules:["@policy:v1","products.read","menu:products"]};
  assert.equal((await post("/api/admin/plans",privatePlan)).status(),200,"Create exclusive plan");
  assert.equal((await post("/api/admin/plans",{...privatePlan,id:"native-fourth",visibility:"public",ownerOrganizationId:null})).status(),400,"Reject fourth public plan");
  const publicResponse=await page.evaluate(async()=>{const response=await fetch("/api/public/plans");return{status:response.status,data:await response.json()};});
  assert.equal(publicResponse.status,200);
  const publicPlans=publicResponse.data.plans as Array<{id:string}>;
  assert.equal(publicPlans.length,3);assert.ok(publicPlans.every(plan=>plan.id!==privatePlan.id),"Private plan never public");
  const version=(await db.organization.findUniqueOrThrow({where:{id:"org-demo"},select:{updatedAt:true}})).updatedAt.toISOString();
  assert.equal((await post("/api/admin/organizations/org-demo/plan",{planId:privatePlan.id,updatedAt:version,confirm:true})).status(),200,"Assign exclusive plan");
  assert.deepEqual((await db.organization.findUniqueOrThrow({where:{id:"org-demo"},select:{modules:true}})).modules,privatePlan.modules);
  const other=await db.organization.create({data:{id:"native-other",slug:"native-other",name:"Outro cliente sintético",document:"native-other",ownerName:"Teste",email:"other@example.invalid",planId:"native-scale",status:"active",modules:["*"]}});
  assert.equal((await post("/api/admin/organizations/native-other/plan",{planId:privatePlan.id,updatedAt:other.updatedAt.toISOString(),confirm:true})).status(),409,"Reject another customer's private plan");
  const owner=await db.user.create({data:{id:"native-owner",name:"Proprietário sintético",email:"owner@example.invalid",passwordHash:await hashPassword(password),role:"user"}});
  await db.membership.create({data:{userId:owner.id,organizationId:"org-demo",role:"owner",status:"active"}});
  const ownerContext=await browser.newContext({baseURL:base});
  try {
    assert.equal((await ownerContext.request.post("/api/auth/login",{headers:{origin:base},data:{email:owner.email,password}})).status(),200);
    const ownerPage=await ownerContext.newPage();
    ownerPage.on("pageerror",error=>errors.push(error.message));
    await ownerPage.goto("/");
    const getStatus=(path:string)=>ownerPage.evaluate(async path=>(await fetch(path)).status,path);
    assert.equal(await getStatus("/api/auth/me"),200,"Owner session is actually authenticated");
    assert.equal(await getStatus("/api/admin/users"),403,"Owner cannot administer the platform");
    assert.equal(await getStatus("/api/admin/organizations/org-demo/users"),403,"Owner cannot use superadmin organization API");
    assert.equal(await getStatus("/api/erp?scope=finance"),403,"Owner cannot bypass plan restrictions");
  } finally { await ownerContext.close(); }
  trackPageFailures=true;
  console.log("PASS real exclusive-plan creation/assignment, three public plans, cross-client rejection and owner authorization");
  await page.goto("/admin/organizacoes");
  await expect(page.getByRole("cell",{name:"Responsável de homologação",exact:true})).toBeVisible();
  await mkdir("outputs/admin-native",{recursive:true});
  await page.screenshot({path:"outputs/admin-native/organizations-desktop.png",fullPage:true});
  await page.setViewportSize({width:320,height:740});
  await expect.poll(()=>page.locator(".control-sidebar").evaluate(node=>node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.reload();
  await expect(page.getByRole("cell",{name:"Responsável de homologação",exact:true})).toBeVisible();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:"outputs/admin-native/organizations-mobile.png",fullPage:true});
  assert.deepEqual(errors,[],"No unhandled JavaScript exceptions");
  assert.deepEqual(failed,[],"No failed API responses");
  console.log("PASS real login, 25 destinations, organization persistence, desktop/mobile; zero JS exceptions or unexpected page API failures");
} finally {
  await browser.close();
  await db.$disconnect();
}
