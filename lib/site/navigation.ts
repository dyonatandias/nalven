import { controlDb } from "@/db/control";
import { safeObservedPath } from "./paths";

export async function recordNavigation(requestId: string, path: string, status: number, destination = "") {
  try {
    await controlDb.routeEvent.createMany({
      data: [{ requestId, path: safeObservedPath(path), status, destination: safeObservedPath(destination) }],
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("navigation.record.failed", { type: error instanceof Error ? error.name : "unknown", code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined });
  }
}

export async function pruneNavigation() {
  return controlDb.routeEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } } });
}
