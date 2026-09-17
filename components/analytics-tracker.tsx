"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { classifyPage, normalizePath, shouldTrackPath } from "@/lib/analytics/core";

type Payload = {
  session_hash: string;
  visitor_hash: string;
  page_path: string;
  page_type: string;
  device_type: "desktop" | "mobile" | "tablet";
  referrer: string;
  is_heartbeat: boolean;
  action?: string;
};

let lastBody = "";
let lastSentAt = 0;

export default function AnalyticsTracker() {
  const pathname = usePathname();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!shouldTrackPath(pathname)) return;
    void send(false);
  }, [pathname]);

  useEffect(() => {
    if (!shouldTrackPath(pathname)) return;
    let disposed = false;
    const start = async () => {
      let seconds = 30;
      try {
        const response = await fetch("/api/analytics/event", { cache: "no-store" });
        const config = await response.json() as { enabled?: boolean; heartbeatIntervalSeconds?: number };
        if (config.enabled === false || disposed) return;
        seconds = Math.max(10, Math.min(120, Number(config.heartbeatIntervalSeconds || 30)));
      } catch { /* Analytics nunca interfere na navegação. */ }
      if (!disposed) intervalRef.current = setInterval(() => void send(true), seconds * 1000);
    };
    const click = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (anchor?.getAttribute("href")?.startsWith("/cadastro")) void send(false, "signup_cta");
    };
    const leave = () => send(true, undefined, true);
    document.addEventListener("click", click, { capture: true });
    window.addEventListener("pagehide", leave);
    void start();
    return () => {
      disposed = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("click", click, { capture: true });
      window.removeEventListener("pagehide", leave);
    };
  }, [pathname]);

  return null;
}

function send(heartbeat: boolean, action?: string, beacon = false) {
  const path = normalizePath(window.location.pathname);
  if (!shouldTrackPath(path)) return;
  const payload: Payload = {
    session_hash: browserId("nalven_analytics_session", "sessionStorage"),
    visitor_hash: browserId("nalven_analytics_visitor", "localStorage"),
    page_path: path,
    page_type: classifyPage(path),
    device_type: window.innerWidth < 768 ? "mobile" : window.innerWidth < 1024 ? "tablet" : "desktop",
    referrer: sessionValue("nalven_analytics_referrer", document.referrer),
    is_heartbeat: heartbeat,
    ...(action ? { action } : {}),
  };
  const body = JSON.stringify(payload);
  const now = Date.now();
  if (body === lastBody && now - lastSentAt < 2000) return;
  lastBody = body;
  lastSentAt = now;
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/analytics/event", new Blob([body], { type: "application/json" }));
    return;
  }
  void fetch("/api/analytics/event", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}

function browserId(key: string, storageName: "localStorage" | "sessionStorage") {
  try {
    const storage = window[storageName];
    const existing = storage.getItem(key);
    if (existing) return existing;
    const value = crypto.randomUUID().replaceAll("-", "");
    storage.setItem(key, value);
    return value;
  } catch { return crypto.randomUUID().replaceAll("-", ""); }
}
function sessionValue(key: string, fallback: string) {
  const safeFallback = referrerOrigin(fallback);
  try {
    const existing = sessionStorage.getItem(key);
    // Upgrade legacy full-URL values before sending or retaining them.
    const safeValue = existing === null ? safeFallback : referrerOrigin(existing);
    sessionStorage.setItem(key, safeValue);
    return safeValue;
  } catch { /* sem persistência */ }
  return safeFallback;
}

function referrerOrigin(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch { return ""; }
}
