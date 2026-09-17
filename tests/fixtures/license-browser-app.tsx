import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LicenseWorkspace } from "../../components/portal/license-workspace";
import "../../app/globals.css";
import "../../app/portal/portal.css";

function Fixture() {
  const [active, setActive] = useState(true), [organizationId, setOrganizationId] = useState("license-org-a");
  return <div className="customer-portal" style={{ display: "block" }}><main style={{ marginLeft: 0, maxWidth: 1240, marginInline: "auto" }}><section style={{ padding: 16 }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
      <button type="button" onClick={() => setActive(value => !value)}>Alternar área de teste</button>
      <button type="button" onClick={() => setOrganizationId(value => value === "license-org-a" ? "license-org-b" : "license-org-a")}>Alternar organização de teste</button>
    </div>
    <div hidden={!active}><LicenseWorkspace organizationId={organizationId} active={active} /></div>
    {!active && <p>Outra área de teste</p>}
  </section></main></div>;
}
createRoot(document.getElementById("app")!).render(<Fixture />);
