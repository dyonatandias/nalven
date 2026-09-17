"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DownloadLink } from "./download-link";
import { SUPPORT_CATEGORIES, SUPPORT_PRIORITIES, supportReplyInput, supportTicketInput, type SupportDetailData, type SupportListData, type SupportMessage, type SupportTicketSummary } from "@/lib/billing/support-data";
import styles from "./support-workspace.module.css";

type Query = { search: string; status: string; category: string; priority: string; sort: string; page: number };
type TicketInput = ReturnType<typeof supportTicketInput>;
type Intent =
  | { kind: "create"; commandId: string; payload: TicketInput }
  | { kind: "reply"; commandId: string; token: string; message: string }
  | { kind: "upload"; commandId: string; token: string; messageId: string; file: File };
type CommandError = { kind: Intent["kind"]; token?: string; message: string };
const EMPTY_QUERY: Query = { search: "", status: "", category: "", priority: "", sort: "updated_desc", page: 1 };
const ACCEPTED_FILES = ["application/pdf", "text/plain", "text/csv", "image/jpeg", "image/png", "image/webp"];
const FILE_LIMIT = 5 * 1024 * 1024;
const RetryWaitContext = createContext(0);

export function SupportWorkspace({ organizationId, active = true }: { organizationId: string; active?: boolean }) {
  return <SupportWorkspaceContent key={organizationId} organizationId={organizationId} active={active} />;
}

