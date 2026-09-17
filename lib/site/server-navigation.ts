import { after } from "next/server";
import { headers } from "next/headers";
import { redirect as nextRedirect, notFound as nextNotFound, permanentRedirect as nextPermanentRedirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { recordNavigation } from "./navigation";

export async function observePage(status: number, destination = "") {
  const h = await headers();
  const path = h.get("x-route-path");
  if (!path || h.has("next-router-prefetch") || h.get("purpose") === "prefetch") return;
  const id = h.get("x-request-id") || randomUUID();
  after(() => recordNavigation(id, path, status, destination));
}

export async function redirect(destination: string): Promise<never> {
  await observePage(307, destination);
  nextRedirect(destination);
}

export async function notFound(): Promise<never> {
  await observePage(404);
  nextNotFound();
}

export async function permanentRedirect(destination: string): Promise<never> {
  await observePage(308, destination);
  nextPermanentRedirect(destination);
}
