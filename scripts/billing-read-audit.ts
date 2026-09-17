import { controlDb } from "../db/control";
import { billingClient, billingSettings } from "../lib/billing/client";
import { organizationInvoices, organizationPayment } from "../lib/admin-organization-billing";
import { object } from "../lib/billing/portal-data";

// Read-only diagnostic: no provisioning, reconciliation, charges or session creation.
async function main() {
  console.log("stage: settings");
  const settings = await billingSettings();
  const endpoint = new URL(settings.headlessBaseUrl);
  if (endpoint.origin !== "https://sistema.agenciaexpresso.com.br" || endpoint.pathname !== "/api/v1/saas" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error("Unexpected configured destination");
  console.log("stage: account scope");
  const accounts = await controlDb.billingAccount.findMany({ select: { externalId: true }, take: 2 });
  if (accounts.length !== 1) throw new Error("Reviewed single-account scope changed");
  const checks: Array<[string, () => Promise<unknown>]> = [
    ["catalog", () => billingClient.catalog()],
    ["portal", () => billingClient.portal(accounts[0].externalId)],
    ["invoices", () => billingClient.invoices(accounts[0].externalId)],
  ];
  for (const [name, read] of checks) {
    try {
      const result = await read();
      const shape = Array.isArray(result) ? "array" : result !== null && typeof result === "object" ? "object" : typeof result;
      console.log(`${name}: success, response shape=${shape}`);
      if (name === "portal") {
        const projected = organizationPayment(result);
        console.log(`portal projection: paymentMethodPresent=${projected.paymentMethod !== null}, subscriptionStatusPresent=${projected.subscriptionStatus !== null}, availableMethods=${projected.availableMethods.length}`);
        const portal = object(result), subscription = object(portal.subscription ?? portal.assinatura);
        console.log(`portal contract: preferredMethodPresent=${typeof subscription.forma_pagamento_preferida === "string"}`);
      }
      if (name === "invoices") {
        const projected = organizationInvoices(result);
        console.log(`invoice projection: rows=${projected.length}, amountsPresent=${projected.filter(row => row.amount !== null).length}, dueDatesPresent=${projected.filter(row => row.dueAt !== null).length}, statusesPresent=${projected.filter(row => row.status !== null).length}`);
      }
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : "unknown";
      console.log(`${name}: failed, status=${status}; remote content suppressed`);
      process.exitCode = 1;
    }
  }
}
main().catch(error => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code) ? error.code : "unclassified";
  const message = error instanceof Error ? error.message : "";
  const category = /Cannot find module|ENOENT|wasm/.test(message) ? "diagnostic-package" : /Unexpected configured destination/.test(message) ? "destination" : "local-read";
  console.error(`Read audit failed: category=${category}, code=${code}; details suppressed`);
  process.exitCode = 1;
}).finally(() => controlDb.$disconnect());
