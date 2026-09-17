"use client";
import { tenantDateTimeFormatter, tenantTimeZone } from "@/lib/client-timezone";
import { usePlanFeatures } from "./plan-features";

/* eslint-disable @next/next/no-img-element */
import type { CSSProperties, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErpIcon } from "@/components/erp/erp-icon";
import { ErpModal } from "@/components/erp/modal-portal";

type Status = {
  key: string;
  label: string;
  color: string;
  description?: string | null;
  native: boolean;
};
type CatalogProduct = {
  id: number;
  name: string;
  sku: string;
  price: number;
  availableStock: number;
  unit: string;
  type: string;
  variations: Array<{
    id: number;
    sku?: string | null;
    attributes: unknown;
    regularPrice?: number | null;
    salePrice?: number | null;
  }>;
};
type Customer = {
  id: number;
  name: string;
  tradeName?: string | null;
  document: string;
  email?: string | null;
  phone?: string | null;
  addresses: Array<{
    zip?: string | null;
    street?: string | null;
    number?: string | null;
    complement?: string | null;
    district?: string | null;
    city?: string | null;
    state?: string | null;
  }>;
};
type OrderItem = {
  id: number;
  productId: number;
  nameSnapshot: string;
  skuSnapshot?: string | null;
  imageSnapshot?: string | null;
  quantity: number;
  refundedQuantity: number;
  unitPrice: number;
  listPrice: number;
  discount: number;
  total: number;
  notes?: string | null;
  product: { name: string; sku: string; unit: string };
};
type TimelineItem = {
  id: number;
  createdAt: string;
  actor?: string;
  author?: string;
  notes?: string | null;
  content?: string;
  fromStatus?: string | null;
  toStatus?: string;
  customerVisible?: boolean;
};
type Order = {
  id: number;
  number: string;
  orderKey: string;
  kind: string;
  status: string;
  origin: string;
  customerId?: number | null;
  customerName: string;
  customerDocument?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  salesChannel: string;
  salesperson?: string | null;
  priority: string;
  createdAt: string;
  placedAt: string;
  updatedAt: string;
  validUntil?: string | null;
  expectedAt?: string | null;
  subtotal: number;
  discount: number;
  freightAmount: number;
  taxAmount: number;
  total: number;
  refundedTotal: number;
  paymentMethod?: string | null;
  paymentTitle?: string | null;
  transactionId?: string | null;
  paidAt?: string | null;
  deliveryType: string;
  deliveryZip?: string | null;
  deliveryStreet?: string | null;
  deliveryNumber?: string | null;
  deliveryComplement?: string | null;
  deliveryDistrict?: string | null;
  deliveryCity?: string | null;
  deliveryState?: string | null;
  notes?: string | null;
  internalNotes?: string | null;
  shippingPending: boolean;
  deletedAt?: string | null;
  items: OrderItem[];
  history: TimelineItem[];
  notesTimeline: TimelineItem[];
  addresses: Array<Record<string, string | number | null>>;
  refunds: Array<{
    id: number;
    amount: number;
    reason?: string | null;
    actor: string;
    createdAt: string;
    items: Array<{ orderItemId: number; quantity: number; amount: number }>;
  }>;
  tracking?: {
    trackingNumber: string;
    carrier?: string | null;
    carrierKey?: string | null;
    trackingUrl?: string | null;
    statusLabel?: string | null;
    events: Array<{
      id: number;
      description: string;
      location?: string | null;
      occurredAt: string;
    }>;
  } | null;
  notificationLogs: Array<{
    id: number;
    channel: string;
    success: boolean;
    skipped: boolean;
    skipReason?: string | null;
    createdAt: string;
  }>;
  payments: Array<{
    id: number;
    type: string;
    status: string;
    amount: number;
    method?: string | null;
    paidAt?: string | null;
  }>;
  returns: Array<{
    id: number;
    reason: string;
    description: string;
    status: string;
    customerEmail: string;
    adminNotes?: string | null;
    requestedAt: string;
    items: Array<{ orderItemId: number; quantity: number }>;
  }>;
  documents: Array<{
    id: number;
    type: string;
    name: string;
    externalUrl?: string | null;
    createdAt: string;
  }>;
  shippingLabels: Array<{
    id: number;
    provider: string;
    serviceId?: string | null;
    serviceName?: string | null;
    carrier?: string | null;
    status: string;
    statusLabel?: string | null;
    amount: number;
    protocol?: string | null;
    trackingCode?: string | null;
    trackingUrl?: string | null;
    labelUrl?: string | null;
    createdAt: string;
  }>;
  reviewRequests: Array<{
    id: number;
    token: string;
    state: string;
    sendCount: number;
    expiresAt: string;
    orderItemId: number;
  }>;
};
type Dataset = {
  organization: { slug: string; name: string };
  items: Order[];
  statuses: Status[];
  carriers: Array<{ key: string; label: string; urlTemplate?: string | null }>;
  customers: Customer[];
  products: CatalogProduct[];
  returns: Array<{ id: number; status: string }>;
  queue: Array<{
    id: number;
    channel: string;
    state: string;
    attempts: number;
    lastError?: string | null;
    createdAt: string;
    salesOrder: { number: string; customerName: string };
  }>;
  pagination: { page: number; perPage: number; total: number; pages: number };
  summary: {
    total: number;
    revenue: number;
    averageTicket: number;
    refunded: number;
    items: number;
  };
  analytics?: {
    byStatus: Array<{
      status: string;
      _count: { _all: number };
      _sum: { total: number | null };
    }>;
    byPayment: Array<{
      paymentMethod?: string | null;
      _count: { _all: number };
      _sum: { total: number | null };
    }>;
    byState: Array<{
      deliveryState?: string | null;
      _count: { _all: number };
      _sum: { total: number | null };
    }>;
  };
  notificationSettings?: { enabled: boolean; settings: unknown } | null;
  notificationProvider?: {
    emailConfigured?: boolean;
    providers?: Array<{ id: string; label: string; tested?: boolean | null }>;
  };
};

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const dateTime = tenantDateTimeFormatter({ dateStyle: "short",
  timeStyle: "short",
});
const baseColumns = [
  "pending",
  "processing",
  "preparing",
  "shipped",
  "out-delivery",
  "completed",
];
const clientTransitions: Record<string, readonly string[]> = {
  draft: ["approved", "pending", "processing", "on-hold", "cancelled"],
  approved: ["pending", "processing", "preparing", "completed", "cancelled"],
  pending: [
    "processing",
    "on-hold",
    "failed",
    "cancelled",
    "awaiting-shipping",
  ],
  processing: [
    "on-hold",
    "preparing",
    "shipped",
    "completed",
    "cancelled",
    "refunded",
  ],
  "on-hold": ["pending", "processing", "preparing", "cancelled"],
  preparing: ["processing", "on-hold", "shipped", "cancelled"],
  shipped: ["preparing", "out-delivery", "delivered", "completed"],
  "out-delivery": ["shipped", "delivered", "completed"],
  delivered: ["completed", "refunded"],
  completed: ["refunded"],
  "awaiting-shipping": ["pending", "processing", "cancelled"],
  failed: ["pending", "cancelled"],
  cancelled: [],
  refunded: [],
};
const tabs = [
  ["detalhes", "Detalhes"],
  ["envio", "Envio e rastreio"],
  ["frete", "Frete e etiquetas"],
  ["timeline", "Notas e timeline"],
  ["reembolsos", "Reembolsos"],
  ["cliente", "Cliente"],
  ["devolucoes", "Devoluções"],
  ["documentos", "Documentos"],
  ["comunicacao", "Comunicação"],
] as const;

