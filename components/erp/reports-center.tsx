"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErpModal } from "@/components/erp/modal-portal";
import {
  ReportDetailTools,
  ReportsWorkspaceHub,
} from "@/components/erp/reports-workspace-hub";
import type { ReportKey } from "@/lib/erp/report-workspace";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const BASE = "/erp/relatorios";
const tabs = [
  [BASE, "Central", "◇"],
  [`${BASE}/margens`, "Margens", "▥"],
  [`${BASE}/vendas`, "Vendas", "↗"],
  [`${BASE}/produtos`, "Produtos", "□"],
  [`${BASE}/fiscal`, "Fiscal", "NF"],
] as const;

export function ReportsCenter() {
  const pathname = usePathname();
  const active =
    pathname === BASE
      ? "workspace"
      : pathname.endsWith("/margens")
        ? "margins"
        : pathname.endsWith("/vendas")
          ? "sales"
          : pathname.endsWith("/produtos")
            ? "products"
            : "fiscal";
  return (
    <div className="reports-center">
      <nav className="reports-nav" aria-label="Relatórios">
        {tabs.map(([href, label, icon]) => (
          <Link
            className={pathname === href ? "active" : ""}
            href={href}
            key={href}
          >
            <i>{icon}</i>
            {label}
          </Link>
        ))}
      </nav>
      {active === "workspace" ? (
        <ReportsWorkspaceHub />
      ) : (
        <>
          <ReportDetailTools reportKey={active as ReportKey} />
          {active === "margins" ? (
            <MarginsReport />
          ) : active === "sales" ? (
            <SalesReport />
          ) : active === "products" ? (
            <ProductsReport />
          ) : (
            <FiscalReport />
          )}
          {active === "fiscal" && <FiscalSettingsShortcut />}
        </>
      )}
    </div>
  );
}

function FiscalSettingsShortcut() {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const report = useReport<ReportSettingsData>("/api/erp/reports/settings");
  const [required, setRequired] = useState<string[]>([]);
  useEffect(() => {
    if (report.data && !required.length)
      setRequired(report.data.settings.fiscalRequiredFields);
  }, [report.data, required.length]);
  const save = async () => {
    if (!report.data || !required.length) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/reports/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...report.data.settings,
          fiscalRequiredFields: required,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setOpen(false);
      window.location.reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Não foi possível salvar.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="fiscal-settings-shortcut"
        onClick={() => setOpen(true)}
      >
        Configurar completude fiscal
      </button>
      {open && (
        <div className="report-modal" role="dialog" aria-modal="true">
          <button
            className="modal-backdrop"
            onClick={() => setOpen(false)}
            aria-label="Fechar"
          />
          <section className="fiscal-settings-modal">
            <header>
              <div>
                <small>CONFIGURAÇÃO FISCAL</small>
                <h2>Campos obrigatórios</h2>
              </div>
              <button onClick={() => setOpen(false)}>×</button>
            </header>
            <ReportState report={report}>
              <div className="settings-body">
                <p>
                  Marque os campos exigidos pela operação. CEST marcado como não
                  aplicável conta como preenchido.
                </p>
                <div className="fiscal-required">
                  {[
                    ["ncm", "NCM"],
                    ["cest", "CEST"],
                    ["origin", "Origem da mercadoria"],
                    ["gtin", "GTIN válido"],
                  ].map(([field, label]) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={required.includes(field)}
                        onChange={(event) =>
                          setRequired(
                            event.target.checked
                              ? [...required, field]
                              : required.filter((item) => item !== field),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {error && <InlineError text={error} />}
              </div>
            </ReportState>
            <footer>
              <button onClick={() => setOpen(false)}>Cancelar</button>
              <button
                className="primary"
                disabled={busy || !required.length}
                onClick={() => void save()}
              >
                {busy ? "Salvando…" : "Salvar"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function useReport<T>(endpoint: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok)
          throw new Error(
            payload.error || "Não foi possível carregar o relatório.",
          );
        setData(payload);
      })
      .catch((reason) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, version]);
  return {
    data,
    error,
    loading,
    retry: () => setVersion((value) => value + 1),
    setData,
  };
}

function useUrlFilters() {
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const params = useMemo(
    () => new URLSearchParams(search.toString()),
    [search],
  );
  const update = useCallback(
    (changes: Record<string, string | number | null>, resetPage = true) => {
      const next = new URLSearchParams(search.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, String(value));
      }
      if (resetPage) next.delete("page");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
        scroll: false,
      });
    },
    [pathname, router, search],
  );
  return { params, update };
}

async function download(
  endpoint: string,
  fallback: string,
  reportKey: ReportKey,
) {
  const response = await fetch(endpoint);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Não foi possível exportar.");
  }
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] || fallback;
  link.click();
  URL.revokeObjectURL(url);
  void fetch("/api/erp/reports/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "export.record",
      reportKey,
      fileName: link.download,
    }),
  });
}

