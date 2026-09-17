"use client";
import { useRef, useState, type FormEvent } from "react";
import { Field, FormFooter, ProductionDialog } from "./production-ui";
import styles from "./production-workspace.module.css";

type ReceiptOrder = { id: number; number: string; items: { id: number; productId: number; variationId?: number | null; variation?: { sku: string | null } | null; quantity: number; receivedQuantity: number; product: { name: string; unit: string } }[] };
const remainingQuantity = (item: ReceiptOrder["items"][number]) => Math.round((item.quantity - item.receivedQuantity) * 1000000) / 1000000;
export function PurchaseReceiptDialog({ order, warehouses, close, onSuccess }: { order: ReceiptOrder; warehouses: { id: number; name: string }[]; close: () => void; onSuccess: () => void }) {
  const [busy,setBusy] = useState(false), [error,setError] = useState(""), [uncertain,setUncertain] = useState(false);
  const pending = useRef<Record<string,unknown> | null>(null), inFlight = useRef(false);
  const items = order.items.filter(item => remainingQuantity(item) > 0);
  async function send(payload: Record<string,unknown>) {
    if (inFlight.current) return;
    inFlight.current = true; pending.current = payload; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/erp/purchases/${order.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500) { pending.current = null; setUncertain(false); }
        throw new Error(body.error || "Não foi possível receber a compra.");
      }
      pending.current = null; setUncertain(false);
      window.dispatchEvent(new Event("erp:inventory-changed"));
      onSuccess();
    } catch (reason) {
      setUncertain(Boolean(pending.current));
      setError(reason instanceof Error ? reason.message : "Conexão interrompida. Confirme o resultado antes de alterar os dados.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) { void send(pending.current); return; }
    const values = new FormData(event.currentTarget);
    void send({ action: "receive", idempotencyKey: crypto.randomUUID(), warehouseId: values.get("warehouseId") || null, notes: values.get("notes"), items: items.map(item => ({ itemId: item.id, quantity: Number(values.get(`quantity-${item.id}`)), lotCode: values.get(`lot-${item.id}`), manufacturedOn: values.get(`manufactured-${item.id}`), expiresOn: values.get(`expires-${item.id}`), serialNumbers: values.get(`serials-${item.id}`) })).filter(item => item.quantity > 0) });
  }
  return <ProductionDialog title={`Receber ${order.number}`} subtitle="ENTRADA DE ESTOQUE E CONTA A PAGAR" busy={busy} close={close}>
    <form className={styles.form} onSubmit={save}>
      {error && <div className={`${styles.error} ${styles.wide}`} role="alert">{error}</div>}
      {uncertain && <div className={`${styles.note} ${styles.wide}`} role="status">O resultado ainda não foi confirmado. Repita a mesma operação para consultar o recebimento sem duplicar estoque ou conta a pagar.<button type="button" disabled={busy} onClick={() => pending.current && void send(pending.current)}>Confirmar resultado do recebimento</button></div>}
      <Field label="Depósito de destino" wide hint="Compras geradas pela produção usam o depósito da ordem. Nas demais compras, escolha o destino ou mantenha o padrão da filial.">
        <select name="warehouseId" disabled={busy || uncertain}><option value="">Automático: ordem de produção / filial ativa</option>{warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select>
      </Field>
      <p className={`${styles.note} ${styles.wide}`}>Confira a quantidade, a variação e a rastreabilidade. O recebimento atualiza o estoque compartilhado, o custo médio e a conta a pagar em uma única operação.</p>
      {items.map(item => <fieldset key={item.id} className={styles.wide} disabled={busy || uncertain}>
        <legend>{item.product.name}{item.variationId ? ` · ${item.variation?.sku || `Variação ${item.variationId}`}` : ""}</legend>
        <Field label={`Quantidade recebida de ${item.product.name}`} hint={`${item.receivedQuantity} de ${item.quantity} ${item.product.unit} já recebidos.`}><input name={`quantity-${item.id}`} type="number" min="0" max={remainingQuantity(item)} step="0.000001" required defaultValue={remainingQuantity(item)} /></Field>
        <details><summary>Lote, séries e validade</summary>
          <Field label="Lote do fornecedor" hint="Se não informado, será identificado pelo número do recebimento."><input name={`lot-${item.id}`} maxLength={160} /></Field>
          <Field label="Fabricação"><input name={`manufactured-${item.id}`} type="date" /></Field>
          <Field label="Validade"><input name={`expires-${item.id}`} type="date" /></Field>
          <Field label="Números de série" hint="Uma série por unidade. Separe por vírgulas ou linhas; obrigatório para produtos serializados."><textarea name={`serials-${item.id}`} maxLength={200000} /></Field>
        </details>
      </fieldset>)}
      <Field label="Observações do recebimento" wide><textarea name="notes" maxLength={1000} disabled={busy || uncertain} /></Field>
      {!uncertain && <FormFooter busy={busy} close={close} label="Confirmar recebimento" />}
    </form>
  </ProductionDialog>;
}
