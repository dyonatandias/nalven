"use client";

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import Link from "next/link";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErpIcon } from "@/components/erp/erp-icon";
import styles from "./omnichannel-control-tower.module.css";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const date = tenantDateTimeFormatter({ dateStyle: "short" });
const dateTime = tenantDateTimeFormatter({ dateStyle: "short",
  timeStyle: "short",
});

type Product = {
  id: number;
  name: string;
  sku: string;
  gtin?: string | null;
  unit?: string;
  price: number;
  stock: number;
  cost: number;
  type: string;
};
type Credential = {
  id: string;
  label: string;
  enabled: boolean;
  sandbox: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  config?: unknown;
};
type WebhookEvent = {
  id: number;
  eventKey: string;
  eventType: string;
  state: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
};
type Listing = {
  id: number;
  channelId: number;
  productId: number;
  externalId: string;
  title: string;
  status: string;
  price: number;
  syncedStock: number;
  desiredPrice: number | null;
  desiredStock: number | null;
  syncState: string;
  syncMessage: string | null;
  lastSyncedAt: string | null;
  product: Product;
};
type ChannelOrder = {
  id: number;
  externalId: string;
  status: string;
  customerName: string;
  total: number;
  fee: number;
  commission: number;
  buyerShippingCost: number;
  sellerShippingCost: number;
  marketplaceStatus: string | null;
  paymentStatus: string;
  riskStatus: string;
  buyerCancelRequested: boolean;
  shipByAt: string | null;
  deliverByAt: string | null;
  cancelByAt: string | null;
  logisticType: string | null;
  invoiceStatus: string | null;
  importedAt: string;
  salesOrder: { id: number; number: string; status: string };
};
type Channel = {
  id: number;
  name: string;
  provider: string;
  status: string;
  environment: string;
  autoImport: boolean;
  stockBuffer: number;
  priceAdjustment: number;
  syncInterval: number;
  lastSyncStatus: string;
  lastSyncMessage: string | null;
  lastSyncAt: string | null;
  credentialId: string | null;
  credential: Credential | null;
  listings: Listing[];
  orders: ChannelOrder[];
  webhookEvents: WebhookEvent[];
};
type MarketplaceData = {
  channels: Channel[];
  products: Product[];
  credentials: Credential[];
  summary: {
    channels: number;
    connected: number;
    gmv: number;
    netRevenue: number;
    orders: number;
    errors: number;
    listingCoverage: number;
    listedProducts: number;
    catalogProducts: number;
    failedEvents: number;
    pendingEvents: number;
    staleChannels: number;
    operationalExceptions: number;
  };
  pagination: {
    listingsShown: number;
    ordersShown: number;
    perChannelLimit: number;
  };
};

