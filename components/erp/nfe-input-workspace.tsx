"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ErpModal } from "@/components/erp/modal-portal";
import { DfeInbox } from "@/components/erp/dfe-inbox";
import styles from "./nfe-input-workspace.module.css";

type Product = { id: number; name: string; sku: string; barcode?: string | null; unit: string; stock: number; cost: number; onboardingStatus?: string; onboardingMissingFields?: string[] };
type Warehouse = { id: number; code: string; name: string; branch?: { name: string } | null };
type InvoiceItem = {
  id: number; itemNumber: number; supplierCode?: string | null; description: string;
  barcode?: string | null; ncm?: string | null; cfop?: string | null; unit: string;
  quantity: number; unitCost: number; total: number; productId?: number | null;
  matchSource?: string | null; matchConfidence?: number | null; matchReason?: string | null;
  product?: { id: number; name: string; sku: string; unit: string; stock: number; onboardingStatus?: string; onboardingMissingFields?: string[] } | null;
};
type Invoice = {
  id: number; accessKey: string; number: string; series: string; status: "imported" | "matched" | "received";
  source?: string; branchId?: number | null; supplierId?: number | null;
  supplierDocument: string; supplierName: string; issueDate: string; total: number;
  warehouseId?: number | null; dueAt?: string | null; importedBy: string; receivedAt?: string | null;
  createdAt: string; updatedAt: string; warehouse?: { id: number; code: string; name: string } | null;
  items: InvoiceItem[];
};
type Catalog = {
  items: Invoice[]; products: Product[]; warehouses: Warehouse[];
  summary: { total: number; pending: number; ready: number; received: number; totalValue: number };
  pagination: { page: number; limit: number; total: number; pages: number };
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 });
const shortDate = tenantDateTimeFormatter();
const dateTime = tenantDateTimeFormatter({ dateStyle: "short", timeStyle: "short" });
const MAX_XML_BYTES = 5_000_000;

