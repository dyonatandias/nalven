import { createRoot } from "react-dom/client";
import { ProductionWorkspace } from "../../components/erp/production-workspace";
import { useEffect, useState, type ComponentProps } from "react";
import { PurchaseReceiptDialog } from "../../components/erp/purchase-receipt-dialog";

function ReceiptFixture({ id }: { id: string }) {
  const [data, setData] = useState<Pick<ComponentProps<typeof PurchaseReceiptDialog>, "order" | "warehouses">>();
  const [done, setDone] = useState(false);
  useEffect(() => { void fetch(`/api/erp/purchases/${id}`).then(response => response.json()).then(setData); }, [id]);
  if (done) return <p role="status">Recebimento confirmado</p>;
  return data ? <PurchaseReceiptDialog {...data} close={() => setDone(true)} onSuccess={() => setDone(true)} /> : <p>Carregando compra…</p>;
}
const receiptId = new URLSearchParams(window.location.search).get("receipt");
createRoot(document.getElementById("app")!).render(receiptId ? <ReceiptFixture id={receiptId} /> : <ProductionWorkspace cacheNamespace="production-browser-disposable" />);
