"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PdvPromotionsAdmin } from "@/components/erp/pdv-promotions-admin";
import { PdvInventoryAdmin } from "@/components/erp/pdv-inventory-admin";
import { PdvInternalQrAdmin } from "@/components/erp/pdv-internal-qr-admin";
import { PdvKitsAdmin } from "@/components/erp/pdv-kits-admin";
import { PdvManualApplicationsAdmin } from "@/components/erp/pdv-manual-applications-admin";
import { PdvObservabilityAdmin } from "@/components/erp/pdv-observability-admin";
import { PdvProductCodesAdmin } from "@/components/erp/pdv-product-codes-admin";
import { PdvReconciliationAdmin } from "@/components/erp/pdv-reconciliation-admin";
import { PdvValueAccountsAdmin } from "@/components/erp/pdv-value-accounts-admin";

type Warehouse = { id: number; code: string; name: string; primary: boolean };
type Device = {
  id: string;
  terminalId: string;
  type: string;
  name: string;
  provider?: string | null;
  vendorId?: string | null;
  productId?: string | null;
  serialNumber?: string | null;
  status: string;
};
type Terminal = {
  id: string;
  registerId: number;
  code: string;
  name: string;
  status: string;
  credentialVersion?: number;
  tokenExpiresAt?: string | null;
  pairedAt?: string | null;
  revokedAt?: string | null;
  settings?: {
    operation_mode?: "counter" | "self_service";
    input_mode?: "scanner" | "touch" | "hybrid";
  } | null;
  devices?: Device[];
};
type Connector = {
  id: string;
  branchId: number;
  registerId: number | null;
  type: string;
  provider: string;
  mode: string;
  status: string;
  credentialConfigured: boolean;
};
type Register = {
  id: number;
  branchId: number;
  warehouseId: number | null;
  code: string;
  name: string;
  status: string;
  terminals?: Terminal[];
  connectors?: Connector[];
  counts?: { accesses: number; sessions: number };
};
type AdminData = {
  capabilities?: { reconciliation: boolean; manualApplications: boolean };
  branch: { id: number; code: string; name: string; status: string };
  warehouses: Warehouse[];
  registers: Register[];
  branchConnectors: Connector[];
};

