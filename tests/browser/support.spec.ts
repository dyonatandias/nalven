import { expect, test, type Page, type Route } from "@playwright/test";
import type { SupportDetailData, SupportListData, SupportTicketSummary } from "../../lib/billing/support-data";

const timestamp = "2026-09-08T10:00:00Z";
const tickets: SupportTicketSummary[] = Array.from({ length: 43 }, (_, index) => ({ token: `ticket-${index + 1}`, number: `SUP-${String(index + 1).padStart(3, "0")}`, title: `Solicitação de suporte ${index + 1}`, status: index % 2 ? "fechado" : "aberto", category: index % 2 ? "pagamento" : "duvida", priority: index % 3 ? "media" : "alta", createdAt: timestamp, updatedAt: timestamp, slaHours: 24, slaExceeded: false }));
function detailFor(ticket: SupportTicketSummary, write = true): SupportDetailData {
  return { ticket: { ...ticket, description: "Descrição da solicitação de suporte sem dados reais.", messages: [
    { id: "13", authorName: "Cliente de teste", authorType: "client", body: "Segunda mensagem do cliente.", createdAt: "2026-09-08T12:00:00Z", attachments: [] },
    { id: "12", authorName: "Atendimento", authorType: "support", body: "Resposta pública do atendimento.", createdAt: "2026-09-08T11:00:00Z", attachments: [] },
    { id: "11", authorName: "Cliente de teste", authorType: "client", body: "Primeira mensagem do cliente.", createdAt: timestamp, attachments: [{ id: "7", name: "diagnostico.pdf", mimeType: "application/pdf", size: 2048, downloadUrl: `/api/portal/billing/files?type=anexo&token=7&ticketToken=${ticket.token}` }] },
  ] }, capabilities: { canWrite: write, canReply: write && ticket.status === "aberto", canAttach: write && ticket.status === "aberto" }, generatedAt: timestamp };
}
function listFor(rows: SupportTicketSummary[], params: URLSearchParams, write = true, partial = false): SupportListData {
  let filtered = rows.filter(ticket => (!params.get("search") || `${ticket.title} ${ticket.number}`.toLowerCase().includes(params.get("search")!.toLowerCase())) && (["status", "category", "priority"] as const).every(key => !params.get(key) || ticket[key] === params.get(key)));
  if (params.get("sort") === "oldest") filtered = [...filtered].reverse();
  const page = Math.max(1, Number(params.get("page")) || 1), pageSize = 20;
  return { tickets: filtered.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / pageSize)), hasMore: page * pageSize < filtered.length, partial }, summary: { loaded: rows.length, totalKnown: partial ? null : rows.length, byStatus: rows.reduce<Record<string, number>>((counts, ticket) => ({ ...counts, [ticket.status]: (counts[ticket.status] || 0) + 1 }), {}) }, facets: { statuses: [...new Set(rows.map(ticket => ticket.status))], categories: [...new Set(rows.map(ticket => ticket.category))], priorities: [...new Set(rows.map(ticket => ticket.priority))] }, capabilities: { canWrite: write }, warning: partial ? "Busca e contadores consideram somente os chamados recebidos do serviço." : null, generatedAt: timestamp };
}
async function mockSupport(page: Page, options: { rows?: SupportTicketSummary[]; write?: boolean; partial?: boolean; detail?: (ticket: SupportTicketSummary) => SupportDetailData; intercept?: (route: Route, query: URLSearchParams) => Promise<boolean> } = {}) {
  const calls = { queries: [] as URLSearchParams[], organizations: [] as string[], writes: [] as Record<string, unknown>[], finance: 0 };
  await page.route("**/api/portal/billing", async route => { calls.finance++; await route.fulfill({ status: 503, json: { error: "Finanças indisponíveis." } }); });
  await page.route("**/api/portal/support**", async route => {
    const request = route.request(), query = new URL(request.url()).searchParams;
    calls.organizations.push(request.headers()["x-organization-id"] || "");
    if (request.method() === "POST") calls.writes.push(request.postDataJSON()); else calls.queries.push(query);
    if (await options.intercept?.(route, query)) return;
    if (request.method() !== "GET") { await route.fulfill({ status: 500, json: { error: "Envio deve ser simulado explicitamente." } }); return; }
    const rows = options.rows || tickets;
    if (query.get("resource") === "detail") { const ticket = rows.find(ticket => ticket.token === query.get("token")); await route.fulfill(ticket ? { json: options.detail?.(ticket) || detailFor(ticket, options.write) } : { status: 404, json: { error: "Chamado não encontrado." } }); }
    else await route.fulfill({ json: listFor(rows, query, options.write, options.partial) });
  });
  return calls;
}
const openTicket = async (page: Page, index = 1) => { await page.getByRole("button", { name: new RegExp(`^Solicitação de suporte ${index} SUP-`) }).click(); await expect(page.getByRole("heading", { name: `Solicitação de suporte ${index}`, exact: true })).toBeVisible(); };

