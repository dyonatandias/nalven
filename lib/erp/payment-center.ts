export const PAYMENT_PERIODS = [7, 30, 90] as const;
export const PAYMENT_PAGE_LIMIT = 25;
export const PAYMENT_EXPORT_LIMIT = 10_000;

export type PaymentCenterQuery = {
  days: (typeof PAYMENT_PERIODS)[number];
  page: number;
  limit: number;
  search: string;
  status: string;
  method: string;
  provider: string;
};

const FILTER = /^[\p{L}\p{N}_.:@/\- ]{0,80}$/u;
const SEARCH = /^[^\u0000-\u001f\u007f]{0,120}$/u;

export function parsePaymentCenterQuery(params: URLSearchParams): PaymentCenterQuery {
  const rawDays = Number(params.get("days") || 30);
  const days = PAYMENT_PERIODS.includes(rawDays as PaymentCenterQuery["days"])
    ? (rawDays as PaymentCenterQuery["days"])
    : 30;
  const rawPage = Number(params.get("page") || 1);
  const rawLimit = Number(params.get("limit") || PAYMENT_PAGE_LIMIT);
  return {
    days,
    page: Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 400) : 1,
    limit: Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : PAYMENT_PAGE_LIMIT,
    search: safe(params.get("search"), SEARCH),
    status: safe(params.get("status"), FILTER),
    method: safe(params.get("method"), FILTER),
    provider: safe(params.get("provider"), FILTER),
  };
}

function safe(value: string | null, expression: RegExp) {
  const normalized = (value || "").normalize("NFKC").trim();
  return expression.test(normalized) ? normalized : "";
}

export function isSuccessfulPayment(status: string) {
  return new Set(["captured", "manual_confirmed", "paid", "partially_refunded", "refunded"]).has(status);
}

export function paymentStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (new Set(["captured", "manual_confirmed", "paid", "reconciled", "applied", "succeeded"]).has(status)) return "success";
  if (new Set(["created", "processing", "authorized", "unknown", "manual_review", "pending", "partially_refunded"]).has(status)) return "warning";
  if (new Set(["declined", "failed", "cancelled", "dead", "blocked"]).has(status)) return "danger";
  return "neutral";
}

export function paymentStatusLabel(status: string) {
  return ({
    captured: "Capturado", manual_confirmed: "Confirmado manualmente", paid: "Pago",
    created: "Criado", processing: "Processando", authorized: "Autorizado",
    unknown: "Resultado incerto", manual_review: "Revisão manual", pending: "Pendente",
    partially_refunded: "Estorno parcial", refunded: "Estornado", declined: "Recusado",
    failed: "Falhou", cancelled: "Cancelado", reconciled: "Conciliado", matched: "Conciliado",
    issue: "Com divergência", not_applicable: "Não aplicável", applied: "Aplicado",
  } as Record<string, string>)[status] || status.replaceAll("_", " ");
}

export function paymentMethodLabel(method: string) {
  return ({
    pix: "Pix", credit: "Crédito", debit: "Débito", voucher: "Voucher",
    cash: "Dinheiro", payment_link: "Link de pagamento", bank_transfer: "Transferência",
    store_credit: "Crédito da loja",
  } as Record<string, string>)[method] || method.replaceAll("_", " ");
}

export type PaymentCsvRow = {
  createdAt: Date | string;
  saleNumber: string;
  customer: string;
  type: string;
  method: string;
  provider: string;
  status: string;
  amountCents: number;
  transactionId: string | null;
  endToEndId: string | null;
  nsu: string | null;
  authorizationCode: string | null;
  cardBrand: string | null;
  cardLastFour: string | null;
};

export function paymentCsv(rows: PaymentCsvRow[]) {
  const header = ["Data", "Venda", "Cliente", "Tipo", "Forma", "Provider", "Status", "Valor", "Transação", "EndToEndId", "NSU", "Autorização", "Bandeira", "Final do cartão"];
  const values = rows.map((row) => [
    new Date(row.createdAt).toISOString(), row.saleNumber, row.customer,
    row.type === "refund" ? "Estorno" : "Recebimento", paymentMethodLabel(row.method),
    row.provider, paymentStatusLabel(row.status), (row.amountCents / 100).toFixed(2),
    row.transactionId || "", row.endToEndId || "", row.nsu || "", row.authorizationCode || "",
    row.cardBrand || "", row.cardLastFour || "",
  ]);
  return [header, ...values].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