export function NfeInputWorkspace() {
  const [view, setView] = useState<"detected" | "entries">("entries");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number>();
  const [data, setData] = useState<Catalog>();
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({ page: String(page), limit: "20" });
      if (selectedInvoiceId) parameters.set("invoiceId", String(selectedInvoiceId));
      if (appliedQuery) parameters.set("search", appliedQuery);
      if (status) parameters.set("status", status);
      const response = await fetch(`/api/erp/invoices?${parameters}`, { cache: "no-store" });
      const body = await response.json() as Catalog & { error?: string };
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar as notas fiscais.");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar as notas fiscais.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [appliedQuery, page, selectedInvoiceId, status]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  function chooseFile(candidate?: File) {
    setError("");
    setNotice("");
    if (!candidate) { setFile(undefined); return; }
    if (!candidate.name.toLowerCase().endsWith(".xml") && !["text/xml", "application/xml"].includes(candidate.type)) {
      setError("Selecione o XML autorizado da NF-e.");
      return;
    }
    if (!candidate.size || candidate.size > MAX_XML_BYTES) {
      setError("O XML deve ter conteúdo e no máximo 5 MB.");
      return;
    }
    setFile(candidate);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setError("Selecione o XML da NF-e antes de importar."); return; }
    const succeeded = await command({ action: "import", xml: await file.text() }, "NF-e importada e validada. Confira os vínculos antes do recebimento.", "import");
    if (succeeded) {
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
      setStatus("");
      setAppliedQuery("");
      setQuery("");
      setPage(1);
    }
  }

  async function command(payload: Record<string, unknown>, success: string, actionKey: string) {
    setBusyAction(actionKey);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/erp/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Não foi possível concluir a operação.");
      setNotice(success);
      await load(true);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível concluir a operação.");
      return false;
    } finally { setBusyAction(""); }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedQuery(query.trim());
  }

  if (loading && !data) return <LoadingState />;
  if (!data) return <ErrorState message={error} retry={() => void load()} />;

  return (
    <div className={styles.workspace}>
      <nav className={styles.workspaceTabs} aria-label="Áreas da entrada fiscal">
        <button className={view === "detected" ? styles.activeTab : ""} onClick={() => setView("detected")} aria-current={view === "detected" ? "page" : undefined}><span aria-hidden="true">⌁</span><b>Caixa fiscal</b><small>Documentos detectados</small></button>
        <button className={view === "entries" ? styles.activeTab : ""} onClick={() => { setSelectedInvoiceId(undefined); setView("entries"); }} aria-current={view === "entries" ? "page" : undefined}><span aria-hidden="true">✓</span><b>Entradas e conferência</b><small>{data.summary.pending + data.summary.ready > 0 ? `${data.summary.pending + data.summary.ready} aguardando validação` : "Produtos, estoque e financeiro"}</small></button>
      </nav>
      {view === "detected" ? <DfeInbox openEntries={(invoiceId) => { setSelectedInvoiceId(invoiceId); setQuery(""); setAppliedQuery(""); setStatus(""); setPage(1); setView("entries"); }} /> : <>
      {selectedInvoiceId && <section className={styles.focusedEntry} role="status"><span><strong>Entrada #{selectedInvoiceId} pronta para validação</strong><small>Confira os produtos e confirme o recebimento para movimentar estoque, custo e financeiro.</small></span><button type="button" onClick={() => setSelectedInvoiceId(undefined)}>Ver todas as entradas</button></section>}
      <section className={styles.hero} aria-labelledby="nfe-title">
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>RECEBIMENTO FISCAL E OPERACIONAL</span>
          <h2 id="nfe-title">Entrada por NF-e</h2>
          <p>Importe o XML autorizado, confira os vínculos e reconheça estoque, custo e contas a pagar em uma única operação auditável.</p>
          <ol className={styles.flow} aria-label="Etapas do recebimento">
            <li><b>1</b><span><strong>Importar</strong><small>XML validado</small></span></li>
            <li><b>2</b><span><strong>Conferir</strong><small>Produto por item</small></span></li>
            <li><b>3</b><span><strong>Receber</strong><small>Estoque e financeiro</small></span></li>
          </ol>
        </div>
        <form className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`} onSubmit={upload}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}>
          <input ref={fileInput} id="nfe-xml" type="file" accept=".xml,text/xml,application/xml" onChange={(event) => chooseFile(event.target.files?.[0])} />
          <label htmlFor="nfe-xml">
            <span className={styles.uploadIcon} aria-hidden="true">XML</span>
            <strong>{file ? file.name : "Selecione ou arraste o XML"}</strong>
            <small>{file ? `${formatBytes(file.size)} · pronto para validar` : "Somente XML autorizado · máximo de 5 MB"}</small>
          </label>
          {file && <button type="button" className={styles.clearFile} onClick={() => chooseFile()} aria-label="Remover arquivo selecionado">Remover</button>}
          <button className={styles.importButton} disabled={!file || Boolean(busyAction)}>{busyAction === "import" ? "Validando XML…" : "Importar e validar"}</button>
          <p>O XML fica protegido no banco da organização e não é devolvido pela API.</p>
        </form>
      </section>

      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
        {error && <div className={styles.error}><span aria-hidden="true">!</span><p>{error}</p><button onClick={() => setError("")} aria-label="Fechar mensagem de erro">×</button></div>}
        {notice && <div className={styles.notice}><span aria-hidden="true">✓</span><p>{notice}</p><button onClick={() => setNotice("")} aria-label="Fechar confirmação">×</button></div>}
      </div>

      <section className={styles.metrics} aria-label="Resumo das notas fiscais">
        <Metric label="Total importado" value={String(data.summary.total)} detail={currency.format(data.summary.totalValue)} tone="neutral" />
        <Metric label="Exigem conferência" value={String(data.summary.pending)} detail="Itens ainda sem vínculo" tone={data.summary.pending ? "warning" : "success"} />
        <Metric label="Prontas para receber" value={String(data.summary.ready)} detail="Conferência concluída" tone={data.summary.ready ? "info" : "neutral"} />
        <Metric label="Recebidas" value={String(data.summary.received)} detail="Estoque e título gerados" tone="success" />
      </section>

      <section className={styles.listPanel} aria-labelledby="nfe-list-title">
        <header className={styles.listHeader}>
          <div><span className={styles.eyebrow}>FILA DE ENTRADA</span><h3 id="nfe-list-title">Notas fiscais</h3><p>{data.pagination.total} registro{data.pagination.total === 1 ? "" : "s"} no filtro atual</p></div>
          <button className={styles.refreshButton} onClick={() => void load(true)} disabled={refreshing || Boolean(busyAction)}><span aria-hidden="true">↻</span>{refreshing ? "Atualizando…" : "Atualizar"}</button>
        </header>
        <form className={styles.filters} onSubmit={search} role="search">
          <label className={styles.searchField}><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="Fornecedor, CNPJ, número ou chave de acesso" aria-label="Buscar notas fiscais" /><button>Buscar</button></label>
          <label><span>Status</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">Todos os status</option><option value="imported">Exigem conferência</option><option value="matched">Prontas para receber</option><option value="received">Recebidas</option></select></label>
          {(appliedQuery || status) && <button type="button" className={styles.clearFilters} onClick={() => { setQuery(""); setAppliedQuery(""); setStatus(""); setPage(1); }}>Limpar filtros</button>}
        </form>

        {data.items.length ? <div className={styles.invoiceList}>{data.items.map((invoice) => <InvoiceCard key={`${invoice.id}:${invoice.updatedAt}`} invoice={invoice} products={data.products} warehouses={data.warehouses} busyAction={busyAction} command={command} notify={setNotice} />)}</div> : <EmptyState filtered={Boolean(appliedQuery || status)} clear={() => { setQuery(""); setAppliedQuery(""); setStatus(""); setPage(1); }} />}

        {data.pagination.pages > 1 && <nav className={styles.pagination} aria-label="Paginação das notas fiscais"><button disabled={page <= 1 || refreshing} onClick={() => setPage((current) => Math.max(1, current - 1))}>Anterior</button><span>Página <strong>{data.pagination.page}</strong> de {data.pagination.pages}</span><button disabled={page >= data.pagination.pages || refreshing} onClick={() => setPage((current) => Math.min(data.pagination.pages, current + 1))}>Próxima</button></nav>}
      </section>
      </>}
    </div>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "neutral" | "warning" | "info" | "success" }) {
  return <article className={`${styles.metric} ${styles[tone]}`}><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div><i aria-hidden="true" /></article>;
}

function InvoiceCard({ invoice, products, warehouses, busyAction, command, notify }: {
  invoice: Invoice; products: Product[]; warehouses: Warehouse[]; busyAction: string;
  command: (payload: Record<string, unknown>, success: string, actionKey: string) => Promise<boolean>;
  notify: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(invoice.status !== "received");
  const [receiving, setReceiving] = useState(false);
  const [links, setLinks] = useState<Record<number, string>>(() => Object.fromEntries(invoice.items.map((item) => [item.id, String(item.productId || "")])));
  const missing = invoice.items.filter((item) => !links[item.id]).length;
  const dirty = invoice.items.some((item) => String(item.productId || "") !== links[item.id]);
  const actionKey = `invoice:${invoice.id}`;
  const busy = busyAction === actionKey;
  const linkedPercent = Math.round((invoice.items.length - missing) / invoice.items.length * 100);

  async function saveLinks() {
    await command({ action: "match", invoiceId: invoice.id, items: invoice.items.map((item) => ({ itemId: item.id, productId: Number(links[item.id]) })) }, "Conferência salva. A NF-e está pronta para recebimento.", actionKey);
  }

  async function copyKey() {
    try { await navigator.clipboard.writeText(invoice.accessKey); notify("Chave de acesso copiada."); }
    catch { notify(`Chave de acesso: ${invoice.accessKey}`); }
  }

  return (
    <article className={`${styles.invoiceCard} ${styles[invoice.status]}`}>
      <header className={styles.invoiceHeader}>
        <button className={styles.expandButton} onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={`invoice-${invoice.id}-body`}>
          <span className={styles.chevron} aria-hidden="true">{expanded ? "⌄" : "›"}</span>
          <span className={styles.invoiceIdentity}><small>NF-e {invoice.number}/{invoice.series}</small><strong>{invoice.supplierName}</strong><em>{formatDocument(invoice.supplierDocument)}</em></span>
        </button>
        <div className={styles.invoiceHeadline}>
          <span><small>Emissão</small><strong>{shortDate.format(new Date(invoice.issueDate))}</strong></span>
          <span><small>Itens</small><strong>{invoice.items.length}</strong></span>
          <span><small>Valor</small><strong>{currency.format(invoice.total)}</strong></span>
          <Status status={invoice.status} />
        </div>
      </header>
      {expanded && <div id={`invoice-${invoice.id}-body`}>
        <div className={styles.progressBlock}>
          <div><span><strong>{invoice.status === "received" ? "Processo concluído" : missing ? `${missing} item${missing === 1 ? "" : "s"} sem vínculo` : dirty ? "Alterações ainda não salvas" : "Conferência concluída"}</strong><small>{invoice.status === "received" ? `Recebida em ${invoice.receivedAt ? dateTime.format(new Date(invoice.receivedAt)) : "data não informada"}` : `${invoice.items.length - missing} de ${invoice.items.length} itens vinculados`}</small></span><b>{invoice.status === "received" ? 100 : linkedPercent}%</b></div>
          <div className={styles.progressTrack}><i style={{ width: `${invoice.status === "received" ? 100 : linkedPercent}%` }} /></div>
        </div>

        <div className={styles.itemTable} role="table" aria-label={`Itens da NF-e ${invoice.number}`}>
          <div className={styles.itemHead} role="row"><span role="columnheader">Item do fornecedor</span><span role="columnheader">Dados fiscais</span><span role="columnheader">Quantidade e custo</span><span role="columnheader">Produto no ERP</span></div>
          {invoice.items.map((item) => <div className={styles.itemRow} role="row" key={item.id}>
            <span className={styles.itemDescription} role="cell"><i>{item.itemNumber}</i><span><strong>{item.description}</strong><small>{item.supplierCode || "Sem código do fornecedor"}{item.barcode ? ` · GTIN ${item.barcode}` : ""}</small></span></span>
            <span className={styles.taxData} role="cell"><small>NCM <b>{item.ncm || "—"}</b></small><small>CFOP <b>{item.cfop || "—"}</b></small></span>
            <span className={styles.amountData} role="cell"><strong>{number.format(item.quantity)} {item.unit}</strong><small>{currency.format(item.unitCost)} por unidade</small><b>{currency.format(item.total)}</b></span>
            <span role="cell">{invoice.status === "received" ? <span className={styles.matchedProduct}><i aria-hidden="true">✓</i><span><strong>{item.product?.name || "Produto removido"}</strong><small>{item.product?.sku || "Vínculo histórico"}{item.product?.onboardingStatus === "pending" ? " · cadastro pendente" : ""}</small></span></span> : <div className={styles.productCell}><ProductPicker value={links[item.id] || ""} selected={item.product || undefined} initial={products} onChange={(value) => setLinks((current) => ({ ...current, [item.id]: value }))} />{item.matchConfidence && links[item.id] && <small className={styles.matchHint}>Sugestão {item.matchConfidence}% · {item.matchReason}</small>}{!links[item.id] && <button className={styles.createProduct} disabled={Boolean(busyAction)} onClick={() => void command({ action: "create_product", itemId: item.id }, "Produto criado como rascunho e vinculado. Complete foto, preço e cadastro antes de publicar.", actionKey)}>+ Criar produto deste item</button>}</div>}</span>
          </div>)}
        </div>

        <footer className={styles.invoiceFooter}>
          <div className={styles.auditData}><span><small>Origem / responsável</small><strong>{invoice.source === "sefaz_nfe" ? "SEFAZ · " : invoice.source === "nfse_adn" ? "ADN · " : "XML · "}{invoice.importedBy}</strong></span><span><small>Chave de acesso protegida</small><button onClick={() => void copyKey()}>{invoice.accessKey.slice(0, 8)}…{invoice.accessKey.slice(-8)} <b>Copiar</b></button></span>{invoice.warehouse && <span><small>Destino</small><strong>{invoice.warehouse.code} · {invoice.warehouse.name}</strong></span>}</div>
          {invoice.status !== "received" && <div className={styles.cardActions}>
            <button className={styles.secondaryButton} onClick={() => setExpanded(false)}>Recolher</button>
            <button className={styles.saveButton} disabled={busy || Boolean(busyAction) || missing > 0 || !dirty} onClick={() => void saveLinks()}>{busy ? "Salvando…" : dirty ? "Salvar conferência" : "Conferência salva"}</button>
            {invoice.status === "matched" && !dirty && <button className={styles.receiveButton} disabled={Boolean(busyAction) || !warehouses.length} onClick={() => setReceiving(true)}>Receber NF-e</button>}
          </div>}
        </footer>
      </div>}
      {receiving && <ReceiveDialog invoice={invoice} warehouses={warehouses} busy={busy} close={() => setReceiving(false)} submit={async (warehouseId, dueAt) => {
        const ok = await command({ action: "receive", invoiceId: invoice.id, warehouseId, dueAt }, "NF-e recebida. Estoque, custo médio e conta a pagar foram atualizados.", actionKey);
        if (ok) setReceiving(false);
      }} />}
    </article>
  );
}

function ProductPicker({ value, selected, initial, onChange }: { value: string; selected?: InvoiceItem["product"]; initial: Product[]; onChange: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Product[]>(initial);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function updateQuery(next: string) {
    setQuery(next);
    if (timer.current) clearTimeout(timer.current);
    if (next.trim().length < 2) { setOptions(initial); setSearching(false); return; }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/erp/invoices?productSearch=${encodeURIComponent(next.trim())}`, { cache: "no-store" });
        const body = await response.json() as { products?: Product[] };
        if (response.ok && body.products) setOptions(body.products);
      } finally { setSearching(false); }
    }, 280);
  }

  const selectedOption = selected ? { ...selected, barcode: null, cost: 0 } : undefined;
  const available = selectedOption && !options.some((product) => product.id === selectedOption.id) ? [selectedOption, ...options] : options;
  return <div className={`${styles.productPicker} ${!value ? styles.unmatched : ""}`}><label><span className={styles.srOnly}>Buscar produto no ERP</span><input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Buscar por nome, SKU ou GTIN" /></label><select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Produto correspondente no ERP"><option value="">{searching ? "Buscando produtos…" : "Selecione o produto correspondente"}</option>{available.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku} · saldo {number.format(product.stock)} {product.unit}</option>)}</select></div>;
}

