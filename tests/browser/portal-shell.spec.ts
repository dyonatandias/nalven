import { test, expect, type Page } from "@playwright/test";

const ticket = {token:"test-ticket-a",number:"SUP-001",title:"Ajuda para configurar o sistema",status:"aberto",category:"duvida",priority:"media",createdAt:"2026-09-08T10:00:00Z",updatedAt:"2026-09-08T11:00:00Z"};
async function mockPortal(page: Page) {
  const calls = { billing:0, support:0, writes:0 };
  await page.route("**/api/portal/billing", async route => {
    calls.billing++;
    await route.fulfill({json:{capabilities:{canWrite:true},organization:{name:"Empresa de homologação do portal",status:"active"},section_errors:{portal:"Serviço financeiro temporariamente indisponível."}}});
  });
  await page.route("**/api/portal/support**", async route => {
    calls.support++;
    if(route.request().method()!=="GET") {calls.writes++;await route.fulfill({status:500,json:{error:"Mutação deve ser simulada explicitamente."}});return;}
    const query = new URL(route.request().url()).searchParams;
    if(query.get("resource")==="detail") await route.fulfill({json:{ticket:{...ticket,description:"Preciso de ajuda com uma configuração.",messages:[{id:"1",authorName:"Pessoa de teste",authorType:"client",body:"Mensagem de homologação sem dados reais.",createdAt:ticket.createdAt,attachments:[]}]},capabilities:{canWrite:true,canReply:true,canAttach:true},generatedAt:ticket.updatedAt}});
    else await route.fulfill({json:{tickets:[ticket],pagination:{page:1,pageSize:20,total:1,pages:1,hasMore:false,partial:false},summary:{loaded:1,totalKnown:1,byStatus:{aberto:1}},facets:{statuses:["aberto"],categories:["duvida"],priorities:["media"]},capabilities:{canWrite:true},warning:null,generatedAt:ticket.updatedAt}});
  });
  return calls;
}

test("suporte não depende de finanças, mantém área ativa e preserva rascunho no voltar/avançar", async ({page}) => {
  const calls = await mockPortal(page);
  await page.goto("/__portal-shell?area=suporte");
  await expect(page.getByRole("heading",{name:"Suporte",exact:true,level:1})).toBeVisible();
  await expect(page.locator("aside nav a[aria-current=page]")).toContainText("Suporte");
  await expect(page.getByText(ticket.title,{exact:true})).toBeVisible();
  expect(calls.billing).toBe(0);
  await page.getByText(ticket.title,{exact:true}).click();
  await page.getByLabel("Sua mensagem",{exact:true}).fill("Rascunho que deve continuar aqui.");
  await page.locator("aside nav a[href='/portal?area=faturas']").click();
  await expect(page.getByRole("heading",{name:"Faturas e pagamentos",level:1})).toBeVisible();
  await expect(page.getByText("Consulta financeira indisponível",{exact:true})).toBeVisible();
  expect(calls.billing).toBe(1);
  await page.goBack();
  await expect(page.getByRole("heading",{name:"Suporte",exact:true,level:1})).toBeVisible();
  await expect(page.getByLabel("Sua mensagem",{exact:true})).toHaveValue("Rascunho que deve continuar aqui.");
  await expect(page.getByText("Consulta financeira indisponível",{exact:true})).toHaveCount(0);
  await page.goForward();
  await expect(page.locator("aside nav a[aria-current=page]")).toContainText("Faturas e pagamentos");
  expect(calls.writes).toBe(0);
});

test("portal móvel contém o suporte e usa uma única navegação por área", async ({page}) => {
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.name));
  await mockPortal(page);
  await page.setViewportSize({width:320,height:900});
  await page.goto("/__portal-shell?area=suporte");
  await expect(page.getByText(ticket.title,{exact:true})).toBeVisible();
  await expect(page.getByLabel("Navegar no portal",{exact:true})).toHaveValue("suporte");
  await expect(page.locator("aside nav")).toBeHidden();
  await page.getByText(ticket.title,{exact:true}).click();
  await expect(page.getByLabel("Sua mensagem",{exact:true})).toBeVisible();
  for (const width of [320,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.getByLabel("Sua mensagem",{exact:true}).evaluate(element=>getComputedStyle(element).fontSize)).toBe("16px");
  }
  await page.screenshot({path:"outputs/support-browser/portal-shell-mobile.png",fullPage:true});
  await page.getByLabel("Navegar no portal",{exact:true}).selectOption("conta");
  await expect(page.getByRole("heading",{name:"Minha conta",level:1})).toBeVisible();
  await page.getByLabel("Navegar no portal",{exact:true}).selectOption("suporte");
  await expect(page.getByRole("heading",{name:"Suporte",level:1,exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test("falha ao sair preserva sessão e conversa sem consultar finanças", async ({page}) => {
  const calls=await mockPortal(page);let logouts=0;
  await page.route("**/api/auth/logout",async route=>{logouts++;if(logouts===1)await route.abort("failed");else await route.fulfill({json:{ok:true}});});
  await page.goto("/__portal-shell?area=suporte");
  await expect(page.getByText(ticket.title,{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Sair da conta",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Sua sessão continua aberta");
  await expect(page.getByRole("heading",{name:"Suporte",level:1,exact:true})).toBeVisible();
  expect(calls.billing).toBe(0);
  await page.getByRole("button",{name:"Tentar sair novamente",exact:true}).click();
  await expect(page).toHaveURL("/login");
  expect(logouts).toBe(2);
});
