"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ErpIcon } from "@/components/erp/erp-icon";
import { ErpModal } from "@/components/erp/modal-portal";
import {
  REPORT_DEFINITIONS,
  reportHref,
  type ReportKey,
} from "@/lib/erp/report-workspace";
import styles from "./reports-workspace-hub.module.css";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const dateTime = tenantDateTimeFormatter({ dateStyle: "short",
  timeStyle: "short",
});
const frequencyLabels: Record<string, string> = {
  daily: "Diária",
  weekly: "Semanal",
  monthly: "Mensal",
};
const reportLabels = Object.fromEntries(
  REPORT_DEFINITIONS.map((item) => [item.key, item.name]),
) as Record<string, string>;

type SavedView = {
  id: number;
  name: string;
  description: string | null;
  reportKey: ReportKey;
  filters: Record<string, string>;
  visibility: string;
  ownerUserId: string;
  ownerName: string;
  lastOpenedAt: string | null;
  updatedAt: string;
  favorite: boolean;
  canEdit: boolean;
  _count: { schedules: number };
};
type Schedule = {
  id: number;
  savedReportViewId: number | null;
  name: string;
  reportKey: ReportKey;
  filters: Record<string, string>;
  frequency: string;
  weekday: number | null;
  dayOfMonth: number | null;
  time: string;
  timezone: string;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  createdByName: string;
};
type ExportEvent = {
  id: number;
  reportKey: ReportKey;
  reportName: string;
  format: string;
  scope: string;
  status: string;
  fileName: string | null;
  requestedByName: string;
  createdAt: string;
};
type WorkspaceData = {
  catalog: typeof REPORT_DEFINITIONS;
  views: SavedView[];
  schedules: Schedule[];
  exports: ExportEvent[];
  summary: {
    savedViews: number;
    favorites: number;
    activeSchedules: number;
    exports30d: number;
  };
  capabilities: { canWrite: boolean };
  timezone: string;
  generatedAt: string;
};
type SalesSummary = {
  summary: {
    revenue: number;
    orders: number;
    average_ticket: number;
    items: number;
  };
  comparison: { revenue: number | null };
};
type MarginSummary = {
  summary: {
    weighted_margin_percent: number;
    health_counts: { critical: number; warning: number; healthy: number };
    products_total: number;
  };
};
type FiscalSummary = {
  summary: { complete: number; incomplete: number; total: number };
};
type ProductSummary = { total: number };
type Indicators = {
  sales: SalesSummary | null;
  margins: MarginSummary | null;
  fiscal: FiscalSummary | null;
  products: ProductSummary | null;
};

