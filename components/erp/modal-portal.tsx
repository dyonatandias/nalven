"use client";

import { ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

export function ErpModal({ children, close, className = "", label = "Janela de diálogo" }: { children: ReactNode; close: () => void; className?: string; label?: string }) {
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !layer.current) return;
      const focusable = Array.from(layer.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keyboard);
    window.setTimeout(() => layer.current?.querySelector<HTMLElement>('input,select,textarea,button:not(.modal-close-area)')?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keyboard);
      previousFocus?.focus();
    };
  }, [close]);

  if (!mounted) return null;
  return createPortal(
    <div ref={layer} className={`tenant-modal erp-modal-layer ${className}`} role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" className="modal-close-area" onClick={close} aria-label="Fechar modal" />
      {children}
    </div>,
    document.body,
  );
}

function emptySubscribe() { return () => undefined; }