export function OrderManagement() {
  const features = usePlanFeatures();
  const [data, setData] = useState<Dataset | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [view, setView] = useState<"table" | "kanban">("table"),
    [selected, setSelected] = useState<number[]>([]),
    [detailId, setDetailId] = useState<number | null>(null),
    [createOpen, setCreateOpen] = useState(false),
    [operationsOpen, setOperationsOpen] = useState(false),
    [filtersOpen, setFiltersOpen] = useState(false);
  const initial = useMemo(
    () =>
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search),
    [],
  );
  const [search, setSearch] = useState(initial.get("busca") || ""),
    [status, setStatus] = useState(initial.get("status") || ""),
    [after, setAfter] = useState(initial.get("de") || ""),
    [before, setBefore] = useState(initial.get("ate") || ""),
    [page, setPage] = useState(Number(initial.get("pagina") || 1));
  const [advanced, setAdvanced] = useState({
    origin: initial.get("origem") || "",
    payment: initial.get("pagamento") || "",
    kind: initial.get("tipo") || "",
    customer: initial.get("cliente") || "",
    min: initial.get("minimo") || "",
    max: initial.get("maximo") || "",
    shipping: initial.get("frete") === "pendente",
    trash: initial.get("lixeira") === "1",
  });
  const requestId = useRef(0),
    debounce = useRef<ReturnType<typeof setTimeout> | null>(null),
    activeRequest = useRef<AbortController | null>(null);
  const load = useCallback(
    async (options?: { immediate?: boolean }) => {
      const id = ++requestId.current;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const params = new URLSearchParams({
        page: String(page),
        per_page: "20",
        orderby: "date",
        order: "desc",
      });
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      if (after) params.set("after", after);
      if (before) params.set("before", before);
      if (advanced.origin) params.set("origin", advanced.origin);
      if (advanced.payment) params.set("payment_method", advanced.payment);
      if (advanced.kind) params.set("kind", advanced.kind);
      if (advanced.customer) params.set("customer_id", advanced.customer);
      if (advanced.min) params.set("min_total", advanced.min);
      if (advanced.max) params.set("max_total", advanced.max);
      if (advanced.shipping) params.set("shipping_pending", "true");
      if (advanced.trash) params.set("trash", "true");
      const run = async () => {
        setError("");
        try {
          const response = await fetch(`/api/erp/order-management?${params}`, {
              cache: "no-store",
              signal: controller.signal,
            }),
            body = await response.json();
          if (id !== requestId.current) return;
          if (!response.ok)
            throw new Error(
              body.error || "Não foi possível carregar os pedidos.",
            );
          setData(body);
          const visible = new Set(body.items.map((item: Order) => item.id));
          setSelected((current) => current.filter((item) => visible.has(item)));
          const route = new URLSearchParams();
          if (search) route.set("busca", search);
          if (status) route.set("status", status);
          if (after) route.set("de", after);
          if (before) route.set("ate", before);
          if (advanced.origin) route.set("origem", advanced.origin);
          if (advanced.payment) route.set("pagamento", advanced.payment);
          if (advanced.kind) route.set("tipo", advanced.kind);
          if (advanced.customer) route.set("cliente", advanced.customer);
          if (advanced.min) route.set("minimo", advanced.min);
          if (advanced.max) route.set("maximo", advanced.max);
          if (advanced.shipping) route.set("frete", "pendente");
          if (advanced.trash) route.set("lixeira", "1");
          if (page > 1) route.set("pagina", String(page));
          history.replaceState(
            null,
            "",
            `${location.pathname}${route.size ? `?${route}` : ""}`,
          );
        } catch (caught) {
          if ((caught as Error).name !== "AbortError")
            setError(
              caught instanceof Error
                ? caught.message
                : "Falha ao carregar pedidos.",
            );
        }
      };
      if (options?.immediate) await run();
      else {
        if (debounce.current) clearTimeout(debounce.current);
        debounce.current = setTimeout(run, 400);
      }
      return () => controller.abort();
    },
    [search, status, after, before, page, advanced],
  );
  useEffect(() => {
    void load();
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      activeRequest.current?.abort();
    };
  }, [load]);
  const command = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError("");
    try {
      const endpoint =
          typeof payload._endpoint === "string"
            ? payload._endpoint
            : "/api/erp/order-management",
        requestPayload = { ...payload };
      delete requestPayload._endpoint;
      const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(endpoint === "/api/erp/orders"
              ? { "idempotency-key": crypto.randomUUID() }
              : {}),
          },
          body: JSON.stringify(requestPayload),
        }),
        body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Não foi possível concluir a operação.");
      setNotice(
        body.failed?.length
          ? `${body.succeeded} de ${body.requested} atualizados. ${body.failed.map((item: { id: number; error: string }) => `#${item.id}: ${item.error}`).join(" · ")}`
          : success,
      );
      window.setTimeout(() => setNotice(""), 5000);
      await load({ immediate: true });
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha na operação.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return (
      <section className="orders-screen-state">
        <ErpIcon name="orders" />
        <h2>{error || "Carregando central de pedidos…"}</h2>
        {error && (
          <button onClick={() => void load({ immediate: true })}>
            Tentar novamente
          </button>
        )}
      </section>
    );
  const detail = data.items.find((item) => item.id === detailId) || null,
    allSelected =
      data.items.length > 0 &&
      data.items.every((item) => selected.includes(item.id));
  const statusByKey = new Map(data.statuses.map((item) => [item.key, item]));
  return (
    <div className="order-management">
      {notice && (
        <div className="tenant-notice" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="tenant-error">
          {error}
          <button onClick={() => setError("")}>Fechar</button>
        </div>
      )}
      <section className="order-hero">
        <div>
          <span>OPERAÇÃO COMERCIAL E LOGÍSTICA</span>
          <h2>Gestão de pedidos</h2>
          <p>
            Venda, pagamento, separação, entrega e pós-venda em uma única linha
            do tempo.
          </p>
        </div>
        <div>
          <button onClick={() => setOperationsOpen(true)}>
            Configurar operação
          </button>
          <button onClick={() => exportOrders(search, status, after, before)}>
            Exportar CSV
          </button>
          <button className="primary" onClick={() => setCreateOpen(true)}>
            + Novo orçamento ou pedido
          </button>
        </div>
      </section>
      <section className="order-kpis">
        <Kpi
          label="Pedidos no recorte"
          value={String(data.summary.total)}
          detail={`${data.summary.items} item(ns) em todo o recorte`}
          icon="orders"
        />
        <Kpi
          label="Receita confirmada"
          value={money.format(data.summary.revenue)}
          detail="Exclui pendentes e cancelados"
          icon="finance"
        />
        <Kpi
          label="Ticket médio"
          value={money.format(data.summary.averageTicket)}
          detail="Calculado no servidor"
          icon="sales"
        />
        <Kpi
          label="Reembolsos"
          value={money.format(data.summary.refunded)}
          detail="Total devolvido no período"
          icon="support"
        />
      </section>
      <section className="order-controls">
        <label className="order-search">
          <ErpIcon name="customers" />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Buscar por número, cliente, e-mail, telefone ou documento"
          />
        </label>
        <button
          className={filtersOpen ? "active" : ""}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          Filtros
        </button>
        <div className="order-view-switch">
          <button
            className={view === "table" ? "active" : ""}
            onClick={() => setView("table")}
          >
            Lista
          </button>
          <button
            className={view === "kanban" ? "active" : ""}
            onClick={() => setView("kanban")}
          >
            Kanban
          </button>
        </div>
      </section>
      {filtersOpen && (
        <section className="order-filters">
          <label>
            Status
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Todos</option>
              {data.statuses.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tipo
            <select
              value={advanced.kind}
              onChange={(event) =>
                setAdvanced((value) => ({ ...value, kind: event.target.value }))
              }
            >
              <option value="">Todos</option>
              <option value="quote">Orçamento</option>
              <option value="order">Pedido</option>
            </select>
          </label>
          <label>
            Origem
            <select
              value={advanced.origin}
              onChange={(event) =>
                setAdvanced((value) => ({
                  ...value,
                  origin: event.target.value,
                }))
              }
            >
              <option value="">Todas</option>
              <option value="manual">Manual</option>
              <option value="store">Loja</option>
              {features.marketplaces && <option value="marketplace">Marketplace</option>}
              <option value="import">Importação</option>
            </select>
          </label>
          <label>
            Pagamento
            <input
              value={advanced.payment}
              onChange={(event) =>
                setAdvanced((value) => ({
                  ...value,
                  payment: event.target.value,
                }))
              }
              placeholder="Pix, boleto…"
            />
          </label>
          <label>
            Cliente
            <select
              value={advanced.customer}
              onChange={(event) =>
                setAdvanced((value) => ({
                  ...value,
                  customer: event.target.value,
                }))
              }
            >
              <option value="">Todos</option>
              {data.customers.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.tradeName || item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Valor mínimo
            <input
              type="number"
              min="0"
              step="0.01"
              value={advanced.min}
              onChange={(event) =>
                setAdvanced((value) => ({ ...value, min: event.target.value }))
              }
            />
          </label>
          <label>
            Valor máximo
            <input
              type="number"
              min="0"
              step="0.01"
              value={advanced.max}
              onChange={(event) =>
                setAdvanced((value) => ({ ...value, max: event.target.value }))
              }
            />
          </label>
          <label>
            De
            <input
              type="date"
              value={after}
              onChange={(event) => {
                setAfter(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            Até
            <input
              type="date"
              value={before}
              onChange={(event) => {
                setBefore(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="order-filter-check">
            <input
              type="checkbox"
              checked={advanced.shipping}
              onChange={(event) =>
                setAdvanced((value) => ({
                  ...value,
                  shipping: event.target.checked,
                }))
              }
            />{" "}
            Frete pendente
          </label>
          <label className="order-filter-check">
            <input
              type="checkbox"
              checked={advanced.trash}
              onChange={(event) =>
                setAdvanced((value) => ({
                  ...value,
                  trash: event.target.checked,
                }))
              }
            />{" "}
            Lixeira
          </label>
          <button
            onClick={() => {
              setSearch("");
              setStatus("");
              setAfter("");
              setBefore("");
              setAdvanced({
                origin: "",
                payment: "",
                kind: "",
                customer: "",
                min: "",
                max: "",
                shipping: false,
                trash: false,
              });
              setPage(1);
            }}
          >
            Limpar filtros
          </button>
        </section>
      )}
      {selected.length > 0 && (
        <section className="order-bulk">
          <strong>{selected.length} selecionado(s)</strong>
          <select
            defaultValue=""
            onChange={(event) => {
              const next = event.target.value;
              if (!next) return;
              const chosen = data.items.filter((item) =>
                  selected.includes(item.id),
                ),
                exceptional =
                  statusByKey.get(next)?.native !== false &&
                  chosen.some(
                    (item) => !clientTransitions[item.status]?.includes(next),
                  );
              let reason = "";
              if (exceptional) {
                reason =
                  prompt(
                    "Há pedidos com transição excepcional. Informe o motivo obrigatório para a auditoria:",
                  )?.trim() || "";
                if (!reason) {
                  event.target.value = "";
                  return;
                }
              }
              if (
                confirm(
                  `Alterar ${selected.length} pedido(s) para ${statusByKey.get(next)?.label || next}?`,
                )
              )
                void command(
                  {
                    action: "bulk-status",
                    ids: selected,
                    status: next,
                    confirmRegression: exceptional,
                    reason,
                  },
                  "Status atualizado em lote.",
                );
              event.target.value = "";
            }}
          >
            <option value="">Alterar status…</option>
            {data.statuses
              .filter(
                (item) =>
                  !["approved", "completed", "cancelled"].includes(item.key),
              )
              .map((item) => (
                <option value={item.key} key={item.key}>
                  {item.label}
                </option>
              ))}
          </select>
          <button
            onClick={() => {
              if (confirm(`Mover ${selected.length} pedido(s) para a lixeira?`))
                void command(
                  { action: "trash", ids: selected },
                  "Pedidos movidos para a lixeira.",
                );
            }}
          >
            Mover para lixeira
          </button>
          <button onClick={() => setSelected([])}>Limpar seleção</button>
        </section>
      )}
      {view === "table" ? (
        <OrderTable
          data={data}
          selected={selected}
          allSelected={allSelected}
          setSelected={setSelected}
          open={setDetailId}
          statusByKey={statusByKey}
        />
      ) : (
        <OrderKanban
          data={data}
          open={setDetailId}
          statusByKey={statusByKey}
          move={(order, next) => {
            const payload = statusPayload(order, next, statusByKey);
            if (payload)
              void command(payload, `Pedido ${order.number} movido.`);
          }}
        />
      )}
      {!data.items.length && (
        <section className="orders-screen-state">
          <ErpIcon name="orders" />
          <h2>Nenhum pedido encontrado</h2>
          <p>Ajuste os filtros ou crie o primeiro pedido deste recorte.</p>
          <button className="primary" onClick={() => setCreateOpen(true)}>
            Criar pedido
          </button>
        </section>
      )}
      <footer className="order-pagination">
        <span>
          Mostrando {data.items.length} de {data.pagination.total}
        </span>
        <div>
          <button
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Anterior
          </button>
          <b>
            Página {data.pagination.page} de {data.pagination.pages}
          </b>
          <button
            disabled={page >= data.pagination.pages}
            onClick={() => setPage((value) => value + 1)}
          >
            Próxima
          </button>
        </div>
      </footer>
      {detail && (
        <OrderDetail
          order={detail}
          data={data}
          statusByKey={statusByKey}
          busy={busy}
          close={() => setDetailId(null)}
          command={command}
        />
      )}
      {createOpen && (
        <CreateOrder
          data={data}
          busy={busy}
          close={() => setCreateOpen(false)}
          created={async (payload) => {
            setBusy(true);
            setError("");
            try {
              const response = await fetch("/api/erp/orders", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "idempotency-key": crypto.randomUUID(),
                  },
                  body: JSON.stringify({ action: "create", ...payload }),
                }),
                body = await response.json();
              if (!response.ok)
                throw new Error(
                  body.error || "Não foi possível criar o pedido.",
                );
              setNotice(`${body.order.number} criado com sucesso.`);
              setCreateOpen(false);
              await load({ immediate: true });
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Falha ao criar pedido.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {operationsOpen && (
        <OrderOperations
          data={data}
          busy={busy}
          close={() => setOperationsOpen(false)}
          command={command}
        />
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: string;
}) {
  return (
    <article>
      <i>
        <ErpIcon name={icon} />
      </i>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function OrderTable({
  data,
  selected,
  allSelected,
  setSelected,
  open,
  statusByKey,
}: {
  data: Dataset;
  selected: number[];
  allSelected: boolean;
  setSelected: (ids: number[]) => void;
  open: (id: number) => void;
  statusByKey: Map<string, Status>;
}) {
  return (
    <section className="order-table-wrap">
      <table>
        <thead>
          <tr>
            <th>
              <input
                aria-label="Selecionar página"
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? [] : data.items.map((item) => item.id),
                  )
                }
              />
            </th>
            <th>Pedido</th>
            <th>Data</th>
            <th>Status</th>
            <th>Cliente</th>
            <th>Itens</th>
            <th>Total</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((order) => {
            const definition = statusByKey.get(order.status);
            return (
              <tr key={order.id}>
                <td>
                  <input
                    aria-label={`Selecionar ${order.number}`}
                    type="checkbox"
                    checked={selected.includes(order.id)}
                    onChange={() =>
                      setSelected(
                        selected.includes(order.id)
                          ? selected.filter((id) => id !== order.id)
                          : [...selected, order.id],
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    className="order-number"
                    data-order-id={order.id}
                    onClick={() => open(order.id)}
                  >
                    {order.number}
                  </button>
                  <small>
                    {originLabel(order.origin)} ·{" "}
                    {order.kind === "quote" ? "Orçamento" : "Pedido"}
                  </small>
                </td>
                <td>{dateTime.format(new Date(order.createdAt))}</td>
                <td>
                  <StatusChip status={definition} fallback={order.status} />
                </td>
                <td>
                  <strong>{order.customerName}</strong>
                  <small>{order.customerEmail || "Sem e-mail"}</small>
                </td>
                <td>
                  {order.items.reduce((sum, item) => sum + item.quantity, 0)}
                </td>
                <td>
                  <strong>{money.format(order.total)}</strong>
                  {order.refundedTotal > 0 && (
                    <small className="refund-label">
                      Reembolsado {money.format(order.refundedTotal)}
                    </small>
                  )}
                </td>
                <td>
                  <button onClick={() => open(order.id)}>Ver pedido</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function OrderKanban({
  data,
  open,
  statusByKey,
  move,
}: {
  data: Dataset;
  open: (id: number) => void;
  statusByKey: Map<string, Status>;
  move: (order: Order, status: string) => void;
}) {
  const keys = [
    ...baseColumns,
    ...data.items
      .map((item) => item.status)
      .filter(
        (key, index, all) =>
          !baseColumns.includes(key) && all.indexOf(key) === index,
      ),
  ];
  return (
    <section
      className="order-kanban"
      aria-label={`Kanban mostrando ${data.items.length} de ${data.pagination.total} pedidos`}
    >
      {keys.map((key) => {
        const orders = data.items.filter((item) => item.status === key),
          definition = statusByKey.get(key);
        return (
          <div
            className="order-kanban-column"
            key={key}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const order = data.items.find(
                (item) =>
                  item.id ===
                  Number(event.dataTransfer.getData("text/order-id")),
              );
              if (
                order &&
                order.status !== key &&
                confirm(
                  `Mover ${order.number} para ${definition?.label || key}?`,
                )
              )
                move(order, key);
            }}
          >
            <header>
              <StatusChip status={definition} fallback={key} />
              <b>{orders.length}</b>
            </header>
            {orders.map((order) => (
              <article
                key={order.id}
                draggable
                onDragStart={(event) =>
                  event.dataTransfer.setData("text/order-id", String(order.id))
                }
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter") open(order.id);
                }}
              >
                <button onClick={() => open(order.id)}>
                  <small>
                    {order.number} · {originLabel(order.origin)}
                  </small>
                  <strong>{order.customerName}</strong>
                  <span>
                    {order.items.length} item(ns) · {money.format(order.total)}
                  </span>
                  <time>{dateTime.format(new Date(order.createdAt))}</time>
                </button>
                <label>
                  Mover para
                  <select
                    value={order.status}
                    onChange={(event) => move(order, event.target.value)}
                  >
                    {data.statuses.map((status) => (
                      <option key={status.key} value={status.key}>
                        {status.label}
                      </option>
                    ))}
                  </select>
                </label>
              </article>
            ))}
          </div>
        );
      })}
    </section>
  );
}

function StatusChip({
  status,
  fallback,
}: {
  status?: Status;
  fallback: string;
}) {
  return (
    <span
      className="order-status-chip"
      style={{ "--status-color": status?.color || "#64748b" } as CSSProperties}
    >
      {status?.label || fallback}
    </span>
  );
}

function OrderDetail({
  order,
  data,
  statusByKey,
  busy,
  close,
  command,
}: {
  order: Order;
  data: Dataset;
  statusByKey: Map<string, Status>;
  busy: boolean;
  close: () => void;
  command: (
    payload: Record<string, unknown>,
    success: string,
  ) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("detalhes"),
    [note, setNote] = useState(""),
    [customerVisible, setCustomerVisible] = useState(false),
    [tracking, setTracking] = useState({
      carrier: order.tracking?.carrierKey || "",
      code: order.tracking?.trackingNumber || "",
      url: order.tracking?.trackingUrl || "",
    }),
    [trackingOptions, setTrackingOptions] = useState({
      email: true,
      transition: true,
    }),
    [refund, setRefund] = useState(""),
    [refundItems, setRefundItems] = useState<Record<number, string>>({});
  const timeline = [
    ...order.history.map((item) => ({ ...item, type: "status" })),
    ...order.notesTimeline.map((item) => ({ ...item, type: "note" })),
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const shippingAddress =
    order.addresses.find((item) => item.type === "shipping") || {};
  return (
    <ErpModal
      close={close}
      className="order-detail-layer"
      label={`Pedido ${order.number}`}
    >
      <section className="order-detail-modal">
        <header>
          <div>
            <span>PEDIDO {order.origin.toUpperCase()}</span>
            <h2>
              {order.number} · {order.customerName}
            </h2>
            <p>
              {dateTime.format(new Date(order.createdAt))} ·{" "}
              {money.format(order.total)}
            </p>
          </div>
          <div>
            <select
              value={order.status}
              disabled={busy}
              onChange={(event) => {
                const payload = statusPayload(
                  order,
                  event.target.value,
                  statusByKey,
                );
                if (payload)
                  void command(payload, "Status do pedido atualizado.");
              }}
              aria-label="Status do pedido"
            >
              {data.statuses.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
            <button onClick={() => printOrder(order)}>Imprimir</button>
            <button aria-label="Fechar" onClick={close}>
              ×
            </button>
          </div>
        </header>
        <nav aria-label="Abas do pedido">
          {tabs.map(([key, label]) => (
            <button
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
              key={key}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="order-detail-body">
          {tab === "detalhes" && (
            <div className="order-detail-grid">
              <section>
                <h3>Itens do pedido</h3>
                <div className="order-detail-items">
                  {order.items.map((item) => (
                    <article key={item.id}>
                      {item.imageSnapshot ? (
                        <img src={item.imageSnapshot} alt="" />
                      ) : (
                        <span>
                          <ErpIcon name="products" />
                        </span>
                      )}
                      <div>
                        <strong>
                          {item.nameSnapshot || item.product.name}
                        </strong>
                        <small>
                          {item.skuSnapshot || item.product.sku}
                          {item.notes ? ` · ${item.notes}` : ""}
                        </small>
                      </div>
                      <p>
                        {item.quantity} × {money.format(item.unitPrice)}
                      </p>
                      <b>{money.format(item.total)}</b>
                    </article>
                  ))}
                </div>
                <div className="order-totals">
                  <span>
                    Subtotal <b>{money.format(order.subtotal)}</b>
                  </span>
                  <span>
                    Desconto <b>− {money.format(order.discount)}</b>
                  </span>
                  <span>
                    Frete <b>{money.format(order.freightAmount)}</b>
                  </span>
                  <span>
                    Impostos <b>{money.format(order.taxAmount)}</b>
                  </span>
                  {order.refundedTotal > 0 && (
                    <span>
                      Reembolsado <b>− {money.format(order.refundedTotal)}</b>
                    </span>
                  )}
                  <strong>
                    Total líquido{" "}
                    <b>{money.format(order.total - order.refundedTotal)}</b>
                  </strong>
                </div>
              </section>
              <aside>
                <Info
                  title="Pagamento"
                  rows={[
                    [
                      "Método",
                      order.paymentTitle || order.paymentMethod || "A definir",
                    ],
                    ["Transação", order.transactionId || "Não informada"],
                    [
                      "Confirmação",
                      order.paidAt
                        ? dateTime.format(new Date(order.paidAt))
                        : "Pendente",
                    ],
                  ]}
                />
                <Info
                  title="Entrega"
                  rows={[
                    ["Modalidade", deliveryLabel(order.deliveryType)],
                    [
                      "Endereço",
                      [
                        order.deliveryStreet,
                        order.deliveryNumber,
                        order.deliveryDistrict,
                      ]
                        .filter(Boolean)
                        .join(", ") || "Retirada / não informado",
                    ],
                    [
                      "Cidade",
                      [order.deliveryCity, order.deliveryState]
                        .filter(Boolean)
                        .join("/") || "Não informada",
                    ],
                    ["CEP", order.deliveryZip || "Não informado"],
                  ]}
                />
                <Info
                  title="Observação do cliente"
                  rows={[["Mensagem", order.notes || "Nenhuma observação"]]}
                />
              </aside>
            </div>
          )}
          {tab === "envio" && (
            <div className="order-tab-stack">
              <section className="order-form-card">
                <h3>Rastreio canônico</h3>
                <p>
                  O registro alimenta o painel, o portal do cliente e as
                  notificações.
                </p>
                <div className="order-form-grid">
                  <label>
                    Transportadora
                    <select
                      value={tracking.carrier}
                      onChange={(event) => {
                        const carrier = data.carriers.find(
                          (item) => item.key === event.target.value,
                        );
                        setTracking((current) => ({
                          ...current,
                          carrier: event.target.value,
                          url:
                            carrier?.urlTemplate?.replace(
                              "{code}",
                              current.code,
                            ) || current.url,
                        }));
                      }}
                    >
                      <option value="">Inferir automaticamente</option>
                      {data.carriers.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Código de rastreio
                    <input
                      value={tracking.code}
                      onChange={(event) =>
                        setTracking((current) => ({
                          ...current,
                          code: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="wide">
                    URL de rastreio
                    <input
                      value={tracking.url}
                      onChange={(event) =>
                        setTracking((current) => ({
                          ...current,
                          url: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="order-check-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={trackingOptions.email}
                      onChange={(event) =>
                        setTrackingOptions((current) => ({
                          ...current,
                          email: event.target.checked,
                        }))
                      }
                    />{" "}
                    Notificar por e-mail
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={trackingOptions.transition}
                      onChange={(event) =>
                        setTrackingOptions((current) => ({
                          ...current,
                          transition: event.target.checked,
                        }))
                      }
                    />{" "}
                    Mover para Enviado
                  </label>
                </div>
                <button
                  className="primary"
                  disabled={busy || !tracking.code}
                  onClick={() =>
                    void command(
                      {
                        action: "tracking",
                        orderId: order.id,
                        code: tracking.code,
                        carrierKey: tracking.carrier,
                        trackingUrl: tracking.url,
                        notifyEmail: trackingOptions.email,
                        transition: trackingOptions.transition,
                      },
                      "Rastreio salvo e comunicações agendadas.",
                    )
                  }
                >
                  Salvar rastreio
                </button>
              </section>
              {order.tracking && (
                <section className="tracking-current">
                  <h3>Rastreio atual</h3>
                  <strong>{order.tracking.trackingNumber}</strong>
                  <span>
                    {order.tracking.carrier ||
                      "Transportadora não identificada"}
                  </span>
                  {order.tracking.trackingUrl && (
                    <a
                      href={order.tracking.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Acompanhar envio
                    </a>
                  )}
                  {order.tracking.events.map((event) => (
                    <p key={event.id}>
                      {dateTime.format(new Date(event.occurredAt))} ·{" "}
                      {event.description}
                    </p>
                  ))}
                </section>
              )}
            </div>
          )}
          {tab === "frete" && (
            <div className="order-tab-stack">
              <section className="order-form-card shipping-workflow">
                <header>
                  <div>
                    <h3>Cotação e emissão de etiquetas</h3>
                    <p>
                      O provedor configurado em Integrações recebe somente os
                      dados necessários para a expedição.
                    </p>
                  </div>
                  <button
                    className="primary"
                    disabled={busy || !order.deliveryZip}
                    onClick={() =>
                      void command(
                        { action: "shipping-quote", orderId: order.id },
                        "Cotações de frete atualizadas.",
                      )
                    }
                  >
                    Recalcular cotações
                  </button>
                </header>
                {!order.deliveryZip && (
                  <div className="order-warning">
                    Cadastre o CEP de entrega antes de solicitar uma cotação.
                  </div>
                )}
              </section>
              {order.shippingLabels.map((label) => (
                <article className="shipping-label-card" key={label.id}>
                  <header>
                    <div>
                      <strong>{label.serviceName || "Serviço de frete"}</strong>
                      <small>
                        {label.carrier || label.provider} ·{" "}
                        {label.statusLabel || label.status}
                      </small>
                    </div>
                    <b>{money.format(label.amount)}</b>
                  </header>
                  {label.protocol && <p>Protocolo: {label.protocol}</p>}
                  {label.trackingCode && <p>Rastreio: {label.trackingCode}</p>}
                  <footer>
                    {label.labelUrl && (
                      <a
                        href={label.labelUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Abrir etiqueta PDF
                      </a>
                    )}
                    {label.trackingUrl && (
                      <a
                        href={label.trackingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Rastrear
                      </a>
                    )}
                    {label.status === "quoted" && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => {
                          const invoiceNumber =
                              prompt(
                                "Número da NF-e (vazio para declaração de conteúdo)",
                              ) || "",
                            invoiceKey = invoiceNumber
                              ? prompt("Chave de acesso da NF-e") || ""
                              : "";
                          if (
                            confirm(
                              `Comprar a etiqueta ${label.serviceName || "selecionada"} por ${money.format(label.amount)}?`,
                            )
                          )
                            void command(
                              {
                                action: "shipping-label-purchase",
                                orderId: order.id,
                                labelId: label.id,
                                invoiceNumber,
                                invoiceKey,
                                nonCommercial: !invoiceNumber,
                              },
                              "Etiqueta comprada e vinculada ao pedido.",
                            );
                        }}
                      >
                        Comprar etiqueta
                      </button>
                    )}
                    {["purchased", "ready"].includes(label.status) && (
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              "A etiqueta pode já ter sido paga. Confirmar cancelamento no provedor?",
                            )
                          )
                            void command(
                              {
                                action: "shipping-label-cancel",
                                orderId: order.id,
                                labelId: label.id,
                                confirmation: "CANCELAR",
                              },
                              "Etiqueta cancelada.",
                            );
                        }}
                      >
                        Cancelar etiqueta
                      </button>
                    )}
                  </footer>
                </article>
              ))}
              {!order.shippingLabels.length && (
                <div className="order-empty-inline">
                  <ErpIcon name="logistics" />
                  <strong>Nenhuma cotação realizada</strong>
                  <span>
                    Configure o provedor de frete e solicite a primeira cotação.
                  </span>
                </div>
              )}
            </div>
          )}
          {tab === "timeline" && (
            <div className="order-tab-stack">
              <form
                className="order-note-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    await command(
                      {
                        action: "note",
                        orderId: order.id,
                        content: note,
                        customerVisible,
                      },
                      "Nota adicionada à timeline.",
                    )
                  )
                    setNote("");
                }}
              >
                <label>
                  Nova nota
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Registre uma decisão, contato ou ocorrência…"
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={customerVisible}
                    onChange={(event) =>
                      setCustomerVisible(event.target.checked)
                    }
                  />{" "}
                  Visível ao cliente; e-mail agendado quando o canal estiver
                  ativo
                </label>
                <button className="primary" disabled={busy || !note.trim()}>
                  Adicionar nota
                </button>
              </form>
              <section className="order-timeline">
                {timeline.map((item) => (
                  <article key={`${item.type}-${item.id}`}>
                    <i>{item.type === "status" ? "↻" : "✎"}</i>
                    <div>
                      <strong>
                        {item.type === "status"
                          ? `Status: ${statusByKey.get(item.toStatus || "")?.label || item.toStatus}`
                          : item.customerVisible
                            ? "Nota ao cliente"
                            : "Nota privada"}
                      </strong>
                      <p>
                        {item.content || item.notes || "Alteração registrada"}
                      </p>
                      <small>
                        {item.actor || item.author || "Sistema"} ·{" "}
                        {dateTime.format(new Date(item.createdAt))}
                      </small>
                    </div>
                  </article>
                ))}
              </section>
            </div>
          )}
          {tab === "reembolsos" && (
            <div className="order-tab-stack">
              <section className="order-refund-summary">
                <div>
                  <small>Pago</small>
                  <strong>{money.format(order.total)}</strong>
                </div>
                <div>
                  <small>Já reembolsado</small>
                  <strong>{money.format(order.refundedTotal)}</strong>
                </div>
                <div>
                  <small>Saldo reembolsável</small>
                  <strong>
                    {money.format(
                      Math.max(0, order.total - order.refundedTotal),
                    )}
                  </strong>
                </div>
              </section>
              <section className="order-form-card">
                <h3>Novo reembolso</h3>
                <p>
                  Informe um valor livre ou selecione quantidades para um
                  reembolso item a item.
                </p>
                <div className="refund-item-picker">
                  {order.items.map((item) => {
                    const available = Math.max(
                      0,
                      item.quantity - item.refundedQuantity,
                    );
                    return (
                      <label key={item.id}>
                        <span>
                          <strong>{item.nameSnapshot}</strong>
                          <small>
                            Disponível: {available} ·{" "}
                            {money.format(item.unitPrice)} cada
                          </small>
                        </span>
                        <input
                          aria-label={`Quantidade de ${item.nameSnapshot}`}
                          type="number"
                          min="0"
                          max={available}
                          step="0.0001"
                          value={refundItems[item.id] || ""}
                          onChange={(event) =>
                            setRefundItems((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                    );
                  })}
                </div>
                <label>
                  Valor
                  <input
                    type="number"
                    min="0.01"
                    max={order.total - order.refundedTotal}
                    step="0.01"
                    value={refund}
                    onChange={(event) => setRefund(event.target.value)}
                    placeholder="Calculado pelos itens quando selecionados"
                  />
                </label>
                <label>
                  Motivo
                  <textarea
                    id="refund-reason"
                    placeholder="Explique o motivo para a auditoria"
                  />
                </label>
                <label>
                  <input id="refund-gateway" type="checkbox" /> Estornar também
                  no gateway de pagamento
                </label>
                <label>
                  <input id="refund-restock" type="checkbox" /> Devolver os
                  itens selecionados ao estoque
                </label>
                <button
                  className="danger"
                  disabled={
                    busy ||
                    (!refund &&
                      !Object.values(refundItems).some(
                        (value) => Number(value) > 0,
                      ))
                  }
                  onClick={() => {
                    const reason = (
                        document.getElementById(
                          "refund-reason",
                        ) as HTMLTextAreaElement
                      )?.value,
                      items = order.items
                        .map((item) => ({
                          orderItemId: item.id,
                          quantity: Number(refundItems[item.id] || 0),
                          amount:
                            Math.round(
                              Number(refundItems[item.id] || 0) *
                                item.unitPrice *
                                100,
                            ) / 100,
                        }))
                        .filter((item) => item.quantity > 0),
                      amount = items.length
                        ? items.reduce((sum, item) => sum + item.amount, 0)
                        : Number(refund);
                    if (
                      confirm(
                        `Confirmar reembolso de ${money.format(amount)}? Esta ação é irreversível.`,
                      )
                    )
                      void command(
                        {
                          action: "refund",
                          orderId: order.id,
                          amount,
                          items,
                          reason,
                          refundPayment: (
                            document.getElementById(
                              "refund-gateway",
                            ) as HTMLInputElement
                          )?.checked,
                          restock: (
                            document.getElementById(
                              "refund-restock",
                            ) as HTMLInputElement
                          )?.checked,
                        },
                        "Reembolso registrado.",
                      );
                  }}
                >
                  Confirmar reembolso
                </button>
              </section>
              {order.refunds.map((item) => (
                <article className="refund-history" key={item.id}>
                  <strong>{money.format(item.amount)}</strong>
                  <span>{item.reason || "Sem motivo informado"}</span>
                  <small>
                    {item.actor} · {dateTime.format(new Date(item.createdAt))}
                  </small>
                </article>
              ))}
            </div>
          )}
          {tab === "cliente" && (
            <div className="order-tab-stack">
              <div className="order-detail-grid">
                <section>
                  <h3>{order.customerName}</h3>
                  <div className="customer-profile-grid">
                    <Info
                      title="Contato"
                      rows={[
                        ["E-mail", order.customerEmail || "Não informado"],
                        ["Telefone", order.customerPhone || "Não informado"],
                        [
                          "Documento",
                          maskDocument(order.customerDocument || ""),
                        ],
                      ]}
                    />
                    <Info
                      title="Relacionamento"
                      rows={[
                        [
                          "Tipo",
                          order.customerId ? "Cliente cadastrado" : "Convidado",
                        ],
                        ["Canal", order.salesChannel],
                        ["Vendedor", order.salesperson || "Não informado"],
                      ]}
                    />
                  </div>
                  <div className="customer-link-order">
                    <label>
                      Vincular ou corrigir cliente
                      <select
                        id="order-customer-link"
                        defaultValue={order.customerId || ""}
                      >
                        <option value="">Selecione um cliente</option>
                        {data.customers.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.tradeName || item.name} · {item.document}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={busy}
                      onClick={() => {
                        const customerId = Number(
                          (
                            document.getElementById(
                              "order-customer-link",
                            ) as HTMLSelectElement
                          )?.value,
                        );
                        if (
                          customerId &&
                          confirm(
                            "Vincular este cadastro ao pedido e atualizar o snapshot de contato?",
                          )
                        )
                          void command(
                            {
                              action: "customer-link",
                              orderId: order.id,
                              customerId,
                            },
                            "Cliente vinculado ao pedido.",
                          );
                      }}
                    >
                      Vincular cliente
                    </button>
                  </div>
                </section>
                <aside className="order-form-card">
                  <h3>E-mail avulso</h3>
                  <p>
                    Canais externos recebem eventos assinados pelos webhooks.
                  </p>
                  <label>
                    Mensagem
                    <textarea
                      id="message-content"
                      maxLength={4096}
                      placeholder="A mensagem respeitará consentimento e opt-out do cliente."
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      const message = (
                        document.getElementById(
                          "message-content",
                        ) as HTMLTextAreaElement
                      )?.value;
                      if (
                        message &&
                        confirm("Agendar esta comunicação com o cliente?")
                      )
                        void command(
                          {
                            action: "queue-message",
                            orderId: order.id,
                            channel: "email",
                            message,
                          },
                          "Mensagem adicionada à fila.",
                        );
                    }}
                  >
                    Agendar mensagem
                  </button>
                </aside>
              </div>
              <form
                className="order-form-card"
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = Object.fromEntries(
                    new FormData(event.currentTarget),
                  );
                  void command(
                    {
                      action: "address",
                      orderId: order.id,
                      addressType: "shipping",
                      syncCustomer: values.syncCustomer === "on",
                      address: {
                        firstName: values.firstName,
                        email: values.email,
                        phone: values.phone,
                        document: values.document,
                        zip: values.zip,
                        street: values.street,
                        number: values.number,
                        complement: values.complement,
                        neighborhood: values.neighborhood,
                        city: values.city,
                        state: values.state,
                        country: "BR",
                      },
                    },
                    "Endereço de entrega atualizado e auditado.",
                  );
                }}
              >
                <h3>Editar endereço de entrega</h3>
                <div className="order-form-grid">
                  <label>
                    Destinatário
                    <input
                      name="firstName"
                      defaultValue={String(
                        shippingAddress.firstName || order.customerName,
                      )}
                    />
                  </label>
                  <label>
                    Documento
                    <input
                      name="document"
                      defaultValue={String(
                        shippingAddress.document ||
                          order.customerDocument ||
                          "",
                      )}
                    />
                  </label>
                  <label>
                    E-mail
                    <input
                      name="email"
                      type="email"
                      defaultValue={String(
                        shippingAddress.email || order.customerEmail || "",
                      )}
                    />
                  </label>
                  <label>
                    Telefone
                    <input
                      name="phone"
                      defaultValue={String(
                        shippingAddress.phone || order.customerPhone || "",
                      )}
                    />
                  </label>
                  <label>
                    CEP
                    <input
                      name="zip"
                      defaultValue={String(
                        shippingAddress.zip || order.deliveryZip || "",
                      )}
                    />
                  </label>
                  <label className="wide">
                    Logradouro
                    <input
                      name="street"
                      defaultValue={String(
                        shippingAddress.street || order.deliveryStreet || "",
                      )}
                    />
                  </label>
                  <label>
                    Número
                    <input
                      name="number"
                      defaultValue={String(
                        shippingAddress.number || order.deliveryNumber || "",
                      )}
                    />
                  </label>
                  <label>
                    Complemento
                    <input
                      name="complement"
                      defaultValue={String(
                        shippingAddress.complement ||
                          order.deliveryComplement ||
                          "",
                      )}
                    />
                  </label>
                  <label>
                    Bairro
                    <input
                      name="neighborhood"
                      defaultValue={String(
                        shippingAddress.neighborhood ||
                          order.deliveryDistrict ||
                          "",
                      )}
                    />
                  </label>
                  <label>
                    Cidade
                    <input
                      name="city"
                      defaultValue={String(
                        shippingAddress.city || order.deliveryCity || "",
                      )}
                    />
                  </label>
                  <label>
                    UF
                    <input
                      name="state"
                      maxLength={2}
                      defaultValue={String(
                        shippingAddress.state || order.deliveryState || "",
                      )}
                    />
                  </label>
                  <label className="order-consent">
                    <input name="syncCustomer" type="checkbox" /> Sincronizar
                    também com o cadastro do cliente
                  </label>
                </div>
                <button className="primary" disabled={busy}>
                  Salvar endereço
                </button>
              </form>
            </div>
          )}
          {tab === "devolucoes" && (
            <div className="order-tab-stack">
              {!order.returns.length && (
                <div className="order-empty-inline">
                  <ErpIcon name="support" />
                  <strong>Nenhuma solicitação de devolução</strong>
                  <span>
                    As solicitações do portal do cliente aparecerão aqui.
                  </span>
                </div>
              )}
              {order.returns.map((item) => (
                <article className="return-card" key={item.id}>
                  <header>
                    <div>
                      <strong>{returnReason(item.reason)}</strong>
                      <small>
                        {dateTime.format(new Date(item.requestedAt))} ·{" "}
                        {item.customerEmail}
                      </small>
                    </div>
                    <span>{returnStatus(item.status)}</span>
                  </header>
                  <p>{item.description}</p>
                  {item.adminNotes && (
                    <blockquote>{item.adminNotes}</blockquote>
                  )}
                  <footer>
                    {["approved", "rejected", "completed"].map((next) => (
                      <button
                        key={next}
                        disabled={busy || item.status === next}
                        onClick={() =>
                          void command(
                            {
                              action: "return-status",
                              orderId: order.id,
                              returnId: item.id,
                              status: next,
                            },
                            `Devolução marcada como ${returnStatus(next)}.`,
                          )
                        }
                      >
                        {returnStatus(next)}
                      </button>
                    ))}
                  </footer>
                </article>
              ))}
            </div>
          )}
          {tab === "documentos" && (
            <div className="order-tab-stack">
              <section className="order-document-list">
                <h3>Documentos vinculados</h3>
                {order.documents.map((document) => (
                  <article key={document.id}>
                    <div>
                      <strong>{document.name}</strong>
                      <small>
                        {documentType(document.type)} ·{" "}
                        {dateTime.format(new Date(document.createdAt))}
                      </small>
                    </div>
                    {document.externalUrl ? (
                      <a
                        href={document.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Abrir
                      </a>
                    ) : (
                      <span>Armazenamento interno</span>
                    )}
                  </article>
                ))}
                {!order.documents.length && (
                  <div className="order-empty-inline">
                    <ErpIcon name="fiscal" />
                    <strong>Nenhum documento</strong>
                    <span>
                      NF-e, etiquetas e comprovantes vinculados aparecerão aqui.
                    </span>
                  </div>
                )}
              </section>
              <section className="order-review-list">
                <h3>Avaliações pós-venda</h3>
                {order.reviewRequests.map((request) => (
                  <article key={request.id}>
                    <span>
                      <strong>Item #{request.orderItemId}</strong>
                      <small>
                        {request.state} · {request.sendCount} envio(s) · expira{" "}
                        {tenantDateTimeFormatter().format(
                          new Date(request.expiresAt),
                        )}
                      </small>
                    </span>
                    <a
                      href={`/avaliar/${request.token}?loja=${encodeURIComponent(data.organization.slug)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir convite
                    </a>
                  </article>
                ))}
                {!order.reviewRequests.length && (
                  <p>
                    Os convites são criados automaticamente quando o pedido é
                    entregue ou concluído.
                  </p>
                )}
              </section>
            </div>
          )}
          {tab === "comunicacao" && (
            <div className="order-tab-stack">
              <section className="order-communication-summary">
                <div>
                  <strong>
                    {
                      order.notificationLogs.filter((item) => item.success)
                        .length
                    }
                  </strong>
                  <small>entregues</small>
                </div>
                <div>
                  <strong>
                    {
                      order.notificationLogs.filter((item) => item.skipped)
                        .length
                    }
                  </strong>
                  <small>ignoradas por regra</small>
                </div>
                <div>
                  <strong>
                    {
                      order.notificationLogs.filter(
                        (item) => !item.success && !item.skipped,
                      ).length
                    }
                  </strong>
                  <small>falhas</small>
                </div>
              </section>
              {order.notificationLogs.map((item) => (
                <article className="notification-log-row" key={item.id}>
                  <span>{item.channel}</span>
                  <strong>
                    {item.success
                      ? "Enviada"
                      : item.skipped
                        ? "Ignorada"
                        : "Falhou"}
                  </strong>
                  <small>
                    {item.skipReason ||
                      dateTime.format(new Date(item.createdAt))}
                  </small>
                </article>
              ))}
              {!order.notificationLogs.length && (
                <div className="order-empty-inline">
                  <ErpIcon name="support" />
                  <strong>Nenhuma comunicação enviada</strong>
                  <span>
                    Eventos e tentativas futuras ficarão auditados aqui.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
        <footer>
          <button
            onClick={() =>
              copyText(
                `${location.origin}/rastrear-pedido?pedido=${encodeURIComponent(order.number)}`,
              )
            }
          >
            Copiar link de acompanhamento
          </button>
          <span>Chave pública protegida · dados pessoais filtrados</span>
          <button onClick={close}>Fechar</button>
        </footer>
      </section>
    </ErpModal>
  );
}

function Info({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string]>;
}) {
  return (
    <section className="order-info">
      <h3>{title}</h3>
      {rows.map(([label, value]) => (
        <div key={label}>
          <small>{label}</small>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function CreateOrder({
  data,
  busy,
  close,
  created,
}: {
  data: Dataset;
  busy: boolean;
  close: () => void;
  created: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const features = usePlanFeatures();
  const [section, setSection] = useState("geral"),
    [kind, setKind] = useState("quote"),
    [customerId, setCustomerId] = useState(""),
    [rows, setRows] = useState([
      {
        productId: "",
        variationId: "",
        quantity: "1",
        unitPrice: "0",
        description: "",
        notes: "",
      },
    ]);
  const customer = data.customers.find(
      (item) => item.id === Number(customerId),
    ),
    subtotal = rows.reduce(
      (sum, row) =>
        sum + Number(row.quantity || 0) * Number(row.unitPrice || 0),
      0,
    );
  const chooseProduct = (index: number, productId: string) => {
    const product = data.products.find((item) => item.id === Number(productId));
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              productId,
              variationId: "",
              unitPrice: String(product?.price || 0),
              description: product?.name || "",
            }
          : row,
      ),
    );
  };
  const chooseVariation = (index: number, variationId: string) => {
    const row = rows[index],
      product = data.products.find((item) => item.id === Number(row.productId)),
      variation = product?.variations.find(
        (item) => item.id === Number(variationId),
      );
    setRows((current) =>
      current.map((item, rowIndex) =>
        rowIndex === index
          ? {
              ...item,
              variationId,
              unitPrice: String(
                variation?.salePrice ??
                  variation?.regularPrice ??
                  product?.price ??
                  0,
              ),
            }
          : item,
      ),
    );
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      payload: Record<string, unknown> = Object.fromEntries(form.entries());
    payload.kind = kind;
    payload.customerId = customerId || null;
    payload.termsAccepted = form.get("termsAccepted") === "on";
    payload.items = rows.map((row) => ({
      ...row,
      productId: Number(row.productId),
      variationId: row.variationId ? Number(row.variationId) : null,
      quantity: Number(row.quantity),
      unitPrice: Number(row.unitPrice),
    }));
    await created(payload);
  };
  const sections = [
    ["geral", "Geral"],
    ["itens", "Itens e preços"],
    ["entrega", "Entrega"],
    ["pagamento", "Pagamento"],
    ["observacoes", "Observações"],
  ];
  return (
    <ErpModal
      close={close}
      className="order-create-layer"
      label="Novo orçamento ou pedido"
    >
      <form className="order-create-modal" onSubmit={submit}>
        <header>
          <div>
            <span>PIPELINE COMERCIAL COMPLETO</span>
            <h2>Novo orçamento ou pedido</h2>
            <p>
              Cadastre cliente, itens, condições, entrega e pagamento sem sair
              da tela.
            </p>
          </div>
          <button type="button" onClick={close} aria-label="Fechar">
            ×
          </button>
        </header>
        <nav>
          {sections.map(([key, label]) => (
            <button
              type="button"
              className={section === key ? "active" : ""}
              key={key}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="order-create-body">
          {section === "geral" && (
            <div className="order-form-grid">
              <label>
                Tipo
                <div className="order-kind">
                  <button
                    type="button"
                    className={kind === "quote" ? "active" : ""}
                    onClick={() => setKind("quote")}
                  >
                    Orçamento
                  </button>
                  <button
                    type="button"
                    className={kind === "order" ? "active" : ""}
                    onClick={() => setKind("order")}
                  >
                    Pedido
                  </button>
                </div>
              </label>
              <label>
                Cliente
                <select
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                >
                  <option value="">Consumidor final / convidado</option>
                  {data.customers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.tradeName || item.name} · {item.document}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Contato
                <input
                  name="contactName"
                  defaultValue={customer?.tradeName || customer?.name || ""}
                />
              </label>
              <label>
                E-mail
                <input
                  name="customerEmail"
                  type="email"
                  defaultValue={customer?.email || ""}
                />
              </label>
              <label>
                Telefone
                <input
                  name="customerPhone"
                  defaultValue={customer?.phone || ""}
                />
              </label>
              <label>
                Canal
                <select name="salesChannel" defaultValue="direct">
                  <option value="direct">Venda direta</option>
                  <option value="store">Loja</option>
                  <option value="phone">Telefone</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">E-mail</option>
                  <option value="field">Venda externa</option>
                  <option value="ecommerce">E-commerce</option>
                  {features.marketplaces && <option value="marketplace">Marketplace</option>}
                </select>
              </label>
              <label>
                Prioridade
                <select name="priority" defaultValue="normal">
                  <option value="low">Baixa</option>
                  <option value="normal">Normal</option>
                  <option value="high">Alta</option>
                  <option value="urgent">Urgente</option>
                </select>
              </label>
              <label>
                Referência externa
                <input
                  name="externalReference"
                  placeholder="Pedido do cliente, marketplace…"
                />
              </label>
              <label>
                Validade
                <input name="validUntil" type="date" />
              </label>
              <label>
                Previsão de entrega
                <input name="expectedAt" type="date" />
              </label>
            </div>
          )}
          {section === "itens" && (
            <div className="order-lines">
              <header>
                <div>
                  <h3>Produtos e serviços</h3>
                  <p>Nome, SKU, variação e preço ficam congelados no pedido.</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setRows((current) => [
                      ...current,
                      {
                        productId: "",
                        variationId: "",
                        quantity: "1",
                        unitPrice: "0",
                        description: "",
                        notes: "",
                      },
                    ])
                  }
                >
                  + Adicionar item
                </button>
              </header>
              {rows.map((row, index) => {
                const product = data.products.find(
                  (item) => item.id === Number(row.productId),
                );
                return (
                  <article key={index}>
                    <label>
                      Produto
                      <select
                        required
                        value={row.productId}
                        onChange={(event) =>
                          chooseProduct(index, event.target.value)
                        }
                      >
                        <option value="">Selecione</option>
                        {data.products.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {item.sku} · saldo{" "}
                            {item.availableStock}
                          </option>
                        ))}
                      </select>
                    </label>
                    {Boolean(product?.variations.length) && (
                      <label>
                        Variação
                        <select
                          required
                          value={row.variationId}
                          onChange={(event) =>
                            chooseVariation(index, event.target.value)
                          }
                        >
                          <option value="">Selecione a variação</option>
                          {product?.variations.map((variation) => (
                            <option value={variation.id} key={variation.id}>
                              {variation.sku || `Variação ${variation.id}`} ·{" "}
                              {variationLabel(variation.attributes)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label>
                      Quantidade
                      <input
                        required
                        min="0.0001"
                        step="0.0001"
                        type="number"
                        value={row.quantity}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, rowIndex) =>
                              rowIndex === index
                                ? { ...item, quantity: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      Preço unitário
                      <input
                        required
                        min="0"
                        step="0.01"
                        type="number"
                        value={row.unitPrice}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, rowIndex) =>
                              rowIndex === index
                                ? { ...item, unitPrice: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="wide">
                      Descrição
                      <input
                        value={row.description}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, rowIndex) =>
                              rowIndex === index
                                ? { ...item, description: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="wide">
                      Personalização / observação do item
                      <input
                        value={row.notes}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, rowIndex) =>
                              rowIndex === index
                                ? { ...item, notes: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      aria-label="Remover item"
                      disabled={rows.length === 1}
                      onClick={() =>
                        setRows((current) =>
                          current.filter((_, rowIndex) => rowIndex !== index),
                        )
                      }
                    >
                      ×
                    </button>
                  </article>
                );
              })}
              <div className="order-create-total">
                <span>Subtotal dos itens</span>
                <strong>{money.format(subtotal)}</strong>
              </div>
              <div className="order-form-grid">
                <label>
                  Tipo de desconto
                  <select name="discountType" defaultValue="value">
                    <option value="value">Valor fixo</option>
                    <option value="percent">Percentual</option>
                  </select>
                </label>
                <label>
                  Desconto
                  <input
                    name="discountValue"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue="0"
                  />
                </label>
              </div>
            </div>
          )}
          {section === "entrega" && (
            <div className="order-form-grid">
              <label>
                Modalidade
                <select name="deliveryType" defaultValue="pickup">
                  <option value="pickup">Retirada na filial</option>
                  <option value="delivery">Entrega própria</option>
                  <option value="carrier">Transportadora</option>
                </select>
              </label>
              <label>
                Responsabilidade do frete
                <select name="freightType" defaultValue="none">
                  <option value="none">A definir / sem frete</option>
                  <option value="cif">CIF — remetente</option>
                  <option value="fob">FOB — destinatário</option>
                </select>
              </label>
              <label>
                Valor do frete
                <input
                  name="freightAmount"
                  min="0"
                  step="0.01"
                  type="number"
                  defaultValue="0"
                />
              </label>
              <label>
                CEP
                <input
                  name="deliveryZip"
                  defaultValue={customer?.addresses[0]?.zip || ""}
                />
              </label>
              <label className="wide">
                Logradouro
                <input
                  name="deliveryStreet"
                  defaultValue={customer?.addresses[0]?.street || ""}
                />
              </label>
              <label>
                Número
                <input
                  name="deliveryNumber"
                  defaultValue={customer?.addresses[0]?.number || ""}
                />
              </label>
              <label>
                Complemento
                <input
                  name="deliveryComplement"
                  defaultValue={customer?.addresses[0]?.complement || ""}
                />
              </label>
              <label>
                Bairro
                <input
                  name="deliveryDistrict"
                  defaultValue={customer?.addresses[0]?.district || ""}
                />
              </label>
              <label>
                Cidade
                <input
                  name="deliveryCity"
                  defaultValue={customer?.addresses[0]?.city || ""}
                />
              </label>
              <label>
                UF
                <input
                  name="deliveryState"
                  maxLength={2}
                  defaultValue={customer?.addresses[0]?.state || ""}
                />
              </label>
            </div>
          )}
          {section === "pagamento" && (
            <div className="order-form-grid">
              <label>
                Meio de pagamento
                <select name="paymentMethod" defaultValue="Pix">
                  <option>Pix</option>
                  <option>Cartão de crédito</option>
                  <option>Boleto</option>
                  <option>Transferência</option>
                  <option>Dinheiro</option>
                  <option>A definir</option>
                </select>
              </label>
              <label>
                Condição
                <input
                  name="paymentTerms"
                  placeholder="Entrada + 30 dias, à vista…"
                />
              </label>
              <label>
                Parcelas
                <input
                  name="paymentInstallments"
                  type="number"
                  min="1"
                  max="120"
                  defaultValue="1"
                />
              </label>
              <label>
                Primeiro vencimento
                <input name="firstDueDate" type="date" />
              </label>
              <label className="wide order-consent">
                <input name="termsAccepted" type="checkbox" /> Condições
                comerciais revisadas e aceitas
              </label>
            </div>
          )}
          {section === "observacoes" && (
            <div className="order-form-grid">
              <label className="wide">
                Observação do cliente
                <textarea
                  name="notes"
                  maxLength={4000}
                  placeholder="Será visível em documentos e no portal quando aplicável."
                />
              </label>
              <label className="wide">
                Notas internas
                <textarea
                  name="internalNotes"
                  maxLength={4000}
                  placeholder="Informação restrita à equipe."
                />
              </label>
              <label className="wide">
                Número da ordem de compra
                <input name="purchaseOrderNumber" />
              </label>
            </div>
          )}
        </div>
        <footer>
          <div>
            <small>Total estimado</small>
            <strong>{money.format(subtotal)}</strong>
          </div>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar orçamento ou pedido"}
          </button>
        </footer>
      </form>
    </ErpModal>
  );
}

function OrderOperations({
  data,
  busy,
  close,
  command,
}: {
  data: Dataset;
  busy: boolean;
  close: () => void;
  command: (
    payload: Record<string, unknown>,
    success: string,
  ) => Promise<boolean>;
}) {
  const [tab, setTab] = useState("notificacoes"),
    [newStatus, setNewStatus] = useState({
      key: "",
      label: "",
      color: "#168151",
      description: "",
    });
  const raw =
    data.notificationSettings?.settings &&
    typeof data.notificationSettings.settings === "object" &&
    !Array.isArray(data.notificationSettings.settings)
      ? (data.notificationSettings.settings as Record<string, unknown>)
      : {};
  const rawEmail =
      raw.email && typeof raw.email === "object" && !Array.isArray(raw.email)
        ? (raw.email as Record<string, unknown>)
        : {},
    rawCustomerEmail =
      raw.emailCustomer &&
      typeof raw.emailCustomer === "object" &&
      !Array.isArray(raw.emailCustomer)
        ? (raw.emailCustomer as Record<string, unknown>)
        : {},
    rawDaily =
      raw.dailySummary &&
      typeof raw.dailySummary === "object" &&
      !Array.isArray(raw.dailySummary)
        ? (raw.dailySummary as Record<string, unknown>)
        : {},
    rawMatrix =
      raw.matrix && typeof raw.matrix === "object" && !Array.isArray(raw.matrix)
        ? (raw.matrix as Record<string, unknown>)
        : {},
    rawPolicies =
      raw.policies &&
      typeof raw.policies === "object" &&
      !Array.isArray(raw.policies)
        ? (raw.policies as Record<string, unknown>)
        : {};
  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      list = (key: string) =>
        String(form.get(key) || "")
          .split(/[;,\n]/)
          .map((item) => item.trim())
          .filter(Boolean),
      matrix: Record<string, Record<string, boolean | null>> = {},
      policies: Record<string, unknown> = {};
    for (const status of data.statuses) {
      matrix[status.key] = {};
      for (const channel of ["admin_email", "customer_email"]) {
        const value = String(
          form.get(`matrix:${status.key}:${channel}`) || "inherit",
        );
        matrix[status.key][channel] =
          value === "on" ? true : value === "off" ? false : null;
      }
      const previous =
        rawPolicies[status.key] && typeof rawPolicies[status.key] === "object"
          ? (rawPolicies[status.key] as Record<string, unknown>)
          : {};
      policies[status.key] = {
        ...previous,
        delayMinutes: Number(form.get(`policy:${status.key}:delay`) || 0),
        quietHours: {
          start: Number(form.get(`policy:${status.key}:quietStart`) || -1),
          end: Number(form.get(`policy:${status.key}:quietEnd`) || -1),
        },
        throttlePerMinute: Number(
          form.get(`policy:${status.key}:throttle`) || 0,
        ),
        timezone: String(
          form.get("dailySummaryTimezone") || "America/Sao_Paulo",
        ),
      };
    }
    const settings = {
      ...raw,
      matrix,
      policies,
      email: {
        ...rawEmail,
        enabled: form.get("emailEnabled") === "on",
        recipients: list("emailRecipients"),
        triggerStatuses: list("emailStatuses"),
        includePdf: form.get("includePdf") === "on",
        subjectTemplate: String(form.get("subjectTemplate") || ""),
        replyTo: String(form.get("replyTo") || ""),
      },
      emailCustomer: {
        ...rawCustomerEmail,
        enabled: form.get("customerEmailEnabled") === "on",
        triggerStatuses: list("customerEmailStatuses"),
        subjectTemplate: String(form.get("customerEmailSubject") || ""),
      },
      synchronousDispatch: form.get("synchronousDispatch") === "on",
      logRetentionDays: Number(form.get("logRetentionDays") || 90),
      piiRetentionDays: Number(form.get("piiRetentionDays") || 365),
      anonymizeOnCleanup: form.get("anonymizeOnCleanup") === "on",
      dailySummary: {
        ...rawDaily,
        enabled: form.get("dailySummaryEnabled") === "on",
        hour: Number(form.get("dailySummaryHour") || 18),
        timezone: String(
          form.get("dailySummaryTimezone") || "America/Sao_Paulo",
        ),
        recipients: list("dailySummaryRecipients"),
      },
    };
    await command(
      {
        action: "notification-settings",
        enabled: form.get("masterEnabled") === "on",
        settings,
      },
      "Políticas de e-mail atualizadas.",
    );
  }
  return (
    <ErpModal
      close={close}
      className="order-operations-layer"
      label="Configuração da operação de pedidos"
    >
      <section className="order-operations-modal">
        <header>
          <div>
            <span>CENTRAL DE CONFIGURAÇÃO</span>
            <h2>Operação de pedidos</h2>
            <p>
              Status, comunicação, fila, devoluções e indicadores em um único
              painel.
            </p>
          </div>
          <button onClick={close}>×</button>
        </header>
        <nav>
          {[
            ["notificacoes", "Notificações"],
            ["status", "Status"],
            ["fila", "Fila"],
            ["devolucoes", "Devoluções"],
            ["relatorios", "Relatórios"],
          ].map(([key, label]) => (
            <button
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
              key={key}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="order-operations-body">
          {tab === "notificacoes" && (
            <form className="operation-settings" onSubmit={saveSettings}>
              <section>
                <h3>E-mail</h3>
                <label className="operation-toggle">
                  <input
                    name="masterEnabled"
                    type="checkbox"
                    defaultChecked={data.notificationSettings?.enabled === true}
                  />
                  <span>
                    <strong>Ativar central de notificações</strong>
                    <small>
                      Chave mestre de todos os disparos automáticos.
                    </small>
                  </span>
                </label>
                <label className="operation-toggle">
                  <input
                    name="emailEnabled"
                    type="checkbox"
                    defaultChecked={rawEmail.enabled === true}
                  />
                  <span>
                    <strong>Avisar gestores</strong>
                    <small>
                      A matriz por status nunca sobrepõe a chave mestre.
                    </small>
                  </span>
                </label>
                <label>
                  Destinatários dos gestores
                  <input
                    name="emailRecipients"
                    defaultValue={arrayText(rawEmail.recipients)}
                    placeholder="gestor@empresa.com.br; fiscal@empresa.com.br"
                  />
                </label>
                <label>
                  Status para gestores
                  <input
                    name="emailStatuses"
                    defaultValue={
                      arrayText(rawEmail.triggerStatuses) ||
                      "pending, on-hold, processing"
                    }
                  />
                </label>
                <label>
                  Assunto do gestor
                  <input
                    name="subjectTemplate"
                    defaultValue={String(
                      rawEmail.subjectTemplate ||
                        "Novo pedido #{order_id} — {customer_name} ({total})",
                    )}
                  />
                </label>
                <label>
                  Responder para
                  <input
                    name="replyTo"
                    type="email"
                    defaultValue={String(rawEmail.replyTo || "")}
                  />
                </label>
                <label className="operation-toggle">
                  <input
                    name="includePdf"
                    type="checkbox"
                    defaultChecked={rawEmail.includePdf !== false}
                  />
                  <span>
                    <strong>Incluir resumo do pedido</strong>
                    <small>Conteúdo sanitizado e limitado.</small>
                  </span>
                </label>
                <label className="operation-toggle">
                  <input
                    name="customerEmailEnabled"
                    type="checkbox"
                    defaultChecked={rawCustomerEmail.enabled === true}
                  />
                  <span>
                    <strong>Avisar clientes por e-mail</strong>
                    <small>Usa o e-mail congelado no pedido.</small>
                  </span>
                </label>
                <label>
                  Status para clientes por e-mail
                  <input
                    name="customerEmailStatuses"
                    defaultValue={
                      arrayText(rawCustomerEmail.triggerStatuses) ||
                      "processing, shipped, delivered, completed"
                    }
                  />
                </label>
                <label>
                  Assunto ao cliente
                  <input
                    name="customerEmailSubject"
                    defaultValue={String(
                      rawCustomerEmail.subjectTemplate ||
                        "Atualização do pedido #{order_id} — {store_name}",
                    )}
                  />
                </label>
              </section>
              <section>
                <h3>Políticas e resumo</h3>
                <label className="operation-toggle">
                  <input
                    name="synchronousDispatch"
                    type="checkbox"
                    defaultChecked={raw.synchronousDispatch !== false}
                  />
                  <span>
                    <strong>Priorizar processamento</strong>
                    <small>
                      A entrega continua protegida pela fila e deduplicação.
                    </small>
                  </span>
                </label>
                <label>
                  Retenção do log (dias)
                  <input
                    name="logRetentionDays"
                    type="number"
                    min="7"
                    max="3650"
                    defaultValue={Number(raw.logRetentionDays || 90)}
                  />
                </label>
                <label>
                  Retenção de IP e navegador (dias)
                  <input
                    name="piiRetentionDays"
                    type="number"
                    min="30"
                    max="3650"
                    defaultValue={Number(raw.piiRetentionDays || 365)}
                  />
                </label>
                <label className="operation-toggle">
                  <input
                    name="anonymizeOnCleanup"
                    type="checkbox"
                    defaultChecked={raw.anonymizeOnCleanup === true}
                  />
                  <span>
                    <strong>Anonimizar ao expirar</strong>
                    <small>
                      Preserva métricas sem manter destinatários ou erros.
                    </small>
                  </span>
                </label>
                <label className="operation-toggle">
                  <input
                    name="dailySummaryEnabled"
                    type="checkbox"
                    defaultChecked={rawDaily.enabled === true}
                  />
                  <span>
                    <strong>Resumo diário</strong>
                    <small>Receita, ticket, status e produtos do dia.</small>
                  </span>
                </label>
                <label>
                  Hora do resumo
                  <input
                    name="dailySummaryHour"
                    type="number"
                    min="0"
                    max="23"
                    defaultValue={Number(rawDaily.hour || 18)}
                  />
                </label>
                <label>
                  Fuso horário
                  <input
                    name="dailySummaryTimezone"
                    defaultValue={String(
                      rawDaily.timezone || "America/Sao_Paulo",
                    )}
                  />
                </label>
                <label>
                  Destinatários do resumo
                  <input
                    name="dailySummaryRecipients"
                    defaultValue={arrayText(rawDaily.recipients)}
                  />
                </label>
              </section>
              <section className="notification-matrix">
                <header>
                  <div>
                    <h3>Matriz e políticas por status</h3>
                    <p>
                      Controle canais, atraso, limite por minuto e a janela de
                      silêncio de cada evento.
                    </p>
                  </div>
                  <span>Herdar · Enviar · Bloquear</span>
                </header>
                <div className="notification-matrix-table">
                  <div className="matrix-heading">
                    <strong>Status</strong>
                    <strong>Gestor e-mail</strong>
                    <strong>Cliente e-mail</strong>
                    <strong>Atraso (min)</strong>
                    <strong>Limite/min</strong>
                    <strong>Silêncio (início/fim)</strong>
                  </div>
                  {data.statuses.map((status) => {
                    const values =
                        rawMatrix[status.key] &&
                        typeof rawMatrix[status.key] === "object" &&
                        !Array.isArray(rawMatrix[status.key])
                          ? (rawMatrix[status.key] as Record<string, unknown>)
                          : {},
                      policy =
                        rawPolicies[status.key] &&
                        typeof rawPolicies[status.key] === "object" &&
                        !Array.isArray(rawPolicies[status.key])
                          ? (rawPolicies[status.key] as Record<string, unknown>)
                          : {},
                      quiet =
                        policy.quietHours &&
                        typeof policy.quietHours === "object" &&
                        !Array.isArray(policy.quietHours)
                          ? (policy.quietHours as Record<string, unknown>)
                          : {};
                    return (
                      <div className="matrix-row" key={status.key}>
                        <span>
                          <i style={{ background: status.color }} />
                          {status.label}
                        </span>
                        {["admin_email", "customer_email"].map((channel) => (
                          <select
                            aria-label={`${status.label} — ${channel}`}
                            name={`matrix:${status.key}:${channel}`}
                            defaultValue={
                              values[channel] === true
                                ? "on"
                                : values[channel] === false
                                  ? "off"
                                  : "inherit"
                            }
                            key={channel}
                          >
                            <option value="inherit">Herdar</option>
                            <option value="on">Enviar</option>
                            <option value="off">Bloquear</option>
                          </select>
                        ))}
                        <input
                          aria-label={`Atraso de ${status.label}`}
                          name={`policy:${status.key}:delay`}
                          type="number"
                          min="0"
                          max="10080"
                          defaultValue={Number(policy.delayMinutes || 0)}
                        />
                        <input
                          aria-label={`Limite de ${status.label}`}
                          name={`policy:${status.key}:throttle`}
                          type="number"
                          min="0"
                          max="10000"
                          defaultValue={Number(policy.throttlePerMinute || 0)}
                        />
                        <span className="policy-hours">
                          <input
                            aria-label={`Início do silêncio de ${status.label}`}
                            name={`policy:${status.key}:quietStart`}
                            type="number"
                            min="-1"
                            max="23"
                            defaultValue={Number(quiet.start ?? -1)}
                          />
                          <b>–</b>
                          <input
                            aria-label={`Fim do silêncio de ${status.label}`}
                            name={`policy:${status.key}:quietEnd`}
                            type="number"
                            min="-1"
                            max="23"
                            defaultValue={Number(quiet.end ?? -1)}
                          />
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
              <footer>
                <div>
                  <strong>Configuração preservada</strong>
                  <small>
                    Tokens nunca retornam ao navegador; matriz tri-state não é
                    descartada.
                  </small>
                </div>
                <button className="primary" disabled={busy}>
                  Salvar políticas
                </button>
              </footer>
            </form>
          )}
          {tab === "status" && (
            <div className="operation-statuses">
              <section>
                {data.statuses.map((item) => (
                  <article key={item.key}>
                    <i style={{ background: item.color }} />
                    <div>
                      <strong>{item.label}</strong>
                      <small>
                        {item.key} · {item.description || "Sem descrição"}
                      </small>
                    </div>
                    <span>{item.native ? "Nativo" : "Personalizado"}</span>
                    {!item.native && (
                      <button
                        onClick={() => {
                          if (confirm(`Excluir o status ${item.label}?`))
                            void command(
                              { action: "status-delete", key: item.key },
                              "Status removido.",
                            );
                        }}
                      >
                        Excluir
                      </button>
                    )}
                  </article>
                ))}
              </section>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    await command(
                      { action: "status-save", ...newStatus, position: 500 },
                      "Status personalizado salvo.",
                    )
                  )
                    setNewStatus({
                      key: "",
                      label: "",
                      color: "#168151",
                      description: "",
                    });
                }}
              >
                <h3>Novo status personalizado</h3>
                <label>
                  Chave
                  <input
                    required
                    pattern="[a-z0-9-]+"
                    value={newStatus.key}
                    onChange={(event) =>
                      setNewStatus((current) => ({
                        ...current,
                        key: event.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-]/g, "-"),
                      }))
                    }
                    placeholder="aguardando-documento"
                  />
                </label>
                <label>
                  Rótulo
                  <input
                    required
                    value={newStatus.label}
                    onChange={(event) =>
                      setNewStatus((current) => ({
                        ...current,
                        label: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Cor
                  <input
                    type="color"
                    value={newStatus.color}
                    onChange={(event) =>
                      setNewStatus((current) => ({
                        ...current,
                        color: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Descrição
                  <textarea
                    value={newStatus.description}
                    onChange={(event) =>
                      setNewStatus((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Criar status
                </button>
              </form>
            </div>
          )}
          {tab === "fila" && (
            <div className="operation-queue">
              <header>
                <div>
                  <strong>
                    {
                      data.queue.filter((item) => item.state === "pending")
                        .length
                    }
                  </strong>
                  <small>pendentes</small>
                </div>
                <div>
                  <strong>
                    {data.queue.filter((item) => item.state === "dead").length}
                  </strong>
                  <small>dead letter</small>
                </div>
                <div>
                  <strong>
                    {data.queue.filter((item) => item.state === "sent").length}
                  </strong>
                  <small>enviadas</small>
                </div>
              </header>
              {data.queue.map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>
                      {item.salesOrder.number} · {item.salesOrder.customerName}
                    </strong>
                    <small>
                      {item.channel} ·{" "}
                      {new Date(item.createdAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}
                    </small>
                  </div>
                  <span className={`queue-${item.state}`}>
                    {queueStatus(item.state)}
                  </span>
                  <small>
                    {item.attempts} tentativa(s)
                    {item.lastError ? ` · ${item.lastError}` : ""}
                  </small>
                  <button
                    disabled={busy || item.state === "sent"}
                    onClick={() =>
                      void command(
                        { action: "queue-retry", queueId: item.id },
                        "Mensagem reenfileirada.",
                      )
                    }
                  >
                    Reenviar
                  </button>
                  <button
                    disabled={
                      busy ||
                      item.state === "sent" ||
                      item.state === "cancelled"
                    }
                    onClick={() =>
                      void command(
                        { action: "queue-cancel", queueId: item.id },
                        "Mensagem cancelada.",
                      )
                    }
                  >
                    Cancelar
                  </button>
                </article>
              ))}
              {!data.queue.length && (
                <div className="order-empty-inline">
                  <ErpIcon name="support" />
                  <strong>Fila vazia</strong>
                  <span>
                    Mensagens futuras serão processadas com retentativa
                    exponencial.
                  </span>
                </div>
              )}
            </div>
          )}
          {tab === "devolucoes" && (
            <div className="operation-returns">
              <header>
                <div>
                  <strong>{data.returns.length}</strong>
                  <small>solicitações recentes</small>
                </div>
                <div>
                  <strong>
                    {
                      data.returns.filter((item) => item.status === "pending")
                        .length
                    }
                  </strong>
                  <small>aguardando análise</small>
                </div>
              </header>
              <p>
                Abra o pedido correspondente para analisar itens, histórico e
                alterar o status da devolução.
              </p>
              {data.items
                .flatMap((order) =>
                  order.returns.map((item) => ({ ...item, order })),
                )
                .map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      close();
                      document
                        .querySelector<HTMLButtonElement>(
                          `.order-number[data-order-id="${item.order.id}"]`,
                        )
                        ?.click();
                    }}
                  >
                    <span>
                      <strong>
                        {item.order.number} · {item.order.customerName}
                      </strong>
                      <small>
                        {returnReason(item.reason)} ·{" "}
                        {new Date(item.requestedAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}
                      </small>
                    </span>
                    <b>{returnStatus(item.status)}</b>
                  </button>
                ))}
            </div>
          )}
          {tab === "relatorios" && (
            <div className="operation-reports">
              <section className="report-summary">
                <Kpi
                  label="Pedidos"
                  value={String(data.summary.total)}
                  detail="No recorte atual"
                  icon="orders"
                />
                <Kpi
                  label="Receita"
                  value={money.format(data.summary.revenue)}
                  detail="Pedidos confirmados"
                  icon="finance"
                />
                <Kpi
                  label="Ticket médio"
                  value={money.format(data.summary.averageTicket)}
                  detail="Receita por pedido"
                  icon="sales"
                />
                <Kpi
                  label="Reembolsado"
                  value={money.format(data.summary.refunded)}
                  detail="No recorte atual"
                  icon="support"
                />
              </section>
              <ReportGroup
                title="Pedidos por status"
                rows={(data.analytics?.byStatus || []).map((row) => ({
                  label:
                    data.statuses.find((status) => status.key === row.status)
                      ?.label || row.status,
                  count: row._count._all,
                  value: row._sum.total || 0,
                }))}
              />
              <ReportGroup
                title="Meios de pagamento"
                rows={(data.analytics?.byPayment || []).map((row) => ({
                  label: row.paymentMethod || "Não informado",
                  count: row._count._all,
                  value: row._sum.total || 0,
                }))}
              />
              <ReportGroup
                title="Destinos por UF"
                rows={(data.analytics?.byState || []).map((row) => ({
                  label: row.deliveryState || "Não informado",
                  count: row._count._all,
                  value: row._sum.total || 0,
                }))}
              />
            </div>
          )}
        </div>
        <footer>
          <span>Alterações auditadas por usuário e organização</span>
          <button onClick={close}>Fechar</button>
        </footer>
      </section>
    </ErpModal>
  );
}

function exportOrders(
  search: string,
  status: string,
  after: string,
  before: string,
) {
  const params = new URLSearchParams({ format: "csv" });
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (after) params.set("after", after);
  if (before) params.set("before", before);
  const anchor = document.createElement("a");
  anchor.href = `/api/erp/order-management?${params}`;
  anchor.download = "pedidos.csv";
  anchor.click();
}
function originLabel(value: string) {
  return (
    (
      {
        manual: "Manual",
        store: "Loja",
        marketplace: "Marketplace",
        seller: "Vendedor",
        import: "Importação",
      } as Record<string, string>
    )[value] || value
  );
}
function deliveryLabel(value: string) {
  return (
    (
      {
        pickup: "Retirada",
        delivery: "Entrega própria",
        carrier: "Transportadora",
      } as Record<string, string>
    )[value] || value
  );
}
function returnReason(value: string) {
  return (
    (
      {
        produto_defeituoso: "Produto com defeito",
        produto_errado: "Produto errado",
        produto_danificado: "Danificado no transporte",
        nao_atendeu_expectativas: "Não atendeu às expectativas",
        desistencia: "Desistência da compra",
        outro: "Outro motivo",
      } as Record<string, string>
    )[value] || value
  );
}
function returnStatus(value: string) {
  return (
    (
      {
        pending: "Em análise",
        approved: "Aprovada",
        rejected: "Recusada",
        completed: "Concluída",
      } as Record<string, string>
    )[value] || value
  );
}
function queueStatus(value: string) {
  return (
    (
      {
        pending: "Pendente",
        processing: "Processando",
        sent: "Enviada",
        failed: "Falhou",
        dead: "Esgotada",
        cancelled: "Cancelada",
      } as Record<string, string>
    )[value] || value
  );
}
function statusPayload(
  order: Order,
  next: string,
  statuses: Map<string, Status>,
) {
  if (!next || next === order.status) return null;
  const workflow =
      next === "approved" && order.status === "draft"
        ? "approve"
        : next === "completed"
          ? "complete"
          : next === "cancelled"
            ? "cancel"
            : null,
    exceptional =
      !workflow &&
      statuses.get(next)?.native !== false &&
      !clientTransitions[order.status]?.includes(next);
  let reason = "";
  if (exceptional) {
    reason =
      prompt(
        `A transição ${order.status} → ${next} é excepcional. Informe o motivo obrigatório:`,
      )?.trim() || "";
    if (!reason) return null;
  }
  const label = statuses.get(next)?.label || next;
  if (!confirm(`Alterar o pedido ${order.number} para ${label}?`)) return null;
  return workflow
    ? { _endpoint: "/api/erp/orders", action: workflow, orderId: order.id }
    : {
        action: "status",
        orderId: order.id,
        status: next,
        confirmRegression: exceptional,
        reason,
      };
}
function documentType(value: string) {
  return (
    (
      {
        invoice: "Nota fiscal",
        shipping_label: "Etiqueta de frete",
        receipt: "Comprovante",
        contract: "Contrato",
        return: "Devolução",
      } as Record<string, string>
    )[value] || value
  );
}
function ReportGroup({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; count: number; value: number }>;
}) {
  const maximum = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="report-group">
      <h3>{title}</h3>
      {rows.map((row) => (
        <article key={row.label}>
          <div>
            <span>
              <strong>{row.label}</strong>
              <small>{row.count} pedido(s)</small>
            </span>
            <b>{money.format(row.value)}</b>
          </div>
          <i>
            <span
              style={{ width: `${Math.max(3, (row.count / maximum) * 100)}%` }}
            />
          </i>
        </article>
      ))}
      {!rows.length && <p>Não há dados no recorte atual.</p>}
    </section>
  );
}
function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}
function variationLabel(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Opção configurada";
  return (
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join(" · ") || "Opção configurada"
  );
}
function maskDocument(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length > 4
    ? `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`
    : "Não informado";
}
async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}
function printOrder(order: Order) {
  const popup = window.open("", "_blank", "noopener,noreferrer");
  if (!popup) return;
  const escape = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  popup.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escape(order.number)}</title><style>body{font:14px Arial;padding:32px;color:#172b36}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}.total{text-align:right;font-size:18px;margin-top:20px}</style></head><body><h1>Pedido ${escape(order.number)}</h1><p>${escape(order.customerName)} · ${escape(order.customerEmail)}</p><table><thead><tr><th>Item</th><th>SKU</th><th>Qtd.</th><th>Unitário</th><th>Total</th></tr></thead><tbody>${order.items.map((item) => `<tr><td>${escape(item.nameSnapshot)}</td><td>${escape(item.skuSnapshot)}</td><td>${escape(item.quantity)}</td><td>${escape(money.format(item.unitPrice))}</td><td>${escape(money.format(item.total))}</td></tr>`).join("")}</tbody></table><p class="total"><b>Total: ${escape(money.format(order.total))}</b></p></body></html>`,
  );
  popup.document.close();
  popup.focus();
  popup.print();
}