function ReceiveDialog({ invoice, warehouses, busy, close, submit }: { invoice: Invoice; warehouses: Warehouse[]; busy: boolean; close: () => void; submit: (warehouseId: number, dueAt: string) => Promise<void> }) {
  const [warehouse, setWarehouse] = useState(String(invoice.warehouseId || warehouses[0]?.id || ""));
  const [dueAt, setDueAt] = useState(defaultDueDate(invoice.issueDate));
  async function confirm(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await submit(Number(warehouse), dueAt); }
  return <ErpModal close={busy ? () => undefined : close} label={`Confirmar recebimento da NF-e ${invoice.number}`} className={styles.modalLayer}>
    <form className={styles.receiveDialog} onSubmit={confirm}>
      <header><div><span className={styles.eyebrow}>CONFIRMAÇÃO IRREVERSÍVEL</span><h2>Receber NF-e {invoice.number}/{invoice.series}</h2><p>Revise o destino e o vencimento. A confirmação gera efeitos contábeis e de estoque.</p></div><button type="button" onClick={close} disabled={busy} aria-label="Fechar">×</button></header>
      <div className={styles.receiveSummary}><span><small>Fornecedor</small><strong>{invoice.supplierName}</strong></span><span><small>Itens</small><strong>{invoice.items.length}</strong></span><span><small>Total</small><strong>{currency.format(invoice.total)}</strong></span></div>
      <div className={styles.receiveFields}><label>Depósito de entrada<select value={warehouse} onChange={(event) => setWarehouse(event.target.value)} required><option value="">Selecione o depósito</option>{warehouses.map((item) => <option value={item.id} key={item.id}>{item.code} · {item.name}{item.branch?.name ? ` · ${item.branch.name}` : ""}</option>)}</select><small>Todos os itens desta nota entrarão no mesmo depósito.</small></label><label>Vencimento da conta a pagar<input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} required /><small>Confirme com a condição negociada com o fornecedor.</small></label></div>
      <section className={styles.impacts}><h3>Esta ação irá</h3><ul><li><i>✓</i>Somar as quantidades ao depósito selecionado</li><li><i>✓</i>Atualizar o estoque global e o custo médio ponderado</li><li><i>✓</i>Criar uma conta a pagar vinculada à NF-e</li><li><i>✓</i>Registrar usuário, horário e correlação na auditoria</li></ul></section>
      <footer><button type="button" onClick={close} disabled={busy}>Voltar e revisar</button><button className={styles.receiveButton} disabled={busy || !warehouse || !dueAt}>{busy ? "Processando recebimento…" : "Confirmar recebimento"}</button></footer>
    </form>
  </ErpModal>;
}