test("consulta independente, filtros/paginação e erro não apagam os chamados recebidos", async ({ page }) => {
  let fail = true;
  const calls = await mockSupport(page, { partial: true, intercept: async route => { if (fail) { await route.fulfill({ status: 503, json: { error: "Atendimento indisponível para consulta." } }); return true; } return false; } });
  await page.goto("/__support");
  await expect(page.getByRole("alert")).toContainText("Atendimento indisponível");
  await expect(page.getByRole("heading", { name: "Suporte temporariamente indisponível" })).toBeVisible();
  fail = false; await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.getByText("43 resultado(s) nos 43 chamados recebidos do serviço")).toBeVisible();
  await expect(page.getByText("Busca e contadores consideram somente os chamados recebidos do serviço.")).toBeVisible();
  await page.getByRole("button", { name: "Próxima", exact: true }).click();
  await expect(page.getByText("Página 2 de 3")).toBeVisible();
  await page.getByLabel("Buscar chamado", { exact: true }).fill("SUP-043");
  await expect(page.getByText("1 resultado(s) nos 43 chamados recebidos do serviço")).toBeVisible();
  await expect(page.getByText("Página 1 de 1")).toBeVisible();
  expect(calls.queries.at(-1)?.get("page")).toBe("1");
  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("aberto");
  await page.getByLabel("Categoria", { exact: true }).selectOption("duvida");
  await page.getByLabel("Prioridade", { exact: true }).selectOption("alta");
  await page.getByLabel("Ordenar por", { exact: true }).selectOption("oldest");
  await expect.poll(() => calls.queries.at(-1)?.get("sort")).toBe("oldest");
  fail = true; await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Atendimento indisponível");
  await expect(page.getByRole("region", { name: "Lista de chamados" }).getByRole("button").first()).toBeVisible();
  expect(calls.queries.at(-1)?.get("refresh")).toBe("1");
  expect(calls.finance).toBe(0); expect(calls.writes).toHaveLength(0);
});