type MarginRow = {
  id: number;
  name: string;
  sku: string;
  price: number;
  cogs: number;
  direct_costs: number;
  indirect_costs: number;
  global_costs: number;
  total_cost: number;
  margin: number;
  margin_percent: number;
  target_margin: number;
  minimum_margin: number;
  suggested_price: number;
  suggested_min: number;
  suggested_difference_percent: number;
  health: "healthy" | "warning" | "critical";
  margin_source: string;
  categories: Array<{ id: number; name: string }>;
  cost_breakdown: Array<{ label: string; value: number }>;
};
type MarginsData = {
  products: MarginRow[];
  summary: {
    avg_margin_percent: number;
    weighted_margin_percent: number;
    total_revenue: number;
    total_cost: number;
    total_margin: number;
    health_counts: Record<"healthy" | "warning" | "critical", number>;
    products_total: number;
  };
  category_breakdown: Array<{
    id: number;
    name: string;
    products: number;
    avg_margin_percent: number;
    total_revenue: number;
    total_cost: number;
    total_margin: number;
    health_counts: Record<string, number>;
  }>;
  categories: Array<{ id: number; name: string }>;
  total: number;
  page: number;
  per_page: number;
  pages: number;
};

function MarginsReport() {
  const { params, update } = useUrlFilters(),
    [view, setView] = useState(
      params.get("view") === "categories" ? "categories" : "products",
    ),
    [settings, setSettings] = useState(false),
    [exportError, setExportError] = useState("");
  const endpoint = `/api/erp/reports/margins?${params}`;
  const report = useReport<MarginsData>(endpoint);
  const health = params.get("health") || "";
  const setOrder = (field: string) =>
    update({
      order_by: field,
      order:
        params.get("order_by") === field && params.get("order") !== "ASC"
          ? "ASC"
          : "DESC",
    });
  const exportRows = async (mode: "page" | "all") => {
    try {
      setExportError("");
      const query = new URLSearchParams(params);
      query.set("export", mode);
      await download(
        `/api/erp/reports/margins?${query}`,
        "relatorio-margens.csv",
        "margins",
      );
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Falha na exportação.",
      );
    }
  };
  return (
    <>
      <ReportHeading
        eyebrow="BI DE PRECIFICAÇÃO"
        title="Relatório de margens"
        description="Custos, margens e saúde financeira do catálogo atual — sem filtro de período."
      >
        <button className="primary" onClick={() => setSettings(true)}>
          Configurar relatórios
        </button>
      </ReportHeading>
      <ReportState report={report}>
        {report.data && (
          <>
            <section className="report-kpis">
              <Kpi
                label="Margem média"
                value={`${number.format(report.data.summary.avg_margin_percent)}%`}
                detail={`Ponderada: ${number.format(report.data.summary.weighted_margin_percent)}%`}
              />
              <Kpi
                label="Preço de tabela (soma)"
                value={money.format(report.data.summary.total_revenue)}
                detail="Uma unidade de cada produto"
              />
              <Kpi
                label="Custo total"
                value={money.format(report.data.summary.total_cost)}
                detail="COGS + componentes"
              />
              <Kpi
                label="Lucro bruto potencial"
                value={money.format(report.data.summary.total_margin)}
                detail="Preço de tabela − custo"
                positive={report.data.summary.total_margin >= 0}
              />
            </section>
            <section className="health-grid">
              {(["healthy", "warning", "critical"] as const).map((key) => {
                const count = report.data!.summary.health_counts[key],
                  percent = report.data!.summary.products_total
                    ? Math.round(
                        (count / report.data!.summary.products_total) * 100,
                      )
                    : 0;
                return (
                  <button
                    className={`${key} ${health === key ? "active" : ""}`}
                    onClick={() =>
                      update({ health: health === key ? null : key })
                    }
                    key={key}
                  >
                    <span>{healthLabel(key)}</span>
                    <strong>
                      {count}
                      <small>{percent}%</small>
                    </strong>
                    <i>
                      <b style={{ width: `${percent}%` }} />
                    </i>
                  </button>
                );
              })}
            </section>
            <section className="report-toolbar">
              <label>
                Categoria
                <select
                  value={params.get("category_id") || ""}
                  onChange={(event) =>
                    update({ category_id: event.target.value })
                  }
                >
                  <option value="">Todas</option>
                  {report.data.categories.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {health && (
                <button
                  className="filter-chip"
                  onClick={() => update({ health: null })}
                >
                  {healthLabel(health)} ×
                </button>
              )}
              <span className="toolbar-spacer" />
              <button onClick={() => void exportRows("page")}>
                CSV da página
              </button>
              <button onClick={() => void exportRows("all")}>
                CSV completo
              </button>
              <div className="view-toggle">
                <button
                  className={view === "products" ? "active" : ""}
                  onClick={() => {
                    setView("products");
                    update({ view: null }, false);
                  }}
                >
                  Produtos
                </button>
                <button
                  className={view === "categories" ? "active" : ""}
                  onClick={() => {
                    setView("categories");
                    update({ view: "categories" }, false);
                  }}
                >
                  Categorias
                </button>
              </div>
            </section>
            {exportError && <InlineError text={exportError} />}
            {view === "products" ? (
              <MarginsTable data={report.data} setOrder={setOrder} />
            ) : (
              <CategoryMargins rows={report.data.category_breakdown} />
            )}
            {view === "products" && (
              <Pagination
                page={report.data.page}
                pages={report.data.pages}
                total={report.data.total}
                perPage={report.data.per_page}
                update={update}
              />
            )}
          </>
        )}
      </ReportState>
      {settings && (
        <MarginSettings
          close={() => setSettings(false)}
          saved={() => {
            setSettings(false);
            report.retry();
          }}
        />
      )}
    </>
  );
}

