import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SupportWorkspace } from "../../components/portal/support-workspace";
import "../../app/globals.css";
import "../../app/portal/portal.css";

function Fixture() {
  const [active, setActive] = useState(true);
  const [organization, setOrganization] = useState("support-org-a");
  return <main style={{ maxWidth: 1240, margin: "0 auto", padding: 16 }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
      <button type="button" onClick={() => setActive(value => !value)}>Alternar área de teste</button>
      <button type="button" onClick={() => setOrganization(value => value === "support-org-a" ? "support-org-b" : "support-org-a")}>Alternar organização de teste</button>
    </div>
    <div hidden={!active}><SupportWorkspace organizationId={organization} active={active} /></div>
    {!active && <p>Outra área de teste</p>}
  </main>;
}

createRoot(document.getElementById("app")!).render(<Fixture />);
