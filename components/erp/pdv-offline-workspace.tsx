"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PdvAccessibleModal } from "@/components/erp/pdv-accessible-modal";
import { PosOfflineVault, type OfflineStatus, type PosOfflineQueueIssue } from "@/lib/erp/pos-offline-client";
import styles from "./pdv-offline-workspace.module.css";

type Terminal = { id: string; code: string; name: string; status: string; registerId: number };
type Credential = { id: string; terminalId: string; state: string; expiresAt: string };
type Configuration = { organizationId: string; terminals: Terminal[]; credentials: Credential[] };
type QueueItem = { operationId: string; sequence: number; type: string; state: string; error: PosOfflineQueueIssue | null };
const EMPTY: OfflineStatus = { configured: false, unlocked: false, expiresAt: null, queued: 0, rejected: 0, conflicts: 0, catalogVersion: null, permissionVersion: null, lastPullCursor: "0" };

export function PdvOfflineWorkspace({ embedded = false }: { embedded?: boolean }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [terminalId, setTerminalId] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState(240);
  const [online, setOnline] = useState(true);
  const [status, setStatus] = useState(EMPTY);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [catalogCount, setCatalogCount] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const purgeTriggerRef = useRef<HTMLButtonElement>(null);
  const [draftId, setDraftId] = useState("");
  const [revision, setRevision] = useState(0);
  const [productId, setProductId] = useState("");
  const [variationId, setVariationId] = useState("");
  const [quantity, setQuantity] = useState("1");

  const organizationId = configuration?.organizationId || "";
  const vault = useMemo(() => organizationId && terminalId ? new PosOfflineVault(PosOfflineVault.scope(organizationId, terminalId)) : null, [organizationId, terminalId]);

  const refreshLocal = useCallback(async (active = vault) => {
    if (!active) { setStatus(EMPTY); setQueue([]); return; }
    const nextStatus = await active.status();
    setStatus(nextStatus);
    setQueue(await active.queue());
    const catalog = nextStatus.unlocked ? await active.snapshot<unknown[]>("catalog").catch(() => null) : null;
    setCatalogCount(Array.isArray(catalog?.data) ? catalog.data.length : 0);
  }, [vault]);

  const loadConfiguration = useCallback(async () => {
    if (!navigator.onLine) return;
    const response = await fetch("/api/erp/pdv/offline-credentials", { cache: "no-store" });
    const value = await response.json() as Configuration & { error?: string };
    if (!response.ok) throw new Error(value.error || "Não foi possível consultar os terminais.");
    setConfiguration(value);
    setTerminalId(current => current || value.terminals[0]?.id || "");
    setDraftId(current => current || crypto.randomUUID());
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    queueMicrotask(update);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/pos-sw.js", { scope: "/erp/" }).catch(() => setError("O service worker não pôde ser ativado neste navegador."));
    const timer = window.setTimeout(() => { loadConfiguration().catch(caught => setError(message(caught))); }, 0);
    return () => { window.clearTimeout(timer); window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, [loadConfiguration]);

  useEffect(() => { const timer = window.setTimeout(() => { refreshLocal().catch(caught => setError(message(caught))); }, 0); return () => window.clearTimeout(timer); }, [refreshLocal]);

  async function provision(event: FormEvent) {
    event.preventDefault();
    if (!configuration || !vault || !terminalId) return;
    await run(async () => {
      if (!online) throw new Error("A emissão da credencial exige conexão online.");
      const response = await fetch("/api/erp/pdv/offline-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "credential.issue", terminalId, ttlMinutes, idempotencyKey: `offline.issue:${crypto.randomUUID()}` }) });
      const value = await response.json() as { error?: string; token?: string; credential?: Credential };
      if (!response.ok || !value.token || !value.credential) throw new Error(value.error || "A credencial curta não foi emitida.");
      await vault.initialize(passphrase, { organizationId: configuration.organizationId, terminalId, credentialId: value.credential.id, token: value.token, expiresAt: value.credential.expiresAt });
      setPassphrase("");
      await vault.sync();
      await loadConfiguration();
      await refreshLocal(vault);
      setNotice("Cofre criado, credencial cifrada e snapshots iniciais sincronizados.");
    });
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!vault) return;
    await run(async () => { await vault.unlock(passphrase); setPassphrase(""); await refreshLocal(vault); setNotice("Cofre desbloqueado somente na memória desta aba."); });
  }

  async function synchronize() {
    if (!vault) return;
    await run(async () => { if (!online) throw new Error("Sem conexão: a fila permanece cifrada no dispositivo."); await vault.sync(); await refreshLocal(vault); setNotice("Push, pull e ACK concluídos."); });
  }

  async function queueHeartbeat() {
    if (!vault) return;
    await run(async () => { await vault.enqueue("terminal.heartbeat", { appVersion: "pwa-1", queueDepth: status.queued }); await refreshLocal(vault); setNotice("Heartbeat incluído na fila autenticada."); });
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!vault) return;
    await run(async () => {
      const numericProduct = Number(productId), numericQuantity = Number(quantity);
      if (!Number.isSafeInteger(numericProduct) || numericProduct < 1 || !Number.isFinite(numericQuantity) || numericQuantity <= 0) throw new Error("Produto e quantidade devem ser válidos.");
      const nextRevision = revision + 1;
      await vault.enqueue("cart.draft.upsert", { draftId, baseRevision: revision, revision: nextRevision, customerId: null, items: [{ lineId: crypto.randomUUID(), productId: numericProduct, variationId: variationId ? Number(variationId) : null, quantityMicros: String(Math.round(numericQuantity * 1_000_000)) }] });
      setRevision(nextRevision); await refreshLocal(vault); setNotice("Rascunho salvo localmente. Preço e estoque serão revalidados online.");
    });
  }

  async function discardDraft() {
    if (!vault) return;
    await run(async () => { const nextRevision = revision + 1; await vault.enqueue("cart.draft.discard", { draftId, baseRevision: revision, revision: nextRevision }); setRevision(nextRevision); await refreshLocal(vault); setNotice("Tombstone do rascunho incluído na fila."); });
  }

  async function purge() {
    if (!vault) return;
    setConfirmPurge(false);
    await run(async () => {
      const active = configuration?.credentials.find(item => item.terminalId === terminalId && item.state === "active");
      if (online && active) {
        const response = await fetch("/api/erp/pdv/offline-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "credential.revoke", terminalId, credentialId: active.id, idempotencyKey: `offline.revoke:${crypto.randomUUID()}` }) });
        if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "A revogação no servidor falhou; nada foi apagado localmente.");
      }
      await vault.purge(); await refreshLocal(vault); if (online) await loadConfiguration(); setNotice(online ? "Credencial revogada e dados locais eliminados." : "Dados locais eliminados. Revogue a credencial no servidor quando recuperar conexão.");
    });
  }

  async function run(work: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (caught) { setError(message(caught)); } finally { setBusy(false); } }

  return <main className={styles.page}>
    {!embedded && <header className={styles.hero}>
      <div><span>PDV · CONTINUIDADE SEGURA</span><h1>Rascunhos offline</h1><p>Este modo preserva apenas intenção de carrinho. Valores, estoque, venda, pagamento, caixa e fiscal continuam autoritativos e online.</p></div>
      <div className={online ? styles.online : styles.offline} role="status">{online ? "Online" : "Offline"}</div>
    </header>}
    {!embedded && <nav><Link href="/erp/pdv">← Voltar ao PDV online</Link></nav>}
    {embedded && <div className="pos-offline-embedded-status"><p>Prepare e sincronize rascunhos cifrados deste terminal. Pagamento, caixa e emissão fiscal continuam somente online.</p><span className={online ? styles.online : styles.offline} role="status">{online ? "Online" : "Offline"}</span></div>}
    {notice && <p className={styles.notice} aria-live="polite">{notice}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}

    <section className={styles.grid} aria-label="Estado do modo offline">
      <article><small>Cofre</small><strong>{status.unlocked ? "desbloqueado" : status.configured ? "bloqueado" : "não configurado"}</strong></article>
      <article><small>Fila</small><strong>{status.queued}</strong><span>{status.rejected} rejeitadas · {status.conflicts} conflitos</span></article>
      <article><small>Catálogo</small><strong>{catalogCount} itens</strong><span>{shortVersion(status.catalogVersion)}</span></article>
      <article><small>Credencial</small><strong>{status.expiresAt ? new Date(status.expiresAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() }) : "—"}</strong><span>cursor {status.lastPullCursor}</span></article>
    </section>

    <section className={styles.columns}>
      <form className={styles.card} onSubmit={status.configured ? unlock : provision}>
        <h2>{status.configured ? "Desbloquear cofre" : "Ativar neste dispositivo"}</h2>
        <label>Terminal<select value={terminalId} onChange={event => setTerminalId(event.target.value)} disabled={busy || status.unlocked}><option value="">Selecione</option>{configuration?.terminals.map(terminal => <option key={terminal.id} value={terminal.id}>{terminal.code} · {terminal.name}</option>)}</select></label>
        {!status.configured && <label>Validade curta<select value={ttlMinutes} onChange={event => setTtlMinutes(Number(event.target.value))}><option value={60}>1 hora</option><option value={240}>4 horas</option><option value={480}>8 horas</option></select></label>}
        <label>Frase secreta local<input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={passphrase} onChange={event => setPassphrase(event.target.value)} required /></label>
        <button disabled={busy || !terminalId}>{status.configured ? "Desbloquear" : "Emitir e cifrar"}</button>
        <small>A frase não sai deste navegador e não é armazenada. Perda da frase torna o cofre irrecuperável.</small>
      </form>

      <section className={styles.card}>
        <h2>Sincronização</h2>
        <button onClick={synchronize} disabled={busy || !status.unlocked || !online}>Sincronizar push → pull → ACK</button>
        <button onClick={queueHeartbeat} disabled={busy || !status.unlocked}>Enfileirar heartbeat</button>
        <button ref={purgeTriggerRef} className={styles.danger} onClick={() => setConfirmPurge(true)} disabled={busy || !status.configured}>Revogar e eliminar dados</button>
      </section>
    </section>

    <form className={styles.card} onSubmit={saveDraft}>
      <h2>Preparar rascunho</h2>
      <div className={styles.formGrid}>
        <label>ID do rascunho<input value={draftId} onChange={event => { setDraftId(event.target.value); setRevision(0); }} /></label>
        <label>Produto ID<input inputMode="numeric" value={productId} onChange={event => setProductId(event.target.value)} required /></label>
        <label>Variação ID (opcional)<input inputMode="numeric" value={variationId} onChange={event => setVariationId(event.target.value)} /></label>
        <label>Quantidade<input inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} required /></label>
      </div>
      <div className={styles.actions}><button disabled={busy || !status.unlocked}>Salvar revisão {revision + 1}</button><button type="button" onClick={discardDraft} disabled={busy || !status.unlocked}>Descartar revisão {revision + 1}</button><button type="button" onClick={() => { setDraftId(crypto.randomUUID()); setRevision(0); }}>Novo rascunho</button></div>
    </form>

    <section className={styles.card}>
      <h2>Fila e conflitos</h2>
      {!queue.length ? <p>Nenhuma pendência local.</p> : <ol className={styles.queue}>{queue.map(item => <li key={item.operationId}><span>#{item.sequence} · {item.type}</span><strong>{item.state}</strong>{item.error != null && <code data-reason-code={item.error.reasonCode}>{item.error.message}</code>}</li>)}</ol>}
    </section>

    <aside className={styles.blocked} aria-label="Operações proibidas offline"><strong>Bloqueado offline por política</strong><span>Concluir venda</span><span>Receber pagamento</span><span>Abrir/fechar ou movimentar caixa</span><span>Emitir/autorizar fiscal</span></aside>

    <PdvAccessibleModal
      open={confirmPurge}
      title="Revogar e eliminar dados locais"
      description="Esta ação elimina a credencial, a fila, o catálogo e os rascunhos cifrados deste terminal."
      busy={busy}
      error={error || undefined}
      returnFocusRef={purgeTriggerRef}
      onRequestClose={() => setConfirmPurge(false)}
    >
      <p>Confirme somente se as pendências já foram sincronizadas ou se a perda dos dados locais foi aceita.</p>
      <div className={styles.actions}>
        <button type="button" onClick={() => setConfirmPurge(false)} disabled={busy}>Cancelar</button>
        <button type="button" className={styles.danger} onClick={purge} disabled={busy}>Revogar e eliminar</button>
      </div>
    </PdvAccessibleModal>
  </main>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Erro inesperado no modo offline."; }
function shortVersion(value: string | null) { return value ? `${value.slice(0, 12)}…` : "não sincronizado"; }
