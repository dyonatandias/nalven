import type { Metadata } from "next";
import { PdvOfflineWorkspace } from "@/components/erp/pdv-offline-workspace";

export const metadata: Metadata = {
  title: "PDV Offline Seguro — NALVEN",
  description: "Preparação offline de rascunhos do PDV, sem pagamento, caixa ou fiscal.",
};

export default function PdvOfflinePage() {
  return <PdvOfflineWorkspace />;
}
