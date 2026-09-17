"use client";
import { useEffect, useState } from "react";
import { ErpModal } from "./modal-portal";
import styles from "./dfe-inbox.module.css";

export function FiscalXmlViewer({ documentId, close }: { documentId: number; close(): void }) {
  const [xml, setXml] = useState("");
  const [error, setError] = useState("");
  const url = `/api/erp/invoices/dfe?action=download_xml&documentId=${documentId}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Não foi possível abrir o XML."); }
      const content = await response.text();
      if (!controller.signal.aborted) setXml(content);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha ao carregar XML."); });
    return () => controller.abort();
  }, [url]);
  return <ErpModal close={close} label="Visualizar XML fiscal" className={styles.modalLayer}>
    <section className={styles.xmlViewer}><header><div><h2>XML fiscal original</h2><p>Documento #{documentId} · conteúdo somente para leitura</p></div><button type="button" onClick={close} aria-label="Fechar XML">×</button></header>
      {error ? <p role="alert">{error}</p> : xml ? <pre tabIndex={0} aria-label="Conteúdo XML">{xml.replace(/>\s*</g, ">\n<")}</pre> : <p role="status">Carregando XML…</p>}
      <footer><a href={url} download>Baixar original</a><button type="button" onClick={close}>Fechar</button></footer>
    </section>
  </ErpModal>;
}
