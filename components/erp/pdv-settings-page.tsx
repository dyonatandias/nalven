"use client";

import { PdvAdminDialog } from "@/components/erp/pdv-admin-dialog";

export function PdvSettingsPage() {
  return (
    <section
      className="erp-dedicated-page"
      aria-labelledby="pdv-settings-page-title"
    >
      <header className="erp-dedicated-page-header">
        <div>
          <span>OPERAÇÃO</span>
          <h1 id="pdv-settings-page-title">Configurações do PDV</h1>
          <p>
            Organize caixas, terminais, equipamentos, regras de venda e
            acompanhamento operacional.
          </p>
        </div>
      </header>
      <PdvAdminDialog
        standalone
        onClose={() => undefined}
        onChanged={async () => undefined}
      />
    </section>
  );
}
