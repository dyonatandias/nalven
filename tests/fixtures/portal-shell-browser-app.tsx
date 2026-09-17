import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import PortalClient from "../../app/portal/portal-client";
import "../../app/globals.css";
import "../../app/portal/portal.css";

function ShellFixture() {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const update = () => setSearch(location.search);
    window.addEventListener("portal-test-navigation", update);
    window.addEventListener("popstate", update);
    return () => { window.removeEventListener("portal-test-navigation", update); window.removeEventListener("popstate", update); };
  }, []);
  const params = new URLSearchParams(search), organizationId = params.get("organization") || "portal-org-a";
  return <PortalClient key={organizationId} initialTab={params.get("area") || "suporte"}
    user={{name:"Pessoa de teste",email:"portal@example.invalid"}}
    organization={{id:organizationId,name:"Empresa de homologação do portal",status:"active",timezone:"America/Sao_Paulo"}}/>;
}

createRoot(document.getElementById("app")!).render(<ShellFixture/>);
