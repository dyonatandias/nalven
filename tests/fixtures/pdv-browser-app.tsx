import { createRoot } from "react-dom/client";
import { PdvWorkspace } from "../../components/erp/pdv-workspace";
import "../../app/erp/erp.css";
import "../../app/erp/pdv-cart.css";
import "../../app/erp/pdv-shell.css";

createRoot(document.getElementById("app")!).render(<PdvWorkspace />);
