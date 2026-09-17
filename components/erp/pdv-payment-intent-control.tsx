"use client";
/* eslint-disable @next/next/no-img-element */

import { tenantTimeZone } from "@/lib/client-timezone";
import { useEffect, useRef, useState } from "react";

export type PdvOperatorPaymentIntent = {
  id: string;
  status: string;
  version: number;
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  terminalId: string | null;
  connectorId: string;
  saleDraftId: string;
  paymentPlanId: string;
  paymentIndex: number;
  amountCents: number;
  currency: string;
  method: string;
  installments: number;
  provider: string;
  providerReference: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  unknownSince: string | null;
  nextReconcileAt: string | null;
  expiresAt: string;
  consumedAt: string | null;
  contextSignature: string;
  artifacts: Array<{
    kind: string;
    value: string;
    displayText: string | null;
    expiresAt: string | null;
  }>;
};

type Connector = {
  id: string;
  provider: string;
  mode: string;
  settings?: { channel?: string; methods?: string[] } | null;
  lastHealthOk?: boolean | null;
};
type Terminal = { id: string; name: string; status: string };

export function PdvPaymentIntentControl(props: {
  disabled: boolean;
  createDisabled?: boolean;
  configurationLocked?: boolean;
  online: boolean;
  sessionId: number;
  registerId: number;
  operatorProfileId: number;
  saleDraftId: string;
  paymentPlanId: string;
  paymentIndex: number;
  amountCents: number;
  method: "pix" | "credit" | "debit" | "voucher";
  installments: number;
  connectors: Connector[];
  terminals: Terminal[];
  connectorId: string;
  terminalId: string;
  intent: PdvOperatorPaymentIntent | null;
  onConnectorId: (value: string) => void;
  onTerminalId: (value: string) => void;
  onIntent: (value: PdvOperatorPaymentIntent | null) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [working, setWorking] = useState(false);
  const { onIntent } = props;
  const createAttempt = useRef({ signature: "", key: crypto.randomUUID() });
  const retryAttempts = useRef<Record<string, string>>({});
  const cancelAttempts = useRef<Record<string, string>>({});
  const contextSignature = posPaymentIntentContextSignature(props);
  const intent = props.intent;
  const locked = isPdvPaymentIntentLocked(intent);
  const polling = Boolean(
    intent &&
    [
      "created",
      "processing",
      "authorized",
      "unknown",
      "manual_review",
    ].includes(intent.status),
  );

  useEffect(() => {
    if (!polling || !intent) return;
    let active = true;
    const timer = window.setInterval(() => {
      void fetch(
        `/api/erp/pdv/payment-intents?intentId=${encodeURIComponent(intent.id)}`,
        { cache: "no-store" },
      )
        .then(async (response) => ({
          response,
          body: await responseBody(response),
        }))
        .then(({ response, body }) => {
          if (!active || !response.ok) return;
          const next = parsePdvOperatorPaymentIntent(body.intent);
          if (
            next &&
            (next.version !== intent.version || next.status !== intent.status)
          )
            onIntent(next);
        })
        .catch(() => undefined);
    }, 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [polling, intent, onIntent]);

  async function createIntent() {
    if (
      working ||
      props.disabled ||
      props.createDisabled ||
      !props.online ||
      !props.paymentPlanId ||
      props.amountCents <= 0
    )
      return;
    if (createAttempt.current.signature !== contextSignature)
      createAttempt.current = {
        signature: contextSignature,
        key: crypto.randomUUID(),
      };
    await mutate(
      {
        action: "intent.create",
        sessionId: props.sessionId,
        paymentPlanId: props.paymentPlanId,
        paymentIndex: props.paymentIndex,
        idempotencyKey: createAttempt.current.key,
      },
      "Intenção criada. O boundary persistido aguardará o adapter externo.",
    );
  }

  async function refreshIntent() {
    if (!intent || working) return;
    setWorking(true);
    props.onError("");
    try {
      const response = await fetch(
          `/api/erp/pdv/payment-intents?intentId=${encodeURIComponent(intent.id)}`,
          { cache: "no-store" },
        ),
        body = await responseBody(response);
      const next = parsePdvOperatorPaymentIntent(body.intent);
      if (!response.ok || !next)
        throw new Error(
          stringValue(body.error) ||
            "Resposta inválida ao consultar a intenção.",
        );
      props.onIntent(next);
      props.onNotice(
        next.status === "captured"
          ? "Captura confirmada pelo estado persistido; a venda pode ser concluída."
          : `Estado da intenção: ${next.status}.`,
      );
    } catch (error) {
      props.onError(
        error instanceof Error
          ? error.message
          : "Não foi possível consultar a intenção.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function retryIntent() {
    if (
      !intent ||
      working ||
      ![
        "created",
        "processing",
        "authorized",
        "unknown",
        "manual_review",
      ].includes(intent.status)
    )
      return;
    const attemptKey = `${intent.id}:${intent.version}`;
    retryAttempts.current[attemptKey] ||= crypto.randomUUID();
    await mutate(
      {
        action: "intent.retry",
        intentId: intent.id,
        expectedVersion: intent.version,
        idempotencyKey: retryAttempts.current[attemptKey],
      },
      "Retry persistido; nenhum resultado de captura foi presumido.",
    );
  }

  async function cancelIntent() {
    if (!intent || working || intent.status !== "created") return;
    const attemptKey = `${intent.id}:${intent.version}`;
    cancelAttempts.current[attemptKey] ||= crypto.randomUUID();
    await mutate(
      {
        action: "intent.cancel",
        intentId: intent.id,
        expectedVersion: intent.version,
        idempotencyKey: cancelAttempts.current[attemptKey],
      },
      "Intenção não despachada cancelada localmente.",
    );
  }

  function discardTerminalIntent() {
    createAttempt.current = { signature: "", key: crypto.randomUUID() };
    props.onIntent(null);
  }

  async function mutate(payload: Record<string, unknown>, notice: string) {
    setWorking(true);
    props.onError("");
    try {
      const response = await fetch("/api/erp/pdv/payment-intents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        body = await responseBody(response);
      const next = parsePdvOperatorPaymentIntent(body.intent);
      if (!response.ok || !next)
        throw new Error(
          stringValue(body.error) ||
            "Resposta inválida da intenção de pagamento.",
        );
      props.onIntent(next);
      props.onNotice(
        body.replayed ? "Operação idempotente recuperada." : notice,
      );
    } catch (error) {
      props.onError(
        error instanceof Error
          ? error.message
          : "Não foi possível operar a intenção de pagamento.",
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <section
      className={`pos-payment-intent ${intent?.status === "captured" ? "captured" : intent?.status === "unknown" || intent?.status === "manual_review" ? "uncertain" : ""}`}
      aria-label="Pagamento eletrônico persistido"
    >
      {!intent && (
        <div className="pos-payment-intent-config">
          <small>{paymentChannelGuidance(props.method)}</small>
          {props.connectors.length === 1 &&
          props.connectorId === props.connectors[0].id ? (
            <span className="pos-payment-channel-summary">
              {paymentChannelLabel(props.connectors[0])} ·{" "}
              {props.connectors[0].provider}
            </span>
          ) : (
            <select
              aria-label="Conector eletrônico"
              disabled={props.disabled || props.configurationLocked || working}
              value={props.connectorId}
              onChange={(event) => props.onConnectorId(event.target.value)}
            >
              <option value="">Escolha onde cobrar</option>
              {props.connectors.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  {paymentChannelLabel(connector)} · {connector.provider}
                  {connector.lastHealthOk === false ? " · indisponível" : ""}
                </option>
              ))}
            </select>
          )}
          {props.terminals.length === 1 &&
          props.terminalId === props.terminals[0].id ? (
            <span className="pos-payment-channel-summary">
              {props.terminals[0].name}
            </span>
          ) : (
            <select
              aria-label="Estação do PDV"
              disabled={props.disabled || props.configurationLocked || working}
              value={props.terminalId}
              onChange={(event) => props.onTerminalId(event.target.value)}
            >
              <option value="">Estação que inicia a cobrança</option>
              {props.terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.name} · {terminal.status}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={
              props.disabled ||
              props.createDisabled ||
              working ||
              !props.online ||
              !props.paymentPlanId ||
              props.amountCents <= 0 ||
              !props.connectorId ||
              !props.terminalId
            }
            onClick={() => void createIntent()}
          >
            {working
              ? "Preparando…"
              : props.method === "pix"
                ? "Gerar cobrança Pix"
                : "Iniciar cobrança"}
          </button>
        </div>
      )}
      {intent && (
        <div
          className="pos-payment-intent-state"
          role="status"
          aria-live="polite"
        >
          <div>
            <small>Intent provider-agnostic</small>
            <strong>{posPaymentIntentStatusLabel(intent.status)}</strong>
            <code>{intent.id}</code>
          </div>
          <small>{posPaymentIntentGuidance(intent)}</small>
          {intent.failureCode && (
            <small>
              Última ocorrência: {intent.failureCode}
              {intent.failureMessage ? ` · ${intent.failureMessage}` : ""}
            </small>
          )}
          {intent.artifacts.length > 0 && (
            <div className="pos-payment-artifacts">
              {intent.artifacts.map((artifact) => (
                <PaymentArtifact key={artifact.kind} artifact={artifact} />
              ))}
            </div>
          )}
          <div className="pos-payment-intent-actions">
            <button
              type="button"
              disabled={props.disabled || working}
              onClick={() => void refreshIntent()}
            >
              Atualizar
            </button>
            {[
              "created",
              "processing",
              "authorized",
              "unknown",
              "manual_review",
            ].includes(intent.status) && (
              <button
                type="button"
                disabled={props.disabled || working || !props.online}
                onClick={() => void retryIntent()}
              >
                Retry / consultar
              </button>
            )}
            {intent.status === "created" && (
              <button
                type="button"
                disabled={props.disabled || working}
                onClick={() => void cancelIntent()}
              >
                Cancelar antes do envio
              </button>
            )}
            {["cancelled", "declined"].includes(intent.status) && (
              <button
                type="button"
                disabled={props.disabled || working}
                onClick={discardTerminalIntent}
              >
                Descartar
              </button>
            )}
          </div>
          {locked && intent.status !== "captured" && (
            <small>
              O contexto desta divisão permanece bloqueado até um estado
              conclusivo ou cancelamento seguro.
            </small>
          )}
        </div>
      )}
      <small>
        O checkout acompanha o ledger provider-agnostic; QR, link ou instrução
        aparecem somente quando retornados pelo conector homologado.
      </small>
    </section>
  );
}

export function posPaymentIntentContextSignature(input: {
  sessionId: number;
  registerId: number;
  operatorProfileId: number;
  saleDraftId: string;
  paymentPlanId: string;
  paymentIndex: number;
  amountCents: number;
  method: string;
  installments: number;
  connectorId: string;
  terminalId: string;
}) {
  return JSON.stringify({
    sessionId: input.sessionId,
    registerId: input.registerId,
    operatorProfileId: input.operatorProfileId,
    saleDraftId: input.saleDraftId,
    paymentPlanId: input.paymentPlanId,
    paymentIndex: input.paymentIndex,
    amountCents: input.amountCents,
    method: input.method,
    installments: input.installments,
    connectorId: input.connectorId,
    terminalId: input.terminalId || null,
  });
}

export function isPdvPaymentIntentLocked(
  intent: PdvOperatorPaymentIntent | null,
) {
  return Boolean(intent && !["cancelled", "declined"].includes(intent.status));
}
export function isPdvPaymentIntentCaptured(
  intent: PdvOperatorPaymentIntent | null,
  signature: string,
) {
  return Boolean(
    intent &&
    intent.status === "captured" &&
    !intent.consumedAt &&
    intent.contextSignature === signature,
  );
}

export function parsePdvOperatorPaymentIntent(
  value: unknown,
): PdvOperatorPaymentIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = stringValue(item.id),
    status = stringValue(item.status),
    provider = stringValue(item.provider),
    connectorId = stringValue(item.connectorId),
    saleDraftId = stringValue(item.saleDraftId),
    paymentPlanId = stringValue(item.paymentPlanId),
    method = stringValue(item.method),
    currency = stringValue(item.currency);
  const numbers = [
    item.version,
    item.branchId,
    item.registerId,
    item.sessionId,
    item.operatorProfileId,
    item.paymentIndex,
    item.amountCents,
    item.installments,
  ];
  if (
    !id ||
    !status ||
    !provider ||
    !connectorId ||
    !saleDraftId ||
    !paymentPlanId ||
    !method ||
    currency !== "BRL" ||
    !numbers.every(Number.isSafeInteger)
  )
    return null;
  const terminalId =
    item.terminalId == null ? null : stringValue(item.terminalId);
  const artifacts = Array.isArray(item.artifacts)
    ? item.artifacts.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const artifact = raw as Record<string, unknown>,
          kind = stringValue(artifact.kind),
          value = stringValue(artifact.value);
        return kind && value
          ? [
              {
                kind,
                value,
                displayText:
                  artifact.displayText == null
                    ? null
                    : stringValue(artifact.displayText),
                expiresAt:
                  artifact.expiresAt == null
                    ? null
                    : stringValue(artifact.expiresAt),
              },
            ]
          : [];
      })
    : [];
  const normalized = {
    ...(item as Omit<PdvOperatorPaymentIntent, "contextSignature">),
    id,
    status,
    provider,
    connectorId,
    saleDraftId,
    paymentPlanId,
    method,
    currency,
    version: Number(item.version),
    branchId: Number(item.branchId),
    registerId: Number(item.registerId),
    sessionId: Number(item.sessionId),
    operatorProfileId: Number(item.operatorProfileId),
    paymentIndex: Number(item.paymentIndex),
    amountCents: Number(item.amountCents),
    installments: Number(item.installments),
    terminalId,
    providerReference:
      item.providerReference == null
        ? null
        : stringValue(item.providerReference),
    failureCode:
      item.failureCode == null ? null : stringValue(item.failureCode),
    failureMessage:
      item.failureMessage == null ? null : stringValue(item.failureMessage),
    unknownSince:
      item.unknownSince == null ? null : stringValue(item.unknownSince),
    nextReconcileAt:
      item.nextReconcileAt == null ? null : stringValue(item.nextReconcileAt),
    expiresAt: stringValue(item.expiresAt),
    consumedAt: item.consumedAt == null ? null : stringValue(item.consumedAt),
    artifacts,
  };
  return {
    ...normalized,
    contextSignature: posPaymentIntentContextSignature({
      ...normalized,
      terminalId: terminalId || "",
    }),
  };
}

function PaymentArtifact({
  artifact,
}: {
  artifact: PdvOperatorPaymentIntent["artifacts"][number];
}) {
  const link =
    artifact.kind === "payment_link" || artifact.kind === "pix_qr_url";
  return (
    <article>
      <strong>
        {artifact.displayText ||
          (artifact.kind === "pix_copy_paste"
            ? "Pix copia e cola"
            : artifact.kind === "payment_link"
              ? "Link de pagamento"
              : artifact.kind === "pix_qr_url"
                ? "QR Code Pix"
                : "Instrução do terminal")}
      </strong>
      {artifact.kind === "pix_qr_url" && (
        <img
          src={artifact.value}
          alt="QR Code para pagamento Pix"
          width="180"
          height="180"
        />
      )}
      {link ? (
        <a href={artifact.value} target="_blank" rel="noreferrer">
          Abrir pagamento
        </a>
      ) : (
        <code>{artifact.value}</code>
      )}
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(artifact.value)}
      >
        Copiar
      </button>
      {artifact.expiresAt && (
        <small>
          Expira em {new Date(artifact.expiresAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}
        </small>
      )}
    </article>
  );
}

function posPaymentIntentStatusLabel(status: string) {
  return (
    (
      {
        created: "Criada · aguardando dispatch",
        processing: "Processando",
        authorized: "Autorizada · aguardando captura",
        captured: "Capturada",
        declined: "Negada",
        unknown: "Resultado desconhecido",
        manual_review: "Revisão necessária",
        cancelled: "Cancelada",
        partially_refunded: "Parcialmente estornada",
        refunded: "Estornada",
      } as Record<string, string>
    )[status] || status
  );
}
function posPaymentIntentGuidance(intent: PdvOperatorPaymentIntent) {
  if (intent.status === "captured")
    return "A evidência capturada está pronta para vínculo atômico no commit desta venda.";
  if (intent.status === "unknown")
    return "Não repita a cobrança fora do fluxo. Atualize ou solicite retry de consulta até reconciliar.";
  if (intent.status === "manual_review")
    return "O worker esgotou a certeza automática. Não presuma sucesso nem refaça a cobrança.";
  if (intent.status === "authorized")
    return "Autorização não equivale a captura e ainda não permite concluir a venda.";
  if (intent.status === "processing" || intent.status === "created")
    return "Aguarde o adapter externo; nenhum pagamento foi presumido.";
  if (intent.status === "declined" || intent.status === "cancelled")
    return "Nenhuma captura foi aceita para esta intenção.";
  return "Consulte o estado persistido antes de qualquer nova ação.";
}

function paymentChannelLabel(connector: Connector) {
  const channel = String(connector.settings?.channel || connector.mode);
  return (
    (
      {
        api: "QR ou link",
        server: "QR ou link",
        tef: "TEF",
        local_agent: "Maquininha / agente local",
        smartpos: "SmartPOS",
        terminal: "Maquininha integrada",
      } as Record<string, string>
    )[channel] || channel
  );
}

function paymentChannelGuidance(method: string) {
  if (method === "pix")
    return "Escolha QR/link para exibir a cobrança neste checkout ou uma maquininha integrada. A venda só conclui após confirmação.";
  if (method === "credit")
    return "Escolha maquininha, TEF, SmartPOS ou link. Parcelas e captura serão confirmadas pelo conector.";
  return "Escolha o equipamento ou conector homologado que confirmará esta cobrança.";
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