export function ReportsWorkspaceHub() {
  const [period, setPeriod] = useState("30d");
  const workspace = useWorkspace(period);
  const [viewDialog, setViewDialog] = useState(false),
    [scheduleView, setScheduleView] = useState<SavedView | null>(null);
  const [message, setMessage] = useState(""),
    [actionBusy, setActionBusy] = useState(false);
  const refresh = workspace.reload;
  async function command(payload: Record<string, unknown>, success: string) {
    setMessage("");
    setActionBusy(true);
    try {
      const response = await fetch("/api/erp/reports/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Não foi possível concluir.");
      setMessage(success);
      refresh();
    } catch (reason) {
      setMessage(
        reason instanceof Error ? reason.message : "Não foi possível concluir.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  if (workspace.loading && !workspace.data) return <HubLoading />;
  if (workspace.error || !workspace.data)
    return (
      <HubFatal
        message={workspace.error || "Não foi possível carregar a central."}
        retry={refresh}
      />
    );
  const data = workspace.data;
  return (
    <section className={styles.hub}>
      <header className={styles.hero}>
        <div>
          <span>CENTRAL DE INTELIGÊNCIA</span>
          <h1>Decisões melhores começam com uma leitura confiável.</h1>
          <p>
            Indicadores executivos, análises operacionais e rotinas recorrentes
            reunidos em um só lugar.
          </p>
        </div>
        <div className={styles.heroActions}>
          <label>
            Janela executiva
            <select
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            >
              <option value="7d">Últimos 7 dias</option>
              <option value="30d">Últimos 30 dias</option>
              <option value="90d">Últimos 90 dias</option>
            </select>
          </label>
          <button onClick={() => setViewDialog(true)}>+ Salvar visão</button>
        </div>
      </header>

      <ExecutiveCards indicators={workspace.indicators} period={period} />
      <Insights indicators={workspace.indicators} data={data} />

      <section className={styles.section}>
        <header>
          <div>
            <span>CATÁLOGO ANALÍTICO</span>
            <h2>Explore por pergunta de negócio</h2>
            <p>
              Cada relatório mantém filtros na URL, exportação segura e dados da
              filial ativa.
            </p>
          </div>
          <b>{data.catalog.length} análises</b>
        </header>
        <div className={styles.catalog}>
          {data.catalog.map((item, index) => (
            <Link
              className={`${styles.reportCard} ${styles[item.accent]}`}
              href={item.href}
              key={item.key}
            >
              <i>
                <ErpIcon
                  name={
                    item.key === "sales"
                      ? "sales"
                      : item.key === "fiscal"
                        ? "fiscal"
                        : item.key === "products"
                          ? "products"
                          : "finance"
                  }
                />
              </i>
              <span>
                <small>
                  {String(index + 1).padStart(2, "0")} · {item.area}
                </small>
                <strong>{item.name}</strong>
                <p>{item.description}</p>
                <em>
                  Abrir análise <b>→</b>
                </em>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <div className={styles.managementGrid}>
        <section className={styles.section}>
          <header>
            <div>
              <span>BIBLIOTECA</span>
              <h2>Visões salvas</h2>
              <p>
                Filtros reutilizáveis, pessoais ou compartilhados com a equipe.
              </p>
            </div>
            <b>{data.summary.savedViews}</b>
          </header>
          <div className={styles.viewList}>
            {data.views.map((view) => (
              <SavedViewCard
                key={view.id}
                view={view}
                busy={actionBusy}
                openSchedule={
                  data.capabilities.canWrite
                    ? () => setScheduleView(view)
                    : undefined
                }
                command={command}
              />
            ))}
            {!data.views.length && (
              <Empty
                title="Nenhuma visão salva"
                text="Salve uma combinação de filtros para voltar à mesma análise com um clique."
                action="Criar primeira visão"
                onClick={() => setViewDialog(true)}
              />
            )}
          </div>
        </section>
        <section className={styles.section} id="rotinas">
          <header>
            <div>
              <span>GOVERNANÇA</span>
              <h2>Rotinas recorrentes</h2>
              <p>Cadências de revisão com execução e histórico rastreáveis.</p>
            </div>
            <b>{data.summary.activeSchedules} ativas</b>
          </header>
          <div className={styles.scheduleList}>
            {data.schedules.slice(0, 8).map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                busy={actionBusy}
                command={command}
                notify={setMessage}
              />
            ))}
            {!data.schedules.length && (
              <Empty
                title="Nenhuma rotina agendada"
                text="Agende uma visão salva para criar uma cadência de acompanhamento."
              />
            )}
          </div>
        </section>
      </div>

      <section className={styles.section}>
        <header>
          <div>
            <span>RASTREABILIDADE</span>
            <h2>Exportações recentes</h2>
            <p>
              Registro de arquivos gerados manualmente ou pelas rotinas de
              análise.
            </p>
          </div>
          <b>{data.summary.exports30d} em 30 dias</b>
        </header>
        <div className={styles.exportTable}>
          <div className={styles.tableHeader}>
            <span>Relatório</span>
            <span>Origem</span>
            <span>Responsável</span>
            <span>Gerado em</span>
            <span>Status</span>
          </div>
          {data.exports.slice(0, 10).map((item) => (
            <div key={item.id}>
              <span>
                <strong>{item.reportName}</strong>
                <small>
                  {item.fileName || `${item.reportKey}.${item.format}`}
                </small>
              </span>
              <span>{item.scope === "scheduled" ? "Rotina" : "Manual"}</span>
              <span>{item.requestedByName}</span>
              <time>{dateTime.format(new Date(item.createdAt))}</time>
              <Status value={item.status} />
            </div>
          ))}
          {!data.exports.length && (
            <Empty
              title="Sem exportações registradas"
              text="Os próximos arquivos CSV gerados aparecerão aqui."
            />
          )}
        </div>
      </section>
      {message && (
        <div className={styles.toast} role="status">
          ✓ {message}
          <button onClick={() => setMessage("")} aria-label="Fechar aviso">
            ×
          </button>
        </div>
      )}
      {viewDialog && (
        <ViewDialog
          timezone={data.timezone}
          canShare={data.capabilities.canWrite}
          close={() => setViewDialog(false)}
          saved={() => {
            setViewDialog(false);
            setMessage("Visão salva com sucesso.");
            refresh();
          }}
        />
      )}
      {scheduleView && (
        <ScheduleDialog
          view={scheduleView}
          timezone={data.timezone}
          close={() => setScheduleView(null)}
          saved={() => {
            setScheduleView(null);
            setMessage("Rotina agendada com sucesso.");
            refresh();
          }}
        />
      )}
    </section>
  );
}

export function ReportDetailTools({ reportKey }: { reportKey: ReportKey }) {
  const search = useSearchParams();
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("");
  const filters = useMemo(
    () => Object.fromEntries(new URLSearchParams(search.toString())),
    [search],
  );
  return (
    <section className={styles.detailTools}>
      <div>
        <i>
          <ErpIcon name="reports" />
        </i>
        <span>
          <strong>Visão atual</strong>
          <small>
            {Object.keys(filters).length
              ? `${Object.keys(filters).length} filtro(s) aplicado(s)`
              : "Sem filtros adicionais"}
          </small>
        </span>
      </div>
      <button onClick={() => setOpen(true)}>☆ Salvar esta visão</button>
      {message && <em role="status">✓ {message}</em>}
      {open && (
        <ViewDialog
          reportKey={reportKey}
          filters={filters}
          close={() => setOpen(false)}
          saved={() => {
            setOpen(false);
            setMessage("Visão salva");
          }}
        />
      )}
    </section>
  );
}

function ExecutiveCards({
  indicators,
  period,
}: {
  indicators: Indicators;
  period: string;
}) {
  const sales = indicators.sales,
    margins = indicators.margins,
    fiscal = indicators.fiscal,
    products = indicators.products;
  const fiscalRate = fiscal?.summary.total
    ? (fiscal.summary.complete / fiscal.summary.total) * 100
    : 0;
  return (
    <section className={styles.kpis} aria-label="Indicadores executivos">
      <article>
        <header>
          <span>Receita líquida</span>
          <i className={styles.greenDot} />
        </header>
        <strong>{sales ? money.format(sales.summary.revenue) : "—"}</strong>
        <footer>
          <Variation value={sales?.comparison.revenue ?? null} />
          <small>{period.replace("d", " dias")}</small>
        </footer>
      </article>
      <article>
        <header>
          <span>Margem ponderada</span>
          <i className={styles.blueDot} />
        </header>
        <strong>
          {margins
            ? `${number.format(margins.summary.weighted_margin_percent)}%`
            : "—"}
        </strong>
        <footer>
          <em>
            {margins
              ? `${margins.summary.health_counts.critical} itens críticos`
              : "Carregando base"}
          </em>
          <small>catálogo</small>
        </footer>
      </article>
      <article>
        <header>
          <span>Prontidão fiscal</span>
          <i className={styles.purpleDot} />
        </header>
        <strong>{fiscal ? `${number.format(fiscalRate)}%` : "—"}</strong>
        <footer>
          <em>
            {fiscal
              ? `${fiscal.summary.incomplete} pendência(s)`
              : "Carregando base"}
          </em>
          <small>conformidade</small>
        </footer>
      </article>
      <article>
        <header>
          <span>Produtos ativos</span>
          <i className={styles.amberDot} />
        </header>
        <strong>{products ? number.format(products.total) : "—"}</strong>
        <footer>
          <em>
            {sales
              ? `${number.format(sales.summary.items)} itens vendidos`
              : "Sem recorte"}
          </em>
          <small>{period.replace("d", " dias")}</small>
        </footer>
      </article>
    </section>
  );
}

function Insights({
  indicators,
  data,
}: {
  indicators: Indicators;
  data: WorkspaceData;
}) {
  const critical = indicators.margins?.summary.health_counts.critical || 0,
    incomplete = indicators.fiscal?.summary.incomplete || 0,
    change = indicators.sales?.comparison.revenue;
  const items = [
    critical
      ? {
          tone: "danger",
          title: `${critical} produto(s) abaixo da margem mínima`,
          text: "Revise custo, preço e regras por categoria.",
          href: "/erp/relatorios/margens?health=critical",
        }
      : {
          tone: "success",
          title: "Margens sem itens críticos",
          text: "O catálogo está dentro dos limites configurados.",
          href: "/erp/relatorios/margens",
        },
    incomplete
      ? {
          tone: "warning",
          title: `${incomplete} cadastro(s) com pendência fiscal`,
          text: "Corrija os campos antes da próxima emissão.",
          href: "/erp/relatorios/fiscal?incomplete=true",
        }
      : {
          tone: "success",
          title: "Catálogo fiscalmente pronto",
          text: "Nenhuma pendência no recorte atual.",
          href: "/erp/relatorios/fiscal",
        },
    {
      tone: typeof change === "number" && change < 0 ? "danger" : "info",
      title:
        change === null || change === undefined
          ? "Comparação comercial sem base"
          : `Receita ${change >= 0 ? "cresceu" : "recuou"} ${number.format(Math.abs(change))}%`,
      text: "Comparação com o período imediatamente anterior.",
      href: "/erp/relatorios/vendas",
    },
    {
      tone: data.summary.activeSchedules ? "info" : "warning",
      title: data.summary.activeSchedules
        ? `${data.summary.activeSchedules} rotina(s) de análise ativa(s)`
        : "Nenhuma rotina de análise ativa",
      text: data.summary.activeSchedules
        ? "A governança recorrente está configurada."
        : "Agende uma visão para não depender de acompanhamento manual.",
      href: "#rotinas",
    },
  ];
  return (
    <section className={styles.insights}>
      <header>
        <span>LEITURA ASSISTIDA</span>
        <h2>Pontos que pedem atenção</h2>
      </header>
      <div>
        {items.map((item) => (
          <Link className={styles[item.tone]} href={item.href} key={item.title}>
            <i>
              {item.tone === "success"
                ? "✓"
                : item.tone === "danger"
                  ? "!"
                  : "↗"}
            </i>
            <span>
              <strong>{item.title}</strong>
              <small>{item.text}</small>
            </span>
            <b>→</b>
          </Link>
        ))}
      </div>
    </section>
  );
}

function SavedViewCard({
  view,
  busy,
  openSchedule,
  command,
}: {
  view: SavedView;
  busy: boolean;
  openSchedule?: () => void;
  command: (payload: Record<string, unknown>, success: string) => Promise<void>;
}) {
  const router = useRouter();
  async function open() {
    void command({ action: "view.open", viewId: view.id }, "Visão aberta.");
    router.push(reportHref(view.reportKey, view.filters));
  }
  return (
    <article className={styles.savedView}>
      <header>
        <button
          className={styles.star}
          disabled={busy}
          aria-label={
            view.favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"
          }
          onClick={() =>
            void command(
              {
                action: "view.favorite",
                viewId: view.id,
                favorite: !view.favorite,
              },
              view.favorite
                ? "Removida dos favoritos."
                : "Adicionada aos favoritos.",
            )
          }
        >
          {view.favorite ? "★" : "☆"}
        </button>
        <span>
          <small>
            {reportLabels[view.reportKey]} ·{" "}
            {view.visibility === "team" ? "Equipe" : "Pessoal"}
          </small>
          <strong>{view.name}</strong>
        </span>
        <details>
          <summary aria-label="Ações da visão">•••</summary>
          <div>
            {openSchedule && (
              <button onClick={openSchedule}>Agendar rotina</button>
            )}
            {view.canEdit && (
              <button
                className={styles.dangerText}
                disabled={busy}
                onClick={() =>
                  void command(
                    { action: "view.delete", viewId: view.id },
                    "Visão excluída.",
                  )
                }
              >
                Excluir
              </button>
            )}
          </div>
        </details>
      </header>
      <p>{view.description || "Filtros prontos para reutilização."}</p>
      <footer>
        <span>
          {Object.keys(view.filters).length} filtro(s) · {view._count.schedules}{" "}
          rotina(s)
        </span>
        <button onClick={() => void open()}>Abrir visão →</button>
      </footer>
    </article>
  );
}

function ScheduleRow({
  schedule,
  busy,
  command,
  notify,
}: {
  schedule: Schedule;
  busy: boolean;
  command: (payload: Record<string, unknown>, success: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  async function execute() {
    try {
      const result = await downloadReport(schedule.reportKey, schedule.filters);
      await command(
        {
          action: "schedule.complete",
          scheduleId: schedule.id,
          fileName: result.fileName,
        },
        "Relatório gerado e rotina registrada.",
      );
    } catch (reason) {
      notify(
        reason instanceof Error
          ? reason.message
          : "Não foi possível gerar o relatório.",
      );
    }
  }
  return (
    <article
      className={`${styles.schedule} ${schedule.status === "paused" ? styles.paused : ""}`}
    >
      <i>{schedule.status === "active" ? "◷" : "Ⅱ"}</i>
      <span>
        <strong>{schedule.name}</strong>
        <small>
          {frequencyLabels[schedule.frequency]} · {schedule.time} ·{" "}
          {schedule.nextRunAt
            ? `próxima ${dateTime.format(new Date(schedule.nextRunAt))}`
            : "pausada"}
        </small>
      </span>
      <Status value={schedule.status} />
      <details>
        <summary aria-label="Ações da rotina">•••</summary>
        <div>
          <button disabled={busy} onClick={() => void execute()}>
            Gerar agora
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void command(
                {
                  action: "schedule.toggle",
                  scheduleId: schedule.id,
                  active: schedule.status !== "active",
                },
                schedule.status === "active"
                  ? "Rotina pausada."
                  : "Rotina reativada.",
              )
            }
          >
            {schedule.status === "active" ? "Pausar" : "Reativar"}
          </button>
          <button
            className={styles.dangerText}
            disabled={busy}
            onClick={() =>
              void command(
                { action: "schedule.delete", scheduleId: schedule.id },
                "Rotina excluída.",
              )
            }
          >
            Excluir
          </button>
        </div>
      </details>
    </article>
  );
}

function ViewDialog({
  reportKey = "sales",
  filters = {},
  canShare = true,
  close,
  saved,
}: {
  reportKey?: ReportKey;
  filters?: Record<string, string>;
  timezone?: string;
  canShare?: boolean;
  close: () => void;
  saved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const raw = Object.fromEntries(new FormData(event.currentTarget)),
        key = raw.reportKey as ReportKey;
      const applied = Object.keys(filters).length
        ? filters
        : defaultFilters(key, raw);
      const response = await fetch("/api/erp/reports/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "view.create",
          name: raw.name,
          description: raw.description,
          reportKey: key,
          visibility: raw.visibility,
          filters: applied,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Não foi possível salvar.");
      saved();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Não foi possível salvar.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ErpModal
      close={close}
      className={styles.modalLayer}
      label="Salvar visão de relatório"
    >
      <form className={styles.dialog} onSubmit={submit}>
        <header>
          <div>
            <span>BIBLIOTECA ANALÍTICA</span>
            <h2>Salvar uma visão</h2>
            <p>Guarde o relatório e os filtros para repetir a mesma leitura.</p>
          </div>
          <button type="button" onClick={close} aria-label="Fechar">
            ×
          </button>
        </header>
        <div className={styles.formGrid}>
          <label>
            Nome da visão
            <input
              name="name"
              required
              minLength={3}
              maxLength={100}
              placeholder="Ex.: Fechamento comercial mensal"
            />
          </label>
          <label>
            Relatório
            <select name="reportKey" defaultValue={reportKey}>
              {REPORT_DEFINITIONS.map((item) => (
                <option value={item.key} key={item.key}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.wide}>
            Descrição
            <input
              name="description"
              maxLength={300}
              placeholder="Qual decisão esta visão apoia?"
            />
          </label>
          {!Object.keys(filters).length && (
            <>
              <label>
                Período de vendas
                <select name="period" defaultValue="30d">
                  <option value="7d">7 dias</option>
                  <option value="30d">30 dias</option>
                  <option value="90d">90 dias</option>
                </select>
              </label>
              <label>
                Recorte de atenção
                <select name="attention" defaultValue="">
                  <option value="">Sem recorte</option>
                  <option value="critical">Itens críticos</option>
                  <option value="incomplete">Cadastros incompletos</option>
                  <option value="outofstock">Produtos sem estoque</option>
                </select>
              </label>
            </>
          )}
          <label className={styles.switch}>
            <input
              name="visibility"
              type="checkbox"
              value="team"
              disabled={!canShare}
            />
            <span>
              Compartilhar com a equipe
              {!canShare ? " (requer permissão de gestão)" : ""}
            </span>
          </label>
          {error && <p className={styles.error}>{error}</p>}
        </div>
        <footer>
          <span>Filtros aceitos são normalizados e validados no servidor.</span>
          <div>
            <button type="button" onClick={close}>
              Cancelar
            </button>
            <button className={styles.primary} disabled={busy}>
              {busy ? "Salvando…" : "Salvar visão"}
            </button>
          </div>
        </footer>
      </form>
    </ErpModal>
  );
}

function ScheduleDialog({
  view,
  timezone,
  close,
  saved,
}: {
  view: SavedView;
  timezone: string;
  close: () => void;
  saved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const raw = Object.fromEntries(new FormData(event.currentTarget));
      const response = await fetch("/api/erp/reports/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "schedule.create",
          viewId: view.id,
          name: raw.name,
          reportKey: view.reportKey,
          filters: view.filters,
          frequency: raw.frequency,
          weekday: raw.weekday,
          dayOfMonth: raw.dayOfMonth,
          time: raw.time,
          timezone,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Não foi possível agendar.");
      saved();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Não foi possível agendar.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ErpModal
      close={close}
      className={styles.modalLayer}
      label={`Agendar ${view.name}`}
    >
      <form
        className={`${styles.dialog} ${styles.smallDialog}`}
        onSubmit={submit}
      >
        <header>
          <div>
            <span>ROTINA DE ANÁLISE</span>
            <h2>Agendar acompanhamento</h2>
            <p>Crie uma cadência para revisar e exportar “{view.name}”.</p>
          </div>
          <button type="button" onClick={close} aria-label="Fechar">
            ×
          </button>
        </header>
        <div className={styles.formGrid}>
          <label className={styles.wide}>
            Nome da rotina
            <input
              name="name"
              required
              minLength={3}
              maxLength={100}
              defaultValue={`Revisar ${view.name}`}
            />
          </label>
          <label>
            Frequência
            <select name="frequency" defaultValue="weekly">
              <option value="daily">Diária</option>
              <option value="weekly">Semanal</option>
              <option value="monthly">Mensal</option>
            </select>
          </label>
          <label>
            Horário
            <input name="time" type="time" required defaultValue="08:00" />
          </label>
          <label>
            Dia da semana
            <select name="weekday" defaultValue="1">
              <option value="1">Segunda-feira</option>
              <option value="2">Terça-feira</option>
              <option value="3">Quarta-feira</option>
              <option value="4">Quinta-feira</option>
              <option value="5">Sexta-feira</option>
              <option value="6">Sábado</option>
              <option value="0">Domingo</option>
            </select>
          </label>
          <label>
            Dia do mês
            <select name="dayOfMonth" defaultValue="1">
              {Array.from({ length: 28 }, (_, index) => index + 1).map(
                (day) => (
                  <option value={day} key={day}>
                    Dia {day}
                  </option>
                ),
              )}
            </select>
          </label>
          <aside className={styles.wide}>
            <strong>Fuso operacional</strong>
            <span>{timezone}</span>
            <p>
              “Gerar agora” baixa o CSV, registra a execução e recalcula a
              próxima revisão.
            </p>
          </aside>
          {error && <p className={styles.error}>{error}</p>}
        </div>
        <footer>
          <span>A rotina pode ser pausada ou excluída a qualquer momento.</span>
          <div>
            <button type="button" onClick={close}>
              Cancelar
            </button>
            <button className={styles.primary} disabled={busy}>
              {busy ? "Agendando…" : "Criar rotina"}
            </button>
          </div>
        </footer>
      </form>
    </ErpModal>
  );
}

function useWorkspace(period: string) {
  const [data, setData] = useState<WorkspaceData | null>(null),
    [indicators, setIndicators] = useState<Indicators>({
      sales: null,
      margins: null,
      fiscal: null,
      products: null,
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const json = async <T,>(url: string) => {
      const response = await fetch(url, { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Falha ao carregar dados.");
      return payload as T;
    };
    Promise.all([
      json<WorkspaceData>("/api/erp/reports/workspace"),
      json<SalesSummary>(`/api/erp/reports/sales?period=${period}`).catch(
        () => null,
      ),
      json<MarginSummary>("/api/erp/reports/margins?per_page=1").catch(
        () => null,
      ),
      json<FiscalSummary>("/api/erp/reports/fiscal?per_page=1").catch(
        () => null,
      ),
      json<ProductSummary>("/api/erp/reports/products?per_page=1").catch(
        () => null,
      ),
    ])
      .then(([workspace, sales, margins, fiscal, products]) => {
        setData(workspace);
        setIndicators({ sales, margins, fiscal, products });
      })
      .catch((reason) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [period, version]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { data, indicators, loading, error, reload };
}

function defaultFilters(
  key: ReportKey,
  raw: Record<string, FormDataEntryValue>,
) {
  const attention = String(raw.attention || "");
  if (key === "sales") return { period: String(raw.period || "30d") };
  if (key === "margins" && attention === "critical")
    return { health: "critical" };
  if (key === "fiscal" && attention === "incomplete")
    return { incomplete: "true" };
  if (key === "products" && attention === "outofstock")
    return { stock_status: "outofstock" };
  return {};
}
function Variation({ value }: { value: number | null }) {
  return value === null ? (
    <em>Sem base comparável</em>
  ) : (
    <em className={value >= 0 ? styles.up : styles.down}>
      {value >= 0 ? "↑" : "↓"} {number.format(Math.abs(value))}% vs. anterior
    </em>
  );
}
function Status({ value }: { value: string }) {
  return (
    <b className={`${styles.status} ${styles[value] || ""}`}>
      {value === "active"
        ? "Ativa"
        : value === "paused"
          ? "Pausada"
          : value === "completed"
            ? "Concluído"
            : value}
    </b>
  );
}
function Empty({
  title,
  text,
  action,
  onClick,
}: {
  title: string;
  text: string;
  action?: string;
  onClick?: () => void;
}) {
  return (
    <div className={styles.empty}>
      <i>◇</i>
      <strong>{title}</strong>
      <p>{text}</p>
      {action && <button onClick={onClick}>{action}</button>}
    </div>
  );
}
function HubLoading() {
  return (
    <div className={styles.loading}>
      <section />
      <div>
        {Array.from({ length: 4 }, (_, index) => (
          <i key={index} />
        ))}
      </div>
      <article />
      <article />
    </div>
  );
}
function HubFatal({ message, retry }: { message: string; retry: () => void }) {
  return (
    <section className={styles.fatal}>
      <ErpIcon name="reports" />
      <h2>Não foi possível abrir a central de relatórios</h2>
      <p>{message}</p>
      <button onClick={retry}>Tentar novamente</button>
    </section>
  );
}

async function downloadReport(key: ReportKey, filters: Record<string, string>) {
  const query = new URLSearchParams(filters);
  query.set("export", key === "sales" ? "summary" : "all");
  const response = await fetch(
    `/api/erp/reports/${key === "margins" ? "margins" : key}?${query}`,
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Não foi possível gerar o arquivo.");
  }
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  const fileName =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] || `relatorio-${key}.csv`;
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return { fileName };
}
