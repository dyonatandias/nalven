import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import type { ProductionSnapshot } from "@/lib/erp/production-domain";
export type ProductOption = {
  id: number;
  name: string;
  sku?: string;
  unit?: string;
  cost?: number;
  variations?: { id: number; sku: string | null; attributes: unknown }[];
};
export type Revision = {
  id: string;
  version: number;
  status: string;
  snapshot: ProductionSnapshot;
  effectiveAt: string | null;
  approvedAt: string | null;
};
export type Bom = {
  id: number;
  name: string;
  code: string;
  active: boolean;
  outputProduct: ProductOption;
  revisions: Revision[];
  _count: { orders: number; revisions: number };
};
export type Center = {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  version: number;
  wipLimit: number;
  hourlyCostCents: number;
  timeZone: string;
  shifts: { day: number; start: string; end: string }[];
};
export type Order = {
  id: number;
  number: string;
  version: number;
  status: string;
  priority: string;
  tags: string[];
  assignedTo: string | null;
  dueAt: string | null;
  notes: string | null;
  plannedQuantity: number;
  producedQuantity: number | null;
  actualCost: number | null;
  qualityStatus: string;
  snapshot: ProductionSnapshot;
  outputProduct: ProductOption;
  warehouse: { id: number; name: string };
  bom: { id: number; name: string; code: string };
  revision: { version: number } | null;
  workCenter: Center | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  position: number;
  dependencies?: { predecessorId: number }[];
  _count: { reports: number };
};
export type Reservation = {
  id: string;
  productId: number;
  variationId: number | null;
  lotId: string | null;
  quantityMicros: string;
  consumedMicros: string;
  releasedMicros: string;
};
export type Report = {
  id: string;
  producedMicros: string;
  scrapMicros: string;
  reworkMicros: string;
  materialCostCents: number;
  laborCostCents: number;
  machineCostCents: number;
  energyCostCents: number;
  overheadCostCents: number;
  laborMinutes: number;
  machineMinutes: number;
  status: string;
  actor: string;
  notes: string;
  createdAt: string;
  outputIdentity: {
    lotCode: string;
    serialNumbers: string[];
    manufacturedOn: string;
    expiresOn: string | null;
    lotIds: string[];
  };
  inspections: {
    certificate: string;
    actor: string;
    decision: string;
    notes: string;
    createdAt: string;
    checklist: { name: string; passed: boolean }[];
  }[];
  consumptions: {
    quantityMicros: string;
    totalCostCents: number;
    reservation: Reservation;
  }[];
};
export type Requirement = {
  productId: number;
  variationId: number | null;
  product: ProductOption;
  required: number;
  reserved: number;
  available: number;
  shortage: number;
  netShortage: number;
  incomingQuantity: number;
  sources: { warehouseId: number; name: string; available: number }[];
};
export type Detail = {
  order: Order & {
    reports: Report[];
    reservations: Reservation[];
    dependencies: { predecessorId: number; predecessor: { number: string } }[];
  };
  materials: Requirement[];
  lots: {
    id: string;
    lotCode: string | null;
    serialNumber: string | null;
    expiresOn: string | null;
    status: string;
  }[];
  events: {
    id: string;
    action: string;
    actor: string;
    createdAt: string;
    data: Record<string, unknown>;
  }[];
  reportsHaveMore: boolean;
};
export type Page<T> = {
  items: T[];
  nextCursor: string | number | null;
  total?: number;
};
export type Command = (payload: Record<string, unknown>) => Promise<boolean>;
export const productionApi = "/api/erp/production/operations";
export const stageLabels: Record<string, string> = {
  planned: "Planejada",
  in_progress: "Em produção",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
};
export const priorityLabels: Record<string, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};
export const qualityLabels: Record<string, string> = {
  pending: "Sem apontamentos",
  quarantine: "Aguardando inspeção",
  approved: "Aprovada",
  rejected: "Reprovada",
  mixed: "Com reprovações",
};
export const fmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 });
export const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
export function units(value: string) {
  return Number(value) / 1e6;
}
export function moneyCents(value: number) {
  return brl.format(value / 100);
}
export function shortDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
        timeZone: "UTC",
        dateStyle: "short",
      }).format(new Date(value))
    : "Sem prazo";
}
export function timestamp(value: string) {
  return tenantDateTimeFormatter({ dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
export function reportCost(report: Report) {
  return (
    report.materialCostCents +
    report.laborCostCents +
    report.machineCostCents +
    report.energyCostCents +
    report.overheadCostCents
  );
}