type ShipmentItem = {
  id: number;
  quantity: number;
  pickedQuantity: number;
  shortQuantity: number;
  location: string | null;
  salesOrderItem: {
    id: number;
    productId: number;
    variationId: number | null;
    product: Product;
    variation: {
      id: number;
      sku: string | null;
      gtin: string | null;
      attributes: unknown;
    } | null;
  };
  pickAllocations: Array<{
    id: string;
    lotId: string | null;
    quantity: number;
    location: string | null;
    scannedCode: string | null;
    lot: {
      lotCode: string | null;
      serialNumber: string | null;
      expiresOn: string | null;
    } | null;
  }>;
};
type ShipmentEvent = {
  id: number;
  type: string;
  description: string;
  actor: string;
  createdAt: string;
};
type ShippingLabel = {
  id: number;
  provider: string;
  serviceName: string | null;
  carrier: string | null;
  status: string;
  amount: number;
  trackingCode: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
};
type OrderReturn = {
  id: number;
  reason: string;
  description: string;
  status: string;
  customerEmail: string;
  reverseProvider: string | null;
  reverseCode: string | null;
  reverseTrackingCode: string | null;
  reverseLabelUrl: string | null;
  reverseRequestedAt: string | null;
  requestedAt: string;
  items: Array<{
    id: number;
    orderItemId: number;
    quantity: number;
    receivedQuantity: number;
    condition: string;
    disposition: string;
    inspectedAt: string | null;
  }>;
};
type ShipmentPackage = {
  id: string;
  sequence: number;
  code: string;
  status: string;
  carrier: string | null;
  service: string | null;
  trackingCode: string | null;
  sscc: string | null;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  volumetricWeightKg: number;
  labelFormat: string | null;
  labelUrl: string | null;
  items: Array<{ shipmentItemId: number; quantity: number }>;
};
type ShipmentIncident = {
  id: string;
  category: string;
  severity: string;
  status: string;
  owner: string;
  description: string;
  dueAt: string;
  rootCause: string | null;
  resolution: string | null;
  claimCents: number;
  createdAt: string;
  resolvedAt: string | null;
};
type Shipment = {
  id: number;
  number: string;
  status: string;
  priority: string;
  carrier: string | null;
  service: string | null;
  trackingCode: string | null;
  freight: number;
  deadlineAt: string | null;
  dispatchDeadlineAt: string | null;
  packageCount: number;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  version: number;
  assignedTo: string | null;
  station: string | null;
  holdReason: string | null;
  fiscalRequired: boolean;
  fiscalStatus: string;
  quotedFreightCents: number | null;
  actualFreightCents: number | null;
  chargedFreightCents: number | null;
  packedBy: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveryRecipient: string | null;
  deliveryDocument: string | null;
  deliveryNotes: string | null;
  proofUrl: string | null;
  exceptionStatus: string;
  exceptionCategory: string | null;
  exceptionOwner: string | null;
  exceptionDueAt: string | null;
  exceptionResolvedAt: string | null;
  exceptionResolution: string | null;
  manifestNumber: string | null;
  manifestedAt: string | null;
  handoffAt: string | null;
  cancellationReason: string | null;
  warehouse: {
    id: number;
    name: string;
    branch: { id: number; name: string } | null;
  };
  salesOrder: {
    id: number;
    number: string;
    customerName: string;
    customerEmail: string | null;
    total: number;
    deliveryCity: string | null;
    deliveryState: string | null;
    deliveryZip: string | null;
    deliveryStreet: string | null;
    deliveryNumber: string | null;
    deliveryComplement: string | null;
    deliveryDistrict: string | null;
    shippingLabels: ShippingLabel[];
    tracking: {
      trackingUrl: string | null;
      events: Array<{ id: number; description: string; occurredAt: string }>;
    } | null;
    returns: OrderReturn[];
  };
  channelOrder: { channel: { name: string } } | null;
  items: ShipmentItem[];
  packages: ShipmentPackage[];
  incidents: ShipmentIncident[];
  waveEntries: Array<{
    id: string;
    status: string;
    wave: { id: string; number: string; status: string };
  }>;
  manifestEntries: Array<{
    id: string;
    manifest: { id: string; number: string; status: string };
  }>;
  events: ShipmentEvent[];
};
type AvailableOrder = {
  id: number;
  number: string;
  customerName: string;
  total: number;
  priority: string;
  channelOrder: { channel: { name: string } } | null;
  items: Array<{
    id: number;
    productId: number;
    variationId: number | null;
    name: string;
    sku: string;
    quantity: number;
    allocatedQuantity: number;
    remainingQuantity: number;
  }>;
};
type LogisticsData = {
  shipments: Shipment[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  availableOrders: AvailableOrder[];
  availableOrderCount: number;
  warehouses: Array<{ id: number; name: string }>;
  carriers: Array<{ key: string; label: string; urlTemplate: string | null }>;
  channels: Array<{ id: number; name: string; provider: string }>;
  manifests: Array<{
    id: string;
    number: string;
    carrier: string;
    status: string;
    totalPackages: number;
    totalWeightKg: number;
    pickupWindow: string | null;
    handedOffAt: string | null;
    _count: { shipments: number };
  }>;
  waves: Array<{
    id: string;
    number: string;
    status: string;
    assignedTo: string | null;
    createdAt: string;
    _count: { shipments: number };
  }>;
  branch: { id: number; name: string; timezone: string; crossBranch: boolean };
  summary: {
    pending: number;
    dispatched: number;
    late: number;
    dueToday: number;
    urgent: number;
    onTimeRate: number;
    shipOnTimeRate: number;
    otifRate: number;
    firstAttemptRate: number;
    averageCycleHours: number;
    averagePickingHours: number;
    averageTransitHours: number;
    freight: number;
    costPerShipment: number;
    incidents: number;
    exceptionRate: number;
    manifested: number;
    packageCount: number;
    labelCoverageRate: number;
    openReturns: number;
    bi: {
      statusDistribution: Array<{ status: string; count: number }>;
      dailyThroughput: Array<{
        date: string;
        created: number;
        delivered: number;
      }>;
      carrierScorecards: Array<{
        carrier: string;
        shipments: number;
        delivered: number;
        onTimeRate: number;
        averageFreight: number;
      }>;
      exceptionCauses: Array<{ category: string; count: number }>;
    };
  };
};

const CONTROL_TOWER_CACHE_TTL = 30_000;
const controlTowerCache = new Map<
  string,
  { data: unknown; storedAt: number }
>();

function useControlTower<T>(url: string, cacheNamespace?: string) {
  const cacheKey = cacheNamespace ? `${cacheNamespace}:${url}` : "";
  const cached = cacheKey ? controlTowerCache.get(cacheKey) : undefined;
  const [data, setData] = useState<T | null>(
    () => (cached?.data as T | undefined) || null,
  );
  const [dataScope, setDataScope] = useState(cacheNamespace);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const commandInFlightRef = useRef(false);
  const pendingAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const dataRef = useRef<T | null>(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const clearAccessData = useCallback((activeRead?: AbortController) => {
    if (requestRef.current !== activeRead) {
      requestRef.current?.abort();
      requestRef.current = null;
    }
    dataRef.current = null;
    setData(null);
    if (cacheNamespace)
      for (const key of controlTowerCache.keys())
        if (key.startsWith(`${cacheNamespace}:`)) controlTowerCache.delete(key);
  }, [cacheNamespace]);
  const load = useCallback(async () => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    if (dataRef.current) setRefreshing(true);
    setError("");
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: request.signal,
      });
      if (request.signal.aborted) return false;
      if (response.status === 401 || response.status === 403) clearAccessData(request);
      const body = await response.json();
      if (request.signal.aborted) return false;
      if (!response.ok)
        throw new Error(body.error || "Não foi possível carregar a operação.");
      dataRef.current = body as T;
      setData(body as T);
      setDataScope(cacheNamespace);
      if (cacheKey) {
        for (const [key, entry] of controlTowerCache)
          if (Date.now() - entry.storedAt >= CONTROL_TOWER_CACHE_TTL)
            controlTowerCache.delete(key);
        controlTowerCache.delete(cacheKey);
        controlTowerCache.set(cacheKey, {
          data: body,
          storedAt: Date.now(),
        });
        while (controlTowerCache.size > 40)
          controlTowerCache.delete(controlTowerCache.keys().next().value!);
      }
      return true;
    } catch (reason) {
      if (request.signal.aborted) return false;
      if (reason instanceof DOMException && reason.name === "AbortError")
        return false;
      setError(reason instanceof Error ? reason.message : "Falha ao carregar.");
      return false;
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setRefreshing(false);
      }
    }
  }, [cacheKey, cacheNamespace, clearAccessData, url]);
  useEffect(() => {
    const entry = cacheKey ? controlTowerCache.get(cacheKey) : undefined;
    const fresh =
      entry && Date.now() - entry.storedAt < CONTROL_TOWER_CACHE_TTL;
    const timer = window.setTimeout(() => {
      if (entry) {
        dataRef.current = entry.data as T;
        setData(entry.data as T);
        setDataScope(cacheNamespace);
      }
      if (fresh) {
        setError("");
        setRefreshing(false);
      }
      if (!fresh) void load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [cacheKey, cacheNamespace, load]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !busy && !commandInFlightRef.current) void load();
    };
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [busy, load]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const command = useCallback(
    async (
      payload: Record<string, unknown>,
      message: string,
      reload = true,
    ) => {
      if (commandInFlightRef.current) return false;
      commandInFlightRef.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const requestBody = JSON.stringify(payload);
        const fingerprint = JSON.stringify([cacheNamespace, url, requestBody]);
        if (pendingAttemptRef.current?.fingerprint !== fingerprint)
          pendingAttemptRef.current = {
            fingerprint,
            key: globalThis.crypto?.randomUUID?.() ||
              `nalven-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          };
        // A lost response does not mean the server rolled back. Retrying the
        // same command must confirm the original result, not execute it twice.
        const attempt = pendingAttemptRef.current;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": attempt.key,
          },
          body: requestBody,
        });
        if (response.status === 401 || response.status === 403) clearAccessData();
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "A operação não foi concluída.");
        pendingAttemptRef.current = null;
        // A command can move rows between filtered pages; all snapshots of this
        // resource in the current access scope must be revalidated.
        if (cacheNamespace) {
          const prefix = `${cacheNamespace}:${url.split("?")[0]}`;
          for (const key of controlTowerCache.keys())
            if (key === prefix || key.startsWith(`${prefix}?`))
              controlTowerCache.delete(key);
        }
        if (reload && !(await load())) {
          setError("A operação foi concluída, mas não foi possível atualizar os dados. Atualize a página antes de continuar; não repita o envio.");
          return true;
        }
        if (message) setNotice(message);
        return true;
      } catch (reason) {
        setError(
          reason instanceof TypeError
            ? "Não foi possível confirmar o resultado. Tente novamente sem alterar os dados para consultar o mesmo envio."
            : reason instanceof Error
            ? reason.message
            : "A operação não foi concluída.",
        );
        return false;
      } finally {
        commandInFlightRef.current = false;
        setBusy(false);
      }
    },
    [cacheNamespace, clearAccessData, load, url],
  );
  const clearFeedback = useCallback(() => {
    setError("");
    setNotice("");
  }, []);
  return {
    data: dataScope === cacheNamespace ? data : null,
    busy,
    refreshing,
    error,
    notice,
    load,
    command,
    clearFeedback,
  };
}

function useDismissActionMenus() {
  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      document
        .querySelectorAll<HTMLDetailsElement>(`.${styles.menu}[open]`)
        .forEach((menu) => {
          if (!menu.contains(target)) menu.open = false;
        });
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const open = document.querySelector<HTMLDetailsElement>(
        `.${styles.menu}[open]`,
      );
      if (!open) return;
      open.open = false;
      open.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
}

function Frame({
  title,
  eyebrow,
  description,
  flow,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  flow: string[];
  children: ReactNode;
}) {
  useDismissActionMenus();
  return (
    <div className={styles.frame}>
      <header className={styles.hero}>
        <div>
          <span>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <ol>
          {flow.map((item, index) => (
            <li key={item}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      </header>
      {children}
    </div>
  );
}

function Feedback({
  error,
  notice,
  close,
}: {
  error: string;
  notice: string;
  close: () => void;
}) {
  if (!error && !notice) return null;
  return (
    <div
      className={error ? styles.error : styles.notice}
      role={error ? "alert" : "status"}
    >
      <span>{error || notice}</span>
      <button type="button" onClick={close} aria-label="Fechar mensagem">
        ×
      </button>
    </div>
  );
}

function Metrics({ children }: { children: ReactNode }) {
  return <section className={styles.metrics}>{children}</section>;
}
function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "good" | "warning";
}) {
  return (
    <article data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
function Status({ value, kind = value }: { value: string; kind?: string }) {
  return (
    <span className={styles.status} data-status={kind}>
      {value}
    </span>
  );
}

export function OmnichannelMarketplaces({
  cacheNamespace,
}: {
  cacheNamespace: string;
}) {
  const api = useControlTower<MarketplaceData>(
    "/api/erp/marketplaces",
    cacheNamespace,
  );
  const [view, setView] = useState<
    "overview" | "channels" | "listings" | "orders" | "exceptions"
  >("overview");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [currentTime] = useState(() => Date.now());
  const [modal, setModal] = useState<{
    type: "channel" | "listing" | "order" | "orderState";
    channel?: Channel;
    order?: ChannelOrder;
  } | null>(null);
  const data = api.data;
  const listings = useMemo(
    () =>
      data?.channels.flatMap((channel) =>
        channel.listings.map((listing) => ({ ...listing, channel })),
      ) || [],
    [data],
  );
  const orders = useMemo(
    () =>
      data?.channels.flatMap((channel) =>
        channel.orders.map((order) => ({ ...order, channel })),
      ) || [],
    [data],
  );
  const normalized = query.trim().toLocaleLowerCase("pt-BR");
  const visibleListings = listings.filter(
    (item) =>
      (!normalized ||
        `${item.title} ${item.externalId} ${item.product.sku} ${item.channel.name}`
          .toLocaleLowerCase("pt-BR")
          .includes(normalized)) &&
      (filter === "all" || item.status === filter),
  );
  const visibleOrders = orders.filter(
    (item) =>
      (!normalized ||
        `${item.externalId} ${item.customerName} ${item.salesOrder.number} ${item.channel.name}`
          .toLocaleLowerCase("pt-BR")
          .includes(normalized)) &&
      (filter === "all" || item.status === filter),
  );
  const drifts = listings.filter(
    (item) =>
      Math.abs(
        item.syncedStock -
          (item.desiredStock ??
            Math.max(0, item.product.stock - item.channel.stockBuffer)),
      ) > 0.001 ||
      Math.abs(
        item.price -
          (item.desiredPrice ??
            targetPrice(item.product.price, item.channel.priceAdjustment)),
      ) > 0.01,
  );
  const failedEvents =
    data?.channels.flatMap((channel) =>
      channel.webhookEvents
        .filter((event) => event.state === "failed")
        .map((event) => ({ ...event, channel })),
    ) || [];
  const orderExceptions = orders.filter(
    (order) =>
      order.buyerCancelRequested ||
      ["review", "blocked"].includes(order.riskStatus) ||
      ["pending", "cancelled"].includes(order.paymentStatus) ||
      (order.status === "imported" &&
        Boolean(order.shipByAt) &&
        new Date(order.shipByAt!).getTime() < currentTime),
  );
  if (!data)
    return (
      <div className={styles.loading} role={api.error ? "alert" : "status"}>
        {api.error ? (
          <div className={styles.loadError}>
            <strong>Não foi possível carregar os canais</strong>
            <span>{api.error}</span>
            <button type="button" onClick={() => void api.load()}>
              Tentar novamente
            </button>
          </div>
        ) : (
          "Preparando a torre de controle omnicanal…"
        )}
      </div>
    );
  return (
    <Frame
      eyebrow="COMANDO OMNICANAL"
      title="Canais e marketplaces"
      description="Uma visão operacional de catálogo, preço, estoque, pedidos, taxas e integrações — do evento recebido ao pedido pronto para expedir."
      flow={["Conectar", "Publicar", "Vender", "Conciliar"]}
    >
      {(api.error || api.notice) && (
        <Feedback
          error={api.error}
          notice={api.notice}
          close={api.clearFeedback}
        />
      )}
      <Metrics>
        <Metric
          label="Receita líquida estimada"
          value={money.format(data.summary.netRevenue)}
          detail={`${money.format(data.summary.gmv)} em GMV`}
          tone="good"
        />
        <Metric
          label="Cobertura do catálogo"
          value={`${percent.format(data.summary.listingCoverage)}%`}
          detail={`${data.summary.listedProducts} de ${data.summary.catalogProducts} produtos publicados`}
        />
        <Metric
          label="Conexões saudáveis"
          value={`${data.summary.connected}/${data.summary.channels}`}
          detail="Credenciais testadas nos canais ativos"
          tone={
            data.summary.connected < data.summary.channels ? "warning" : "good"
          }
        />
        <Metric
          label="Exceções abertas"
          value={String(
            data.summary.errors +
              data.summary.failedEvents +
              data.summary.operationalExceptions +
              data.summary.staleChannels,
          )}
          detail={`${data.summary.operationalExceptions} pedidos · ${data.summary.staleChannels} canais atrasados`}
          tone={
            data.summary.failedEvents ||
            data.summary.operationalExceptions ||
            data.summary.staleChannels
              ? "warning"
              : "good"
          }
        />
      </Metrics>
      <section className={styles.workspace}>
        <header className={styles.toolbar}>
          <nav aria-label="Visões de canais">
            {(
              [
                "overview",
                "channels",
                "listings",
                "orders",
                "exceptions",
              ] as const
            ).map((key) => (
              <button
                key={key}
                type="button"
                className={view === key ? styles.active : ""}
                onClick={() => {
                  setView(key);
                  setFilter("all");
                }}
              >
                {
                  {
                    overview: "Visão geral",
                    channels: "Canais",
                    listings: "Anúncios",
                    orders: "Pedidos",
                    exceptions: "Exceções",
                  }[key]
                }
                {key === "exceptions" &&
                failedEvents.length + drifts.length > 0 ? (
                  <b>{failedEvents.length + drifts.length}</b>
                ) : null}
              </button>
            ))}
          </nav>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={api.refreshing || api.busy}
              onClick={() => void api.load()}
            >
              {api.refreshing ? "Atualizando…" : "Atualizar"}
            </button>
            <button
              type="button"
              onClick={() => setModal({ type: "listing" })}
              disabled={!data.channels.some((item) => item.status === "active")}
            >
              Novo anúncio
            </button>
            <button
              type="button"
              onClick={() => setModal({ type: "order" })}
              disabled={!data.channels.some((item) => item.status === "active")}
            >
              Importar pedido
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => setModal({ type: "channel" })}
            >
              Novo canal
            </button>
          </div>
        </header>
        {view !== "overview" && view !== "channels" && (
          <div className={styles.filters}>
            <label>
              <span className={styles.srOnly}>Buscar</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  view === "orders"
                    ? "Buscar pedido, cliente ou canal…"
                    : "Buscar anúncio, SKU ou canal…"
                }
              />
            </label>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label="Filtrar status"
            >
              <option value="all">Todos os status</option>
              {view === "orders" ? (
                <>
                  <option value="imported">Importado</option>
                  <option value="shipped">Despachado</option>
                  <option value="delivered">Entregue</option>
                </>
              ) : (
                <>
                  <option value="active">Ativo</option>
                  <option value="paused">Pausado</option>
                  <option value="error">Com erro</option>
                </>
              )}
            </select>
            <span>
              {view === "orders"
                ? `${visibleOrders.length} exibido(s) de ${data.summary.orders}`
                : view === "exceptions"
                  ? failedEvents.length + drifts.length
                  : visibleListings.length}{" "}
              {view === "orders" ? "" : "registro(s)"}
            </span>
          </div>
        )}
        {view === "overview" && (
          <MarketplaceOverview
            data={data}
            listings={listings}
            orders={orders}
            drifts={drifts}
            openChannel={(channel) => setModal({ type: "channel", channel })}
            sync={(channel) =>
              api.command(
                { action: "channel.sync", channelId: channel.id },
                `Alvos de ${channel.name} recalculados no ERP.`,
              )
            }
            busy={api.busy}
          />
        )}
        {view === "channels" && (
          <div className={styles.channelGrid}>
            {data.channels.map((channel) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                busy={api.busy}
                edit={() => setModal({ type: "channel", channel })}
                command={api.command}
              />
            ))}
            {!data.channels.length && (
              <Empty
                title="Nenhum canal cadastrado"
                detail="Conecte o primeiro canal para centralizar catálogo, pedidos e expedição."
              />
            )}
          </div>
        )}
        {view === "listings" && (
          <ListingTable
            rows={visibleListings}
            busy={api.busy}
            command={api.command}
          />
        )}
        {view === "orders" && (
          <OrderTable
            rows={visibleOrders}
            edit={(order) => setModal({ type: "orderState", order })}
          />
        )}
        {view === "exceptions" && (
          <MarketplaceExceptions
            drifts={drifts}
            events={failedEvents}
            orders={orderExceptions}
            editOrder={(order) => setModal({ type: "orderState", order })}
            busy={api.busy}
            command={api.command}
          />
        )}
      </section>
      {modal && (
        <MarketplaceModal
          modal={modal}
          data={data}
          busy={api.busy}
          error={api.error}
          close={() => setModal(null)}
          submit={async (payload) => {
            const action =
              modal.type === "channel"
                ? modal.channel
                  ? "channel.update"
                  : "channel.create"
                : modal.type === "listing"
                  ? "listing.upsert"
                  : modal.type === "order"
                    ? "order.import"
                    : "order.update";
            if (
              await api.command(
                {
                  action,
                  channelId: modal.channel?.id,
                  orderId: modal.order?.id,
                  ...payload,
                },
                modal.type === "order"
                  ? "Pedido importado e estoque reservado."
                  : modal.type === "orderState"
                    ? "Estado operacional do pedido atualizado."
                    : "Configuração omnicanal salva.",
              )
            )
              setModal(null);
          }}
        />
      )}
    </Frame>
  );
}

function MarketplaceOverview({
  data,
  listings,
  orders,
  drifts,
  openChannel,
  sync,
  busy,
}: {
  data: MarketplaceData;
  listings: Array<Listing & { channel: Channel }>;
  orders: Array<ChannelOrder & { channel: Channel }>;
  drifts: Array<Listing & { channel: Channel }>;
  openChannel: (channel: Channel) => void;
  sync: (channel: Channel) => void;
  busy: boolean;
}) {
  const gaps = data.products
    .filter(
      (product) =>
        !listings.some((listing) => listing.productId === product.id),
    )
    .slice(0, 6);
  return (
    <div className={styles.dashboardGrid}>
      <section className={styles.panel}>
        <header>
          <div>
            <span>DESEMPENHO POR CANAL</span>
            <h2>Operação e contribuição</h2>
          </div>
          <small>{orders.length} pedido(s)</small>
        </header>
        <div className={styles.performance}>
          {data.channels.map((channel) => {
            const gmv = channel.orders.reduce((sum, row) => sum + row.total, 0),
              net = channel.orders.reduce(
                (sum, row) =>
                  sum +
                  row.total +
                  row.buyerShippingCost -
                  (row.commission || row.fee) -
                  row.sellerShippingCost,
                0,
              );
            return (
              <article key={channel.id}>
                <div>
                  <ProviderMark provider={channel.provider} />
                  <span>
                    <strong>{channel.name}</strong>
                    <small>{connectionLabel(channel)}</small>
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>GMV</dt>
                    <dd>{money.format(gmv)}</dd>
                  </div>
                  <div>
                    <dt>Líquido</dt>
                    <dd>{money.format(net)}</dd>
                  </div>
                  <div>
                    <dt>Anúncios</dt>
                    <dd>{channel.listings.length}</dd>
                  </div>
                </dl>
                <footer>
                  <button type="button" onClick={() => openChannel(channel)}>
                    Configurar
                  </button>
                  <button
                    type="button"
                    className={styles.primaryText}
                    onClick={() => sync(channel)}
                    disabled={busy || channel.status !== "active"}
                  >
                    Recalcular alvos
                  </button>
                </footer>
              </article>
            );
          })}
          {!data.channels.length && (
            <Empty
              title="Comece conectando um canal"
              detail="As métricas aparecem assim que catálogo e pedidos forem vinculados."
            />
          )}
        </div>
      </section>
      <aside className={styles.stack}>
        <section className={styles.panel}>
          <header>
            <div>
              <span>SAÚDE DA OPERAÇÃO</span>
              <h2>Pontos de atenção</h2>
            </div>
          </header>
          <div className={styles.healthList}>
            <Health
              label="Divergências de preço/estoque"
              value={drifts.length}
              detail="Publicar e confirmar no conector"
            />
            <Health
              label="Eventos de integração falhos"
              value={data.summary.failedEvents}
              detail="Reprocessamento disponível"
            />
            <Health
              label="Eventos em processamento"
              value={data.summary.pendingEvents}
              detail="Fila idempotente monitorada"
            />
            <Health
              label="Canais sem conexão testada"
              value={Math.max(
                0,
                data.summary.channels - data.summary.connected,
              )}
              detail="Configure em Integrações"
            />
            <Health
              label="Canais com rotina atrasada"
              value={data.summary.staleChannels}
              detail="Intervalo de atualização vencido"
            />
          </div>
        </section>
        <section className={styles.panel}>
          <header>
            <div>
              <span>EXPANSÃO DO CATÁLOGO</span>
              <h2>Produtos sem anúncio</h2>
            </div>
            <b>
              {Math.max(
                0,
                data.summary.catalogProducts - data.summary.listedProducts,
              )}
            </b>
          </header>
          <div className={styles.compactList}>
            {gaps.map((product) => (
              <div key={product.id}>
                <span>
                  <strong>{product.name}</strong>
                  <small>
                    {product.sku} · saldo {number.format(product.stock)}
                  </small>
                </span>
                <b>{money.format(product.price)}</b>
              </div>
            ))}
            {!gaps.length && (
              <p className={styles.allGood}>
                Todo o catálogo ativo tem cobertura em ao menos um canal.
              </p>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function ChannelCard({
  channel,
  busy,
  edit,
  command,
}: {
  channel: Channel;
  busy: boolean;
  edit: () => void;
  command: (
    payload: Record<string, unknown>,
    message: string,
    reload?: boolean,
  ) => Promise<boolean>;
}) {
  const gmv = channel.orders.reduce((sum, item) => sum + item.total, 0);
  return (
    <article className={styles.channelCard}>
      <header>
        <ProviderMark provider={channel.provider} />
        <div>
          <small>{providerLabel(channel.provider)}</small>
          <h2>{channel.name}</h2>
        </div>
        <Status
          value={channel.status === "active" ? "Ativo" : "Pausado"}
          kind={channel.status}
        />
        <ActionMenu label={`Ações de ${channel.name}`}>
          <button type="button" onClick={edit}>
            Editar políticas
          </button>
          <button
            type="button"
            disabled={busy || channel.status !== "active"}
            onClick={() =>
              command(
                { action: "channel.sync", channelId: channel.id },
                `Alvos de ${channel.name} recalculados no ERP.`,
              )
            }
          >
            Recalcular alvos
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              command(
                { action: "channel.toggle", channelId: channel.id },
                channel.status === "active"
                  ? "Canal pausado."
                  : "Canal ativado.",
              )
            }
          >
            {channel.status === "active" ? "Pausar canal" : "Ativar canal"}
          </button>
        </ActionMenu>
      </header>
      <div
        className={styles.connection}
        data-ok={channel.credential?.lastTestOk === true}
      >
        <i />
        <span>
          <strong>{connectionLabel(channel)}</strong>
          <small>
            {channel.lastSyncMessage ||
              "Aguardando o primeiro cálculo de alvos."}
          </small>
        </span>
      </div>
      <dl className={styles.channelStats}>
        <div>
          <dt>Anúncios</dt>
          <dd>{channel.listings.length}</dd>
        </div>
        <div>
          <dt>Pedidos</dt>
          <dd>{channel.orders.length}</dd>
        </div>
        <div>
          <dt>GMV</dt>
          <dd>{money.format(gmv)}</dd>
        </div>
        <div>
          <dt>Última rotina</dt>
          <dd>
            {channel.lastSyncAt
              ? dateTime.format(new Date(channel.lastSyncAt))
              : "Pendente"}
          </dd>
        </div>
      </dl>
      <footer>
        <span>Buffer {number.format(channel.stockBuffer)} un.</span>
        <span>
          Preço {channel.priceAdjustment >= 0 ? "+" : ""}
          {percent.format(channel.priceAdjustment)}%
        </span>
        <span>A cada {channel.syncInterval} min</span>
      </footer>
    </article>
  );
}

function ListingTable({
  rows,
  busy,
  command,
}: {
  rows: Array<Listing & { channel: Channel }>;
  busy: boolean;
  command: (
    payload: Record<string, unknown>,
    message: string,
    reload?: boolean,
  ) => Promise<boolean>;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.marketplaceTable}>
        <thead>
          <tr>
            <th>Anúncio</th>
            <th>Canal</th>
            <th>Preço publicado</th>
            <th>Estoque publicado</th>
            <th>Sincronização</th>
            <th>
              <span className={styles.srOnly}>Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const targetStock =
                row.desiredStock ??
                Math.max(0, row.product.stock - row.channel.stockBuffer),
              target =
                row.desiredPrice ??
                targetPrice(row.product.price, row.channel.priceAdjustment),
              drift =
                Math.abs(row.syncedStock - targetStock) > 0.001 ||
                Math.abs(row.price - target) > 0.01;
            return (
              <tr key={row.id}>
                <td>
                  <strong>{row.title}</strong>
                  <small>
                    {row.externalId} · {row.product.sku}
                  </small>
                </td>
                <td>{row.channel.name}</td>
                <td>
                  <strong>{money.format(row.price)}</strong>
                  {Math.abs(row.price - target) > 0.01 && (
                    <small className={styles.warningText}>
                      Alvo {money.format(target)}
                    </small>
                  )}
                </td>
                <td>
                  <strong>{number.format(row.syncedStock)}</strong>
                  {Math.abs(row.syncedStock - targetStock) > 0.001 && (
                    <small className={styles.warningText}>
                      Alvo {number.format(targetStock)}
                    </small>
                  )}
                </td>
                <td>
                  <Status
                    value={
                      drift
                        ? "Divergente"
                        : row.syncState === "pending_external"
                          ? "Aguardando canal"
                          : row.syncState === "local_only"
                            ? "Somente ERP"
                            : row.status === "active"
                              ? "Em dia"
                              : statusLabel(row.status)
                    }
                    kind={
                      drift || row.syncState === "pending_external"
                        ? "warning"
                        : row.status
                    }
                  />
                  <small>
                    {row.syncMessage ||
                      (row.lastSyncedAt
                        ? `Observado em ${dateTime.format(new Date(row.lastSyncedAt))}`
                        : "Nunca observado no canal")}
                  </small>
                </td>
                <td>
                  <ActionMenu label={`Ações do anúncio ${row.title}`}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        command(
                          { action: "listing.toggle", listingId: row.id },
                          row.status === "paused"
                            ? "Anúncio ativado no ERP."
                            : "Anúncio pausado no ERP.",
                        )
                      }
                    >
                      {row.status === "paused" ? "Ativar" : "Pausar"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        command(
                          { action: "channel.sync", channelId: row.channel.id },
                          "Alvos do canal recalculados no ERP.",
                        )
                      }
                    >
                      Recalcular alvos
                    </button>
                  </ActionMenu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.marketplaceCards}>
        {rows.map((row) => {
          const targetStock =
              row.desiredStock ??
              Math.max(0, row.product.stock - row.channel.stockBuffer),
            target =
              row.desiredPrice ??
              targetPrice(row.product.price, row.channel.priceAdjustment),
            drift =
              Math.abs(row.syncedStock - targetStock) > 0.001 ||
              Math.abs(row.price - target) > 0.01;
          return (
            <article key={row.id}>
              <header>
                <span>
                  <strong>{row.title}</strong>
                  <small>
                    {row.product.sku} · {row.channel.name}
                  </small>
                </span>
                <Status
                  value={drift ? "Divergente" : statusLabel(row.status)}
                  kind={drift ? "warning" : row.status}
                />
              </header>
              <dl>
                <div>
                  <dt>Publicado</dt>
                  <dd>{money.format(row.price)}</dd>
                </div>
                <div>
                  <dt>Alvo</dt>
                  <dd>{money.format(target)}</dd>
                </div>
                <div>
                  <dt>Estoque</dt>
                  <dd>{number.format(row.syncedStock)}</dd>
                </div>
                <div>
                  <dt>Alvo</dt>
                  <dd>{number.format(targetStock)}</dd>
                </div>
              </dl>
              <footer>
                <small>
                  {row.syncMessage || "Estado externo não confirmado"}
                </small>
                <ActionMenu label={`Ações do anúncio ${row.title}`}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      command(
                        { action: "listing.toggle", listingId: row.id },
                        row.status === "paused"
                          ? "Anúncio ativado no ERP."
                          : "Anúncio pausado no ERP.",
                      )
                    }
                  >
                    {row.status === "paused" ? "Ativar" : "Pausar"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      command(
                        { action: "channel.sync", channelId: row.channel.id },
                        "Alvos do canal recalculados no ERP.",
                      )
                    }
                  >
                    Recalcular alvos
                  </button>
                </ActionMenu>
              </footer>
            </article>
          );
        })}
      </div>
      {!rows.length && (
        <Empty
          title="Nenhum anúncio encontrado"
          detail="Ajuste os filtros ou publique um produto em um canal ativo."
        />
      )}
    </div>
  );
}

function OrderTable({
  rows,
  edit,
}: {
  rows: Array<ChannelOrder & { channel: Channel }>;
  edit: (order: ChannelOrder) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.marketplaceTable}>
        <thead>
          <tr>
            <th>Pedido</th>
            <th>Cliente</th>
            <th>Canal</th>
            <th>GMV</th>
            <th>Custos do canal</th>
            <th>Líquido estimado</th>
            <th>Pagamento / risco</th>
            <th>Prazo operacional</th>
            <th>Status</th>
            <th>
              <span className={styles.srOnly}>Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const costs = (row.commission || row.fee) + row.sellerShippingCost,
              net = row.total + row.buyerShippingCost - costs;
            return (
              <tr key={row.id}>
                <td>
                  <strong>{row.externalId}</strong>
                  <small>
                    {row.salesOrder.number} ·{" "}
                    {date.format(new Date(row.importedAt))}
                  </small>
                </td>
                <td>{row.customerName}</td>
                <td>
                  <strong>{row.channel.name}</strong>
                  <small>{row.logisticType || "Logística padrão"}</small>
                </td>
                <td>{money.format(row.total)}</td>
                <td>
                  <strong>{money.format(costs)}</strong>
                  <small>Comissão + frete vendedor</small>
                </td>
                <td>
                  <strong>{money.format(net)}</strong>
                  <small>
                    {row.total ? percent.format((net / row.total) * 100) : "0"}%
                    do GMV
                  </small>
                </td>
                <td>
                  <Status
                    value={paymentStatusLabel(row.paymentStatus)}
                    kind={
                      ["paid", "refunded"].includes(row.paymentStatus)
                        ? "active"
                        : "warning"
                    }
                  />
                  <small>Risco: {riskStatusLabel(row.riskStatus)}</small>
                </td>
                <td>
                  <strong>
                    {row.shipByAt
                      ? dateTime.format(new Date(row.shipByAt))
                      : "Sem limite"}
                  </strong>
                  <small>
                    {row.buyerCancelRequested
                      ? "Cancelamento solicitado pelo cliente"
                      : row.deliverByAt
                        ? `Entrega até ${date.format(new Date(row.deliverByAt))}`
                        : "Entrega não informada"}
                  </small>
                </td>
                <td>
                  <Status value={orderStatus(row.status)} kind={row.status} />
                  <small>
                    {row.invoiceStatus
                      ? `Fiscal: ${row.invoiceStatus}`
                      : "Fiscal não informado"}
                  </small>
                </td>
                <td>
                  <ActionMenu label={`Ações do pedido ${row.externalId}`}>
                    <button type="button" onClick={() => edit(row)}>
                      Atualizar estado operacional
                    </button>
                  </ActionMenu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.marketplaceCards}>
        {rows.map((row) => {
          const costs = (row.commission || row.fee) + row.sellerShippingCost,
            net = row.total + row.buyerShippingCost - costs;
          return (
            <article
              key={row.id}
              data-alert={
                orderExceptionLabel(row) !== "revisão operacional necessária"
              }
            >
              <header>
                <span>
                  <strong>{row.externalId}</strong>
                  <small>
                    {row.salesOrder.number} · {row.channel.name}
                  </small>
                </span>
                <Status value={orderStatus(row.status)} kind={row.status} />
              </header>
              <p>{row.customerName}</p>
              <dl>
                <div>
                  <dt>GMV</dt>
                  <dd>{money.format(row.total)}</dd>
                </div>
                <div>
                  <dt>Líquido</dt>
                  <dd>{money.format(net)}</dd>
                </div>
                <div>
                  <dt>Pagamento</dt>
                  <dd>{paymentStatusLabel(row.paymentStatus)}</dd>
                </div>
                <div>
                  <dt>Risco</dt>
                  <dd>{riskStatusLabel(row.riskStatus)}</dd>
                </div>
              </dl>
              <footer>
                <small>
                  {row.buyerCancelRequested
                    ? "Cancelamento solicitado pelo cliente"
                    : row.shipByAt
                      ? `Despachar até ${dateTime.format(new Date(row.shipByAt))}`
                      : "Prazo de despacho não informado"}
                </small>
                <button type="button" onClick={() => edit(row)}>
                  Atualizar estado
                </button>
              </footer>
            </article>
          );
        })}
      </div>
      {!rows.length && (
        <Empty
          title="Nenhum pedido encontrado"
          detail="Os pedidos importados aparecem aqui com taxas e receita líquida."
        />
      )}
    </div>
  );
}

function MarketplaceExceptions({
  drifts,
  events,
  orders,
  editOrder,
  busy,
  command,
}: {
  drifts: Array<Listing & { channel: Channel }>;
  events: Array<WebhookEvent & { channel: Channel }>;
  orders: Array<ChannelOrder & { channel: Channel }>;
  editOrder: (order: ChannelOrder) => void;
  busy: boolean;
  command: (
    payload: Record<string, unknown>,
    message: string,
    reload?: boolean,
  ) => Promise<boolean>;
}) {
  return (
    <div className={styles.exceptionGrid}>
      <section className={styles.panel}>
        <header>
          <div>
            <span>CATÁLOGO</span>
            <h2>Divergências para publicar</h2>
          </div>
          <b>{drifts.length}</b>
        </header>
        <div className={styles.exceptionList}>
          {drifts.map((row) => (
            <article key={row.id}>
              <Status value="Divergente" kind="warning" />
              <div>
                <strong>{row.title}</strong>
                <small>
                  {row.channel.name} · {row.product.sku}
                </small>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  command(
                    { action: "channel.sync", channelId: row.channel.id },
                    `Alvos de ${row.channel.name} recalculados.`,
                  )
                }
              >
                Recalcular
              </button>
            </article>
          ))}
          {!drifts.length && (
            <Empty
              title="Catálogo sem divergências"
              detail="Os estados observados estão alinhados aos alvos do ERP."
            />
          )}
        </div>
      </section>
      <section className={styles.panel}>
        <header>
          <div>
            <span>PEDIDOS</span>
            <h2>Risco, pagamento e prazo</h2>
          </div>
          <b>{orders.length}</b>
        </header>
        <div className={styles.exceptionList}>
          {orders.map((order) => (
            <article key={order.id}>
              <Status value="Ação necessária" kind="warning" />
              <div>
                <strong>
                  {order.externalId} · {order.customerName}
                </strong>
                <small>
                  {order.channel.name} · {orderExceptionLabel(order)}
                </small>
              </div>
              <button type="button" onClick={() => editOrder(order)}>
                Tratar
              </button>
            </article>
          ))}
          {!orders.length && (
            <Empty
              title="Pedidos sob controle"
              detail="Nenhum bloqueio de risco, pagamento, cancelamento ou prazo."
            />
          )}
        </div>
      </section>
      <section className={styles.panel}>
        <header>
          <div>
            <span>INTEGRAÇÕES</span>
            <h2>Eventos que exigem ação</h2>
          </div>
          <b>{events.length}</b>
        </header>
        <div className={styles.exceptionList}>
          {events.map((event) => (
            <article key={event.id}>
              <Status value="Falhou" kind="error" />
              <div>
                <strong>{event.eventType}</strong>
                <small>
                  {event.channel.name} · tentativa {event.attempts}
                  {event.lastError ? ` · ${event.lastError}` : ""}
                </small>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  command(
                    { action: "webhook.retry", eventId: event.id },
                    "Evento agendado para reprocessamento.",
                  )
                }
              >
                Reprocessar
              </button>
            </article>
          ))}
          {!events.length && (
            <Empty
              title="Fila saudável"
              detail="Nenhum evento de integração com falha."
            />
          )}
        </div>
      </section>
    </div>
  );
}

function MarketplaceModal({
  modal,
  data,
  busy,
  error,
  close,
  submit,
}: {
  modal: {
    type: "channel" | "listing" | "order" | "orderState";
    channel?: Channel;
    order?: ChannelOrder;
  };
  data: MarketplaceData;
  busy: boolean;
  error: string;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [rows, setRows] = useState([
    { productId: "", quantity: "1", unitPrice: "0" },
  ]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await submit(modal.type === "order" ? { ...values, items: rows } : values);
  };
  const activeChannels = data.channels.filter(
    (channel) => channel.status === "active",
  );
  return (
    <Modal
      title={
        modal.type === "channel"
          ? modal.channel
            ? "Configurar canal"
            : "Conectar novo canal"
          : modal.type === "listing"
            ? "Publicar anúncio"
            : modal.type === "order"
              ? "Importar pedido externo"
              : `Atualizar pedido ${modal.order?.externalId || ""}`
      }
      eyebrow="OPERAÇÃO OMNICANAL"
      close={close}
      busy={busy}
      error={error}
    >
      <form onSubmit={save} className={styles.form}>
        {modal.type === "channel" && (
          <>
            <Field label="Nome do canal">
              <input name="name" defaultValue={modal.channel?.name} required />
            </Field>
            <Field label="Plataforma">
              <select
                name="provider"
                defaultValue={modal.channel?.provider || "mercado_livre"}
              >
                {[
                  "mercado_livre",
                  "shopee",
                  "woocommerce",
                  "shopify",
                  "amazon",
                  "magalu",
                  "nuvemshop",
                  "tiktok_shop",
                  "other",
                ].map((provider) => (
                  <option value={provider} key={provider}>
                    {providerLabel(provider)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ambiente">
              <select
                name="environment"
                defaultValue={modal.channel?.environment || "production"}
              >
                <option value="production">Produção</option>
                <option value="sandbox">Homologação / sandbox</option>
              </select>
            </Field>
            <Field label="Credencial segura">
              <select
                name="credentialId"
                defaultValue={modal.channel?.credentialId || ""}
              >
                <option value="">Sem conector externo</option>
                {data.credentials
                  .filter((credential) => credential.enabled)
                  .map((credential) => (
                    <option value={credential.id} key={credential.id}>
                      {credential.label || "Conta marketplace"}
                      {credential.lastTestOk === true
                        ? " · testada"
                        : " · teste pendente"}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Estoque de segurança">
              <input
                name="stockBuffer"
                type="number"
                min="0"
                step=".01"
                defaultValue={modal.channel?.stockBuffer || 0}
              />
            </Field>
            <Field label="Ajuste de preço (%)">
              <input
                name="priceAdjustment"
                type="number"
                min="-90"
                max="500"
                step=".01"
                defaultValue={modal.channel?.priceAdjustment || 0}
              />
            </Field>
            <Field label="Intervalo de atualização (min)">
              <input
                name="syncInterval"
                type="number"
                min="1"
                max="1440"
                defaultValue={modal.channel?.syncInterval || 15}
              />
            </Field>
            <label className={styles.toggle}>
              <input
                name="autoImport"
                type="checkbox"
                defaultChecked={modal.channel?.autoImport ?? true}
              />
              <span>
                <strong>Importar pedidos automaticamente</strong>
                <small>
                  A ingestão ainda respeita idempotência e reserva de estoque.
                </small>
              </span>
            </label>
            <p className={styles.formNote}>
              Credenciais e OAuth são gerenciados em{" "}
              <Link href="/erp/integracoes">Integrações</Link>. Sem uma conta
              testada, os alvos permanecem apenas no ERP.
            </p>
          </>
        )}
        {modal.type === "listing" && (
          <>
            <Field label="Canal">
              <select name="channelId" required>
                <option value="">Selecione</option>
                {activeChannels.map((channel) => (
                  <option value={channel.id} key={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Produto">
              <select
                name="productId"
                required
                onChange={(event) => {
                  const product = data.products.find(
                    (item) => item.id === Number(event.target.value),
                  );
                  const form = event.currentTarget.form;
                  if (product && form) {
                    const title = form.elements.namedItem(
                        "title",
                      ) as HTMLInputElement | null,
                      priceInput = form.elements.namedItem(
                        "price",
                      ) as HTMLInputElement | null;
                    if (title && !title.value) title.value = product.name;
                    if (priceInput) priceInput.value = String(product.price);
                  }
                }}
              >
                <option value="">Selecione</option>
                {data.products.map((product) => (
                  <option value={product.id} key={product.id}>
                    {product.name} · {product.sku}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Código externo">
              <input name="externalId" required />
            </Field>
            <Field label="Preço inicial">
              <input name="price" type="number" min="0" step=".01" required />
            </Field>
            <Field label="Título do anúncio" wide>
              <input name="title" required />
            </Field>
          </>
        )}
        {modal.type === "order" && (
          <>
            <Field label="Canal">
              <select name="channelId" required>
                <option value="">Selecione</option>
                {activeChannels.map((channel) => (
                  <option value={channel.id} key={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pedido externo">
              <input name="externalId" required />
            </Field>
            <Field label="Cliente">
              <input name="customerName" required />
            </Field>
            <Field label="CPF/CNPJ">
              <input name="customerDocument" />
            </Field>
            <Field label="E-mail">
              <input name="customerEmail" type="email" />
            </Field>
            <Field label="Telefone">
              <input name="customerPhone" />
            </Field>
            <Field label="Status do pagamento">
              <select name="paymentStatus" defaultValue="paid">
                <option value="paid">Pago no canal</option>
                <option value="pending">Pendente</option>
                <option value="partially_refunded">Estorno parcial</option>
                <option value="refunded">Estornado</option>
                <option value="cancelled">Cancelado</option>
                <option value="unknown">Não informado</option>
              </select>
            </Field>
            <Field label="Análise de risco">
              <select name="riskStatus" defaultValue="approved">
                <option value="approved">Aprovado</option>
                <option value="review">Em análise</option>
                <option value="blocked">Bloqueado</option>
                <option value="unknown">Não informado</option>
              </select>
            </Field>
            <Field label="Status no canal">
              <input
                name="marketplaceStatus"
                placeholder="paid / ready_to_ship"
              />
            </Field>
            <Field label="Modelo logístico">
              <input
                name="logisticType"
                placeholder="fulfillment / cross_docking"
              />
            </Field>
            <Field label="Despachar até">
              <input name="shipByAt" type="datetime-local" />
            </Field>
            <Field label="Entregar até">
              <input name="deliverByAt" type="datetime-local" />
            </Field>
            <Field label="Cancelar automaticamente em">
              <input name="cancelByAt" type="datetime-local" />
            </Field>
            <Field label="Status fiscal">
              <input name="invoiceStatus" placeholder="pending / authorized" />
            </Field>
            <label className={styles.toggle}>
              <input name="buyerCancelRequested" type="checkbox" />
              <span>
                <strong>Cliente solicitou cancelamento</strong>
                <small>Destaca o pedido na fila de exceções.</small>
              </span>
            </label>
            <Field label="Comissão/taxa">
              <input
                name="commission"
                type="number"
                min="0"
                step=".01"
                defaultValue="0"
              />
            </Field>
            <Field label="Frete pago pelo cliente">
              <input
                name="buyerShippingCost"
                type="number"
                min="0"
                step=".01"
                defaultValue="0"
              />
            </Field>
            <Field label="Frete pago pela empresa">
              <input
                name="sellerShippingCost"
                type="number"
                min="0"
                step=".01"
                defaultValue="0"
              />
            </Field>
            <Field label="CEP">
              <input name="deliveryZip" inputMode="numeric" />
            </Field>
            <Field label="Endereço" wide>
              <input name="deliveryStreet" />
            </Field>
            <Field label="Número">
              <input name="deliveryNumber" />
            </Field>
            <Field label="Bairro">
              <input name="deliveryDistrict" />
            </Field>
            <Field label="Cidade">
              <input name="deliveryCity" />
            </Field>
            <Field label="UF">
              <input name="deliveryState" maxLength={2} />
            </Field>
            <section className={styles.lines}>
              <header>
                <strong>Itens do pedido</strong>
                <button
                  type="button"
                  onClick={() =>
                    setRows((current) => [
                      ...current,
                      { productId: "", quantity: "1", unitPrice: "0" },
                    ])
                  }
                >
                  Adicionar item
                </button>
              </header>
              {rows.map((row, index) => (
                <div key={index}>
                  <select
                    value={row.productId}
                    required
                    aria-label={`Produto ${index + 1}`}
                    onChange={(event) => {
                      const product = data.products.find(
                        (item) => item.id === Number(event.target.value),
                      );
                      setRows((current) =>
                        current.map((item, position) =>
                          position === index
                            ? {
                                ...item,
                                productId: event.target.value,
                                unitPrice: String(product?.price || 0),
                              }
                            : item,
                        ),
                      );
                    }}
                  >
                    <option value="">Produto</option>
                    {data.products.map((product) => (
                      <option value={product.id} key={product.id}>
                        {product.name} · {product.sku}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Quantidade ${index + 1}`}
                    value={row.quantity}
                    type="number"
                    min=".0001"
                    step=".0001"
                    required
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((item, position) =>
                          position === index
                            ? { ...item, quantity: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <input
                    aria-label={`Preço ${index + 1}`}
                    value={row.unitPrice}
                    type="number"
                    min="0"
                    step=".01"
                    required
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((item, position) =>
                          position === index
                            ? { ...item, unitPrice: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label={`Remover item ${index + 1}`}
                    disabled={rows.length === 1}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>
          </>
        )}
        {modal.type === "orderState" && modal.order && (
          <>
            <Field label="Status do pagamento">
              <select
                name="paymentStatus"
                defaultValue={modal.order.paymentStatus}
              >
                <option value="paid">Pago no canal</option>
                <option value="pending">Pendente</option>
                <option value="partially_refunded">Estorno parcial</option>
                <option value="refunded">Estornado</option>
                <option value="cancelled">Cancelado</option>
                <option value="unknown">Não informado</option>
              </select>
            </Field>
            <Field label="Análise de risco">
              <select name="riskStatus" defaultValue={modal.order.riskStatus}>
                <option value="approved">Aprovado</option>
                <option value="review">Em análise</option>
                <option value="blocked">Bloqueado</option>
                <option value="unknown">Não informado</option>
              </select>
            </Field>
            <Field label="Status no canal">
              <input
                name="marketplaceStatus"
                defaultValue={modal.order.marketplaceStatus || ""}
              />
            </Field>
            <Field label="Status fiscal">
              <input
                name="invoiceStatus"
                defaultValue={modal.order.invoiceStatus || ""}
              />
            </Field>
            <Field label="Despachar até">
              <input
                name="shipByAt"
                type="datetime-local"
                defaultValue={dateTimeInput(modal.order.shipByAt)}
              />
            </Field>
            <Field label="Entregar até">
              <input
                name="deliverByAt"
                type="datetime-local"
                defaultValue={dateTimeInput(modal.order.deliverByAt)}
              />
            </Field>
            <Field label="Cancelar automaticamente em">
              <input
                name="cancelByAt"
                type="datetime-local"
                defaultValue={dateTimeInput(modal.order.cancelByAt)}
              />
            </Field>
            <label className={styles.toggle}>
              <input
                name="buyerCancelRequested"
                type="checkbox"
                defaultChecked={modal.order.buyerCancelRequested}
              />
              <span>
                <strong>Cliente solicitou cancelamento</strong>
                <small>Bloqueia a entrada na expedição.</small>
              </span>
            </label>
            <p className={styles.formNote}>
              Apenas pedidos pagos, aprovados no risco e sem pedido de
              cancelamento ficam disponíveis para expedição.
            </p>
          </>
        )}
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className={styles.primary} disabled={busy}>
            {busy ? "Processando…" : "Salvar e continuar"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

type LogisticsView =
  "queue" | "board" | "sla" | "operations" | "performance" | "history";

type LogisticsModalType =
  | "create"
  | "pick"
  | "pack"
  | "dispatch"
  | "deliver"
  | "incident"
  | "resolve"
  | "tracking"
  | "return"
  | "returnState"
  | "returnInspect"
  | "cancel"
  | "manifest";

export function OmnichannelLogistics({
  cacheNamespace,
}: {
  cacheNamespace: string;
}) {
  useDismissActionMenus();
  const [view, setView] = useState<LogisticsView>("queue");
  const [query, setQuery] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  const [status, setStatus] = useState("open");
  const [warehouse, setWarehouse] = useState("");
  const [channel, setChannel] = useState("");
  const [carrier, setCarrier] = useState("");
  const [priority, setPriority] = useState("");
  const [incident, setIncident] = useState("");
  const [sla, setSla] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [selectionMode, setSelectionMode] = useState<"wave" | "manifest">(
    "wave",
  );
  const [modal, setModal] = useState<{
    type: LogisticsModalType;
    shipment?: Shipment;
    shipmentIds?: number[];
  } | null>(null);
  const endpoint = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      status,
      q: serverQuery,
    });
    if (warehouse) params.set("warehouse", warehouse);
    if (channel) params.set("channel", channel);
    if (carrier) params.set("carrier", carrier);
    if (priority) params.set("priority", priority);
    if (incident) params.set("incident", incident);
    if (sla) params.set("sla", sla);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/api/erp/logistics?${params.toString()}`;
  }, [
    page,
    status,
    serverQuery,
    warehouse,
    channel,
    carrier,
    priority,
    incident,
    sla,
    from,
    to,
  ]);
  const api = useControlTower<LogisticsData>(endpoint, cacheNamespace);
  const data = api.data;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setServerQuery(query.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  const filtered = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return data.shipments
      .filter(
        (shipment) =>
          (!normalized ||
            `${shipment.number} ${shipment.salesOrder.number} ${shipment.salesOrder.customerName} ${shipment.trackingCode || ""} ${shipment.channelOrder?.channel.name || ""}`
              .toLocaleLowerCase("pt-BR")
              .includes(normalized)) &&
          (status === "all" ||
            (status === "open"
              ? !["delivered", "cancelled"].includes(shipment.status)
              : shipment.status === status)),
      )
      .sort((left, right) => shipmentScore(right) - shipmentScore(left));
  }, [data, query, status]);
  const eligibleIds = useMemo(
    () =>
      filtered
        .filter(
          (shipment) =>
            shipment.status === "picking" &&
            shipment.items.some((item) => item.pickedQuantity < item.quantity),
        )
        .map((shipment) => shipment.id),
    [filtered],
  );
  const manifestEligibleIds = useMemo(
    () =>
      filtered
        .filter(
          (shipment) =>
            ["packed", "dispatched"].includes(shipment.status) &&
            !shipment.manifestNumber,
        )
        .map((shipment) => shipment.id),
    [filtered],
  );
  if (!data)
    return (
      <div className={styles.loading} role={api.error ? "alert" : "status"}>
        {api.error ? (
          <div className={styles.loadError}>
            <strong>Não foi possível carregar a expedição</strong>
            <span>{api.error}</span>
            <button type="button" onClick={() => void api.load()}>
              Tentar novamente
            </button>
          </div>
        ) : (
          "Organizando a central de expedição…"
        )}
      </div>
    );
  const wave = async () => {
    const shipmentIds = selected.filter((id) => eligibleIds.includes(id));
    if (
      shipmentIds.length &&
      (await api.command(
        { action: "pick.wave", shipmentIds },
        `Onda criada para ${shipmentIds.length} expedição(ões). A leitura e a conferência continuam pendentes.`,
      ))
    )
      setSelected([]);
  };
  const openManifest = () => {
    const shipmentIds = selected.filter((id) =>
      manifestEligibleIds.includes(id),
    );
    if (shipmentIds.length) setModal({ type: "manifest", shipmentIds });
  };
  const changeView = (next: LogisticsView) => {
    setView(next);
    setPage(1);
    setSelected([]);
    if (["history", "performance"].includes(next) && status === "open")
      setStatus("all");
    if (next === "sla" && status === "all") setStatus("open");
  };
  const hasAdvancedFilters = Boolean(
    warehouse ||
    channel ||
    carrier ||
    priority ||
    incident ||
    sla ||
    from ||
    to,
  );
  const clearFilters = () => {
    setQuery("");
    setStatus(view === "history" || view === "performance" ? "all" : "open");
    setWarehouse("");
    setChannel("");
    setCarrier("");
    setPriority("");
    setIncident("");
    setSla("");
    setFrom("");
    setTo("");
    setPage(1);
    setSelected([]);
  };
  const applyFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
    setSelected([]);
  };
  const selectableIds =
    selectionMode === "wave" ? eligibleIds : manifestEligibleIds;
  const visibleSelectedIds = selected.filter((id) => selectableIds.includes(id));
  const allEligibleSelected =
    selectableIds.length > 0 && visibleSelectedIds.length === selectableIds.length;
  return (
    <div className={`${styles.frame} ${styles.logisticsFrame}`}>
      <section className={styles.logisticsIntro}>
        <div>
          <span>FULFILLMENT E ENTREGA</span>
          <h2>Central de execução logística</h2>
          <p>
            A fila é priorizada por prazo e urgência. Cada avanço mantém a
            conferência, o estoque e o rastreio sincronizados.
          </p>
          <small className={styles.branchScope}>
            {data.branch.name} · {data.branch.timezone}
            {data.branch.crossBranch
              ? " · visão entre filiais autorizada"
              : " · dados desta filial"}
          </small>
        </div>
        <ol aria-label="Etapas da expedição">
          {["Separar", "Embalar", "Despachar", "Entregar"].map(
            (step, index) => (
              <li key={step}>
                <b>{index + 1}</b>
                <span>{step}</span>
              </li>
            ),
          )}
        </ol>
      </section>
      {(api.error || api.notice) && (
        <Feedback
          error={api.error}
          notice={api.notice}
          close={api.clearFeedback}
        />
      )}
      <Metrics>
        <Metric
          label="Fila em preparação"
          value={String(data.summary.pending)}
          detail={`${data.availableOrders.length} pedido(s) aguardam expedição`}
        />
        <Metric
          label="OTIF"
          value={`${percent.format(data.summary.otifRate)}%`}
          detail={`${percent.format(data.summary.shipOnTimeRate)}% despachado no prazo`}
          tone={data.summary.otifRate < 90 ? "warning" : "good"}
        />
        <Metric
          label="SLA de entrega"
          value={`${percent.format(data.summary.onTimeRate)}%`}
          detail={`${data.summary.late} atrasada(s) · ${data.summary.dueToday} vence(m) hoje`}
          tone={data.summary.late ? "warning" : "good"}
        />
        <Metric
          label="Em transporte"
          value={String(data.summary.dispatched)}
          detail={`${data.summary.urgent} prioridade(s) urgente(s)`}
        />
        <Metric
          label="Custo por envio"
          value={money.format(data.summary.costPerShipment)}
          detail={`${percent.format(data.summary.averageCycleHours)} h de ciclo médio`}
        />
        <Metric
          label="Ocorrências abertas"
          value={String(data.summary.incidents)}
          detail={`${data.summary.openReturns} reversa(s) em andamento`}
          tone={data.summary.incidents ? "warning" : "good"}
        />
        <Metric
          label="Cobertura de etiquetas"
          value={`${percent.format(data.summary.labelCoverageRate)}%`}
          detail={`${data.summary.manifested}/${data.summary.packageCount} volumes em romaneio`}
          tone={data.summary.labelCoverageRate < 100 ? "warning" : "good"}
        />
      </Metrics>
      <section className={styles.workspace} aria-busy={api.refreshing}>
        <header className={styles.toolbar}>
          <div className={styles.logisticsHeading}>
            <strong>Operação diária</strong>
            <small>
              {api.refreshing
                ? "Atualizando dados…"
                : "Dados operacionais atualizados"}
            </small>
          </div>
          <div className={styles.actions}>
            {view === "queue" && (
              <>
                <label className={styles.bulkPicker}>
                  <span>Ação em lote</span>
                  <select
                    value={selectionMode}
                    onChange={(event) => {
                      setSelectionMode(
                        event.target.value as "wave" | "manifest",
                      );
                      setSelected([]);
                    }}
                  >
                    <option value="wave">Criar onda</option>
                    <option value="manifest">Gerar romaneio</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!selectableIds.length || api.busy}
                  onClick={() =>
                    setSelected(
                      allEligibleSelected
                        ? []
                        : selectableIds,
                    )
                  }
                >
                  {allEligibleSelected
                    ? "Limpar seleção"
                    : `Selecionar nesta página (${selectableIds.length})`}
                </button>
                <button
                  type="button"
                  disabled={
                    !selected.some((id) => selectableIds.includes(id)) ||
                    api.busy
                  }
                  onClick={() =>
                    selectionMode === "wave" ? void wave() : openManifest()
                  }
                >
                  {selectionMode === "wave" ? "Criar onda" : "Gerar romaneio"} (
                  {selected.filter((id) => selectableIds.includes(id)).length})
                </button>
              </>
            )}
            <button type="button" onClick={() => exportLogisticsCsv(endpoint)}>
              Exportar CSV
            </button>
            <button
              type="button"
              disabled={api.busy || api.refreshing}
              onClick={() => void api.load()}
            >
              {api.refreshing ? "Atualizando…" : "Atualizar"}
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!data.availableOrders.length || api.busy}
              title={
                data.availableOrders.length
                  ? "Abrir uma nova expedição"
                  : "Não há pedidos aprovados aguardando expedição"
              }
              onClick={() => setModal({ type: "create" })}
            >
              Nova expedição
            </button>
          </div>
        </header>
        <div className={styles.filters}>
          <label className={styles.viewPicker}>
            <span>Visualização</span>
            <select
              aria-label="Visualização da expedição"
              value={view}
              onChange={(event) =>
                changeView(event.target.value as LogisticsView)
              }
            >
              <option value="queue">Fila operacional</option>
              <option value="board">Quadro por etapa</option>
              <option value="sla">SLA e exceções</option>
              <option value="operations">Ondas e romaneios</option>
              <option value="performance">Desempenho e custos</option>
              <option value="history">Histórico completo</option>
            </select>
          </label>
          <label>
            <span className={styles.srOnly}>Buscar</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected([]);
              }}
              placeholder="Buscar expedição, pedido, cliente ou rastreio…"
            />
          </label>
          <select
            aria-label="Filtrar expedições"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
              setSelected([]);
            }}
          >
            <option value="open">Somente abertas</option>
            <option value="all">Todos os status</option>
            <option value="picking">Separação</option>
            <option value="packed">Embalado</option>
            <option value="dispatched">Em transporte</option>
            <option value="delivered">Entregue</option>
            <option value="cancelled">Cancelado</option>
            <option value="on_hold">Em espera</option>
          </select>
          <button
            type="button"
            className={styles.advancedFilterButton}
            aria-expanded={filtersOpen}
            aria-controls="logistics-advanced-filters"
            onClick={() => setFiltersOpen((value) => !value)}
          >
            Mais filtros{hasAdvancedFilters ? " •" : ""}
          </button>
          {(query ||
            hasAdvancedFilters ||
            status !==
              (view === "history" || view === "performance"
                ? "all"
                : "open")) && (
            <button
              type="button"
              className={styles.clearFilters}
              onClick={clearFilters}
            >
              Limpar filtros
            </button>
          )}
          <span role="status" aria-live="polite" aria-atomic="true">
            {data.pagination.total} expedição(ões)
            {data.pagination.pages > 1
              ? ` · página ${data.pagination.page}/${data.pagination.pages}`
              : ""}
          </span>
        </div>
        {filtersOpen && (
          <div id="logistics-advanced-filters" className={styles.advancedFilters}>
            <FilterSelect
              label="Depósito"
              value={warehouse}
              change={(value) => applyFilter(setWarehouse, value)}
            >
              <option value="">Todos os depósitos</option>
              {data.warehouses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Canal"
              value={channel}
              change={(value) => applyFilter(setChannel, value)}
            >
              <option value="">Todos os canais</option>
              {data.channels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Transportadora"
              value={carrier}
              change={(value) => applyFilter(setCarrier, value)}
            >
              <option value="">Todas as transportadoras</option>
              {data.carriers.map((item) => (
                <option key={item.key} value={item.label}>
                  {item.label}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Prioridade"
              value={priority}
              change={(value) => applyFilter(setPriority, value)}
            >
              <option value="">Todas as prioridades</option>
              <option value="urgent">Urgente</option>
              <option value="high">Alta</option>
              <option value="normal">Normal</option>
              <option value="low">Baixa</option>
            </FilterSelect>
            <FilterSelect
              label="Ocorrência"
              value={incident}
              change={(value) => applyFilter(setIncident, value)}
            >
              <option value="">Todas as ocorrências</option>
              <option value="open">Aberta</option>
              <option value="resolved">Resolvida</option>
              <option value="none">Sem ocorrência aberta</option>
            </FilterSelect>
            <FilterSelect
              label="SLA"
              value={sla}
              change={(value) => applyFilter(setSla, value)}
            >
              <option value="">Todos os prazos</option>
              <option value="late">Atrasado</option>
              <option value="today">Vence hoje</option>
              <option value="upcoming">Próximos</option>
            </FilterSelect>
            <label>
              <span>De</span>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setPage(1);
                  setSelected([]);
                }}
              />
            </label>
            <label>
              <span>Até</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => {
                  setTo(event.target.value);
                  setPage(1);
                  setSelected([]);
                }}
              />
            </label>
          </div>
        )}
        {data.availableOrders.length > 0 && (
          <div className={styles.callout}>
            <span>
              <strong>
                {data.availableOrders.length} pedido(s) aprovado(s) ainda não
                entraram na expedição.
              </strong>
              <small>
                Abra os envios para iniciar a contagem do SLA operacional.
              </small>
            </span>
            <button
              type="button"
              disabled={api.busy}
              onClick={() => setModal({ type: "create" })}
            >
              Abrir agora
            </button>
          </div>
        )}
        {view === "queue" && (
          <ShipmentQueue
            rows={filtered}
            busy={api.busy}
            eligibleIds={selectableIds}
            selected={selected}
            setSelected={setSelected}
            open={(type, shipment) => setModal({ type, shipment })}
            command={api.command}
          />
        )}
        {view === "board" && (
          <ShipmentBoard
            rows={filtered}
            busy={api.busy}
            open={(type, shipment) => setModal({ type, shipment })}
            command={api.command}
          />
        )}
        {view === "sla" && (
          <SlaView
            rows={filtered.filter(
              (shipment) =>
                shipment.status !== "delivered" &&
                shipment.status !== "cancelled",
            )}
          />
        )}
        {view === "history" && <ShipmentHistory rows={filtered} />}
        {view === "operations" && (
          <LogisticsOperations
            data={data}
            busy={api.busy}
            command={api.command}
          />
        )}
        {view === "performance" && (
          <LogisticsPerformance summary={data.summary} />
        )}
        {!["operations", "performance"].includes(view) && data.pagination.pages > 1 && (
          <nav className={styles.logisticsPager} aria-label="Paginação">
            <button
              type="button"
              disabled={page <= 1 || api.refreshing}
              onClick={() => {
                setSelected([]);
                setPage((current) => Math.max(1, current - 1));
              }}
            >
              Anterior
            </button>
            <span>
              Página <strong>{data.pagination.page}</strong> de{" "}
              <strong>{data.pagination.pages}</strong>
            </span>
            <button
              type="button"
              disabled={page >= data.pagination.pages || api.refreshing}
              onClick={() => {
                setSelected([]);
                setPage((current) => current + 1);
              }}
            >
              Próxima
            </button>
          </nav>
        )}
      </section>
      {modal && (
        <LogisticsModal
          modal={modal}
          data={data}
          busy={api.busy}
          error={api.error}
          close={() => setModal(null)}
          submit={async (payload) => {
            const action =
              modal.type === "pick"
                ? "pick.items"
                : modal.type === "resolve"
                  ? "incident.resolve"
                  : modal.type === "tracking"
                    ? "tracking.update"
                    : modal.type === "return"
                      ? "return.create"
                      : modal.type === "returnState"
                        ? "return.update"
                        : modal.type === "returnInspect"
                          ? "return.inspect"
                          : modal.type === "manifest"
                            ? "manifest.create"
                            : modal.type;
            if (
              await api.command(
                {
                  action,
                  shipmentId: modal.shipment?.id,
                  returnId: modal.shipment?.salesOrder.returns.find((item) =>
                    [
                      "pending",
                      "authorized",
                      "in_transit",
                      "received",
                    ].includes(item.status),
                  )?.id,
                  shipmentIds: modal.shipmentIds,
                  ...payload,
                },
                logisticsSuccess(modal.type),
              )
            ) {
              setModal(null);
              if (modal.type === "manifest") setSelected([]);
            }
          }}
        />
      )}
    </div>
  );
}

type OpenShipment = (
  type: Exclude<LogisticsModalType, "create" | "manifest">,
  shipment: Shipment,
) => void;

function FilterSelect({
  label,
  value,
  change,
  children,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => change(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function LogisticsOperations({
  data,
  busy,
  command,
}: {
  data: LogisticsData;
  busy: boolean;
  command: (
    payload: Record<string, unknown>,
    message: string,
    reload?: boolean,
  ) => Promise<boolean>;
}) {
  return (
    <div className={styles.operationsGrid}>
      <section className={styles.panel}>
        <header>
          <div>
            <span>SEPARAÇÃO</span>
            <h2>Ondas recentes</h2>
          </div>
          <small>{data.waves.length} onda(s)</small>
        </header>
        <div className={styles.operationList}>
          {data.waves.map((wave) => (
            <article key={wave.id}>
              <div>
                <strong>{wave.number}</strong>
                <small>{dateTime.format(new Date(wave.createdAt))}</small>
              </div>
              <span>{wave.assignedTo || "Sem operador"}</span>
              <b>{wave._count.shipments} expedição(ões)</b>
              <Status
                value={wave.status === "open" ? "Aberta" : wave.status}
                kind={wave.status}
              />
            </article>
          ))}
          {!data.waves.length && (
            <Empty
              title="Nenhuma onda criada"
              detail="Selecione expedições na fila e crie uma onda de separação."
            />
          )}
        </div>
      </section>
      <section className={styles.panel}>
        <header>
          <div>
            <span>COLETA</span>
            <h2>Romaneios recentes</h2>
          </div>
          <small>{data.manifests.length} romaneio(s)</small>
        </header>
        <div className={styles.operationList}>
          {data.manifests.map((manifest) => (
            <article key={manifest.id}>
              <div>
                <strong>{manifest.number}</strong>
                <small>{manifest.carrier}</small>
              </div>
              <span>
                {manifest.totalPackages} volume(s) ·{" "}
                {number.format(manifest.totalWeightKg)} kg
              </span>
              <b>{manifest._count.shipments} expedição(ões)</b>
              <div className={styles.operationActions}>
                <Status
                  value={manifestStatusLabel(manifest.status)}
                  kind={manifest.status}
                />
                {manifest.status === "open" && (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void command(
                        {
                          action: "manifest.update",
                          manifestId: manifest.id,
                          status: "closed",
                        },
                        "Romaneio fechado e pronto para coleta.",
                      )
                    }
                  >
                    Fechar
                  </button>
                )}
                {manifest.status === "closed" && (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void command(
                        {
                          action: "manifest.update",
                          manifestId: manifest.id,
                          status: "handed_off",
                        },
                        "Coleta confirmada com trilha de auditoria.",
                      )
                    }
                  >
                    Confirmar coleta
                  </button>
                )}
                {!["handed_off", "cancelled"].includes(manifest.status) && (
                  <button
                    disabled={busy}
                    type="button"
                    className={styles.dangerText}
                    onClick={() =>
                      void command(
                        {
                          action: "manifest.update",
                          manifestId: manifest.id,
                          status: "cancelled",
                        },
                        "Romaneio cancelado; expedições liberadas.",
                      )
                    }
                  >
                    Cancelar
                  </button>
                )}
                {manifest.status === "cancelled" && (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void command(
                        {
                          action: "manifest.update",
                          manifestId: manifest.id,
                          status: "open",
                        },
                        "Romaneio reaberto.",
                      )
                    }
                  >
                    Reabrir
                  </button>
                )}
              </div>
            </article>
          ))}
          {!data.manifests.length && (
            <Empty
              title="Nenhum romaneio criado"
              detail="Agrupe volumes embalados ou despachados para controlar a coleta."
            />
          )}
        </div>
      </section>
    </div>
  );
}

function LogisticsPerformance({
  summary,
}: {
  summary: LogisticsData["summary"];
}) {
  const throughputMax = Math.max(
    1,
    ...summary.bi.dailyThroughput.flatMap((row) => [
      row.created,
      row.delivered,
    ]),
  );
  const distributionMax = Math.max(
    1,
    ...summary.bi.statusDistribution.map((row) => row.count),
  );
  return (
    <div className={styles.performanceGrid}>
      <section className={styles.panel}>
        <header>
          <div>
            <span>FLUXO</span>
            <h2>Volume dos últimos 14 dias</h2>
          </div>
        </header>
        <div
          className={styles.throughputChart}
          aria-label="Expedições criadas e entregues por dia"
        >
          {summary.bi.dailyThroughput.map((row) => (
            <div
              key={row.date}
              title={`${row.date}: ${row.created} criadas, ${row.delivered} entregues`}
            >
              <span
                style={{
                  height: `${Math.max(3, (row.created / throughputMax) * 100)}%`,
                }}
              />
              <i
                style={{
                  height: `${Math.max(3, (row.delivered / throughputMax) * 100)}%`,
                }}
              />
              <small>{row.date.slice(5).split("-").reverse().join("/")}</small>
            </div>
          ))}
        </div>
        <p className={styles.chartLegend}>
          <i data-kind="created" /> Criadas <i data-kind="delivered" />{" "}
          Entregues
        </p>
      </section>
      <section className={styles.panel}>
        <header>
          <div>
            <span>CARTEIRA</span>
            <h2>Distribuição por etapa</h2>
          </div>
        </header>
        <div className={styles.distributionList}>
          {summary.bi.statusDistribution.map((row) => (
            <div key={row.status}>
              <span>
                {shipmentStatus(row.status)} <b>{row.count}</b>
              </span>
              <i>
                <span
                  style={{ width: `${(row.count / distributionMax) * 100}%` }}
                />
              </i>
            </div>
          ))}
        </div>
      </section>
      <section className={`${styles.panel} ${styles.performanceWide}`}>
        <header>
          <div>
            <span>TRANSPORTADORAS</span>
            <h2>Scorecard de entrega</h2>
          </div>
        </header>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Transportadora</th>
                <th>Envios</th>
                <th>Entregues</th>
                <th>No prazo</th>
                <th>Frete médio</th>
              </tr>
            </thead>
            <tbody>
              {summary.bi.carrierScorecards.map((row) => (
                <tr key={row.carrier}>
                  <td>
                    <strong>{row.carrier}</strong>
                  </td>
                  <td>{row.shipments}</td>
                  <td>{row.delivered}</td>
                  <td>
                    <Status
                      value={`${percent.format(row.onTimeRate)}%`}
                      kind={row.onTimeRate >= 90 ? "delivered" : "today"}
                    />
                  </td>
                  <td>{money.format(row.averageFreight)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!summary.bi.carrierScorecards.length && (
            <Empty
              title="Sem dados de transportadora"
              detail="Os indicadores aparecem após o primeiro despacho."
            />
          )}
        </div>
      </section>
      <section className={styles.panel}>
        <header>
          <div>
            <span>QUALIDADE</span>
            <h2>Causas das ocorrências</h2>
          </div>
        </header>
        <div className={styles.causeList}>
          {summary.bi.exceptionCauses.map((row) => (
            <p key={row.category}>
              <span>{incidentCategoryLabel(row.category)}</span>
              <b>{row.count}</b>
            </p>
          ))}
          {!summary.bi.exceptionCauses.length && (
            <p>Nenhuma ocorrência no período filtrado.</p>
          )}
        </div>
      </section>
      <section className={styles.panel}>
        <header>
          <div>
            <span>EFICIÊNCIA</span>
            <h2>Indicadores operacionais</h2>
          </div>
        </header>
        <dl className={styles.efficiencyList}>
          <div>
            <dt>Primeira tentativa</dt>
            <dd>{percent.format(summary.firstAttemptRate)}%</dd>
          </div>
          <div>
            <dt>Taxa de exceção</dt>
            <dd>{percent.format(summary.exceptionRate)}%</dd>
          </div>
          <div>
            <dt>Separação média</dt>
            <dd>{percent.format(summary.averagePickingHours)} h</dd>
          </div>
          <div>
            <dt>Trânsito médio</dt>
            <dd>{percent.format(summary.averageTransitHours)} h</dd>
          </div>
          <div>
            <dt>Frete total</dt>
            <dd>{money.format(summary.freight)}</dd>
          </div>
          <div>
            <dt>Volumes</dt>
            <dd>{summary.packageCount}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function ShipmentQueue({
  rows,
  busy,
  eligibleIds,
  selected,
  setSelected,
  open,
  command,
}: {
  rows: Shipment[];
  busy: boolean;
  eligibleIds: number[];
  selected: number[];
  setSelected: (value: number[]) => void;
  open: OpenShipment;
  command: (
    payload: Record<string, unknown>,
    message: string,
    reload?: boolean,
  ) => Promise<boolean>;
}) {
  const eligible = rows.filter((shipment) => eligibleIds.includes(shipment.id));
  const selectionRef = useRef<HTMLInputElement>(null);
  const selectionCount = eligible.filter((shipment) => selected.includes(shipment.id)).length;
  useEffect(() => {
    if (selectionRef.current)
      selectionRef.current.indeterminate = selectionCount > 0 && selectionCount < eligible.length;
  }, [selectionCount, eligible.length]);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.queueTable}>
        <thead>
          <tr>
            <th>
              <input
                ref={selectionRef}
                type="checkbox"
                disabled={busy || !eligible.length}
                aria-label="Selecionar expedições elegíveis nesta página"
                checked={
                  eligible.length > 0 &&
                  eligible.every((shipment) => selected.includes(shipment.id))
                }
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? eligible.map((shipment) => shipment.id)
                      : [],
                  )
                }
              />
            </th>
            <th>Expedição / pedido</th>
            <th>Cliente / canal</th>
            <th>SLA</th>
            <th>Progresso</th>
            <th>Destino</th>
            <th>Status</th>
            <th>
              <span className={styles.srOnly}>Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((shipment) => {
            const progress = pickingProgress(shipment),
              sla = shipmentSla(shipment);
            return (
              <tr key={shipment.id} data-late={sla.kind === "late"}>
                <td>
                  <input
                    type="checkbox"
                    disabled={busy || !eligible.some((item) => item.id === shipment.id)}
                    checked={selected.includes(shipment.id)}
                    aria-label={`Selecionar ${shipment.number}`}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, shipment.id]
                          : selected.filter((id) => id !== shipment.id),
                      )
                    }
                  />
                </td>
                <td>
                  <strong>{shipment.number}</strong>
                  <small>
                    {shipment.salesOrder.number} ·{" "}
                    {dateTime.format(new Date(shipment.createdAt))}
                  </small>
                </td>
                <td>
                  <strong>{shipment.salesOrder.customerName}</strong>
                  <small>
                    {shipment.channelOrder?.channel.name || "Venda direta"}
                  </small>
                </td>
                <td>
                  <Status value={sla.label} kind={sla.kind} />
                  <small>
                    {shipment.dispatchDeadlineAt
                      ? `Despachar ${dateTime.format(new Date(shipment.dispatchDeadlineAt))}`
                      : shipment.deadlineAt
                        ? `Entregar ${date.format(new Date(shipment.deadlineAt))}`
                        : "Sem prazo informado"}
                  </small>
                </td>
                <td>
                  <div
                    className={styles.progress}
                    role="progressbar"
                    aria-label={`Progresso de ${shipment.number}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress)}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <small>
                    {percent.format(progress)}% · {shipment.items.length}{" "}
                    item(ns)
                  </small>
                </td>
                <td>
                  <strong>
                    {[
                      shipment.salesOrder.deliveryCity,
                      shipment.salesOrder.deliveryState,
                    ]
                      .filter(Boolean)
                      .join("/") || "Não informado"}
                  </strong>
                  <small>{shipment.carrier || "Transportadora pendente"}</small>
                </td>
                <td>
                  <Status
                    value={shipmentStatus(shipment.status)}
                    kind={shipment.status}
                  />
                  <small>
                    {shipment.holdReason
                      ? `Bloqueio · ${shipment.holdReason}`
                      : shipment.fiscalRequired &&
                          shipment.fiscalStatus !== "authorized"
                        ? `Fiscal · ${shipment.fiscalStatus}`
                        : shipment.exceptionStatus === "open"
                          ? `Ocorrência · ${shipment.exceptionOwner || "sem responsável"}`
                          : priorityLabel(shipment.priority)}
                  </small>
                </td>
                <td>
                  <ShipmentActions
                    shipment={shipment}
                    busy={busy}
                    open={open}
                    command={command}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.shipmentCards}>
        {rows.map((shipment) => {
          const progress = pickingProgress(shipment),
            sla = shipmentSla(shipment),
            next = shipmentNextAction(shipment);
          const selectable = eligible.some((item) => item.id === shipment.id);
          return (
            <article
              key={shipment.id}
              data-late={sla.kind === "late"}
              data-priority={shipment.priority}
            >
              <header>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy || !selectable}
                    checked={selected.includes(shipment.id)}
                    aria-label={`Selecionar ${shipment.number}`}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, shipment.id]
                          : selected.filter((id) => id !== shipment.id),
                      )
                    }
                  />
                  <span>
                    <strong>{shipment.number}</strong>
                    <small>{shipment.salesOrder.number}</small>
                  </span>
                </label>
                <Status
                  value={shipmentStatus(shipment.status)}
                  kind={shipment.status}
                />
              </header>
              <div className={styles.shipmentCardIdentity}>
                <strong>{shipment.salesOrder.customerName}</strong>
                <small>
                  {shipment.channelOrder?.channel.name || "Venda direta"} ·{" "}
                  {shipment.warehouse.name}
                </small>
              </div>
              <div className={styles.shipmentCardProgress}>
                <span>
                  <b>Separação</b>
                  <small>{percent.format(progress)}%</small>
                </span>
                <div
                  className={styles.progress}
                  role="progressbar"
                  aria-label={`Progresso de ${shipment.number}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              </div>
              <dl>
                <div>
                  <dt>Prazo</dt>
                  <dd>
                    <Status value={sla.label} kind={sla.kind} />
                  </dd>
                </div>
                <div>
                  <dt>Destino</dt>
                  <dd>
                    {[
                      shipment.salesOrder.deliveryCity,
                      shipment.salesOrder.deliveryState,
                    ]
                      .filter(Boolean)
                      .join("/") || "Não informado"}
                  </dd>
                </div>
                <div>
                  <dt>Transportadora</dt>
                  <dd>{shipment.carrier || "A definir"}</dd>
                </div>
                <div>
                  <dt>Prioridade</dt>
                  <dd>{priorityLabel(shipment.priority)}</dd>
                </div>
                <div>
                  <dt>Volumes</dt>
                  <dd>{shipment.packages.length || shipment.packageCount}</dd>
                </div>
                <div>
                  <dt>Fiscal</dt>
                  <dd>
                    {shipment.fiscalRequired
                      ? shipment.fiscalStatus
                      : "Dispensado"}
                  </dd>
                </div>
              </dl>
              <footer>
                {next && (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    onClick={() => open(next.type, shipment)}
                  >
                    {next.label}
                  </button>
                )}
                <ShipmentActions
                  shipment={shipment}
                  busy={busy}
                  open={open}
                  command={command}
                />
              </footer>
            </article>
          );
        })}
      </div>
      {!rows.length && (
        <Empty
          title="Nenhuma expedição encontrada"
          detail="Ajuste os filtros ou abra uma expedição para um pedido aprovado."
        />
      )}
    </div>
  );
}

function ShipmentActions({
  shipment,
  busy,
  open,
  command,
}: {
  shipment: Shipment;
  busy: boolean;
  open: OpenShipment;
  command: (
    payload: Record<string, unknown>,
    message: string,
    reload?: boolean,
  ) => Promise<boolean>;
}) {
  const complete = shipment.items.every(
      (item) => item.pickedQuantity >= item.quantity,
    ),
    activeReturn = shipment.salesOrder.returns.find((item) =>
      ["pending", "authorized", "in_transit", "received"].includes(item.status),
    ),
    openShipment = !["delivered", "cancelled"].includes(shipment.status);
  return (
    <ActionMenu label={`Ações de ${shipment.number}`}>
      {shipment.status === "picking" && !complete && (
        <button
          type="button"
          disabled={busy}
          onClick={() => open("pick", shipment)}
        >
          Conferir separação
        </button>
      )}
      {shipment.status === "picking" && complete && (
        <button
          type="button"
          disabled={busy}
          onClick={() => open("pack", shipment)}
        >
          Registrar embalagem
        </button>
      )}
      {shipment.status === "packed" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => open("dispatch", shipment)}
        >
          Despachar
        </button>
      )}
      {shipment.status === "dispatched" && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => open("tracking", shipment)}
          >
            Atualizar rastreio
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => open("deliver", shipment)}
          >
            Confirmar entrega
          </button>
        </>
      )}
      {openShipment && (
        <button
          type="button"
          disabled={busy}
          onClick={() => open("incident", shipment)}
        >
          Registrar ocorrência
        </button>
      )}
      {shipment.exceptionStatus === "open" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => open("resolve", shipment)}
        >
          Resolver ocorrência
        </button>
      )}
      {["picking", "packed"].includes(shipment.status) && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            command(
              { action: "freight.quote", shipmentId: shipment.id },
              "Fretes calculados e melhor opção aplicada à expedição.",
            )
          }
        >
          Cotar frete
        </button>
      )}
      {shipment.status === "packed" && shipment.packages.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            command(
              { action: "label.generate", shipmentId: shipment.id },
              "Etiquetas geradas para todos os volumes.",
            )
          }
        >
          Gerar etiquetas
        </button>
      )}
      {shipment.packages.some((item) => item.labelUrl) && (
        <button type="button" onClick={() => printPackageLabels(shipment)}>
          Imprimir etiquetas
        </button>
      )}
      {["dispatched", "delivered"].includes(shipment.status) &&
        !activeReturn && (
          <button
            type="button"
            disabled={busy}
            onClick={() => open("return", shipment)}
          >
            Abrir logística reversa
          </button>
        )}
      {activeReturn && activeReturn.status !== "received" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => open("returnState", shipment)}
        >
          Atualizar logística reversa
        </button>
      )}
      {activeReturn?.status === "received" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => open("returnInspect", shipment)}
        >
          Inspecionar devolução
        </button>
      )}
      {openShipment && shipment.priority !== "urgent" && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            command(
              {
                action: "priority",
                shipmentId: shipment.id,
                priority: "urgent",
              },
              "Expedição marcada como urgente.",
            )
          }
        >
          Marcar como urgente
        </button>
      )}
      {openShipment && shipment.priority !== "normal" && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            command(
              {
                action: "priority",
                shipmentId: shipment.id,
                priority: "normal",
              },
              "Prioridade normalizada.",
            )
          }
        >
          Prioridade normal
        </button>
      )}
      <button type="button" onClick={() => printShipment(shipment)}>
        Imprimir lista
      </button>
      {["picking", "packed"].includes(shipment.status) && (
        <button
          type="button"
          className={styles.dangerText}
          disabled={busy}
          onClick={() => open("cancel", shipment)}
        >
          Cancelar expedição
        </button>
      )}
      {shipment.status === "cancelled" && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            command(
              { action: "reopen", shipmentId: shipment.id },
              "Expedição reaberta para separação.",
            )
          }
        >
          Reabrir expedição
        </button>
      )}
    </ActionMenu>
  );
}

function ShipmentBoard({
  rows,
  busy,
  open,
  command,
}: {
  rows: Shipment[];
  busy: boolean;
  open: OpenShipment;
  command: (
    payload: Record<string, unknown>,
    message: string,
    reload?: boolean,
  ) => Promise<boolean>;
}) {
  const columns = [
    "picking",
    "packed",
    "dispatched",
    "delivered",
    ...(rows.some((shipment) => shipment.status === "on_hold")
      ? ["on_hold"]
      : []),
    ...(rows.some((shipment) => shipment.status === "cancelled")
      ? ["cancelled"]
      : []),
  ];
  return (
    <div className={styles.boardScroll} role="region" aria-label="Quadro de expedições desta página" tabIndex={0}>
      <div className={styles.board}>
        {columns.map((status) => {
          const items = rows.filter((shipment) => shipment.status === status);
          return (
            <section key={status}>
              <header>
                <strong>{shipmentStatus(status)}</strong>
                <span>{items.length}</span>
              </header>
              <div role="region" aria-label={`Expedições: ${shipmentStatus(status)}`} tabIndex={0}>
                {items.map((shipment) => (
                  <article key={shipment.id} data-priority={shipment.priority}>
                    <div>
                      <span>{shipment.number}</span>
                      <Status
                        value={priorityLabel(shipment.priority)}
                        kind={shipment.priority}
                      />
                    </div>
                    <h3>{shipment.salesOrder.customerName}</h3>
                    <p>
                      {shipment.salesOrder.number} ·{" "}
                      {shipment.channelOrder?.channel.name || "Venda direta"}
                    </p>
                    <dl>
                      <div>
                        <dt>SLA</dt>
                        <dd>{shipmentSla(shipment).label}</dd>
                      </div>
                      <div>
                        <dt>Itens</dt>
                        <dd>{shipment.items.length}</dd>
                      </div>
                    </dl>
                    <footer>
                      {shipmentNextAction(shipment) ? (
                        <button
                          type="button"
                          onClick={() =>
                            open(shipmentNextAction(shipment)!.type, shipment)
                          }
                          disabled={busy}
                        >
                          {shipmentNextAction(shipment)!.label}
                        </button>
                      ) : (
                        <span className={styles.stageComplete}>
                          {status === "on_hold" ? "Aguardando liberação" : status === "cancelled" ? "Cancelado" : "Concluído"}
                        </span>
                      )}
                      <ShipmentActions
                        shipment={shipment}
                        busy={busy}
                        open={open}
                        command={command}
                      />
                    </footer>
                  </article>
                ))}
                {!items.length && (
                  <p className={styles.columnEmpty}>
                    Nenhum volume nesta etapa.
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SlaView({ rows }: { rows: Shipment[] }) {
  return (
    <div className={styles.slaGrid}>
      <section className={styles.panel}>
        <header>
          <div>
            <span>ORDEM DE ATAQUE</span>
            <h2>Expedições por urgência</h2>
          </div>
        </header>
        <div className={styles.slaList}>
          {rows
            .sort((left, right) => shipmentScore(right) - shipmentScore(left))
            .map((shipment, index) => {
              const sla = shipmentSla(shipment);
              return (
                <article key={shipment.id}>
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <div>
                    <strong>
                      {shipment.number} · {shipment.salesOrder.customerName}
                    </strong>
                    <small>
                      {shipmentStatus(shipment.status)} ·{" "}
                      {shipment.warehouse.name} ·{" "}
                      {shipment.exceptionStatus === "open"
                        ? `ocorrência com ${shipment.exceptionOwner || "responsável pendente"}${shipment.exceptionDueAt ? ` até ${dateTime.format(new Date(shipment.exceptionDueAt))}` : ""}`
                        : priorityLabel(shipment.priority)}
                    </small>
                  </div>
                  <Status value={sla.label} kind={sla.kind} />
                </article>
              );
            })}
          {!rows.length && (
            <Empty
              title="SLA sob controle"
              detail="Não há expedições abertas para priorizar."
            />
          )}
        </div>
      </section>
      <aside className={styles.panel}>
        <header>
          <div>
            <span>CRITÉRIO</span>
            <h2>Como priorizamos</h2>
          </div>
        </header>
        <div className={styles.legend}>
          <p>
            <i data-kind="late" /> Prazo já vencido
          </p>
          <p>
            <i data-kind="urgent" /> Prioridade urgente
          </p>
          <p>
            <i data-kind="today" /> Despacho ou entrega hoje
          </p>
          <p>
            <i data-kind="normal" /> Demais pedidos por antiguidade
          </p>
        </div>
      </aside>
    </div>
  );
}

function ShipmentHistory({ rows }: { rows: Shipment[] }) {
  return (
    <div className={styles.history}>
      {rows.map((shipment) => (
        <details key={shipment.id}>
          <summary>
            <span>
              <strong>
                {shipment.number} · {shipment.salesOrder.customerName}
              </strong>
              <small>
                {shipment.salesOrder.number} · {shipment.warehouse.name}
              </small>
            </span>
            <Status
              value={shipmentStatus(shipment.status)}
              kind={shipment.status}
            />
            <span>{shipment.events.length} evento(s)</span>
          </summary>
          <div className={styles.detailGrid}>
            <section>
              <h3>Volumes e transporte</h3>
              <dl>
                <div>
                  <dt>Embalagens</dt>
                  <dd>{shipment.packageCount}</dd>
                </div>
                <div>
                  <dt>Peso</dt>
                  <dd>
                    {shipment.weightKg
                      ? `${number.format(shipment.weightKg)} kg`
                      : "Não informado"}
                  </dd>
                </div>
                <div>
                  <dt>Dimensões</dt>
                  <dd>
                    {shipment.lengthCm && shipment.widthCm && shipment.heightCm
                      ? `${number.format(shipment.lengthCm)} × ${number.format(shipment.widthCm)} × ${number.format(shipment.heightCm)} cm`
                      : "Não informadas"}
                  </dd>
                </div>
                <div>
                  <dt>Rastreio</dt>
                  <dd>{shipment.trackingCode || "Pendente"}</dd>
                </div>
                <div>
                  <dt>Romaneio</dt>
                  <dd>{shipment.manifestNumber || "Não gerado"}</dd>
                </div>
                <div>
                  <dt>Coleta</dt>
                  <dd>
                    {shipment.handoffAt
                      ? dateTime.format(new Date(shipment.handoffAt))
                      : "Não confirmada"}
                  </dd>
                </div>
                <div>
                  <dt>Destino</dt>
                  <dd>{shipmentAddress(shipment)}</dd>
                </div>
                <div>
                  <dt>Frete</dt>
                  <dd>
                    {money.format(
                      (shipment.actualFreightCents ??
                        shipment.quotedFreightCents ??
                        Math.round(shipment.freight * 100)) / 100,
                    )}
                  </dd>
                </div>
              </dl>
              <div className={styles.packageList}>
                {shipment.packages.map((volume) => (
                  <article key={volume.id}>
                    <span>
                      <strong>Volume {volume.sequence}</strong>
                      <small>{volume.code}</small>
                    </span>
                    <span>
                      {number.format(volume.weightKg)} kg ·{" "}
                      {number.format(volume.lengthCm)} ×{" "}
                      {number.format(volume.widthCm)} ×{" "}
                      {number.format(volume.heightCm)} cm
                    </span>
                    <span>{volume.trackingCode || "Rastreio pendente"}</span>
                    {volume.labelUrl && (
                      <a
                        href={volume.labelUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Etiqueta
                      </a>
                    )}
                  </article>
                ))}
              </div>
              {shipment.salesOrder.shippingLabels.map((label) => (
                <p key={label.id} className={styles.labelLinks}>
                  {label.labelUrl && (
                    <a href={label.labelUrl} target="_blank" rel="noreferrer">
                      Abrir etiqueta
                    </a>
                  )}
                  {label.trackingUrl && (
                    <a
                      href={label.trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Rastrear pacote
                    </a>
                  )}
                </p>
              ))}
            </section>
            <section>
              <h3>Comprovante de entrega</h3>
              {shipment.deliveryRecipient ? (
                <dl>
                  <div>
                    <dt>Recebedor</dt>
                    <dd>{shipment.deliveryRecipient}</dd>
                  </div>
                  <div>
                    <dt>Documento</dt>
                    <dd>{shipment.deliveryDocument || "Não informado"}</dd>
                  </div>
                  <div>
                    <dt>Observação</dt>
                    <dd>{shipment.deliveryNotes || "Sem observações"}</dd>
                  </div>
                </dl>
              ) : (
                <p>Nenhum comprovante registrado.</p>
              )}
              {shipment.proofUrl && (
                <a href={shipment.proofUrl} target="_blank" rel="noreferrer">
                  Abrir comprovante digital
                </a>
              )}
            </section>
            <section>
              <h3>Exceções e logística reversa</h3>
              {shipment.incidents.map((incidentRow) => (
                <article key={incidentRow.id} className={styles.incidentCard}>
                  <span>
                    <Status
                      value={
                        incidentRow.status === "open" ? "Aberta" : "Resolvida"
                      }
                      kind={incidentRow.status}
                    />{" "}
                    <b>{incidentCategoryLabel(incidentRow.category)}</b> ·{" "}
                    {severityLabel(incidentRow.severity)}
                  </span>
                  <strong>{incidentRow.description}</strong>
                  <small>
                    {incidentRow.owner} · prazo{" "}
                    {dateTime.format(new Date(incidentRow.dueAt))}
                  </small>
                  {incidentRow.rootCause && (
                    <small>Causa: {incidentRow.rootCause}</small>
                  )}
                  {incidentRow.resolution && (
                    <small>Resolução: {incidentRow.resolution}</small>
                  )}
                </article>
              ))}
              {shipment.salesOrder.returns.map((orderReturn) => (
                <article key={orderReturn.id} className={styles.returnCard}>
                  <strong>
                    Reversa #{orderReturn.id} ·{" "}
                    {returnStatusLabel(orderReturn.status)}
                  </strong>
                  <small>{orderReturn.description}</small>
                  <span>
                    {orderReturn.reverseProvider || "Operador pendente"}
                    {orderReturn.reverseTrackingCode
                      ? ` · ${orderReturn.reverseTrackingCode}`
                      : ""}
                  </span>
                  {orderReturn.items.map((item) => (
                    <small key={item.id}>
                      Item {item.orderItemId}:{" "}
                      {number.format(item.receivedQuantity)}/
                      {number.format(item.quantity)} recebido(s) ·{" "}
                      {returnDispositionLabel(item.disposition)}
                    </small>
                  ))}
                  {orderReturn.reverseLabelUrl && (
                    <a
                      href={orderReturn.reverseLabelUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Abrir etiqueta reversa
                    </a>
                  )}
                </article>
              ))}
              {!shipment.incidents.length &&
                !shipment.salesOrder.returns.length && (
                  <p>Nenhuma exceção ou devolução registrada.</p>
                )}
            </section>
            <section className={styles.timeline}>
              <h3>Linha do tempo</h3>
              {shipment.events.map((event) => (
                <article key={event.id}>
                  <i />
                  <div>
                    <strong>{eventLabel(event.type)}</strong>
                    <p>{event.description}</p>
                    <small>
                      {event.actor} ·{" "}
                      {dateTime.format(new Date(event.createdAt))}
                    </small>
                  </div>
                </article>
              ))}
            </section>
          </div>
        </details>
      ))}
      {!rows.length && (
        <Empty
          title="Nenhum histórico encontrado"
          detail="As etapas e ocorrências aparecerão nesta linha do tempo."
        />
      )}
    </div>
  );
}

function LogisticsModal({
  modal,
  data,
  busy,
  error,
  close,
  submit,
}: {
  modal: {
    type: LogisticsModalType;
    shipment?: Shipment;
    shipmentIds?: number[];
  };
  data: LogisticsData;
  busy: boolean;
  error: string;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const shipment = modal.shipment;
  const [picked, setPicked] = useState(
    () =>
      shipment?.items.map((item) => ({
        itemId: item.id,
        pickedQuantity: String(item.pickedQuantity),
        shortQuantity: String(item.shortQuantity || 0),
        location: item.location || "",
        scannedCode: item.pickAllocations[0]?.scannedCode || "",
      })) || [],
  );
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [shipmentRows, setShipmentRows] = useState<
    Array<{ orderItemId: number; quantity: string }>
  >([]);
  const [incidentDueAt] = useState(() =>
    toLocalDateTime(new Date(Date.now() + 24 * 3_600_000)),
  );
  const [checkpointAt] = useState(() => toLocalDateTime(new Date()));
  const activeReturn = shipment?.salesOrder.returns.find((item) =>
    ["pending", "authorized", "in_transit", "received"].includes(item.status),
  );
  const [packageRows, setPackageRows] = useState(() =>
    shipment?.packages.length
      ? shipment.packages.map((volume) => ({
          sequence: volume.sequence,
          weightKg: String(volume.weightKg),
          lengthCm: String(volume.lengthCm),
          widthCm: String(volume.widthCm),
          heightCm: String(volume.heightCm),
          labelFormat: volume.labelFormat || "pdf",
          items: shipment.items.map((item) => ({
            shipmentItemId: item.id,
            quantity: String(
              volume.items.find((row) => row.shipmentItemId === item.id)
                ?.quantity || 0,
            ),
          })),
        }))
      : shipment
        ? [
            {
              sequence: 1,
              weightKg: String(shipment.weightKg || ""),
              lengthCm: String(shipment.lengthCm || ""),
              widthCm: String(shipment.widthCm || ""),
              heightCm: String(shipment.heightCm || ""),
              labelFormat: "pdf",
              items: shipment.items.map((item) => ({
                shipmentItemId: item.id,
                quantity: String(item.quantity),
              })),
            },
          ]
        : [],
  );
  const [returnRows, setReturnRows] = useState(
    () =>
      activeReturn?.items.map((item) => ({
        returnItemId: item.id,
        receivedQuantity: String(item.quantity),
        condition: "opened",
        disposition: "quarantine",
        notes: "",
      })) || [],
  );
  const selectedOrder = data.availableOrders.find(
    (order) => String(order.id) === selectedOrderId,
  );
  const pickingValid =
    modal.type !== "pick" ||
    (shipment?.items.every((item, index) => {
      const value = Number(picked[index]?.pickedQuantity),
        shortage = Number(picked[index]?.shortQuantity);
      return (
        Number.isFinite(value) &&
        Number.isFinite(shortage) &&
        value >= 0 &&
        shortage >= 0 &&
        value + shortage <= item.quantity + 0.0001
      );
    }) ??
      false);
  const packingValid =
    modal.type !== "pack" ||
    (packageRows.length > 0 &&
      packageRows.every((row) =>
        [row.weightKg, row.lengthCm, row.widthCm, row.heightCm].every(
          (value) => Number(value) > 0,
        ),
      ) &&
      (shipment?.items.every((item) => {
        const allocated = packageRows.reduce(
          (sum, volume) =>
            sum +
            Number(
              volume.items.find((row) => row.shipmentItemId === item.id)
                ?.quantity || 0,
            ),
          0,
        );
        return Math.abs(allocated - item.quantity) < 0.0001;
      }) ??
        false));
  const shipmentOpeningValid =
    modal.type !== "create" ||
    Boolean(
      selectedOrder &&
      shipmentRows.some((item) => Number(item.quantity) > 0) &&
      shipmentRows.every((item) => {
        const orderItem = selectedOrder.items.find(
            (row) => row.id === item.orderItemId,
          ),
          quantity = Number(item.quantity);
        return Boolean(
          orderItem &&
          Number.isFinite(quantity) &&
          quantity >= 0 &&
          quantity <= orderItem.remainingQuantity + 0.0001,
        );
      }),
    );
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (modal.type === "create") {
      await submit({
        ...values,
        items: shipmentRows
          .map((item) => ({
            orderItemId: item.orderItemId,
            quantity: Number(item.quantity),
          }))
          .filter((item) => item.quantity > 0),
      });
      return;
    }
    if (modal.type === "pick") {
      await submit({
        ...values,
        items: picked.map((row) => ({
          ...row,
          allocations:
            Number(row.pickedQuantity) > 0 && (row.location || row.scannedCode)
              ? [
                  {
                    quantity: row.pickedQuantity,
                    location: row.location,
                    scannedCode: row.scannedCode,
                  },
                ]
              : [],
        })),
      });
      return;
    }
    if (modal.type === "pack") {
      const weights = packageRows.map((row) => Number(row.weightKg));
      await submit({
        ...values,
        packageCount: packageRows.length,
        weightKg: weights.reduce((sum, value) => sum + value, 0),
        lengthCm: Math.max(...packageRows.map((row) => Number(row.lengthCm))),
        widthCm: Math.max(...packageRows.map((row) => Number(row.widthCm))),
        heightCm: Math.max(...packageRows.map((row) => Number(row.heightCm))),
        packages: packageRows,
      });
      return;
    }
    if (modal.type === "returnInspect") {
      await submit({ ...values, items: returnRows });
      return;
    }
    if (modal.type === "return" && shipment) {
      await submit({
        ...values,
        items: shipment.items
          .map((item) => ({
            orderItemId: item.salesOrderItem.id,
            quantity: Number(values[`return-item-${item.id}`] || 0),
          }))
          .filter((item) => item.quantity > 0),
      });
      return;
    }
    await submit(values);
  };
  return (
    <Modal
      eyebrow="FLUXO LOGÍSTICO"
      title={
        modal.type === "create"
          ? "Abrir expedição"
          : `${logisticsActionLabel(modal.type)} ${shipment?.number || ""}`
      }
      close={close}
      busy={busy}
      error={error}
    >
      <form onSubmit={save} className={styles.form} aria-busy={busy}>
        {modal.type === "create" && (
          <>
            <Field label="Pedido aprovado" wide>
              <select
                name="salesOrderId"
                value={selectedOrderId}
                required
                onChange={(event) => {
                  const value = event.target.value,
                    order = data.availableOrders.find(
                      (item) => String(item.id) === value,
                    );
                  setSelectedOrderId(value);
                  setShipmentRows(
                    order?.items.map((item) => ({
                      orderItemId: item.id,
                      quantity: String(item.remainingQuantity),
                    })) || [],
                  );
                }}
              >
                <option value="">Selecione</option>
                {data.availableOrders.map((order) => (
                  <option value={order.id} key={order.id}>
                    {order.number} · {order.customerName} ·{" "}
                    {money.format(order.total)}
                  </option>
                ))}
              </select>
            </Field>
            {selectedOrder && (
              <>
                <div className={styles.orderPreview}>
                  <span>
                    <small>Cliente</small>
                    <strong>{selectedOrder.customerName}</strong>
                  </span>
                  <span>
                    <small>Canal</small>
                    <strong>
                      {selectedOrder.channelOrder?.channel.name ||
                        "Venda direta"}
                    </strong>
                  </span>
                  <span>
                    <small>Total</small>
                    <strong>{money.format(selectedOrder.total)}</strong>
                  </span>
                </div>
                <section className={styles.returnItems}>
                  <header>
                    <strong>Itens deste envio</strong>
                    <small>
                      Quantidades parciais permanecem disponíveis para uma nova
                      expedição.
                    </small>
                  </header>
                  {selectedOrder.items.map((item, index) => (
                    <label key={item.id}>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.sku} · pendente{" "}
                          {number.format(item.remainingQuantity)}
                        </small>
                      </span>
                      <input
                        type="number"
                        min="0"
                        max={item.remainingQuantity}
                        step=".0001"
                        value={shipmentRows[index]?.quantity || "0"}
                        onChange={(event) =>
                          setShipmentRows((current) =>
                            current.map((row, position) =>
                              position === index
                                ? { ...row, quantity: event.target.value }
                                : row,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </section>
              </>
            )}
            <Field label="Depósito">
              <select name="warehouseId" required>
                <option value="">Selecione</option>
                {data.warehouses.map((warehouse) => (
                  <option value={warehouse.id} key={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prioridade">
              <select name="priority">
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
                <option value="urgent">Urgente</option>
                <option value="low">Baixa</option>
              </select>
            </Field>
            <Field label="Limite para despacho">
              <input name="dispatchDeadlineAt" type="datetime-local" />
            </Field>
            <Field label="Prazo de entrega">
              <input name="deadlineAt" type="date" />
            </Field>
            <Field label="Transportadora">
              <input name="carrier" list="carrier-options" />
            </Field>
            <Field label="Serviço">
              <input name="service" />
            </Field>
            <Field label="Frete">
              <input
                name="freight"
                type="number"
                min="0"
                step=".01"
                defaultValue="0"
              />
            </Field>
            <Field label="Volumes">
              <input
                name="packageCount"
                type="number"
                min="1"
                max="999"
                defaultValue="1"
              />
            </Field>
            <datalist id="carrier-options">
              {data.carriers.map((carrier) => (
                <option value={carrier.label} key={carrier.key} />
              ))}
            </datalist>
          </>
        )}
        {modal.type === "pick" && shipment && (
          <section className={styles.pickList}>
            <header>
              <span>
                <strong>Conferência item a item</strong>
                <small>
                  Informe o total efetivamente separado. A quantidade nunca pode
                  superar o pedido.
                </small>
              </span>
              <button
                type="button"
                onClick={() =>
                  setPicked(
                    shipment.items.map((item) => ({
                      itemId: item.id,
                      pickedQuantity: String(item.quantity),
                      shortQuantity: "0",
                      location: item.location || "",
                      scannedCode:
                        item.salesOrderItem.variation?.gtin ||
                        item.salesOrderItem.product.gtin ||
                        "",
                    })),
                  )
                }
              >
                Marcar tudo
              </button>
            </header>
            {shipment.items.map((item, index) => (
              <div key={item.id} className={styles.pickRow}>
                <span>
                  <strong>{item.salesOrderItem.product.name}</strong>
                  <small>
                    {item.salesOrderItem.variation?.sku ||
                      item.salesOrderItem.product.sku}
                    {item.salesOrderItem.variation
                      ? ` · ${formatAttributes(item.salesOrderItem.variation.attributes)}`
                      : ""}{" "}
                    · solicitado {number.format(item.quantity)}
                  </small>
                </span>
                <label>
                  <small>Separado</small>
                  <input
                    value={picked[index]?.pickedQuantity || "0"}
                    type="number"
                    min="0"
                    max={item.quantity}
                    step=".0001"
                    aria-label={`Quantidade separada de ${item.salesOrderItem.product.name}`}
                    onChange={(event) =>
                      setPicked((current) =>
                        current.map((row, position) =>
                          position === index
                            ? { ...row, pickedQuantity: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  <small>Falta</small>
                  <input
                    value={picked[index]?.shortQuantity || "0"}
                    type="number"
                    min="0"
                    max={item.quantity}
                    step=".0001"
                    aria-label={`Falta de ${item.salesOrderItem.product.name}`}
                    onChange={(event) =>
                      setPicked((current) =>
                        current.map((row, position) =>
                          position === index
                            ? { ...row, shortQuantity: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  <small>Endereço</small>
                  <input
                    value={picked[index]?.location || ""}
                    placeholder="A-01-02"
                    onChange={(event) =>
                      setPicked((current) =>
                        current.map((row, position) =>
                          position === index
                            ? { ...row, location: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  <small>Leitura</small>
                  <input
                    value={picked[index]?.scannedCode || ""}
                    placeholder="GTIN, lote ou serial"
                    onChange={(event) =>
                      setPicked((current) =>
                        current.map((row, position) =>
                          position === index
                            ? { ...row, scannedCode: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            ))}
          </section>
        )}
        {modal.type === "pack" && shipment && (
          <section className={styles.packageEditor}>
            <header>
              <span>
                <strong>Volumes e cubagem</strong>
                <small>
                  Distribua integralmente cada item entre os volumes.
                </small>
              </span>
              <button
                type="button"
                onClick={() =>
                  setPackageRows((current) => [
                    ...current,
                    {
                      sequence: current.length + 1,
                      weightKg: "",
                      lengthCm: "",
                      widthCm: "",
                      heightCm: "",
                      labelFormat: "pdf",
                      items: shipment.items.map((item) => ({
                        shipmentItemId: item.id,
                        quantity: "0",
                      })),
                    },
                  ])
                }
              >
                Adicionar volume
              </button>
            </header>
            {packageRows.map((volume, volumeIndex) => (
              <article key={volume.sequence}>
                <header>
                  <strong>Volume {volumeIndex + 1}</strong>
                  {packageRows.length > 1 && (
                    <button
                      type="button"
                      className={styles.dangerText}
                      onClick={() =>
                        setPackageRows((current) =>
                          current
                            .filter((_, index) => index !== volumeIndex)
                            .map((row, index) => ({
                              ...row,
                              sequence: index + 1,
                            })),
                        )
                      }
                    >
                      Remover
                    </button>
                  )}
                </header>
                <div className={styles.packageDimensions}>
                  {(
                    ["weightKg", "lengthCm", "widthCm", "heightCm"] as const
                  ).map((field) => (
                    <label key={field}>
                      <span>{packageDimensionLabel(field)}</span>
                      <input
                        type="number"
                        min=".001"
                        step=".001"
                        required
                        value={volume[field]}
                        onChange={(event) =>
                          setPackageRows((current) =>
                            current.map((row, index) =>
                              index === volumeIndex
                                ? { ...row, [field]: event.target.value }
                                : row,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                  <label>
                    <span>Formato</span>
                    <select
                      value={volume.labelFormat}
                      onChange={(event) =>
                        setPackageRows((current) =>
                          current.map((row, index) =>
                            index === volumeIndex
                              ? { ...row, labelFormat: event.target.value }
                              : row,
                          ),
                        )
                      }
                    >
                      <option value="pdf">Impressão A4</option>
                      <option value="zpl">Térmica ZPL</option>
                    </select>
                  </label>
                </div>
                <div className={styles.packageItems}>
                  {shipment.items.map((item, itemIndex) => (
                    <label key={item.id}>
                      <span>
                        {item.salesOrderItem.variation?.sku ||
                          item.salesOrderItem.product.sku}
                        <small>{item.salesOrderItem.product.name}</small>
                      </span>
                      <input
                        type="number"
                        min="0"
                        max={item.quantity}
                        step=".0001"
                        aria-label={`${item.salesOrderItem.product.name} no volume ${volumeIndex + 1}`}
                        value={volume.items[itemIndex]?.quantity || "0"}
                        onChange={(event) =>
                          setPackageRows((current) =>
                            current.map((row, index) =>
                              index === volumeIndex
                                ? {
                                    ...row,
                                    items: row.items.map((entry, position) =>
                                      position === itemIndex
                                        ? {
                                            ...entry,
                                            quantity: event.target.value,
                                          }
                                        : entry,
                                    ),
                                  }
                                : row,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              </article>
            ))}
            {!packingValid && (
              <p className={styles.validationMessage}>
                Preencha a cubagem e distribua exatamente a quantidade
                solicitada de cada item.
              </p>
            )}
          </section>
        )}
        {modal.type === "dispatch" && shipment && (
          <>
            <div className={styles.formNote}>
              Fiscal:{" "}
              <strong>
                {shipment.fiscalRequired ? shipment.fiscalStatus : "dispensado"}
              </strong>{" "}
              · {shipment.packages.filter((item) => item.labelUrl).length}/
              {shipment.packages.length} etiqueta(s) pronta(s).
            </div>
            <Field label="Transportadora">
              <input
                name="carrier"
                list="dispatch-carriers"
                defaultValue={shipment.carrier || ""}
                required
              />
            </Field>
            <Field label="Serviço">
              <input name="service" defaultValue={shipment.service || ""} />
            </Field>
            <Field label="Código de rastreio" wide>
              <input
                name="trackingCode"
                defaultValue={
                  shipment.salesOrder.shippingLabels.find(
                    (label) => label.trackingCode,
                  )?.trackingCode || ""
                }
                required
              />
            </Field>
            <datalist id="dispatch-carriers">
              {data.carriers.map((carrier) => (
                <option value={carrier.label} key={carrier.key} />
              ))}
            </datalist>
          </>
        )}
        {modal.type === "deliver" && (
          <>
            <Field label="Nome do recebedor" wide>
              <input name="recipient" required />
            </Field>
            <Field label="Documento/identificação">
              <input name="document" />
            </Field>
            <Field label="URL do comprovante">
              <input name="proofUrl" type="url" placeholder="https://…" />
            </Field>
            <Field label="Observações" wide>
              <textarea name="notes" maxLength={500} />
            </Field>
          </>
        )}
        {modal.type === "incident" && (
          <>
            <Field label="Categoria">
              <select name="category" defaultValue="operational">
                <option value="operational">Operacional</option>
                <option value="stock">Estoque</option>
                <option value="carrier">Transportadora</option>
                <option value="address">Endereço</option>
                <option value="damage">Avaria</option>
                <option value="fiscal">Fiscal</option>
                <option value="customer">Cliente</option>
                <option value="other">Outro</option>
              </select>
            </Field>
            <Field label="Severidade">
              <select name="severity" defaultValue="medium">
                <option value="low">Baixa</option>
                <option value="medium">Média</option>
                <option value="high">Alta</option>
                <option value="critical">Crítica · bloqueia despacho</option>
              </select>
            </Field>
            <Field label="Responsável">
              <input name="owner" required placeholder="Nome ou equipe" />
            </Field>
            <Field label="Resolver até">
              <input
                name="dueAt"
                type="datetime-local"
                required
                defaultValue={incidentDueAt}
              />
            </Field>
            <Field label="Descrição da ocorrência" wide>
              <textarea
                name="description"
                minLength={2}
                maxLength={500}
                required
                placeholder="Descreva o fato, impacto e próxima ação…"
              />
            </Field>
            <Field label="Causa conhecida" wide>
              <textarea
                name="rootCause"
                maxLength={500}
                placeholder="Opcional nesta etapa"
              />
            </Field>
            <Field label="Valor reclamado">
              <input
                name="claimAmount"
                type="number"
                min="0"
                step=".01"
                defaultValue="0"
              />
            </Field>
          </>
        )}
        {modal.type === "resolve" && (
          <>
            <div className={styles.formNote}>
              Ocorrência de {shipment?.exceptionCategory || "operação"}, sob
              responsabilidade de {shipment?.exceptionOwner || "equipe"}.
            </div>
            <Field label="Resolução aplicada" wide>
              <textarea
                name="resolution"
                minLength={2}
                maxLength={500}
                required
                placeholder="Registre a causa, a correção e a prevenção…"
              />
            </Field>
            <Field label="Causa raiz" wide>
              <textarea
                name="rootCause"
                maxLength={500}
                required
                placeholder="Explique a causa para prevenir recorrência…"
              />
            </Field>
          </>
        )}
        {modal.type === "tracking" && (
          <>
            {shipment && shipment.packages.length > 0 && (
              <Field label="Volume">
                <select name="packageId" defaultValue="">
                  <option value="">Todos os volumes</option>
                  {shipment.packages.map((volume) => (
                    <option key={volume.id} value={volume.id}>
                      Volume {volume.sequence} ·{" "}
                      {volume.trackingCode || volume.code}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Checkpoint">
              <select name="status" defaultValue="in_transit">
                <option value="in_transit">Em trânsito</option>
                <option value="out_for_delivery">Saiu para entrega</option>
                <option value="delivery_failed">Tentativa sem sucesso</option>
                <option value="awaiting_pickup">Aguardando retirada</option>
                <option value="returned_to_sender">Em devolução</option>
                <option value="delivered">Entregue</option>
              </select>
            </Field>
            <Field label="Data e hora">
              <input
                name="occurredAt"
                type="datetime-local"
                required
                defaultValue={checkpointAt}
              />
            </Field>
            <Field label="Local">
              <input name="location" placeholder="Cidade / unidade" />
            </Field>
            <Field label="Descrição" wide>
              <textarea name="description" maxLength={500} required />
            </Field>
          </>
        )}
        {modal.type === "return" && (
          <>
            <Field label="Motivo">
              <select name="reason" defaultValue="withdrawal">
                <option value="withdrawal">Arrependimento</option>
                <option value="defect">Defeito</option>
                <option value="wrong_item">Item incorreto</option>
                <option value="damage">Avaria</option>
                <option value="delivery_failure">Falha na entrega</option>
                <option value="other">Outro</option>
              </select>
            </Field>
            <Field label="E-mail do cliente">
              <input
                name="customerEmail"
                type="email"
                required
                defaultValue={shipment?.salesOrder.customerEmail || ""}
              />
            </Field>
            <Field label="Operador reverso">
              <input name="provider" placeholder="Correios / transportadora" />
            </Field>
            <Field label="Código de autorização">
              <input name="reverseCode" />
            </Field>
            <Field label="Rastreio reverso">
              <input name="trackingCode" />
            </Field>
            <Field label="URL da etiqueta">
              <input name="labelUrl" type="url" placeholder="https://…" />
            </Field>
            <Field label="Descrição" wide>
              <textarea name="description" maxLength={500} required />
            </Field>
            {shipment && (
              <section className={styles.returnItems}>
                <header>
                  <strong>Itens da devolução</strong>
                  <small>Ajuste para devolução parcial.</small>
                </header>
                {shipment.items.map((item) => (
                  <label key={item.id}>
                    <span>
                      <strong>{item.salesOrderItem.product.name}</strong>
                      <small>
                        {item.salesOrderItem.variation?.sku ||
                          item.salesOrderItem.product.sku}
                      </small>
                    </span>
                    <input
                      name={`return-item-${item.id}`}
                      type="number"
                      min="0"
                      max={item.quantity}
                      step=".0001"
                      defaultValue={item.quantity}
                    />
                  </label>
                ))}
              </section>
            )}
          </>
        )}
        {modal.type === "returnState" && activeReturn && (
          <>
            <div className={styles.formNote}>
              Reversa #{activeReturn.id} ·{" "}
              {returnStatusLabel(activeReturn.status)}
            </div>
            <Field label="Próxima etapa">
              <select name="status" required defaultValue="">
                <option value="" disabled>
                  Selecione
                </option>
                {returnTransitions(activeReturn.status).map((status) => (
                  <option value={status} key={status}>
                    {returnStatusLabel(status)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Operador reverso">
              <input
                name="provider"
                defaultValue={activeReturn.reverseProvider || ""}
              />
            </Field>
            <Field label="Código de autorização">
              <input
                name="reverseCode"
                defaultValue={activeReturn.reverseCode || ""}
              />
            </Field>
            <Field label="Rastreio reverso">
              <input
                name="trackingCode"
                defaultValue={activeReturn.reverseTrackingCode || ""}
              />
            </Field>
            <Field label="URL da etiqueta">
              <input
                name="labelUrl"
                type="url"
                defaultValue={activeReturn.reverseLabelUrl || ""}
              />
            </Field>
            <Field label="Observações" wide>
              <textarea name="notes" maxLength={500} />
            </Field>
          </>
        )}
        {modal.type === "returnInspect" && activeReturn && (
          <>
            <div className={styles.formNote}>
              Recebimento da reversa #{activeReturn.id}. O destino controla se o
              saldo volta a ficar vendável.
            </div>
            <Field label="Depósito de recebimento" wide>
              <select name="warehouseId" required defaultValue="">
                <option value="" disabled>
                  Selecione
                </option>
                {data.warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </Field>
            <section className={styles.returnInspection}>
              {returnRows.map((row, index) => {
                const item = activeReturn.items[index];
                return (
                  <article key={row.returnItemId}>
                    <header>
                      <strong>Item {item?.orderItemId}</strong>
                      <small>
                        Solicitado: {number.format(item?.quantity || 0)}
                      </small>
                    </header>
                    <label>
                      <span>Recebido</span>
                      <input
                        type="number"
                        min="0"
                        max={item?.quantity || 0}
                        step=".0001"
                        value={row.receivedQuantity}
                        onChange={(event) =>
                          setReturnRows((current) =>
                            current.map((entry, position) =>
                              position === index
                                ? {
                                    ...entry,
                                    receivedQuantity: event.target.value,
                                  }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      <span>Condição</span>
                      <select
                        value={row.condition}
                        onChange={(event) =>
                          setReturnRows((current) =>
                            current.map((entry, position) =>
                              position === index
                                ? { ...entry, condition: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      >
                        <option value="new">Novo/lacrado</option>
                        <option value="opened">Aberto</option>
                        <option value="used">Usado</option>
                        <option value="damaged">Avariado</option>
                        <option value="defective">Defeituoso</option>
                      </select>
                    </label>
                    <label>
                      <span>Destino</span>
                      <select
                        value={row.disposition}
                        onChange={(event) =>
                          setReturnRows((current) =>
                            current.map((entry, position) =>
                              position === index
                                ? { ...entry, disposition: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      >
                        <option value="restock">Repor ao estoque</option>
                        <option value="quarantine">Quarentena</option>
                        <option value="repair">Reparo</option>
                        <option value="scrap">Descarte</option>
                        <option value="return_to_supplier">
                          Devolver ao fornecedor
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>Observação</span>
                      <input
                        maxLength={500}
                        value={row.notes}
                        onChange={(event) =>
                          setReturnRows((current) =>
                            current.map((entry, position) =>
                              position === index
                                ? { ...entry, notes: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                  </article>
                );
              })}
            </section>
            <Field label="Parecer geral" wide>
              <textarea name="notes" maxLength={500} />
            </Field>
          </>
        )}
        {modal.type === "cancel" && (
          <>
            <input type="hidden" name="confirmation" value="CANCELAR" />
            <div className={styles.formNote}>
              O envio sairá da fila, mas o pedido e sua reserva serão
              preservados para reabertura ou tratamento comercial.
            </div>
            <Field label="Motivo do cancelamento" wide>
              <textarea name="reason" maxLength={500} required />
            </Field>
          </>
        )}
        {modal.type === "manifest" && (
          <>
            <div className={styles.orderPreview}>
              <span>
                <small>Expedições selecionadas</small>
                <strong>{modal.shipmentIds?.length || 0}</strong>
              </span>
            </div>
            <Field label="Transportadora">
              <input name="carrier" list="manifest-carriers" required />
            </Field>
            <Field label="Número do romaneio">
              <input
                name="manifestNumber"
                placeholder="Gerado automaticamente"
              />
            </Field>
            <Field label="Janela de coleta">
              <input name="pickupWindow" type="datetime-local" />
            </Field>
            <Field label="Doca">
              <input name="dock" maxLength={80} />
            </Field>
            <Field label="Placa">
              <input name="vehiclePlate" maxLength={12} />
            </Field>
            <Field label="Motorista">
              <input name="driverName" maxLength={160} />
            </Field>
            <Field label="Documento do motorista">
              <input name="driverDocument" maxLength={30} />
            </Field>
            <Field label="Protocolo">
              <input name="protocol" maxLength={160} />
            </Field>
            <label className={styles.toggle}>
              <input name="confirmHandoff" type="checkbox" />
              <span>
                <strong>Confirmar coleta agora</strong>
                <small>
                  Use somente se todos os volumes já foram despachados.
                </small>
              </span>
            </label>
            <datalist id="manifest-carriers">
              {data.carriers.map((carrier) => (
                <option value={carrier.label} key={carrier.key} />
              ))}
            </datalist>
          </>
        )}
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancelar
          </button>
          <button
            type="submit"
            className={styles.primary}
            disabled={
              busy || !pickingValid || !packingValid || !shipmentOpeningValid
            }
          >
            {busy ? "Processando…" : logisticsSubmitLabel(modal.type)}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function Modal({
  eyebrow,
  title,
  close,
  busy = false,
  error = "",
  children,
}: {
  eyebrow: string;
  title: string;
  close: () => void;
  busy?: boolean;
  error?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const busyRef = useRef(busy);
  useEffect(() => {
    closeRef.current = close;
    busyRef.current = busy;
  }, [close, busy]);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow,
      previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const focusable = () => [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) || []),
    ].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    (focusable()[0] || dialogRef.current)?.focus();
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target))
        (focusable()[0] || dialogRef.current)?.focus();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("focusin", containFocus);
      if (previousFocus?.isConnected) {
        const returnTarget = previousFocus.getClientRects().length
          ? previousFocus
          : previousFocus.closest("details")?.querySelector("summary");
        returnTarget?.focus();
      }
    };
  }, []);
  return (
    <div
      className={styles.modal}
    >
      <button
        type="button"
        className={styles.backdrop}
        onClick={close}
        disabled={busy}
        tabIndex={-1}
        aria-hidden="true"
        aria-label="Fechar janela"
      />
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={error ? errorId : undefined}>
        <header>
          <div>
            <span>{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Fechar">
            ×
          </button>
        </header>
        {error && <p id={errorId} className={styles.modalError} role="alert">{error}</p>}
        {children}
      </section>
    </div>
  );
}
function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={wide ? styles.wide : ""}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.empty}>
      <ErpIcon name="dashboard" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
function Health({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <article data-alert={value > 0}>
      <b>{value}</b>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </article>
  );
}
function ActionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  return (
    <details className={styles.menu} ref={menuRef}>
      <summary aria-label={label} aria-haspopup="true">
        •••
      </summary>
      <div
        role="group"
        aria-label={label}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, a"))
            menuRef.current?.removeAttribute("open");
        }}
      >
        {children}
      </div>
    </details>
  );
}
function ProviderMark({ provider }: { provider: string }) {
  return (
    <b className={styles.providerMark}>
      {providerLabel(provider).slice(0, 2).toUpperCase()}
    </b>
  );
}
function providerLabel(value: string) {
  return (
    (
      {
        mercado_livre: "Mercado Livre",
        shopee: "Shopee",
        woocommerce: "WooCommerce",
        shopify: "Shopify",
        amazon: "Amazon",
        magalu: "Magalu",
        nuvemshop: "Nuvemshop",
        tiktok_shop: "TikTok Shop",
        other: "Outro canal",
      } as Record<string, string>
    )[value] || value
  );
}
function connectionLabel(channel: Channel) {
  if (!channel.credential) return "Operação local · sem conector";
  if (!channel.credential.enabled) return "Credencial desativada";
  if (channel.credential.lastTestOk === true) return "Conexão testada e ativa";
  if (channel.credential.lastTestOk === false) return "Falha no último teste";
  return "Conexão aguardando teste";
}
function targetPrice(price: number, adjustment: number) {
  return Math.round(price * (1 + adjustment / 100) * 100) / 100;
}
function statusLabel(value: string) {
  return (
    (
      { active: "Ativo", paused: "Pausado", error: "Erro" } as Record<
        string,
        string
      >
    )[value] || value
  );
}
function orderStatus(value: string) {
  return (
    (
      {
        imported: "Importado",
        shipped: "Despachado",
        delivered: "Entregue",
        cancelled: "Cancelado",
        on_hold: "Em espera",
      } as Record<string, string>
    )[value] || value
  );
}
function paymentStatusLabel(value: string) {
  return (
    (
      {
        unknown: "Não informado",
        pending: "Pendente",
        paid: "Pago no canal",
        partially_refunded: "Estorno parcial",
        refunded: "Estornado",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[value] || value
  );
}
function riskStatusLabel(value: string) {
  return (
    (
      {
        unknown: "não informado",
        approved: "aprovado",
        review: "em análise",
        blocked: "bloqueado",
      } as Record<string, string>
    )[value] || value
  );
}
function orderExceptionLabel(order: ChannelOrder) {
  if (order.buyerCancelRequested) return "cliente solicitou cancelamento";
  if (order.riskStatus === "blocked") return "risco bloqueado";
  if (order.riskStatus === "review") return "risco em análise";
  if (order.paymentStatus === "cancelled") return "pagamento cancelado";
  if (order.paymentStatus === "pending") return "pagamento pendente";
  if (order.shipByAt && order.status === "imported")
    return "limite de despacho deve ser verificado";
  return "revisão operacional necessária";
}
function shipmentStatus(value: string) {
  return (
    (
      {
        picking: "Separação",
        packed: "Embalado",
        dispatched: "Em transporte",
        on_hold: "Em espera",
        delivered: "Entregue",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[value] || value
  );
}
function priorityLabel(value: string) {
  return (
    (
      {
        low: "Prioridade baixa",
        normal: "Prioridade normal",
        high: "Prioridade alta",
        urgent: "Prioridade urgente",
      } as Record<string, string>
    )[value] || value
  );
}
function eventLabel(value: string) {
  return (
    (
      {
        created: "Expedição criada",
        picking_progress: "Progresso da separação",
        picked: "Separação concluída",
        packed: "Embalagem registrada",
        dispatched: "Despacho",
        delivered: "Entrega",
        incident: "Ocorrência",
        incident_resolved: "Ocorrência resolvida",
        tracking_checkpoint: "Checkpoint de rastreio",
        manifested: "Inclusão em romaneio",
        handoff: "Coleta confirmada",
        wave_assigned: "Onda atribuída",
        freight_quoted: "Frete cotado",
        label_generated: "Etiqueta gerada",
        return_inspected: "Devolução inspecionada",
        return_requested: "Logística reversa",
        return_updated: "Atualização da logística reversa",
        cancelled: "Cancelamento",
        reopened: "Reabertura",
      } as Record<string, string>
    )[value] || value
  );
}
function returnStatusLabel(value: string) {
  return (
    (
      {
        pending: "Aguardando autorização",
        authorized: "Autorizada",
        in_transit: "Em trânsito",
        received: "Recebida",
        completed: "Concluída",
        rejected: "Recusada",
        cancelled: "Cancelada",
      } as Record<string, string>
    )[value] || value
  );
}
function returnTransitions(value: string) {
  return (
    (
      {
        pending: ["authorized", "rejected", "cancelled"],
        authorized: ["in_transit", "received", "cancelled"],
        in_transit: ["received", "cancelled"],
        received: ["completed"],
      } as Record<string, string[]>
    )[value] || []
  );
}
function pickingProgress(shipment: Shipment) {
  const total = shipment.items.reduce((sum, item) => sum + item.quantity, 0),
    picked = shipment.items.reduce((sum, item) => sum + item.pickedQuantity, 0);
  return total ? Math.min(100, (picked / total) * 100) : 100;
}
function shipmentNextAction(
  shipment: Shipment,
): { type: "pick" | "pack" | "dispatch" | "deliver"; label: string } | null {
  if (shipment.status === "picking")
    return shipment.items.every((item) => item.pickedQuantity >= item.quantity)
      ? { type: "pack", label: "Registrar embalagem" }
      : { type: "pick", label: "Conferir separação" };
  if (shipment.status === "packed")
    return { type: "dispatch", label: "Despachar" };
  if (shipment.status === "dispatched")
    return { type: "deliver", label: "Confirmar entrega" };
  return null;
}
function shipmentSla(shipment: Shipment) {
  const deadline = shipment.dispatchDeadlineAt
    ? new Date(shipment.dispatchDeadlineAt)
    : shipment.deadlineAt
      ? new Date(`${shipment.deadlineAt.slice(0, 10)}T23:59:59.999Z`)
      : null;
  if (!deadline) return { label: "Sem SLA", kind: "neutral" };
  const diff = deadline.getTime() - Date.now(),
    hours = diff / 3_600_000;
  if (diff < 0)
    return {
      label: `Atrasado ${Math.max(1, Math.ceil(Math.abs(hours)))} h`,
      kind: "late",
    };
  if (hours <= 24)
    return {
      label: `Vence em ${Math.max(1, Math.ceil(hours))} h`,
      kind: "today",
    };
  return { label: `${Math.ceil(hours / 24)} dia(s)`, kind: "active" };
}
function shipmentScore(shipment: Shipment) {
  const sla = shipmentSla(shipment);
  return (
    (sla.kind === "late" ? 10000 : sla.kind === "today" ? 5000 : 0) +
    (
      { urgent: 4000, high: 2000, normal: 1000, low: 0 } as Record<
        string,
        number
      >
    )[shipment.priority] -
    new Date(shipment.createdAt).getTime() / 1e12
  );
}
function logisticsActionLabel(value: string) {
  return (
    (
      {
        pick: "Separar",
        pack: "Embalar",
        dispatch: "Despachar",
        deliver: "Entregar",
        incident: "Ocorrência em",
        resolve: "Resolver ocorrência em",
        tracking: "Atualizar rastreio de",
        return: "Logística reversa de",
        returnState: "Atualizar logística reversa de",
        returnInspect: "Inspecionar devolução de",
        cancel: "Cancelar",
        manifest: "Gerar romaneio",
      } as Record<string, string>
    )[value] || value
  );
}
function logisticsSuccess(value: string) {
  return (
    (
      {
        create: "Expedição aberta e priorizada.",
        pick: "Progresso da separação salvo.",
        pack: "Embalagem e cubagem registradas.",
        dispatch: "Despacho confirmado, estoque baixado e rastreio criado.",
        deliver: "Entrega confirmada com comprovante.",
        incident: "Ocorrência registrada na linha do tempo.",
        resolve: "Ocorrência resolvida e auditada.",
        tracking: "Checkpoint de rastreio registrado.",
        return: "Logística reversa aberta para o pedido.",
        returnState: "Logística reversa atualizada.",
        returnInspect: "Devolução inspecionada e estoque destinado.",
        cancel: "Expedição cancelada com motivo e trilha de auditoria.",
        manifest: "Romaneio gerado para as expedições selecionadas.",
      } as Record<string, string>
    )[value] || "Etapa concluída."
  );
}
function logisticsSubmitLabel(value: string) {
  return (
    (
      {
        create: "Abrir expedição",
        pick: "Salvar conferência",
        pack: "Registrar embalagem",
        dispatch: "Confirmar despacho",
        deliver: "Confirmar entrega",
        incident: "Registrar ocorrência",
        resolve: "Concluir ocorrência",
        tracking: "Salvar checkpoint",
        return: "Abrir logística reversa",
        returnState: "Salvar etapa da reversa",
        returnInspect: "Concluir inspeção",
        cancel: "Cancelar expedição",
        manifest: "Gerar romaneio",
      } as Record<string, string>
    )[value] || "Confirmar etapa"
  );
}
function exportLogisticsCsv(endpoint: string) {
  const separator = endpoint.includes("?") ? "&" : "?",
    link = document.createElement("a");
  link.href = `${endpoint}${separator}export=csv`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

function manifestStatusLabel(value: string) {
  return (
    (
      {
        open: "Aberto",
        closed: "Fechado",
        handed_off: "Coletado",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[value] || value
  );
}

function incidentCategoryLabel(value: string) {
  return (
    (
      {
        operational: "Operação",
        stock: "Estoque",
        carrier: "Transportadora",
        address: "Endereço",
        damage: "Avaria",
        fiscal: "Fiscal",
        customer: "Cliente",
        other: "Outro",
      } as Record<string, string>
    )[value] || value
  );
}

function severityLabel(value: string) {
  return (
    (
      {
        low: "baixa",
        medium: "média",
        high: "alta",
        critical: "crítica",
      } as Record<string, string>
    )[value] || value
  );
}

function returnDispositionLabel(value: string) {
  return (
    (
      {
        pending: "Pendente",
        restock: "Reposto",
        quarantine: "Quarentena",
        repair: "Reparo",
        scrap: "Descarte",
        return_to_supplier: "Fornecedor",
      } as Record<string, string>
    )[value] || value
  );
}

function packageDimensionLabel(value: string) {
  return (
    (
      {
        weightKg: "Peso (kg)",
        lengthCm: "Comp. (cm)",
        widthCm: "Larg. (cm)",
        heightCm: "Alt. (cm)",
      } as Record<string, string>
    )[value] || value
  );
}

function formatAttributes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Variação";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}: ${String(item)}`)
    .join(" · ");
}

function shipmentAddress(shipment: Shipment) {
  const order = shipment.salesOrder;
  return (
    [
      [order.deliveryStreet, order.deliveryNumber].filter(Boolean).join(", "),
      order.deliveryComplement,
      order.deliveryDistrict,
      [order.deliveryCity, order.deliveryState].filter(Boolean).join("/"),
      order.deliveryZip,
    ]
      .filter(Boolean)
      .join(" · ") || "Não informado"
  );
}

function toLocalDateTime(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function dateTimeInput(value: string | null) {
  return value ? toLocalDateTime(new Date(value)) : "";
}

function printShipment(shipment: Shipment) {
  const popup = window.open("", "_blank", "width=920,height=760");
  if (!popup) return;
  const itemRows = shipment.items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.salesOrderItem.variation?.sku || item.salesOrderItem.product.sku)}</td><td>${escapeHtml(item.salesOrderItem.product.name)}${item.salesOrderItem.variation ? `<br><small>${escapeHtml(formatAttributes(item.salesOrderItem.variation.attributes))}</small>` : ""}</td><td>${number.format(item.quantity)}</td><td>${escapeHtml(item.location || "")}</td><td></td></tr>`,
    )
    .join("");
  popup.document
    .write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(shipment.number)}</title><style>
    body{font:14px system-ui,sans-serif;color:#17202b;margin:32px}header{display:flex;justify-content:space-between;border-bottom:2px solid #17202b;padding-bottom:16px;margin-bottom:20px}h1{font-size:24px;margin:0}p{margin:5px 0}table{width:100%;border-collapse:collapse;margin-top:22px}th,td{border:1px solid #aab3bd;padding:10px;text-align:left}th{background:#eef2f5}footer{margin-top:28px;display:grid;grid-template-columns:1fr 1fr;gap:40px}.sign{border-top:1px solid #17202b;padding-top:8px;margin-top:52px}@media print{button{display:none}body{margin:12mm}}</style></head><body>
    <header><div><small>LISTA DE SEPARAÇÃO</small><h1>${escapeHtml(shipment.number)}</h1><p>Pedido ${escapeHtml(shipment.salesOrder.number)}</p></div><div><p><strong>${escapeHtml(shipment.salesOrder.customerName)}</strong></p><p>${escapeHtml(shipment.warehouse.name)}</p><p>${escapeHtml(shipment.carrier || "Transportadora a definir")}</p></div></header>
    <p><strong>Destino:</strong> ${escapeHtml(shipmentAddress(shipment))}</p>
    <p><strong>Volumes:</strong> ${shipment.packageCount} · <strong>Prioridade:</strong> ${escapeHtml(priorityLabel(shipment.priority))}</p>
    <table><thead><tr><th>SKU</th><th>Produto/variação</th><th>Quantidade</th><th>Endereço</th><th>Conferido</th></tr></thead><tbody>${itemRows}</tbody></table>
    <footer><div class="sign">Separado por / data</div><div class="sign">Conferido por / data</div></footer><button onclick="window.print()">Imprimir</button></body></html>`);
  popup.document.close();
  popup.focus();
}