function MarginsTable({
  data,
  setOrder,
}: {
  data: MarginsData;
  setOrder: (field: string) => void;
}) {
  return (
    <section className="report-table">
      <table>
        <thead>
          <tr>
            <th>Produto</th>
            {[
              ["price", "Preço"],
              ["total_cost", "Custo total"],
              ["margin", "Margem"],
              ["margin_percent", "Margem (%)"],
              ["suggested_min", "Mín. sugerido"],
            ].map(([field, label]) => (
              <th className="numeric" key={field}>
                <button onClick={() => setOrder(field)}>{label} ↕</button>
              </th>
            ))}
            <th className="numeric wide-column">Preço sugerido</th>
            <th>Saúde</th>
          </tr>
        </thead>
        <tbody>
          {data.products.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`/erp/produtos-servicos?produto=${row.id}`}>
                  <strong>{row.name}</strong>
                </Link>
                <small>
                  {row.sku || "Sem SKU"} ·{" "}
                  <b className="source-badge">
                    {sourceLabel(row.margin_source)}
                  </b>
                </small>
              </td>
              <td className="numeric">{money.format(row.price)}</td>
              <td className="numeric">
                <span className="has-tooltip">
                  {money.format(row.total_cost)}
                  <span className="report-tooltip">
                    {row.cost_breakdown.map((item, index) => (
                      <i key={`${item.label}-${index}`}>
                        <span>{item.label}</span>
                        <b>{money.format(item.value)}</b>
                      </i>
                    ))}
                    <i className="total">
                      <span>Total</span>
                      <b>{money.format(row.total_cost)}</b>
                    </i>
                  </span>
                </span>
              </td>
              <td className={`numeric ${row.margin < 0 ? "negative" : ""}`}>
                {money.format(row.margin)}
              </td>
              <td className={`numeric ${row.margin < 0 ? "negative" : ""}`}>
                {number.format(row.margin_percent)}%
              </td>
              <td className="numeric wide-column">
                {money.format(row.suggested_min)}
              </td>
              <td className="numeric wide-column">
                <span className="has-tooltip">
                  {money.format(row.suggested_price)}
                  <span className="report-tooltip">
                    <i>
                      <span>Margem alvo</span>
                      <b>{number.format(row.target_margin)}%</b>
                    </i>
                    <i>
                      <span>Preço atual</span>
                      <b>{money.format(row.price)}</b>
                    </i>
                    <i className="total">
                      <span>Diferença</span>
                      <b>{number.format(row.suggested_difference_percent)}%</b>
                    </i>
                  </span>
                </span>
              </td>
              <td>
                <HealthBadge value={row.health} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!data.products.length && (
        <ReportEmpty
          filtered={Boolean(
            data.total === 0 && data.summary.products_total > 0,
          )}
        />
      )}
    </section>
  );
}