function Status({ status }: { status: Invoice["status"] }) {
  const label = status === "imported" ? "Conferir" : status === "matched" ? "Pronta" : "Recebida";
  return <em className={`${styles.status} ${styles[status]}`}><i aria-hidden="true" />{label}</em>;
}
function EmptyState({ filtered, clear }: { filtered: boolean; clear: () => void }) { return <div className={styles.empty}><span aria-hidden="true">NF</span><h3>{filtered ? "Nenhuma NF-e corresponde aos filtros" : "Nenhuma NF-e importada"}</h3><p>{filtered ? "Ajuste a busca ou limpe os filtros para visualizar toda a fila." : "Use a área de importação acima para iniciar o primeiro recebimento fiscal."}</p>{filtered && <button onClick={clear}>Limpar filtros</button>}</div>; }
function LoadingState() { return <div className={styles.loading} aria-live="polite"><span /><div><b /><i /><i /></div><div><b /><i /><i /></div><p>Carregando a fila de entrada…</p></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className={styles.empty} role="alert"><span aria-hidden="true">!</span><h3>Não foi possível abrir a Entrada por NF-e</h3><p>{message}</p><button onClick={retry}>Tentar novamente</button></div>; }
function formatDocument(value: string) { return value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"); }
function formatBytes(value: number) { return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1).replace(".", ",")} MB`; }
function defaultDueDate(issueDate: string) { const issue = new Date(issueDate), today = new Date(); issue.setUTCDate(issue.getUTCDate() + 30); const candidate = issue.getTime() > today.getTime() ? issue : today; return candidate.toISOString().slice(0, 10); }
