"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BomForm,
  CenterForm,
  InspectionForm,
  OrderForm,
  ProcurementForm,
  ReportForm,
  ScheduleForm,
} from "./production-forms";
import { Field, FormFooter, ProductionDialog } from "./production-ui";
import {
  brl,
  fmt,
  moneyCents,
  priorityLabels,
  productionApi,
  qualityLabels,
  reportCost,
  shortDate,
  stageLabels,
  timestamp,
  units,
  type Bom,
  type Center,
  type Detail,
  type Order,
  type Page,
  type Report,
  type Requirement,
  type Revision,
} from "./production-types";
import type { ProductionSnapshot } from "@/lib/erp/production-domain";
import styles from "./production-workspace.module.css";

const cache = new Map<string, { at: number; value: unknown }>();
function useProductionData<T>(
  namespace: string,
  query: string,
  revision: number,
) {
  const key = `${namespace}:${query}`;
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error: string;
    loading: boolean;
  }>(() => ({
    key,
    data: cache.get(key)?.value as T | undefined,
    error: "",
    loading: true,
  }));
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((current) => ({
      key,
      data:
        current.key === key
          ? current.data
          : (cache.get(key)?.value as T | undefined),
      error: "",
      loading: true,
    }));
    try {
      const response = await fetch(`${productionApi}?${query}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Não foi possível carregar a produção.");
      if (controller.signal.aborted) return;
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), value: body });
      setState({ key, data: body, error: "", loading: false });
    } catch (reason) {
      if (!controller.signal.aborted)
        setState((current) => ({
          ...current,
          key,
          error: reason instanceof Error ? reason.message : "Falha de conexão.",
          loading: false,
        }));
    }
  }, [key, query]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [load, revision]);
  return {
    ...(state.key === key
      ? state
      : { key, loading: true, error: "", data: undefined }),
    reload: load,
  };
}
type Modal =
  | { kind: "order"; order?: Order; edit?: boolean }
  | { kind: "bom"; template?: ProductionSnapshot; bomId?: number }
  | { kind: "center"; center?: Center }
  | { kind: "detail" | "report"; orderId: number }
  | { kind: "inspect"; order: Order; report: Report }
  | { kind: "schedule"; order: Order }
  | {
      kind: "procurement";
      order: Order;
      material: Requirement;
      operation: "purchase" | "transfer";
    }
  | { kind: "revisions"; bom: Bom }
  | {
      kind: "confirm";
      title: string;
      description: string;
      payload: Record<string, unknown>;
      reason?: boolean;
    };
type Summary = {
  groups: {
    status: string;
    _count: { _all: number };
    _sum: { actualCost: number | null; producedQuantity: number | null };
  }[];
  overdue: number;
  quarantine: number;
};
export function ProductionWorkspace({
  cacheNamespace,
}: {
  cacheNamespace: string;
}) {
  const [resource, setResource] = useState("orders"),
    [layout, setLayout] = useState("kanban"),
    [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [status, setStatus] = useState(""),
    [priority, setPriority] = useState(""),
    [tag, setTag] = useState(""),
    [overdue, setOverdue] = useState(false);
  const [cursor, setCursor] = useState<string | number | null>(null),
    [previous, setPrevious] = useState<Array<string | number | null>>([]),
    [selected, setSelected] = useState<number[]>([]),
    [bulkStatus, setBulkStatus] = useState("in_progress"),
    [revision, setRevision] = useState(0),
    [modal, setModal] = useState<Modal | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [range, setRange] = useState(() => {
    const now = new Date();
    return {
      start: now.toISOString().slice(0, 10),
      end: new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10),
    };
  });
  const pending = useRef<{
      payload: Record<string, unknown>;
      key: string;
      signature: string;
    } | null>(null),
    inFlight = useRef(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const resetPage = () => {
    setCursor(null);
    setPrevious([]);
    setSelected([]);
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setCursor(null);
      setPrevious([]);
      setSelected([]);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    resource:
      resource === "orders" && layout === "calendar" ? "calendar" : resource,
    search: debounced,
    limit: "30",
  });
  if (cursor)
    params.set(
      resource === "centers" ? "centerAfter" : "after",
      String(cursor),
    );
  if (resource === "orders") {
    if (status) params.set("status", status);
    if (priority) params.set("priority", priority);
    if (tag) params.set("tag", tag);
    if (overdue) params.set("overdue", "true");
    if (layout === "calendar") {
      params.set("start", `${range.start}T00:00:00Z`);
      params.set("end", `${range.end}T23:59:00Z`);
    }
  }
  const list = useProductionData<Page<Order | Bom | Center>>(
    cacheNamespace,
    params.toString(),
    revision,
  );
  const summary = useProductionData<Summary>(
    cacheNamespace,
    "resource=summary",
    revision,
  );
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    let latest = "",
      stopped = false;
    const controller = new AbortController();
    const check = async () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      try {
        const response = await fetch(`${productionApi}?resource=changes`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = await response.json();
        if (!stopped && latest && latest !== body.revision) refresh();
        latest = body.revision;
      } catch {
        /* The foreground loader shows actionable failures. */
      }
    };
    const timer = setInterval(() => void check(), 12000);
    const focus = () => {
      refresh();
      void check();
    };
    window.addEventListener("focus", focus);
    void check();
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [cacheNamespace, refresh]);
  async function command(payload: Record<string, unknown>) {
    if (inFlight.current) return false;
    const signature = JSON.stringify(payload);
    if (pending.current && pending.current.signature !== signature) {
      setError(
        "A operação anterior ainda não teve o resultado confirmado. Use “Tentar operação novamente” antes de executar outra ação.",
      );
      return false;
    }
    const attempt = pending.current || {
      payload,
      signature,
      key: crypto.randomUUID(),
    };
    pending.current = attempt;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(productionApi, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...attempt.payload,
          idempotencyKey: attempt.key,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500) pending.current = null;
        throw new Error(body.error || "Não foi possível concluir a operação.");
      }
      pending.current = null;
      setUnconfirmed(false);
      setNotice(body.message || "Operação concluída.");
      setSelected([]);
      refresh();
      window.dispatchEvent(new Event("erp:inventory-changed"));
      return true;
    } catch (reason) {
      setUnconfirmed(Boolean(pending.current));
      setError(
        reason instanceof Error
          ? reason.message
          : "Conexão interrompida. Tente novamente para confirmar o resultado sem duplicar a operação.",
      );
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function retryPendingCommand() {
    if (!pending.current) return;
    if (await command(pending.current.payload)) {
      if (modal && modal.kind !== "detail" && modal.kind !== "revisions")
        setModal(null);
    }
  }
  const transition = (order: Order, target: string) => {
    if (target === order.status) return;
    if (target === "completed" || target === "cancelled") {
      setModal({
        kind: "confirm",
        title: target === "completed" ? "Concluir ordem" : "Cancelar ordem",
        description:
          "Os apontamentos serão preservados e as reservas restantes serão liberadas. Todas as inspeções precisam estar concluídas.",
        payload: {
          action: target === "completed" ? "order.close" : "order.cancel",
          orderId: order.id,
          version: order.version,
        },
        reason: true,
      });
      return;
    }
    if (
      !(
        {
          planned: ["in_progress"],
          in_progress: ["paused"],
          paused: ["in_progress"],
        } as Record<string, string[]>
      )[order.status]?.includes(target)
    ) {
      setError(
        "Essa mudança de etapa não é permitida. Use as ações disponíveis na ordem.",
      );
      return;
    }
    void command({
      action: "order.transition",
      orderId: order.id,
      version: order.version,
      status: target,
    });
  };
  const orders =
    resource === "orders" ? ((list.data?.items || []) as Order[]) : [];
  const ordered = orders;
  const totalOpen = summary.data?.groups
    .filter((group) =>
      ["planned", "in_progress", "paused"].includes(group.status),
    )
    .reduce((sum, group) => sum + group._count._all, 0);
  const closed = (order: Order) =>
    ["completed", "cancelled"].includes(order.status);
  const closeModal = () => {
    if (!busy) setModal(null);
  };
  function card(order: Order) {
    return (
      <article
        key={order.id}
        className={styles.card}
        data-priority={order.priority}
        draggable={!busy && !closed(order)}
        onDragStart={(event) => {
          event.dataTransfer.setData(
            "application/x-nalven-production",
            String(order.id),
          );
          event.dataTransfer.effectAllowed = "move";
        }}
      >
        <header>
          <label className={styles.checkbox}>
            <input
              aria-label={`Selecionar ${order.number}`}
              type="checkbox"
              checked={selected.includes(order.id)}
              disabled={busy}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, order.id]
                    : current.filter((id) => id !== order.id),
                )
              }
            />
            <span>{order.number}</span>
          </label>
          <span className={styles.badge} data-status={order.status}>
            {stageLabels[order.status]}
          </span>
        </header>
        <button
          className={styles.cardTitle}
          onClick={() => setModal({ kind: "detail", orderId: order.id })}
        >
          {order.outputProduct.name}
        </button>
        <small>
          {order.warehouse.name} · revisão {order.revision?.version ?? "legada"}{" "}
          · ID {order.id}
        </small>
        <div className={styles.tags}>
          <span data-priority={order.priority}>
            {priorityLabels[order.priority]}
          </span>
          {order.tags.map((item) => (
            <button
              key={item}
              onClick={() => {
                setTag(item);
                resetPage();
              }}
            >
              {item}
            </button>
          ))}
        </div>
        <dl>
          <div>
            <dt>Planejado / aprovado</dt>
            <dd>
              {fmt.format(order.plannedQuantity)} /{" "}
              {fmt.format(order.producedQuantity || 0)}
            </dd>
          </div>
          <div>
            <dt>Prazo</dt>
            <dd>{shortDate(order.dueAt)}</dd>
          </div>
          <div>
            <dt>Responsável</dt>
            <dd>{order.assignedTo || "Não atribuído"}</dd>
          </div>
          <div>
            <dt>Qualidade</dt>
            <dd>{qualityLabels[order.qualityStatus]}</dd>
          </div>
        </dl>
        {order.workCenter && (
          <p className={styles.resourceLabel}>
            {order.workCenter.name}
            {order.scheduledStart
              ? ` · ${timestamp(order.scheduledStart)}`
              : ""}
          </p>
        )}
        <footer>
          <button
            onClick={() => setModal({ kind: "detail", orderId: order.id })}
          >
            Abrir ordem
          </button>
          {!closed(order) && (
            <select
              aria-label={`Mover ${order.number} para etapa`}
              value=""
              disabled={busy}
              onChange={(event) => transition(order, event.target.value)}
            >
              <option value="">Mover etapa…</option>
              {order.status !== "in_progress" && (
                <option value="in_progress">
                  {order.status === "paused" ? "Retomar" : "Iniciar"}
                </option>
              )}
              {order.status === "in_progress" && (
                <option value="paused">Pausar</option>
              )}
              <option value="completed">Concluir</option>
              <option value="cancelled">Cancelar</option>
            </select>
          )}
        </footer>
      </article>
    );
  }
  return (
    <div className={styles.workspace}>
      <header className={styles.commandbar}>
        <div>
          <p>PLANEJAMENTO E CHÃO DE FÁBRICA</p>
          <h2>Produção e kits</h2>
          <span>Materiais, execução e qualidade em uma única ordem.</span>
        </div>
        <div>
          <button onClick={refresh} disabled={list.loading}>
            {list.loading ? "Atualizando…" : "Atualizar"}
          </button>
          <button onClick={() => setModal({ kind: "bom" })}>Nova ficha</button>
          <button
            className={styles.primary}
            onClick={() => setModal({ kind: "order" })}
          >
            Nova ordem
          </button>
        </div>
      </header>
      {(error || notice) && (
        <div
          className={error ? styles.error : styles.notice}
          role={error ? "alert" : "status"}
        >
          <span>{error || notice}</span>
          {unconfirmed && (
            <button disabled={busy} onClick={() => void retryPendingCommand()}>
              Tentar operação novamente
            </button>
          )}
          <button
            aria-label="Dispensar mensagem"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            ×
          </button>
        </div>
      )}
      <section className={styles.kpis} aria-label="Indicadores de produção">
        <article>
          <span>Ordens abertas</span>
          <strong>{totalOpen ?? "—"}</strong>
          <small>Planejadas, em produção e pausadas</small>
        </article>
        <article>
          <span>Em produção</span>
          <strong>
            {summary.data?.groups.find(
              (group) => group.status === "in_progress",
            )?._count._all ?? (summary.data ? 0 : "—")}
          </strong>
          <small>Em execução no chão de fábrica</small>
        </article>
        <article>
          <span>Aguardando qualidade</span>
          <strong>{summary.data?.quarantine ?? "—"}</strong>
          <small>Apontamentos em quarentena</small>
        </article>
        <article>
          <span>Ordens atrasadas</span>
          <strong>{summary.data?.overdue ?? "—"}</strong>
          <button
            onClick={() => {
              setResource("orders");
              setOverdue(true);
              resetPage();
            }}
          >
            Ver atrasadas
          </button>
        </article>
      </section>
      {summary.error && (
        <div className={styles.error} role="alert">
          {summary.error}
          <button onClick={() => void summary.reload()}>
            Atualizar indicadores
          </button>
        </div>
      )}
      <section className={styles.filters} aria-label="Filtros de produção">
        <Field label="Recurso">
          <select
            value={resource}
            onChange={(event) => {
              setResource(event.target.value);
              resetPage();
            }}
          >
            <option value="orders">Ordens de produção</option>
            <option value="boms">Fichas e revisões</option>
            <option value="centers">Máquinas, equipes e turnos</option>
          </select>
        </Field>
        <Field label="Buscar">
          <input
            type="search"
            placeholder="Nome, ordem ou responsável…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        {resource === "orders" && (
          <>
            <Field label="Status">
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  resetPage();
                }}
              >
                <option value="">Todos</option>
                {Object.entries(stageLabels).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prioridade">
              <select
                value={priority}
                onChange={(event) => {
                  setPriority(event.target.value);
                  resetPage();
                }}
              >
                <option value="">Todas</option>
                {Object.entries(priorityLabels).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Etiqueta">
              <input
                value={tag}
                onChange={(event) => {
                  setTag(event.target.value);
                  resetPage();
                }}
                placeholder="Etiqueta exata"
              />
            </Field>
            <Field label="Exibição">
              <select
                value={layout}
                onChange={(event) => {
                  setLayout(event.target.value);
                  resetPage();
                }}
              >
                <option value="kanban">Kanban</option>
                <option value="list">Lista</option>
                <option value="calendar">Calendário / Gantt</option>
              </select>
            </Field>
          </>
        )}
        <button
          onClick={() => {
            setSearch("");
            setStatus("");
            setPriority("");
            setTag("");
            setOverdue(false);
            resetPage();
          }}
        >
          Limpar filtros{overdue ? " · atrasadas" : ""}
        </button>
      </section>
      {resource === "orders" && layout === "calendar" && (
        <div className={styles.dateRange}>
          <Field label="De">
            <input
              type="date"
              value={range.start}
              onChange={(event) => {
                setRange((current) => ({
                  ...current,
                  start: event.target.value,
                }));
                resetPage();
              }}
            />
          </Field>
          <Field label="Até">
            <input
              type="date"
              value={range.end}
              onChange={(event) => {
                setRange((current) => ({
                  ...current,
                  end: event.target.value,
                }));
                resetPage();
              }}
            />
          </Field>
          <p>Até 31 dias. Abra uma ordem para agendar um recurso.</p>
        </div>
      )}
      {selected.length > 0 && resource === "orders" && (
        <section
          className={styles.bulk}
          aria-label="Ações nas ordens selecionadas"
        >
          <strong>{selected.length} selecionada(s)</strong>
          <select
            aria-label="Etapa em lote"
            value={bulkStatus}
            onChange={(event) => setBulkStatus(event.target.value)}
          >
            <option value="in_progress">Iniciar / retomar</option>
            <option value="paused">Pausar</option>
          </select>
          <button
            disabled={busy}
            onClick={() =>
              void command({
                action: "order.bulk",
                operation: "order.transition",
                orders: orders
                  .filter((order) => selected.includes(order.id))
                  .map((order) => ({
                    orderId: order.id,
                    version: order.version,
                  })),
                changes: { status: bulkStatus },
              })
            }
          >
            Aplicar etapa
          </button>
          <button onClick={() => setSelected([])}>Limpar seleção</button>
          <small>
            Se uma ordem não puder mudar, todo o lote será preservado.
          </small>
        </section>
      )}
      {list.error && (
        <div role="alert" className={styles.error}>
          {list.error}
          <button onClick={() => void list.reload()}>Tentar novamente</button>
        </div>
      )}
      {!list.data && list.loading && (
        <div className={styles.empty} role="status">
          Carregando produção…
        </div>
      )}
      {list.data && !list.data.items.length && (
        <div className={styles.empty}>
          <h3>Nenhum resultado</h3>
          <p>
            {resource === "orders"
              ? "Crie uma ordem ou ajuste os filtros para organizar a produção."
              : "Cadastre o primeiro registro ou ajuste a busca."}
          </p>
          <button
            onClick={() =>
              setModal(
                resource === "centers"
                  ? { kind: "center" }
                  : resource === "boms"
                    ? { kind: "bom" }
                    : { kind: "order" },
              )
            }
          >
            Criar registro
          </button>
        </div>
      )}
      {resource === "orders" && layout === "kanban" && orders.length > 0 && (
        <>
          <p className={styles.hint}>
            Arraste para mudar de etapa ou use “Mover etapa” em cada ordem. A
            posição manual, a prioridade e o prazo organizam toda a fila antes
            da paginação.
          </p>
          <section className={styles.kanban} aria-label="Kanban de produção">
            {Object.entries(stageLabels).map(([stage, label]) => (
              <section
                key={stage}
                data-stage={stage}
                onDragOver={(event) => {
                  if (
                    event.dataTransfer.types.includes(
                      "application/x-nalven-production",
                    )
                  ) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = Number(
                      event.dataTransfer.getData(
                        "application/x-nalven-production",
                      ),
                    ),
                    order = orders.find((item) => item.id === id);
                  if (order && !busy) transition(order, stage);
                }}
              >
                <header>
                  <h3>{label}</h3>
                  <span>
                    {orders.filter((order) => order.status === stage).length}
                  </span>
                </header>
                <div role="region" aria-label={`Ordens: ${label}`} tabIndex={0}>
                  {ordered.filter((order) => order.status === stage).map(card)}
                  {!orders.some((order) => order.status === stage) && (
                    <p>Nenhuma ordem nesta etapa da página.</p>
                  )}
                </div>
              </section>
            ))}
          </section>
        </>
      )}
      {resource === "orders" && layout === "list" && (
        <section className={styles.orderList}>{ordered.map(card)}</section>
      )}
      {resource === "orders" && layout === "calendar" && orders.length > 0 && (
        <Gantt
          orders={orders}
          start={range.start}
          end={range.end}
          open={(order) => setModal({ kind: "detail", orderId: order.id })}
        />
      )}
      {resource === "boms" && (
        <section className={styles.catalog}>
          {((list.data?.items || []) as Bom[]).map((bom) => (
            <article key={bom.id}>
              <header>
                <div>
                  <small>{bom.code}</small>
                  <h3>{bom.name}</h3>
                </div>
                <span className={styles.badge}>
                  {bom.active ? "Ativa" : "Arquivada"}
                </span>
              </header>
              <p>{bom.outputProduct.name}</p>
              <dl>
                <div>
                  <dt>Revisões</dt>
                  <dd>{bom._count.revisions}</dd>
                </div>
                <div>
                  <dt>Ordens</dt>
                  <dd>{bom._count.orders}</dd>
                </div>
              </dl>
              <p>
                Última revisão: {bom.revisions[0]?.version || "—"} ·{" "}
                {bom.revisions[0]?.status === "draft"
                  ? "Aguardando aprovação"
                  : bom.revisions[0]?.status === "approved"
                    ? "Aprovada"
                    : "Sem revisão"}
              </p>
              <footer>
                <button onClick={() => setModal({ kind: "revisions", bom })}>
                  Revisões e aprovação
                </button>
                <button
                  onClick={() =>
                    setModal({
                      kind: "bom",
                      template: bom.revisions[0]?.snapshot,
                    })
                  }
                >
                  Duplicar ficha
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void command({ action: "bom.toggle", bomId: bom.id })
                  }
                >
                  {bom.active ? "Arquivar" : "Reativar"}
                </button>
              </footer>
            </article>
          ))}
        </section>
      )}
      {resource === "centers" && (
        <>
          <div className={styles.sectionTitle}>
            <h3>Capacidade e turnos</h3>
            <button
              className={styles.primary}
              onClick={() => setModal({ kind: "center" })}
            >
              Novo recurso
            </button>
          </div>
          <section className={styles.catalog}>
            {((list.data?.items || []) as Center[]).map((center) => (
              <article key={center.id}>
                <header>
                  <h3>{center.name}</h3>
                  <span>{center.active ? "Ativo" : "Inativo"}</span>
                </header>
                <p>
                  {center.kind === "machine"
                    ? "Máquina"
                    : center.kind === "team"
                      ? "Equipe"
                      : "Linha de produção"}{" "}
                  · {center.timeZone}
                </p>
                <dl>
                  <div>
                    <dt>Limite simultâneo</dt>
                    <dd>{center.wipLimit} ordens</dd>
                  </div>
                  <div>
                    <dt>Custo por hora</dt>
                    <dd>{moneyCents(center.hourlyCostCents)}</dd>
                  </div>
                </dl>
                <ul>
                  {center.shifts.map((shift, index) => (
                    <li key={index}>
                      {
                        ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][
                          shift.day
                        ]
                      }{" "}
                      · {shift.start}–{shift.end}
                    </li>
                  ))}
                </ul>
                <button onClick={() => setModal({ kind: "center", center })}>
                  Editar recurso e turnos
                </button>
              </article>
            ))}
          </section>
        </>
      )}
      {list.data && (
        <footer className={styles.pager}>
          <span>
            {list.data.items.length} registros nesta página
            {list.data.total !== undefined
              ? ` · ${list.data.total} no filtro`
              : ""}
          </span>
          <div>
            <button
              disabled={!previous.length || list.loading}
              onClick={() => {
                setCursor(previous[previous.length - 1]);
                setPrevious((current) => current.slice(0, -1));
                setSelected([]);
              }}
            >
              Anterior
            </button>
            <button
              disabled={!list.data.nextCursor || list.loading}
              onClick={() => {
                setPrevious((current) => [...current, cursor]);
                setCursor(list.data!.nextCursor);
                setSelected([]);
              }}
            >
              Próxima
            </button>
          </div>
        </footer>
      )}
      {modal && (
        <ProductionDialog
          title={
            modal.kind === "confirm"
              ? modal.title
              : (
                  {
                    order:
                      modal.kind === "order" && modal.edit
                        ? "Editar planejamento"
                        : "Nova ordem de produção",
                    bom: "Ficha técnica e custos",
                    center: "Recurso e turnos",
                    detail: "Ordem de produção",
                    report: "Apontamento parcial",
                    inspect: "Inspeção de qualidade",
                    schedule: "Agendar produção",
                    procurement: "Abastecer produção",
                    revisions: "Revisões da ficha",
                  } as Record<string, string>
                )[modal.kind]
          }
          busy={busy}
          close={closeModal}
        >
          {error && (
            <div role="alert" className={styles.error}>
              {error}
              {unconfirmed && (
                <button
                  disabled={busy}
                  onClick={() => void retryPendingCommand()}
                >
                  Tentar operação novamente
                </button>
              )}
            </div>
          )}
          {modal.kind === "order" && (
            <OrderForm
              order={modal.order}
              edit={modal.edit}
              busy={busy}
              close={closeModal}
              command={command}
            />
          )}
          {modal.kind === "bom" && (
            <BomForm
              template={modal.template}
              bomId={modal.bomId}
              busy={busy}
              close={closeModal}
              command={command}
            />
          )}
          {modal.kind === "center" && (
            <CenterForm
              center={modal.center}
              busy={busy}
              close={closeModal}
              command={command}
            />
          )}
          {(modal.kind === "detail" || modal.kind === "report") && (
            <OrderDetail
              namespace={cacheNamespace}
              id={modal.orderId}
              revision={revision}
              reportMode={modal.kind === "report"}
              busy={busy}
              close={closeModal}
              command={command}
              open={setModal}
            />
          )}
          {modal.kind === "inspect" && (
            <InspectionForm
              order={modal.order}
              report={modal.report}
              busy={busy}
              close={closeModal}
              command={command}
            />
          )}
          {modal.kind === "schedule" && (
            <ScheduleForm
              order={modal.order}
              busy={busy}
              close={closeModal}
              command={command}
            />
          )}
          {modal.kind === "procurement" && (
            <ProcurementForm
              order={modal.order}
              material={modal.material}
              kind={modal.operation}
              busy={busy}
              close={closeModal}
              command={command}
            />
          )}
          {modal.kind === "revisions" && (
            <Revisions
              namespace={cacheNamespace}
              bom={modal.bom}
              revision={revision}
              command={command}
              busy={busy}
              open={setModal}
            />
          )}
          {modal.kind === "confirm" && (
            <form
              className={styles.form}
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const values = Object.fromEntries(
                  new FormData(event.currentTarget),
                );
                if (await command({ ...modal.payload, ...values }))
                  closeModal();
              }}
            >
              <p className={styles.wide}>{modal.description}</p>
              {modal.reason && (
                <Field wide label="Justificativa">
                  <textarea name="reason" required maxLength={1000} />
                </Field>
              )}
              <FormFooter busy={busy} close={closeModal} label="Confirmar" />
            </form>
          )}
        </ProductionDialog>
      )}
    </div>
  );
}

function OrderDetail({
  namespace,
  id,
  revision,
  reportMode,
  busy,
  close,
  command,
  open,
}: {
  namespace: string;
  id: number;
  revision: number;
  reportMode: boolean;
  busy: boolean;
  close: () => void;
  command: (payload: Record<string, unknown>) => Promise<boolean>;
  open: (modal: Modal) => void;
}) {
  const data = useProductionData<Detail>(
    namespace,
    `resource=detail&id=${id}`,
    revision,
  );
  if (!data.data)
    return (
      <div className={styles.detail}>
        {data.error ? (
          <div role="alert">
            {data.error}
            <button onClick={() => void data.reload()}>Tentar novamente</button>
          </div>
        ) : (
          <p role="status">Carregando a ordem…</p>
        )}
      </div>
    );
  const detail = data.data,
    order = detail.order,
    isClosed = ["completed", "cancelled"].includes(order.status);
  if (reportMode)
    return (
      <ReportForm detail={detail} busy={busy} close={close} command={command} />
    );
  return (
    <div className={styles.detail}>
      {data.error && <div className={styles.error}>{data.error}</div>}
      <header className={styles.detailHeading}>
        <div>
          <small>
            {order.number} · ID {order.id} · revisão {order.revision?.version}
          </small>
          <h3>{order.outputProduct.name}</h3>
          <p>
            {order.warehouse.name} · {stageLabels[order.status]} ·{" "}
            {qualityLabels[order.qualityStatus]}
          </p>
        </div>
        <strong>
          {brl.format(order.actualCost || 0)}
          <small>Custo acumulado</small>
        </strong>
      </header>
      <div className={styles.actions}>
        <button onClick={() => open({ kind: "order", order, edit: true })}>
          Editar planejamento
        </button>
        <button onClick={() => open({ kind: "order", order })}>
          Duplicar ordem
        </button>
        {!isClosed && (
          <>
            <button
              onClick={() => open({ kind: "schedule", order })}
              disabled={order.status === "in_progress"}
            >
              Agendar recurso
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void command({
                  action: "order.reserve",
                  orderId: id,
                  version: order.version,
                })
              }
            >
              Reservar materiais
            </button>
            {order.status === "in_progress" ? (
              <>
                <button
                  className={styles.primary}
                  onClick={() => open({ kind: "report", orderId: id })}
                >
                  Apontar produção
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void command({
                      action: "order.transition",
                      orderId: id,
                      version: order.version,
                      status: "paused",
                    })
                  }
                >
                  Pausar
                </button>
              </>
            ) : (
              <button
                className={styles.primary}
                disabled={busy}
                onClick={() =>
                  void command({
                    action: "order.transition",
                    orderId: id,
                    version: order.version,
                    status: "in_progress",
                  })
                }
              >
                {order.status === "paused"
                  ? "Retomar produção"
                  : "Iniciar produção"}
              </button>
            )}
            <button
              onClick={() =>
                open({
                  kind: "confirm",
                  title: "Liberar reservas",
                  description:
                    "Os materiais não consumidos ficarão disponíveis para outras operações. A ordem precisa estar planejada ou pausada.",
                  payload: {
                    action: "order.release",
                    orderId: id,
                    version: order.version,
                  },
                  reason: true,
                })
              }
            >
              Liberar reservas
            </button>
            <button
              onClick={() =>
                open({
                  kind: "confirm",
                  title: "Concluir ordem",
                  description:
                    "Confirme que todos os apontamentos e inspeções foram realizados. As reservas restantes serão liberadas.",
                  payload: {
                    action: "order.close",
                    orderId: id,
                    version: order.version,
                  },
                  reason: true,
                })
              }
            >
              Concluir ordem
            </button>
            <button
              onClick={() =>
                open({
                  kind: "confirm",
                  title: "Cancelar ordem",
                  description:
                    "O histórico de consumo e produção será preservado e as reservas restantes serão liberadas.",
                  payload: {
                    action: "order.cancel",
                    orderId: id,
                    version: order.version,
                  },
                  reason: true,
                })
              }
            >
              Cancelar ordem
            </button>
          </>
        )}
        {order.status === "cancelled" && (
          <button
            disabled={busy}
            onClick={() =>
              void command({
                action: "order.reopen",
                orderId: id,
                version: order.version,
              })
            }
          >
            Reabrir ordem
          </button>
        )}
      </div>
      <dl className={styles.detailMetrics}>
        <div>
          <dt>Planejado</dt>
          <dd>{fmt.format(order.plannedQuantity)}</dd>
        </div>
        <div>
          <dt>Aprovado</dt>
          <dd>{fmt.format(order.producedQuantity || 0)}</dd>
        </div>
        <div>
          <dt>Responsável</dt>
          <dd>{order.assignedTo || "Não atribuído"}</dd>
        </div>
        <div>
          <dt>Prazo</dt>
          <dd>{shortDate(order.dueAt)}</dd>
        </div>
      </dl>
      {order.notes && <p>{order.notes}</p>}
      <section>
        <h3>Materiais e necessidade de abastecimento</h3>
        <p className={styles.hint}>
          A disponibilidade física é revalidada por lote, validade e reservas na
          confirmação da operação.
        </p>
        <div className={styles.materials}>
          {detail.materials.map((material) => (
            <article key={`${material.productId}:${material.variationId}`}>
              <header>
                <strong>{material.product.name}</strong>
                {material.variationId && (
                  <small>Variação {material.variationId}</small>
                )}
              </header>
              <dl>
                <div>
                  <dt>Necessário</dt>
                  <dd>{fmt.format(material.required)}</dd>
                </div>
                <div>
                  <dt>Reservado</dt>
                  <dd>{fmt.format(material.reserved)}</dd>
                </div>
                <div>
                  <dt>Disponível</dt>
                  <dd>{fmt.format(material.available)}</dd>
                </div>
                <div>
                  <dt>Compra pendente</dt>
                  <dd>{fmt.format(material.incomingQuantity)}</dd>
                </div>
                <div>
                  <dt>Falta líquida</dt>
                  <dd>{fmt.format(material.netShortage)}</dd>
                </div>
              </dl>
              {material.netShortage > 0 && !isClosed && (
                <div className={styles.actions}>
                  <button
                    onClick={() =>
                      open({
                        kind: "procurement",
                        order,
                        material,
                        operation: "purchase",
                      })
                    }
                  >
                    Gerar compra
                  </button>
                  <button
                    disabled={!material.sources.length}
                    onClick={() =>
                      open({
                        kind: "procurement",
                        order,
                        material,
                        operation: "transfer",
                      })
                    }
                  >
                    Transferir de outro depósito
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      <section>
        <h3>Separação e rastreabilidade</h3>
        {!order.reservations.length ? (
          <p>Ainda não há reserva de insumos.</p>
        ) : (
          <ul className={styles.trace}>
            {order.reservations.map((row) => {
              const lot = detail.lots.find((item) => item.id === row.lotId);
              return (
                <li key={row.id}>
                  <strong>
                    {detail.materials.find(
                      (item) => item.productId === row.productId,
                    )?.product.name || `Produto #${row.productId}`}
                  </strong>
                  <span>
                    {lot
                      ? `Lote ${lot.lotCode || "—"}${lot.serialNumber ? ` · série ${lot.serialNumber}` : ""} · validade ${shortDate(lot.expiresOn)}`
                      : "Saldo sem lote"}
                  </span>
                  <small>
                    Reservado {fmt.format(units(row.quantityMicros))} ·
                    consumido {fmt.format(units(row.consumedMicros))} · liberado{" "}
                    {fmt.format(units(row.releasedMicros))}
                  </small>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section>
        <h3>Apontamentos e qualidade</h3>
        {!order.reports.length && <p>Nenhum apontamento registrado.</p>}
        {order.reports.map((report) => (
          <article className={styles.report} key={report.id}>
            <header>
              <div>
                <strong>{report.outputIdentity.lotCode}</strong>
                <small>
                  {timestamp(report.createdAt)} · {report.actor}
                </small>
              </div>
              <span className={styles.badge}>
                {qualityLabels[report.status] || report.status}
              </span>
            </header>
            <dl>
              <div>
                <dt>Boa</dt>
                <dd>{fmt.format(units(report.producedMicros))}</dd>
              </div>
              <div>
                <dt>Refugo</dt>
                <dd>{fmt.format(units(report.scrapMicros))}</dd>
              </div>
              <div>
                <dt>Retrabalho</dt>
                <dd>{fmt.format(units(report.reworkMicros))}</dd>
              </div>
              <div>
                <dt>Custo total</dt>
                <dd>{moneyCents(reportCost(report))}</dd>
              </div>
            </dl>
            <details>
              <summary>Consumo real e composição do custo</summary>
              <p>
                Materiais {moneyCents(report.materialCostCents)} · mão de obra{" "}
                {moneyCents(report.laborCostCents)} · máquina{" "}
                {moneyCents(report.machineCostCents)} · energia{" "}
                {moneyCents(report.energyCostCents)} · indiretos{" "}
                {moneyCents(report.overheadCostCents)}
              </p>
              <ul>
                {report.consumptions.map((line) => (
                  <li key={line.reservation.id}>
                    {detail.materials.find(
                      (item) => item.productId === line.reservation.productId,
                    )?.product.name ||
                      `Produto #${line.reservation.productId}`}{" "}
                    · {fmt.format(units(line.quantityMicros))} ·{" "}
                    {moneyCents(line.totalCostCents)}
                  </li>
                ))}
              </ul>
              {report.outputIdentity.serialNumbers.length > 0 && (
                <p>Séries: {report.outputIdentity.serialNumbers.join(", ")}</p>
              )}
              {report.notes && <p>{report.notes}</p>}
            </details>
            <footer>
              {report.status === "quarantine" && (
                <button
                  className={styles.primary}
                  onClick={() => open({ kind: "inspect", order, report })}
                >
                  Inspecionar qualidade
                </button>
              )}
              {report.inspections.length > 0 && (
                <button onClick={() => printCertificate(order, report)}>
                  Imprimir certificado
                </button>
              )}
              {(report.status === "rejected" ||
                units(report.reworkMicros) > 0) && (
                <button
                  onClick={() =>
                    open({
                      kind: "confirm",
                      title: "Criar reposição/retrabalho",
                      description:
                        "Uma nova ordem receberá a quantidade reprovada ou destinada a retrabalho. A composição da ficha e os novos consumos serão registrados separadamente.",
                      payload: {
                        action: "order.rework",
                        orderId: id,
                        version: order.version,
                        reportId: report.id,
                      },
                      reason: true,
                    })
                  }
                >
                  Gerar ordem de retrabalho
                </button>
              )}
            </footer>
          </article>
        ))}
        {detail.reportsHaveMore && (
          <ReportHistory
            namespace={namespace}
            order={order}
            revision={revision}
            open={open}
            busy={busy}
          />
        )}
      </section>
      <section>
        <h3>Histórico da ordem</h3>
        <ol className={styles.history}>
          {detail.events.map((event) => (
            <li key={event.id}>
              <strong>{eventLabel(event.action)}</strong>
              <span>
                {event.actor} · {timestamp(event.createdAt)}
              </span>
              {typeof event.data.reason === "string" && (
                <p>{event.data.reason}</p>
              )}
            </li>
          ))}
        </ol>
        {detail.events.length === 50 && (
          <EventHistory
            namespace={namespace}
            orderId={id}
            revision={revision}
            firstCursor={detail.events[49].id}
          />
        )}
      </section>
    </div>
  );
}
function Revisions({
  namespace,
  bom,
  revision,
  command,
  busy,
  open,
}: {
  namespace: string;
  bom: Bom;
  revision: number;
  command: (payload: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  open: (modal: Modal) => void;
}) {
  const [after, setAfter] = useState<number | null>(null);
  const data = useProductionData<Page<Revision>>(
    namespace,
    `resource=revisions&bomId=${bom.id}${after ? `&after=${after}` : ""}`,
    revision,
  );
  return (
    <div className={styles.detail}>
      {data.error && <p role="alert">{data.error}</p>}
      <p>
        Revisões aprovadas ficam preservadas nas ordens. Uma revisão com
        vigência futura só será usada a partir da data definida.
      </p>
      {data.data?.items.map((item) => (
        <article className={styles.report} key={item.id}>
          <header>
            <h3>Revisão {item.version}</h3>
            <span>
              {item.status === "approved"
                ? "Aprovada"
                : item.status === "draft"
                  ? "Rascunho"
                  : "Retirada"}
            </span>
          </header>
          <p>
            Rendimento: {fmt.format(item.snapshot.yieldQuantity)} ·{" "}
            {item.snapshot.items.length} materiais · vigência:{" "}
            {item.effectiveAt ? timestamp(item.effectiveAt) : "A definir"}
          </p>
          <details>
            <summary>Composição, custos e instruções</summary>
            <ul>
              {item.snapshot.items.map((material) => (
                <li key={`${material.productId}:${material.variationId}`}>
                  Produto #{material.productId}
                  {material.variationId
                    ? ` · variação ${material.variationId}`
                    : ""}
                  : {fmt.format(material.quantity)} · perda{" "}
                  {material.wastePercent}%
                </li>
              ))}
            </ul>
            <p>
              Mão de obra {moneyCents(item.snapshot.laborHourlyCents)}/h ·
              máquina {moneyCents(item.snapshot.machineHourlyCents)}/h · energia{" "}
              {moneyCents(item.snapshot.energyBatchCents)}/lote · indiretos{" "}
              {moneyCents(item.snapshot.overheadBatchCents)}/lote
            </p>
            <p>{item.snapshot.notes}</p>
          </details>
          <footer>
            <button
              onClick={() =>
                open({ kind: "bom", bomId: bom.id, template: item.snapshot })
              }
            >
              Criar nova revisão
            </button>
            {item.status === "draft" && (
              <form
                className={styles.approval}
                onSubmit={async (event) => {
                  event.preventDefault();
                  const date = new FormData(event.currentTarget).get(
                    "effectiveAt",
                  );
                  await command({
                    action: "bom.approve",
                    revisionId: item.id,
                    ...(date
                      ? { effectiveAt: new Date(String(date)).toISOString() }
                      : {}),
                  });
                }}
              >
                <label>
                  Vigência (em branco: agora)
                  <input name="effectiveAt" type="datetime-local" />
                </label>
                <button className={styles.primary} disabled={busy}>
                  Aprovar revisão
                </button>
              </form>
            )}
          </footer>
        </article>
      ))}
      {data.loading && <p role="status">Carregando revisões…</p>}
      {data.data?.nextCursor && (
        <button onClick={() => setAfter(Number(data.data!.nextCursor))}>
          Revisões anteriores
        </button>
      )}
      {after && (
        <button onClick={() => setAfter(null)}>Voltar às recentes</button>
      )}
    </div>
  );
}
function ReportHistory({
  namespace,
  order,
  revision,
  open,
  busy,
}: {
  namespace: string;
  order: Order;
  revision: number;
  open: (modal: Modal) => void;
  busy: boolean;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const data = useProductionData<Page<Report>>(
    namespace,
    `resource=reports&orderId=${order.id}${cursor ? `&reportAfter=${cursor}` : ""}`,
    revision,
  );
  return (
    <details>
      <summary>Consultar histórico completo de apontamentos</summary>
      {data.data?.items.map((report) => (
        <article className={styles.report} key={report.id}>
          <header>
            <strong>{report.outputIdentity.lotCode}</strong>
            <span className={styles.badge}>{qualityLabels[report.status]}</span>
          </header>
          <p>
            {timestamp(report.createdAt)} · {report.actor}
          </p>
          <p>
            Boa: {fmt.format(units(report.producedMicros))} · Refugo:{" "}
            {fmt.format(units(report.scrapMicros))} · Retrabalho:{" "}
            {fmt.format(units(report.reworkMicros))} · Total:{" "}
            {moneyCents(reportCost(report))}
          </p>
          <details>
            <summary>Consumo, custos e rastreabilidade</summary>
            <p>
              Materiais {moneyCents(report.materialCostCents)} · mão de obra{" "}
              {moneyCents(report.laborCostCents)} · máquina{" "}
              {moneyCents(report.machineCostCents)} · energia{" "}
              {moneyCents(report.energyCostCents)} · indiretos{" "}
              {moneyCents(report.overheadCostCents)}
            </p>
            <ul>
              {report.consumptions.map((line) => (
                <li key={line.reservation.id}>
                  Produto #{line.reservation.productId}
                  {line.reservation.variationId
                    ? ` · Variação ${line.reservation.variationId}`
                    : ""}{" "}
                  · {fmt.format(units(line.quantityMicros))} ·{" "}
                  {moneyCents(line.totalCostCents)}
                </li>
              ))}
            </ul>
            <p>
              Validade: {shortDate(report.outputIdentity.expiresOn)} · Séries:{" "}
              {report.outputIdentity.serialNumbers.join(", ") ||
                "Não se aplica"}
            </p>
            {report.notes && <p>{report.notes}</p>}
          </details>
          <footer>
            {report.status === "quarantine" && (
              <button
                className={styles.primary}
                disabled={busy}
                onClick={() => open({ kind: "inspect", order, report })}
              >
                Inspecionar qualidade
              </button>
            )}
            {report.inspections.length > 0 && (
              <button onClick={() => printCertificate(order, report)}>
                Imprimir certificado
              </button>
            )}
            {(report.status === "rejected" ||
              units(report.reworkMicros) > 0) && (
              <button
                disabled={busy}
                onClick={() =>
                  open({
                    kind: "confirm",
                    title: "Criar reposição/retrabalho",
                    description:
                      "Criar uma ordem vinculada a este apontamento, com novos consumos e custos registrados separadamente.",
                    payload: {
                      action: "order.rework",
                      orderId: order.id,
                      version: order.version,
                      reportId: report.id,
                    },
                    reason: true,
                  })
                }
              >
                Gerar ordem de retrabalho
              </button>
            )}
          </footer>
        </article>
      ))}
      {data.error && <p role="alert">{data.error}</p>}
      {data.loading && <p role="status">Carregando apontamentos…</p>}
      {data.data?.nextCursor && (
        <button onClick={() => setCursor(String(data.data!.nextCursor))}>
          Apontamentos anteriores
        </button>
      )}
      {cursor && (
        <button onClick={() => setCursor(null)}>Voltar aos recentes</button>
      )}
    </details>
  );
}
function EventHistory({
  namespace,
  orderId,
  revision,
  firstCursor,
}: {
  namespace: string;
  orderId: number;
  revision: number;
  firstCursor: string;
}) {
  const [cursor, setCursor] = useState(firstCursor);
  const data = useProductionData<Page<Detail["events"][number]>>(
    namespace,
    `resource=events&orderId=${orderId}&after=${cursor}&limit=50`,
    revision,
  );
  return (
    <details>
      <summary>Consultar eventos anteriores</summary>
      {data.loading && <p role="status">Carregando histórico…</p>}
      {data.error && <p role="alert">{data.error}</p>}
      <ol className={styles.history}>
        {data.data?.items.map((event) => (
          <li key={event.id}>
            <strong>{eventLabel(event.action)}</strong>
            <span>
              {event.actor} · {timestamp(event.createdAt)}
            </span>
            {typeof event.data.reason === "string" && (
              <p>{event.data.reason}</p>
            )}
          </li>
        ))}
      </ol>
      {data.data?.nextCursor && (
        <button onClick={() => setCursor(String(data.data!.nextCursor))}>
          Eventos anteriores
        </button>
      )}
      {cursor !== firstCursor && (
        <button onClick={() => setCursor(firstCursor)}>
          Voltar ao início do histórico
        </button>
      )}
    </details>
  );
}
function Gantt({
  orders,
  start,
  end,
  open,
}: {
  orders: Order[];
  start: string;
  end: string;
  open: (order: Order) => void;
}) {
  const from = new Date(`${start}T00:00:00Z`).getTime(),
    until = new Date(`${end}T23:59:00Z`).getTime(),
    width = until - from;
  return (
    <section className={styles.gantt} aria-label="Calendário Gantt de produção">
      <header>
        <strong>Ordem / recurso</strong>
        <span>
          {shortDate(start)} — {shortDate(end)}
        </span>
      </header>
      {orders.map((order) => {
        const left = Math.max(
            0,
            ((new Date(order.scheduledStart!).getTime() - from) / width) * 100,
          ),
          right = Math.min(
            100,
            ((new Date(order.scheduledEnd!).getTime() - from) / width) * 100,
          );
        return (
          <div key={order.id}>
            <button onClick={() => open(order)}>
              <strong>{order.number}</strong>
              <small>{order.workCenter?.name}</small>
            </button>
            <div>
              <button
                data-status={order.status}
                style={{
                  left: `${left}%`,
                  width: `${Math.max(1, right - left)}%`,
                }}
                onClick={() => open(order)}
                aria-label={`${order.number}, ${timestamp(order.scheduledStart!)} até ${timestamp(order.scheduledEnd!)}`}
                title={`${timestamp(order.scheduledStart!)} — ${timestamp(order.scheduledEnd!)}`}
              >
                {order.outputProduct.name}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
function eventLabel(action: string) {
  return (
    (
      {
        "order.created": "Ordem criada",
        "order.update": "Planejamento atualizado",
        "order.schedule": "Agendamento alterado",
        "order.reserve": "Materiais reservados",
        "order.release": "Reservas liberadas",
        "order.transition": "Etapa alterada",
        "order.report": "Produção apontada",
        "report.inspect": "Inspeção realizada",
        "order.close": "Ordem concluída",
        "order.cancel": "Ordem cancelada",
        "order.reopen": "Ordem reaberta",
        "order.rework": "Retrabalho gerado",
        "mrp.purchase": "Compra gerada",
        "mrp.transfer": "Material transferido",
      } as Record<string, string>
    )[action] || "Ordem atualizada"
  );
}
function printCertificate(order: Order, report: Report) {
  const inspection = report.inspections[0];
  if (!inspection) return;
  const popup = window.open("", "_blank", "width=900,height=750");
  if (!popup) return;
  const escape = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  popup.document.write(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escape(inspection.certificate)}</title><style>body{font:15px system-ui;margin:40px;color:#17372c}h1{font-size:24px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border:1px solid #bbb;text-align:left}@media print{button{display:none}}</style></head><body><h1>Certificado de inspeção de produção</h1><p>${escape(inspection.certificate)}</p><h2>${escape(order.number)} · ${escape(order.outputProduct.name)}</h2><p>Revisão ${escape(order.revision?.version)} · lote ${escape(report.outputIdentity.lotCode)} · quantidade ${escape(fmt.format(units(report.producedMicros)))}</p><p>Fabricação ${escape(shortDate(report.outputIdentity.manufacturedOn))} · validade ${escape(shortDate(report.outputIdentity.expiresOn))}</p><table><thead><tr><th>Verificação</th><th>Resultado</th></tr></thead><tbody>${inspection.checklist.map((check) => `<tr><td>${escape(check.name)}</td><td>${check.passed ? "Conforme" : "Não conforme"}</td></tr>`).join("")}</tbody></table><p>Decisão: ${escape(qualityLabels[inspection.decision])}</p><p>${escape(inspection.notes)}</p><p>Inspetor: ${escape(inspection.actor)} · ${escape(timestamp(inspection.createdAt))}</p><p>Séries: ${escape(report.outputIdentity.serialNumbers.join(", ") || "Não se aplica")}</p><button onclick="window.print()">Imprimir</button></body></html>`,
  );
  popup.document.close();
  popup.focus();
}