function printPackageLabels(shipment: Shipment) {
  const popup = window.open("", "_blank", "width=920,height=760");
  if (!popup) return;
  const labels = shipment.packages
    .filter((volume) => volume.labelUrl)
    .map(
      (volume) =>
        `<article><header><span>NALVEN LOGÍSTICA</span><b>${escapeHtml(volume.carrier || shipment.carrier || "TRANSPORTADORA")}</b></header><h1>${escapeHtml(shipment.salesOrder.customerName)}</h1><p>${escapeHtml(shipmentAddress(shipment))}</p><dl><div><dt>Pedido</dt><dd>${escapeHtml(shipment.salesOrder.number)}</dd></div><div><dt>Expedição</dt><dd>${escapeHtml(shipment.number)}</dd></div><div><dt>Volume</dt><dd>${volume.sequence}/${shipment.packages.length}</dd></div><div><dt>Peso</dt><dd>${number.format(volume.weightKg)} kg</dd></div></dl><div class="code">${escapeHtml(volume.trackingCode || volume.code)}</div><small>SSCC ${escapeHtml(volume.sscc || "não informado")}</small></article>`,
    )
    .join("");
  popup.document.write(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Etiquetas ${escapeHtml(shipment.number)}</title><style>body{margin:0;font:14px system-ui,sans-serif;color:#101820}article{box-sizing:border-box;width:100mm;min-height:145mm;padding:9mm;border:1px dashed #667;page-break-after:always}header{display:flex;justify-content:space-between;border-bottom:2px solid;padding-bottom:8px}h1{font-size:20px;margin:18px 0 6px}p{min-height:40px;line-height:1.5}dl{display:grid;grid-template-columns:1fr 1fr;gap:8px}dt{font-size:11px;text-transform:uppercase}dd{margin:2px 0;font-weight:700}.code{margin:24px 0 8px;padding:14px;border:2px solid;text-align:center;font:700 20px monospace;letter-spacing:.12em}@media print{article{border:0}button{display:none}}</style></head><body>${labels}<button onclick="window.print()">Imprimir</button></body></html>`,
  );
  popup.document.close();
  popup.focus();
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
