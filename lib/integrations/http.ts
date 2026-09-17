import { IntegrationError } from "./core";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

const MAX_JSON_BYTES = 256 * 1024;

export async function readIntegrationJson(request: Request) {
  try { return await readJsonObject(request, MAX_JSON_BYTES); }
  catch (error) {
    if (error instanceof HttpSecurityError) throw new IntegrationError(error.message, error.status);
    throw error;
  }
}

export function privateJson(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(value, { ...init, headers });
}