function CategoryMargins({
  rows,
}: {
  rows: MarginsData["category_breakdown"];
}) {
  return (
    <section className="report-table">
      <table>
        <thead>
          <tr>
            <th>Categoria</th>
            <th className="numeric">Produtos</th>
            <th className="numeric">Margem média</th>
            <th className="numeric">Preço de tabela</th>
            <th className="numeric">Custo</th>
            <th className="numeric">Lucro</th>
            <th>Saúde</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const total = row.products || 1;
            return (
              <tr key={row.id}>
                <td>
                  <strong>{row.name}</strong>
                </td>
                <td className="numeric">{row.products}</td>
                <td className="numeric">
                  {number.format(row.avg_margin_percent)}%
                </td>
                <td className="numeric">{money.format(row.total_revenue)}</td>
                <td className="numeric">{money.format(row.total_cost)}</td>
                <td
                  className={`numeric ${row.total_margin < 0 ? "negative" : ""}`}
                >
                  {money.format(row.total_margin)}
                </td>
                <td>
                  <div className="health-distribution">
                    <i
                      className="healthy"
                      style={{
                        width: `${((row.health_counts.healthy || 0) / total) * 100}%`,
                      }}
                    />
                    <i
                      className="warning"
                      style={{
                        width: `${((row.health_counts.warning || 0) / total) * 100}%`,
                      }}
                    />
                    <i
                      className="critical"
                      style={{
                        width: `${((row.health_counts.critical || 0) / total) * 100}%`,
                      }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

type ReportSettingsData = {
  settings: {
    pricingMode: string;
    globalTargetMargin: number | string;
    globalMinimumMargin: number | string;
    fiscalRequiredFields: string[];
    globalCosts: Array<{ type: string; label: string; value: number | string }>;
    categoryOverrides: Array<{
      categoryId: number;
      targetMargin: number | string;
      minimumMargin: number | string;
    }>;
  };
  categories: Array<{ id: number; name: string }>;
};
function MarginSettings({
  close,
  saved,
}: {
  close: () => void;
  saved: () => void;
}) {
  const report = useReport<ReportSettingsData>("/api/erp/reports/settings"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [form, setForm] = useState<ReportSettingsData["settings"] | null>(null);
  const categories = report.data?.categories || [];
  useEffect(() => {
    if (report.data && !form) setForm(report.data.settings);
  }, [report.data, form]);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/reports/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      saved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Falha ao salvar.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="report-modal" role="dialog" aria-modal="true">
      <button className="modal-backdrop" onClick={close} aria-label="Fechar" />
      <section>
        <header>
          <div>
            <small>CONFIGURAÇÃO</small>
            <h2>Margens e custos globais</h2>
          </div>
          <button onClick={close}>×</button>
        </header>
        <ReportState report={report}>
          {form && report.data && (
            <div className="settings-body">
              <div className="settings-grid">
                <label>
                  Modo
                  <select
                    value={form.pricingMode}
                    onChange={(event) =>
                      setForm({ ...form, pricingMode: event.target.value })
                    }
                  >
                    <option value="mixed">
                      Misto: produto → categoria → global
                    </option>
                    <option value="global">Somente global</option>
                    <option value="product">Produto → global</option>
                  </select>
                </label>
                <label>
                  Margem alvo global (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={String(form.globalTargetMargin)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        globalTargetMargin: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Margem mínima global (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={String(form.globalMinimumMargin)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        globalMinimumMargin: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <ConfigList
                title="Custos globais por unidade"
                note="Valores absolutos rateados em cada produto. Para despesa mensal, divida pelo volume esperado."
                add={() =>
                  setForm({
                    ...form,
                    globalCosts: [
                      ...form.globalCosts,
                      { type: "indirect", label: "", value: 0 },
                    ],
                  })
                }
              >
                {form.globalCosts.map((item, index) => (
                  <div className="config-row" key={index}>
                    <select
                      value={item.type}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          globalCosts: replace(form.globalCosts, index, {
                            ...item,
                            type: event.target.value,
                          }),
                        })
                      }
                    >
                      <option value="direct">Direto</option>
                      <option value="indirect">Indireto</option>
                    </select>
                    <input
                      placeholder="Descrição"
                      value={item.label}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          globalCosts: replace(form.globalCosts, index, {
                            ...item,
                            label: event.target.value,
                          }),
                        })
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={String(item.value)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          globalCosts: replace(form.globalCosts, index, {
                            ...item,
                            value: event.target.value,
                          }),
                        })
                      }
                    />
                    <button
                      onClick={() =>
                        setForm({
                          ...form,
                          globalCosts: form.globalCosts.filter(
                            (_, position) => position !== index,
                          ),
                        })
                      }
                    >
                      Remover
                    </button>
                  </div>
                ))}
              </ConfigList>
              <ConfigList
                title="Margens por categoria"
                add={() =>
                  setForm({
                    ...form,
                    categoryOverrides: [
                      ...form.categoryOverrides,
                      {
                        categoryId:
                          categories.find(
                            (category) =>
                              !form.categoryOverrides.some(
                                (current) => current.categoryId === category.id,
                              ),
                          )?.id || 0,
                        targetMargin: form.globalTargetMargin,
                        minimumMargin: form.globalMinimumMargin,
                      },
                    ],
                  })
                }
              >
                {form.categoryOverrides.map((item, index) => (
                  <div className="config-row category" key={index}>
                    <select
                      value={item.categoryId}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          categoryOverrides: replace(
                            form.categoryOverrides,
                            index,
                            { ...item, categoryId: Number(event.target.value) },
                          ),
                        })
                      }
                    >
                      <option value="0">Categoria</option>
                      {categories.map((category) => (
                        <option value={category.id} key={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Margem alvo"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={String(item.targetMargin)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          categoryOverrides: replace(
                            form.categoryOverrides,
                            index,
                            { ...item, targetMargin: event.target.value },
                          ),
                        })
                      }
                    />
                    <input
                      aria-label="Margem mínima"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={String(item.minimumMargin)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          categoryOverrides: replace(
                            form.categoryOverrides,
                            index,
                            { ...item, minimumMargin: event.target.value },
                          ),
                        })
                      }
                    />
                    <button
                      onClick={() =>
                        setForm({
                          ...form,
                          categoryOverrides: form.categoryOverrides.filter(
                            (_, position) => position !== index,
                          ),
                        })
                      }
                    >
                      Remover
                    </button>
                  </div>
                ))}
              </ConfigList>
              {error && <InlineError text={error} />}
            </div>
          )}
        </ReportState>
        <footer>
          <button onClick={close}>Cancelar</button>
          <button
            className="primary"
            disabled={busy || !form}
            onClick={() => void save()}
          >
            {busy ? "Salvando…" : "Salvar configuração"}
          </button>
        </footer>
      </section>
    </div>
  );
}