test("320/390px comportam assunto, protocolo, conversa e anexos longos sem rolagem horizontal", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const long = { ...tickets[0], title: `Solicitação-${"X".repeat(220)}`, number: `SUP-${"9".repeat(96)}`, slaExceeded: true };
  await mockSupport(page, { rows: [long], detail: ticket => { const data = detailFor(ticket); data.ticket.description = "D".repeat(350); data.ticket.messages[0].body = "M".repeat(450); data.ticket.messages[0].authorName = "C".repeat(150); data.ticket.messages[2].attachments[0].name = `${"arquivo".repeat(30)}.pdf`; return data; } });
  await page.setViewportSize({ width: 320, height: 900 }); await page.goto("/__support");
  await expect(page.getByRole("button", { name: "Novo chamado", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Novo chamado", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Novo chamado" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: new RegExp(`^${long.title}`) }).click();
  await expect(page.getByText("SLA informado: 24 horas · excedido segundo o serviço")).toBeVisible();
  for (const width of [320, 390]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await page.screenshot({ path: "outputs/support-browser/workspace-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Voltar à lista" }).click();
  await expect(page.getByLabel("Buscar chamado")).toBeVisible();
  expect(errors).toEqual([]);
});

test("respostas obsoletas não trocam conversa, e rascunhos ficam em memória por chamado e área", async ({ page }) => {
  let delayed: Route | undefined;
  const calls = await mockSupport(page, { intercept: async (route, query) => { if (query.get("resource") === "detail" && query.get("token") === "ticket-1" && !delayed) { delayed = route; return true; } return false; } });
  await page.goto("/__support");
  await page.getByRole("button", { name: /^Solicitação de suporte 1 SUP-/ }).click();
  await expect.poll(() => Boolean(delayed)).toBe(true);
  await openTicket(page, 3);
  await delayed!.fulfill({ json: detailFor(tickets[0]) }).catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Solicitação de suporte 3", exact: true })).toBeVisible();
  await page.getByLabel("Sua mensagem", { exact: true }).fill("Rascunho da terceira conversa.");
  await openTicket(page, 1); await page.getByLabel("Sua mensagem", { exact: true }).fill("Rascunho da primeira conversa.");
  await openTicket(page, 3); await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveValue("Rascunho da terceira conversa.");
  await page.getByRole("button", { name: "Alternar área de teste" }).click();
  await expect(page.getByText("Outra área de teste")).toBeVisible();
  await page.getByRole("button", { name: "Alternar área de teste" }).click();
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveValue("Rascunho da terceira conversa.");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole("button", { name: "Alternar organização de teste" }).click();
  await expect(page.getByRole("heading", { name: "Selecione um chamado" })).toBeVisible();
  await openTicket(page, 3); await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveValue("");
  expect(calls.organizations).toContain("support-org-b"); expect(calls.writes).toHaveLength(0);
});

test("modal acessível mantém dados e erro local após rejeição, Escape devolve foco", async ({ page }) => {
  const calls = await mockSupport(page, { intercept: async route => { if (route.request().method() === "POST") { await route.fulfill({ status: 422, json: { error: "Revise a categoria selecionada." } }); return true; } return false; } });
  await page.goto("/__support"); await page.getByRole("button", { name: "Novo chamado", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Novo chamado" });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("dialog")?.contains(document.activeElement))).toBe(true);
  await page.getByLabel("Assunto", { exact: true }).fill("Dúvida sobre configuração");
  await page.getByLabel("Descrição", { exact: true }).fill("Preciso de ajuda para configurar uma opção de teste.");
  await page.getByRole("button", { name: "Criar chamado", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Revise a categoria");
  await expect(page.getByLabel("Assunto", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Assunto", { exact: true })).toHaveValue("Dúvida sobre configuração");
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Novo chamado", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Novo chamado", exact: true }).click();
  await expect(page.getByLabel("Descrição", { exact: true })).toHaveValue("Preciso de ajuda para configurar uma opção de teste.");
  expect(calls.writes).toHaveLength(1);
});

test("ack inválido e 429 preservam um único comando, respeitam Retry-After e não reenviam após sucesso", async ({ page }) => {
  let writes = 0, confirmed = false;
  const calls = await mockSupport(page, { intercept: async route => {
    if (route.request().method() === "POST") { writes++; if (writes === 1) await route.fulfill({ json: { error: "Resposta incompleta." } }); else if (writes === 2) await route.fulfill({ json: [] }); else if (writes === 3) await route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "Aguarde antes de confirmar." } }); else { confirmed = true; await route.fulfill({ json: { ok: true, result: { ticketToken: "ticket-1", messageId: null } } }); } return true; }
    if (confirmed) { await route.fulfill({ status: 503, json: { error: "Consulta temporariamente indisponível." } }); return true; } return false;
  } });
  await page.goto("/__support"); await page.getByRole("button", { name: "Novo chamado", exact: true }).click();
  await page.getByLabel("Assunto", { exact: true }).fill("Teste de confirmação única"); await page.getByLabel("Descrição", { exact: true }).fill("Descrição de teste preservada durante uma falha.");
  await page.getByRole("dialog").locator("form").evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("não confirmou"); expect(writes).toBe(1);
  await expect(page.getByLabel("Assunto", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Confirmar chamado", exact: true }).click();
  await expect.poll(() => writes).toBe(2); await expect(page.getByRole("button", { name: "Confirmar chamado", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Confirmar chamado", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /Aguarde \d+s para confirmar/ })).toBeDisabled();
  expect(writes).toBe(3);
  await expect(page.getByRole("button", { name: "Confirmar chamado", exact: true })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Confirmar chamado", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden(); await expect(page.getByText("Chamado criado. A lista será atualizada.")).toBeVisible();
  await expect(page.getByText("Consulta temporariamente indisponível.").first()).toBeVisible();
  expect(calls.writes).toHaveLength(4); expect(calls.writes.every(body => JSON.stringify(body) === JSON.stringify(calls.writes[0]))).toBe(true);
  await page.getByRole("button", { name: "Atualizar", exact: true }).click(); expect(calls.writes).toHaveLength(4);
});

test("resposta incerta mantém chave e conteúdo ao alternar chamado e estado remoto", async ({ page }) => {
  const duplicateKeys: string[] = []; page.on("console", message => { if (message.text().includes("same key")) duplicateKeys.push(message.text()); });
  let writes = 0;
  const calls = await mockSupport(page, { intercept: async route => { if (route.request().method() !== "POST") return false; writes++; if (writes === 1) await route.abort("failed"); else if (writes === 2) await route.fulfill({ status: 409, json: { error: "Confira o histórico antes de descartar um envio anterior.", retryable: true, outcome: "unknown" } }); else await route.fulfill({ json: { ok: true, result: { ticketToken: "ticket-1", messageId: "20" } } }); return true; } });
  await page.goto("/__support"); await openTicket(page);
  await page.getByLabel("Sua mensagem", { exact: true }).fill("Resposta que deve ser enviada uma única vez.");
  await page.getByRole("button", { name: "Enviar resposta", exact: true }).click();
  await expect(page.getByText("Há um envio sem confirmação.", { exact: false })).toBeVisible();
  await openTicket(page, 3); await expect(page.getByLabel("Sua mensagem", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Ver envio pendente", exact: true }).click();
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveValue("Resposta que deve ser enviada uma única vez.");
  await page.getByRole("button", { name: "Confirmar resposta enviada", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Confira o histórico");
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Confirmar resposta enviada", exact: true }).click();
  await expect(page.getByText("Resposta enviada. A conversa será atualizada.")).toBeVisible();
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveValue("");
  expect(calls.writes).toHaveLength(3); expect(calls.writes.every(body => JSON.stringify(body) === JSON.stringify(calls.writes[0]))).toBe(true);
  expect(duplicateKeys).toEqual([]); await expect(page.locator("#support-reply")).toHaveCount(1);
});

test("encerrar tentativa exige revisão explícita e não é apresentado como cancelamento remoto", async ({ page }) => {
  const calls = await mockSupport(page, { intercept: async route => { if (route.request().method() !== "POST") return false; await route.fulfill({ status: 503, json: { error: "Resultado ainda desconhecido." } }); return true; } });
  await page.goto("/__support"); await openTicket(page);
  await page.getByLabel("Sua mensagem", { exact: true }).fill("Rascunho preservado para revisão manual.");
  await page.getByRole("button", { name: "Enviar resposta", exact: true }).click();
  await page.getByRole("button", { name: "Encerrar tentativa", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Encerrar tentativa pendente?" });
  await expect(dialog).toBeVisible(); await expect(dialog.getByText("Um novo envio poderá duplicar o anterior.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Encerrar após revisão" })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Encerrar tentativa", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Encerrar tentativa", exact: true }).click();
  await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "Encerrar após revisão" }).click();
  await expect(dialog).toBeHidden(); await expect(page.getByText("Tentativa encerrada somente nesta página.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveValue("Rascunho preservado para revisão manual.");
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toBeEnabled(); expect(calls.writes).toHaveLength(1);
});

test("revogação de acesso ao detalhe remove dados sem criar chamadas financeiras", async ({ page }) => {
  let denied = false;
  let lateList: Route | undefined, deniedDetail: Route | undefined;
  const calls = await mockSupport(page, { intercept: async (route, query) => { if (denied) { if (query.get("resource") === "detail") deniedDetail = route; else lateList = route; return true; } return false; } });
  await page.goto("/__support"); await openTicket(page);
  denied = true; await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect.poll(() => Boolean(lateList && deniedDetail)).toBe(true);
  await deniedDetail!.fulfill({ status: 403, json: { error: "Permissão de consulta removida." } });
  await expect(page.getByRole("alert")).toContainText("Permissão de consulta removida.");
  await lateList!.fulfill({ json: listFor(tickets, new URLSearchParams()) }).catch(() => undefined);
  await expect(page.getByRole("region", { name: "Lista de chamados" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Mensagens do chamado" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Novo chamado", exact: true })).toBeDisabled();
  expect(calls.finance).toBe(0); expect(calls.writes).toHaveLength(0);
});

test("anexos exigem vínculo explícito; respostas null não travam e retry preserva arquivo e chave", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const uploads: { id: string; message: string; token: string; filename: string; content: string; organization: string }[] = [];
  await mockSupport(page);
  await page.route("**/api/portal/billing/files**", async route => {
    if (route.request().method() === "GET") { await route.fulfill({ status: 403, json: { error: "Arquivo indisponível para este perfil." } }); return; }
    const request = route.request(); const form = await new Response(Uint8Array.from(request.postDataBuffer() || []), { headers: { "content-type": request.headers()["content-type"] } }).formData();
    const file = form.get("file") as File;
    uploads.push({ id: String(form.get("commandId")), message: String(form.get("messageId")), token: String(form.get("ticketToken")), filename: file.name, content: await file.text(), organization: request.headers()["x-organization-id"] });
    await route.fulfill(uploads.length === 1 ? { status: 503, body: "null", contentType: "application/json" } : uploads.length === 2 ? { body: "null", contentType: "application/json" } : { json: { ok: true } });
  });
  await page.goto("/__support"); await openTicket(page);
  const selector = page.getByLabel("Anexar à mensagem", { exact: true });
  await expect(selector).toHaveValue(""); await expect(selector.locator("option")).toHaveCount(3);
  await expect(selector.locator("option[value='12']")).toHaveCount(0);
  const messages = page.getByRole("list", { name: "Mensagens do chamado" }).getByRole("listitem");
  await expect(messages.first()).toContainText("Primeira mensagem do cliente.");
  await selector.selectOption("11");
  await page.getByLabel("Arquivo", { exact: true }).setInputFiles({ name: "script.html", mimeType: "text/html", buffer: Buffer.from("<script>no</script>") });
  await page.getByRole("button", { name: "Enviar arquivo", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("Formato não permitido"); expect(uploads).toHaveLength(0);
  await page.getByLabel("Arquivo", { exact: true }).setInputFiles({ name: "diagnostico.txt", mimeType: "text/plain", buffer: Buffer.from("Arquivo de teste sem dados reais.") });
  await page.getByRole("button", { name: "Enviar arquivo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirmar envio do anexo", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Arquivo", { exact: true })).toBeDisabled();
  await openTicket(page, 3); await page.getByRole("button", { name: "Ver envio pendente", exact: true }).click();
  await expect(selector).toHaveValue("11"); await expect(page.getByText("diagnostico.txt ·", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Confirmar envio do anexo", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("não confirmou");
  await page.getByRole("button", { name: "Confirmar envio do anexo", exact: true }).click(); await expect(page.getByText("Anexo enviado. A conversa será atualizada.")).toBeVisible();
  expect(uploads).toHaveLength(3); expect(uploads.every(upload => JSON.stringify(upload) === JSON.stringify(uploads[0]))).toBe(true); expect(uploads[0].organization).toBe("support-org-a");
  await page.getByRole("link", { name: "diagnostico.pdf", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("Arquivo indisponível para este perfil.");
  expect(errors).toEqual([]);
});

test("capacidades de leitura e status desconhecido não inventam ações", async ({ page }) => {
  const row = { ...tickets[0], status: "em_validacao_externa" };
  const calls = await mockSupport(page, { rows: [row], write: false });
  await page.goto("/__support"); await expect(page.getByRole("button", { name: "Novo chamado", exact: true })).toBeDisabled();
  await expect(page.getByText("Seu perfil permite consultar os chamados.", { exact: false })).toBeVisible();
  await openTicket(page); await expect(page.getByText("em validacao externa", { exact: true }).last()).toBeVisible();
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Arquivo", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Fechar chamado|Reabrir chamado/ })).toHaveCount(0);
  expect(calls.writes).toHaveLength(0);
});

test("atualização suave preserva foco e rascunho e pausa fora da área", async ({ page }) => {
  await page.clock.install();
  const calls = await mockSupport(page);
  await page.goto("/__support"); await openTicket(page);
  await page.getByLabel("Sua mensagem", { exact: true }).fill("Rascunho durante atualização automática.");
  const before = calls.queries.length;
  await page.clock.fastForward(60_100);
  await expect.poll(() => calls.queries.length).toBeGreaterThan(before);
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Sua mensagem", { exact: true })).toHaveValue("Rascunho durante atualização automática.");
  expect(calls.queries.every(query => !query.has("refresh"))).toBe(true);
  await page.getByRole("button", { name: "Alternar área de teste" }).click();
  const inactive = calls.queries.length; await page.clock.fastForward(120_000); expect(calls.queries.length).toBe(inactive);
});
