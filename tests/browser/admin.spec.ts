import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
const snapshot={tenants:[{id:"org-test",name:"Organização Árvore",document:"123",ownerName:"Pessoa",email:"test@example.invalid",status:"active",planId:"plan",mrr:123}],plans:[{id:"plan",name:"Plano teste"}],databases:[],invoices:[],tickets:[],integrations:[],backups:[],exports:[],jobs:[]};
test("construtor de planos duplica sem vínculos e protege rascunho", async ({page}) => {
  const plan = {id:"public-a",name:"Gestão",monthlyPrice:299,annualPrice:2990,seats:8,active:true,visibility:"public",ownerOrganizationId:null,updatedAt:"2026-09-09T12:00:00.000Z",modules:["@policy:v1","products.read","products.write","menu:products"],_count:{organizations:4}};
  await page.route("**/api/admin/plans", route => route.fulfill({json:{plans:[plan],organizations:[{id:"org-a",name:"Cliente A"}]}}));
  await page.goto("/admin/planos");
  await page.getByRole("combobox",{name:"Plano para gerenciar"}).selectOption("public-a");
  await expect(page.getByLabel("Código",{exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Salvar plano",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Duplicar para outro cliente"}).click();
  await expect(page.getByLabel("Código",{exact:true})).toHaveValue("");
  await expect(page.getByRole("combobox",{name:"Cliente exclusivo",exact:true})).toHaveValue("");
  await expect(page.getByLabel("Nome",{exact:true})).toHaveValue("Gestão — cópia");
  await expect(page.getByLabel("Produtos: Alterar",{exact:true})).toBeChecked();
  await page.getByLabel("Nome",{exact:true}).fill("Rascunho protegido");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button",{name:"Novo plano",exact:true}).click();
  await expect(page.getByLabel("Nome",{exact:true})).toHaveValue("Rascunho protegido");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button",{name:"Descartar alterações"}).click();
  await expect(page.getByLabel("Nome",{exact:true})).toHaveValue("");
});
test("recursos em lote são filtrados e prévia cabe em tela móvel", async ({page}, testInfo) => {
  const errors:string[]=[]; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/admin/plans", route => route.fulfill({json:{plans:[],organizations:[{id:"org-a",name:"Cliente A"}]}}));
  await page.goto("/admin/planos");
  await page.getByLabel("Filtrar recursos do plano").fill("Produtos");
  await page.getByRole("button",{name:"Acesso completo no filtro"}).click();
  await expect(page.getByLabel("Produtos: Alterar",{exact:true})).toBeChecked();
  await expect(page.getByRole("complementary",{name:"Resumo do plano"}).getByText("Produtos",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Somente consulta no filtro"}).click();
  await expect(page.getByLabel("Produtos: Alterar",{exact:true})).not.toBeChecked();
  await page.getByLabel("Filtrar recursos do plano").fill("Financeiro");
  await expect(page.getByLabel("Financeiro: Consultar",{exact:true})).not.toBeChecked();
  await page.getByLabel("Filtrar recursos do plano").fill("");
  await page.getByLabel("Nome",{exact:true}).fill("Plano exclusivo");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path:testInfo.outputPath("planos-desktop.png"),fullPage:true});
  await page.setViewportSize({width:320,height:800});
  await expect(page.getByRole("heading",{name:"Recursos e permissões"})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("planos-mobile.png"),fullPage:true});
  expect(errors).toEqual([]);
});
test("plano exclusivo usa seletores de recursos sem JSON e mantém formulário após erro",async({page})=>{
  let saved:Record<string,unknown>|undefined;
  await page.route("**/api/admin/plans",route=>{
    if(route.request().method()==="POST"){saved=route.request().postDataJSON();return route.fulfill({status:409,json:{error:"O plano foi alterado por outro administrador."}});}
    return route.fulfill({json:{plans:[],organizations:[{id:"org-a",name:"Cliente A"}]}});
  });
  await page.goto("/admin/planos");
  await page.getByLabel("Código",{exact:true}).fill("exclusivo-a");
  await page.getByLabel("Nome",{exact:true}).fill("Plano do Cliente A");
  await page.getByRole("combobox",{name:"Cliente exclusivo",exact:true}).selectOption("org-a");
  await page.getByLabel("Produtos: Alterar",{exact:true}).check();
  await expect(page.getByLabel("Produtos: Consultar",{exact:true})).toBeChecked();
  await page.getByLabel("Produtos: mostrar menu",{exact:true}).check();
  await page.getByRole("button",{name:"Salvar plano",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("outro administrador");
  expect(saved?.ownerOrganizationId).toBe("org-a");
  expect(saved?.visibility).toBe("private");
  expect(saved?.modules).toEqual(expect.arrayContaining(["@policy:v1","products.read","products.write","menu:products"]));
  await expect(page.getByLabel("Nome",{exact:true})).toHaveValue("Plano do Cliente A");
  await expect(page.locator("textarea,pre")).toHaveCount(0);
});
test("integração sinaliza vínculo legado e conflito 409 sem reprocessamento", async ({page}) => {
  await page.route("**/api/admin/billing", route => route.fulfill({json:{configuration:{headlessBaseUrl:"https://billing.example.test/api/v1/saas"},accounts:[{id:"account",organizationId:"org-a",externalId:"legacy-slug",organization:{name:"Loja teste"},remoteStatus:"failed"}],jobs:[{id:"job",organizationId:"org-a",status:"failed",attempts:1,errorCode:"HTTP_409",nextAttemptAt:"2026-09-09T00:00:00Z"}],events:[]}}));
  await page.goto("/admin/integracoes");
  await expect(page.getByRole("heading",{name:"Identidade e prevenção de duplicidades"})).toBeVisible();
  await expect(page.getByText("Loja teste: vínculo legado.")).toBeVisible();
  await expect(page.getByRole("button",{name:"Reprocessar",exact:true})).toBeDisabled();
  await expect(page.getByRole("cell",{name:"Sem nova tentativa agendada"})).toBeVisible();
});
test("sistema apresenta indicadores sem JSON e SMTP tem carregamento independente", async ({page}) => {
  await page.route("**/api/admin/system", route => route.fulfill({json:{host:{node:"v24.19.0",uptimeSeconds:90000,totalMemory:8589934592,freeMemory:4294967296,loadAverage:[1,2,3]},users:12,sessions:3,databases:2,organizations:[{status:"active",_count:2}],jobs:[],integrations:[]}}));
  await page.goto("/admin/sistema");
  await expect(page.getByText("8.00 GB",{exact:true})).toBeVisible();
  await expect(page.getByText("1 dias e 1 horas",{exact:true})).toBeVisible();
  await expect(page.locator("pre")).toHaveCount(0);
  let billingCalls=0;
  await page.route("**/api/admin/billing",route=>{billingCalls++;return route.abort();});
  await page.route("**/api/admin/email",route=>route.abort());
  await page.getByRole("link",{name:"E-mail e SMTP",exact:true}).click();
  await expect(page.getByRole("heading",{name:"E-mail e SMTP",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Recarregar configuração"})).toBeVisible();
  expect(billingCalls).toBe(0);
});
test("financeiro individual não confunde falha externa com ausência de cobranças", async ({page}) => {
  let mode = "partial";
  await page.route("**/api/admin/organizations/org-a/billing", route => route.fulfill({ json: mode === "invalid" ? { linked: true, invoices: [{}] } : {
    linked: true, checkedAt: "2026-09-09T12:00:00Z", payment: { paymentMethod: "pix", subscriptionStatus: "active", availableMethods: ["pix"] },
    invoices: mode === "partial" ? null : [{ id: "one", description: "Mensalidade externa", amount: null, dueAt: "2026-09-10", paidAt: null, status: "pendente" }],
    errors: { payment: null, invoices: mode === "partial" ? "Não foi possível consultar as faturas externas." : null },
  } }));
  await page.goto("/admin/organizacoes/org-a?billing-test");
  await expect(page.getByText("O histórico está indisponível", { exact: false })).toBeVisible();
  await expect(page.getByText("Nenhuma fatura retornada nesta consulta.")).toHaveCount(0);
  mode = "invalid";
  await page.getByRole("button", { name: "Atualizar financeiro" }).click();
  await expect(page.getByRole("alert")).toHaveText("Resposta financeira inválida.");
  mode = "success";
  await page.getByRole("button", { name: "Atualizar financeiro" }).click();
  await expect(page.getByRole("cell", { name: "Mensalidade externa" })).toBeVisible();
  await expect(page.getByText("R$ 0,00")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Gerar Pix|Gerar boleto|Baixar cobrança/ })).toHaveCount(0);
});

test("histórico individual preserva organização e datas ao paginar", async ({page}) => {
  const requests: URL[] = [];
  await page.route("**/api/admin/audit**", route => {
    const url = new URL(route.request().url()); requests.push(url);
    return route.fulfill({ json: { logs: [], total: 51, page: Number(url.searchParams.get("page")), pageSize: 50 } });
  });
  await page.goto("/admin/organizacoes/org-a?audit-test");
  await expect(page.getByRole("heading", { name: "Histórico administrativo da organização", level: 2 })).toBeVisible();
  await expect(page.getByText("51 registros encontrados")).toBeVisible();
  await page.getByLabel("De (UTC)").fill("2026-09-01");
  await page.getByLabel("Até (UTC)").fill("2026-09-09");
  await expect(page.getByText("51 registros encontrados")).toBeVisible();
  await page.getByRole("button", { name: "Próxima", exact: true }).click();
  await expect(page.getByText("Página 2 de 2")).toBeVisible();
  expect(requests.every(url => url.searchParams.get("organizationId") === "org-a")).toBe(true);
  expect(requests.at(-1)?.searchParams.get("from")).toBe("2026-09-01");
  expect(requests.at(-1)?.searchParams.get("to")).toBe("2026-09-09");
});

test("auditoria filtra, pagina e aponta para a organização sem renderizar metadados", async ({page}) => {
  await page.route("**/api/admin/audit**",route=>{
    const params=new URL(route.request().url()).searchParams;
    const current=Number(params.get("page"));
    return route.fulfill({json:{logs:[{id:`log-${current}`,action:"organization.save",entityType:"organization",entityId:"org-test",createdAt:"2026-09-08T12:00:00Z",user:{name:params.get("q")||`Responsável ${current}`}}],total:51,page:current,pageSize:50}});
  });
  await page.goto("/admin/auditoria");
  await expect(page.getByRole("cell",{name:"Responsável 1"})).toBeVisible();
  await page.getByRole("button",{name:"Próxima",exact:true}).click();
  await expect(page.getByRole("cell",{name:"Responsável 2"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Próxima",exact:true})).toBeDisabled();
  await page.getByLabel("Buscar na auditoria").fill("Ana");
  await page.getByRole("button",{name:"Buscar",exact:true}).click();
  await expect(page.getByRole("cell",{name:"Ana",exact:true})).toBeVisible();
  await expect(page.getByText("Página 1 de 2")).toBeVisible();
  await expect(page.getByRole("link",{name:"Visualizar organização",exact:true})).toHaveAttribute("href","/admin/organizacoes/org-test");
  await expect(page.locator("pre,textarea")).toHaveCount(0);
});
test("organizações: busca, resposta inválida, recuperação e troca entre formatos de módulo",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  let bad=false;
  await page.route("**/api/saas",route=>route.fulfill({json:bad?{}:snapshot}));
  await page.route("**/api/admin/system",route=>route.fulfill({json:{host:{node:"test"},sessions:0}}));
  await page.route("**/api/admin/audit**",route=>route.fulfill({json:{logs:[],total:0,page:1,pageSize:50}}));
  await page.goto("/admin/organizacoes");
  await expect(page.getByRole("cell",{name:"Plano teste",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"Visualizar organização Organização Árvore"})).toHaveAttribute("href","/admin/organizacoes/org-test");
  await page.getByLabel("Buscar organização").fill("arvore");
  await expect(page.getByRole("cell",{name:"Organização Árvore",exact:true})).toBeVisible();
  await page.getByLabel("Buscar organização").fill("inexistente");
  await expect(page.getByText("Nenhuma organização encontrada")).toBeVisible();
  bad=true;await page.getByRole("button",{name:"Atualizar",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("incompleta");
  bad=false;await page.getByRole("button",{name:"Tentar novamente"}).click();
  await expect(page.getByRole("cell",{name:"Organização Árvore",exact:true})).toBeVisible();
  for(const label of ["Sistema","Organizações","Auditoria","Organizações","Backups","Organizações"]){
    await page.getByRole("navigation",{name:"Administração",exact:true}).getByRole("link",{name:label,exact:true}).click();
    await expect(page.getByRole("heading",{level:1,name:label,exact:true})).toBeVisible();
    await expect(page.getByText("Carregando dados…")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
test("todos os links laterais têm uma página ou módulo implementado", async({page})=>{
  await page.route("**/api/saas",route=>route.fulfill({json:snapshot}));
  await page.goto("/admin/organizacoes");
  const links=await page.locator(".control-nav a").evaluateAll(items=>items.map(item=>item.getAttribute("href")!));
  const dynamic=readFileSync("app/admin/[module]/page.tsx","utf8");
  for(const href of links){
    expect(existsSync(`app${href}/page.tsx`)||dynamic.includes(`'${href.split("/")[2]}'`),href).toBe(true);
  }
  expect(links.length).toBe(25);
});
test("destinos de conteúdo, analytics e navegação tratam indisponibilidade",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/**",route=>route.fulfill({status:503,json:{error:"Serviço indisponível para teste"}}));
  for(const moduleName of ["biblioteca","seo","blog","glossario","analytics","navegacao","perfil"]){
    await page.goto("/admin/"+moduleName);
    await expect(page.getByText(/Serviço indisponível para teste|Não foi possível carregar este módulo/).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});
test("rede indisponível não deixa promessa rejeitada e permite nova tentativa",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/saas",route=>route.abort());
  await page.goto("/admin/organizacoes");await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Carregando dados…")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("resposta atrasada de sistema não sobrescreve organizações",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  let release=()=>{};
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/admin/system",async route=>{await pending;await route.fulfill({json:{host:{node:"old"},sessions:0}}).catch(()=>{});});
  await page.route("**/api/saas",route=>route.fulfill({json:snapshot}));
  await page.goto("/admin/sistema");
  await page.getByRole("link",{name:"Organizações",exact:true}).click();
  await expect(page.getByRole("cell",{name:"Organização Árvore",exact:true})).toBeVisible();
  release();
  await expect(page.getByRole("cell",{name:"Organização Árvore",exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
test("logout com erro mantém o painel e permite repetir",async({page})=>{
  await page.route("**/api/saas",route=>route.fulfill({json:snapshot}));
  await page.route("**/api/auth/logout",route=>route.fulfill({status:503,json:{error:"indisponível"}}));
  await page.goto("/admin/organizacoes");await page.getByRole("button",{name:"Menu da conta"}).click();
  await page.getByRole("button",{name:"Encerrar sessão"}).click();
  await expect(page.getByRole("alert")).toContainText("Não foi possível encerrar");
  await expect(page).toHaveURL(/admin\/organizacoes/);
  await expect(page.getByRole("button",{name:"Encerrar sessão"})).toBeEnabled();
});
test("menu móvel: foco, Escape, item ativo, largura e rodapé",async({page})=>{
  await page.route("**/api/saas",route=>route.fulfill({json:snapshot}));
  await page.setViewportSize({width:320,height:740});await page.goto("/admin/organizacoes");
  await expect(page.getByRole("cell",{name:"Organização Árvore",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("organizations-mobile.png"),fullPage:true});
  const open=page.getByRole("button",{name:"Abrir menu",exact:true});
  await open.click();await expect(page.getByRole("button",{name:"Fechar menu",exact:true})).toBeFocused();
  await expect(page.getByRole("link",{name:"Organizações",exact:true})).toHaveAttribute("aria-current","page");
  await page.keyboard.press("Escape");await expect(open).toBeFocused();await expect(open).toHaveAttribute("aria-expanded","false");
  await page.setViewportSize({width:1440,height:900});
  expect(await page.locator(".control-sidebar>footer a").evaluate(el=>el.getBoundingClientRect().width)).toBeGreaterThan(150);
  await page.screenshot({path:test.info().outputPath("organizations-desktop.png"),fullPage:true});
});
test("configuração financeira exige senha e limpa segredos em erro preservando URLs",async({page})=>{
  let submitted:Record<string,unknown>|undefined;
  await page.route("**/api/admin/billing",route=>{
    if(route.request().method()==="POST"){submitted=route.request().postDataJSON();return route.fulfill({status:500,json:{error:"Falha de gravação simulada"}});}
    return route.fulfill({json:{configuration:{baseUrl:"https://billing.example.test/api",headlessBaseUrl:"https://billing.example.test/headless",publicAppUrl:"https://app.example.test",productCode:"nalven",appVersion:"0.9.0",webhookUrl:"https://app.example.test/api/webhooks/billing"},accounts:[],jobs:[],events:[]}});
  });
  await page.goto("/admin/integracoes");
  const form=page.locator(".billing-settings-form");
  await form.getByLabel("API principal",{exact:true}).fill("https://changed.example.test/api");
  const password=form.getByLabel("Confirme sua senha administrativa");
  await expect(password).toHaveAttribute("required","");
  await password.fill("synthetic-confirmation");
  await form.getByLabel("Chave permanente do produto").fill("skp_nalven_synthetic_browser_key");
  await form.getByRole("button",{name:"Salvar configuração"}).click();
  await expect(page.getByText("Falha de gravação simulada")).toBeVisible();
  await expect(password).toHaveValue("");
  await expect(form.getByLabel("Chave permanente do produto")).toHaveValue("");
  await expect(form.getByLabel("API principal",{exact:true})).toHaveValue("https://changed.example.test/api");
  expect(submitted?.currentPassword).toBe("synthetic-confirmation");
  const webhook=page.locator(".webhook-import-form");
  await webhook.getByLabel("Segredo em exibição única").fill("synthetic-webhook-secret-for-browser-test");
  await webhook.getByLabel("Fingerprint do Billing").fill("0123456789abcdef");
  await webhook.getByLabel("Confirme sua senha administrativa").fill("synthetic-confirmation");
  await webhook.getByRole("button",{name:"Validar fingerprint e cifrar"}).click();
  await expect(webhook.getByLabel("Segredo em exibição única")).toHaveValue("");
  await expect(webhook.getByLabel("Confirme sua senha administrativa")).toHaveValue("");
  await expect(webhook.getByLabel("Fingerprint do Billing")).toHaveValue("0123456789abcdef");
});

test("Usuários abre a gestão correta e integrações apresentam falhas",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/api/admin/users**",route=>route.fulfill({json:{users:[],total:0,page:1,pageSize:50,actorId:"admin"}}));
  await page.goto("/admin/usuarios");await expect(page.getByRole("heading",{name:"Usuários da plataforma"})).toBeVisible();
  await expect(page.getByText("Nenhum administrador encontrado.")).toBeVisible();
  await expect(page.locator(".management pre, .management textarea")).toHaveCount(0);
  await page.route("**/api/admin/billing",route=>route.abort());
  await page.route("**/api/admin/email",route=>route.abort());
  await page.getByRole("link",{name:"Financeiro externo",exact:true}).click();
  await expect(page.getByRole("button",{name:"Tentar novamente"}).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("cadastro individual preserva edição em conflito e envia apenas campos permitidos",async({page})=>{
  await page.route("**/api/admin/organizations/org-a/fiscal**",route=>route.fulfill({json:{branches:[],total:0,page:1,pageSize:25}}));
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/admin/organizations/org-a",async route=>{
    writes.push(route.request().postDataJSON());
    await route.fulfill({status:writes.length===1?409:200,json:writes.length===1?{error:"Cadastro alterado. Recarregue antes de salvar."}:{ok:true,updatedAt:"2026-09-09T01:00:00.000Z"}});
  });
  await page.goto("/admin/organizacoes/org-a");
  await page.getByLabel("Razão social / nome",{exact:true}).fill("Cliente atualizado");
  await page.getByRole("button",{name:"Salvar cadastro"}).click();
  await expect(page.getByRole("alert")).toContainText("Cadastro alterado");
  await expect(page.getByLabel("Razão social / nome",{exact:true})).toHaveValue("Cliente atualizado");
  expect(writes[0]).toEqual({name:"Cliente atualizado",ownerName:"Responsável",email:"contact@example.test",updatedAt:"2026-09-09T00:00:00.000Z"});
  await expect(page.getByLabel("Documento fiscal")).toHaveAttribute("readonly","");
  await page.getByRole("button",{name:"Salvar cadastro"}).click();
  await expect(page.getByRole("status")).toContainText("Cadastro salvo");
});

test("central de usuários administrativos consulta somente a organização selecionada",async({page})=>{
  let calls=0;
  await page.route("**/api/admin/organizations/org-a/users",async route=>{
    calls++;await route.fulfill({json:{members:[],roles:[],invites:[],branches:[],activity:[],permissionResources:[],capabilities:{canWrite:true},generatedAt:"2026-09-09T00:00:00Z",summary:{active:0,disabled:0,expired:0,pending:0,roles:0,sessions:0,stale:0,reviewDue:0,branchCoverage:0}}});
  });
  await page.goto("/admin/organizacoes/org-a?users-test");
  await expect(page.getByRole("heading",{name:"Usuários desta organização"})).toBeVisible();
  await page.getByRole("tab",{name:"Convites",exact:true}).click();
  await expect(page.getByRole("button",{name:"+ Convidar usuário"})).toBeVisible();
  await page.getByRole("tab",{name:"Atividade",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Atividade de identidade e acesso"})).toBeVisible();
  await expect(page.locator('a[href^="/erp/"]')).toHaveCount(0);
  expect(calls).toBe(1);
});

test("atribuição de plano exige confirmação e preserva seleção em conflito",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/admin/organizations/org-a/plan",async route=>{
    if(route.request().method()==="POST"){
      writes.push(route.request().postDataJSON());await route.fulfill({status:409,json:{error:"A organização mudou. Recarregue os planos antes de confirmar."}});
    }else await route.fulfill({json:{organization:{id:"org-a",planId:"public",updatedAt:"2026-09-09T00:00:00.000Z"},plans:[{id:"public",name:"Público",seats:5,visibility:"public"},{id:"private",name:"Exclusivo A",seats:10,visibility:"private"}]}});
  });
  await page.goto("/admin/organizacoes/org-a?plan-test");
  await page.getByLabel("Plano disponível").selectOption("private");
  await expect(page.getByRole("button",{name:"Atribuir plano",exact:true})).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button",{name:"Atribuir plano",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("A organização mudou");
  await expect(page.getByLabel("Plano disponível")).toHaveValue("private");
  expect(writes).toEqual([{planId:"private",updatedAt:"2026-09-09T00:00:00.000Z",confirm:true}]);
});

test("dados fiscais recuperam falha do tenant sem interromper o cadastro",async({page})=>{
  let calls=0;
  await page.route("**/api/admin/organizations/org-a/fiscal**",async route=>{
    if(++calls===1){await route.abort();return;}
    await route.fulfill({json:{branches:[{id:1,name:"Matriz",legalName:"Cliente A Ltda",document:"Documento fiscal de teste",stateRegistrationExempt:true,status:"active",primary:true}],total:1,page:1,pageSize:25}});
  });
  await page.goto("/admin/organizacoes/org-a");
  await expect(page.getByRole("button",{name:"Salvar cadastro"})).toBeVisible();
  await page.getByRole("button",{name:"Recarregar dados fiscais"}).click();
  await expect(page.getByRole("heading",{name:"Matriz · Unidade principal"})).toBeVisible();
  await expect(page.locator("#fiscal")).toContainText("Cliente A Ltda");
  await expect(page.locator("#fiscal")).toContainText("Isenta");
  await expect(page.locator("#fiscal pre, #fiscal textarea")).toHaveCount(0);
});

test("dados fiscais ocultam a página anterior enquanto aguardam a próxima", async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const branch = { id: 1, name: "Primeira unidade", legalName: "Empresa teste", document: "Documento teste", primary: true, stateRegistrationExempt: true, status: "active" };
  await page.route("**/api/admin/organizations/org-a/fiscal**", async route => {
    const current = Number(new URL(route.request().url()).searchParams.get("page"));
    if (current === 2) await gate;
    await route.fulfill({ json: { branches: [{ ...branch, id: current, name: current === 1 ? "Primeira unidade" : "Segunda unidade" }], total: 26, page: current, pageSize: 25 } });
  });
  try {
    await page.goto("/admin/organizacoes/org-a");
    await expect(page.locator("#fiscal")).toContainText("Primeira unidade");
    await page.getByRole("button", { name: "Próximas unidades" }).click();
    await expect(page.locator("#fiscal [role=status]")).toHaveText("Consultando unidades…");
    await expect(page.locator("#fiscal")).not.toContainText("Primeira unidade");
    release!();
    await expect(page.locator("#fiscal")).toContainText("Segunda unidade");
    await expect(page.locator("#fiscal")).toContainText("página 2");
  } finally { release!(); }
});

test("dados fiscais recusam registros malformados e recuperam sem exceção de renderização", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const branch = { id: 1, name: "Matriz", legalName: "Cliente A Ltda", document: "Documento de teste", stateRegistrationExempt: true, primary: true, status: "active" };
  const invalid = [null, { ...branch, legalName: {} }, { ...branch, primary: "true" }, { ...branch, city: [] }];
  let call = 0;
  await page.route("**/api/admin/organizations/org-a/fiscal**", route => route.fulfill({ json: { branches: [call < invalid.length ? invalid[call++] : branch], total: 1, page: 1, pageSize: 25 } }));
  await page.goto("/admin/organizacoes/org-a");
  for (let index = 0; index < invalid.length; index++) {
    await expect(page.locator("#fiscal [role=alert]")).toContainText("Resposta fiscal inválida");
    await expect(page.getByRole("button", { name: "Salvar cadastro" })).toBeVisible();
    await page.getByRole("button", { name: "Recarregar dados fiscais" }).click();
  }
  await expect(page.locator("#fiscal")).toContainText("Cliente A Ltda");
  expect(errors).toEqual([]);
});

test("site edita recursos com campos próprios e preserva alterações em conflito",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/admin/site",async route=>{
    if(route.request().method()==="POST"){
      writes.push(route.request().postDataJSON());await route.fulfill({status:409,json:{error:"Este conteúdo mudou. Recarregue antes de salvar novamente."}});
    }else await route.fulfill({json:{content:[{key:"features.items",group:"features",label:"Recursos",type:"json",public:true,updatedAt:"2026-09-09T00:00:00.000Z",value:[{title:"Vendas",description:"Descrição de vendas"}]}]}});
  });
  await page.goto("/admin/site");
  await expect(page.getByRole("heading",{name:"Site público",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Adicionar recurso"}).click();
  await page.getByLabel("Título do recurso 2",{exact:true}).fill("Estoque");
  await page.getByLabel("Descrição do recurso 2",{exact:true}).fill("Controle de estoque");
  await page.getByRole("button",{name:"Subir recurso 2"}).click();
  await expect(page.getByLabel("Título do recurso 1",{exact:true})).toHaveValue("Estoque");
  await page.getByRole("button",{name:"Salvar conteúdo"}).click();
  await expect(page.getByRole("status")).toContainText("Este conteúdo mudou");
  await expect(page.getByLabel("Título do recurso 1",{exact:true})).toHaveValue("Estoque");
  expect(writes[0].value).toEqual([{title:"Estoque",description:"Controle de estoque"},{title:"Vendas",description:"Descrição de vendas"}]);
  expect(writes[0].updatedAt).toBe("2026-09-09T00:00:00.000Z");
  await expect(page.locator(".management pre")).toHaveCount(0);
  expect(await page.locator(".management textarea").evaluateAll(elements=>elements.map(element=>(element as HTMLTextAreaElement).value))).toEqual(["Controle de estoque","Descrição de vendas"]);
});

test("licenças têm página própria, consulta externa e vínculo com organização",async({page})=>{
  let verifies=0;
  await page.route("**/api/admin/licenses**",async route=>{
    if(route.request().method()==="POST"){
      expect(route.request().postDataJSON()).toEqual({action:"verify",organizationId:"org-a"});
      verifies++; await route.fulfill({json:{valid:true,checkedAt:"2026-09-09T00:00:00Z"}});
    }else await route.fulfill({json:{accounts:[{id:"account",organizationId:"org-a",organization:{name:"Cliente A"},licenseStatus:"active",subscriptionStatus:"active",lastSyncedAt:null}],total:1,page:1,pageSize:50,timeoutMs:5000,cacheSeconds:300}});
  });
  await page.goto("/admin/licencas");
  await expect(page.getByRole("heading",{name:"Licenças",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"Cliente A",exact:true})).toHaveAttribute("href","/admin/organizacoes/org-a");
  await page.getByRole("button",{name:"Validar agora"}).click();
  await expect(page.getByRole("status")).toContainText("Cliente A: licença válida");
  expect(verifies).toBe(1);
  await expect(page.locator(".management pre, .management textarea")).toHaveCount(0);
  await expect(page.getByRole("heading",{name:"Política de consulta de licença"})).toBeVisible();
});

test("comunicados e modelos usam páginas e consultas separadas",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/admin/control**",async route=>{
    if(route.request().method()==="POST"){
      writes.push(route.request().postDataJSON());await route.fulfill({status:503,json:{error:"Falha temporária ao salvar."}});return;
    }
    const section=new URL(route.request().url()).searchParams.get("section");
    expect(["templates","announcements"]).toContain(section);
    await route.fulfill({json:section==="templates"?{templates:[{id:"welcome",name:"Boas-vindas",subject:"Olá {{name}}",body:"Seja bem-vindo, {{name}}.",active:true}]}:{announcements:[]}});
  });
  await page.goto("/admin/comunicados");
  await expect(page.getByRole("heading",{name:"Comunicados",exact:true})).toBeVisible();
  await page.getByLabel("Título",{exact:true}).fill("Manutenção programada");
  await page.getByLabel("Mensagem",{exact:true}).fill("Aviso de manutenção");
  await page.getByRole("button",{name:"Publicar comunicado"}).click();
  await expect(page.getByRole("alert")).toContainText("Falha temporária");
  await expect(page.getByLabel("Título",{exact:true})).toHaveValue("Manutenção programada");
  expect(writes[0].audience).toBe("all");
  await page.getByRole("link",{name:"Modelos de e-mail",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Modelos de e-mail",exact:true})).toBeVisible();
  await expect(page.getByLabel("Assunto",{exact:true})).toHaveValue("Olá {{name}}");
  await expect(page.locator(".management pre")).toHaveCount(0);
});

test("gestão vira índice sem carga agregada e configurações usam campos próprios",async({page})=>{
  let aggregate=0;
  await page.route("**/api/admin/control**",async route=>{aggregate++;await route.abort();});
  await page.goto("/admin/gestao");
  await expect(page.getByRole("heading",{name:"Gestão da plataforma",exact:true})).toBeVisible();
  await expect(page.locator(".management form, .management textarea")).toHaveCount(0);
  expect(aggregate).toBe(0);
  await page.route("**/api/admin/platform-settings",async route=>{
    if(route.request().method()==="POST"){
      expect(route.request().postDataJSON().billingPlanCodes).toEqual({public:"billing-code"});
      await route.fulfill({status:409,json:{error:"A configuração mudou."}});
    }else await route.fulfill({json:{name:"Nalven",domain:"example.test",trialDays:14,dueDay:10,paymentMethods:["pix"],plans:[{id:"public",name:"Plano público",visibility:"public",active:true,billingCode:"billing-code"}],versions:{saas:null,signup:null}}});
  });
  await page.getByRole("link",{name:"Configurações da plataforma",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Configurações da plataforma"})).toBeVisible();
  await page.getByLabel("Nome da plataforma").fill("Novo nome");
  await page.getByLabel("Sua senha administrativa").fill("FixtureAdmin123!");
  await page.getByRole("button",{name:"Salvar configurações",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("A configuração mudou");
  await expect(page.getByLabel("Nome da plataforma")).toHaveValue("Novo nome");
  await expect(page.getByLabel("Sua senha administrativa")).toHaveValue("");
});

test("webhooks distingue recebimento financeiro de cadastros sem entrega",async({page})=>{
  await page.route("**/api/admin/webhooks**",route=>route.fulfill({json:{records:[{id:"legacy",name:"Registro antigo",url:"https://example.test/events",createdAt:"2026-09-09T00:00:00Z",lastAt:null,lastStatus:null}],total:1,page:1,pageSize:50}}));
  await page.goto("/admin/webhooks");
  await expect(page.getByRole("heading",{name:"Webhooks",exact:true})).toBeVisible();
  await expect(page.getByRole("note")).toContainText("não possuem serviço de entrega implementado");
  await expect(page.getByRole("link",{name:"Gerenciar receptor financeiro →"})).toHaveAttribute("href","/admin/integracoes");
  await expect(page.getByText("Registro antigo",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:/Criar|Ativar/})).toHaveCount(0);
});

test("SEO edita estrutura existente por campos sem expor JSON",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/admin/content**",async route=>{
    if(route.request().method()==="POST"){
      writes.push(route.request().postDataJSON());await route.fulfill({status:409,json:{error:"Conflito de teste"}});return;
    }
    await route.fulfill({json:{items:[{path:"/",title:"Página inicial",description:"Descrição de teste",robots:"index,follow",schemaJson:{"@context":"https://schema.org","@type":"Organization",name:"Empresa anterior",sameAs:["https://example.test"],address:{city:"São Paulo"}}}]}});
  });
  await page.goto("/admin/seo");
  await page.getByRole("button",{name:/Página inicial/}).click();
  await page.getByLabel("Nome",{exact:true}).fill("Empresa atualizada");
  await page.getByRole("button",{name:"Salvar",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("Conflito de teste");
  expect(writes[0].schemaJson).toEqual({"@context":"https://schema.org","@type":"Organization",name:"Empresa atualizada",sameAs:["https://example.test"],address:{city:"São Paulo"}});
  await expect(page.locator('textarea[name="schemaJson"], pre')).toHaveCount(0);
  await expect(page.getByLabel("Nome",{exact:true})).toHaveValue("Empresa atualizada");
});

test("política de licença preserva valores e limpa senha após conflito",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/admin/licenses**",async route=>{
    if(route.request().method()==="POST"){
      writes.push(route.request().postDataJSON());await route.fulfill({status:409,json:{error:"A política mudou. Recarregue a página antes de salvar."}});
    }else await route.fulfill({json:{accounts:[],total:0,page:1,pageSize:50,timeoutMs:5000,cacheSeconds:300,policyVersion:"2026-09-09T00:00:00.000Z"}});
  });
  await page.goto("/admin/licencas");
  await page.getByLabel("Tempo limite da consulta (ms)").fill("6000");
  await page.getByLabel("Sua senha administrativa").fill("FixtureAdmin123!");
  await page.getByRole("button",{name:"Salvar política de licença"}).click();
  await expect(page.getByRole("status")).toContainText("A política mudou");
  await expect(page.getByLabel("Tempo limite da consulta (ms)")).toHaveValue("6000");
  await expect(page.getByLabel("Sua senha administrativa")).toHaveValue("");
  expect(writes[0].licenseTimeoutMs).toBe(6000);
  expect(writes[0].policyVersion).toBe("2026-09-09T00:00:00.000Z");
});

test("Usuários preserva cadastro em erro e limpa a confirmação administrativa",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/admin/users**",async route=>{
    if(route.request().method()==="POST"){
      writes.push(route.request().postDataJSON());
      await route.fulfill({status:409,json:{error:"Este e-mail já possui uma conta."}});
    }else await route.fulfill({json:{users:[],total:0,page:1,pageSize:50,actorId:"admin"}});
  });
  await page.goto("/admin/usuarios");
  await page.getByRole("button",{name:"Novo administrador",exact:true}).click();
  await page.getByLabel("Nome",{exact:true}).fill("Administrador de teste");
  await page.getByLabel("E-mail",{exact:true}).fill("existing@example.test");
  await page.getByLabel("Senha inicial do novo administrador").fill("TestPassword123!");
  await page.getByLabel("Sua senha administrativa").fill("FixtureAdmin123!");
  await page.getByRole("button",{name:"Salvar administrador"}).click();
  await expect(page.getByRole("alert")).toHaveText("Este e-mail já possui uma conta.");
  await expect(page.getByLabel("Nome",{exact:true})).toHaveValue("Administrador de teste");
  await expect(page.getByLabel("Sua senha administrativa")).toHaveValue("");
  expect(writes).toHaveLength(1);
  expect(writes[0].action).toBe("create");
  expect(writes[0].role).toBeUndefined();
  expect(writes[0].organizationId).toBeUndefined();
});