function SupportWorkspaceContent({ organizationId, active }: { organizationId: string; active: boolean }) {
  const [query, setQuery] = useState<Query>(EMPTY_QUERY);
  const [list, setList] = useState<SupportListData | null>(null);
  const [loadedQuery, setLoadedQuery] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [listRevision, setListRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [endingAttempt, setEndingAttempt] = useState(false);
  const [createVersion, setCreateVersion] = useState(0);
  const [replyVersion, setReplyVersion] = useState(0);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [uploadVersion, setUploadVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [commandError, setCommandError] = useState<CommandError | null>(null);
  const [retryWait, setRetryWait] = useState(0);
  const retryDeadline = useRef(0);
  const pendingRef = useRef<Intent | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const listRequest = useRef<AbortController | null>(null);
  const forceListRefresh = useRef(false);
  const detailRequest = useRef<AbortController | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const shouldFocusDetail = useRef(false);
  const queryKey = JSON.stringify(query);
  const listPending = listLoading || loadedQuery !== queryKey;
  const canWrite = list?.capabilities.canWrite === true;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listRequest.current?.abort(); detailRequest.current?.abort(); }; }, []);
  useEffect(() => {
    if (!retryWait) return;
    const timer = window.setInterval(() => setRetryWait(Math.max(0, Math.ceil((retryDeadline.current - Date.now()) / 1000))), 500);
    return () => clearInterval(timer);
  }, [retryWait]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    listRequest.current?.abort(); listRequest.current = controller;
    async function load() {
      setListLoading(true); setListError("");
      try {
        const params = new URLSearchParams({ resource: "list", page: String(query.page), pageSize: "20", search: query.search, status: query.status, category: query.category, priority: query.priority, sort: query.sort });
        if (forceListRefresh.current) { params.set("refresh", "1"); forceListRefresh.current = false; }
        const data = await readSupport<SupportListData>(await fetch(`/api/portal/support?${params}`, { cache: "no-store", headers: { "x-organization-id": organizationId }, signal: controller.signal }));
        if (controller.signal.aborted || listRequest.current !== controller) return;
        if (!Array.isArray(data.tickets) || !data.pagination || !data.capabilities || !data.summary || !data.facets) throw new Error("A lista de chamados retornou um formato inesperado.");
        setList(data); setLoadedQuery(queryKey);
      } catch (error) {
        if (controller.signal.aborted || listRequest.current !== controller) return;
        if (error instanceof SupportRequestError && [401, 403, 409].includes(error.status)) { setList(null); setDetail(null); setSelected(null); }
        setListError(failureMessage(error, "Não foi possível consultar os chamados. Verifique sua conexão."));
      } finally { if (!controller.signal.aborted && listRequest.current === controller) setListLoading(false); }
    }
    const timer = window.setTimeout(() => void load(), query.search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, organizationId, query, queryKey, listRevision]);

  useEffect(() => {
    if (!active || !selected) return;
    const controller = new AbortController();
    detailRequest.current?.abort(); detailRequest.current = controller;
    async function load() {
      setDetailLoading(true); setDetailError("");
      try {
        const params = new URLSearchParams({ resource: "detail", token: selected! });
        const data = await readSupport<SupportDetailData>(await fetch(`/api/portal/support?${params}`, { cache: "no-store", headers: { "x-organization-id": organizationId }, signal: controller.signal }));
        if (controller.signal.aborted || detailRequest.current !== controller) return;
        if (data.ticket?.token !== selected || !Array.isArray(data.ticket.messages) || !data.capabilities) throw new Error("Não foi possível confirmar o chamado solicitado.");
        setDetail(data);
      } catch (error) {
        if (controller.signal.aborted || detailRequest.current !== controller) return;
        if (error instanceof SupportRequestError && [401, 403, 409].includes(error.status)) { listRequest.current?.abort(); setListLoading(false); setList(null); setDetail(null); setSelected(null); setListError(error.message); }
        else if (error instanceof SupportRequestError && error.status === 404) setDetail(null);
        setDetailError(failureMessage(error, "Não foi possível abrir a conversa. Verifique sua conexão."));
      } finally { if (!controller.signal.aborted && detailRequest.current === controller) setDetailLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [active, selected, organizationId, detailRevision]);

  useEffect(() => {
    if (!active || !detail || !shouldFocusDetail.current) return;
    shouldFocusDetail.current = false;
    detailHeading.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width:760px)").matches) detailHeading.current?.scrollIntoView({ block: "start" });
  }, [active, detail]);

  useEffect(() => {
    if (!active) return;
    const refreshVisible = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || working.current) return;
      setListRevision(current => current + 1);
      if (selected) setDetailRevision(current => current + 1);
    };
    const timer = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("online", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { clearInterval(timer); window.removeEventListener("focus", refreshVisible); window.removeEventListener("online", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [active, selected]);

  function selectTicket(token: string) {
    if (token !== selected) { detailRequest.current?.abort(); setDetail(null); setDetailError(""); }
    shouldFocusDetail.current = true; setSelected(token);
  }
  function updateQuery(field: keyof Omit<Query, "page">, value: string) { forceListRefresh.current = false; setQuery(current => ({ ...current, [field]: value, page: 1 })); }
  function refresh() { forceListRefresh.current = true; setListRevision(current => current + 1); if (selected) setDetailRevision(current => current + 1); }
  function updateReplyDraft(token: string, message: string) {
    if (message && !replyDrafts[token] && Object.values(replyDrafts).filter(Boolean).length >= 20) { setNotice("Há 20 rascunhos de resposta abertos. Envie ou limpe um deles antes de escrever em outro chamado."); return; }
    setReplyDrafts(current => ({ ...current, [token]: message }));
  }

  async function runIntent(intent: Intent): Promise<boolean> {
    if (working.current || !active || Date.now() < retryDeadline.current) return false;
    // One immutable operation survives view changes and uncertain responses.
    if (pendingRef.current && pendingRef.current !== intent) return false;
    const retrying = pendingRef.current === intent;
    working.current = true; pendingRef.current = intent; setPending(intent); setBusy(true); setProgress(0); setCommandError(null); setNotice("");
    try {
      let result: { result?: { ticketToken?: string | null; messageId?: string | null } };
      if (intent.kind === "upload") result = await uploadSupportFile(intent, organizationId, value => { if (mounted.current) setProgress(value); });
      else {
        const payload = intent.kind === "create" ? { action: "ticket_create", commandId: intent.commandId, payload: intent.payload } : { action: "ticket_reply", commandId: intent.commandId, token: intent.token, message: intent.message };
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 45_000);
        try { result = await readSupport(await fetch("/api/portal/support", { method: "POST", headers: { "content-type": "application/json", "x-organization-id": organizationId }, body: JSON.stringify(payload), signal: controller.signal }), true); }
        finally { clearTimeout(timeout); }
      }
      if (!mounted.current) return false;
      pendingRef.current = null; setPending(null); setCommandError(null);
      // A confirmed mutation is never replayed merely because its refresh fails.
      setNotice(intent.kind === "create" ? "Chamado criado. A lista será atualizada." : intent.kind === "reply" ? "Resposta enviada. A conversa será atualizada." : "Anexo enviado. A conversa será atualizada.");
      if (intent.kind === "create") { setCreating(false); setCreateVersion(current => current + 1); if (result.result?.ticketToken) selectTicket(result.result.ticketToken); }
      else if (intent.kind === "reply") { setReplyDrafts(current => ({ ...current, [intent.token]: "" })); setReplyVersion(current => current + 1); }
      else setUploadVersion(current => current + 1);
      setListRevision(current => current + 1); setDetailRevision(current => current + 1);
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      const definitive = !retrying && error instanceof SupportRequestError && !error.retryable && [400, 401, 403, 404, 413, 415, 422].includes(error.status);
      if (definitive) { pendingRef.current = null; setPending(null); }
      if (error instanceof SupportRequestError && error.retryAfter > 0) { retryDeadline.current = Date.now() + error.retryAfter * 1000; setRetryWait(error.retryAfter); }
      if (error instanceof SupportRequestError && [401, 403, 409].includes(error.status)) {
        if (error.status !== 409 || !error.retryable) { setList(null); setDetail(null); setSelected(null); }
        setListRevision(current => current + 1); setDetailRevision(current => current + 1);
      }
      setCommandError({ kind: intent.kind, token: intent.kind !== "create" ? intent.token : undefined, message: failureMessage(error, "A conexão foi interrompida. O resultado do envio ainda não foi confirmado.") });
      return false;
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  function focusPending() {
    if (pending?.kind === "create") setCreating(true);
    else if (pending) selectTicket(pending.token);
  }
  function endAttempt() {
    if (working.current) return;
    pendingRef.current = null; setPending(null); setEndingAttempt(false); setCommandError(null);
    setNotice("Tentativa encerrada somente nesta página. Isso não cancela um envio já recebido pelo serviço. Confira o histórico antes de iniciar outro envio.");
  }
  const shownDetail = detail?.ticket.token === selected ? detail : null;
  const errorFor = (kind: Intent["kind"]) => commandError?.kind === kind && (kind === "create" || commandError.token === selected) ? commandError.message : "";

  return <RetryWaitContext.Provider value={retryWait}><section className={styles.workspace} data-detail={Boolean(selected)} aria-label="Central de suporte">
    <header className={styles.heading}><div><h2>Como podemos ajudar?</h2><p>Acompanhe seus chamados, converse com o atendimento e envie os documentos necessários em um só lugar.</p></div><div className={styles.actions}><button className={styles.button} type="button" disabled={listLoading || detailLoading} onClick={refresh}>Atualizar</button><button className={styles.primary} type="button" disabled={!canWrite || Boolean(pending)} onClick={() => { setCommandError(null); setCreating(true); }}>Novo chamado</button></div></header>
    {notice && <Feedback><span>{notice}</span><button className={styles.button} onClick={() => setNotice("")} type="button" aria-label="Fechar confirmação">Fechar</button></Feedback>}
    {list && !canWrite && <Feedback tone="neutral">Seu perfil permite consultar os chamados. Abrir chamados, responder e anexar arquivos exige permissão de escrita.</Feedback>}
    {pending && !busy && <Feedback tone="warning"><p>Há um envio sem confirmação. Os dados foram preservados; confirme o resultado antes de iniciar outro envio.</p><div className={styles.actions}><button className={styles.button} type="button" onClick={focusPending}>Ver envio pendente</button><RetryButton wait={retryWait} busy={busy} retry={() => void runIntent(pending)}>Confirmar envio</RetryButton><button className={styles.button} type="button" onClick={() => setEndingAttempt(true)}>Encerrar tentativa</button></div></Feedback>}
    {listError && <Feedback tone="error"><p>{listError}</p><button className={styles.button} type="button" onClick={() => setListRevision(current => current + 1)}>Tentar novamente</button></Feedback>}
    {!list ? <div className={styles.panel}>{listLoading || !listError ? <Loading>Consultando sua central de suporte…</Loading> : <Empty title="Suporte temporariamente indisponível">Não foi possível consultar os chamados. Seus dados não foram substituídos por uma lista vazia.</Empty>}</div> : <>
      <div className={styles.toolbar} role="search" aria-label="Filtrar chamados">
        <Field label="Buscar chamado" id="support-search"><input id="support-search" type="search" value={query.search} maxLength={200} placeholder="Assunto ou protocolo" onChange={event => updateQuery("search", event.target.value)} /></Field>
        <Filter label="Status" value={query.status} options={list.facets.statuses} change={value => updateQuery("status", value)} />
        <Filter label="Categoria" value={query.category} options={list.facets.categories} change={value => updateQuery("category", value)} />
        <Filter label="Prioridade" value={query.priority} options={list.facets.priorities} change={value => updateQuery("priority", value)} />
        <Field label="Ordenar por" id="support-sort"><select id="support-sort" value={query.sort} onChange={event => updateQuery("sort", event.target.value)}><option value="updated_desc">Atualizados recentemente</option><option value="created_desc">Mais recentes</option><option value="oldest">Mais antigos</option><option value="priority">Maior prioridade</option></select></Field>
      </div>
      <div className={styles.results}><p>{listPending ? "Atualizando resultados…" : `${list.pagination.total} resultado(s) nos ${list.summary.loaded} chamados recebidos do serviço`}</p>{Boolean(query.search || query.status || query.category || query.priority) && <button className={styles.button} type="button" onClick={() => setQuery(EMPTY_QUERY)}>Limpar filtros</button>}<div className={styles.counts} aria-label="Status no conjunto de chamados recebido">{Object.entries(list.summary.byStatus).map(([status, total]) => <button type="button" key={status} onClick={() => updateQuery("status", status)}>{label(status)} · {total}</button>)}</div></div>
      {(list.warning || list.pagination.partial) && <Feedback tone="warning">{list.warning || "A consulta contém apenas parte dos chamados disponíveis no serviço. A busca, os filtros e os contadores se referem aos chamados recebidos."}</Feedback>}
      <div className={styles.layout}>
        <section className={`${styles.panel} ${styles.listPanel}`} aria-label="Lista de chamados" aria-busy={listPending}>
          <div className={styles.panelHeading}><h3>Seus chamados</h3><small className={styles.hint}>{list.tickets.length} nesta página</small></div>
          {list.tickets.length ? <ul className={styles.tickets}>{list.tickets.map(ticket => <li key={ticket.token}><button className={styles.ticket} aria-pressed={selected === ticket.token} onClick={() => selectTicket(ticket.token)} type="button"><strong>{ticket.title}</strong><TicketBadges ticket={ticket} /><time dateTime={ticket.updatedAt || ticket.createdAt || undefined}>Atualização: {dateTime(ticket.updatedAt || ticket.createdAt)}</time></button></li>)}</ul> : <Empty title={query.search || query.status || query.category || query.priority ? "Nenhum resultado para estes filtros" : "Nenhum chamado encontrado"}>{query.search || query.status || query.category || query.priority ? "Altere ou limpe os filtros para consultar outros chamados." : "Quando precisar de ajuda, abra um chamado com o assunto e uma descrição do que aconteceu."}</Empty>}
          <footer className={styles.pager}><span>Página {list.pagination.page} de {Math.max(1, list.pagination.pages)}</span><div><button className={styles.button} disabled={listPending || list.pagination.page <= 1} onClick={() => setQuery(current => ({ ...current, page: list.pagination.page - 1 }))}>Anterior</button><button className={styles.button} disabled={listPending || !list.pagination.hasMore} onClick={() => setQuery(current => ({ ...current, page: list.pagination.page + 1 }))}>Próxima</button></div></footer>
        </section>
        <section className={`${styles.panel} ${styles.detailPanel}`} aria-label="Conversa do chamado" aria-busy={detailLoading}>
          {selected ? <>
            <div className={styles.panelHeading}><button className={styles.button} type="button" onClick={() => { detailRequest.current?.abort(); setSelected(null); setDetail(null); }}>Voltar à lista</button><button className={styles.button} type="button" disabled={detailLoading} onClick={() => setDetailRevision(current => current + 1)}>Atualizar conversa</button></div>
            {detailError && <div className={styles.composer}><Feedback tone="error"><p>{detailError}</p><button className={styles.button} type="button" onClick={() => setDetailRevision(current => current + 1)}>Tentar abrir novamente</button></Feedback></div>}
            {detailLoading && <Loading>Atualizando a conversa…</Loading>}
            {shownDetail && <>
              <header className={styles.detailHeader}><TicketBadges ticket={shownDetail.ticket} /><h3 tabIndex={-1} ref={detailHeading}>{shownDetail.ticket.title}</h3><div className={styles.detailDates}>{shownDetail.ticket.number && <span>Protocolo {shownDetail.ticket.number}</span>}<span>Criado em {dateTime(shownDetail.ticket.createdAt)}</span><span>Atualizado em {dateTime(shownDetail.ticket.updatedAt)}</span>{shownDetail.ticket.slaHours !== null && shownDetail.ticket.slaHours !== undefined && <span>SLA informado: {shownDetail.ticket.slaHours} horas{shownDetail.ticket.slaExceeded === true ? " · excedido segundo o serviço" : ""}</span>}</div></header>
              {shownDetail.ticket.description && <p className={styles.description}>{shownDetail.ticket.description}</p>}
              {shownDetail.ticket.messages.length ? <ol className={styles.conversation} aria-label="Mensagens do chamado">{orderedMessages(shownDetail.ticket.messages).map((message, index) => <li key={message.id || `message-${index}`} className={styles.message} data-author={message.authorType}><header><strong>{message.authorName} · {message.authorType === "client" ? "Cliente" : message.authorType === "support" ? "Atendimento" : "Sistema"}</strong><time dateTime={message.createdAt || undefined}>{dateTime(message.createdAt)}</time></header>{message.body && <p>{message.body}</p>}{message.attachments.length > 0 && <ul className={styles.attachments}>{message.attachments.map(file => <li key={file.id}><DownloadLink href={file.downloadUrl} organizationId={organizationId}>{file.name}</DownloadLink>{file.size !== null && <small>{fileSize(file.size)}</small>}</li>)}</ul>}</li>)}</ol> : <Empty title="Ainda não há mensagens públicas">As respostas do atendimento aparecerão aqui. A descrição inicial do chamado permanece acima.</Empty>}
              <ReplyForm key={`reply:${selected}:${replyVersion}`} message={pending?.kind === "reply" && pending.token === selected ? pending.message : replyDrafts[selected] || ""} change={message => updateReplyDraft(selected, message)} disabled={!shownDetail.capabilities.canReply || Boolean(pending)} readOnly={!shownDetail.capabilities.canReply} busy={busy && pending?.kind === "reply"} pending={pending?.kind === "reply" && pending.token === selected} error={errorFor("reply")} submit={message => runIntent({ kind: "reply", token: selected, commandId: crypto.randomUUID(), message })} retry={() => pending && void runIntent(pending)} />
              {shownDetail.capabilities.canAttach && <UploadForm key={`upload:${selected}:${uploadVersion}`} messages={orderedMessages(shownDetail.ticket.messages).filter(message => message.authorType === "client" && message.id && /^[1-9]\d*$/.test(message.id))} frozen={pending?.kind === "upload" && pending.token === selected ? pending : undefined} disabled={Boolean(pending)} busy={busy && pending?.kind === "upload"} progress={progress} pending={pending?.kind === "upload" && pending.token === selected} error={errorFor("upload")} submit={(messageId, file) => runIntent({ kind: "upload", token: selected, commandId: crypto.randomUUID(), messageId, file })} retry={() => pending && void runIntent(pending)} />}
            </>}
          </> : <Empty title="Selecione um chamado">Abra um item da lista para consultar a conversa, responder ou baixar anexos disponíveis.</Empty>}
        </section>
      </div>
      <p className={styles.hint}>Consultado em {dateTime(list.generatedAt)}. As informações vêm do serviço de atendimento; a página não altera status nem promete prazos de resposta.</p>
    </>}
    <CreateTicketDialog open={creating && active} onClose={() => setCreating(false)} version={createVersion} busy={busy && pending?.kind === "create"} disabled={!canWrite || Boolean(pending)} pending={pending?.kind === "create"} error={errorFor("create")} submit={payload => runIntent({ kind: "create", commandId: crypto.randomUUID(), payload })} retry={() => pending && void runIntent(pending)} />
    {pending && <EndAttemptDialog key={pending.commandId} open={endingAttempt && active} close={() => setEndingAttempt(false)} confirm={endAttempt} />}
  </section></RetryWaitContext.Provider>;
}

function ReplyForm({ message, change, disabled, readOnly, busy, pending, error, submit, retry }: { message: string; change: (message: string) => void; disabled: boolean; readOnly: boolean; busy: boolean; pending: boolean; error: string; submit: (message: string) => Promise<boolean>; retry: () => void }) {
  const [localError, setLocalError] = useState("");
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return;
    try { const input = supportReplyInput(message); setLocalError(""); await submit(input); }
    catch (reason) { setLocalError(failureMessage(reason, "Revise sua resposta.")); }
  }
  return <form className={styles.composer} onSubmit={send} aria-busy={busy}><h4>Responder ao chamado</h4>{readOnly ? <p className={styles.hint}>Este chamado está disponível para consulta. Seu perfil ou o estado informado pelo serviço não permite novas respostas.</p> : <><label htmlFor="support-reply">Sua mensagem</label><textarea id="support-reply" value={message} onChange={event => change(event.target.value)} maxLength={10000} disabled={disabled} required placeholder="Descreva a atualização ou responda ao atendimento." /><div className={styles.composerFooter}><small className={styles.hint}>{message.length.toLocaleString("pt-BR")} / 10.000 caracteres</small>{pending ? <RetryButton busy={busy} retry={retry}>Confirmar resposta enviada</RetryButton> : <button className={styles.primary} disabled={disabled || !message.trim()}>{busy ? "Enviando…" : "Enviar resposta"}</button>}</div></>}{(error || localError) && <Feedback tone="error">{error || localError}</Feedback>}</form>;
}

function UploadForm({ messages, frozen, disabled, busy, pending, progress, error, submit, retry }: { messages: SupportMessage[]; frozen?: Extract<Intent, { kind: "upload" }>; disabled: boolean; busy: boolean; pending: boolean; progress: number; error: string; submit: (messageId: string, file: File) => Promise<boolean>; retry: () => void }) {
  const [messageId, setMessageId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState("");
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return;
    if (!messageId || !messages.some(message => message.id === messageId)) return setLocalError("Selecione a mensagem à qual o arquivo será anexado.");
    if (!file) return setLocalError("Selecione um arquivo.");
    if (!ACCEPTED_FILES.includes(file.type)) return setLocalError("Formato não permitido. Use PDF, TXT, CSV, JPEG, PNG ou WebP.");
    if (file.size < 1 || file.size > FILE_LIMIT) return setLocalError("Selecione um arquivo não vazio de até 5 MB.");
    setLocalError(""); await submit(messageId, file);
  }
  const shownFile = frozen?.file || file;
  return <form className={styles.uploads} onSubmit={send} aria-busy={busy}><h4>Enviar anexo</h4><p className={styles.hint}>Escolha explicitamente a mensagem do cliente que receberá o arquivo. O anexo será vinculado a essa mensagem.</p><Field label="Anexar à mensagem" id="support-upload-message"><select id="support-upload-message" value={frozen?.messageId || messageId} disabled={disabled || !messages.length} onChange={event => setMessageId(event.target.value)} required><option value="">Selecione uma mensagem</option>{messages.map(message => <option value={message.id!} key={message.id}>{dateTime(message.createdAt)} · {message.body.slice(0, 100) || "Mensagem com anexo"}</option>)}</select></Field><Field label="Arquivo" id="support-upload-file"><input id="support-upload-file" type="file" accept={ACCEPTED_FILES.join(",")} disabled={disabled || !messages.length} onChange={event => { setFile(event.target.files?.[0] || null); setLocalError(""); }} required /></Field><p className={styles.hint}>Até 5 MB por arquivo: PDF, TXT, CSV, JPEG, PNG ou WebP. Não envie senhas ou dados desnecessários.</p>{shownFile && <p className={styles.hint}>{shownFile.name} · {fileSize(shownFile.size)}</p>}{busy && <><progress aria-label="Progresso do upload" max={100} value={progress} /><p className={styles.hint} role="status">{progress < 100 ? `Enviando arquivo: ${progress}%` : "Arquivo enviado. Aguardando validação e confirmação do serviço…"}</p></>}{(error || localError) && <Feedback tone="error">{error || localError}</Feedback>}{pending ? <RetryButton busy={busy} retry={retry}>Confirmar envio do anexo</RetryButton> : <button className={styles.button} disabled={disabled || !messages.length || !file || !messageId}>Enviar arquivo</button>}</form>;
}

function CreateTicketDialog({ open, onClose, version, busy, disabled, pending, error, submit, retry }: { open: boolean; onClose: () => void; version: number; busy: boolean; disabled: boolean; pending: boolean; error: string; submit: (payload: TicketInput) => Promise<boolean>; retry: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [localError, setLocalError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; element.showModal(); }
    else if (!open && element?.open) { element.close(); previousFocus.current?.focus({ preventScroll: true }); }
  }, [open]);
  useEffect(() => () => dialog.current?.close(), []);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return;
    try { const payload = supportTicketInput(Object.fromEntries(new FormData(event.currentTarget))); setLocalError(""); await submit(payload); }
    catch (reason) { setLocalError(failureMessage(reason, "Revise os dados do chamado.")); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="support-create-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header className={styles.dialogHeader}><div><h2 id="support-create-title">Novo chamado</h2><p>Conte o que aconteceu e como podemos ajudar.</p></div><button type="button" disabled={busy} onClick={onClose} aria-label="Fechar novo chamado">×</button></header><form key={version} className={styles.dialogForm} onSubmit={send} aria-busy={busy}><Field label="Assunto" id="support-create-title-field"><input id="support-create-title-field" name="titulo" minLength={5} maxLength={255} required disabled={disabled} placeholder="Resuma sua solicitação" /></Field><div className={styles.grid}><Field label="Categoria do chamado" id="support-create-category"><select id="support-create-category" name="categoria" defaultValue="duvida" disabled={disabled}>{SUPPORT_CATEGORIES.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></Field><Field label="Prioridade do chamado" id="support-create-priority"><select id="support-create-priority" name="prioridade" defaultValue="media" disabled={disabled}>{SUPPORT_PRIORITIES.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></Field></div><Field label="Descrição" id="support-create-description"><textarea id="support-create-description" name="descricao" minLength={10} maxLength={10000} required disabled={disabled} placeholder="Informe o que aconteceu, quando começou e o que você já tentou." /></Field><p className={styles.hint}>De 10 a 10.000 caracteres. Não inclua senhas. Após criar o chamado, os anexos poderão ser enviados quando houver uma mensagem disponível para vinculação.</p>{(error || localError) && <Feedback tone="error">{error || localError}</Feedback>}{pending && !busy && <Feedback tone="warning">O resultado do envio ainda não foi confirmado. Ao confirmar novamente, os mesmos dados e identificador serão utilizados.</Feedback>}<footer className={styles.dialogFooter}><button type="button" className={styles.button} disabled={busy} onClick={onClose}>Voltar</button>{pending ? <RetryButton busy={busy} retry={retry}>Confirmar chamado</RetryButton> : <button className={styles.primary} disabled={disabled}>{busy ? "Enviando…" : "Criar chamado"}</button>}</footer></form></dialog>;
}

function Field({ label: text, id, children }: { label: string; id: string; children: ReactNode }) { return <div className={styles.field}><label htmlFor={id}>{text}</label>{children}</div>; }
function EndAttemptDialog({ open, close, confirm }: { open: boolean; close: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; element.showModal(); }
    else if (!open && element?.open) { element.close(); previousFocus.current?.focus({ preventScroll: true }); }
  }, [open]);
  useEffect(() => () => dialog.current?.close(), []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="support-end-title" onCancel={event => { event.preventDefault(); close(); }}><header className={styles.dialogHeader}><h2 id="support-end-title">Encerrar tentativa pendente?</h2></header><div className={styles.dialogForm}><p>Esta ação encerra a tentativa apenas nesta página: ela não cancela um chamado, uma resposta ou um arquivo já recebido pelo serviço. Um novo envio poderá duplicar o anterior.</p><p>Primeiro atualize e confira o histórico do chamado. Em caso de dúvida, mantenha a tentativa e confirme usando o mesmo identificador.</p><label className={styles.confirmChoice}><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />Conferi o histórico e entendo que o envio anterior pode ter sido recebido.</label><footer className={styles.dialogFooter}><button className={styles.button} type="button" onClick={close}>Manter tentativa</button><button className={styles.primary} type="button" disabled={!acknowledged} onClick={confirm}>Encerrar após revisão</button></footer></div></dialog>;
}
function Filter({ label: text, value, options, change }: { label: string; value: string; options: string[]; change: (value: string) => void }) { const id = `support-filter-${text}`; return <Field label={text} id={id}><select id={id} value={value} onChange={event => change(event.target.value)}><option value="">Todos</option>{[...new Set([...options, ...(value ? [value] : [])])].map(option => <option key={option} value={option}>{label(option)}</option>)}</select></Field>; }
function Feedback({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "error" | "warning" | "neutral" }) { return <div className={`${styles.feedback} ${tone === "success" ? "" : styles[tone]}`} role={tone === "error" ? "alert" : "status"}>{children}</div>; }
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className={styles.empty}><h3>{title}</h3><p>{children}</p></div>; }
function Loading({ children }: { children: ReactNode }) { return <div className={styles.loading} role="status">{children}<span /><span /><span /></div>; }
function TicketBadges({ ticket }: { ticket: SupportTicketSummary }) { return <div className={styles.ticketMeta}>{ticket.number && <span>{ticket.number}</span>}<span className={styles.badge} data-tone={tone(ticket.status)}>{label(ticket.status)}</span><span>{label(ticket.category)}</span><span className={styles.badge} data-tone={ticket.priority === "urgente" ? "red" : ticket.priority === "alta" ? "amber" : undefined}>{label(ticket.priority)}</span></div>; }
function label(value: string) { return ({ aberto: "Aberto", open: "Aberto", em_andamento: "Em andamento", in_progress: "Em andamento", aguardando_cliente: "Aguardando cliente", aguardando_resposta: "Aguardando resposta", pending: "Pendente", resolvido: "Resolvido", resolved: "Resolvido", fechado: "Fechado", closed: "Fechado", cancelado: "Cancelado", pagamento: "Pagamento", tecnico: "Técnico", funcionalidade: "Funcionalidade", integracao: "Integração", duvida: "Dúvida", reclamacao: "Reclamação", sugestao: "Sugestão", outro: "Outro", baixa: "Baixa", media: "Média", alta: "Alta", urgente: "Urgente", unknown: "Não informado" } as Record<string, string>)[value] || value.replaceAll("_", " "); }
function tone(value: string) { return ["resolvido", "resolved", "fechado", "closed"].includes(value) ? "green" : ["aguardando_cliente", "aguardando_resposta", "pending"].includes(value) ? "amber" : "blue"; }
function dateTime(value: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone(), dateStyle: "short", timeStyle: "short" }) : "Não informada"; }
function fileSize(value: number) { return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB` : value >= 1024 ? `${(value / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB` : `${value} bytes`; }
function orderedMessages(messages: SupportMessage[]) { return messages.map((message, index) => ({ message, index, timestamp: message.createdAt ? Date.parse(message.createdAt) : NaN })).sort((left, right) => (Number.isFinite(left.timestamp) ? left.timestamp : Infinity) - (Number.isFinite(right.timestamp) ? right.timestamp : Infinity) || left.index - right.index).map(item => item.message); }
class SupportRequestError extends Error { constructor(message: string, readonly status: number, readonly retryable = false, readonly retryAfter = 0) { super(message); } }
function retrySeconds(value: string | null) { if (!value) return 0; const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000); return Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
async function readSupport<T>(response: Response, requireAcknowledgement = false): Promise<T> {
  const retryAfter = retrySeconds(response.headers.get("retry-after"));
  let body: unknown;
  try { body = await response.json(); } catch { throw new SupportRequestError("O serviço retornou uma resposta inesperada. O resultado ainda não foi confirmado.", response.status, true, retryAfter); }
  if (!response.ok) throw new SupportRequestError(isRecord(body) && typeof body.error === "string" ? body.error : "Não foi possível concluir a solicitação.", response.status, isRecord(body) && body.retryable === true, retryAfter);
  if (!isRecord(body) || (requireAcknowledgement && body.ok !== true)) throw new SupportRequestError("O serviço não confirmou o resultado do envio. Consulte o histórico ou confirme novamente com os mesmos dados.", response.status, true, retryAfter);
  return body as T;
}
function RetryButton({ children, busy, retry, wait }: { children: ReactNode; busy: boolean; retry: () => void; wait?: number }) { const contextWait = useContext(RetryWaitContext); const seconds = wait ?? contextWait; return <button className={styles.primary} type="button" disabled={busy || seconds > 0} onClick={retry}>{busy ? "Confirmando…" : seconds > 0 ? `Aguarde ${seconds}s para confirmar` : children}</button>; }
function failureMessage(error: unknown, fallback: string) { return error instanceof Error && error.name !== "TypeError" ? error.message : fallback; }
function uploadSupportFile(intent: Extract<Intent, { kind: "upload" }>, organizationId: string, progress: (value: number) => void): Promise<Record<string, never>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/portal/billing/files"); xhr.setRequestHeader("x-organization-id", organizationId); xhr.timeout = 120_000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.min(100, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      const retryAfter = retrySeconds(xhr.getResponseHeader("retry-after"));
      let body: unknown;
      try { body = JSON.parse(xhr.responseText); } catch { reject(new SupportRequestError("Não foi possível confirmar o recebimento do arquivo.", xhr.status, true, retryAfter)); return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (isRecord(body) && body.ok === true) resolve({});
        else reject(new SupportRequestError("O serviço não confirmou o recebimento do arquivo. Confirme novamente com os mesmos dados.", xhr.status, true, retryAfter));
      } else reject(new SupportRequestError(isRecord(body) && typeof body.error === "string" ? body.error : "Não foi possível enviar o anexo.", xhr.status, isRecord(body) && body.retryable === true, retryAfter));
    };
    xhr.onerror = () => reject(new Error("A conexão foi interrompida. Confirme o resultado antes de enviar outro arquivo."));
    xhr.ontimeout = () => reject(new Error("O serviço demorou para confirmar o arquivo. Confirme novamente com os mesmos dados."));
    xhr.onabort = () => reject(new Error("O envio foi interrompido antes da confirmação."));
    const form = new FormData(); form.set("file", intent.file); form.set("ticketToken", intent.token); form.set("messageId", intent.messageId); form.set("commandId", intent.commandId); xhr.send(form);
  });
}
