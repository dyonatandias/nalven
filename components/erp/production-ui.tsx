"use client";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { productionApi, type Page } from "./production-types";
import styles from "./production-workspace.module.css";

export function ProductionDialog({
  title,
  subtitle,
  busy,
  close,
  children,
}: {
  title: string;
  subtitle?: string;
  busy: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-busy={busy}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const dialog = event.currentTarget;
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 && element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <header>
        <div>
          {subtitle && <small>{subtitle}</small>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          aria-label="Fechar diálogo"
        >
          ×
        </button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}
export function Field({
  label,
  children,
  wide = false,
  hint,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  hint?: string;
}) {
  const labelId = useId(),
    hintId = useId();
  return (
    <label className={wide ? styles.wide : undefined}>
      <span id={labelId}>{label}</span>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            "aria-labelledby": labelId,
            ...(hint ? { "aria-describedby": hintId } : {}),
          })
        : children}
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  );
}
export function FormFooter({
  close,
  busy,
  label = "Salvar",
}: {
  close: () => void;
  busy: boolean;
  label?: string;
}) {
  return (
    <footer className={styles.formFooter}>
      <button type="button" onClick={close} disabled={busy}>
        Voltar
      </button>
      <button className={styles.primary} disabled={busy}>
        {busy ? "Salvando…" : label}
      </button>
    </footer>
  );
}

type Choice = {
  id: string | number;
  name: string;
  code?: string;
  sku?: string;
};
export function RemoteChoice<T extends Choice>({
  resource,
  label,
  value,
  change,
  initial,
  required = true,
}: {
  resource: string;
  label: string;
  value: string;
  change: (item: T | null) => void;
  initial?: T;
  required?: boolean;
}) {
  const choiceLabelId = useId();
  const [search, setSearch] = useState(""),
    [items, setItems] = useState<T[]>(initial ? [initial] : []),
    [next, setNext] = useState<string | number | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const selected = useRef<T | null>(initial || null);
  async function load(cursor?: string | number) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError("");
    try {
      const url = new URLSearchParams({ resource, search, limit: "30" });
      if (resource === "boms") url.set("active", "true");
      if (cursor)
        url.set(
          resource === "centers" ? "centerAfter" : "after",
          String(cursor),
        );
      const response = await fetch(`${productionApi}?${url}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Falha ao buscar opções.");
      const data = body as Page<T>;
      if (controller.signal.aborted) return;
      setItems((current) => [
        ...new Map(
          [
            ...(cursor ? current : selected.current ? [selected.current] : []),
            ...data.items,
          ].map((item) => [item.id, item]),
        ).values(),
      ]);
      setNext(data.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "Falha ao buscar.");
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => {
      clearTimeout(timer);
      abort.current?.abort();
    }; /* Search triggers a new, cancellable catalog request. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, search]);
  return (
    <div className={styles.choice}>
      <label>
        <span>Buscar {label.toLocaleLowerCase("pt-BR")}</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Nome ou código"
        />
      </label>
      <label>
        <span id={choiceLabelId}>{label}</span>
        <select
          aria-labelledby={choiceLabelId}
          required={required}
          value={value}
          onChange={(event) => {
            const item =
              items.find((item) => String(item.id) === event.target.value) ??
              null;
            selected.current = item;
            change(item);
          }}
        >
          <option value="">Selecione</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.sku || item.code ? ` · ${item.sku || item.code}` : ""}
            </option>
          ))}
        </select>
      </label>
      {loading && <small role="status">Buscando…</small>}
      {error && (
        <div role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Tentar novamente
          </button>
        </div>
      )}
      {next && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(next)}
        >
          Mais opções
        </button>
      )}
    </div>
  );
}
