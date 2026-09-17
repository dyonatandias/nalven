import { csvFile } from "@/lib/erp/report-domain";

export const FISCAL_DOCUMENT_TYPES = ["nfe", "nfce", "nfse"] as const;
export const FISCAL_DOCUMENT_STATUSES = [
  "draft",
  "queued",
  "processing",
  "authorized",
  "rejected",
  "contingency",
  "cancelled",
] as const;
export const FISCAL_OPERATION_TYPES = [
  "issuance",
  "retry",
  "status_query",
  "contingency",
  "cancellation",
  "correction",
  "invalidation",
] as const;
export const FISCAL_OPERATION_STATUSES = [
  "pending",
  "processing",
  "completed",
  "rejected",
  "withdrawn",
] as const;

export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number];
export type FiscalDocumentStatus = (typeof FISCAL_DOCUMENT_STATUSES)[number];
export type FiscalOperationType = (typeof FISCAL_OPERATION_TYPES)[number];

export class FiscalControlInputError extends Error {}

export type FiscalQuery = {
  search: string;
  status: string;
  type: string;
  environment: string;
  branchId: number;
  from: Date | null;
  toExclusive: Date | null;
  fromText: string;
  toText: string;
  page: number;
  limit: number;
  format: string;
};

export function parseFiscalQuery(params: URLSearchParams): FiscalQuery {
  const search = (params.get("search") || "").trim().slice(0, 100);
  const status = optionalChoice(params.get("status"), FISCAL_DOCUMENT_STATUSES, "Status");
  const type = optionalChoice(params.get("type"), FISCAL_DOCUMENT_TYPES, "Modelo");
  const environment = optionalChoice(params.get("environment"), ["homologation", "production"] as const, "Ambiente");
  const branchId = optionalPositiveInteger(params.get("branchId"), "Filial");
  const page = boundedInteger(params.get("page"), 1, 1, 10_000, "Página");
  const limit = boundedInteger(params.get("limit"), 12, 8, 50, "Limite");
  const fromText = optionalDateText(params.get("from"), "Data inicial");
  const toText = optionalDateText(params.get("to"), "Data final");
  const from = fromText ? new Date(`${fromText}T00:00:00.000Z`) : null;
  const toExclusive = toText ? new Date(`${toText}T00:00:00.000Z`) : null;
  if (toExclusive) toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  if (from && toExclusive && from >= toExclusive)
    throw new FiscalControlInputError("A data inicial deve ser anterior ou igual à data final.");
  const format = optionalChoice(params.get("format"), ["csv"] as const, "Formato");
  return { search, status, type, environment, branchId, from, toExclusive, fromText, toText, page, limit, format };
}

export function allowedFiscalOperation(
  operation: FiscalOperationType,
  document: { status: string; type: string } | null,
) {
  if (operation === "invalidation") return document === null;
  if (!document || operation === "issuance") return false;
  if (operation === "retry") return document.status === "rejected";
  if (operation === "status_query") return ["queued", "processing", "contingency"].includes(document.status);
  if (operation === "contingency") return ["queued", "processing"].includes(document.status);
  if (operation === "cancellation") return document.status === "authorized";
  return operation === "correction" && document.status === "authorized" && document.type === "nfe";
}

export function operationDueAt(operation: FiscalOperationType, now = new Date()) {
  const minutes: Record<FiscalOperationType, number> = {
    issuance: 15,
    retry: 15,
    status_query: 10,
    contingency: 10,
    cancellation: 30,
    correction: 60,
    invalidation: 60,
  };
  return new Date(now.valueOf() + minutes[operation] * 60_000);
}

export function fiscalDocumentCsv(documents: Array<{
  branch: { code: string; name: string };
  type: string;
  series: number;
  number: number;
  status: string;
  environment: string;
  recipient: string;
  amountCents: number;
  accessKey: string | null;
  protocol: string | null;
  rejectionCode: string | null;
  rejectionMessage: string | null;
  issuedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}>) {
  return csvFile(
    ["filial", "modelo", "serie", "numero", "status", "ambiente", "destinatario", "valor", "chave", "protocolo", "codigo_rejeicao", "rejeicao", "emitido_em", "cancelado_em", "criado_em"],
    documents.map((document) => [
      `${document.branch.code} · ${document.branch.name}`,
      document.type.toUpperCase(),
      document.series,
      document.number,
      document.status,
      document.environment,
      document.recipient,
      (document.amountCents / 100).toFixed(2),
      document.accessKey,
      document.protocol,
      document.rejectionCode,
      document.rejectionMessage,
      document.issuedAt?.toISOString() || "",
      document.cancelledAt?.toISOString() || "",
      document.createdAt.toISOString(),
    ]),
  );
}

function optionalChoice<const T extends readonly string[]>(raw: string | null, values: T, label: string) {
  if (!raw) return "";
  if (!values.includes(raw)) throw new FiscalControlInputError(`${label} inválido.`);
  return raw;
}

function optionalPositiveInteger(raw: string | null, label: string) {
  if (!raw) return 0;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new FiscalControlInputError(`${label} inválida.`);
  return Number(raw);
}

function boundedInteger(raw: string | null, fallback: number, min: number, max: number, label: string) {
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new FiscalControlInputError(`${label} inválida.`);
  const value = Number(raw);
  if (value < min || value > max) throw new FiscalControlInputError(`${label} fora do limite permitido.`);
  return value;
}

function optionalDateText(raw: string | null, label: string) {
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new FiscalControlInputError(`${label} inválida.`);
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== raw)
    throw new FiscalControlInputError(`${label} inválida.`);
  return raw;
}
