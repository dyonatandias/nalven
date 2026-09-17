"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { nextPosModalFocusIndex, PosModalIsolationStack } from "@/lib/erp/pos-modal-stack";

type CloseReason = "escape" | "backdrop" | "button";

export type PdvAccessibleModalProps = {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  busy?: boolean;
  error?: string | null;
  status?: string | null;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  overlayClassName?: string;
  dialogClassName?: string;
  onRequestClose(reason: CloseReason): void;
};

const PORTAL_ATTRIBUTE = "data-pdv-modal-portal-root";
let portalRoot: HTMLDivElement | null = null;

const modalStack = new PosModalIsolationStack<HTMLElement>(() => {
  if (typeof document === "undefined" || !portalRoot) return [];
  return [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portalRoot);
});

export function PdvAccessibleModal({
  open,
  title,
  description,
  children,
  busy = false,
  error,
  status,
  closeLabel = "Fechar",
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  returnFocusRef,
  overlayClassName = "",
  dialogClassName = "",
  onRequestClose,
}: PdvAccessibleModalProps) {
  const reactId = useId();
  const token = `pdv-modal-${reactId}`;
  const titleId = `${token}-title`, descriptionId = description == null ? undefined : `${token}-description`;
  const alertId = `${token}-alert`, statusId = `${token}-status`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy), closeRef = useRef(onRequestClose);
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    busyRef.current = busy;
    closeRef.current = onRequestClose;
  }, [busy, onRequestClose]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    let active = true;
    queueMicrotask(() => {
      if (active) setHost(ensurePortalRoot());
    });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !host || !dialog || typeof document === "undefined") return;
    const trigger = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    let closed = false;
    modalStack.open(token, dialog);
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(dialog.parentElement, { autoAlpha: 0 }, { autoAlpha: 1, duration: .18, ease: "power1.out", clearProps: "all" });
      gsap.fromTo(dialog, { autoAlpha: 0, y: 14, scale: .985 }, { autoAlpha: 1, y: 0, scale: 1, duration: .28, ease: "power3.out", clearProps: "all" });
    });

    const focusInitial = () => {
      if (closed || !modalStack.isTop(token)) return;
      focusIntoModal(dialog, initialFocusRef?.current ?? null);
    };
    queueMicrotask(focusInitial);

    const keydown = (event: KeyboardEvent) => {
      if (!modalStack.isTop(token)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current && closeOnEscape) closeRef.current("escape");
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        dialog.focus();
        return;
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      focusable[nextPosModalFocusIndex(focusable.length, currentIndex, event.shiftKey)].focus();
    };

    const focusin = (event: FocusEvent) => {
      if (!modalStack.isTop(token) || dialog.contains(event.target as Node)) return;
      focusIntoModal(dialog, initialFocusRef?.current ?? null);
    };

    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin, true);
      media.revert();
      closed = true;
      const closeResult = modalStack.close(token);
      queueMicrotask(() => {
        if (modalStack.has(token) || !closeResult.wasTop) return;
        if (validFocusReturn(trigger)) trigger.focus();
      });
    };
  }, [closeOnEscape, host, initialFocusRef, open, returnFocusRef, token]);

  if (!open || !host) return null;

  const requestClose = (reason: CloseReason) => {
    if (!busyRef.current && modalStack.isTop(token)) closeRef.current(reason);
  };

  return createPortal(
    <div
      className={`tenant-modal pos-dialog pdv-accessible-modal-overlay ${overlayClassName}`.trim()}
      data-pdv-modal-overlay="true"
      onClick={event => {
        if (event.target === event.currentTarget && closeOnBackdrop) requestClose("backdrop");
      }}
    >
      <div
        ref={dialogRef}
        className={`pdv-accessible-modal-dialog ${dialogClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description != null && <p id={descriptionId}>{description}</p>}
          </div>
          <button type="button" disabled={busy} onClick={() => requestClose("button")}>{closeLabel}</button>
        </header>
        {error && <div id={alertId} className="tenant-error pdv-accessible-modal-alert" role="alert" aria-live="assertive">{error}</div>}
        {status && <div id={statusId} className="tenant-success pdv-accessible-modal-status" role="status" aria-live="polite">{status}</div>}
        {children}
      </div>
    </div>,
    host,
  );
}

function ensurePortalRoot() {
  if (portalRoot?.isConnected) return portalRoot;
  const existing = document.querySelector<HTMLDivElement>(`div[${PORTAL_ATTRIBUTE}]`);
  if (existing) {
    portalRoot = existing;
    return existing;
  }
  const created = document.createElement("div");
  created.setAttribute(PORTAL_ATTRIBUTE, "true");
  document.body.appendChild(created);
  portalRoot = created;
  return created;
}

function focusIntoModal(dialog: HTMLElement, preferred: HTMLElement | null) {
  const target = preferred && dialog.contains(preferred) && focusable(preferred) ? preferred : focusableElements(dialog)[0] ?? dialog;
  target.focus();
}

function focusableElements(dialog: HTMLElement) {
  const selector = [
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "a[href]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return [...dialog.querySelectorAll<HTMLElement>(selector)].filter(focusable);
}

function focusable(element: HTMLElement) {
  if (!element.isConnected || element.inert || element.closest("[inert], [aria-hidden='true']")) return false;
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled) return false;
  }
  return element.getAttribute("aria-disabled") !== "true" && element.tabIndex >= 0;
}

function validFocusReturn(target: HTMLElement | null): target is HTMLElement {
  return Boolean(target && focusable(target));
}