export function PdvAdminDialog({
  onClose,
  onChanged,
  standalone = false,
}: {
  onClose(): void;
  onChanged(): Promise<void>;
  standalone?: boolean;
}) {
  const [section, setSection] = useState<
    "registers" | "checkout" | "payments" | "operation" | "external"
  >("registers");
  const [data, setData] = useState<AdminData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealedSecret, setRevealedSecret] = useState<{
    terminalId: string;
    title: string;
    value: string;
    expiresAt?: string | null;
  } | null>(null);
  const attempts = useRef<Record<string, { signature: string; key: string }>>(
    {},
  );

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/admin", { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok)
        throw new Error(
          stringValue(body.error) ||
            "Não foi possível carregar a configuração.",
        );
      setData(body as AdminData);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível carregar a configuração.",
      );
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function mutate(
    logicalId: string,
    payload: Record<string, unknown>,
    success: string,
  ) {
    if (busy) return false;
    const signature = JSON.stringify(payload);
    const current = attempts.current[logicalId];
    const attempt =
      current?.signature === signature
        ? current
        : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/erp/pdv/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }),
      });
      const body = await responseBody(response);
      if (!response.ok)
        throw new Error(
          stringValue(body.error) || "Não foi possível salvar a configuração.",
        );
      delete attempts.current[logicalId];
      setNotice(success);
      await Promise.all([load(), onChanged()]);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível salvar a configuração.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function mutateCredential(
    terminal: Terminal,
    action:
      "terminal.pairing.issue" | "terminal.token.rotate" | "terminal.revoke",
  ) {
    if (busy) return;
    const payload = { action, terminalId: terminal.id, confirm: true },
      signature = JSON.stringify(payload),
      logicalId = `credential:${action}:${terminal.id}`;
    const current = attempts.current[logicalId],
      attempt =
        current?.signature === signature
          ? current
          : { signature, key: crypto.randomUUID() };
    attempts.current[logicalId] = attempt;
    setBusy(true);
    setError("");
    setNotice("");
    setRevealedSecret(null);
    try {
      const response = await fetch("/api/erp/pdv/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }),
      });
      const body = await responseBody(response);
      if (!response.ok)
        throw new Error(
          stringValue(body.error) ||
            "Não foi possível gerir a credencial do terminal.",
        );
      delete attempts.current[logicalId];
      const pairingCode = stringValue(body.pairingCode),
        agentToken = stringValue(body.agentToken);
      if (pairingCode)
        setRevealedSecret({
          terminalId: terminal.id,
          title: "Código de pareamento (exibição única)",
          value: pairingCode,
          expiresAt: nestedString(body, "pairing", "expiresAt"),
        });
      else if (agentToken)
        setRevealedSecret({
          terminalId: terminal.id,
          title: "Token do agente (exibição única)",
          value: agentToken,
          expiresAt: nestedString(body, "credential", "expiresAt"),
        });
      else if (action !== "terminal.revoke")
        setNotice(
          "A operação já foi concluída, mas o segredo não pode ser reexibido. Gere um novo para substituir o anterior.",
        );
      else setNotice("Terminal e credenciais revogados.");
      await Promise.all([load(), onChanged()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível gerir a credencial do terminal.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!data)
    return (
      <div
        className={
          standalone
            ? "pos-admin-page pos-admin-dialog"
            : "tenant-modal pos-dialog pos-admin-dialog"
        }
        role={standalone ? undefined : "dialog"}
        aria-modal={standalone ? undefined : "true"}
        aria-labelledby="pos-admin-title"
      >
        <div>
          <header>
            <h2 id="pos-admin-title">Configuração do PDV</h2>
            {standalone ? (
              <Link href="/erp/pdv">Voltar ao PDV</Link>
            ) : (
              <button type="button" onClick={onClose}>
                Fechar
              </button>
            )}
          </header>
          <p role="status">{error || "Carregando caixas e terminais…"}</p>
        </div>
      </div>
    );

  const connectors = [
    ...data.branchConnectors,
    ...data.registers.flatMap((register) => register.connectors || []),
  ].filter(
    (connector, index, values) =>
      values.findIndex((item) => item.id === connector.id) === index,
  );

  return (
    <div
      className={
        standalone
          ? "pos-admin-page pos-admin-dialog"
          : "tenant-modal pos-dialog pos-admin-dialog"
      }
      role={standalone ? undefined : "dialog"}
      aria-modal={standalone ? undefined : "true"}
      aria-labelledby="pos-admin-title"
    >
      <div>
        <header>
          <div>
            <h2 id="pos-admin-title">Configurar ponto de venda</h2>
            <p>{data.branch.name} · operação, equipamentos e regras do caixa</p>
          </div>
          {standalone ? (
            <Link href="/erp/pdv">Voltar ao PDV</Link>
          ) : (
            <button type="button" autoFocus onClick={onClose}>
              Fechar
            </button>
          )}
        </header>
        {error && (
          <p className="tenant-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="tenant-success" role="status">
            {notice}
          </p>
        )}
        {revealedSecret && (
          <aside className="pos-admin-secret" role="status">
            <div>
              <strong>{revealedSecret.title}</strong>
              <small>
                Copie agora. O servidor não armazenará nem exibirá este valor
                novamente.
                {revealedSecret.expiresAt
                  ? ` Expira em ${new Date(revealedSecret.expiresAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}.`
                  : ""}
              </small>
              <code>{revealedSecret.value}</code>
            </div>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(revealedSecret.value).then(
                  () => setNotice("Segredo copiado."),
                  () =>
                    setError(
                      "Não foi possível copiar automaticamente; selecione o valor.",
                    ),
                )
              }
            >
              Copiar
            </button>
            <button type="button" onClick={() => setRevealedSecret(null)}>
              Ocultar
            </button>
          </aside>
        )}

        <nav className="pos-admin-tabs" aria-label="Etapas da configuração">
          {(
            [
              [
                "registers",
                "1",
                "Caixa e equipamentos",
                "Onde a venda acontece",
              ],
              [
                "checkout",
                "2",
                "Regras de venda",
                "Como o PDV identifica e calcula",
              ],
              ["payments", "3", "Recebimentos", "Como cobrar e conferir"],
              ["operation", "4", "Acompanhamento", "Saúde e ocorrências"],
              [
                "external",
                "↗",
                "Outros módulos",
                "Pagamentos, produtos e estoque",
              ],
            ] as const
          ).map(([key, step, label, description]) => (
            <button
              key={key}
              type="button"
              aria-current={section === key ? "page" : undefined}
              onClick={() => setSection(key)}
            >
              <span>{step}</span>
              <strong>{label}</strong>
              <small>{description}</small>
            </button>
          ))}
        </nav>

        <div className="pos-admin-section" hidden={section !== "registers"}>
          <Intro
            title="Etapa 1 · Caixa e equipamentos"
            text="Crie o caixa físico, escolha de qual depósito ele vende e cadastre somente os equipamentos conectados a cada terminal."
          />
          <section className="pos-admin-create">
            <h3>Novo caixa</h3>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const element = event.currentTarget,
                  form = new FormData(element);
                void mutate(
                  "register.create",
                  {
                    action: "register.create",
                    branchId: data.branch.id,
                    warehouseId: nullableNumber(form.get("warehouseId")),
                    code: form.get("code"),
                    name: form.get("name"),
                  },
                  "Caixa criado.",
                ).then((ok) => {
                  if (ok) element.reset();
                });
              }}
            >
              <label>
                Código
                <input name="code" required maxLength={40} disabled={busy} />
              </label>
              <label>
                Nome
                <input name="name" required maxLength={160} disabled={busy} />
              </label>
              <WarehouseSelect warehouses={data.warehouses} disabled={busy} />
              <button className="primary" disabled={busy}>
                Criar caixa
              </button>
            </form>
          </section>

          <section className="pos-admin-list" aria-label="Caixas configurados">
            {data.registers.map((register) => (
              <article key={register.id}>
                <header>
                  <div>
                    <h3>{register.name}</h3>
                    <small>
                      {register.code} · {register.status} ·{" "}
                      {register.counts?.accesses || 0} acessos ·{" "}
                      {register.counts?.sessions || 0} turnos
                    </small>
                  </div>
                  {register.status === "active" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Desativar o caixa ${register.name} e revogar seus terminais?`,
                          )
                        )
                          void mutate(
                            `register.deactivate:${register.id}`,
                            {
                              action: "register.deactivate",
                              registerId: register.id,
                            },
                            "Caixa desativado.",
                          );
                      }}
                    >
                      Desativar
                    </button>
                  )}
                </header>
                <form
                  className="pos-admin-row pos-register-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void mutate(
                      `register.update:${register.id}`,
                      {
                        action: "register.update",
                        registerId: register.id,
                        code: form.get("code"),
                        name: form.get("name"),
                        warehouseId: nullableNumber(form.get("warehouseId")),
                      },
                      "Caixa atualizado.",
                    );
                  }}
                >
                  <label>
                    Código
                    <input
                      name="code"
                      defaultValue={register.code}
                      required
                      maxLength={40}
                      disabled={busy || register.status !== "active"}
                    />
                  </label>
                  <label>
                    Nome
                    <input
                      name="name"
                      defaultValue={register.name}
                      required
                      maxLength={160}
                      disabled={busy || register.status !== "active"}
                    />
                  </label>
                  <WarehouseSelect
                    warehouses={data.warehouses}
                    defaultValue={register.warehouseId}
                    disabled={busy || register.status !== "active"}
                  />
                  <button disabled={busy || register.status !== "active"}>
                    Salvar caixa
                  </button>
                </form>

                {register.status === "active" && (
                  <form
                    className="pos-admin-row pos-terminal-create"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const element = event.currentTarget,
                        form = new FormData(element);
                      void mutate(
                        `terminal.create:${register.id}`,
                        {
                          action: "terminal.create",
                          registerId: register.id,
                          code: form.get("code"),
                          name: form.get("name"),
                          settings: {
                            operation_mode: form.get("operationMode"),
                            input_mode: form.get("inputMode"),
                          },
                        },
                        "Terminal criado como não pareado.",
                      ).then((ok) => {
                        if (ok) element.reset();
                      });
                    }}
                  >
                    <strong>Novo terminal</strong>
                    <label>
                      Código
                      <input
                        name="code"
                        required
                        maxLength={40}
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Nome
                      <input
                        name="name"
                        required
                        maxLength={160}
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Perfil
                      <select name="operationMode" defaultValue="counter">
                        <option value="counter">Balcão / operador</option>
                        <option value="self_service">Autoatendimento</option>
                      </select>
                    </label>
                    <label>
                      Entrada
                      <select name="inputMode" defaultValue="hybrid">
                        <option value="hybrid">Leitor + touch</option>
                        <option value="scanner">Priorizar leitor</option>
                        <option value="touch">Priorizar touch</option>
                      </select>
                    </label>
                    <button disabled={busy}>Adicionar</button>
                  </form>
                )}

                <div className="pos-admin-children">
                  {register.terminals?.map((terminal) => (
                    <section key={terminal.id}>
                      <form
                        className="pos-admin-row pos-terminal-edit"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void mutate(
                            `terminal.update:${terminal.id}`,
                            {
                              action: "terminal.update",
                              terminalId: terminal.id,
                              code: form.get("code"),
                              name: form.get("name"),
                              settings: {
                                operation_mode: form.get("operationMode"),
                                input_mode: form.get("inputMode"),
                              },
                            },
                            "Terminal atualizado.",
                          );
                        }}
                      >
                        <strong>Terminal</strong>
                        <label>
                          Código
                          <input
                            name="code"
                            defaultValue={terminal.code}
                            required
                            disabled={
                              busy ||
                              !["unpaired", "revoked"].includes(terminal.status)
                            }
                          />
                        </label>
                        <label>
                          Nome
                          <input
                            name="name"
                            defaultValue={terminal.name}
                            required
                            disabled={
                              busy ||
                              !["unpaired", "revoked"].includes(terminal.status)
                            }
                          />
                        </label>
                        <label>
                          Perfil
                          <select
                            name="operationMode"
                            defaultValue={
                              terminal.settings?.operation_mode || "counter"
                            }
                            disabled={busy || terminal.status === "revoked"}
                          >
                            <option value="counter">Balcão / operador</option>
                            <option value="self_service">
                              Autoatendimento
                            </option>
                          </select>
                        </label>
                        <label>
                          Entrada
                          <select
                            name="inputMode"
                            defaultValue={
                              terminal.settings?.input_mode || "hybrid"
                            }
                            disabled={busy || terminal.status === "revoked"}
                          >
                            <option value="hybrid">Leitor + touch</option>
                            <option value="scanner">Priorizar leitor</option>
                            <option value="touch">Priorizar touch</option>
                          </select>
                        </label>
                        <span>
                          {terminal.status}
                          {terminal.credentialVersion
                            ? ` · cred. v${terminal.credentialVersion}`
                            : ""}
                          {terminal.tokenExpiresAt
                            ? ` · exp. ${new Date(terminal.tokenExpiresAt).toLocaleDateString("pt-BR", { timeZone: tenantTimeZone() })}`
                            : ""}
                        </span>
                        <button
                          disabled={
                            busy ||
                            !["unpaired", "revoked"].includes(terminal.status)
                          }
                        >
                          Salvar
                        </button>
                        {["unpaired", "revoked"].includes(terminal.status) ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutateCredential(
                                terminal,
                                "terminal.pairing.issue",
                              )
                            }
                          >
                            Gerar pareamento
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Rotacionar a credencial de ${terminal.name}? O agente atual perderá acesso imediatamente.`,
                                )
                              )
                                void mutateCredential(
                                  terminal,
                                  "terminal.token.rotate",
                                );
                            }}
                          >
                            Rotacionar token
                          </button>
                        )}
                        {terminal.status !== "revoked" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Revogar o terminal ${terminal.name} e desabilitar seus dispositivos?`,
                                )
                              )
                                void mutateCredential(
                                  terminal,
                                  "terminal.revoke",
                                );
                            }}
                          >
                            Revogar
                          </button>
                        )}
                      </form>
                      {terminal.status !== "revoked" && (
                        <form
                          className="pos-admin-row pos-admin-device"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const element = event.currentTarget,
                              form = new FormData(element);
                            void mutate(
                              `device.create:${terminal.id}`,
                              {
                                action: "device.create",
                                terminalId: terminal.id,
                                type: form.get("type"),
                                name: form.get("name"),
                                provider: nullableText(form.get("provider")),
                                vendorId: null,
                                productId: null,
                                serialNumber: nullableText(
                                  form.get("serialNumber"),
                                ),
                              },
                              "Dispositivo cadastrado.",
                            ).then((ok) => {
                              if (ok) element.reset();
                            });
                          }}
                        >
                          <small>Novo periférico</small>
                          <label>
                            Tipo
                            <select name="type" disabled={busy}>
                              <option value="scanner">Leitor de código</option>
                              <option value="camera">Câmera USB</option>
                              <option value="printer">Impressora</option>
                              <option value="scale">Balança</option>
                              <option value="drawer">Gaveta</option>
                              <option value="pinpad">Pinpad</option>
                              <option value="display">Display</option>
                            </select>
                          </label>
                          <label>
                            Nome
                            <input name="name" required disabled={busy} />
                          </label>
                          <label>
                            Provider
                            <input name="provider" disabled={busy} />
                          </label>
                          <label>
                            Série
                            <input name="serialNumber" disabled={busy} />
                          </label>
                          <button disabled={busy}>Adicionar</button>
                        </form>
                      )}
                      {terminal.devices?.map((device) => (
                        <form
                          key={device.id}
                          className="pos-admin-row pos-admin-device"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const form = new FormData(event.currentTarget);
                            void mutate(
                              `device.update:${device.id}`,
                              {
                                action: "device.update",
                                deviceId: device.id,
                                type: form.get("type"),
                                name: form.get("name"),
                                provider: nullableText(form.get("provider")),
                                serialNumber: nullableText(
                                  form.get("serialNumber"),
                                ),
                              },
                              "Dispositivo atualizado.",
                            );
                          }}
                        >
                          <small>Periférico</small>
                          <label>
                            Tipo
                            <input
                              name="type"
                              defaultValue={device.type}
                              required
                              disabled={busy || device.status === "disabled"}
                            />
                          </label>
                          <label>
                            Nome
                            <input
                              name="name"
                              defaultValue={device.name}
                              required
                              disabled={busy || device.status === "disabled"}
                            />
                          </label>
                          <label>
                            Provider
                            <input
                              name="provider"
                              defaultValue={device.provider || ""}
                              disabled={busy || device.status === "disabled"}
                            />
                          </label>
                          <label>
                            Série
                            <input
                              name="serialNumber"
                              defaultValue={device.serialNumber || ""}
                              disabled={busy || device.status === "disabled"}
                            />
                          </label>
                          <span>{device.status}</span>
                          <button
                            disabled={busy || device.status === "disabled"}
                          >
                            Salvar
                          </button>
                          {device.status !== "disabled" && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  `device.deactivate:${device.id}`,
                                  {
                                    action: "device.deactivate",
                                    deviceId: device.id,
                                  },
                                  "Dispositivo desativado.",
                                )
                              }
                            >
                              Desativar
                            </button>
                          )}
                        </form>
                      ))}
                    </section>
                  ))}
                </div>
              </article>
            ))}
          </section>
        </div>

        <div className="pos-admin-section" hidden={section !== "checkout"}>
          <Intro
            title="Etapa 2 · Regras usadas durante a venda"
            text="Aqui ficam apenas regras que mudam o comportamento do caixa. Nome, preço, categoria e saldo do produto continuam nos cadastros gerais."
          />
          <GuidedBlock
            title="1. Códigos lidos no caixa"
            description="Defina códigos de barras, embalagens e etiquetas de balança reconhecidos pelo PDV."
          >
            {/* prettier-ignore */}
            <PdvProductCodesAdmin branchId={data.branch.id} onChanged={onChanged} />
          </GuidedBlock>
          <GuidedBlock
            title="2. Kits vendidos no caixa"
            description="Informe quais componentes devem sair do estoque quando um kit for vendido."
          >
            <PdvKitsAdmin branchId={data.branch.id} onChanged={onChanged} />
          </GuidedBlock>
          <GuidedBlock
            title="3. QR internos"
            description="Crie atalhos seguros para cliente, carrinho, cupom, vale e recibo."
          >
            <PdvInternalQrAdmin branchId={data.branch.id} />
          </GuidedBlock>
          <GuidedBlock
            title="4. Promoções e cupons"
            description="Configure as ofertas que o servidor deve validar antes do pagamento."
          >
            <PromotionsSettings data={data} onChanged={onChanged} />
          </GuidedBlock>
        </div>
        <div className="pos-admin-section" hidden={section !== "payments"}>
          <Intro
            title="Etapa 3 · Recebimentos"
            text="Escolha os meios aceitos no caixa e confira o que foi recebido. Credenciais e homologação do provedor ficam no Centro de Integrações."
          />
          <GuidedBlock
            title="1. Conectores disponíveis no PDV"
            description="Vincule ao caixa somente conectores já cadastrados e homologados no Centro de Integrações."
            defaultOpen
          >
            <section className="pos-admin-create">
              <h3>Novo vínculo operacional</h3>
              <p>
                Este vínculo define a filial ou o caixa que poderá usar o
                conector; ele não guarda senha ou token.
              </p>
              <ConnectorCreateForm
                branchId={data.branch.id}
                registers={data.registers}
                busy={busy}
                mutate={mutate}
              />
            </section>
            <ConnectorList
              title="Vínculos atuais"
              connectors={connectors}
              registers={data.registers}
              busy={busy}
              mutate={mutate}
            />
          </GuidedBlock>
          <GuidedBlock
            title="2. Gift card, fidelidade e crédito da loja"
            description="Defina valores próprios que o cliente poderá usar como pagamento."
          >
            {/* prettier-ignore */}
            <PdvValueAccountsAdmin branchId={data.branch.id} onChanged={onChanged} />
          </GuidedBlock>
          <GuidedBlock
            title="3. Conciliação"
            description="Compare o que o PDV registrou com os arquivos enviados pelas adquirentes."
          >
            {data.capabilities?.reconciliation ? (
              section === "payments" && <PdvReconciliationAdmin branchId={data.branch.id} />
            ) : <p>A conciliação não está disponível no plano ou nas permissões deste usuário.</p>}
          </GuidedBlock>
          <GuidedBlock
            title="4. Casos excepcionais"
            description="Acompanhe finalizações manuais e pendências que exigem tratamento do gestor."
          >
            {data.capabilities?.manualApplications ? (
              section === "payments" && <PdvManualApplicationsAdmin branchId={data.branch.id} />
            ) : <p>Os casos excepcionais exigem permissão de PDV e um perfil operacional ativo. Solicite a verificação do cadastro ao administrador.</p>}
          </GuidedBlock>
        </div>
        <div className="pos-admin-section" hidden={section !== "operation"}>
          <Intro
            title="Etapa 4 · Acompanhamento"
            text="Consulte o estado dos turnos, filas e operações. Esta etapa não altera preços, produtos nem credenciais."
          />
          <PdvObservabilityAdmin branchId={data.branch.id} />
        </div>
        <div className="pos-admin-section" hidden={section !== "external"}>
          <Intro
            title="Cadastros que não pertencem ao PDV"
            text="O caixa somente consome estas configurações. Elas são compartilhadas com pedidos, financeiro, logística, e-commerce e outros canais."
          />
          <div className="pos-admin-domain-grid">
            <article>
              <span>01</span>
              <div>
                <h3>Pagamentos e recebimentos</h3>
                <p>
                  Gateways, bancos, Pix, links, TEF e adquirentes são
                  cadastrados na Central de Pagamentos. No PDV você apenas
                  escolhe onde uma rota homologada poderá ser usada.
                </p>
              </div>
              <Link href="/erp/pagamentos-recebimentos">
                Abrir Central de Pagamentos
              </Link>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>Produtos e catálogo</h3>
                <p>
                  Nome, SKU, preço, categoria, variações, imagens, unidade e
                  dados fiscais pertencem ao cadastro mestre do produto.
                </p>
              </div>
              <Link href="/erp/produtos-servicos">
                Abrir produtos e serviços
              </Link>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>Estoque e lotes</h3>
                <p>
                  Entradas, depósitos, lotes, séries, validade e movimentos
                  pertencem ao estoque. O PDV apenas reserva e baixa do depósito
                  ligado ao caixa.
                </p>
              </div>
              <Link href="/erp/estoque">Abrir estoque</Link>
            </article>
          </div>
          <GuidedBlock
            title="Ferramenta avançada de lotes"
            description="Acesso temporário à gestão técnica de lotes já existente, preservado até sua consolidação definitiva no módulo de estoque."
          >
            {/* prettier-ignore */}
            <PdvInventoryAdmin branchId={data.branch.id} onChanged={onChanged} />
          </GuidedBlock>
        </div>
      </div>
    </div>
  );
}

function Intro({ title, text }: { title: string; text: string }) {
  return (
    <section className="pos-admin-intro">
      <span>CONFIGURAÇÃO GUIADA</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </section>
  );
}

function GuidedBlock({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="pos-admin-guided" open={defaultOpen || undefined}>
      <summary>
        <span aria-hidden="true">›</span>
        <div>
          <strong>{title}</strong>
          <small>{description}</small>
        </div>
      </summary>
      <div>{children}</div>
    </details>
  );
}

function PromotionsSettings({
  data,
  onChanged,
}: {
  data: AdminData;
  onChanged(): Promise<void>;
}) {
  return <PdvPromotionsAdmin branchId={data.branch.id} onChanged={onChanged} />;
}

function WarehouseSelect({
  warehouses,
  defaultValue,
  disabled,
}: {
  warehouses: Warehouse[];
  defaultValue?: number | null;
  disabled: boolean;
}) {
  return (
    <label>
      Depósito
      <select
        name="warehouseId"
        defaultValue={defaultValue || ""}
        disabled={disabled}
      >
        <option value="">Sem depósito</option>
        {warehouses.map((warehouse) => (
          <option key={warehouse.id} value={warehouse.id}>
            {warehouse.name} · {warehouse.code}
          </option>
        ))}
      </select>
    </label>
  );
}

function ConnectorCreateForm({
  branchId,
  registers,
  busy,
  mutate,
}: {
  branchId: number;
  registers: Register[];
  busy: boolean;
  mutate: Mutation;
}) {
  return (
    <form
      className="pos-admin-row"
      onSubmit={(event) => {
        event.preventDefault();
        const element = event.currentTarget,
          form = new FormData(element);
        void mutate(
          "connector.create",
          {
            action: "connector.create",
            branchId,
            registerId: nullableNumber(form.get("registerId")),
            type: form.get("type"),
            provider: form.get("provider"),
            mode: form.get("mode"),
            credentialRef: null,
          },
          "Vínculo criado como inativo.",
        ).then((ok) => {
          if (ok) element.reset();
        });
      }}
    >
      <label>
        Onde será usado
        <select name="registerId" disabled={busy}>
          <option value="">Todos os caixas da filial</option>
          {registers
            .filter((item) => item.status === "active")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Finalidade
        <select name="type" required disabled={busy}>
          <option value="pix">Pix</option>
          <option value="tef">Cartão / TEF</option>
          <option value="card">Cartão integrado</option>
          <option value="fiscal">Emissão fiscal</option>
        </select>
      </label>
      <label>
        Integração cadastrada
        <input
          name="provider"
          required
          placeholder="Nome do provedor"
          disabled={busy}
        />
      </label>
      <label>
        Como se comunica
        <select name="mode" disabled={busy}>
          <option value="server">Pela internet</option>
          <option value="local_agent">Programa neste computador</option>
          <option value="terminal">Direto pelo terminal</option>
        </select>
      </label>
      <button className="primary" disabled={busy}>
        Criar vínculo
      </button>
    </form>
  );
}

type Mutation = (
  logicalId: string,
  payload: Record<string, unknown>,
  success: string,
) => Promise<boolean>;

function ConnectorList({
  title,
  connectors,
  registers,
  busy,
  mutate,
}: {
  title?: string;
  connectors: Connector[];
  registers: Register[];
  busy: boolean;
  mutate: Mutation;
}) {
  if (!connectors.length) return null;
  return (
    <section className="pos-admin-connectors">
      {title && <h3>{title}</h3>}
      {connectors.map((connector) => (
        <form
          key={connector.id}
          className="pos-admin-row"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void mutate(
              `connector.update:${connector.id}`,
              {
                action: "connector.update",
                connectorId: connector.id,
                registerId: nullableNumber(form.get("registerId")),
                type: form.get("type"),
                provider: form.get("provider"),
                mode: form.get("mode"),
              },
              "Vínculo atualizado.",
            );
          }}
        >
          <label>
            Onde é usado
            <select
              name="registerId"
              defaultValue={connector.registerId || ""}
              disabled={busy || connector.status !== "inactive"}
            >
              <option value="">Todos os caixas da filial</option>
              {registers
                .filter((item) => item.status === "active")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Finalidade
            <input
              name="type"
              defaultValue={connector.type}
              required
              disabled={busy || connector.status !== "inactive"}
            />
          </label>
          <label>
            Integração
            <input
              name="provider"
              defaultValue={connector.provider}
              required
              disabled={busy || connector.status !== "inactive"}
            />
          </label>
          <label>
            Comunicação
            <select
              name="mode"
              defaultValue={connector.mode}
              disabled={busy || connector.status !== "inactive"}
            >
              <option value="server">Pela internet</option>
              <option value="local_agent">Programa neste computador</option>
              <option value="terminal">Direto pelo terminal</option>
            </select>
          </label>
          <span className={`pos-connector-state ${connector.status}`}>
            {connector.credentialConfigured
              ? "Integração vinculada"
              : "Aguardando integração"}{" "}
            · {connector.status}
          </span>
          <button disabled={busy || connector.status !== "inactive"}>
            Salvar vínculo
          </button>
          <button
            type="button"
            disabled={
              busy ||
              connector.status !== "inactive" ||
              !connector.credentialConfigured
            }
            onClick={() =>
              void mutate(
                `connector.activate:${connector.id}`,
                { action: "connector.activate", connectorId: connector.id },
                "Vínculo ativado.",
              )
            }
          >
            Ativar
          </button>
          <button
            type="button"
            disabled={busy || connector.status === "inactive"}
            onClick={() =>
              void mutate(
                `connector.deactivate:${connector.id}`,
                { action: "connector.deactivate", connectorId: connector.id },
                "Vínculo desativado.",
              )
            }
          >
            Desativar
          </button>
        </form>
      ))}
    </section>
  );
}

async function responseBody(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}
function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
function nestedString(
  value: Record<string, unknown>,
  key: string,
  field: string,
) {
  const nested = value[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? stringValue((nested as Record<string, unknown>)[field]) || null
    : null;
}
function nullableNumber(value: FormDataEntryValue | null) {
  const result = Number(value);
  return value == null ||
    value === "" ||
    !Number.isSafeInteger(result) ||
    result <= 0
    ? null
    : result;
}
function nullableText(value: FormDataEntryValue | null) {
  const result = String(value || "").trim();
  return result || null;
}