type SalesData = {
  period: {
    date_min: string;
    date_max: string;
    days: number;
    timezone: string;
    paid_statuses: string[];
    refund_treatment: string;
  };
  summary: Record<"revenue" | "orders" | "average_ticket" | "items", number>;
  previous: Record<string, number>;
  comparison: Record<
    "revenue" | "orders" | "average_ticket" | "items",
    number | null
  >;
  top_sellers: Array<{
    product_id: number | null;
    product: string;
    quantity: number;
    revenue: number;
  }>;
  timeline: Array<{
    date: string;
    revenue: number;
    orders: number;
    items: number;
  }>;
  totals: { orders: number; products: number; customers: number };
};
function SalesReport() {
  const { params, update } = useUrlFilters(),
    [exportError, setExportError] = useState("");
  const report = useReport<SalesData>(`/api/erp/reports/sales?${params}`);
  const exportRows = async (mode: string) => {
    try {
      setExportError("");
      const query = new URLSearchParams(params);
      query.set("export", mode);
      await download(
        `/api/erp/reports/sales?${query}`,
        `relatorio-vendas-${mode}.csv`,
        "sales",
      );
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Falha na exportação.",
      );
    }
  };
  return (
    <>
      <ReportHeading
        eyebrow="DESEMPENHO COMERCIAL"
        title="Relatório de vendas"
        description="Faturamento líquido, pedidos e produtos vendidos no período."
      />
      <section className="report-toolbar period-toolbar">
        <label>
          Período
          <select
            value={params.get("period") || "30d"}
            onChange={(event) =>
              update({
                period: event.target.value,
                date_min: null,
                date_max: null,
              })
            }
          >
            <option value="7d">7 dias</option>
            <option value="30d">30 dias</option>
            <option value="90d">90 dias</option>
          </select>
        </label>
        <label>
          De
          <input
            type="date"
            value={params.get("date_min") || ""}
            onChange={(event) =>
              update({ date_min: event.target.value, period: null })
            }
          />
        </label>
        <label>
          Até
          <input
            type="date"
            value={params.get("date_max") || ""}
            onChange={(event) =>
              update({ date_max: event.target.value, period: null })
            }
          />
        </label>
        <span className="toolbar-spacer" />
        <button onClick={() => void exportRows("summary")}>CSV resumo</button>
        <button onClick={() => void exportRows("top")}>CSV produtos</button>
      </section>
      {exportError && <InlineError text={exportError} />}
      <ReportState report={report}>
        {report.data && (
          <>
            <section className="report-kpis">
              <Kpi
                label="Faturamento líquido"
                value={money.format(report.data.summary.revenue)}
                detail={<Variation value={report.data.comparison.revenue} />}
              />
              <Kpi
                label="Pedidos"
                value={number.format(report.data.summary.orders)}
                detail={<Variation value={report.data.comparison.orders} />}
              />
              <Kpi
                label="Ticket médio"
                value={money.format(report.data.summary.average_ticket)}
                detail={
                  <Variation value={report.data.comparison.average_ticket} />
                }
              />
              <Kpi
                label="Itens vendidos"
                value={number.format(report.data.summary.items)}
                detail={<Variation value={report.data.comparison.items} />}
              />
            </section>
            <section className="sales-grid">
              <article className="report-panel">
                <header>
                  <div>
                    <h2>Evolução diária</h2>
                    <small>
                      {report.data.period.date_min} a{" "}
                      {report.data.period.date_max} ·{" "}
                      {report.data.period.timezone}
                    </small>
                  </div>
                </header>
                <Timeline rows={report.data.timeline} />
              </article>
              <article className="report-panel">
                <header>
                  <div>
                    <h2>Mais vendidos</h2>
                    <small>Mesmo filtro dos indicadores</small>
                  </div>
                </header>
                <ol className="top-sellers">
                  {report.data.top_sellers.map((item, index) => (
                    <li key={`${item.product_id}-${item.product}`}>
                      <b>#{index + 1}</b>
                      <span>
                        <strong>{item.product}</strong>
                        <small>{money.format(item.revenue)} de receita</small>
                      </span>
                      <em>{number.format(item.quantity)}</em>
                    </li>
                  ))}
                  {!report.data.top_sellers.length && <ReportEmpty />}
                </ol>
              </article>
            </section>
            <p className="report-note">
              <strong>Critério:</strong> {report.data.period.refund_treatment}{" "}
              Status contabilizados:{" "}
              {report.data.period.paid_statuses.join(", ")}.
            </p>
          </>
        )}
      </ReportState>
    </>
  );
}

