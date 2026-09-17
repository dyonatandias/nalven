import { createRoot } from "react-dom/client";
import ErpClient from "../../app/erp/erp-client";
import { ERP_MODULES } from "../../lib/erp/modules";
import "../../app/globals.css";
import "../../app/erp/erp.css";
import "../../app/erp/pdv-cart.css";
import "../../app/erp/orders.css";
import "../../app/erp/enhancements.css";
import "../../app/erp/pdv-shell.css";

createRoot(document.getElementById("app")!).render(<ErpClient
  initialPage="production" allowedPages={ERP_MODULES.map(item => item.id)}
  user={{ name: "Operador de demonstração", email: "operador@example.invalid" }}
  organization={{ id: "shell-test", name: "Empresa demonstração", status: "active", trialEndsAt: null, timezone: "America/Sao_Paulo", accentColor: "#52d18e", interfaceDensity: "comfortable", defaultSidebarMode: "expanded", logoMediaId: null, activeBranch: { id: 1, code: "MATRIZ", name: "Matriz", timezone: "America/Sao_Paulo" } }}
  organizations={[{ id: "shell-test", name: "Empresa demonstração", role: "owner" }]}
/>);
