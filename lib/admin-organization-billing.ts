import { billingList, object } from "@/lib/billing/portal-data";

function text(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 1000) : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
function amount(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || value === "" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export function organizationInvoices(value: unknown) {
  const rows = billingList(value, ["items", "data", "invoices", "faturas"]);
  return rows.map(value => {
    const row = object(value);
    const id = text(row.id);
    if (!id) throw new Error("Fatura externa sem identificador.");
    return { id, description: text(row.descricao ?? row.numero) || `Fatura ${id}`, amount: amount(row.valor_total ?? row.valor ?? row.amount), dueAt: text(row.data_vencimento ?? row.vencimento ?? row.due_at), paidAt: text(row.data_pagamento ?? row.paid_at), status: text(row.status) };
  });
}
export function organizationPayment(value: unknown) {
  const portal = object(value), subscription = object(portal.subscription ?? portal.assinatura), methods = object(portal.payment_methods);
  if (!Object.keys(portal).length) throw new Error("Resposta financeira inválida.");
  return { paymentMethod: text(subscription.forma_pagamento_preferida ?? subscription.forma_pagamento ?? subscription.payment_method), subscriptionStatus: text(subscription.status), availableMethods: ["pix", "boleto", "cartao"].filter(key => methods[key] === true) };
}