type ProductsData = {
  items: Array<{
    id: number;
    name: string;
    sku: string;
    categories: Array<{ id: number; name: string }>;
    price: number;
    stock_status: string;
    manage_stock: boolean;
    stock_quantity: number | null;
    weight: number | null;
    weight_unit: string;
    dimensions: {
      length: number | null;
      width: number | null;
      height: number | null;
      unit: string;
    } | null;
  }>;
  categories: Array<{ id: number; name: string }>;
  total: number;
  page: number;
  per_page: number;
  pages: number;
};
function ProductsReport() {
  const { params, update } = useUrlFilters(),
    [exportError, setExportError] = useState("");
  const report = useReport<ProductsData>(`/api/erp/reports/products?${params}`);
  const exportRows = async (mode: string) => {
    try {
      const query = new URLSearchParams(params);
      query.set("export", mode);
      await download(
        `/api/erp/reports/products?${query}`,
        "relatorio-produtos.csv",
        "products",
      );
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Falha na exportação.",
      );
    }
  };
  return (
    <>
      <ReportHeading
        eyebrow="CATÁLOGO OPERACIONAL"
        title="Relatório de produtos"
        description="Filtre o catálogo atual e exporte os dados operacionais."
      />
      <section className="report-toolbar filters-wrap">
        <label className="search-field">
          Busca
          <input
            value={params.get("search") || ""}
            onChange={(event) => update({ search: event.target.value })}
            placeholder="Nome, SKU ou GTIN"
          />
        </label>
        <label>
          Categoria
          <select
            value={params.get("category") || ""}
            onChange={(event) => update({ category: event.target.value })}
          >
            <option value="">Todas</option>
            {report.data?.categories.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Estoque
          <select
            value={params.get("stock_status") || ""}
            onChange={(event) => update({ stock_status: event.target.value })}
          >
            <option value="">Todos</option>
            <option value="instock">Em estoque</option>
            <option value="outofstock">Esgotado</option>
            <option value="onbackorder">Sob encomenda</option>
          </select>
        </label>
        <label>
          Preço mín.
          <input
            type="number"
            min="0"
            step="0.01"
            value={params.get("min_price") || ""}
            onChange={(event) => update({ min_price: event.target.value })}
          />
        </label>
        <label>
          Preço máx.
          <input
            type="number"
            min="0"
            step="0.01"
            value={params.get("max_price") || ""}
            onChange={(event) => update({ max_price: event.target.value })}
          />
        </label>
      </section>
      <ReportState report={report}>
        {report.data && (
          <>
            <section className="report-actions">
              <span>{report.data.total} produto(s) no recorte</span>
              <button onClick={() => void exportRows("page")}>
                CSV da página
              </button>
              <button onClick={() => void exportRows("all")}>
                CSV completo
              </button>
            </section>
            {exportError && <InlineError text={exportError} />}
            <section className="report-table">
              <table>
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th>SKU</th>
                    <th>Categoria</th>
                    <th className="numeric">Preço</th>
                    <th>Estoque</th>
                    <th className="numeric">Quantidade</th>
                    <th>Peso</th>
                    <th>Dimensões</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link
                          href={`/erp/produtos-servicos?produto=${item.id}`}
                        >
                          <strong>{item.name}</strong>
                        </Link>
                      </td>
                      <td>{item.sku || "—"}</td>
                      <td>
                        {item.categories
                          .map((category) => category.name)
                          .join(", ") || "—"}
                      </td>
                      <td className="numeric">{money.format(item.price)}</td>
                      <td>
                        <StockBadge value={item.stock_status} />
                      </td>
                      <td className="numeric">
                        {item.manage_stock
                          ? number.format(item.stock_quantity || 0)
                          : "—"}
                      </td>
                      <td>
                        {item.weight === null
                          ? "—"
                          : `${number.format(item.weight)} ${item.weight_unit}`}
                      </td>
                      <td>
                        {item.dimensions
                          ? `${item.dimensions.length ?? "—"}×${item.dimensions.width ?? "—"}×${item.dimensions.height ?? "—"} ${item.dimensions.unit}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!report.data.items.length && (
                <ReportEmpty
                  filtered={params.size > 0}
                  clear={() =>
                    update(
                      Object.fromEntries(
                        [...params.keys()].map((key) => [key, null]),
                      ),
                    )
                  }
                />
              )}
            </section>
            <Pagination
              page={report.data.page}
              pages={report.data.pages}
              total={report.data.total}
              perPage={report.data.per_page}
              update={update}
            />
          </>
        )}
      </ReportState>
    </>
  );
}

type FiscalItem = {
  id: number;
  name: string;
  sku: string;
  ncm: string | null;
  cest: string | null;
  cestNotApplicable: boolean;
  origin: string | null;
  origin_label: string;
  gtin: string | null;
  completeness: number;
  complete: boolean;
  missing_fields: string[];
  field_validity: Record<string, boolean>;
};
type FiscalData = {
  items: FiscalItem[];
  summary: { complete: number; incomplete: number; total: number };
  required_fields: string[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
};
function FiscalReport() {
  const { params, update } = useUrlFilters(),
    [selected, setSelected] = useState<number[]>([]),
    [exportError, setExportError] = useState(""),
    [bulk, setBulk] = useState({ field: "ncm", value: "" });
  const report = useReport<FiscalData>(`/api/erp/reports/fiscal?${params}`);
  useEffect(() => setSelected([]), [params]);
  const exportRows = async (mode: string) => {
    try {
      const query = new URLSearchParams(params);
      query.set("export", mode);
      await download(
        `/api/erp/reports/fiscal?${query}`,
        "relatorio-fiscal.csv",
        "fiscal",
      );
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Falha na exportação.",
      );
    }
  };
  const applyBulk = async () => {
    if (!selected.length) return;
    try {
      setExportError("");
      const response = await fetch("/api/erp/reports/fiscal", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: selected,
          field: bulk.field,
          value: bulk.field === "cestNotApplicable" ? true : bulk.value,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setSelected([]);
      report.retry();
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Falha na edição em lote.",
      );
    }
  };
  return (
    <>
      <ReportHeading
        eyebrow="PRONTIDÃO FISCAL"
        title="Relatório fiscal"
        description="Identifique e corrija produtos que ainda não estão prontos para emissão."
      />
      <ReportState report={report}>
        {report.data && (
          <>
            <section className="fiscal-summary">
              <button
                className={
                  !params.get("incomplete") ? "active complete" : "complete"
                }
                onClick={() => update({ incomplete: null })}
              >
                <small>Completos</small>
                <strong>{report.data.summary.complete}</strong>
              </button>
              <button
                className={
                  params.get("incomplete") ? "active incomplete" : "incomplete"
                }
                onClick={() =>
                  update({
                    incomplete: params.get("incomplete") ? null : "true",
                  })
                }
              >
                <small>Incompletos</small>
                <strong>{report.data.summary.incomplete}</strong>
              </button>
            </section>
            <section className="report-toolbar filters-wrap">
              <label className="search-field">
                Busca
                <input
                  value={params.get("search") || ""}
                  onChange={(event) => update({ search: event.target.value })}
                  placeholder="Produto, SKU, NCM ou GTIN"
                />
              </label>
              <label>
                Campo faltante
                <select
                  value={params.get("missing_field") || ""}
                  onChange={(event) =>
                    update({ missing_field: event.target.value })
                  }
                >
                  <option value="">Todos</option>
                  {report.data.required_fields.map((field) => (
                    <option value={field} key={field}>
                      {field.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <span className="toolbar-spacer" />
              <button onClick={() => void exportRows("page")}>
                CSV da página
              </button>
              <button onClick={() => void exportRows("all")}>
                CSV completo
              </button>
            </section>
            {selected.length > 0 && (
              <section className="bulk-bar">
                <strong>{selected.length} selecionado(s)</strong>
                <select
                  value={bulk.field}
                  onChange={(event) =>
                    setBulk({ field: event.target.value, value: "" })
                  }
                >
                  <option value="ncm">NCM</option>
                  <option value="cest">CEST</option>
                  <option value="origin">Origem</option>
                  <option value="gtin">GTIN</option>
                  <option value="cestNotApplicable">CEST não aplicável</option>
                </select>
                {bulk.field !== "cestNotApplicable" && (
                  <input
                    value={bulk.value}
                    onChange={(event) =>
                      setBulk({
                        ...bulk,
                        value: event.target.value.replace(/\D/g, ""),
                      })
                    }
                    placeholder="Novo valor"
                  />
                )}
                <button className="primary" onClick={() => void applyBulk()}>
                  Aplicar em lote
                </button>
                <button onClick={() => setSelected([])}>Limpar</button>
              </section>
            )}
            {exportError && <InlineError text={exportError} />}
            <section className="report-table">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        aria-label="Selecionar página"
                        type="checkbox"
                        checked={
                          report.data.items.length > 0 &&
                          selected.length === report.data.items.length
                        }
                        onChange={() =>
                          setSelected(
                            selected.length === report.data!.items.length
                              ? []
                              : report.data!.items.map((item) => item.id),
                          )
                        }
                      />
                    </th>
                    <th>Produto</th>
                    <th>SKU</th>
                    <th>NCM</th>
                    <th>CEST</th>
                    <th>Origem</th>
                    <th>GTIN</th>
                    <th>Completude</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <input
                          aria-label={`Selecionar ${item.name}`}
                          type="checkbox"
                          checked={selected.includes(item.id)}
                          onChange={() =>
                            setSelected(
                              selected.includes(item.id)
                                ? selected.filter((id) => id !== item.id)
                                : [...selected, item.id],
                            )
                          }
                        />
                      </td>
                      <td>
                        <Link
                          href={`/erp/produtos-servicos?produto=${item.id}`}
                        >
                          <strong>{item.name}</strong>
                        </Link>
                        <small>
                          {item.missing_fields.length
                            ? `Falta: ${item.missing_fields.join(", ").toUpperCase()}`
                            : "Pronto para emissão"}
                        </small>
                      </td>
                      <td>{item.sku || "—"}</td>
                      <td className={!item.field_validity.ncm ? "invalid" : ""}>
                        {item.ncm || "—"}
                      </td>
                      <td
                        className={!item.field_validity.cest ? "invalid" : ""}
                      >
                        {item.cestNotApplicable
                          ? "Não aplicável"
                          : item.cest || "—"}
                      </td>
                      <td
                        className={!item.field_validity.origin ? "invalid" : ""}
                      >
                        {item.origin
                          ? `${item.origin} · ${item.origin_label}`
                          : "—"}
                      </td>
                      <td
                        className={!item.field_validity.gtin ? "invalid" : ""}
                      >
                        {item.gtin || "—"}
                      </td>
                      <td>
                        <div
                          className={`completion ${item.complete ? "complete" : ""}`}
                        >
                          <span>
                            <i style={{ width: `${item.completeness}%` }} />
                          </span>
                          <b>{item.completeness}%</b>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!report.data.items.length && (
                <ReportEmpty filtered={params.size > 0} />
              )}
            </section>
            <Pagination
              page={report.data.page}
              pages={report.data.pages}
              total={report.data.total}
              perPage={report.data.per_page}
              update={update}
            />
          </>
        )}
      </ReportState>
    </>
  );
}

function ReportHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="report-heading">
      <div>
        <small>{eyebrow}</small>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children && <div>{children}</div>}
    </header>
  );
}
function ReportState<T>({
  report,
  children,
}: {
  report: {
    data: T | null;
    error: string;
    loading: boolean;
    retry: () => void;
  };
  children: React.ReactNode;
}) {
  if (report.loading && !report.data)
    return (
      <div className="report-skeleton">
        <i />
        <i />
        <i />
        <i />
        <span />
        <span />
        <span />
        <span />
      </div>
    );
  if (report.error)
    return <ReportAlert text={report.error} retry={report.retry} />;
  return <>{children}</>;
}
function Kpi({
  label,
  value,
  detail,
  positive,
}: {
  label: string;
  value: string;
  detail: React.ReactNode;
  positive?: boolean;
}) {
  return (
    <article>
      <small>{label}</small>
      <strong className={positive ? "positive" : ""}>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}
function Variation({ value }: { value: number | null }) {
  return value === null ? (
    <span>Sem base de comparação</span>
  ) : (
    <span className={value > 0 ? "positive" : value < 0 ? "negative" : ""}>
      {value > 0 ? "+" : ""}
      {number.format(value)}% vs. período anterior
    </span>
  );
}
function Pagination({
  page,
  pages,
  total,
  perPage,
  update,
}: {
  page: number;
  pages: number;
  total: number;
  perPage: number;
  update: (
    changes: Record<string, string | number | null>,
    reset?: boolean,
  ) => void;
}) {
  const from = total ? (page - 1) * perPage + 1 : 0,
    to = Math.min(page * perPage, total);
  return (
    <footer className="report-pagination">
      <span>
        Mostrando {from}–{to} de {total}
      </span>
      <div>
        <button
          disabled={page <= 1}
          onClick={() => update({ page: page - 1 }, false)}
        >
          Anterior
        </button>
        {page > 2 && (
          <button onClick={() => update({ page: 1 }, false)}>1</button>
        )}
        {page > 3 && <i>…</i>}
        {[page - 1, page, page + 1]
          .filter((value) => value >= 1 && value <= pages)
          .map((value) => (
            <button
              className={value === page ? "active" : ""}
              onClick={() => update({ page: value }, false)}
              key={value}
            >
              {value}
            </button>
          ))}
        {page < pages - 2 && <i>…</i>}
        {page < pages - 1 && (
          <button onClick={() => update({ page: pages }, false)}>
            {pages}
          </button>
        )}
        <button
          disabled={page >= pages}
          onClick={() => update({ page: page + 1 }, false)}
        >
          Próxima
        </button>
      </div>
    </footer>
  );
}
function ReportEmpty({
  filtered = false,
  clear,
}: {
  filtered?: boolean;
  clear?: () => void;
}) {
  return (
    <div className="report-state">
      <strong>
        {filtered
          ? "Nenhum resultado com esses filtros"
          : "Nenhum produto cadastrado"}
      </strong>
      {filtered && clear && <button onClick={clear}>Limpar filtros</button>}
    </div>
  );
}
function InlineError({ text }: { text: string }) {
  return <ReportAlert text={text} />;
}
function ReportAlert({ text, retry }: { text: string; retry?: () => void }) {
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(true), [text]);
  if (!open) return null;
  return (
    <ErpModal
      close={() => setOpen(false)}
      className="report-alert-layer"
      label="Alerta do relatório"
    >
      <section className="report-alert-modal">
        <header>
          <div>
            <small>ALERTA DO RELATÓRIO</small>
            <h2>Não foi possível concluir</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Fechar"
          >
            ×
          </button>
        </header>
        <p>{text}</p>
        <footer>
          <button type="button" onClick={() => setOpen(false)}>
            Fechar
          </button>
          {retry && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setOpen(false);
                retry();
              }}
            >
              Tentar novamente
            </button>
          )}
        </footer>
      </section>
    </ErpModal>
  );
}
function HealthBadge({ value }: { value: string }) {
  return <span className={`health-badge ${value}`}>{healthLabel(value)}</span>;
}
function StockBadge({ value }: { value: string }) {
  return (
    <span className={`stock-badge ${value}`}>
      {(
        {
          instock: "Em estoque",
          outofstock: "Esgotado",
          onbackorder: "Sob encomenda",
        } as Record<string, string>
      )[value] || value}
    </span>
  );
}
function healthLabel(value: string) {
  return (
    (
      {
        healthy: "Saudável",
        warning: "Atenção",
        critical: "Crítico",
      } as Record<string, string>
    )[value] || value
  );
}
function sourceLabel(value: string) {
  return (
    (
      { product: "Produto", category: "Categoria", global: "Global" } as Record<
        string,
        string
      >
    )[value] || value
  );
}
function replace<T>(rows: T[], index: number, value: T) {
  return rows.map((row, position) => (position === index ? value : row));
}
function ConfigList({
  title,
  note,
  add,
  children,
}: {
  title: string;
  note?: string;
  add: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="config-list">
      <header>
        <div>
          <strong>{title}</strong>
          {note && <small>{note}</small>}
        </div>
        <button onClick={add}>Adicionar</button>
      </header>
      {children}
    </section>
  );
}
function Timeline({ rows }: { rows: SalesData["timeline"] }) {
  const max = Math.max(1, ...rows.map((item) => item.revenue));
  return (
    <div className="timeline-chart" aria-label="Faturamento diário">
      {rows.map((item) => (
        <div
          key={item.date}
          title={`${item.date}: ${money.format(item.revenue)}`}
        >
          <i
            style={{
              height: `${Math.max(item.revenue ? 5 : 1, (item.revenue / max) * 100)}%`,
            }}
          />
          <small>
            {rows.length <= 31 || item.date.endsWith("-01")
              ? item.date.slice(5).replace("-", "/")
              : ""}
          </small>
        </div>
      ))}
    </div>
  );
}
