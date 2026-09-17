"use client";
import { setTenantTimeZone, tenantTimeZone } from "@/lib/client-timezone";
import { PlanFeatures, usePlanFeatures } from "@/components/erp/plan-features";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, react-hooks/set-state-in-effect, react-hooks/exhaustive-deps, @next/next/no-img-element */
import type {
  FormEvent,
  ReactNode,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrowserReadCache, readBrowserPreference, writeBrowserPreference } from "@/lib/erp/browser-read-cache";
import { ErpIcon } from "@/components/erp/erp-icon";
import {
  MediaLibrary,
  MediaPicker,
  type MediaAsset,
} from "@/components/erp/media-library";
import { ErpModal } from "@/components/erp/modal-portal";
import {
  ProductCatalogForm,
  type ProductCatalogItem,
} from "@/components/erp/product-catalog-form";
import { OrderManagement } from "@/components/erp/order-management";
import { PurchaseReceiptDialog } from "@/components/erp/purchase-receipt-dialog";
import { IntegrationCenter } from "@/components/erp/integration-center";
import { ReportsCenter } from "@/components/erp/reports-center";
import { PdvWorkspace } from "@/components/erp/pdv-workspace";
import { PdvSettingsPage } from "@/components/erp/pdv-settings-page";
import { PaymentCenter } from "@/components/erp/payment-center";
import { TransactionalEmailCenter } from "@/components/erp/transactional-email-center";
import { AiIntegrationCenter } from "@/components/erp/ai-integration-center";
import { SettingsControlCenter } from "@/components/erp/settings-control-center";
import { SalesExpenses } from "@/components/erp/sales-expenses";
import { BusinessIntelligenceDashboard } from "@/components/erp/business-intelligence-dashboard";
import { NfeInputWorkspace } from "@/components/erp/nfe-input-workspace";
import { FiscalCenter } from "@/components/erp/fiscal-center";
import { FinanceControlCenter } from "@/components/erp/finance-control-center";
import { CashCloseControlCenter } from "@/components/erp/cash-close-control-center";
import { AccountsControlCenter } from "@/components/erp/accounts-control-center";
import { BankReconciliationCenter } from "@/components/erp/bank-reconciliation-center";
import { PlanningControlCenter } from "@/components/erp/planning-control-center";
import { ProductionWorkspace } from "@/components/erp/production-workspace";
import { CustomerCenter } from "@/components/erp/customer-center";
import { SupplierCenter } from "@/components/erp/supplier-center";
import { CategoryCenter } from "@/components/erp/category-center";
import { UserAccessCenter } from "@/components/erp/user-access-center";
import { CompanyBranchCenter } from "@/components/erp/company-branch-center";
import { AuditActivityCenter } from "@/components/erp/audit-activity-center";
import { PrivacyGovernanceCenter } from "@/components/erp/privacy-governance-center";
import { OperationsSuiteFrame } from "@/components/erp/operations-suite-frame";
import {
  OmnichannelLogistics,
  OmnichannelMarketplaces,
} from "@/components/erp/omnichannel-control-tower";
import {
  ERP_MODULES,
  ERP_SECTIONS,
  erpModule,
  erpRoute,
  type ErpPage,
} from "@/lib/erp/modules";

type Product = ProductCatalogItem;
type Movement = {
  id: number;
  productId: number;
  productName: string;
  unit: string;
  type: string;
  quantity: number;
  previousStock: number;
  currentStock: number;
  note?: string;
  userName: string;
  createdAt: string;
};
type Sale = {
  id: number;
  saleNumber: string;
  customer: string;
  seller: string;
  paymentMethod: string;
  total: number;
  createdAt: string;
};
type Snapshot = {
  products: Product[];
  movements: Movement[];
  sales: Sale[];
  saleItems: any[];
  settings?: {
    autoGenerateSku?: boolean;
    defaultPaymentMethod: string;
    defaultCustomerName: string;
    requireCustomer: boolean;
    lowStockAlerts: boolean;
  } | null;
  categories?: Array<{ id: number; name: string }>;
  brands?: Array<{ id: number; name: string }>;
  marketplaceChannels?: Array<{ id: number; name: string; provider: string }>;
  operationalBranch?: {
    id: number;
    code: string;
    name: string;
    warehouseId: number | null;
    warehouseName: string | null;
    canManageStock: boolean;
  } | null;
};

const EMPTY_SNAPSHOT: Snapshot = {
  products: [],
  movements: [],
  sales: [],
  saleItems: [],
};
const SNAPSHOT_CACHE_TTL = 30_000;
const snapshotCache = new BrowserReadCache<Snapshot>(SNAPSHOT_CACHE_TTL);
const viewDataCache = new BrowserReadCache<unknown>(120_000, 40);

function snapshotKey(organizationId: string, scope: ErpPage) {
  return `${organizationId}:${scope}`;
}

function needsShellSnapshot(scope: ErpPage) {
  return scope === "products" || scope === "stock";
}

function cachedViewData<T>(organizationId: string, endpoint: string) {
  return viewDataCache.get(`${organizationId}:${endpoint}`)?.data as T | undefined;
}

function cacheViewData(
  organizationId: string,
  endpoint: string,
  data: unknown,
) {
  viewDataCache.set(`${organizationId}:${endpoint}`, data);
}

function invalidateViewData(organizationId: string, endpoint: string) {
  viewDataCache.invalidate(`${organizationId}:${endpoint}`);
}

async function requestSnapshot(organizationId: string, scope: ErpPage) {
  const key = snapshotKey(organizationId, scope);
  return snapshotCache.read(key, async signal => {
    const response = await fetch(`/api/erp?scope=${encodeURIComponent(scope)}`, { cache: "no-store", signal });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Não foi possível carregar o ambiente.");
    return json as Snapshot;
  });
}
type Customer = {
  id: number;
  type: string;
  name: string;
  tradeName?: string | null;
  document: string;
  email?: string | null;
  phone?: string | null;
  status: string;
  creditLimit: number;
  notes?: string | null;
  addresses: Array<{
    zip?: string | null;
    street?: string | null;
    number?: string | null;
    complement?: string | null;
    district?: string | null;
    city?: string | null;
    state?: string | null;
  }>;
};
type Category = {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  type: string;
  color: string;
  active: boolean;
  parentId?: number | null;
  parent?: { id: number; name: string } | null;
  _count: { products: number; children: number };
};
type Supplier = {
  id: number;
  name: string;
  tradeName?: string | null;
  document: string;
  email?: string | null;
  phone?: string | null;
  status: string;
  paymentTerms?: string | null;
  notes?: string | null;
  contacts: Array<{
    name: string;
    role?: string | null;
    email?: string | null;
    phone?: string | null;
    primary: boolean;
  }>;
  products: Array<{
    product: { id: number; name: string; sku: string };
    lastCost?: number | null;
    preferred: boolean;
  }>;
  _count: { products: number };
};
type PurchaseOrder = {
  id: number;
  number: string;
  status: string;
  expectedAt?: string | null;
  dueAt?: string | null;
  subtotal: number;
  freight: number;
  discount: number;
  total: number;
  notes?: string | null;
  createdAt: string;
  supplier: { id: number; name: string; tradeName?: string | null };
  items: Array<{
    id: number;
    productId: number;
    variationId?: number | null;
    variation?: { id: number; sku: string | null; attributes: unknown } | null;
    quantity: number;
    receivedQuantity: number;
    unitCost: number;
    total: number;
    product: { id: number; name: string; sku: string; unit: string };
  }>;
  receipts: Array<{ id: number; number: string; receivedAt: string }>;
};
type PurchaseCatalog = {
  warehouses?: Array<{ id: number; name: string }>;
  items: PurchaseOrder[];
  quotations: any[];
  suppliers: Array<{
    id: number;
    name: string;
    tradeName?: string | null;
    document: string;
    paymentTerms?: string | null;
  }>;
  products: Array<{
    id: number;
    name: string;
    sku: string;
    unit: string;
    cost: number;
    stock: number;
  }>;
  summary: {
    total: number;
    drafts: number;
    awaitingReceipt: number;
    committed: number;
    openQuotations: number;
    overdueQuotations: number;
  };
};
type FinancialTitle = {
  id: number;
  type: string;
  description: string;
  documentNumber?: string | null;
  amount: number;
  paidAmount: number;
  dueAt: string;
  status: string;
  notes?: string | null;
  createdAt: string;
  customer?: { id: number; name: string; tradeName?: string | null } | null;
  supplier?: { id: number; name: string; tradeName?: string | null } | null;
  settlements: Array<{
    id: number;
    amount: number;
    interest: number;
    discount: number;
    method: string;
    settledAt: string;
  }>;
};
type FinanceCatalog = {
  items: FinancialTitle[];
  customers: Array<{
    id: number;
    name: string;
    tradeName?: string | null;
    document: string;
  }>;
  suppliers: Array<{
    id: number;
    name: string;
    tradeName?: string | null;
    document: string;
  }>;
  summary: {
    receivable: number;
    payable: number;
    overdue: number;
    settled: number;
  };
};
type InventoryProduct = {
  id: number;
  name: string;
  sku: string;
  unit: string;
  cost: number;
  stock: number;
};
type Warehouse = {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  active: boolean;
  primary: boolean;
  balances: Array<{
    id: number;
    productId: number;
    quantity: number;
    reservedQuantity: number;
    product: InventoryProduct;
  }>;
};
type InventoryCount = {
  id: number;
  number: string;
  status: string;
  blind: boolean;
  notes?: string | null;
  createdAt: string;
  completedAt?: string | null;
  warehouse: { id: number; code: string; name: string };
  items: Array<{
    id: number;
    productId: number;
    systemQuantity: number;
    countedQuantity?: number | null;
    difference?: number | null;
    product: InventoryProduct;
  }>;
};
type InventoryCatalog = {
  warehouses: Warehouse[];
  counts: InventoryCount[];
  transfers: Array<{
    id: number;
    number: string;
    status: string;
    notes?: string | null;
    transferredBy: string;
    createdAt: string;
    fromWarehouse: { id: number; code: string; name: string };
    toWarehouse: { id: number; code: string; name: string };
    items: Array<{ id: number; quantity: number; product: InventoryProduct }>;
  }>;
  products: InventoryProduct[];
  positions: Array<
    InventoryProduct & {
      physical: number;
      reserved: number;
      available: number;
      value: number;
      belowMinimum: boolean;
      minStock: number;
      warehouses: Array<{
        id: number;
        code: string;
        name: string;
        quantity: number;
        reservedQuantity: number;
        available: number;
      }>;
    }
  >;
  ledger: Array<{
    id: string;
    type: string;
    quantity: number;
    balanceBefore: number;
    balanceAfter: number;
    createdAt: string;
    warehouse: { code: string; name: string };
    product: { name: string; sku: string; unit: string };
  }>;
  summary: {
    warehouses: number;
    products: number;
    stockValue: number;
    physical: number;
    reserved: number;
    available: number;
    reservedProducts: number;
    lowStock: number;
    negative: number;
    openCounts: number;
    divergences: number;
  };
  pagination: {
    counts: { total: number; shown: number };
    transfers: { total: number; shown: number };
    ledger: { page: number; limit: number; total: number; pages: number };
  };
};
type AuditEvent = {
  id: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  correlationId?: string | null;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  createdAt: string;
  source?: "erp" | "integration";
  actor: { name: string; email: string };
};
type AuditCatalog = {
  items: AuditEvent[];
  pagination: { page: number; limit: number; total: number; pages: number };
  facets: { entityTypes: string[] };
  summary: { today: number; total: number; actors: number; correlated: number };
};
type TenantRole = {
  id: number;
  key: string;
  name: string;
  description?: string | null;
  permissions: string[];
  system: boolean;
  active: boolean;
  _count: { members: number };
};
type UserCatalog = {
  members: Array<{
    id: string;
    roleKey: string;
    status: string;
    createdAt: string;
    user: {
      id: string;
      name: string;
      email: string;
      status: string;
      lastLoginAt?: string | null;
      createdAt: string;
      activeSessions: number;
    };
  }>;
  roles: TenantRole[];
  invites: Array<{
    id: string;
    email: string;
    name?: string | null;
    roleKey: string;
    status: string;
    expiresAt: string;
    createdAt: string;
    invitedBy: { name: string; email: string };
  }>;
  permissionResources: Array<{ key: string; label: string }>;
  summary: { active: number; disabled: number; pending: number; roles: number };
};
type BranchWarehouse = {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  active: boolean;
  primary: boolean;
  branchId?: number | null;
  branch?: { id: number; code: string; name: string } | null;
  balances: Array<{ quantity: number; reservedQuantity: number }>;
};
type BranchProductCatalogItem = {
  id: number;
  name: string;
  sku: string;
  type: string;
  active: boolean;
  price: number;
  cost: number;
  minStock: number;
  unit: string;
};
type BranchProductConfiguration = {
  productId: number;
  active: boolean;
  saleEnabled: boolean;
  purchaseEnabled: boolean;
  priceOverride?: number | null;
  costOverride?: number | null;
  minStock?: number | null;
  maxStock?: number | null;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
  preferredWarehouseId?: number | null;
  location?: string | null;
  leadTimeDays: number;
};
type BranchUserAccess = {
  userProfileId: number;
  canSell: boolean;
  canManageStock: boolean;
  canIssueFiscal: boolean;
  primary: boolean;
};
type BranchProfile = { id: number; displayName: string; email: string };
type Branch = {
  id: number;
  code: string;
  name: string;
  legalName: string;
  document: string;
  type: string;
  status: string;
  stateRegistration?: string | null;
  municipalRegistration?: string | null;
  email?: string | null;
  phone?: string | null;
  managerName?: string | null;
  managerEmail?: string | null;
  managerPhone?: string | null;
  costCenterCode?: string | null;
  zip?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  timezone: string;
  primary: boolean;
  defaultWarehouseId?: number | null;
  defaultWarehouse?: { id: number; code: string; name: string } | null;
  warehouses: BranchWarehouse[];
  settings?: {
    taxRegime: string;
    fiscalEnvironment: string;
    nfeSeries: number;
    nfceSeries: number;
    nfseSeries: number;
    nextNfeNumber: number;
    nextNfceNumber: number;
    nextNfseNumber: number;
    reserveStockOnOrder: boolean;
    allowCrossBranchFulfillment: boolean;
    autoTransferEnabled: boolean;
    stockAllocationStrategy: string;
  } | null;
  productConfigurations: BranchProductConfiguration[];
  userAccesses: BranchUserAccess[];
  _count: { activeProfiles: number; userAccesses: number };
};
type BranchCatalog = {
  branches: Branch[];
  warehouses: BranchWarehouse[];
  products: BranchProductCatalogItem[];
  profiles: BranchProfile[];
  activeBranchId: number | null;
  summary: {
    total: number;
    active: number;
    headquarters: number;
    unassignedWarehouses: number;
  };
};
type TenantSettingsRecord = {
  id: number;
  organizationName: string;
  tradeName?: string | null;
  locale: string;
  currency: string;
  timezone: string;
  defaultPaymentMethod: string;
  defaultCustomerName: string;
  requireCustomer: boolean;
  lowStockAlerts: boolean;
  operationalEmail?: string | null;
  dailySummary: boolean;
  notifyLowStock: boolean;
  auditRetentionDays: number;
  logoMediaId?: string | null;
  logoMedia?: MediaAsset | null;
  accentColor: string;
  interfaceDensity: string;
  defaultSidebarMode: string;
  operationalPhone?: string | null;
  autoGenerateSku: boolean;
  allowNegativeStock: boolean;
  quoteValidityDays: number;
  maxDiscountPercent: number;
  posCloseToleranceCents: number;
  dailySummaryTime: string;
  notifyOverdueTitles: boolean;
  notifyNewSales: boolean;
  quoteFooter?: string | null;
  receiptFooter?: string | null;
  termsAndConditions?: string | null;
  dataProtectionEmail?: string | null;
  version: number;
  updatedAt: string;
};
type SalesOrder = {
  id: number;
  number: string;
  kind: string;
  status: string;
  customerName: string;
  customerDocument?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  contactName?: string | null;
  salesChannel: string;
  salesperson?: string | null;
  priority: string;
  externalReference?: string | null;
  purchaseOrderNumber?: string | null;
  validUntil?: string | null;
  expectedAt?: string | null;
  subtotal: number;
  discount: number;
  discountType: string;
  discountValue: number;
  freightAmount: number;
  freightType: string;
  total: number;
  paymentMethod?: string | null;
  paymentTerms?: string | null;
  paymentInstallments: number;
  firstDueDate?: string | null;
  deliveryType: string;
  deliveryCity?: string | null;
  deliveryState?: string | null;
  notes?: string | null;
  internalNotes?: string | null;
  createdAt: string;
  items: Array<{
    id: number;
    productId: number;
    quantity: number;
    description?: string | null;
    listPrice: number;
    unitPrice: number;
    discount: number;
    discountPercent: number;
    notes?: string | null;
    total: number;
    product: {
      id: number;
      name: string;
      sku: string;
      unit: string;
      stock: number;
    };
  }>;
  history: Array<{
    id: number;
    fromStatus?: string | null;
    toStatus: string;
    actor: string;
    notes?: string | null;
    createdAt: string;
  }>;
};
type OrderCatalog = {
  items: SalesOrder[];
  customers: Array<{
    id: number;
    name: string;
    tradeName?: string | null;
    document: string;
    email?: string | null;
    phone?: string | null;
    addresses: Array<{
      zip?: string | null;
      street?: string | null;
      number?: string | null;
      complement?: string | null;
      district?: string | null;
      city?: string | null;
      state?: string | null;
    }>;
  }>;
  products: Array<{
    id: number;
    name: string;
    sku: string;
    unit: string;
    price: number;
    stock: number;
    type: string;
  }>;
  salespeople: Array<{ id: number; displayName: string; email: string }>;
  currentSalespersonProfileId: number;
  branch?: {
    id: number;
    code: string;
    name: string;
    defaultWarehouse?: { id: number; code: string; name: string } | null;
  } | null;
  summary: {
    total: number;
    drafts: number;
    approved: number;
    completed: number;
  };
  settings: {
    quoteValidityDays: number;
    maxDiscountPercent: number;
    defaultPaymentMethod: string;
    termsAndConditions?: string | null;
  };
};
type ServiceCatalog = {
  items: any[];
  customers: OrderCatalog["customers"];
  products: OrderCatalog["products"];
  summary: {
    total: number;
    open: number;
    inProgress: number;
    completed: number;
  };
};
const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export default function ErpClient({
  initialPage,
  allowedPages,
  user,
  organization,
  organizations,
}: {
  initialPage: ErpPage;
  allowedPages: readonly ErpPage[];
  user: { id?: string; cacheVersion?: string; name: string; email: string };
  organization: {
    id: string;
    name: string;
    status: string;
    trialEndsAt: string | null;
    timezone: string;
    accentColor: string;
    interfaceDensity: string;
    defaultSidebarMode: string;
    logoMediaId: string | null;
    activeBranch: { id: number; code: string; name: string; timezone: string } | null;
  };
  organizations: Array<{ id: string; name: string; role: string }>;
}) {
  setTenantTimeZone(organization.activeBranch?.timezone || organization.timezone);
  const router = useRouter();
  const cacheNamespace = [organization.id, user.id || user.email, organization.activeBranch?.id || 0, user.cacheVersion || "initial"].join(":");
  const [page, setPage] = useState<ErpPage>(initialPage);
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot | undefined>>(() => {
    const key = snapshotKey(cacheNamespace, initialPage);
    const cached = snapshotCache.get(key);
    return cached ? { [key]: cached.data } : {};
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const loadingSequence = useRef(0);
  const actionPending = useRef(false);
  const [mobile, setMobile] = useState(false),
    [companyOpen, setCompanyOpen] = useState(false),
    [userOpen, setUserOpen] = useState(false),
    [sidebar, setSidebar] = useState<"expanded" | "compact" | "hidden">(
      organization.defaultSidebarMode === "compact" ? "compact" : "expanded",
    );
  const navigationRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [mobileScreen, setMobileScreen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => { setMobileScreen(media.matches); if (!media.matches) setMobile(false); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobile || !mobileScreen || !sidebarRef.current) return;
    const panel = sidebarRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => [...panel.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex='0']")].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
    (panel.querySelector<HTMLElement>("a[aria-current='page']") || focusable()[0])?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setMobile(false); }
      if (event.key !== "Tab") return;
      const options = focusable(), first = options[0], last = options.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("keydown", keyboard); document.body.style.overflow = overflow; previous?.focus(); };
  }, [mobile, mobileScreen]);
  const boundaryAttempts = useRef<
    Record<string, { signature: string; key: string }>
  >({});
  useEffect(() => {
    const saved = readBrowserPreference("localStorage", "nalven.erp.sidebar");
    if (saved === "expanded" || saved === "compact" || saved === "hidden")
      setSidebar(saved);
  }, []);
  function changeSidebar(value: "expanded" | "compact" | "hidden") {
    setSidebar(value);
    writeBrowserPreference("localStorage", "nalven.erp.sidebar", value);
  }
  async function load(scope: ErpPage = page, force = false) {
    const sequence = ++loadingSequence.current;
    setError("");
    if (!needsShellSnapshot(scope)) return;
    const key = snapshotKey(cacheNamespace, scope);
    const cached = snapshotCache.get(key);
    if (cached) {
      setSnapshots((current) => ({ ...current, [key]: cached.data }));
      if (!force && Date.now() - cached.storedAt < SNAPSHOT_CACHE_TTL) return;
    }
    try {
      const json = await requestSnapshot(cacheNamespace, scope);
      if (sequence !== loadingSequence.current) return;
      setSnapshots((current) => ({ ...current, [key]: json }));
    } catch (reason) {
      if (sequence !== loadingSequence.current || (reason instanceof Error && reason.name === "AbortError")) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível carregar o ambiente.",
      );
    }
  }
  useEffect(() => {
    void load(page);
    return () => { loadingSequence.current++; };
  }, [page, cacheNamespace, snapshotRevision]);
  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);
  useEffect(() => {
    const navigation = navigationRef.current;
    if (!navigation) return;
    const stored = Number(
      readBrowserPreference("sessionStorage", "nalven.erp.navigation.scroll") || 0,
    );
    navigation.scrollTop = Number.isFinite(stored) ? stored : 0;
    const active = navigation.querySelector<HTMLAnchorElement>(
      "a[aria-current='page']",
    );
    if (active) {
      const navigationBox = navigation.getBoundingClientRect(),
        activeBox = active.getBoundingClientRect();
      if (
        activeBox.top < navigationBox.top ||
        activeBox.bottom > navigationBox.bottom
      )
        active.scrollIntoView({ block: "nearest" });
    }
  }, [initialPage, page]);
  async function action(payload: Record<string, unknown>, success: string) {
    if (actionPending.current) return false;
    const boundaryAction = [
      "create_product",
      "update_product",
      "toggle_product",
      "delete_product",
    ].includes(String(payload.action || ""));
    const logicalId = boundaryAction
      ? `${String(payload.action)}:${String(payload.id || (payload.product as { id?: unknown } | undefined)?.id || "new")}`
      : "";
    const signature = boundaryAction ? JSON.stringify(payload) : "";
    const previous = logicalId
      ? boundaryAttempts.current[logicalId]
      : undefined;
    const attempt = boundaryAction
      ? previous?.signature === signature
        ? previous
        : { signature, key: crypto.randomUUID() }
      : null;
    if (logicalId && attempt) boundaryAttempts.current[logicalId] = attempt;
    actionPending.current = true;
    // Supersede outstanding reads before committing an operation.
    const actionSequence = ++loadingSequence.current;
    const actionScope = page;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt ? { ...payload, idempotencyKey: attempt.key } : payload),
      });
      const json = await response.json();
      if (!response.ok) {
        if (actionSequence === loadingSequence.current) setError(json.error || "Não foi possível concluir.");
        return false;
      }
      if (logicalId) delete boundaryAttempts.current[logicalId];
      snapshotCache.invalidate(snapshotKey(cacheNamespace, "products"));
      snapshotCache.invalidate(snapshotKey(cacheNamespace, "stock"));
      snapshotCache.set(snapshotKey(cacheNamespace, actionScope), json);
      setSnapshots((current) => ({
        ...current,
        [snapshotKey(cacheNamespace, "products")]: undefined,
        [snapshotKey(cacheNamespace, "stock")]: undefined,
        [snapshotKey(cacheNamespace, actionScope)]: json,
      }));
      // Reload the visible scope if the operator navigated during the POST.
      setSnapshotRevision(value => value + 1);
      if (actionSequence === loadingSequence.current) {
        setNotice(success);
        window.setTimeout(() => setNotice(""), 2500);
      }
      return true;
    } catch {
      if (actionSequence === loadingSequence.current) setError("Conexão interrompida. Confira o resultado antes de tentar novamente.");
      return false;
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      window.location.replace("/login");
    } catch { setError("Não foi possível sair da conta. Verifique sua conexão e tente novamente."); }
    finally { setBusy(false); }
  }
  async function switchOrganization(organizationId: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) {
        const body = await response.json();
        return setError(body.error || "Não foi possível trocar de organização.");
      }
      setCompanyOpen(false);
      // A complete navigation discards all client caches from the previous company.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/erp");
    } catch { setError("Não foi possível trocar de organização. Verifique sua conexão e tente novamente."); }
    finally { setBusy(false); }
  }
  const current = erpModule(page);
  const data =
    snapshots[snapshotKey(cacheNamespace, page)] ||
    (needsShellSnapshot(page) ? undefined : EMPTY_SNAPSHOT);
  function prefetch(id: ErpPage) {
    router.prefetch(erpRoute(id));
    const cached = snapshotCache.get(snapshotKey(cacheNamespace, id));
    if (needsShellSnapshot(id) && !cached)
      void requestSnapshot(cacheNamespace, id).catch(() => undefined);
  }
  function navigate(event: ReactMouseEvent<HTMLAnchorElement>, id: ErpPage) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (navigationRef.current)
      writeBrowserPreference("sessionStorage",
        "nalven.erp.navigation.scroll",
        String(navigationRef.current.scrollTop),
      );
    loadingSequence.current++;
    setError("");
    setNotice("");
    setPage(id);
    setMobile(false);
  }
  return (
    <PlanFeatures.Provider value={{services:allowedPages.includes("service-orders"),marketplaces:allowedPages.includes("marketplaces")}}><div
      className={`tenant-shell sidebar-${sidebar} density-${organization.interfaceDensity}`}
      style={
        { "--tenant-accent": organization.accentColor } as React.CSSProperties
      }
    >
      <aside id="erp-navigation" ref={sidebarRef} className={mobile ? "open" : ""} inert={mobileScreen ? !mobile : sidebar === "hidden"} role={mobileScreen && mobile ? "dialog" : undefined} aria-modal={mobileScreen && mobile ? true : undefined} aria-label="Menu principal">
        <header>
          <span
            className={
              organization.logoMediaId
                ? "tenant-brand-media"
                : "tenant-brand-default"
            }
          >
            <img
              src={
                organization.logoMediaId
                  ? `/api/erp/library/${organization.logoMediaId}/file`
                  : "/favicon.svg"
              }
              alt={
                organization.logoMediaId
                  ? `Logotipo de ${organization.name}`
                  : "NALVEN"
              }
            />
          </span>
          <div>
            <strong>NALVEN</strong>
            <small>Gestão empresarial</small>
          </div>
          <button
            className="tenant-mobile-close"
            onClick={() => setMobile(false)}
            aria-label="Fechar menu"
          >
            <ErpIcon name="close" />
          </button>
          <button
            className="tenant-collapse-control"
            onClick={() =>
              changeSidebar(sidebar === "expanded" ? "compact" : "expanded")
            }
            aria-label={
              sidebar === "expanded" ? "Recolher menu" : "Expandir menu"
            }
          >
            <ErpIcon name={sidebar === "expanded" ? "collapse" : "expand"} />
          </button>
        </header>
        <div className="tenant-company-wrap">
          <button
            className="tenant-company"
            onClick={() => setCompanyOpen((value) => !value)}
          >
            <b>{organization.name.slice(0, 2).toUpperCase()}</b>
            <div>
              <strong>{organization.name}</strong>
              <small>
                {organization.status === "trial"
                  ? `Teste até ${date(organization.trialEndsAt)}`
                  : organization.status}
              </small>
            </div>
            <i>{organizations.length > 1 ? "⌄" : ""}</i>
          </button>
          {companyOpen && organizations.length > 1 && (
            <div className="tenant-company-popover">
              {organizations.map((item) => (
                <button
                  className={item.id === organization.id ? "active" : ""}
                  disabled={busy || item.id === organization.id}
                  onClick={() => switchOrganization(item.id)}
                  key={item.id}
                >
                  <b>{item.name.slice(0, 2).toUpperCase()}</b>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{roleDisplay(item.role)}</small>
                  </span>
                  {item.id === organization.id && <i>✓</i>}
                </button>
              ))}
            </div>
          )}
        </div>
        <nav
          ref={navigationRef}
          onScroll={(event) =>
            writeBrowserPreference("sessionStorage",
              "nalven.erp.navigation.scroll",
              String(event.currentTarget.scrollTop),
            )
          }
        >
          {ERP_SECTIONS.map((section) => {
            const modules = ERP_MODULES.filter(
              (item) =>
                item.section === section && allowedPages.includes(item.id),
            );
            return modules.length ? (
              <section key={section}>
                <small>{section}</small>
                {modules.map((item) => (
                  <Link
                    href={erpRoute(item.id)}
                    className={page === item.id ? "active" : ""}
                    aria-current={page === item.id ? "page" : undefined}
                    title={sidebar === "compact" ? item.label : undefined}
                    onClick={(event) => navigate(event, item.id)}
                    onMouseEnter={() => prefetch(item.id)}
                    onFocus={() => prefetch(item.id)}
                    key={item.id}
                  >
                    <i>
                      <ErpIcon name={item.id} />
                    </i>
                    <span>{item.id === "products" && !allowedPages.includes("service-orders") ? "Produtos" : item.label}</span>
                  </Link>
                ))}
              </section>
            ) : null;
          })}
        </nav>
        <footer>
          <div className="tenant-aside-identity">
            <span>{user.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
          </div>
          <div className="tenant-aside-actions">
            <Link href="/portal" title="Minha conta" aria-label="Minha conta">
              <ErpIcon name="account" />
              <span>Conta</span>
            </Link>
            <Link
              href="/portal?area=suporte"
              title="Suporte"
              aria-label="Suporte"
            >
              <ErpIcon name="support" />
              <span>Suporte</span>
            </Link>
            <button
              className="tenant-aside-logout"
              onClick={logout}
              title="Sair da conta"
              aria-label="Sair da conta"
            >
              <ErpIcon name="logout" />
              <span>Sair</span>
            </button>
          </div>
        </footer>
      </aside>
      <main inert={mobileScreen && mobile}>
        <header>
          <button
            className="tenant-menu"
            onClick={() => setMobile(true)}
            aria-label="Abrir menu"
            aria-expanded={mobile}
            aria-controls="erp-navigation"
          >
            <ErpIcon name="menu" />
          </button>
          <button
            className="tenant-desktop-menu"
            onClick={() =>
              changeSidebar(sidebar === "hidden" ? "expanded" : "hidden")
            }
            aria-label={
              sidebar === "hidden"
                ? "Abrir menu lateral"
                : "Fechar menu lateral"
            }
          >
            <ErpIcon name={sidebar === "hidden" ? "expand" : "collapse"} />
          </button>
          <div>
            <small>
              {current.section} ·{" "}
              {organization.activeBranch
                ? `${organization.activeBranch.name} (${organization.activeBranch.code})`
                : "FILIAL NÃO SELECIONADA"}
            </small>
            <h1>{current.id === "products" && !allowedPages.includes("service-orders") ? "Produtos" : current.title}</h1>
          </div>
          <div className="tenant-user-wrap">
            <button
              className="tenant-user"
              onClick={() => setUserOpen((value) => !value)}
            >
              <span>
                <ErpIcon name="account" />
              </span>
              <div>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </div>
              <i>⌄</i>
            </button>
            {userOpen && (
              <div className="tenant-user-popover">
                <div>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </div>
                <Link href="/portal">Minha conta</Link>
                <Link href="/portal?area=suporte">Suporte e financeiro</Link>
                {allowedPages.includes("users") && (
                  <Link href={erpRoute("users")}>Usuários e acessos</Link>
                )}
                <button onClick={logout}>Sair da conta</button>
              </div>
            )}
          </div>
        </header>
        <div className="tenant-content">
          {notice && <div className="tenant-notice">{notice}</div>}
          {error && (
            <div className="tenant-error">
              {error}
              <button onClick={() => load()}>Tentar novamente</button>
            </div>
          )}
          {!data ? (
            <div className="tenant-loading">
              Carregando dados do banco da organização…
            </div>
          ) : (
            <PageContent
              key={cacheNamespace}
              page={page}
              data={data}
              action={action}
              busy={busy}
              organizationId={cacheNamespace}
            />
          )}
        </div>
        <footer>
          © 2026 NALVEN · Dados operacionais isolados no PostgreSQL desta
          organização
        </footer>
      </main>
      {mobile && (
        <button className="tenant-scrim" tabIndex={-1} aria-label="Fechar menu lateral" onClick={() => setMobile(false)} />
      )}
    </div></PlanFeatures.Provider>
  );
}

function PageContent({
  page,
  data,
  action,
  busy,
  organizationId,
}: {
  page: ErpPage;
  data: Snapshot;
  action: (
    payload: Record<string, unknown>,
    success: string,
  ) => Promise<boolean>;
  busy: boolean;
  organizationId: string;
}) {
  if (page === "dashboard") return <BusinessIntelligenceDashboard />;
  if (page === "products")
    return <Products data={data} action={action} busy={busy} />;
  if (page === "stock")
    return <Stock data={data} action={action} busy={busy} />;
  if (page === "pdv") return <PdvWorkspace />;
  if (page === "pos-settings") return <PdvSettingsPage />;
  if (page === "sales") return <SalesExpenses />;
  if (page === "reports") return <ReportsCenter />;
  if (page === "library") return <MediaLibrary />;
  if (page === "customers") return <CustomerCenter />;
  if (page === "categories") return <CategoryCenter />;
  if (page === "suppliers") return <SupplierCenter />;
  if (page === "purchases")
    return (
      <OperationsSuiteFrame module="purchases">
        <Purchases cacheNamespace={organizationId} />
      </OperationsSuiteFrame>
    );
  if (page === "finance") return <FinanceControlCenter />;
  if (page === "inventory")
    return (
      <OperationsSuiteFrame module="inventory">
        <Inventory cacheNamespace={organizationId} />
      </OperationsSuiteFrame>
    );
  if (page === "activities") return <AuditActivityCenter />;
  if (page === "users") return <UserAccessCenter />;
  if (page === "branches") return <CompanyBranchCenter />;
  if (page === "settings") return <SettingsControlCenter />;
  if (page === "orders")
    return (
      <OperationsSuiteFrame module="orders">
        <OrderManagement />
      </OperationsSuiteFrame>
    );
  if (page === "service-orders")
    return (
      <OperationsSuiteFrame module="service-orders">
        <ServiceOrders cacheNamespace={organizationId} />
      </OperationsSuiteFrame>
    );
  if (page === "invoices") return <NfeInputWorkspace />;
  if (page === "crm")
    return (
      <OperationsSuiteFrame module="crm">
        <Crm cacheNamespace={organizationId} />
      </OperationsSuiteFrame>
    );
  if (page === "contracts")
    return (
      <OperationsSuiteFrame module="contracts">
        <Contracts cacheNamespace={organizationId} />
      </OperationsSuiteFrame>
    );
  if (page === "production")
    return (
      <OperationsSuiteFrame module="production">
        <Production cacheNamespace={organizationId} />
      </OperationsSuiteFrame>
    );
  if (page === "marketplaces")
    return <OmnichannelMarketplaces cacheNamespace={organizationId} />;
  if (page === "logistics")
    return <OmnichannelLogistics cacheNamespace={organizationId} />;
  if (page === "accounts") return <AccountsControlCenter />;
  if (page === "cash-close") return <CashCloseControlCenter />;
  if (page === "reconciliation") return <BankReconciliationCenter />;
  if (page === "planning") return <PlanningControlCenter />;
  if (page === "fiscal") return <FiscalCenter />;
  if (page === "automations") return <Automations />;
  if (page === "privacy") return <PrivacyGovernanceCenter />;
  if (page === "integrations") return <IntegrationCenter />;
  if (page === "payments") return <PaymentCenter />;
  if (page === "transactional-email") return <TransactionalEmailCenter />;
  if (page === "ai-integrations") return <AiIntegrationCenter />;
  return null;
}

function Customers() {
  const [items, setItems] = useState<Customer[]>([]),
    [summary, setSummary] = useState({ total: 0, active: 0, creditLimit: 0 }),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Customer>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setError("");
    const params = new URLSearchParams({ limit: "100" });
    if (query) params.set("search", query);
    if (status) params.set("status", status);
    const response = await fetch(`/api/erp/customers?${params}`, {
      cache: "no-store",
    });
    const body = await response.json();
    if (response.ok) {
      setItems(body.items);
      setSummary(body.summary);
    } else setError(body.error || "Não foi possível carregar os clientes.");
  }
  useEffect(() => {
    load();
  }, []);
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await load();
  }
  function edit(customer?: Customer) {
    setEditing(customer);
    setOpen(true);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const payload = Object.fromEntries(new FormData(e.currentTarget));
    const response = await fetch(
      editing ? `/api/erp/customers/${editing.id}` : "/api/erp/customers",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const body = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(body.error || "Não foi possível salvar o cliente.");
    setOpen(false);
    setEditing(undefined);
    await load();
  }
  async function toggle(customer: Customer) {
    setBusy(true);
    const response = await fetch(`/api/erp/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "status",
        status: customer.status === "active" ? "inactive" : "active",
      }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(body.error || "Não foi possível alterar o status.");
    await load();
  }
  return (
    <div className="erp-customers">
      <section className="tenant-kpis">
        <Kpi
          label="Clientes cadastrados"
          value={String(summary.total)}
          detail="Banco desta organização"
        />
        <Kpi
          label="Clientes ativos"
          value={String(summary.active)}
          detail="Disponíveis para operação"
        />
        <Kpi
          label="Limite de crédito"
          value={money.format(summary.creditLimit)}
          detail="Total autorizado"
        />
        <Kpi
          label="Resultado filtrado"
          value={String(items.length)}
          detail="Registros exibidos"
        />
      </section>
      <form className="tenant-toolbar customer-toolbar" onSubmit={search}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar nome, CPF/CNPJ ou e-mail…"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
        </select>
        <button>Buscar</button>
        <button className="primary" type="button" onClick={() => edit()}>
          + Novo cliente
        </button>
      </form>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-panel tenant-table">
        <header>
          <h2>Clientes da organização</h2>
          <span>{items.length}</span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>CPF/CNPJ</th>
                <th>Contato</th>
                <th>Cidade</th>
                <th>Crédito</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {items.map((customer) => {
                const address = customer.addresses[0];
                return (
                  <tr key={customer.id}>
                    <td>
                      <strong>{customer.name}</strong>
                      <small>{customer.tradeName || customer.type}</small>
                    </td>
                    <td>{formatDocument(customer.document)}</td>
                    <td>
                      <strong>{customer.email || "—"}</strong>
                      <small>{formatPhone(customer.phone)}</small>
                    </td>
                    <td>
                      {[address?.city, address?.state]
                        .filter(Boolean)
                        .join(" / ") || "—"}
                    </td>
                    <td>{money.format(customer.creditLimit)}</td>
                    <td>
                      <span className={`customer-status ${customer.status}`}>
                        {customer.status === "active" ? "Ativo" : "Inativo"}
                      </span>
                    </td>
                    <td>
                      <div className="customer-actions">
                        <button onClick={() => edit(customer)}>Editar</button>
                        <button
                          disabled={busy}
                          onClick={() => toggle(customer)}
                        >
                          {customer.status === "active" ? "Inativar" : "Ativar"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!items.length && (
            <Empty text="Nenhum cliente encontrado para os filtros informados." />
          )}
        </div>
      </section>
      {open && (
        <CustomerModal
          customer={editing}
          busy={busy}
          close={() => {
            setOpen(false);
            setEditing(undefined);
          }}
          submit={submit}
        />
      )}
    </div>
  );
}
function CustomerModal({
  customer,
  busy,
  close,
  submit,
}: {
  customer?: Customer;
  busy: boolean;
  close: () => void;
  submit: (e: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const address = customer?.addresses[0];
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={submit}>
        <header>
          <div>
            <small>CADASTRO REAL DO TENANT</small>
            <h2>{customer ? "Editar cliente" : "Novo cliente"}</h2>
          </div>
          <button type="button" onClick={close} disabled={busy}>
            ×
          </button>
        </header>
        <label className="wide">
          Nome / razão social
          <input name="name" defaultValue={customer?.name || ""} required />
        </label>
        <label>
          Nome fantasia
          <input name="tradeName" defaultValue={customer?.tradeName || ""} />
        </label>
        <label>
          CPF ou CNPJ
          <input
            name="document"
            defaultValue={formatDocument(customer?.document)}
            required
          />
        </label>
        <label>
          E-mail
          <input
            name="email"
            type="email"
            defaultValue={customer?.email || ""}
          />
        </label>
        <label>
          Telefone
          <input name="phone" defaultValue={customer?.phone || ""} />
        </label>
        <label>
          Limite de crédito
          <input
            name="creditLimit"
            type="number"
            min="0"
            step="0.01"
            defaultValue={customer?.creditLimit || 0}
          />
        </label>
        <label>
          CEP
          <input name="zip" defaultValue={address?.zip || ""} />
        </label>
        <label className="wide">
          Logradouro
          <input name="street" defaultValue={address?.street || ""} />
        </label>
        <label>
          Número
          <input name="number" defaultValue={address?.number || ""} />
        </label>
        <label>
          Complemento
          <input name="complement" defaultValue={address?.complement || ""} />
        </label>
        <label>
          Bairro
          <input name="district" defaultValue={address?.district || ""} />
        </label>
        <label>
          Cidade
          <input name="city" defaultValue={address?.city || ""} />
        </label>
        <label>
          UF
          <input
            name="state"
            maxLength={2}
            defaultValue={address?.state || ""}
          />
        </label>
        <label className="wide">
          Observações
          <textarea name="notes" defaultValue={customer?.notes || ""} />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar cliente"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Categories() {
  const [items, setItems] = useState<Category[]>([]),
    [summary, setSummary] = useState({
      total: 0,
      active: 0,
      linkedProducts: 0,
    }),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Category>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setError("");
    const response = await fetch("/api/erp/categories", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) {
      setItems(body.items);
      setSummary(body.summary);
    } else setError(body.error || "Não foi possível carregar as categorias.");
  }
  useEffect(() => {
    load();
  }, []);
  function edit(category?: Category) {
    setEditing(category);
    setOpen(true);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const payload = Object.fromEntries(new FormData(e.currentTarget));
    const response = await fetch(
      editing ? `/api/erp/categories/${editing.id}` : "/api/erp/categories",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const body = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(body.error || "Não foi possível salvar a categoria.");
    setOpen(false);
    setEditing(undefined);
    await load();
  }
  async function toggle(category: Category) {
    setBusy(true);
    const response = await fetch(`/api/erp/categories/${category.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", active: !category.active }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(body.error || "Não foi possível alterar o status.");
    await load();
  }
  return (
    <div className="erp-catalog-register">
      <section className="tenant-kpis">
        <Kpi
          label="Categorias cadastradas"
          value={String(summary.total)}
          detail="Estrutura real do catálogo"
        />
        <Kpi
          label="Categorias ativas"
          value={String(summary.active)}
          detail="Disponíveis nos cadastros"
        />
        <Kpi
          label="Produtos vinculados"
          value={String(summary.linkedProducts)}
          detail="Relacionamentos normalizados"
        />
        <Kpi
          label="Sem produtos"
          value={String(
            items.filter((item) => item._count.products === 0).length,
          )}
          detail="Categorias para revisar"
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Organização do catálogo</strong>
          <small>Produtos, serviços e hierarquias</small>
        </div>
        <button className="primary" onClick={() => edit()}>
          + Nova categoria
        </button>
      </div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="category-grid">
        {items.map((category) => (
          <article className="category-card" key={category.id}>
            <i style={{ backgroundColor: category.color }} />
            <div>
              <header>
                <span>
                  {category.type === "product"
                    ? "PRODUTOS"
                    : category.type === "service"
                      ? "SERVIÇOS"
                      : "PRODUTOS E SERVIÇOS"}
                </span>
                <em
                  className={`customer-status ${category.active ? "active" : "inactive"}`}
                >
                  {category.active ? "Ativa" : "Inativa"}
                </em>
              </header>
              <h2>{category.name}</h2>
              <p>{category.description || "Sem descrição informada."}</p>
              <dl>
                <div>
                  <dt>Produtos</dt>
                  <dd>{category._count.products}</dd>
                </div>
                <div>
                  <dt>Subcategorias</dt>
                  <dd>{category._count.children}</dd>
                </div>
                <div>
                  <dt>Superior</dt>
                  <dd>{category.parent?.name || "Raiz"}</dd>
                </div>
              </dl>
              <footer>
                <button onClick={() => edit(category)}>Editar</button>
                <button disabled={busy} onClick={() => toggle(category)}>
                  {category.active ? "Inativar" : "Ativar"}
                </button>
              </footer>
            </div>
          </article>
        ))}
      </section>
      {!items.length && (
        <section className="tenant-panel">
          <Empty text="Nenhuma categoria cadastrada nesta organização." />
        </section>
      )}
      {open && (
        <CategoryModal
          category={editing}
          categories={items}
          busy={busy}
          close={() => {
            setOpen(false);
            setEditing(undefined);
          }}
          submit={submit}
        />
      )}
    </div>
  );
}

function CategoryModal({
  category,
  categories,
  busy,
  close,
  submit,
}: {
  category?: Category;
  categories: Category[];
  busy: boolean;
  close: () => void;
  submit: (e: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={submit}>
        <header>
          <div>
            <small>CATÁLOGO REAL DO TENANT</small>
            <h2>{category ? "Editar categoria" : "Nova categoria"}</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Nome
          <input name="name" defaultValue={category?.name || ""} required />
        </label>
        <label>
          Aplicação
          <select name="type" defaultValue={category?.type || "both"}>
            <option value="both">Produtos e serviços</option>
            <option value="product">Somente produtos</option>
            <option value="service">Somente serviços</option>
          </select>
        </label>
        <label>
          Cor
          <input
            name="color"
            type="color"
            defaultValue={category?.color || "#168151"}
          />
        </label>
        <label className="wide">
          Categoria superior
          <select name="parentId" defaultValue={category?.parentId || ""}>
            <option value="">Nenhuma · categoria raiz</option>
            {categories
              .filter((item) => item.id !== category?.id)
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label className="wide">
          Descrição
          <textarea
            name="description"
            defaultValue={category?.description || ""}
          />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar categoria"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Suppliers() {
  const [items, setItems] = useState<Supplier[]>([]),
    [summary, setSummary] = useState({
      total: 0,
      active: 0,
      linkedProducts: 0,
    }),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Supplier>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setError("");
    const params = new URLSearchParams();
    if (query) params.set("search", query);
    if (status) params.set("status", status);
    const response = await fetch(`/api/erp/suppliers?${params}`, {
      cache: "no-store",
    });
    const body = await response.json();
    if (response.ok) {
      setItems(body.items);
      setSummary(body.summary);
    } else setError(body.error || "Não foi possível carregar os fornecedores.");
  }
  useEffect(() => {
    load();
  }, []);
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await load();
  }
  function edit(supplier?: Supplier) {
    setEditing(supplier);
    setOpen(true);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const payload = Object.fromEntries(new FormData(e.currentTarget));
    const response = await fetch(
      editing ? `/api/erp/suppliers/${editing.id}` : "/api/erp/suppliers",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const body = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(body.error || "Não foi possível salvar o fornecedor.");
    setOpen(false);
    setEditing(undefined);
    await load();
  }
  async function toggle(supplier: Supplier) {
    setBusy(true);
    const response = await fetch(`/api/erp/suppliers/${supplier.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "status",
        status: supplier.status === "active" ? "inactive" : "active",
      }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(body.error || "Não foi possível alterar o status.");
    await load();
  }
  return (
    <div className="erp-suppliers">
      <section className="tenant-kpis">
        <Kpi
          label="Fornecedores"
          value={String(summary.total)}
          detail="Banco desta organização"
        />
        <Kpi
          label="Fornecedores ativos"
          value={String(summary.active)}
          detail="Disponíveis para compras"
        />
        <Kpi
          label="Itens vinculados"
          value={String(summary.linkedProducts)}
          detail="Catálogo de fornecimento"
        />
        <Kpi
          label="Resultado filtrado"
          value={String(items.length)}
          detail="Registros exibidos"
        />
      </section>
      <form className="tenant-toolbar customer-toolbar" onSubmit={search}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar razão social, CNPJ ou e-mail…"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
        </select>
        <button>Buscar</button>
        <button className="primary" type="button" onClick={() => edit()}>
          + Novo fornecedor
        </button>
      </form>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-panel tenant-table">
        <header>
          <h2>Fornecedores da organização</h2>
          <span>{items.length}</span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fornecedor</th>
                <th>CNPJ</th>
                <th>Contato principal</th>
                <th>Condição</th>
                <th>Itens</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {items.map((supplier) => {
                const contact = supplier.contacts[0];
                return (
                  <tr key={supplier.id}>
                    <td>
                      <strong>{supplier.tradeName || supplier.name}</strong>
                      <small>{supplier.name}</small>
                    </td>
                    <td>{formatDocument(supplier.document)}</td>
                    <td>
                      <strong>{contact?.name || supplier.email || "—"}</strong>
                      <small>
                        {contact?.email ||
                          formatPhone(contact?.phone || supplier.phone)}
                      </small>
                    </td>
                    <td>{supplier.paymentTerms || "Não informada"}</td>
                    <td>
                      <strong>{supplier._count.products}</strong>
                      <small>
                        {
                          supplier.products.filter((item) => item.preferred)
                            .length
                        }{" "}
                        preferenciais
                      </small>
                    </td>
                    <td>
                      <span className={`customer-status ${supplier.status}`}>
                        {supplier.status === "active" ? "Ativo" : "Inativo"}
                      </span>
                    </td>
                    <td>
                      <div className="customer-actions">
                        <button onClick={() => edit(supplier)}>Editar</button>
                        <button
                          disabled={busy}
                          onClick={() => toggle(supplier)}
                        >
                          {supplier.status === "active" ? "Inativar" : "Ativar"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!items.length && (
            <Empty text="Nenhum fornecedor encontrado para os filtros informados." />
          )}
        </div>
      </section>
      {open && (
        <SupplierModal
          supplier={editing}
          busy={busy}
          close={() => {
            setOpen(false);
            setEditing(undefined);
          }}
          submit={submit}
        />
      )}
    </div>
  );
}

function SupplierModal({
  supplier,
  busy,
  close,
  submit,
}: {
  supplier?: Supplier;
  busy: boolean;
  close: () => void;
  submit: (e: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const contact = supplier?.contacts[0];
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={submit}>
        <header>
          <div>
            <small>SUPRIMENTOS REAIS DO TENANT</small>
            <h2>{supplier ? "Editar fornecedor" : "Novo fornecedor"}</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Razão social
          <input name="name" defaultValue={supplier?.name || ""} required />
        </label>
        <label>
          Nome fantasia
          <input name="tradeName" defaultValue={supplier?.tradeName || ""} />
        </label>
        <label>
          CNPJ
          <input
            name="document"
            defaultValue={formatDocument(supplier?.document)}
            required
          />
        </label>
        <label>
          E-mail da empresa
          <input
            name="email"
            type="email"
            defaultValue={supplier?.email || ""}
          />
        </label>
        <label>
          Telefone da empresa
          <input name="phone" defaultValue={supplier?.phone || ""} />
        </label>
        <label className="wide">
          Condição de pagamento
          <input
            name="paymentTerms"
            defaultValue={supplier?.paymentTerms || ""}
            placeholder="Ex.: 28/42 dias"
          />
        </label>
        <label>
          Contato principal
          <input name="contactName" defaultValue={contact?.name || ""} />
        </label>
        <label>
          Cargo / área
          <input name="contactRole" defaultValue={contact?.role || ""} />
        </label>
        <label>
          E-mail do contato
          <input
            name="contactEmail"
            type="email"
            defaultValue={contact?.email || ""}
          />
        </label>
        <label>
          Telefone do contato
          <input name="contactPhone" defaultValue={contact?.phone || ""} />
        </label>
        <label className="wide">
          Observações
          <textarea name="notes" defaultValue={supplier?.notes || ""} />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar fornecedor"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Purchases({ cacheNamespace }: { cacheNamespace: string }) {
  const endpoint = "/api/erp/purchases";
  const [data, setData] = useState<PurchaseCatalog | undefined>(() =>
      cachedViewData<PurchaseCatalog>(cacheNamespace, endpoint),
    ),
    [view, setView] = useState<"quotations" | "orders">("quotations"),
    [open, setOpen] = useState(false),
    [receiving, setReceiving] = useState<PurchaseOrder>(),
    [quotationOpen, setQuotationOpen] = useState(false),
    [offerFor, setOfferFor] = useState<any>(),
    [awardOffer, setAwardOffer] = useState<any>(),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setError("");
    const response = await fetch(endpoint, { cache: "no-store" });
    const body = await response.json();
    if (response.ok) {
      cacheViewData(cacheNamespace, endpoint, body);
      setData(body);
    } else setError(body.error || "Não foi possível carregar as compras.");
  }
  useEffect(() => {
    load();
  }, []);
  async function create(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/purchases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível criar o pedido.");
      return;
    }
    setOpen(false);
    setNotice("Pedido criado como rascunho.");
    await load();
  }
  async function quotationCommand(
    payload: Record<string, unknown>,
    success: string,
  ) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/purchases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível atualizar a cotação.");
      return false;
    }
    setNotice(success);
    setQuotationOpen(false);
    setOfferFor(undefined);
    setAwardOffer(undefined);
    await load();
    return true;
  }
  async function command(
    order: PurchaseOrder,
    action: string,
    payload: Record<string, unknown> = {},
  ) {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/erp/purchases/${order.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível atualizar o pedido.");
      return false;
    }
    setNotice(
      action === "receive"
        ? "Recebimento concluído: estoque, custo e conta a pagar atualizados."
        : action === "submit"
          ? "Pedido enviado ao fornecedor."
          : "Pedido cancelado.",
    );
    setReceiving(undefined);
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">
        Carregando pedidos, fornecedores e produtos…
      </div>
    );
  const term = search.trim().toLocaleLowerCase("pt-BR"),
    visibleItems = data.items.filter(
      (order) =>
        (!status || order.status === status) &&
        (!term ||
          `${order.number} ${order.supplier.name} ${order.supplier.tradeName || ""}`
            .toLocaleLowerCase("pt-BR")
            .includes(term)),
    ),
    visibleQuotations = data.quotations.filter(
      (quotation: any) =>
        (!status || quotation.status === status) &&
        (!term ||
          `${quotation.number} ${quotation.title} ${quotation.notes || ""}`
            .toLocaleLowerCase("pt-BR")
            .includes(term)),
    );
  return (
    <div className="erp-purchases">
      {notice && <div className="tenant-notice">{notice}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Cotações abertas"
          value={String(data.summary.openQuotations)}
          detail={`${data.summary.overdueQuotations} com prazo vencido`}
          alert={data.summary.overdueQuotations > 0}
        />
        <Kpi
          label="Rascunhos"
          value={String(data.summary.drafts)}
          detail="Aguardando envio"
        />
        <Kpi
          label="A receber"
          value={String(data.summary.awaitingReceipt)}
          detail="Pedidos em trânsito"
        />
        <Kpi
          label="Valor comprometido"
          value={money.format(data.summary.committed)}
          detail="Exceto cancelados"
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Fluxo de suprimentos</strong>
          <small>Pedido → recebimento → estoque → conta a pagar</small>
        </div>
        <div>
          <button onClick={() => setQuotationOpen(true)}>+ Nova cotação</button>
          <button className="primary" onClick={() => setOpen(true)}>
            + Novo pedido
          </button>
        </div>
      </div>
      <nav className="supply-view-tabs" aria-label="Visões de compras">
        <button
          className={view === "quotations" ? "active" : ""}
          onClick={() => {
            setView("quotations");
            setStatus("");
          }}
        >
          <span>Cotações</span>
          <b>{data.quotations.length}</b>
        </button>
        <button
          className={view === "orders" ? "active" : ""}
          onClick={() => {
            setView("orders");
            setStatus("");
          }}
        >
          <span>Pedidos de compra</span>
          <b>{data.items.length}</b>
        </button>
      </nav>
      <SuiteListFilter
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        placeholder={
          view === "quotations"
            ? "Buscar cotação, título ou observação"
            : "Buscar pedido ou fornecedor"
        }
        options={
          view === "quotations"
            ? [
                ["open", "Em cotação"],
                ["awarded", "Adjudicadas"],
                ["cancelled", "Canceladas"],
              ]
            : [
                ["draft", "Rascunhos"],
                ["ordered", "A receber"],
                ["partially_received", "Recebimento parcial"],
                ["received", "Recebidos"],
                ["cancelled", "Cancelados"],
              ]
        }
      />
      {error && <div className="tenant-error">{error}</div>}
      {view === "quotations" && (
        <section className="purchase-list quotation-list">
          {visibleQuotations.map((quotation: any) => {
            const bestOffer = quotation.offers.length
              ? Math.min(...quotation.offers.map((offer: any) => offer.total))
              : null;
            const highestOffer = quotation.offers.length
              ? Math.max(...quotation.offers.map((offer: any) => offer.total))
              : null;
            const overdue = quotation.isOverdue;
            return (
              <article className="purchase-card" key={quotation.id}>
                <header>
                  <div>
                    <span>{quotation.number}</span>
                    <h2>{quotation.title}</h2>
                  </div>
                  <em
                    className={`purchase-status ${quotation.status === "awarded" ? "received" : quotation.status === "cancelled" ? "cancelled" : overdue ? "late" : "ordered"}`}
                  >
                    {quotation.status === "awarded"
                      ? "Adjudicada"
                      : quotation.status === "cancelled"
                        ? "Cancelada"
                        : overdue
                          ? "Prazo vencido"
                          : "Em cotação"}
                  </em>
                </header>
                <div className="purchase-meta">
                  <span>
                    <small>Prazo</small>
                    <strong>{shortDate(quotation.deadlineAt)}</strong>
                  </span>
                  <span>
                    <small>Itens</small>
                    <strong>{quotation.items.length}</strong>
                  </span>
                  <span>
                    <small>Propostas</small>
                    <strong>{quotation.offers.length}</strong>
                  </span>
                  <span>
                    <small>Melhor valor</small>
                    <strong>
                      {bestOffer === null ? "—" : money.format(bestOffer)}
                    </strong>
                  </span>
                </div>
                {bestOffer !== null &&
                  highestOffer !== null &&
                  highestOffer > bestOffer && (
                    <div className="supply-insight">
                      <strong>
                        Economia potencial de{" "}
                        {money.format(highestOffer - bestOffer)}
                      </strong>
                      <span>entre a maior e a menor proposta recebida</span>
                    </div>
                  )}
                <div className="purchase-items">
                  {quotation.items.map((item: any) => (
                    <div key={item.id}>
                      <span>
                        <strong>{item.product.name}</strong>
                        <small>{item.product.sku}</small>
                      </span>
                      <b>
                        {numberValue(item.quantity)} {item.product.unit}
                      </b>
                    </div>
                  ))}
                </div>
                {quotation.offers.length > 0 && (
                  <div className="quotation-offers">
                    {quotation.offers.map((offer: any) => (
                      <div
                        className={offer.selected ? "selected" : ""}
                        key={offer.id}
                      >
                        <span>
                          <strong>
                            {offer.supplier.tradeName || offer.supplier.name}
                          </strong>
                          <small>
                            {offer.paymentTerms || "Condição não informada"} ·{" "}
                            {offer.leadTimeDays} dia(s) · frete{" "}
                            {money.format(offer.freight || 0)} · desconto{" "}
                            {money.format(offer.discount || 0)}
                          </small>
                        </span>
                        <b>
                          <small>Total entregue</small>
                          {money.format(offer.total)}
                        </b>
                        {quotation.status === "open" && (
                          <button
                            disabled={busy}
                            onClick={() => setAwardOffer({ quotation, offer })}
                          >
                            Escolher
                          </button>
                        )}
                        {offer.selected && <em>Selecionada</em>}
                      </div>
                    ))}
                  </div>
                )}
                <footer>
                  <small>
                    {quotation.purchaseOrder
                      ? `Pedido ${quotation.purchaseOrder.number} gerado a partir desta adjudicação.`
                      : quotation.notes ||
                        "Compare preço, prazo e condição antes da adjudicação."}
                  </small>
                  {quotation.status === "open" && (
                    <div>
                      <button
                        disabled={busy}
                        onClick={() =>
                          quotationCommand(
                            {
                              action: "quotation.cancel",
                              quotationId: quotation.id,
                            },
                            "Cotação cancelada.",
                          )
                        }
                      >
                        Cancelar
                      </button>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => setOfferFor(quotation)}
                      >
                        + Registrar proposta
                      </button>
                    </div>
                  )}
                </footer>
              </article>
            );
          })}
        </section>
      )}
      {view === "quotations" && !visibleQuotations.length && (
        <section className="tenant-panel">
          <Empty
            text={
              data.quotations.length
                ? "Nenhuma cotação corresponde aos filtros."
                : "Nenhuma cotação cadastrada."
            }
          />
        </section>
      )}
      {view === "orders" && (
        <section className="purchase-list">
          {visibleItems.map((order) => (
            <article className="purchase-card" key={order.id}>
              <header>
                <div>
                  <span>{order.number}</span>
                  <h2>{order.supplier.tradeName || order.supplier.name}</h2>
                </div>
                <em className={`purchase-status ${order.status}`}>
                  {purchaseStatus(order.status)}
                </em>
              </header>
              <div className="purchase-meta order-meta">
                <span>
                  <small>Total</small>
                  <strong>{money.format(order.total)}</strong>
                </span>
                <span>
                  <small>Previsão</small>
                  <strong>{shortDate(order.expectedAt)}</strong>
                </span>
                <span>
                  <small>Vencimento</small>
                  <strong>{shortDate(order.dueAt)}</strong>
                </span>
                <span>
                  <small>Recebimentos</small>
                  <strong>{order.receipts.length}</strong>
                </span>
              </div>
              <div className="purchase-items">
                {order.items.map((item) => {
                  const remaining = Math.max(
                    0,
                    item.quantity - item.receivedQuantity,
                  );
                  return (
                    <div key={item.id}>
                      <span>
                        <strong>{item.product.name}</strong>
                        <small>
                          {item.variation?.sku || item.product.sku}{item.variationId ? ` · Variação ${item.variationId}` : ""} · {money.format(item.unitCost)}/
                          {item.product.unit}
                        </small>
                      </span>
                      <span>
                        <b>
                          {item.receivedQuantity} / {item.quantity}{" "}
                          {item.product.unit}
                        </b>
                        <small>
                          {remaining ? `${remaining} pendente` : "Recebido"}
                        </small>
                      </span>
                    </div>
                  );
                })}
              </div>
              <footer>
                <small>Criado em {dateTime(order.createdAt)}</small>
                <div>
                  {order.status === "draft" && (
                    <button
                      disabled={busy}
                      onClick={() => command(order, "submit")}
                    >
                      Enviar pedido
                    </button>
                  )}
                  {["ordered", "partially_received"].includes(order.status) && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => setReceiving(order)}
                    >
                      Registrar recebimento
                    </button>
                  )}
                  {["draft", "ordered"].includes(order.status) && (
                    <button
                      disabled={busy}
                      onClick={() => command(order, "cancel")}
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </footer>
            </article>
          ))}
        </section>
      )}
      {view === "orders" && !visibleItems.length && (
        <section className="tenant-panel">
          <Empty
            text={
              data.items.length
                ? "Nenhum pedido corresponde aos filtros."
                : "Nenhum pedido de compra cadastrado."
            }
          />
        </section>
      )}
      {open && (
        <PurchaseModal
          catalog={data}
          busy={busy}
          close={() => setOpen(false)}
          submit={create}
        />
      )}{" "}
      {quotationOpen && (
        <PurchaseQuotationModal
          catalog={data}
          busy={busy}
          close={() => setQuotationOpen(false)}
          submit={(payload) =>
            quotationCommand(
              { action: "quotation.create", ...payload },
              "Cotação aberta e pronta para receber propostas.",
            )
          }
        />
      )}{" "}
      {offerFor && (
        <PurchaseQuotationOfferModal
          quotation={offerFor}
          suppliers={data.suppliers}
          busy={busy}
          close={() => setOfferFor(undefined)}
          submit={(payload) =>
            quotationCommand(
              {
                action: "quotation.offer",
                quotationId: offerFor.id,
                ...payload,
              },
              "Proposta registrada na cotação.",
            )
          }
        />
      )}{" "}
      {awardOffer && (
        <PurchaseQuotationAwardModal
          selection={awardOffer}
          busy={busy}
          close={() => setAwardOffer(undefined)}
          submit={(payload) =>
            quotationCommand(
              {
                action: "quotation.select",
                offerId: awardOffer.offer.id,
                ...payload,
              },
              "Proposta escolhida e pedido de compra gerado como rascunho.",
            )
          }
        />
      )}{" "}
      {receiving && (
        <PurchaseReceiptDialog
          order={receiving}
          warehouses={data.warehouses || []}
          close={() => setReceiving(undefined)}
          onSuccess={() => { setReceiving(undefined); setNotice("Recebimento concluído: estoque, custo médio e conta a pagar atualizados."); void load(); }}
        />
      )}
    </div>
  );
}

function PurchaseModal({
  catalog,
  busy,
  close,
  submit,
}: {
  catalog: PurchaseCatalog;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [rows, setRows] = useState<
    Array<{ productId: string; quantity: string; unitCost: string }>
  >([{ productId: "", quantity: "1", unitCost: "0" }]);
  function update(index: number, patch: Partial<(typeof rows)[number]>) {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  }
  function selectProduct(index: number, productId: string) {
    const product = catalog.products.find(
      (item) => item.id === Number(productId),
    );
    update(index, { productId, unitCost: String(product?.cost || 0) });
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget));
    await submit({
      ...form,
      items: rows
        .filter((row) => row.productId)
        .map((row) => ({
          productId: Number(row.productId),
          quantity: Number(row.quantity),
          unitCost: Number(row.unitCost),
        })),
    });
  }
  const subtotal = rows.reduce(
    (sum, row) =>
      sum + (Number(row.quantity) || 0) * (Number(row.unitCost) || 0),
    0,
  );
  return (
    <div className="tenant-modal purchase-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>PEDIDO REAL DA ORGANIZAÇÃO</small>
            <h2>Novo pedido de compra</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Fornecedor
          <select name="supplierId" required>
            <option value="">Selecione um fornecedor ativo</option>
            {catalog.suppliers.map((item) => (
              <option value={item.id} key={item.id}>
                {item.tradeName || item.name} · {formatDocument(item.document)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Previsão de entrega
          <input name="expectedAt" type="date" />
        </label>
        <label>
          Vencimento
          <input name="dueAt" type="date" required />
        </label>
        <section className="purchase-lines wide">
          <header>
            <strong>Produtos do pedido</strong>
            <button
              type="button"
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { productId: "", quantity: "1", unitCost: "0" },
                ])
              }
            >
              + Adicionar item
            </button>
          </header>
          {rows.map((row, index) => (
            <div key={index}>
              <select
                value={row.productId}
                onChange={(event) => selectProduct(index, event.target.value)}
                required
              >
                <option value="">Selecione o produto</option>
                {catalog.products.map((product) => (
                  <option value={product.id} key={product.id}>
                    {product.name} · {product.sku}
                  </option>
                ))}
              </select>
              <input
                aria-label="Quantidade"
                type="number"
                min="0.0001"
                step="0.0001"
                value={row.quantity}
                onChange={(event) =>
                  update(index, { quantity: event.target.value })
                }
                required
              />
              <input
                aria-label="Custo unitário"
                type="number"
                min="0"
                step="0.01"
                value={row.unitCost}
                onChange={(event) =>
                  update(index, { unitCost: event.target.value })
                }
                required
              />
              <button
                type="button"
                disabled={rows.length === 1}
                onClick={() =>
                  setRows((current) =>
                    current.filter((_, rowIndex) => rowIndex !== index),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </section>
        <label>
          Frete
          <input
            name="freight"
            type="number"
            min="0"
            step="0.01"
            defaultValue="0"
          />
        </label>
        <label>
          Desconto
          <input
            name="discount"
            type="number"
            min="0"
            step="0.01"
            defaultValue="0"
          />
        </label>
        <label className="wide">
          Observações
          <textarea name="notes" />
        </label>
        <div className="purchase-total wide">
          <span>Subtotal dos itens</span>
          <strong>{money.format(subtotal)}</strong>
        </div>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button
            className="primary"
            disabled={
              busy || !catalog.suppliers.length || !catalog.products.length
            }
          >
            {busy ? "Salvando…" : "Criar pedido"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function PurchaseQuotationModal({
  catalog,
  busy,
  close,
  submit,
}: {
  catalog: PurchaseCatalog;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [rows, setRows] = useState([{ productId: "", quantity: "1" }]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit({
      ...Object.fromEntries(new FormData(event.currentTarget)),
      items: rows.map((row) => ({
        productId: Number(row.productId),
        quantity: Number(row.quantity),
      })),
    });
  }
  return (
    <div className="tenant-modal purchase-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>MAPA DE PREÇOS E PRAZOS</small>
            <h2>Nova cotação</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Título
          <input
            name="title"
            minLength={2}
            maxLength={180}
            required
            placeholder="Ex.: Reposição de insumos de setembro"
          />
        </label>
        <label>
          Prazo para respostas
          <input name="deadlineAt" type="date" />
        </label>
        <section className="purchase-lines wide">
          <header>
            <strong>Itens solicitados</strong>
            <button
              type="button"
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { productId: "", quantity: "1" },
                ])
              }
            >
              + Item
            </button>
          </header>
          {rows.map((row, index) => (
            <div key={index}>
              <select
                value={row.productId}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item, position) =>
                      position === index
                        ? { ...item, productId: event.target.value }
                        : item,
                    ),
                  )
                }
                required
              >
                <option value="">Selecione o produto</option>
                {catalog.products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} · {product.sku}
                  </option>
                ))}
              </select>
              <input
                aria-label="Quantidade solicitada"
                type="number"
                min=".0001"
                step=".0001"
                value={row.quantity}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item, position) =>
                      position === index
                        ? { ...item, quantity: event.target.value }
                        : item,
                    ),
                  )
                }
                required
              />
              <button
                type="button"
                disabled={rows.length === 1}
                onClick={() =>
                  setRows((current) =>
                    current.filter((_, position) => position !== index),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </section>
        <label className="wide">
          Observações
          <textarea name="notes" maxLength={2000} />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Abrindo…" : "Abrir cotação"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function PurchaseQuotationOfferModal({
  quotation,
  suppliers,
  busy,
  close,
  submit,
}: {
  quotation: any;
  suppliers: PurchaseCatalog["suppliers"];
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [costs, setCosts] = useState<Record<number, string>>(
      Object.fromEntries(quotation.items.map((item: any) => [item.id, "0"])),
    ),
    [freight, setFreight] = useState("0"),
    [discount, setDiscount] = useState("0");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit({
      ...Object.fromEntries(new FormData(event.currentTarget)),
      items: quotation.items.map((item: any) => ({
        quotationItemId: item.id,
        unitCost: Number(costs[item.id]),
      })),
    });
  }
  const subtotal = quotation.items.reduce(
      (sum: number, item: any) =>
        sum + item.quantity * (Number(costs[item.id]) || 0),
      0,
    ),
    total = Math.max(
      0,
      subtotal + (Number(freight) || 0) - (Number(discount) || 0),
    );
  return (
    <div className="tenant-modal purchase-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>{quotation.number}</small>
            <h2>Registrar proposta</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Fornecedor
          <select name="supplierId" required>
            <option value="">Selecione</option>
            {suppliers
              .filter(
                (supplier) =>
                  !quotation.offers.some(
                    (offer: any) => offer.supplier.id === supplier.id,
                  ),
              )
              .map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.tradeName || supplier.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Prazo de entrega (dias)
          <input
            name="leadTimeDays"
            type="number"
            min="0"
            max="3650"
            defaultValue="0"
            required
          />
        </label>
        <label>
          Condição de pagamento
          <input
            name="paymentTerms"
            maxLength={200}
            placeholder="Ex.: 28/42 dias"
          />
        </label>
        <label>
          Frete
          <input
            name="freight"
            type="number"
            min="0"
            step=".01"
            value={freight}
            onChange={(event) => setFreight(event.target.value)}
          />
        </label>
        <label>
          Desconto
          <input
            name="discount"
            type="number"
            min="0"
            step=".01"
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
          />
        </label>
        <section className="purchase-lines wide">
          <header>
            <strong>Custos unitários</strong>
            <b>
              Subtotal {money.format(subtotal)} · total entregue{" "}
              {money.format(total)}
            </b>
          </header>
          {quotation.items.map((item: any) => (
            <div key={item.id}>
              <span>
                <strong>{item.product.name}</strong>
                <small>
                  {numberValue(item.quantity)} {item.product.unit}
                </small>
              </span>
              <input
                aria-label={`Custo de ${item.product.name}`}
                type="number"
                min="0"
                step=".0001"
                value={costs[item.id]}
                onChange={(event) =>
                  setCosts((current) => ({
                    ...current,
                    [item.id]: event.target.value,
                  }))
                }
                required
              />
            </div>
          ))}
        </section>
        <label className="wide">
          Observações
          <textarea name="notes" maxLength={1000} />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Registrando…" : "Registrar proposta"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function PurchaseQuotationAwardModal({
  selection,
  busy,
  close,
  submit,
}: {
  selection: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>{selection.quotation.number}</small>
            <h2>Adjudicar proposta</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <div className="wide quotation-award-summary">
          <span>
            Fornecedor
            <strong>
              {selection.offer.supplier.tradeName ||
                selection.offer.supplier.name}
            </strong>
          </span>
          <span>
            Valor<strong>{money.format(selection.offer.total)}</strong>
          </span>
          <span>
            Entrega<strong>{selection.offer.leadTimeDays} dia(s)</strong>
          </span>
        </div>
        <label className="wide">
          Vencimento do pedido
          <input name="dueAt" type="date" required />
        </label>
        <p className="wide">
          A proposta será marcada como vencedora e um pedido de compra será
          criado como rascunho com os itens e custos cotados.
        </p>
        <footer>
          <button type="button" onClick={close}>
            Voltar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Gerando pedido…" : "Escolher e gerar pedido"}
          </button>
        </footer>
      </form>
    </div>
  );
}


function Finance() {
  const [data, setData] = useState<FinanceCatalog>(),
    [type, setType] = useState(""),
    [status, setStatus] = useState(""),
    [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [settling, setSettling] = useState<FinancialTitle>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setError("");
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    if (query) params.set("search", query);
    const response = await fetch(`/api/erp/finance?${params}`, {
      cache: "no-store",
    });
    const body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error || "Não foi possível carregar o financeiro.");
  }
  useEffect(() => {
    load();
  }, []);
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await load();
  }
  async function create(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/finance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível criar o título.");
      return;
    }
    setOpen(false);
    setNotice("Título financeiro criado.");
    await load();
  }
  async function command(
    title: FinancialTitle,
    action: string,
    payload: Record<string, unknown> = {},
  ) {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/erp/finance/${title.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível atualizar o título.");
      return false;
    }
    setSettling(undefined);
    setNotice(
      action === "settle"
        ? "Baixa financeira registrada."
        : "Título cancelado.",
    );
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">Carregando contas e liquidações…</div>
    );
  return (
    <div className="erp-finance">
      {notice && <div className="tenant-notice">{notice}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="A receber em aberto"
          value={money.format(data.summary.receivable)}
          detail="Saldo dos recebíveis"
        />
        <Kpi
          label="A pagar em aberto"
          value={money.format(data.summary.payable)}
          detail="Inclui pedidos recebidos"
        />
        <Kpi
          label="Total vencido"
          value={money.format(data.summary.overdue)}
          detail="Exige regularização"
          alert={data.summary.overdue > 0}
        />
        <Kpi
          label="Títulos liquidados"
          value={money.format(data.summary.settled)}
          detail="Histórico acumulado"
        />
      </section>
      <form className="tenant-toolbar finance-toolbar" onSubmit={search}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar descrição ou documento…"
        />
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">Pagar e receber</option>
          <option value="receivable">Contas a receber</option>
          <option value="payable">Contas a pagar</option>
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">Todos os status</option>
          <option value="open">Em aberto</option>
          <option value="partial">Parcial</option>
          <option value="paid">Liquidado</option>
          <option value="cancelled">Cancelado</option>
        </select>
        <button>Filtrar</button>
        <button className="primary" type="button" onClick={() => setOpen(true)}>
          + Novo título
        </button>
      </form>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-panel tenant-table">
        <header>
          <h2>Movimentação financeira operacional</h2>
          <span>{data.items.length}</span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tipo / descrição</th>
                <th>Cliente ou fornecedor</th>
                <th>Vencimento</th>
                <th>Valor</th>
                <th>Saldo</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((title) => {
                const remaining = Math.max(0, title.amount - title.paidAmount),
                  party = title.customer || title.supplier;
                return (
                  <tr key={title.id}>
                    <td>
                      <span className={`finance-kind ${title.type}`}>
                        {title.type === "receivable" ? "RECEBER" : "PAGAR"}
                      </span>
                      <strong>{title.description}</strong>
                      <small>
                        {title.documentNumber || title.settlements.length
                          ? `${title.documentNumber || "Sem documento"} · ${title.settlements.length} baixa(s)`
                          : "Lançamento sem documento"}
                      </small>
                    </td>
                    <td>
                      <strong>
                        {party?.tradeName || party?.name || "Sem vínculo"}
                      </strong>
                      <small>{title.notes || "—"}</small>
                    </td>
                    <td
                      className={
                        title.status !== "paid" &&
                        new Date(title.dueAt) < new Date()
                          ? "finance-overdue"
                          : ""
                      }
                    >
                      {shortDate(title.dueAt)}
                    </td>
                    <td>{money.format(title.amount)}</td>
                    <td>
                      <strong>{money.format(remaining)}</strong>
                    </td>
                    <td>
                      <span className={`finance-status ${title.status}`}>
                        {financeStatus(title.status)}
                      </span>
                    </td>
                    <td>
                      <div className="customer-actions">
                        {["open", "partial"].includes(title.status) && (
                          <button onClick={() => setSettling(title)}>
                            Dar baixa
                          </button>
                        )}
                        {title.status === "open" &&
                          !title.settlements.length && (
                            <button
                              disabled={busy}
                              onClick={() => command(title, "cancel")}
                            >
                              Cancelar
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!data.items.length && (
            <Empty text="Nenhum título encontrado para os filtros informados." />
          )}
        </div>
      </section>
      {open && (
        <FinancialTitleModal
          catalog={data}
          busy={busy}
          close={() => setOpen(false)}
          submit={create}
        />
      )}{" "}
      {settling && (
        <SettlementModal
          title={settling}
          busy={busy}
          close={() => setSettling(undefined)}
          submit={(payload) => command(settling, "settle", payload)}
        />
      )}
    </div>
  );
}

function FinancialTitleModal({
  catalog,
  busy,
  close,
  submit,
}: {
  catalog: FinanceCatalog;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [type, setType] = useState("receivable");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>FINANCEIRO OPERACIONAL REAL</small>
            <h2>Novo título</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label>
          Tipo
          <select
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value="receivable">Conta a receber</option>
            <option value="payable">Conta a pagar</option>
          </select>
        </label>
        <label>
          {type === "receivable" ? "Cliente" : "Fornecedor"}
          <select name={type === "receivable" ? "customerId" : "supplierId"}>
            <option value="">Sem vínculo</option>
            {(type === "receivable"
              ? catalog.customers
              : catalog.suppliers
            ).map((item) => (
              <option value={item.id} key={item.id}>
                {item.tradeName || item.name} · {formatDocument(item.document)}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Descrição
          <input name="description" required />
        </label>
        <label>
          Documento
          <input
            name="documentNumber"
            placeholder="NF, contrato ou referência"
          />
        </label>
        <label>
          Vencimento
          <input name="dueAt" type="date" required />
        </label>
        <label>
          Valor
          <input name="amount" type="number" min="0.01" step="0.01" required />
        </label>
        <label className="wide">
          Observações
          <textarea name="notes" />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Criar título"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function SettlementModal({
  title,
  busy,
  close,
  submit,
}: {
  title: FinancialTitle;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const remaining = Math.max(0, title.amount - title.paidAmount);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>BAIXA FINANCEIRA AUDITADA</small>
            <h2>{title.description}</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <div className="purchase-total wide">
          <span>Saldo atual</span>
          <strong>{money.format(remaining)}</strong>
        </div>
        <label>
          Valor pago/recebido
          <input
            name="amount"
            type="number"
            min="0.01"
            max={remaining}
            step="0.01"
            defaultValue={remaining}
            required
          />
        </label>
        <label>
          Meio
          <select name="method">
            <option value="pix">Pix</option>
            <option value="bank_transfer">Transferência</option>
            <option value="boleto">Boleto</option>
            <option value="cash">Dinheiro</option>
            <option value="card">Cartão</option>
            <option value="other">Outro</option>
          </select>
        </label>
        <label>
          Juros
          <input
            name="interest"
            type="number"
            min="0"
            step="0.01"
            defaultValue="0"
          />
        </label>
        <label>
          Desconto
          <input
            name="discount"
            type="number"
            min="0"
            max={remaining}
            step="0.01"
            defaultValue="0"
          />
        </label>
        <label className="wide">
          Observações
          <textarea name="notes" />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Processando…" : "Confirmar baixa"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Inventory({ cacheNamespace }: { cacheNamespace: string }) {
  const endpoint = "/api/erp/inventory";
  const [data, setData] = useState<InventoryCatalog | undefined>(() =>
      cachedViewData<InventoryCatalog>(cacheNamespace, endpoint),
    ),
    [tab, setTab] = useState<
      "positions" | "warehouses" | "counts" | "transfers" | "ledger"
    >("positions"),
    [modal, setModal] = useState<"warehouse" | "count" | "transfer">(),
    [counting, setCounting] = useState<InventoryCount>(),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [ledgerPage, setLedgerPage] = useState(1),
    [ledgerSearchPending, setLedgerSearchPending] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [commandError, setCommandError] = useState(""),
    [notice, setNotice] = useState("");
  const inventoryRequest = useRef<AbortController | null>(null);
  const inventoryCommand = useRef(false);
  const ledgerSearchTimer = useRef<number | undefined>(undefined);
  async function load(
    page = ledgerPage,
    ledgerSearch = tab === "ledger" ? search : "",
  ) {
    window.clearTimeout(ledgerSearchTimer.current);
    setLedgerSearchPending(false);
    inventoryRequest.current?.abort();
    const controller = new AbortController();
    inventoryRequest.current = controller;
    setRefreshing(true);
    setError("");
    try {
      const parameters = new URLSearchParams({
        ledgerPage: String(page),
        ledgerLimit: "50",
      });
      if (ledgerSearch.trim())
        parameters.set("ledgerSearch", ledgerSearch.trim());
      const response = await fetch(`${endpoint}?${parameters}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json();
      if (inventoryRequest.current !== controller || controller.signal.aborted)
        return;
      if (response.status === 401 || response.status === 403) {
        invalidateViewData(cacheNamespace, endpoint);
        setData(undefined);
      }
      if (!response.ok)
        throw new Error(
          body.error || "Não foi possível carregar o inventário.",
        );
      if (page === 1 && !ledgerSearch.trim())
        cacheViewData(cacheNamespace, endpoint, body);
      setData(body);
    } catch (reason) {
      if (controller.signal.aborted || inventoryRequest.current !== controller)
        return;
      if (reason instanceof DOMException && reason.name === "AbortError")
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível carregar o inventário.",
      );
    } finally {
      if (inventoryRequest.current === controller) setRefreshing(false);
    }
  }
  useEffect(() => {
    void load();
    return () => inventoryRequest.current?.abort();
  }, []);
  useEffect(() => {
    if (tab !== "ledger") {
      setLedgerSearchPending(false);
      return;
    }
    setLedgerSearchPending(true);
    const timeout = window.setTimeout(() => {
      setLedgerPage(1);
      void load(1, search);
    }, 300);
    ledgerSearchTimer.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [tab, search]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  async function command(payload: Record<string, unknown>, success: string) {
    if (inventoryCommand.current) return false;
    inventoryCommand.current = true;
    setBusy(true);
    setCommandError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Não foi possível concluir a operação.");
      invalidateViewData(cacheNamespace, endpoint);
      setModal(undefined);
      setCounting(undefined);
      setNotice(success);
      await load();
      return true;
    } catch (reason) {
      setCommandError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível concluir a operação.",
      );
      return false;
    } finally {
      inventoryCommand.current = false;
      setBusy(false);
    }
  }
  if (!data)
    return (
      <div
        className={`tenant-loading inventory-loading ${error ? "error" : ""}`}
        role={error ? "alert" : "status"}
      >
        {error || "Carregando depósitos e saldos…"}
        {error && (
          <button type="button" onClick={() => void load()}>
            Tentar novamente
          </button>
        )}
      </div>
    );
  const term = search.trim().toLocaleLowerCase("pt-BR"),
    matches = (value: string) =>
      !term || value.toLocaleLowerCase("pt-BR").includes(term),
    visiblePositions = data.positions.filter(
      (position) =>
        matches(`${position.name} ${position.sku}`) &&
        (!status ||
          (status === "low" && position.belowMinimum) ||
          (status === "negative" && position.available < 0) ||
          (status === "ok" &&
            !position.belowMinimum &&
            position.available >= 0)),
    ),
    visibleWarehouses = data.warehouses.filter(
      (warehouse) =>
        matches(
          `${warehouse.code} ${warehouse.name} ${warehouse.description || ""}`,
        ) &&
        (!status || String(warehouse.active) === status),
    ),
    visibleCounts = data.counts.filter(
      (count) =>
        matches(`${count.number} ${count.warehouse.name}`) &&
        (!status || count.status === status),
    ),
    visibleTransfers = data.transfers.filter((transfer) =>
      matches(
        `${transfer.number} ${transfer.fromWarehouse.name} ${transfer.toWarehouse.name} ${transfer.items.map((item) => item.product.name).join(" ")}`,
      ),
    ),
    // Ledger filtering and totals belong to the server. Filtering the returned
    // page again (especially after translating event names) drops valid rows.
    visibleLedger = data.ledger,
    filterOptions: Array<[string, string]> =
      tab === "positions"
        ? [
            ["low", "Abaixo do mínimo"],
            ["negative", "Saldo negativo"],
            ["ok", "Saldo saudável"],
          ]
        : tab === "warehouses"
          ? [
              ["true", "Ativos"],
              ["false", "Inativos"],
            ]
          : tab === "counts"
            ? [
                ["draft", "Em andamento"],
                ["completed", "Concluídas"],
                ["cancelled", "Canceladas"],
              ]
            : [];
  const activeWarehouses = data.warehouses.filter(
    (warehouse) => warehouse.active,
  );
  const countableWarehouses = activeWarehouses.filter(
    (warehouse) =>
      !data.counts.some(
        (count) =>
          count.warehouse.id === warehouse.id && count.status === "draft",
      ),
  );
  const transferSources = activeWarehouses.filter((warehouse) =>
    warehouse.balances.some(
      (balance) => balance.quantity - balance.reservedQuantity > 0.000001,
    ),
  );
  const inventoryTabs = [
    ["positions", "Posição", data.positions.length],
    ["warehouses", "Depósitos", data.warehouses.length],
    ["counts", "Contagens", data.pagination.counts.total],
    ["transfers", "Transferências", data.pagination.transfers.total],
    ["ledger", "Razão", data.pagination.ledger.total],
  ] as const;
  function selectInventoryTab(id: typeof tab) {
    setTab(id);
    setSearch("");
    setStatus("");
  }
  function openInventoryModal(next: typeof modal) {
    setCommandError("");
    setModal(next);
  }
  return (
    <div className="erp-inventory">
      {notice && (
        <div className="tenant-notice inventory-feedback" role="status">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice("")}
            aria-label="Fechar mensagem"
          >
            ×
          </button>
        </div>
      )}
      <section className="tenant-kpis">
        <Kpi
          label="Produtos controlados"
          value={String(data.summary.products)}
          detail={`${data.summary.warehouses} depósito(s) ativo(s)`}
        />
        <Kpi
          label="Produtos com reserva"
          value={String(data.summary.reservedProducts)}
          detail="Com saldo comprometido por operações"
        />
        <Kpi
          label="Abaixo do mínimo"
          value={String(data.summary.lowStock)}
          detail={`${data.summary.negative} produto(s) com saldo negativo`}
          alert={data.summary.lowStock > 0 || data.summary.negative > 0}
        />
        <Kpi
          label="Valor armazenado"
          value={money.format(data.summary.stockValue)}
          detail={`${data.summary.openCounts} contagem(ns) · ${data.summary.divergences} divergência(s)`}
          alert={data.summary.openCounts > 0}
        />
      </section>
      <section
        className="inventory-commandbar"
        aria-label="Ações de inventário"
      >
        <div>
          <strong>Controle operacional</strong>
          <small>
            Cadastre locais, conte o estoque e movimente saldos com
            rastreabilidade.
          </small>
        </div>
        <div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy || refreshing}
          >
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
          <button
            type="button"
            onClick={() => openInventoryModal("warehouse")}
            disabled={busy}
          >
            Novo depósito
          </button>
          <button
            type="button"
            onClick={() => openInventoryModal("count")}
            disabled={busy || !countableWarehouses.length || !data.products.length}
            title={
              !activeWarehouses.length
                ? "Cadastre um depósito ativo para abrir uma contagem"
                : !data.products.length
                  ? "Cadastre produtos para abrir uma contagem"
                  : !countableWarehouses.length
                    ? "Todos os depósitos ativos já possuem uma contagem aberta"
                    : undefined
            }
          >
            Abrir contagem
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => openInventoryModal("transfer")}
            disabled={
              busy || activeWarehouses.length < 2 || !transferSources.length
            }
            title={
              activeWarehouses.length < 2
                ? "Cadastre ao menos dois depósitos ativos"
                : !transferSources.length
                  ? "Nenhum depósito possui saldo disponível para transferir"
                  : undefined
            }
          >
            Nova transferência
          </button>
        </div>
      </section>
      {(data.summary.lowStock > 0 || data.summary.negative > 0 || data.summary.openCounts > 0) && (
        <section className="inventory-attention" aria-label="Pontos de atenção">
          <strong>Atenção operacional</strong>
          <div>
            {data.summary.lowStock > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTab("positions");
                  setStatus("low");
                  setSearch("");
                }}
              >
                {data.summary.lowStock} abaixo do mínimo
              </button>
            )}
            {data.summary.negative > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTab("positions");
                  setStatus("negative");
                  setSearch("");
                }}
              >
                {data.summary.negative} com saldo negativo
              </button>
            )}
            {data.summary.openCounts > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTab("counts");
                  setStatus("draft");
                  setSearch("");
                }}
              >
                {data.summary.openCounts} contagem(ns) aberta(s)
              </button>
            )}
          </div>
        </section>
      )}
      <div
        className="inventory-view-tabs"
        role="tablist"
        aria-label="Visualização do inventário"
      >
        {inventoryTabs.map(([id, label, count]) => (
          <button
            type="button"
            role="tab"
            id={`inventory-tab-${id}`}
            aria-controls={`inventory-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "active" : ""}
            onClick={() => selectInventoryTab(id)}
            onKeyDown={(event) => {
              const index = inventoryTabs.findIndex(([value]) => value === id);
              const nextIndex = event.key === "Home" ? 0
                : event.key === "End" ? inventoryTabs.length - 1
                  : event.key === "ArrowRight" ? (index + 1) % inventoryTabs.length
                    : event.key === "ArrowLeft" ? (index + inventoryTabs.length - 1) % inventoryTabs.length
                      : undefined;
              if (nextIndex === undefined) return;
              event.preventDefault();
              const next = inventoryTabs[nextIndex][0];
              selectInventoryTab(next);
              document.getElementById(`inventory-tab-${next}`)?.focus();
            }}
            key={id}
          >
            <span>{label}</span>
            <b>{count}</b>
          </button>
        ))}
      </div>
      <label className="inventory-mobile-view">
        <span>Visualização</span>
        <select
          aria-label="Visualização"
          value={tab}
          onChange={(event) => selectInventoryTab(event.target.value as typeof tab)}
        >
          {inventoryTabs.map(([id, label, count]) => (
            <option key={id} value={id}>
              {label} ({count})
            </option>
          ))}
        </select>
      </label>
      <SuiteListFilter
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        placeholder={
          tab === "positions"
            ? "Buscar produto ou SKU"
            : tab === "warehouses"
              ? "Buscar depósito"
              : tab === "counts"
                ? "Buscar contagem ou depósito"
                : tab === "transfers"
                  ? "Buscar transferência, depósito ou produto"
                  : "Buscar produto, SKU, depósito ou código do evento"
        }
        options={filterOptions}
      />
      {refreshing && data && (
        <div className="inventory-refreshing" role="status">
          <span /> Atualizando dados…
        </div>
      )}
      {error && (
        <div className="tenant-error inventory-feedback" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            Tentar novamente
          </button>
        </div>
      )}
      {commandError && !modal && !counting && (
        <div className="tenant-error inventory-feedback" role="alert">
          {commandError}
        </div>
      )}
      {tab === "positions" && (
        <section
          id="inventory-panel-positions"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby="inventory-tab-positions"
          className="tenant-panel tenant-table supply-position-panel"
        >
          <header>
            <div>
              <h2>Posição consolidada por produto</h2>
              <small>
                Físico − reservado = disponível, detalhado por depósito
              </small>
            </div>
            <span>{visiblePositions.length}</span>
          </header>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Físico</th>
                  <th>Reservado</th>
                  <th>Disponível</th>
                  <th>Mínimo</th>
                  <th>Valoração</th>
                  <th>Distribuição</th>
                </tr>
              </thead>
              <tbody>
                {visiblePositions.map((position) => (
                  <tr
                    key={position.id}
                    className={position.belowMinimum || position.available < 0 ? "supply-row-alert" : ""}
                  >
                    <td>
                      <strong>{position.name}</strong>
                      <small>
                        {position.sku} · {position.unit}
                      </small>
                    </td>
                    <td>{numberValue(position.physical)}</td>
                    <td>{numberValue(position.reserved)}</td>
                    <td
                      className={
                        position.available < 0
                          ? "inventory-negative"
                          : "inventory-positive"
                      }
                    >
                      <strong>{numberValue(position.available)}</strong>
                    </td>
                    <td>
                      {numberValue(position.minStock)}
                      {position.belowMinimum && <small>Abaixo do mínimo</small>}
                    </td>
                    <td>{money.format(position.value)}</td>
                    <td>
                      <div className="warehouse-balance-chips">
                        {position.warehouses
                          .filter(
                            (warehouse) =>
                              warehouse.quantity !== 0 ||
                              warehouse.reservedQuantity !== 0,
                          )
                          .map((warehouse) => (
                            <span key={warehouse.id}>
                              <b>{warehouse.code}</b>{" "}
                              {numberValue(warehouse.available)}
                            </span>
                          ))}
                        {!position.warehouses.some(
                          (warehouse) =>
                            warehouse.quantity !== 0 ||
                            warehouse.reservedQuantity !== 0,
                        ) && <small>Sem saldo</small>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visiblePositions.length && (
              <Empty
                text={
                  data.positions.length
                    ? "Nenhum produto corresponde aos filtros."
                    : "Nenhuma posição de estoque disponível."
                }
              />
            )}
          </div>
          <div className="inventory-position-cards">
            {visiblePositions.map((position) => (
              <article
                key={position.id}
                className={position.belowMinimum || position.available < 0 ? "alert" : ""}
              >
                <header>
                  <div>
                    <strong>{position.name}</strong>
                    <small>
                      {position.sku} · {position.unit}
                    </small>
                  </div>
                  <span
                    className={position.belowMinimum || position.available < 0 ? "warning" : "healthy"}
                  >
                    {position.available < 0 ? "Saldo negativo" : position.belowMinimum ? "Abaixo do mínimo" : "Saudável"}
                  </span>
                </header>
                <dl>
                  <div>
                    <dt>Físico</dt>
                    <dd>{numberValue(position.physical)}</dd>
                  </div>
                  <div>
                    <dt>Reservado</dt>
                    <dd>{numberValue(position.reserved)}</dd>
                  </div>
                  <div>
                    <dt>Disponível</dt>
                    <dd
                      className={
                        position.available < 0
                          ? "inventory-negative"
                          : "inventory-positive"
                      }
                    >
                      {numberValue(position.available)}
                    </dd>
                  </div>
                  <div>
                    <dt>Mínimo</dt>
                    <dd>{numberValue(position.minStock)}</dd>
                  </div>
                  <div>
                    <dt>Valoração</dt>
                    <dd>{money.format(position.value)}</dd>
                  </div>
                </dl>
                <div className="warehouse-balance-chips">
                  {position.warehouses
                    .filter(
                      (warehouse) =>
                        warehouse.quantity !== 0 ||
                        warehouse.reservedQuantity !== 0,
                    )
                    .map((warehouse) => (
                      <span key={warehouse.id}>
                        <b>{warehouse.code}</b>{" "}
                        {numberValue(warehouse.available)}
                      </span>
                    ))}
                  {!position.warehouses.some(
                    (warehouse) =>
                      warehouse.quantity !== 0 ||
                      warehouse.reservedQuantity !== 0,
                  ) && <small>Sem saldo nos depósitos</small>}
                </div>
              </article>
            ))}
            {!visiblePositions.length && (
              <Empty
                text={
                  data.positions.length
                    ? "Nenhum produto corresponde aos filtros."
                    : "Nenhuma posição de estoque disponível."
                }
              />
            )}
          </div>
        </section>
      )}
      {tab === "warehouses" && (
        <section
          id="inventory-panel-warehouses"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby="inventory-tab-warehouses"
          className="inventory-view-panel"
        >
          <section className="warehouse-grid">
            {visibleWarehouses.map((warehouse) => (
              <article
                className={`warehouse-card ${warehouse.active ? "" : "inactive"}`}
                key={warehouse.id}
              >
                <header>
                  <span>{warehouse.code}</span>
                  <div>
                    {warehouse.primary && <em>PRINCIPAL</em>}
                    <i
                      className={`customer-status ${warehouse.active ? "active" : "inactive"}`}
                    >
                      {warehouse.active ? "Ativo" : "Inativo"}
                    </i>
                  </div>
                </header>
                <h2>{warehouse.name}</h2>
                <p>{warehouse.description || "Sem descrição."}</p>
                <dl>
                  <div>
                    <dt>Itens com saldo</dt>
                    <dd>
                      {
                        warehouse.balances.filter((item) => item.quantity !== 0)
                          .length
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>Disponível</dt>
                    <dd>
                      {numberValue(
                        warehouse.balances.reduce(
                          (sum, item) =>
                            sum + item.quantity - item.reservedQuantity,
                          0,
                        ),
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Reservado</dt>
                    <dd>
                      {numberValue(
                        warehouse.balances.reduce(
                          (sum, item) => sum + item.reservedQuantity,
                          0,
                        ),
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Custo</dt>
                    <dd>
                      {money.format(
                        warehouse.balances.reduce(
                          (sum, item) =>
                            sum + item.quantity * item.product.cost,
                          0,
                        ),
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="warehouse-products">
                  {warehouse.balances
                    .filter((item) => item.quantity !== 0)
                    .slice(0, 5)
                    .map((balance) => (
                      <span key={balance.id}>
                        <strong>{balance.product.name}</strong>
                        <b>
                          {numberValue(
                            balance.quantity - balance.reservedQuantity,
                          )}{" "}
                          {balance.product.unit}
                          {balance.reservedQuantity > 0
                            ? ` · ${numberValue(balance.reservedQuantity)} reservado`
                            : ""}
                        </b>
                      </span>
                    ))}
                  {!warehouse.balances.some((item) => item.quantity !== 0) && (
                    <small>Depósito sem saldo.</small>
                  )}
                  {warehouse.balances.filter((item) => item.quantity !== 0)
                    .length > 5 && (
                    <small>
                      +{" "}
                      {warehouse.balances.filter((item) => item.quantity !== 0)
                        .length - 5}{" "}
                      outro(s) produto(s) com saldo
                    </small>
                  )}
                </div>
                {!warehouse.primary && (
                  <footer>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        (warehouse.active &&
                          warehouse.balances.some(
                            (balance) =>
                              Math.abs(balance.quantity) > 0.000001 ||
                              balance.reservedQuantity > 0.000001,
                          ))
                      }
                      title={
                        warehouse.active &&
                        warehouse.balances.some(
                          (balance) =>
                            Math.abs(balance.quantity) > 0.000001 ||
                            balance.reservedQuantity > 0.000001,
                        )
                          ? "Transfira ou zere os saldos e reservas antes de inativar"
                          : undefined
                      }
                      onClick={() =>
                        command(
                          {
                            action: "toggle_warehouse",
                            warehouseId: warehouse.id,
                          },
                          warehouse.active
                            ? "Depósito inativado."
                            : "Depósito reativado.",
                        )
                      }
                    >
                      {warehouse.active ? "Inativar" : "Ativar"}
                    </button>
                  </footer>
                )}
              </article>
            ))}
          </section>
          {!visibleWarehouses.length && (
            <section className="tenant-panel">
              <Empty text="Nenhum depósito corresponde aos filtros." />
            </section>
          )}
        </section>
      )}
      {tab === "counts" && (
        <section
          id="inventory-panel-counts"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby="inventory-tab-counts"
          className="inventory-view-panel"
        >
          {data.pagination.counts.total > data.pagination.counts.shown && (
            <p className="receipt-warning" role="status">
              Exibindo as {data.pagination.counts.shown} contagens mais recentes de {data.pagination.counts.total}.
              A busca e o status filtram apenas os registros carregados.
            </p>
          )}
          <section className="inventory-operation-list">
            {visibleCounts.map((count) => (
              <article key={count.id}>
                <i>{count.status === "completed" ? "✓" : "#"}</i>
                <div>
                  <strong>
                    {count.number} · {count.warehouse.name}
                  </strong>
                  <small>
                    {count.items.length} produtos ·{" "}
                    {count.blind ? "contagem cega" : "contagem orientada"} ·
                    aberta em {dateTime(count.createdAt)}
                  </small>
                </div>
                <span>
                  {count.status === "completed"
                    ? `${count.items.filter((item) => Math.abs(item.difference || 0) > 0.000001).length} ajustes`
                    : count.status === "cancelled" ? "Sem alteração de saldo" : "Aguardando contagem"}
                </span>
                <em className={`inventory-operation-status ${count.status}`}>
                  {inventoryCountStatus(count.status)}
                </em>
                {count.status === "draft" && (
                  <div className="inventory-operation-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setCommandError("");
                        setCounting(count);
                      }}
                    >
                      Preencher
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Cancelar a contagem ${count.number}? Nenhum saldo será alterado.`,
                          )
                        )
                          void command(
                            { action: "cancel_count", countId: count.id },
                            "Contagem cancelada.",
                          );
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                )}
              </article>
            ))}
          </section>
          {!visibleCounts.length && (
            <section className="tenant-panel">
              <Empty
                text={
                  data.counts.length
                    ? "Nenhuma contagem corresponde aos filtros."
                    : "Nenhuma contagem de inventário registrada."
                }
              />
            </section>
          )}
        </section>
      )}
      {tab === "transfers" && (
        <section
          id="inventory-panel-transfers"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby="inventory-tab-transfers"
          className="inventory-view-panel"
        >
          {data.pagination.transfers.total > data.pagination.transfers.shown && (
            <p className="receipt-warning" role="status">
              Exibindo as {data.pagination.transfers.shown} transferências mais recentes de {data.pagination.transfers.total}.
              A busca filtra apenas os registros carregados.
            </p>
          )}
          <section className="inventory-operation-list">
            {visibleTransfers.map((transfer) => (
              <article key={transfer.id}>
                <i>⇄</i>
                <div>
                  <strong>
                    {transfer.number} · {transfer.fromWarehouse.code} →{" "}
                    {transfer.toWarehouse.code}
                  </strong>
                  <small>
                    {transfer.items
                      .map(
                        (item) =>
                          `${item.product.name}: ${numberValue(item.quantity)} ${item.product.unit}`,
                      )
                      .join(" · ")}
                  </small>
                </div>
                <span>
                  {transfer.items.length} item(ns) · {transfer.transferredBy}
                </span>
                <time>{dateTime(transfer.createdAt)}</time>
              </article>
            ))}
          </section>
          {!visibleTransfers.length && (
            <section className="tenant-panel">
              <Empty
                text={
                  data.transfers.length
                    ? "Nenhuma transferência corresponde à busca."
                    : "Nenhuma transferência registrada."
                }
              />
            </section>
          )}
        </section>
      )}
      {tab === "ledger" && (
        <section
          id="inventory-panel-ledger"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby="inventory-tab-ledger"
          className="tenant-panel tenant-table inventory-ledger-panel"
        >
          <header>
            <div>
              <h2>Razão imutável por depósito</h2>
              <small>
                Histórico cronológico de todas as entradas, saídas e ajustes
              </small>
            </div>
            <span>{data.pagination.ledger.total}</span>
          </header>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Produto</th>
                  <th>Depósito</th>
                  <th>Evento</th>
                  <th>Quantidade</th>
                  <th>Saldo anterior</th>
                  <th>Novo saldo</th>
                </tr>
              </thead>
              <tbody>
                {visibleLedger.map((entry) => (
                  <tr key={entry.id}>
                    <td>{dateTime(entry.createdAt)}</td>
                    <td>
                      <strong>{entry.product.name}</strong>
                      <small>{entry.product.sku}</small>
                    </td>
                    <td>{entry.warehouse.name}</td>
                    <td>{inventoryEvent(entry.type)}</td>
                    <td
                      className={
                        entry.quantity < 0
                          ? "inventory-negative"
                          : "inventory-positive"
                      }
                    >
                      {entry.quantity > 0 ? "+" : ""}
                      {numberValue(entry.quantity)} {entry.product.unit}
                    </td>
                    <td>{numberValue(entry.balanceBefore)}</td>
                    <td>
                      <strong>{numberValue(entry.balanceAfter)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visibleLedger.length && (
              <Empty
                text={
                  data.ledger.length
                    ? "Nenhum evento corresponde à busca."
                    : "Nenhum evento registrado no razão de estoque."
                }
              />
            )}
          </div>
          <div className="inventory-ledger-cards">
            {visibleLedger.map((entry) => (
              <article key={entry.id}>
                <header>
                  <div>
                    <strong>{entry.product.name}</strong>
                    <small>
                      {entry.product.sku} · {entry.warehouse.name}
                    </small>
                  </div>
                  <time>{dateTime(entry.createdAt)}</time>
                </header>
                <div>
                  <span>{inventoryEvent(entry.type)}</span>
                  <strong
                    className={
                      entry.quantity < 0
                        ? "inventory-negative"
                        : "inventory-positive"
                    }
                  >
                    {entry.quantity > 0 ? "+" : ""}
                    {numberValue(entry.quantity)} {entry.product.unit}
                  </strong>
                </div>
                <footer>
                  <span>
                    Anterior <b>{numberValue(entry.balanceBefore)}</b>
                  </span>
                  <i>→</i>
                  <span>
                    Novo saldo <b>{numberValue(entry.balanceAfter)}</b>
                  </span>
                </footer>
              </article>
            ))}
            {!visibleLedger.length && (
              <Empty
                text={
                  data.ledger.length
                    ? "Nenhum evento corresponde à busca."
                    : "Nenhum evento registrado no razão de estoque."
                }
              />
            )}
          </div>
          <footer className="supply-pager">
            <span>
              Página {data.pagination.ledger.page} de{" "}
              {data.pagination.ledger.pages} · {data.pagination.ledger.total}{" "}
              eventos
            </span>
            <div>
              <button
                disabled={
                  busy || refreshing || ledgerSearchPending || data.pagination.ledger.page <= 1
                }
                onClick={async () => {
                  const page = data.pagination.ledger.page - 1;
                  setLedgerPage(page);
                  await load(page, search);
                }}
              >
                Anterior
              </button>
              <button
                disabled={
                  busy ||
                  refreshing ||
                  ledgerSearchPending ||
                  data.pagination.ledger.page >= data.pagination.ledger.pages
                }
                onClick={async () => {
                  const page = data.pagination.ledger.page + 1;
                  setLedgerPage(page);
                  await load(page, search);
                }}
              >
                Próxima
              </button>
            </div>
          </footer>
        </section>
      )}
      {modal === "warehouse" && (
        <WarehouseModal
          busy={busy}
          error={commandError}
          close={() => openInventoryModal(undefined)}
          submit={(payload) =>
            command(
              { action: "create_warehouse", ...payload },
              "Depósito criado.",
            )
          }
        />
      )}{" "}
      {modal === "count" && (
        <CountSetupModal
          warehouses={countableWarehouses}
          busy={busy}
          error={commandError}
          close={() => openInventoryModal(undefined)}
          submit={(payload) =>
            command(
              { action: "create_count", ...payload },
              "Contagem aberta com o saldo congelado.",
            )
          }
        />
      )}{" "}
      {modal === "transfer" && (
        <TransferModal
          catalog={data}
          busy={busy}
          error={commandError}
          close={() => openInventoryModal(undefined)}
          submit={(payload) =>
            command(
              { action: "transfer", ...payload },
              "Transferência concluída.",
            )
          }
        />
      )}{" "}
      {counting && (
        <CountExecutionModal
          count={counting}
          busy={busy}
          error={commandError}
          close={() => {
            setCounting(undefined);
            setCommandError("");
          }}
          submit={(payload) =>
            command(
              { action: "finalize_count", countId: counting.id, ...payload },
              "Contagem finalizada e saldos conciliados.",
            )
          }
        />
      )}
    </div>
  );
}

function InventoryDialog({
  busy,
  close,
  label,
  children,
}: {
  busy: boolean;
  close: () => void;
  label: string;
  children: ReactNode;
}) {
  // Keep the portal's focus lifecycle stable while fields, errors and request
  // state change. Pending mutations cannot be dismissed accidentally.
  const current = useRef({ busy, close });
  useEffect(() => { current.current = { busy, close }; }, [busy, close]);
  const [dismiss] = useState(() => () => {
    if (!current.current.busy) current.current.close();
  });
  return (
    <ErpModal className="purchase-modal inventory-modal" label={label} close={dismiss}>
      {children}
    </ErpModal>
  );
}

function WarehouseModal({
  busy,
  error,
  close,
  submit,
}: {
  busy: boolean;
  error: string;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <InventoryDialog busy={busy} close={close} label="Novo depósito">
      <form onSubmit={save} aria-busy={busy}>
        <header>
          <div>
            <small>LOCAL FÍSICO DE ESTOQUE</small>
            <h2 id="warehouse-modal-title">Novo depósito</h2>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Fechar novo depósito">
            ×
          </button>
        </header>
        {error && <div className="tenant-error wide" role="alert">{error}</div>}
        <label>
          Nome
          <input name="name" required disabled={busy} />
        </label>
        <label>
          Código
          <input name="code" placeholder="Ex.: LOJA-02" disabled={busy} />
        </label>
        <label className="wide">
          Descrição
          <textarea name="description" disabled={busy} />
        </label>
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Criar depósito"}
          </button>
        </footer>
      </form>
    </InventoryDialog>
  );
}

function CountSetupModal({
  warehouses,
  busy,
  error,
  close,
  submit,
}: {
  warehouses: Warehouse[];
  busy: boolean;
  error: string;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <InventoryDialog busy={busy} close={close} label="Abrir contagem">
      <form onSubmit={save} aria-busy={busy}>
        <header>
          <div>
            <small>FOTOGRAFIA DO SALDO ATUAL</small>
            <h2 id="count-setup-modal-title">Abrir contagem</h2>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Fechar abertura de contagem">
            ×
          </button>
        </header>
        {error && <div className="tenant-error wide" role="alert">{error}</div>}
        <label className="wide">
          Depósito
          <select name="warehouseId" required disabled={busy}>
            <option value="">Selecione</option>
            {warehouses.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name} · {item.code}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Método de contagem
          <select name="blind" defaultValue="true" disabled={busy}>
            <option value="true">
              Cega · a equipe não visualiza o saldo do sistema
            </option>
            <option value="false">Orientada · mostra o saldo esperado</option>
          </select>
        </label>
        <label className="wide">
          Orientações para a equipe
          <textarea name="notes" disabled={busy} />
        </label>
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Abrindo…" : "Abrir contagem"}
          </button>
        </footer>
      </form>
    </InventoryDialog>
  );
}

function CountExecutionModal({
  count,
  busy,
  error,
  close,
  submit,
}: {
  count: InventoryCount;
  busy: boolean;
  error: string;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<number, string>>(
      Object.fromEntries(
        count.items.map((item) => [
          item.id,
          count.blind ? "" : String(item.systemQuantity),
        ]),
      ),
    ),
    [query, setQuery] = useState(""),
    [formError, setFormError] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
  const visibleItems = count.items.filter(
    (item) =>
      !normalizedQuery ||
      `${item.product.name} ${item.product.sku}`
        .toLocaleLowerCase("pt-BR")
        .includes(normalizedQuery),
  );
  const completedItems = count.items.filter((item) => {
    const value = values[item.id]?.trim();
    return Boolean(value) && Number.isFinite(Number(value)) && Number(value) >= 0;
  }).length;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (completedItems !== count.items.length) {
      setFormError(
        `Informe a quantidade de todos os ${count.items.length} produtos antes de finalizar.`,
      );
      return;
    }
    setFormError("");
    await submit({
      items: count.items.map((item) => ({
        itemId: item.id,
        countedQuantity: Number(values[item.id]),
      })),
    });
  }
  return (
    <InventoryDialog busy={busy} close={close} label="Informar contagem física">
      <form onSubmit={save} aria-busy={busy}>
        <header>
          <div>
            <small>
              {count.number} · {count.warehouse.name}
            </small>
            <h2 id="count-execution-modal-title">Informar contagem física</h2>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Fechar contagem física">
            ×
          </button>
        </header>
        {error && <div className="tenant-error wide" role="alert">{error}</div>}
        <div className="receipt-warning wide">
          Confira todos os itens. Ao finalizar, diferenças atualizarão o
          depósito e o saldo total do produto em uma única transação auditada.
        </div>
        <div className="inventory-count-progress wide">
          <div>
            <strong>
              {completedItems} de {count.items.length} informados
            </strong>
            <span>
              {Math.round(
                (completedItems / Math.max(1, count.items.length)) * 100,
              )}
              %
            </span>
          </div>
          <i role="progressbar" aria-label="Produtos com quantidade informada" aria-valuemin={0} aria-valuemax={count.items.length} aria-valuenow={completedItems}>
            <b
              style={{
                width: `${(completedItems / Math.max(1, count.items.length)) * 100}%`,
              }}
            />
          </i>
          <label>
            <span>Localizar produto</span>
            <input
              type="search"
              disabled={busy}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nome ou SKU"
            />
          </label>
        </div>
        {formError && (
          <div className="tenant-error wide" role="alert">
            {formError}
          </div>
        )}
        <section className="receipt-lines wide">
          {visibleItems.map((item) => (
            <label key={item.id}>
              <span>
                <strong>{item.product.name}</strong>
                <small>
                  {count.blind
                    ? "Saldo do sistema oculto até o fechamento"
                    : `Sistema: ${numberValue(item.systemQuantity)} ${item.product.unit}`}
                </small>
              </span>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={values[item.id]}
                disabled={busy}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [item.id]: event.target.value,
                  }))
                }
                aria-label={`Quantidade contada de ${item.product.name}`}
                required
              />
            </label>
          ))}
          {!visibleItems.length && (
            <Empty text="Nenhum produto corresponde à busca." />
          )}
        </section>
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancelar
          </button>
          <button
            className="primary"
            disabled={busy || completedItems !== count.items.length}
          >
            {busy ? "Conciliando…" : "Finalizar contagem"}
          </button>
        </footer>
      </form>
    </InventoryDialog>
  );
}

function TransferModal({
  catalog,
  busy,
  error,
  close,
  submit,
}: {
  catalog: InventoryCatalog;
  busy: boolean;
  error: string;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [rows, setRows] = useState<
      Array<{ productId: string; quantity: string }>
    >([{ productId: "", quantity: "1" }]),
    [fromWarehouseId, setFromWarehouseId] = useState(""),
    [toWarehouseId, setToWarehouseId] = useState("");
  const activeWarehouses = catalog.warehouses.filter(
    (warehouse) => warehouse.active,
  );
  const originWarehouses = activeWarehouses.filter((warehouse) =>
    warehouse.balances.some(
      (balance) => balance.quantity - balance.reservedQuantity > 0.000001,
    ),
  );
  const sourceWarehouse = activeWarehouses.find(
    (warehouse) => String(warehouse.id) === fromWarehouseId,
  );
  const availableBalances =
    sourceWarehouse?.balances.filter(
      (balance) => balance.quantity - balance.reservedQuantity > 0.000001,
    ) || [];
  const availableForProduct = (productId: string) => {
    const balance = availableBalances.find(
      (item) => String(item.productId) === productId,
    );
    return balance ? balance.quantity - balance.reservedQuantity : undefined;
  };
  const transferReady = Boolean(
    fromWarehouseId &&
    toWarehouseId &&
    rows.length &&
    rows.every((row) => {
      const balance = availableBalances.find(
        (item) => String(item.productId) === row.productId,
      );
      const quantity = Number(row.quantity);
      return (
        balance &&
        Number.isFinite(quantity) &&
        quantity > 0 &&
        quantity <= balance.quantity - balance.reservedQuantity
      );
    }),
  );
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!transferReady || busy) return;
    const form = Object.fromEntries(new FormData(e.currentTarget));
    await submit({
      ...form,
      items: rows
        .filter((row) => row.productId)
        .map((row) => ({
          productId: Number(row.productId),
          quantity: Number(row.quantity),
        })),
    });
  }
  return (
    <InventoryDialog busy={busy} close={close} label="Nova transferência">
      <form onSubmit={save} aria-busy={busy}>
        <header>
          <div>
            <small>TRANSFERÊNCIA TRANSACIONAL</small>
            <h2 id="transfer-modal-title">Nova transferência</h2>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Fechar transferência">
            ×
          </button>
        </header>
        {error && <div className="tenant-error wide" role="alert">{error}</div>}
        <label>
          Origem
          <select
            name="fromWarehouseId"
            value={fromWarehouseId}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;
              setFromWarehouseId(next);
              if (next === toWarehouseId) setToWarehouseId("");
              setRows([{ productId: "", quantity: "1" }]);
            }}
            required
          >
            <option value="">Selecione</option>
            {originWarehouses.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name} · {item.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destino
          <select
            name="toWarehouseId"
            value={toWarehouseId}
            onChange={(event) => setToWarehouseId(event.target.value)}
            disabled={busy || !fromWarehouseId}
            required
          >
            <option value="">Selecione</option>
            {activeWarehouses
              .filter((item) => String(item.id) !== fromWarehouseId)
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name} · {item.code}
                </option>
              ))}
          </select>
        </label>
        <section className="purchase-lines wide">
          <header>
            <div>
              <strong>Produtos</strong>
              <small>
                {sourceWarehouse
                  ? `${availableBalances.length} produto(s) com saldo disponível na origem`
                  : "Selecione a origem para carregar os saldos"}
              </small>
            </div>
            <button
              type="button"
              disabled={
                busy || !sourceWarehouse || rows.length >= availableBalances.length
              }
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { productId: "", quantity: "1" },
                ])
              }
            >
              + Adicionar
            </button>
          </header>
          {rows.map((row, index) => (
            <div className="transfer-line" key={index}>
              <select
                aria-label={`Produto da linha ${index + 1}`}
                disabled={busy || !sourceWarehouse}
                value={row.productId}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item, rowIndex) =>
                      rowIndex === index
                        ? { ...item, productId: event.target.value }
                        : item,
                    ),
                  )
                }
                required
              >
                <option value="">Selecione o produto</option>
                {availableBalances
                  .filter(
                    (balance) =>
                      !rows.some(
                        (other, rowIndex) =>
                          rowIndex !== index &&
                          other.productId === String(balance.productId),
                      ),
                  )
                  .map((balance) => (
                    <option value={balance.productId} key={balance.productId}>
                      {balance.product.name} · disponível{" "}
                      {numberValue(balance.quantity - balance.reservedQuantity)}{" "}
                      {balance.product.unit}
                    </option>
                  ))}
              </select>
              <input
                aria-label={`Quantidade da linha ${index + 1}`}
                type="number"
                min="0.0001"
                max={availableForProduct(row.productId)}
                step="0.0001"
                value={row.quantity}
                disabled={busy || !row.productId}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item, rowIndex) =>
                      rowIndex === index
                        ? { ...item, quantity: event.target.value }
                        : item,
                    ),
                  )
                }
                required
              />
              <button
                type="button"
                aria-label={`Remover produto da linha ${index + 1}`}
                disabled={busy || rows.length === 1}
                onClick={() =>
                  setRows((current) =>
                    current.filter((_, rowIndex) => rowIndex !== index),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </section>
        <label className="wide">
          Observações
          <textarea name="notes" disabled={busy} />
        </label>
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancelar
          </button>
          <button className="primary" disabled={busy || !transferReady}>
            {busy ? "Transferindo…" : "Concluir transferência"}
          </button>
        </footer>
      </form>
    </InventoryDialog>
  );
}

function Activities() {
  const [data, setData] = useState<AuditCatalog>(),
    [query, setQuery] = useState(""),
    [entityType, setEntityType] = useState(""),
    [selected, setSelected] = useState<AuditEvent>(),
    [error, setError] = useState("");
  async function load(page = 1) {
    setError("");
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (query) params.set("search", query);
    if (entityType) params.set("entityType", entityType);
    const response = await fetch(`/api/erp/activities?${params}`, {
      cache: "no-store",
    });
    const body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error || "Não foi possível carregar a auditoria.");
  }
  useEffect(() => {
    load();
  }, []);
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await load(1);
  }
  const exportParams = new URLSearchParams({ format: "csv" });
  if (query) exportParams.set("search", query);
  if (entityType) exportParams.set("entityType", entityType);
  if (!data)
    return (
      <div className="tenant-loading">Carregando trilha de auditoria…</div>
    );
  return (
    <div className="erp-activities">
      <section className="tenant-kpis">
        <Kpi
          label="Eventos hoje"
          value={String(data.summary.today)}
          detail="ERP e integrações"
        />
        <Kpi
          label="Resultado da consulta"
          value={String(data.summary.total)}
          detail="Eventos encontrados"
        />
        <Kpi
          label="Atores nesta página"
          value={String(data.summary.actors)}
          detail="Usuários identificados"
        />
        <Kpi
          label="Com correlação"
          value={String(data.summary.correlated)}
          detail="Fluxos rastreáveis"
        />
      </section>
      <form className="tenant-toolbar activity-toolbar" onSubmit={search}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar ação, entidade, registro ou correlação…"
        />
        <select
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
        >
          <option value="">Todas as entidades</option>
          {data.facets.entityTypes.map((item) => (
            <option value={item} key={item}>
              {entityLabel(item)}
            </option>
          ))}
        </select>
        <button>Filtrar</button>
        <a className="primary" href={`/api/erp/activities?${exportParams}`}>
          Exportar CSV
        </a>
      </form>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-panel tenant-table">
        <header>
          <div>
            <h2>Linha do tempo auditável</h2>
            <small>
              ERP, PDV, configurações e integrações em uma trilha única
            </small>
          </div>
          <span>{data.pagination.total}</span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Data e hora</th>
                <th>Ator</th>
                <th>Ação</th>
                <th>Entidade</th>
                <th>Registro</th>
                <th>Correlação</th>
                <th>Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((event) => (
                <tr key={event.id}>
                  <td>{dateTime(event.createdAt)}</td>
                  <td>
                    <strong>{event.actor.name}</strong>
                    <small>{event.actor.email}</small>
                  </td>
                  <td>
                    <span className="audit-action">
                      {actionLabel(event.action)}
                    </span>
                  </td>
                  <td>{entityLabel(event.entityType)}</td>
                  <td>{event.entityId || "—"}</td>
                  <td>
                    <code className="audit-correlation">
                      {event.correlationId?.slice(0, 8) || "—"}
                    </code>
                  </td>
                  <td>
                    <button onClick={() => setSelected(event)}>
                      Visualizar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.items.length && (
            <Empty text="Nenhum evento encontrado para os filtros informados." />
          )}
        </div>
        <footer className="audit-pagination">
          <span>
            Página {data.pagination.page} de {data.pagination.pages}
          </span>
          <div>
            <button
              disabled={data.pagination.page <= 1}
              onClick={() => load(data.pagination.page - 1)}
            >
              Anterior
            </button>
            <button
              disabled={data.pagination.page >= data.pagination.pages}
              onClick={() => load(data.pagination.page + 1)}
            >
              Próxima
            </button>
          </div>
        </footer>
      </section>
      {selected && (
        <AuditDetail event={selected} close={() => setSelected(undefined)} />
      )}
    </div>
  );
}

function AuditDetail({
  event,
  close,
}: {
  event: AuditEvent;
  close: () => void;
}) {
  const changes = auditChanges(event);
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <section className="audit-detail">
        <header>
          <div>
            <small>EVENTO IMUTÁVEL · {event.id}</small>
            <h2>{actionLabel(event.action)}</h2>
          </div>
          <button onClick={close}>×</button>
        </header>
        <div className="audit-detail-meta">
          <p>
            <small>Ator</small>
            <strong>{event.actor.name}</strong>
            <span>{event.actor.email}</span>
          </p>
          <p>
            <small>Entidade</small>
            <strong>
              {entityLabel(event.entityType)} #{event.entityId || "—"}
            </strong>
            <span>{dateTime(event.createdAt)}</span>
          </p>
          <p>
            <small>Correlação</small>
            <strong>{event.correlationId || "Não informada"}</strong>
            <span>Identificador para rastrear o fluxo completo</span>
          </p>
        </div>
        <h3>Alterações registradas</h3>
        <div className="audit-change-list">
          {changes.map((change) => (
            <article key={change.key}>
              <strong>{fieldLabel(change.key)}</strong>
              {change.before !== undefined && (
                <span>
                  <small>Antes</small>
                  {auditValue(change.before)}
                </span>
              )}
              <span>
                <small>Depois</small>
                {auditValue(change.after)}
              </span>
            </article>
          ))}
          {!changes.length && (
            <Empty text="O evento não possui campos adicionais registrados." />
          )}
        </div>
        <footer>
          <button onClick={close}>Fechar</button>
        </footer>
      </section>
    </div>
  );
}

function UsersAccess() {
  const [data, setData] = useState<UserCatalog>(),
    [tab, setTab] = useState("members"),
    [inviteOpen, setInviteOpen] = useState(false),
    [roleOpen, setRoleOpen] = useState<TenantRole | null | undefined>(
      undefined,
    ),
    [oneTimeUrl, setOneTimeUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [copied, setCopied] = useState(false);
  async function load() {
    setError("");
    const response = await fetch("/api/erp/users", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error || "Não foi possível carregar os acessos.");
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>, success: string) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível concluir a operação.");
      return;
    }
    setNotice(success);
    await load();
    return body;
  }
  async function invite(payload: Record<string, unknown>) {
    const result = await command(
      { action: "invite.create", ...payload },
      "Convite criado. Copie o link e envie ao usuário.",
    );
    if (result) {
      setInviteOpen(false);
      setOneTimeUrl(result.acceptanceUrl);
    }
  }
  async function rotate(inviteId: string) {
    const result = await command(
      { action: "invite.rotate", inviteId },
      "O link anterior foi invalidado e um novo foi emitido.",
    );
    if (result) setOneTimeUrl(result.acceptanceUrl);
  }
  async function copy() {
    await navigator.clipboard.writeText(oneTimeUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }
  if (!data)
    return (
      <div className="tenant-loading">
        Carregando equipe, convites e permissões…
      </div>
    );
  const availableRoles = data.roles.filter(
    (role) => role.active && role.key !== "owner",
  );
  return (
    <div className="erp-users">
      {notice && <div className="tenant-notice">{notice}</div>}
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Usuários ativos"
          value={String(data.summary.active)}
          detail="Memberships liberadas"
        />
        <Kpi
          label="Acessos bloqueados"
          value={String(data.summary.disabled)}
          detail="Sem entrada na organização"
        />
        <Kpi
          label="Convites pendentes"
          value={String(data.summary.pending)}
          detail="Válidos por sete dias"
        />
        <Kpi
          label="Perfis de acesso"
          value={String(data.summary.roles)}
          detail="Permissões do tenant"
        />
      </section>
      {oneTimeUrl && (
        <section className="one-time-invite">
          <div>
            <span>LINK EXIBIDO SOMENTE AGORA</span>
            <strong>Copie e envie por um canal seguro</strong>
            <small>Emitir outro link invalida este imediatamente.</small>
          </div>
          <code>{oneTimeUrl}</code>
          <button onClick={copy}>{copied ? "Copiado ✓" : "Copiar link"}</button>
          <button onClick={() => setOneTimeUrl("")}>Fechar</button>
        </section>
      )}
      <nav className="erp-prototype-tabs inventory-tabs">
        {[
          ["members", "Equipe"],
          ["invites", "Convites"],
          ["roles", "Perfis e permissões"],
        ].map(([id, label]) => (
          <button
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
            key={id}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "members" && (
        <>
          <div className="tenant-toolbar register-toolbar">
            <div>
              <strong>Equipe da organização</strong>
              <small>
                Identidade no controle; permissão no banco exclusivo do tenant
              </small>
            </div>
            <button className="primary" onClick={() => setInviteOpen(true)}>
              + Convidar usuário
            </button>
          </div>
          <section className="tenant-panel tenant-table">
            <header>
              <h2>Usuários com membership</h2>
              <span>{data.members.length}</span>
            </header>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Usuário</th>
                    <th>Último acesso</th>
                    <th>Sessões</th>
                    <th>Perfil</th>
                    <th>Status</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((member) => (
                    <MemberAccessRow
                      member={member}
                      roles={data.roles}
                      busy={busy}
                      save={(payload) =>
                        command(
                          {
                            action: "member.update",
                            membershipId: member.id,
                            ...payload,
                          },
                          "Acesso do usuário atualizado.",
                        )
                      }
                      key={member.id}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {tab === "invites" && (
        <>
          <div className="tenant-toolbar register-toolbar">
            <div>
              <strong>Convites de acesso</strong>
              <small>
                Tokens armazenados somente como hash e rotacionáveis
              </small>
            </div>
            <button className="primary" onClick={() => setInviteOpen(true)}>
              + Novo convite
            </button>
          </div>
          <section className="inventory-operation-list invite-list">
            {data.invites.map((invite) => (
              <article key={invite.id}>
                <i>@</i>
                <div>
                  <strong>{invite.name || invite.email}</strong>
                  <small>
                    {invite.email} · {roleDisplay(invite.roleKey)} · por{" "}
                    {invite.invitedBy.name}
                  </small>
                </div>
                <span className={`invite-state-chip ${invite.status}`}>
                  {inviteStatus(invite.status)}
                </span>
                <time>
                  {invite.status === "pending"
                    ? `Expira ${dateTime(invite.expiresAt)}`
                    : dateTime(invite.createdAt)}
                </time>
                {invite.status === "pending" && (
                  <>
                    <button disabled={busy} onClick={() => rotate(invite.id)}>
                      Novo link
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        command(
                          { action: "invite.revoke", inviteId: invite.id },
                          "Convite revogado.",
                        )
                      }
                    >
                      Revogar
                    </button>
                  </>
                )}
              </article>
            ))}
          </section>
          {!data.invites.length && (
            <section className="tenant-panel">
              <Empty text="Nenhum convite emitido." />
            </section>
          )}
        </>
      )}
      {tab === "roles" && (
        <>
          <div className="tenant-toolbar register-toolbar">
            <div>
              <strong>Matriz de acesso</strong>
              <small>
                Leitura e escrita concedidas explicitamente por recurso
              </small>
            </div>
            <button className="primary" onClick={() => setRoleOpen(null)}>
              + Novo perfil
            </button>
          </div>
          <section className="role-grid">
            {data.roles.map((role) => (
              <article key={role.id}>
                <header>
                  <div>
                    <span>
                      {role.system
                        ? "PERFIL DO SISTEMA"
                        : "PERFIL PERSONALIZADO"}
                    </span>
                    <h2>{role.name}</h2>
                  </div>
                  <b>{role._count.members} usuário(s)</b>
                </header>
                <p>{role.description || "Sem descrição."}</p>
                <div>
                  <strong>
                    {role.permissions.includes("*")
                      ? "Acesso integral"
                      : `${role.permissions.length} permissões`}
                  </strong>
                  <small>
                    {role.permissions.includes("*")
                      ? "Todas as operações da organização"
                      : `${role.permissions.filter((item) => item.endsWith(".write")).length} recursos com escrita`}
                  </small>
                </div>
                <footer>
                  {role.key === "owner" ? (
                    <span>Perfil protegido</span>
                  ) : (
                    <button onClick={() => setRoleOpen(role)}>
                      Configurar
                    </button>
                  )}
                </footer>
              </article>
            ))}
          </section>
        </>
      )}
      {inviteOpen && (
        <InviteModal
          roles={availableRoles}
          busy={busy}
          close={() => setInviteOpen(false)}
          submit={invite}
        />
      )}{" "}
      {roleOpen !== undefined && (
        <RoleModal
          role={roleOpen || undefined}
          resources={data.permissionResources}
          busy={busy}
          close={() => setRoleOpen(undefined)}
          submit={async (payload) => {
            const result = await command(
              {
                action: roleOpen ? "role.update" : "role.create",
                ...(roleOpen ? { roleId: roleOpen.id } : {}),
                ...payload,
              },
              roleOpen ? "Perfil atualizado." : "Perfil criado.",
            );
            if (result) setRoleOpen(undefined);
          }}
        />
      )}
    </div>
  );
}

function MemberAccessRow({
  member,
  roles,
  busy,
  save,
}: {
  member: UserCatalog["members"][number];
  roles: TenantRole[];
  busy: boolean;
  save: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [roleKey, setRoleKey] = useState(member.roleKey),
    [status, setStatus] = useState(member.status);
  const owner = member.roleKey === "owner";
  return (
    <tr>
      <td>
        <strong>{member.user.name}</strong>
        <small>{member.user.email}</small>
      </td>
      <td>
        {member.user.lastLoginAt
          ? dateTime(member.user.lastLoginAt)
          : "Nunca acessou"}
      </td>
      <td>{member.user.activeSessions} ativa(s)</td>
      <td>
        <select
          value={roleKey}
          disabled={owner}
          onChange={(event) => setRoleKey(event.target.value)}
        >
          {roles
            .filter((role) => role.active && (role.key !== "owner" || owner))
            .map((role) => (
              <option value={role.key} key={role.id}>
                {role.name}
              </option>
            ))}
        </select>
      </td>
      <td>
        <select
          value={status}
          disabled={owner}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="active">Ativo</option>
          <option value="disabled">Bloqueado</option>
        </select>
      </td>
      <td>
        {owner ? (
          <span className="owner-chip">Proprietário</span>
        ) : (
          <button
            disabled={
              busy || (roleKey === member.roleKey && status === member.status)
            }
            onClick={() => save({ roleKey, status })}
          >
            Salvar
          </button>
        )}
      </td>
    </tr>
  );
}

function InviteModal({
  roles,
  busy,
  close,
  submit,
}: {
  roles: TenantRole[];
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>CONVITE COM TOKEN DE USO ÚNICO</small>
            <h2>Convidar usuário</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label>
          Nome
          <input name="name" />
        </label>
        <label>
          E-mail
          <input name="email" type="email" required />
        </label>
        <label className="wide">
          Perfil
          <select name="roleKey" required>
            <option value="">Selecione</option>
            {roles.map((role) => (
              <option value={role.key} key={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <div className="receipt-warning wide">
          O link ficará visível uma vez após salvar. O banco guarda apenas o
          hash e nunca permite recuperar o token original.
        </div>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Emitindo…" : "Criar convite"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function RoleModal({
  role,
  resources,
  busy,
  close,
  submit,
}: {
  role?: TenantRole;
  resources: UserCatalog["permissionResources"];
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const initial = role?.permissions.includes("*")
      ? resources.flatMap((item) => [`${item.key}.read`, `${item.key}.write`])
      : role?.permissions || [],
    [permissions, setPermissions] = useState(new Set(initial));
  function toggle(value: string) {
    setPermissions((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit({
      ...Object.fromEntries(new FormData(e.currentTarget)),
      key: role?.key,
      permissions: [...permissions],
    });
  }
  return (
    <div className="tenant-modal role-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>PERMISSÃO POR RECURSO E AÇÃO</small>
            <h2>{role ? "Configurar perfil" : "Novo perfil"}</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label>
          Nome
          <input name="name" defaultValue={role?.name || ""} required />
        </label>
        {!role && (
          <label>
            Identificador
            <input name="key" placeholder="Gerado pelo nome se vazio" />
          </label>
        )}
        <label className="wide">
          Descrição
          <input name="description" defaultValue={role?.description || ""} />
        </label>
        <section className="permission-matrix wide">
          <header>
            <strong>Recurso</strong>
            <span>Consultar</span>
            <span>Alterar</span>
          </header>
          {resources.map((resource) => (
            <label key={resource.key}>
              <strong>{resource.label}</strong>
              <input
                type="checkbox"
                checked={permissions.has(`${resource.key}.read`)}
                onChange={() => toggle(`${resource.key}.read`)}
              />
              <input
                type="checkbox"
                checked={permissions.has(`${resource.key}.write`)}
                onChange={() => toggle(`${resource.key}.write`)}
              />
            </label>
          ))}
        </section>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar perfil"}
          </button>
        </footer>
      </form>
    </div>
  );
}
function LegacyFiscal() {
  const [data, setData] = useState<any>(),
    [modal, setModal] = useState<{
      mode: "certificate" | "document";
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const response = await fetch("/api/erp/fiscal", { cache: "no-store" }),
      body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/fiscal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">
        {error || "Carregando central fiscal…"}
      </div>
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Autorizadas"
          value={String(data.summary.authorized)}
          detail="Documentos com protocolo"
        />
        <Kpi
          label="Fila/contingência"
          value={String(data.summary.queued)}
          detail="Aguardando processamento"
          alert={data.summary.queued > 0}
        />
        <Kpi
          label="Rejeições"
          value={String(data.summary.rejected)}
          detail="Exigem correção"
          alert={data.summary.rejected > 0}
        />
        <Kpi
          label="Alertas de certificado"
          value={String(data.summary.certificateAlerts)}
          detail="Vencido ou até 30 dias"
          alert={data.summary.certificateAlerts > 0}
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Central fiscal</strong>
          <small>
            Preparação local e certificado cifrado; transmissão, retorno e
            cancelamento exigem conector fiscal homologado
          </small>
        </div>
        <div>
          <button onClick={() => setModal({ mode: "certificate" })}>
            Certificado A1
          </button>
          <button
            className="primary"
            disabled={!data.sources.length}
            onClick={() => setModal({ mode: "document" })}
          >
            + Documento
          </button>
        </div>
      </div>
      <section className="purchase-list">
        {data.documents.map((document: any) => (
          <article className="purchase-card" key={document.id}>
            <header>
              <div>
                <span>
                  {document.type.toUpperCase()}{" "}
                  {String(document.series).padStart(3, "0")}.
                  {String(document.number).padStart(9, "0")}
                </span>
                <h2>{document.recipient}</h2>
              </div>
              <em
                className={`purchase-status ${document.status === "authorized" ? "received" : document.status === "rejected" ? "cancelled" : "ordered"}`}
              >
                {fiscalStatus(document.status)}
              </em>
            </header>
            <div className="purchase-meta">
              <span>
                <small>Ambiente</small>
                <strong>
                  {document.environment === "production"
                    ? "Produção"
                    : "Homologação"}
                </strong>
              </span>
              <span>
                <small>Valor</small>
                <strong>{money.format(document.amount)}</strong>
              </span>
              <span>
                <small>Protocolo</small>
                <strong>{document.protocol || "—"}</strong>
              </span>
              <span>
                <small>Chave</small>
                <strong>
                  {document.accessKey
                    ? `${document.accessKey.slice(0, 6)}…${document.accessKey.slice(-6)}`
                    : "—"}
                </strong>
              </span>
            </div>
            <div className="purchase-items">
              {document.events.map((event: any) => (
                <div key={event.id}>
                  <span>
                    <strong>{fiscalStatus(event.type)}</strong>
                    <small>{event.description}</small>
                  </span>
                  <b>{dateTime(event.createdAt)}</b>
                </div>
              ))}
            </div>
            <footer>
              <small>
                Origem {document.sourceType} #{document.sourceId}
              </small>
              <div>
                {document.status === "draft" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      command({ action: "queue", documentId: document.id })
                    }
                  >
                    Preparar para transmissão
                  </button>
                )}
                {["queued", "contingency"].includes(document.status) && (
                  <small>Aguardando conector fiscal homologado</small>
                )}
                {document.status === "authorized" && (
                  <small>Cancelamento somente pelo conector fiscal</small>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      <section className="tenant-panel tenant-table">
        <header>
          <h2>Certificados instalados</h2>
          <span>{data.certificates.length}</span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Filial</th>
                <th>Fingerprint</th>
                <th>Validade</th>
                <th>Status</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {data.certificates.map((cert: any) => (
                <tr key={cert.id}>
                  <td>{cert.name}</td>
                  <td>
                    {
                      data.branches.find(
                        (branch: any) => branch.id === cert.branchId,
                      )?.name
                    }
                  </td>
                  <td>{cert.fingerprint}</td>
                  <td>{shortDate(cert.expiresAt)}</td>
                  <td>{cert.active ? "Ativo" : "Inativo"}</td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() =>
                        command({
                          action: "certificate.toggle",
                          certificateId: cert.id,
                        })
                      }
                    >
                      {cert.active ? "Desativar" : "Ativar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {modal && (
        <FiscalModal
          config={modal}
          data={data}
          busy={busy}
          close={() => setModal(null)}
          submit={async (payload) => {
            const action =
              modal.mode === "certificate"
                ? "certificate.save"
                : "document.create";
            if (
              await command({
                action,
                ...payload,
              })
            )
              setModal(null);
          }}
        />
      )}
    </div>
  );
}
function FiscalModal({
  config,
  data,
  busy,
  close,
  submit,
}: {
  config: {
    mode: "certificate" | "document";
  };
  data: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      values = Object.fromEntries(form);
    if (config.mode === "certificate") {
      const file = form.get("certificate") as File;
      delete values.certificate;
      values.content = await browserFileBase64(file);
    }
    await submit(values);
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <h2>
            {config.mode === "certificate"
              ? "Instalar certificado A1"
              : "Preparar documento fiscal"}
          </h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        {config.mode === "certificate" && (
          <>
            <div className="receipt-warning wide">
              O PFX e a senha são cifrados com AES-256-GCM. A API nunca devolve
              o conteúdo.
            </div>
            <label>
              Nome
              <input name="name" required />
            </label>
            <label>
              Filial
              <select name="branchId" required>
                {data.branches.map((item: any) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Arquivo PFX
              <input
                name="certificate"
                type="file"
                accept=".pfx,.p12,application/x-pkcs12"
                required
              />
            </label>
            <label>
              Senha
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              Validade
              <input name="expiresAt" type="date" required />
            </label>
          </>
        )}
        {config.mode === "document" && (
          <>
            <label>
              Filial
              <select name="branchId" required>
                {data.branches.map((item: any) => (
                  <option value={item.id} key={item.id}>
                    {item.name} ·{" "}
                    {item.settings?.fiscalEnvironment === "production"
                      ? "produção"
                      : "homologação"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Modelo
              <select name="type">
                <option value="nfe">NF-e</option>
                <option value="nfce">NFC-e</option>
                <option value="nfse">NFS-e</option>
              </select>
            </label>
            <label className="wide">
              Pedido concluído
              <select name="sourceId" required>
                <option value="">Selecione</option>
                {data.sources.map((item: any) => (
                  <option value={item.id} key={item.id}>
                    {item.number} · {item.customerName} ·{" "}
                    {money.format(item.total)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Confirmar
          </button>
        </footer>
      </form>
    </div>
  );
}
async function browserFileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function Automations() {
  const [data, setData] = useState<any>(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const response = await fetch("/api/erp/automations", { cache: "no-store" }),
      body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">{error || "Carregando automações…"}</div>
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Regras ativas"
          value={String(data.summary.active)}
          detail="Monitoradas"
        />
        <Kpi
          label="Execuções"
          value={String(data.summary.runs)}
          detail="Histórico recente"
        />
        <Kpi
          label="Ações geradas"
          value={String(data.summary.actions)}
          detail="Notificações e tarefas"
        />
        <Kpi
          label="Falhas"
          value={String(data.summary.failures)}
          detail="Exigem revisão"
          alert={data.summary.failures > 0}
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Regras e automações</strong>
          <small>
            Condições reais, execução idempotente por janela e evidência em
            auditoria
          </small>
        </div>
        <div>
          <button onClick={() => setOpen(true)}>+ Regra</button>
          <button
            className="primary"
            disabled={busy || !data.summary.active}
            onClick={() => command({ action: "scan" })}
          >
            Executar varredura
          </button>
        </div>
      </div>
      <section className="branch-grid">
        {data.rules.map((rule: any) => (
          <article className="branch-card" key={rule.id}>
            <header>
              <div>
                <span>{automationTrigger(rule.trigger)}</span>
                <h2>{rule.name}</h2>
              </div>
              <i className={rule.active ? "" : "inactive"}>
                {rule.active ? "ATIVA" : "PAUSADA"}
              </i>
            </header>
            <p>
              <strong>
                {rule.conditionField} {rule.operator} {rule.conditionValue}
              </strong>
              <span>{automationAction(rule.actionType)}</span>
            </p>
            <dl>
              <div>
                <dt>Execuções</dt>
                <dd>{rule.runs.length}</dd>
              </div>
              <div>
                <dt>Correspondências</dt>
                <dd>
                  {rule.runs.reduce(
                    (sum: number, run: any) => sum + run.matchedCount,
                    0,
                  )}
                </dd>
              </div>
              <div>
                <dt>Ações</dt>
                <dd>
                  {rule.runs.reduce(
                    (sum: number, run: any) => sum + run.actionCount,
                    0,
                  )}
                </dd>
              </div>
              <div>
                <dt>Última</dt>
                <dd>
                  {rule.runs[0] ? shortDate(rule.runs[0].startedAt) : "—"}
                </dd>
              </div>
            </dl>
            <footer>
              <button
                onClick={() => command({ action: "toggle", ruleId: rule.id })}
              >
                {rule.active ? "Pausar" : "Ativar"}
              </button>
              <button
                className="primary"
                disabled={busy || !rule.active}
                onClick={() => command({ action: "run", ruleId: rule.id })}
              >
                Executar
              </button>
            </footer>
          </article>
        ))}
      </section>
      <section className="tenant-panel tenant-table">
        <header>
          <h2>Notificações e tarefas</h2>
          <span>{data.notifications.length}</span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Regra</th>
                <th>Assunto</th>
                <th>Mensagem</th>
                <th>Data</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.notifications.map((item: any) => (
                <tr key={item.id}>
                  <td>{item.rule.name}</td>
                  <td>{item.subject}</td>
                  <td>{item.message}</td>
                  <td>{dateTime(item.createdAt)}</td>
                  <td>
                    <button
                      disabled={item.status === "read"}
                      onClick={() =>
                        command({
                          action: "notification.read",
                          notificationId: item.id,
                        })
                      }
                    >
                      {item.status === "read" ? "Lida" : "Marcar lida"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {open && (
        <AutomationModal
          busy={busy}
          close={() => setOpen(false)}
          submit={async (payload) => {
            if (await command({ action: "create", ...payload })) setOpen(false);
          }}
        />
      )}
    </div>
  );
}
function AutomationModal({
  busy,
  close,
  submit,
}: {
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <h2>Nova regra</h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Nome
          <input name="name" required />
        </label>
        <label>
          Gatilho
          <select name="trigger">
            <option value="low_stock">Estoque baixo</option>
            <option value="overdue_title">Título vencido</option>
            <option value="shipment_incident">Ocorrência logística</option>
          </select>
        </label>
        <label>
          Operador
          <select name="operator">
            <option value="lte">Menor ou igual</option>
            <option value="lt">Menor que</option>
            <option value="gte">Maior ou igual</option>
            <option value="gt">Maior que</option>
            <option value="eq">Igual</option>
          </select>
        </label>
        <label>
          Valor da condição
          <input name="conditionValue" type="number" step=".01" required />
        </label>
        <label>
          Ação
          <select name="actionType">
            <option value="notify">Notificar</option>
            <option value="create_task">Criar tarefa</option>
            <option value="audit">Somente auditar</option>
          </select>
        </label>
        <label className="wide">
          Mensagem
          <input name="message" required />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Salvar regra
          </button>
        </footer>
      </form>
    </div>
  );
}

function Privacy() {
  const [data, setData] = useState<any>(),
    [modal, setModal] = useState<{
      mode: "request" | "basis" | "retention" | "incident" | "evidence";
      item?: any;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const response = await fetch("/api/erp/privacy", { cache: "no-store" }),
      body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/privacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">{error || "Carregando privacidade…"}</div>
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Solicitações abertas"
          value={String(data.summary.requests)}
          detail="Direitos dos titulares"
        />
        <Kpi
          label="No prazo"
          value={String(data.summary.onTime)}
          detail="Prazo operacional"
        />
        <Kpi
          label="Bases mapeadas"
          value={String(data.summary.mapped)}
          detail="Finalidades documentadas"
        />
        <Kpi
          label="Riscos abertos"
          value={String(data.summary.risks)}
          detail="Incidentes em tratamento"
          alert={data.summary.risks > 0}
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Privacidade e LGPD</strong>
          <small>
            Bases legais, retenção, direitos do titular, incidentes e evidências
          </small>
        </div>
        <div>
          <button onClick={() => setModal({ mode: "basis" })}>
            + Base legal
          </button>
          <button onClick={() => setModal({ mode: "retention" })}>
            + Retenção
          </button>
          <button onClick={() => setModal({ mode: "incident" })}>
            + Incidente
          </button>
          <button
            className="primary"
            onClick={() => setModal({ mode: "request" })}
          >
            + Solicitação
          </button>
        </div>
      </div>
      <section className="purchase-list">
        {data.requests.map((item: any) => (
          <article className="purchase-card" key={item.id}>
            <header>
              <div>
                <span>
                  {item.number} · {privacyType(item.type)}
                </span>
                <h2>{item.subjectName}</h2>
              </div>
              <em
                className={`purchase-status ${item.status === "completed" ? "received" : "ordered"}`}
              >
                {privacyStatus(item.status)}
              </em>
            </header>
            <div className="purchase-meta">
              <span>
                <small>Documento</small>
                <strong>{item.subjectDocument}</strong>
              </span>
              <span>
                <small>Contato</small>
                <strong>{item.contact}</strong>
              </span>
              <span>
                <small>Prazo</small>
                <strong>{shortDate(item.dueAt)}</strong>
              </span>
              <span>
                <small>Responsável</small>
                <strong>{item.assignedTo || "A definir"}</strong>
              </span>
            </div>
            <footer>
              <small>{item.evidence || "Evidência ainda não registrada"}</small>
              <div>
                {item.status === "received" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      command({ action: "request.verify", requestId: item.id })
                    }
                  >
                    Identidade validada
                  </button>
                )}
                {item.status === "verified" && (
                  <button
                    className="primary"
                    onClick={() => setModal({ mode: "evidence", item })}
                  >
                    Concluir com evidência
                  </button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      <section className="branch-grid">
        {data.bases.map((basis: any) => (
          <article className="branch-card" key={`b${basis.id}`}>
            <header>
              <div>
                <span>{basis.basis.toUpperCase()}</span>
                <h2>{basis.name}</h2>
              </div>
            </header>
            <p>
              <strong>{basis.dataCategory}</strong>
              <span>{basis.purpose}</span>
            </p>
          </article>
        ))}
        {data.retention.map((rule: any) => (
          <article className="branch-card" key={`r${rule.id}`}>
            <header>
              <div>
                <span>RETENÇÃO</span>
                <h2>{rule.dataCategory}</h2>
              </div>
            </header>
            <p>
              <strong>
                {rule.retentionDays} dias · {rule.action}
              </strong>
              <span>{rule.legalReason}</span>
            </p>
          </article>
        ))}
        {data.incidents.map((incident: any) => (
          <article className="branch-card" key={`i${incident.id}`}>
            <header>
              <div>
                <span>INCIDENTE {incident.severity.toUpperCase()}</span>
                <h2>{incident.title}</h2>
              </div>
              <i className={incident.status === "resolved" ? "" : "inactive"}>
                {incident.status === "resolved" ? "RESOLVIDO" : "ABERTO"}
              </i>
            </header>
            <p>
              <strong>{incident.affectedSubjects} titular(es)</strong>
              <span>{incident.description}</span>
            </p>
            <footer>
              {incident.status === "open" && (
                <button
                  className="primary"
                  onClick={() =>
                    command({
                      action: "incident.resolve",
                      incidentId: incident.id,
                    })
                  }
                >
                  Resolver
                </button>
              )}
            </footer>
          </article>
        ))}
      </section>
      {modal && (
        <PrivacyModal
          config={modal}
          busy={busy}
          close={() => setModal(null)}
          submit={async (payload) => {
            const action =
              modal.mode === "request"
                ? "request.create"
                : modal.mode === "basis"
                  ? "basis.create"
                  : modal.mode === "retention"
                    ? "retention.upsert"
                    : modal.mode === "incident"
                      ? "incident.create"
                      : "request.complete";
            if (
              await command({ action, requestId: modal.item?.id, ...payload })
            )
              setModal(null);
          }}
        />
      )}
    </div>
  );
}
function PrivacyModal({
  config,
  busy,
  close,
  submit,
}: {
  config: {
    mode: "request" | "basis" | "retention" | "incident" | "evidence";
    item?: any;
  };
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <h2>
            {config.mode === "request"
              ? "Solicitação do titular"
              : config.mode === "basis"
                ? "Mapear base legal"
                : config.mode === "retention"
                  ? "Regra de retenção"
                  : config.mode === "incident"
                    ? "Registrar incidente"
                    : "Evidência de atendimento"}
          </h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        {config.mode === "request" && (
          <>
            <label>
              Direito
              <select name="type">
                <option value="access">Acesso</option>
                <option value="correction">Correção</option>
                <option value="deletion">Eliminação</option>
                <option value="portability">Portabilidade</option>
                <option value="revocation">Revogação</option>
              </select>
            </label>
            <label>
              Titular
              <input name="subjectName" required />
            </label>
            <label>
              CPF/CNPJ
              <input name="subjectDocument" required />
            </label>
            <label>
              Contato
              <input name="contact" required />
            </label>
          </>
        )}
        {config.mode === "basis" && (
          <>
            <label>
              Nome
              <input name="name" required />
            </label>
            <label>
              Base
              <select name="basis">
                <option value="consent">Consentimento</option>
                <option value="contract">Contrato</option>
                <option value="legal_obligation">Obrigação legal</option>
                <option value="legitimate_interest">Legítimo interesse</option>
                <option value="credit_protection">Proteção do crédito</option>
              </select>
            </label>
            <label>
              Categoria de dados
              <input name="dataCategory" required />
            </label>
            <label className="wide">
              Finalidade
              <input name="purpose" required />
            </label>
          </>
        )}
        {config.mode === "retention" && (
          <>
            <label>
              Categoria de dados
              <input name="dataCategory" required />
            </label>
            <label>
              Prazo em dias
              <input
                name="retentionDays"
                type="number"
                min="1"
                max="36500"
                required
              />
            </label>
            <label>
              Ação
              <select name="retentionAction">
                <option value="anonymize">Anonimizar</option>
                <option value="delete">Eliminar</option>
                <option value="review">Revisar</option>
              </select>
            </label>
            <label className="wide">
              Fundamento
              <input name="legalReason" required />
            </label>
          </>
        )}
        {config.mode === "incident" && (
          <>
            <label>
              Título
              <input name="title" required />
            </label>
            <label>
              Severidade
              <select name="severity">
                <option value="low">Baixa</option>
                <option value="medium">Média</option>
                <option value="high">Alta</option>
                <option value="critical">Crítica</option>
              </select>
            </label>
            <label>
              Afetados
              <input
                name="affectedSubjects"
                type="number"
                min="0"
                defaultValue="0"
              />
            </label>
            <label className="wide">
              Descrição
              <textarea name="description" required />
            </label>
          </>
        )}
        {config.mode === "evidence" && (
          <label className="wide">
            Evidência
            <textarea
              name="evidence"
              minLength={2}
              maxLength={1000}
              placeholder="Descreva o atendimento, validações e artefatos entregues"
              required
            />
          </label>
        )}
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Confirmar
          </button>
        </footer>
      </form>
    </div>
  );
}
function fiscalStatus(value: string) {
  return (
    (
      {
        draft: "Rascunho",
        queued: "Na fila",
        authorized: "Autorizado",
        rejected: "Rejeitado",
        contingency: "Contingência",
        cancelled: "Cancelado",
        created: "Criado",
      } as Record<string, string>
    )[value] || value
  );
}
function automationTrigger(value: string) {
  return (
    (
      {
        low_stock: "ESTOQUE BAIXO",
        overdue_title: "TÍTULO VENCIDO",
        shipment_incident: "OCORRÊNCIA LOGÍSTICA",
      } as Record<string, string>
    )[value] || value
  );
}
function automationAction(value: string) {
  return (
    (
      {
        notify: "Notificar",
        audit: "Auditar",
        create_task: "Criar tarefa",
      } as Record<string, string>
    )[value] || value
  );
}
function privacyType(value: string) {
  return (
    (
      {
        access: "Acesso",
        correction: "Correção",
        deletion: "Eliminação",
        portability: "Portabilidade",
        revocation: "Revogação",
      } as Record<string, string>
    )[value] || value
  );
}
function privacyStatus(value: string) {
  return (
    (
      {
        received: "Recebida",
        verified: "Identidade validada",
        completed: "Concluída",
        rejected: "Rejeitada",
      } as Record<string, string>
    )[value] || value
  );
}

function Reconciliation() {
  const [data, setData] = useState<any>(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const response = await fetch("/api/erp/reconciliation", {
        cache: "no-store",
      }),
      body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/reconciliation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">{error || "Carregando conciliação…"}</div>
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="A conciliar"
          value={String(data.summary.pending)}
          detail="Movimentos do extrato"
          alert={data.summary.pending > 0}
        />
        <Kpi
          label="Conciliados"
          value={String(data.summary.reconciled)}
          detail="Razão e títulos atualizados"
        />
        <Kpi
          label="Ignorados"
          value={String(data.summary.divergences)}
          detail="Movimentos justificados"
        />
        <Kpi
          label="Sugestões exatas"
          value={String(data.summary.automation)}
          detail="Mesmo tipo e valor"
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Conciliação bancária</strong>
          <small>
            Importação CSV, sugestão de títulos, baixa e atualização da conta
          </small>
        </div>
        <button
          className="primary"
          disabled={!data.accounts.length}
          onClick={() => setOpen(true)}
        >
          Importar extrato
        </button>
      </div>
      <section className="purchase-list">
        {data.transactions.map((transaction: any) => (
          <ReconciliationCard
            transaction={transaction}
            titles={data.titles}
            busy={busy}
            command={command}
            key={transaction.id}
          />
        ))}
      </section>
      {open && (
        <ReconciliationImport
          data={data}
          busy={busy}
          close={() => setOpen(false)}
          submit={async (payload) => {
            if (await command({ action: "import", ...payload })) setOpen(false);
          }}
        />
      )}
    </div>
  );
}
function ReconciliationCard({
  transaction,
  titles,
  busy,
  command,
}: {
  transaction: any;
  titles: any[];
  busy: boolean;
  command: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const compatible = titles.filter((title) =>
      transaction.amount > 0
        ? title.type === "receivable"
        : title.type === "payable",
    ),
    [titleId, setTitleId] = useState(
      String(transaction.suggestions[0]?.id || ""),
    );
  return (
    <article className="purchase-card">
      <header>
        <div>
          <span>
            {transaction.account.name} · {shortDate(transaction.occurredAt)}
          </span>
          <h2>{transaction.description}</h2>
        </div>
        <em
          className={`purchase-status ${transaction.status === "reconciled" ? "received" : transaction.status === "ignored" ? "cancelled" : "draft"}`}
        >
          {transaction.status === "pending"
            ? "Pendente"
            : transaction.status === "reconciled"
              ? "Conciliado"
              : "Ignorado"}
        </em>
      </header>
      <div className="purchase-meta">
        <span>
          <small>Valor</small>
          <strong>
            {transaction.amount > 0 ? "+" : "−"}
            {money.format(Math.abs(transaction.amount))}
          </strong>
        </span>
        <span>
          <small>Origem</small>
          <strong>{transaction.statementImport.fileName}</strong>
        </span>
        <span>
          <small>Sugestões</small>
          <strong>{transaction.suggestions.length}</strong>
        </span>
        <span>
          <small>Título vinculado</small>
          <strong>{transaction.matchedTitle?.documentNumber || "—"}</strong>
        </span>
      </div>
      {transaction.status === "pending" && (
        <footer>
          <small>
            A conciliação gera lançamento na conta e baixa financeira em uma
            transação.
          </small>
          <div>
            <select
              value={titleId}
              onChange={(event) => setTitleId(event.target.value)}
            >
              <option value="">Sem título</option>
              {compatible.map((title) => (
                <option value={title.id} key={title.id}>
                  {title.documentNumber || title.description} ·{" "}
                  {money.format(title.amount - title.paidAmount)}
                </option>
              ))}
            </select>
            <button
              disabled={busy}
              onClick={() =>
                command({ action: "ignore", transactionId: transaction.id })
              }
            >
              Ignorar
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                command({
                  action: "reconcile",
                  transactionId: transaction.id,
                  titleId: titleId || null,
                })
              }
            >
              Conciliar
            </button>
          </div>
        </footer>
      )}
    </article>
  );
}
function ReconciliationImport({
  data,
  busy,
  close,
  submit,
}: {
  data: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      file = form.get("file") as File;
    await submit({
      accountId: form.get("accountId"),
      fileName: file.name,
      csv: await file.text(),
    });
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <h2>Importar extrato CSV</h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <div className="receipt-warning wide">
          Formato: date;description;amount;external_id. Valores positivos são
          entradas e negativos são saídas.
        </div>
        <label>
          Conta bancária
          <select name="accountId" required>
            <option value="">Selecione</option>
            {data.accounts.map((item: any) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Arquivo CSV
          <input name="file" type="file" accept=".csv,text/csv" required />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Importar
          </button>
        </footer>
      </form>
    </div>
  );
}

function Marketplaces() {
  const [data, setData] = useState<any>(),
    [modal, setModal] = useState<"channel" | "listing" | "order" | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const response = await fetch("/api/erp/marketplaces", {
        cache: "no-store",
      }),
      body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/marketplaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">{error || "Carregando canais…"}</div>
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Canais ativos"
          value={String(data.summary.channels)}
          detail="Integrações operacionais"
        />
        <Kpi
          label="GMV importado"
          value={money.format(data.summary.gmv)}
          detail="Pedidos de todos os canais"
        />
        <Kpi
          label="Pedidos importados"
          value={String(data.summary.orders)}
          detail="Convertidos em pedido interno"
        />
        <Kpi
          label="Anúncios com erro"
          value={String(data.summary.errors)}
          detail="Exigem sincronização"
          alert={data.summary.errors > 0}
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Hub de marketplaces</strong>
          <small>
            Catálogo, estoque, preços, taxas e pedidos sem credenciais expostas
          </small>
        </div>
        <div>
          <button onClick={() => setModal("channel")}>+ Canal</button>
          <button
            disabled={!data.channels.length}
            onClick={() => setModal("listing")}
          >
            + Anúncio
          </button>
          <button
            className="primary"
            disabled={!data.channels.length}
            onClick={() => setModal("order")}
          >
            Importar pedido
          </button>
        </div>
      </div>
      <section className="purchase-list">
        {data.channels.map((channel: any) => (
          <article className="purchase-card" key={channel.id}>
            <header>
              <div>
                <span>{marketplaceProvider(channel.provider)}</span>
                <h2>{channel.name}</h2>
              </div>
              <em
                className={`purchase-status ${channel.status === "active" ? "received" : "cancelled"}`}
              >
                {channel.status === "active" ? "Ativo" : "Pausado"}
              </em>
            </header>
            <div className="purchase-meta">
              <span>
                <small>Anúncios</small>
                <strong>{channel.listings.length}</strong>
              </span>
              <span>
                <small>Pedidos</small>
                <strong>{channel.orders.length}</strong>
              </span>
              <span>
                <small>GMV</small>
                <strong>
                  {money.format(
                    channel.orders.reduce(
                      (sum: number, item: any) => sum + item.total,
                      0,
                    ),
                  )}
                </strong>
              </span>
              <span>
                <small>Última sincronização</small>
                <strong>
                  {channel.lastSyncAt
                    ? dateTime(channel.lastSyncAt)
                    : "Pendente"}
                </strong>
              </span>
            </div>
            <div className="purchase-items">
              {channel.listings.map((listing: any) => (
                <div key={listing.id}>
                  <span>
                    <strong>{listing.title}</strong>
                    <small>
                      {listing.externalId} · {listing.product.sku}
                    </small>
                  </span>
                  <b>
                    {money.format(listing.price)} · saldo{" "}
                    {numberValue(listing.syncedStock)}
                  </b>
                </div>
              ))}
              {channel.orders.map((order: any) => (
                <div key={order.id}>
                  <span>
                    <strong>Pedido {order.externalId}</strong>
                    <small>
                      {order.customerName} · interno {order.salesOrder.number}
                    </small>
                  </span>
                  <b>
                    {money.format(order.total)} ·{" "}
                    {marketplaceOrderStatus(order.status)}
                  </b>
                </div>
              ))}
            </div>
            <footer>
              <small>
                Ambiente{" "}
                {channel.environment === "production" ? "produção" : "sandbox"}{" "}
                · importação {channel.autoImport ? "automática" : "manual"}
              </small>
              <div>
                <button
                  onClick={() =>
                    command({ action: "channel.toggle", channelId: channel.id })
                  }
                >
                  {channel.status === "active" ? "Pausar" : "Ativar"}
                </button>
                <button
                  className="primary"
                  disabled={busy || channel.status !== "active"}
                  onClick={() =>
                    command({ action: "channel.sync", channelId: channel.id })
                  }
                >
                  Sincronizar estoque
                </button>
              </div>
            </footer>
          </article>
        ))}
      </section>
      {modal && (
        <MarketplaceModal
          kind={modal}
          data={data}
          busy={busy}
          close={() => setModal(null)}
          submit={async (payload) => {
            const action =
              modal === "channel"
                ? "channel.create"
                : modal === "listing"
                  ? "listing.upsert"
                  : "order.import";
            if (await command({ action, ...payload })) setModal(null);
          }}
        />
      )}
    </div>
  );
}

function MarketplaceModal({
  kind,
  data,
  busy,
  close,
  submit,
}: {
  kind: "channel" | "listing" | "order";
  data: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [rows, setRows] = useState([
    { productId: "", quantity: "1", unitPrice: "0" },
  ]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await submit(kind === "order" ? { ...values, items: rows } : values);
  }
  function update(index: number, patch: Record<string, string>) {
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, ...patch } : row,
      ),
    );
  }
  return (
    <div className="tenant-modal purchase-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>INTEGRAÇÃO OMNICANAL</small>
            <h2>
              {kind === "channel"
                ? "Novo canal"
                : kind === "listing"
                  ? "Publicar anúncio"
                  : "Importar pedido externo"}
            </h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        {kind === "channel" && (
          <>
            <label>
              Nome
              <input name="name" required />
            </label>
            <label>
              Provedor
              <select name="provider">
                <option value="mercado_livre">Mercado Livre</option>
                <option value="shopee">Shopee</option>
                <option value="woocommerce">WooCommerce</option>
                <option value="other">Outro</option>
              </select>
            </label>
            <label>
              Ambiente
              <select name="environment">
                <option value="production">Produção</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </label>
            <label className="settings-toggle">
              <input name="autoImport" type="checkbox" defaultChecked />
              <span>
                <strong>Importação automática</strong>
                <small>Novos pedidos entram aprovados para expedição</small>
              </span>
            </label>
          </>
        )}
        {kind === "listing" && (
          <>
            <label>
              Canal
              <select name="channelId" required>
                <option value="">Selecione</option>
                {data.channels
                  .filter((item: any) => item.status === "active")
                  .map((item: any) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Produto
              <select name="productId" required>
                <option value="">Selecione</option>
                {data.products.map((item: any) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.sku}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Código externo
              <input name="externalId" required />
            </label>
            <label>
              Preço
              <input name="price" type="number" min="0" step=".01" required />
            </label>
            <label className="wide">
              Título
              <input name="title" required />
            </label>
          </>
        )}
        {kind === "order" && (
          <>
            <label>
              Canal
              <select name="channelId" required>
                <option value="">Selecione</option>
                {data.channels
                  .filter((item: any) => item.status === "active")
                  .map((item: any) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Pedido externo
              <input name="externalId" required />
            </label>
            <label>
              Cliente
              <input name="customerName" required />
            </label>
            <label>
              CPF/CNPJ
              <input name="customerDocument" />
            </label>
            <label>
              Taxa do canal
              <input
                name="fee"
                type="number"
                min="0"
                step=".01"
                defaultValue="0"
              />
            </label>
            <section className="purchase-lines wide">
              <header>
                <strong>Itens do pedido</strong>
                <button
                  type="button"
                  onClick={() =>
                    setRows([
                      ...rows,
                      { productId: "", quantity: "1", unitPrice: "0" },
                    ])
                  }
                >
                  + Item
                </button>
              </header>
              {rows.map((row, index) => (
                <div key={index}>
                  <select
                    value={row.productId}
                    onChange={(event) => {
                      const product = data.products.find(
                        (item: any) => String(item.id) === event.target.value,
                      );
                      update(index, {
                        productId: event.target.value,
                        unitPrice: String(product?.price || 0),
                      });
                    }}
                    required
                  >
                    <option value="">Produto</option>
                    {data.products.map((item: any) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={row.quantity}
                    onChange={(event) =>
                      update(index, { quantity: event.target.value })
                    }
                    type="number"
                    min=".0001"
                    step=".0001"
                    required
                  />
                  <input
                    value={row.unitPrice}
                    onChange={(event) =>
                      update(index, { unitPrice: event.target.value })
                    }
                    type="number"
                    min="0"
                    step=".01"
                    required
                  />
                  <button
                    type="button"
                    disabled={rows.length === 1}
                    onClick={() =>
                      setRows(rows.filter((_, position) => position !== index))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>
          </>
        )}
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Processando…" : "Confirmar"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Logistics() {
  const [data, setData] = useState<any>(),
    [modal, setModal] = useState<{
      type: "create" | "dispatch" | "incident";
      shipment?: any;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const response = await fetch("/api/erp/logistics", { cache: "no-store" }),
      body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/logistics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">{error || "Carregando expedições…"}</div>
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="A separar/embalar"
          value={String(data.summary.pending)}
          detail="Fila operacional"
        />
        <Kpi
          label="Em transporte"
          value={String(data.summary.dispatched)}
          detail="Com rastreamento"
        />
        <Kpi
          label="Fora do prazo"
          value={String(data.summary.late)}
          detail="Prazo de entrega vencido"
          alert={data.summary.late > 0}
        />
        <Kpi
          label="Ocorrências"
          value={String(data.summary.incidents)}
          detail="Eventos reportados"
          alert={data.summary.incidents > 0}
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Expedição e logística</strong>
          <small>Picking, packing, despacho, rastreio e prova de entrega</small>
        </div>
        <button
          className="primary"
          disabled={!data.availableOrders.length}
          onClick={() => setModal({ type: "create" })}
        >
          + Nova expedição
        </button>
      </div>
      {data.availableOrders.length > 0 && (
        <div className="receipt-warning">
          {data.availableOrders.length} pedido(s) aprovado(s) aguardam abertura
          da expedição.
        </div>
      )}
      <section className="purchase-list">
        {data.shipments.map((shipment: any) => (
          <article className="purchase-card" key={shipment.id}>
            <header>
              <div>
                <span>{shipment.number}</span>
                <h2>
                  {shipment.salesOrder.number} ·{" "}
                  {shipment.salesOrder.customerName}
                </h2>
              </div>
              <em
                className={`purchase-status ${shipment.status === "delivered" ? "received" : shipment.status === "dispatched" ? "ordered" : "draft"}`}
              >
                {shipmentStatus(shipment.status)}
              </em>
            </header>
            <div className="purchase-meta">
              <span>
                <small>Depósito</small>
                <strong>{shipment.warehouse.name}</strong>
              </span>
              <span>
                <small>Canal</small>
                <strong>
                  {shipment.channelOrder?.channel.name || "Venda direta"}
                </strong>
              </span>
              <span>
                <small>Transportadora</small>
                <strong>{shipment.carrier || "A definir"}</strong>
              </span>
              <span>
                <small>Rastreio</small>
                <strong>{shipment.trackingCode || "Pendente"}</strong>
              </span>
            </div>
            <div className="purchase-items">
              {shipment.items.map((item: any) => (
                <div key={item.id}>
                  <span>
                    <strong>{item.salesOrderItem.product.name}</strong>
                    <small>{item.salesOrderItem.product.sku}</small>
                  </span>
                  <b>
                    {numberValue(item.pickedQuantity)} /{" "}
                    {numberValue(item.quantity)} separado
                  </b>
                </div>
              ))}
              {shipment.events.slice(0, 3).map((event: any) => (
                <div key={event.id}>
                  <span>
                    <strong>{shipmentEventLabel(event.type)}</strong>
                    <small>{event.description}</small>
                  </span>
                  <b>{dateTime(event.createdAt)}</b>
                </div>
              ))}
            </div>
            <footer>
              <small>
                Prazo{" "}
                {shipment.deadlineAt
                  ? shortDate(shipment.deadlineAt)
                  : "não informado"}{" "}
                · frete {money.format(shipment.freight)}
              </small>
              <div>
                {shipment.status === "picking" &&
                  shipment.items.some(
                    (item: any) => item.pickedQuantity < item.quantity,
                  ) && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        command({ action: "pick", shipmentId: shipment.id })
                      }
                    >
                      Separar tudo
                    </button>
                  )}
                {shipment.status === "picking" &&
                  shipment.items.every(
                    (item: any) => item.pickedQuantity >= item.quantity,
                  ) && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        command({ action: "pack", shipmentId: shipment.id })
                      }
                    >
                      Embalar
                    </button>
                  )}
                {shipment.status === "packed" && (
                  <button
                    className="primary"
                    onClick={() => setModal({ type: "dispatch", shipment })}
                  >
                    Despachar
                  </button>
                )}
                {shipment.status === "dispatched" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      command({ action: "deliver", shipmentId: shipment.id })
                    }
                  >
                    Confirmar entrega
                  </button>
                )}
                {shipment.status !== "delivered" && (
                  <button
                    onClick={() => setModal({ type: "incident", shipment })}
                  >
                    Ocorrência
                  </button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      {modal && (
        <LogisticsModal
          mode={modal.type}
          shipment={modal.shipment}
          data={data}
          busy={busy}
          close={() => setModal(null)}
          submit={async (payload) => {
            if (
              await command({
                action: modal.type,
                shipmentId: modal.shipment?.id,
                ...payload,
              })
            )
              setModal(null);
          }}
        />
      )}
    </div>
  );
}

function LogisticsModal({
  mode,
  shipment,
  data,
  busy,
  close,
  submit,
}: {
  mode: "create" | "dispatch" | "incident";
  shipment?: any;
  data: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>FLUXO LOGÍSTICO</small>
            <h2>
              {mode === "create"
                ? "Abrir expedição"
                : mode === "dispatch"
                  ? `Despachar ${shipment.number}`
                  : `Ocorrência em ${shipment.number}`}
            </h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        {mode === "create" && (
          <>
            <label className="wide">
              Pedido aprovado
              <select name="salesOrderId" required>
                <option value="">Selecione</option>
                {data.availableOrders.map((item: any) => (
                  <option value={item.id} key={item.id}>
                    {item.number} · {item.customerName} ·{" "}
                    {money.format(item.total)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Depósito
              <select name="warehouseId" required>
                <option value="">Selecione</option>
                {data.warehouses.map((item: any) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Prazo
              <input name="deadlineAt" type="date" />
            </label>
            <label>
              Transportadora
              <input name="carrier" />
            </label>
            <label>
              Serviço
              <input name="service" />
            </label>
            <label>
              Frete
              <input
                name="freight"
                type="number"
                min="0"
                step=".01"
                defaultValue="0"
              />
            </label>
          </>
        )}
        {mode === "dispatch" && (
          <>
            <label>
              Transportadora
              <input
                name="carrier"
                defaultValue={shipment.carrier || ""}
                required
              />
            </label>
            <label>
              Serviço
              <input name="service" defaultValue={shipment.service || ""} />
            </label>
            <label className="wide">
              Código de rastreio
              <input name="trackingCode" required />
            </label>
          </>
        )}
        {mode === "incident" && (
          <label className="wide">
            Descrição
            <textarea
              name="description"
              minLength={2}
              maxLength={500}
              required
            />
          </label>
        )}
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Processando…" : "Confirmar"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function marketplaceProvider(value: string) {
  return (
    (
      {
        mercado_livre: "MERCADO LIVRE",
        shopee: "SHOPEE",
        woocommerce: "WOOCOMMERCE",
        other: "OUTRO CANAL",
      } as Record<string, string>
    )[value] || value
  );
}
function marketplaceOrderStatus(value: string) {
  return (
    (
      {
        imported: "Importado",
        shipped: "Despachado",
        delivered: "Entregue",
      } as Record<string, string>
    )[value] || value
  );
}
function shipmentStatus(value: string) {
  return (
    (
      {
        picking: "Separação",
        packed: "Embalado",
        dispatched: "Em transporte",
        delivered: "Entregue",
      } as Record<string, string>
    )[value] || value
  );
}
function shipmentEventLabel(value: string) {
  return (
    (
      {
        created: "Expedição criada",
        picked: "Separação",
        packed: "Embalagem",
        dispatched: "Despacho",
        delivered: "Entrega",
        incident: "Ocorrência",
      } as Record<string, string>
    )[value] || value
  );
}

function Production({ cacheNamespace }: { cacheNamespace: string }) {
  return <ProductionWorkspace cacheNamespace={cacheNamespace} />;
}

function Contracts({ cacheNamespace }: { cacheNamespace: string }) {
  const endpoint = "/api/erp/contracts";
  const [data, setData] = useState<any>(() =>
      cachedViewData(cacheNamespace, endpoint),
    ),
    [open, setOpen] = useState(false),
    [adjusting, setAdjusting] = useState<any>(),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const r = await fetch(endpoint, { cache: "no-store" }),
      b = await r.json();
    if (r.ok) {
      cacheViewData(cacheNamespace, endpoint, b);
      setData(b);
    } else setError(b.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function cmd(p: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const r = await fetch("/api/erp/contracts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
      }),
      b = await r.json();
    setBusy(false);
    if (!r.ok) {
      setError(b.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">{error || "Carregando contratos…"}</div>
    );
  const term = search.trim().toLocaleLowerCase("pt-BR"),
    visibleItems = data.items.filter(
      (contract: any) =>
        (!status || contract.status === status) &&
        (!term ||
          `${contract.number} ${contract.name} ${contract.customer.name} ${contract.customer.tradeName || ""}`
            .toLocaleLowerCase("pt-BR")
            .includes(term)),
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Contratos ativos"
          value={String(data.summary.active)}
          detail="Recorrências vigentes"
        />
        <Kpi
          label="MRR contratado"
          value={money.format(data.summary.mrr)}
          detail="Receita mensal"
        />
        <Kpi
          label="Ciclos a gerar"
          value={String(data.summary.due)}
          detail="Até a data atual"
          alert={data.summary.due > 0}
        />
        <Kpi
          label="Cobranças geradas"
          value={String(data.summary.cycles)}
          detail="Títulos financeiros"
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Contratos e recorrência</strong>
          <small>
            Vigência, SLA, reajustes e ciclos financeiros idempotentes
          </small>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          + Novo contrato
        </button>
      </div>
      <SuiteListFilter
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        placeholder="Buscar contrato ou cliente"
        options={[
          ["draft", "Rascunhos"],
          ["active", "Ativos"],
          ["paused", "Pausados"],
          ["cancelled", "Cancelados"],
        ]}
      />
      <section className="purchase-list">
        {visibleItems.map((c: any) => (
          <article className="purchase-card" key={c.id}>
            <header>
              <div>
                <span>{c.number}</span>
                <h2>
                  {c.name} · {c.customer.tradeName || c.customer.name}
                </h2>
              </div>
              <em className={`purchase-status ${c.status}`}>
                {contractStatus(c.status)}
              </em>
            </header>
            <div className="purchase-meta">
              <span>
                <small>Mensalidade</small>
                <strong>{money.format(c.amount)}</strong>
              </span>
              <span>
                <small>Próxima cobrança</small>
                <strong>{shortDate(c.nextBillingAt)}</strong>
              </span>
              <span>
                <small>SLA</small>
                <strong>{c.slaHours ? `${c.slaHours} horas` : "—"}</strong>
              </span>
              <span>
                <small>Ciclos</small>
                <strong>{c.cycles.length}</strong>
              </span>
            </div>
            <footer>
              <small>
                {c.adjustmentIndex || "Sem índice"} · {c.adjustments.length}{" "}
                reajuste(s)
              </small>
              <div>
                {c.status === "draft" && (
                  <button
                    className="primary"
                    onClick={() =>
                      cmd({
                        action: "status",
                        contractId: c.id,
                        status: "active",
                      })
                    }
                  >
                    Ativar
                  </button>
                )}
                {c.status === "active" && (
                  <>
                    <button
                      className="primary"
                      onClick={() => cmd({ action: "cycle", contractId: c.id })}
                    >
                      Gerar cobrança
                    </button>
                    <button
                      onClick={() =>
                        cmd({
                          action: "status",
                          contractId: c.id,
                          status: "paused",
                        })
                      }
                    >
                      Pausar
                    </button>
                  </>
                )}
                {c.status === "paused" && (
                  <button
                    onClick={() =>
                      cmd({
                        action: "status",
                        contractId: c.id,
                        status: "active",
                      })
                    }
                  >
                    Retomar
                  </button>
                )}
                {c.status !== "cancelled" && (
                  <>
                    <button disabled={busy} onClick={() => setAdjusting(c)}>
                      Reajustar
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        cmd({
                          action: "status",
                          contractId: c.id,
                          status: "cancelled",
                        })
                      }
                    >
                      Cancelar
                    </button>
                  </>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      {!visibleItems.length && (
        <section className="tenant-panel">
          <Empty
            text={
              data.items.length
                ? "Nenhum contrato corresponde aos filtros."
                : "Nenhum contrato cadastrado."
            }
          />
        </section>
      )}
      {open && (
        <ContractModal
          data={data}
          busy={busy}
          close={() => setOpen(false)}
          submit={async (p) => {
            if (await cmd({ action: "create", ...p })) setOpen(false);
          }}
        />
      )}
      {adjusting && (
        <ContractAdjustmentModal
          contract={adjusting}
          busy={busy}
          close={() => setAdjusting(undefined)}
          submit={async (payload) => {
            if (
              await cmd({
                action: "adjust",
                contractId: adjusting.id,
                ...payload,
              })
            )
              setAdjusting(undefined);
          }}
        />
      )}
    </div>
  );
}

function ContractAdjustmentModal({
  contract,
  busy,
  close,
  submit,
}: {
  contract: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>{contract.number}</small>
            <h2>Registrar reajuste</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label>
          Valor atual
          <input value={money.format(contract.amount)} disabled />
        </label>
        <label>
          Percentual
          <input
            name="percentage"
            type="number"
            min="-99"
            max="1000"
            step=".0001"
            required
          />
        </label>
        <label>
          Vigência
          <input name="effectiveAt" type="date" required />
        </label>
        <label className="wide">
          Motivo e índice aplicado
          <textarea name="reason" minLength={3} maxLength={500} required />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Reajustando…" : "Aplicar reajuste"}
          </button>
        </footer>
      </form>
    </div>
  );
}
function ContractModal({
  data,
  busy,
  close,
  submit,
}: {
  data: any;
  busy: boolean;
  close: () => void;
  submit: (p: Record<string, unknown>) => Promise<void>;
}) {
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <h2>Novo contrato</h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Nome
          <input name="name" required />
        </label>
        <label>
          Cliente
          <select name="customerId" required>
            <option value="">Selecione</option>
            {data.customers.map((x: any) => (
              <option value={x.id} key={x.id}>
                {x.tradeName || x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mensalidade
          <input name="amount" type="number" min=".01" step=".01" required />
        </label>
        <label>
          Início
          <input name="startDate" type="date" required />
        </label>
        <label>
          Fim
          <input name="endDate" type="date" />
        </label>
        <label>
          Próxima cobrança
          <input name="nextBillingAt" type="date" required />
        </label>
        <label>
          Dia de vencimento
          <input
            name="billingDay"
            type="number"
            min="1"
            max="28"
            defaultValue="10"
          />
        </label>
        <label>
          Índice de reajuste
          <input name="adjustmentIndex" placeholder="IPCA, IGP-M…" />
        </label>
        <label>
          SLA em horas
          <input name="slaHours" type="number" min="1" />
        </label>
        <label className="wide">
          Observações
          <textarea name="notes" />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Salvar contrato
          </button>
        </footer>
      </form>
    </div>
  );
}
function contractStatus(v: string) {
  return (
    (
      {
        draft: "Rascunho",
        active: "Ativo",
        paused: "Pausado",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[v] || v
  );
}

function Crm({ cacheNamespace }: { cacheNamespace: string }) {
  const endpoint = "/api/erp/crm";
  const [data, setData] = useState<any>(() =>
      cachedViewData(cacheNamespace, endpoint),
    ),
    [open, setOpen] = useState(false),
    [activityFor, setActivityFor] = useState<any>(),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const r = await fetch(endpoint, { cache: "no-store" }),
      b = await r.json();
    if (r.ok) {
      cacheViewData(cacheNamespace, endpoint, b);
      setData(b);
    } else setError(b.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function cmd(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const r = await fetch("/api/erp/crm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      b = await r.json();
    setBusy(false);
    if (!r.ok) {
      setError(b.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return <div className="tenant-loading">{error || "Carregando CRM…"}</div>;
  const columns = ["lead", "qualified", "proposal", "negotiation"],
    term = search.trim().toLocaleLowerCase("pt-BR"),
    visibleItems = data.items.filter(
      (item: any) =>
        (!status || item.status === status) &&
        (!term ||
          `${item.title} ${item.company || ""} ${item.contactName} ${item.owner}`
            .toLocaleLowerCase("pt-BR")
            .includes(term)),
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Oportunidades abertas"
          value={String(data.summary.open)}
          detail="Funil ativo"
        />
        <Kpi
          label="Pipeline"
          value={money.format(data.summary.pipeline)}
          detail="Valor potencial"
        />
        <Kpi
          label="Previsão ponderada"
          value={money.format(data.summary.weighted)}
          detail="Valor × probabilidade"
        />
        <Kpi
          label="Atividades atrasadas"
          value={String(data.summary.overdue)}
          detail="Exigem ação"
          alert={data.summary.overdue > 0}
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Pipeline comercial</strong>
          <small>Leads, tarefas, propostas e histórico de etapas</small>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          + Nova oportunidade
        </button>
      </div>
      <SuiteListFilter
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        placeholder="Buscar oportunidade, empresa ou responsável"
        options={[
          ["open", "Abertas"],
          ["won", "Ganhas"],
          ["lost", "Perdidas"],
        ]}
      />
      <section className="crm-board">
        {columns.map((stage) => (
          <div className="crm-column" key={stage}>
            <header>
              <strong>{crmStageLabel(stage)}</strong>
              <span>
                {
                  visibleItems.filter(
                    (x: any) => x.stage === stage && x.status === "open",
                  ).length
                }
              </span>
            </header>
            {visibleItems
              .filter((x: any) => x.stage === stage && x.status === "open")
              .map((item: any) => (
                <article key={item.id}>
                  <small>{item.company || item.contactName}</small>
                  <h3>{item.title}</h3>
                  <b>{money.format(item.value)}</b>
                  <p>
                    {item.probability}% · {item.owner}
                  </p>
                  <div>
                    <button onClick={() => setActivityFor(item)}>
                      + Atividade
                    </button>
                    {stage !== "lead" && (
                      <button
                        onClick={() =>
                          cmd({
                            action: "move",
                            opportunityId: item.id,
                            stage: columns[columns.indexOf(stage) - 1],
                          })
                        }
                      >
                        ←
                      </button>
                    )}
                    {stage !== "negotiation" && (
                      <button
                        onClick={() =>
                          cmd({
                            action: "move",
                            opportunityId: item.id,
                            stage: columns[columns.indexOf(stage) + 1],
                          })
                        }
                      >
                        →
                      </button>
                    )}
                    <button
                      className="win"
                      onClick={() =>
                        cmd({
                          action: "move",
                          opportunityId: item.id,
                          stage: "won",
                        })
                      }
                    >
                      Ganhar
                    </button>
                    <button
                      onClick={() =>
                        cmd({
                          action: "move",
                          opportunityId: item.id,
                          stage: "lost",
                          lostReason: "Encerrada pelo operador",
                        })
                      }
                    >
                      Perder
                    </button>
                  </div>
                </article>
              ))}
          </div>
        ))}
      </section>
      <section className="tenant-panel tenant-table">
        <header>
          <h2>Resultados do funil</h2>
          <span>
            {money.format(data.summary.wonValue)} ganhos · {data.summary.lost}{" "}
            perdidos
          </span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Oportunidade</th>
                <th>Empresa</th>
                <th>Resultado</th>
                <th>Valor</th>
                <th>Responsável</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems
                .filter((item: any) => item.status !== "open")
                .map((item: any) => (
                  <tr key={item.id}>
                    <td>{item.title}</td>
                    <td>{item.company || item.contactName}</td>
                    <td>
                      {item.status === "won"
                        ? "Ganha"
                        : `Perdida${item.lostReason ? ` · ${item.lostReason}` : ""}`}
                    </td>
                    <td>{money.format(item.value)}</td>
                    <td>{item.owner}</td>
                  </tr>
                ))}
              {!visibleItems.some((item: any) => item.status !== "open") && (
                <tr>
                  <td colSpan={5}>
                    Nenhuma oportunidade encerrada nesta visão.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="tenant-panel tenant-table">
        <header>
          <h2>Atividades recentes</h2>
          <span>
            {visibleItems.reduce(
              (n: number, x: any) => n + x.activities.length,
              0,
            )}
          </span>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Oportunidade</th>
                <th>Atividade</th>
                <th>Prazo</th>
                <th>Responsável</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.flatMap((o: any) =>
                o.activities.map((a: any) => (
                  <tr key={a.id}>
                    <td>{o.title}</td>
                    <td>{a.subject}</td>
                    <td>{a.dueAt ? dateTime(a.dueAt) : "—"}</td>
                    <td>{a.createdBy}</td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          cmd({
                            action: "activity.complete",
                            opportunityId: o.id,
                            activityId: a.id,
                          })
                        }
                      >
                        {a.completedAt ? "Reabrir" : "Concluir"}
                      </button>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </section>
      {open && (
        <CrmModal
          data={data}
          busy={busy}
          close={() => setOpen(false)}
          submit={async (p) => {
            if (await cmd({ action: "create", ...p })) setOpen(false);
          }}
        />
      )}
      {activityFor && (
        <CrmActivityModal
          opportunity={activityFor}
          busy={busy}
          close={() => setActivityFor(undefined)}
          submit={async (payload) => {
            if (
              await cmd({
                action: "activity",
                opportunityId: activityFor.id,
                ...payload,
              })
            )
              setActivityFor(undefined);
          }}
        />
      )}
    </div>
  );
}

function CrmActivityModal({
  opportunity,
  busy,
  close,
  submit,
}: {
  opportunity: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>{opportunity.company || opportunity.contactName}</small>
            <h2>Nova atividade</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label>
          Tipo
          <select name="type" defaultValue="task">
            <option value="task">Tarefa</option>
            <option value="call">Ligação</option>
            <option value="email">E-mail</option>
            <option value="meeting">Reunião</option>
            <option value="note">Nota</option>
          </select>
        </label>
        <label>
          Prazo
          <input name="dueAt" type="datetime-local" />
        </label>
        <label className="wide">
          Assunto
          <input name="subject" minLength={2} maxLength={180} required />
        </label>
        <label className="wide">
          Notas
          <textarea name="notes" maxLength={2000} />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Agendar atividade"}
          </button>
        </footer>
      </form>
    </div>
  );
}
function CrmModal({
  data,
  busy,
  close,
  submit,
}: {
  data: any;
  busy: boolean;
  close: () => void;
  submit: (p: Record<string, unknown>) => Promise<void>;
}) {
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <h2>Nova oportunidade</h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label className="wide">
          Título
          <input name="title" required />
        </label>
        <label>
          Empresa
          <input name="company" />
        </label>
        <label>
          Contato
          <input name="contactName" required />
        </label>
        <label>
          E-mail
          <input name="email" type="email" />
        </label>
        <label>
          Telefone
          <input name="phone" />
        </label>
        <label>
          Cliente existente
          <select name="customerId">
            <option value="">Ainda não é cliente</option>
            {data.customers.map((x: any) => (
              <option value={x.id} key={x.id}>
                {x.tradeName || x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Origem
          <input name="source" placeholder="Indicação, site, campanha…" />
        </label>
        <label>
          Valor potencial
          <input name="value" type="number" min="0" step=".01" />
        </label>
        <label>
          Probabilidade
          <input
            name="probability"
            type="number"
            min="0"
            max="100"
            defaultValue="10"
          />
        </label>
        <label>
          Previsão
          <input name="expectedAt" type="date" />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Salvar oportunidade
          </button>
        </footer>
      </form>
    </div>
  );
}
function crmStageLabel(v: string) {
  return (
    (
      {
        lead: "Leads",
        qualified: "Qualificadas",
        proposal: "Propostas",
        negotiation: "Negociação",
      } as Record<string, string>
    )[v] || v
  );
}

function ServiceOrders({ cacheNamespace }: { cacheNamespace: string }) {
  const endpoint = "/api/erp/service-orders";
  const [data, setData] = useState<ServiceCatalog | undefined>(() =>
      cachedViewData<ServiceCatalog>(cacheNamespace, endpoint),
    ),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<any>(),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const r = await fetch(endpoint, { cache: "no-store" }),
      b = await r.json();
    if (r.ok) {
      cacheViewData(cacheNamespace, endpoint, b);
      setData(b);
    } else setError(b.error);
  }
  useEffect(() => {
    load();
  }, []);
  async function cmd(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const r = await fetch("/api/erp/service-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      b = await r.json();
    setBusy(false);
    if (!r.ok) {
      setError(b.error);
      return false;
    }
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">
        {error || "Carregando ordens de serviço…"}
      </div>
    );
  const term = search.trim().toLocaleLowerCase("pt-BR"),
    visibleItems = data.items.filter(
      (order) =>
        (!status || order.status === status) &&
        (!term ||
          `${order.number} ${order.customerName} ${order.asset} ${order.assetIdentifier || ""} ${order.technician || ""}`
            .toLocaleLowerCase("pt-BR")
            .includes(term)),
    );
  return (
    <div>
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Ordens"
          value={String(data.summary.total)}
          detail="Banco do tenant"
        />
        <Kpi
          label="Abertas"
          value={String(data.summary.open)}
          detail="Aguardando início"
        />
        <Kpi
          label="Em execução"
          value={String(data.summary.inProgress)}
          detail="Serviços ativos"
        />
        <Kpi
          label="Concluídas"
          value={String(data.summary.completed)}
          detail="Venda e financeiro gerados"
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Oficina e atendimento técnico</strong>
          <small>
            Checklist, peças, serviços, garantia e conversão financeira
          </small>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          + Nova OS
        </button>
      </div>
      <SuiteListFilter
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        placeholder="Buscar OS, cliente, bem ou técnico"
        options={[
          ["open", "Abertas"],
          ["in_progress", "Em execução"],
          ["completed", "Concluídas"],
          ["cancelled", "Canceladas"],
        ]}
      />
      <section className="purchase-list">
        {visibleItems.map((os) => (
          <article className="purchase-card" key={os.id}>
            <header>
              <div>
                <span>ORDEM DE SERVIÇO</span>
                <h2>
                  {os.number} · {os.customerName}
                </h2>
              </div>
              <em className={`purchase-status ${os.status}`}>
                {serviceStatus(os.status)}
              </em>
            </header>
            <div className="purchase-meta">
              <span>
                <small>Bem/veículo</small>
                <strong>{os.asset}</strong>
              </span>
              <span>
                <small>Identificação</small>
                <strong>{os.assetIdentifier || "—"}</strong>
              </span>
              <span>
                <small>Técnico</small>
                <strong>{os.technician || "Não definido"}</strong>
              </span>
              <span>
                <small>Total</small>
                <strong>{money.format(os.total)}</strong>
              </span>
            </div>
            <div className="purchase-items">
              {os.items.map((x: any) => (
                <div key={x.id}>
                  <span>
                    <strong>{x.product.name}</strong>
                    <small>
                      {x.product.type === "service" ? "Serviço" : "Peça"} ·{" "}
                      {x.product.sku}
                    </small>
                  </span>
                  <b>
                    {numberValue(x.quantity)} × {money.format(x.unitPrice)}
                  </b>
                </div>
              ))}
            </div>
            <section className="service-checklist">
              {os.checklist.map((x: any) => (
                <button
                  disabled={
                    busy || !["open", "in_progress"].includes(os.status)
                  }
                  className={x.completed ? "done" : ""}
                  onClick={() =>
                    cmd({ action: "checklist", orderId: os.id, itemId: x.id })
                  }
                  key={x.id}
                >
                  {x.completed ? "✓" : "○"} {x.label}
                </button>
              ))}
            </section>
            <footer>
              <small>
                <b>Relato:</b> {os.complaint}
                {os.diagnosis ? (
                  <>
                    {" "}
                    · <b>Diagnóstico:</b> {os.diagnosis}
                  </>
                ) : null}
                {os.scheduledAt ? (
                  <>
                    {" "}
                    · <b>Agendado:</b> {dateTime(os.scheduledAt)}
                  </>
                ) : null}
              </small>
              <div>
                {["open", "in_progress"].includes(os.status) && (
                  <button disabled={busy} onClick={() => setEditing(os)}>
                    Atualizar atendimento
                  </button>
                )}
                {os.status === "open" && (
                  <button
                    className="primary"
                    onClick={() => cmd({ action: "start", orderId: os.id })}
                  >
                    Iniciar
                  </button>
                )}
                {os.status === "in_progress" && (
                  <button
                    className="primary"
                    onClick={() => cmd({ action: "complete", orderId: os.id })}
                  >
                    Concluir e faturar
                  </button>
                )}
                {["open", "in_progress"].includes(os.status) && (
                  <button
                    onClick={() => cmd({ action: "cancel", orderId: os.id })}
                  >
                    Cancelar
                  </button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      {!visibleItems.length && (
        <section className="tenant-panel">
          <Empty
            text={
              data.items.length
                ? "Nenhuma OS corresponde aos filtros."
                : "Nenhuma ordem de serviço cadastrada."
            }
          />
        </section>
      )}
      {open && (
        <ServiceOrderModal
          catalog={data}
          busy={busy}
          close={() => setOpen(false)}
          submit={async (p) => {
            if (await cmd({ action: "create", ...p })) setOpen(false);
          }}
        />
      )}
      {editing && (
        <ServiceOrderDetailsModal
          order={editing}
          busy={busy}
          close={() => setEditing(undefined)}
          submit={async (payload) => {
            if (
              await cmd({
                action: "details.update",
                orderId: editing.id,
                ...payload,
              })
            )
              setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

function ServiceOrderDetailsModal({
  order,
  busy,
  close,
  submit,
}: {
  order: any;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  const scheduledAt = order.scheduledAt
    ? new Date(order.scheduledAt).toISOString().slice(0, 16)
    : "";
  return (
    <div className="tenant-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <div>
            <small>
              {order.number} · {order.asset}
            </small>
            <h2>Atualizar atendimento</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label>
          Técnico responsável
          <input
            name="technician"
            maxLength={160}
            defaultValue={order.technician || ""}
          />
        </label>
        <label>
          Agendamento
          <input
            name="scheduledAt"
            type="datetime-local"
            defaultValue={scheduledAt}
          />
        </label>
        <label className="wide">
          Diagnóstico técnico
          <textarea
            name="diagnosis"
            maxLength={2000}
            defaultValue={order.diagnosis || ""}
            placeholder="Causa identificada, testes executados e recomendação…"
          />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Atualizando…" : "Salvar atendimento"}
          </button>
        </footer>
      </form>
    </div>
  );
}
function ServiceOrderModal({
  catalog,
  busy,
  close,
  submit,
}: {
  catalog: ServiceCatalog;
  busy: boolean;
  close: () => void;
  submit: (p: Record<string, unknown>) => Promise<void>;
}) {
  const [rows, setRows] = useState([
    { productId: "", quantity: "1", unitPrice: "0" },
  ]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await submit({
      ...Object.fromEntries(new FormData(e.currentTarget)),
      items: rows.map((x) => ({
        productId: Number(x.productId),
        quantity: Number(x.quantity),
        unitPrice: Number(x.unitPrice),
      })),
      checklist: [
        "Conferir identificação do bem",
        "Validar serviço com o cliente",
      ],
    });
  }
  return (
    <div className="tenant-modal purchase-modal">
      <button className="modal-close-area" onClick={close} />
      <form onSubmit={save}>
        <header>
          <h2>Nova ordem de serviço</h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <label>
          Cliente
          <select name="customerId" required>
            <option value="">Selecione</option>
            {catalog.customers.map((x) => (
              <option value={x.id} key={x.id}>
                {x.tradeName || x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bem ou veículo
          <input name="asset" required />
        </label>
        <label>
          Placa / série
          <input name="assetIdentifier" />
        </label>
        <label>
          Quilometragem
          <input name="mileage" type="number" min="0" />
        </label>
        <label>
          Técnico responsável
          <input name="technician" />
        </label>
        <label>
          Agendamento
          <input name="scheduledAt" type="datetime-local" />
        </label>
        <label className="wide">
          Relato do cliente
          <textarea name="complaint" required />
        </label>
        <section className="purchase-lines wide">
          <header>
            <strong>Peças e serviços</strong>
            <button
              type="button"
              onClick={() =>
                setRows((x) => [
                  ...x,
                  { productId: "", quantity: "1", unitPrice: "0" },
                ])
              }
            >
              + Item
            </button>
          </header>
          {rows.map((row, i) => (
            <div key={i}>
              <select
                value={row.productId}
                onChange={(e) => {
                  const p = catalog.products.find(
                    (x) => x.id === Number(e.target.value),
                  );
                  setRows((a) =>
                    a.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            productId: e.target.value,
                            unitPrice: String(p?.price || 0),
                          }
                        : x,
                    ),
                  );
                }}
                required
              >
                <option value="">Selecione</option>
                {catalog.products.map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <input
                value={row.quantity}
                type="number"
                min=".0001"
                step=".0001"
                onChange={(e) =>
                  setRows((a) =>
                    a.map((x, j) =>
                      j === i ? { ...x, quantity: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                value={row.unitPrice}
                type="number"
                min="0"
                step=".01"
                onChange={(e) =>
                  setRows((a) =>
                    a.map((x, j) =>
                      j === i ? { ...x, unitPrice: e.target.value } : x,
                    ),
                  )
                }
              />
              <button
                type="button"
                disabled={rows.length === 1}
                onClick={() => setRows((a) => a.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </section>
        <label>
          Desconto
          <input
            name="discount"
            type="number"
            min="0"
            step=".01"
            defaultValue="0"
          />
        </label>
        <label>
          Garantia (dias)
          <input name="warrantyDays" type="number" min="0" defaultValue="90" />
        </label>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Salvar OS
          </button>
        </footer>
      </form>
    </div>
  );
}

function Orders() {
  const [data, setData] = useState<OrderCatalog>(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setError("");
    const response = await fetch("/api/erp/orders", { cache: "no-store" }),
      body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error || "Não foi possível carregar os pedidos.");
  }
  useEffect(() => {
    load();
  }, []);
  async function command(payload: Record<string, unknown>, success: string) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/erp/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível concluir a operação.");
      return false;
    }
    setNotice(success);
    window.setTimeout(() => setNotice(""), 2500);
    await load();
    return true;
  }
  if (!data)
    return (
      <div className="tenant-loading">
        {error || "Carregando orçamentos e pedidos…"}
      </div>
    );
  return (
    <div className="erp-orders">
      {notice && <div className="tenant-notice">{notice}</div>}
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Orçamentos e pedidos"
          value={String(data.summary.total)}
          detail="Registros no tenant"
        />
        <Kpi
          label="Rascunhos"
          value={String(data.summary.drafts)}
          detail="Aguardando aprovação"
        />
        <Kpi
          label="Aprovados"
          value={String(data.summary.approved)}
          detail="Prontos para concluir"
        />
        <Kpi
          label="Vendas convertidas"
          value={money.format(data.summary.completed)}
          detail="Pedidos concluídos"
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Pipeline comercial</strong>
          <small>
            A conclusão baixa o depósito da filial ativa e cria venda e
            recebível
          </small>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          + Novo orçamento
        </button>
      </div>
      <section className="purchase-list">
        {data.items.map((order) => (
          <article className="purchase-card order-card" key={order.id}>
            <header>
              <div>
                <span>{order.kind === "quote" ? "ORÇAMENTO" : "PEDIDO"}</span>
                <h2>
                  {order.number} · {order.customerName}
                </h2>
              </div>
              <em className={`purchase-status ${order.status}`}>
                {orderStatus(order.status)}
              </em>
            </header>
            <div className="purchase-meta">
              <span>
                <small>Criado em</small>
                <strong>{dateTime(order.createdAt)}</strong>
              </span>
              <span>
                <small>Validade</small>
                <strong>{shortDate(order.validUntil)}</strong>
              </span>
              <span>
                <small>Itens</small>
                <strong>{order.items.length}</strong>
              </span>
              <span>
                <small>Vendedor</small>
                <strong>{order.salesperson || "Não informado"}</strong>
              </span>
              <span>
                <small>Canal</small>
                <strong>{salesChannelLabel(order.salesChannel)}</strong>
              </span>
              <span>
                <small>Total</small>
                <strong>{money.format(order.total)}</strong>
              </span>
            </div>
            <div className="order-context">
              <span>
                <small>Prioridade</small>
                <strong>{priorityLabel(order.priority)}</strong>
              </span>
              <span>
                <small>Entrega</small>
                <strong>
                  {deliveryTypeLabel(order.deliveryType)}
                  {order.deliveryCity
                    ? ` · ${order.deliveryCity}/${order.deliveryState || ""}`
                    : ""}
                </strong>
              </span>
              <span>
                <small>Pagamento</small>
                <strong>
                  {order.paymentMethod || "A definir"}
                  {order.paymentInstallments > 1
                    ? ` · ${order.paymentInstallments}x`
                    : ""}
                </strong>
              </span>
              <span>
                <small>Frete</small>
                <strong>
                  {order.freightType === "none"
                    ? "Sem frete"
                    : `${order.freightType.toUpperCase()} · ${money.format(order.freightAmount)}`}
                </strong>
              </span>
            </div>
            <div className="purchase-items">
              {order.items.map((item) => (
                <div key={item.id}>
                  <span>
                    <strong>{item.product.name}</strong>
                    <small>
                      {item.product.sku} · saldo{" "}
                      {numberValue(item.product.stock)} {item.product.unit}
                    </small>
                  </span>
                  <span>
                    <small>
                      {numberValue(item.quantity)} ×{" "}
                      {money.format(item.unitPrice)}
                      {item.discount > 0
                        ? ` · desconto ${money.format(item.discount)}`
                        : ""}
                    </small>
                    <b>{money.format(item.total)}</b>
                  </span>
                </div>
              ))}
            </div>
            <footer>
              <small>
                {order.history.length} evento(s) no histórico ·{" "}
                {order.notes || "Sem observações"}
              </small>
              <div>
                {order.status === "draft" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      command(
                        { action: "approve", orderId: order.id },
                        "Pedido aprovado.",
                      )
                    }
                  >
                    Aprovar pedido
                  </button>
                )}
                {order.status === "approved" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      command(
                        { action: "complete", orderId: order.id },
                        "Pedido concluído, estoque baixado e recebível criado.",
                      )
                    }
                  >
                    Concluir venda
                  </button>
                )}
                {new Set(["draft", "approved"]).has(order.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      command(
                        { action: "cancel", orderId: order.id },
                        "Registro cancelado.",
                      )
                    }
                  >
                    Cancelar
                  </button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      {!data.items.length && (
        <section className="tenant-panel">
          <Empty text="Nenhum orçamento ou pedido cadastrado." />
        </section>
      )}
      {open && (
        <OrderModal
          catalog={data}
          busy={busy}
          close={() => setOpen(false)}
          submit={async (payload) => {
            if (
              await command(
                { action: "create", ...payload },
                "Orçamento criado e auditado.",
              )
            )
              setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function OrderModal({
  catalog,
  busy,
  close,
  submit,
}: {
  catalog: OrderCatalog;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  type OrderRow = {
    productId: string;
    quantity: string;
    listPrice: number;
    unitPrice: string;
    description: string;
    notes: string;
  };
  const emptyRow = (): OrderRow => ({
    productId: "",
    quantity: "1",
    listPrice: 0,
    unitPrice: "0",
    description: "",
    notes: "",
  });
  const [rows, setRows] = useState<OrderRow[]>([emptyRow()]),
    [section, setSection] = useState("geral"),
    [kind, setKind] = useState("quote"),
    [customerId, setCustomerId] = useState(""),
    [customerEmail, setCustomerEmail] = useState(""),
    [customerPhone, setCustomerPhone] = useState(""),
    [contactName, setContactName] = useState(""),
    [discountType, setDiscountType] = useState("value"),
    [discountValue, setDiscountValue] = useState("0"),
    [freightAmount, setFreightAmount] = useState("0"),
    [deliveryType, setDeliveryType] = useState("pickup"),
    [delivery, setDelivery] = useState({
      zip: "",
      street: "",
      number: "",
      complement: "",
      district: "",
      city: "",
      state: "",
    }),
    [formError, setFormError] = useState(""),
    [defaultValidity] = useState(() =>
      new Date(Date.now() + catalog.settings.quoteValidityDays * 86400000)
        .toISOString()
        .slice(0, 10),
    );
  function choose(index: number, productId: string) {
    const product = catalog.products.find(
      (item) => item.id === Number(productId),
    );
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              productId,
              listPrice: product?.price || 0,
              unitPrice: String(product?.price || 0),
              description: product?.name || "",
            }
          : row,
      ),
    );
  }
  function chooseCustomer(value: string) {
    setCustomerId(value);
    const customer = catalog.customers.find(
        (item) => item.id === Number(value),
      ),
      address = customer?.addresses[0];
    setCustomerEmail(customer?.email || "");
    setCustomerPhone(customer?.phone || "");
    setContactName(customer ? customer.tradeName || customer.name : "");
    setDelivery({
      zip: address?.zip || "",
      street: address?.street || "",
      number: address?.number || "",
      complement: address?.complement || "",
      district: address?.district || "",
      city: address?.city || "",
      state: address?.state || "",
    });
  }
  function updateRow(index: number, values: Partial<OrderRow>) {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...values } : row,
      ),
    );
  }
  const itemSubtotal = rows.reduce(
      (sum, row) =>
        sum + (Number(row.quantity) || 0) * (Number(row.unitPrice) || 0),
      0,
    ),
    listSubtotal = rows.reduce(
      (sum, row) => sum + (Number(row.quantity) || 0) * row.listPrice,
      0,
    ),
    itemDiscount = Math.max(0, listSubtotal - itemSubtotal),
    generalDiscount =
      discountType === "percent"
        ? (itemSubtotal * (Number(discountValue) || 0)) / 100
        : Number(discountValue) || 0,
    total = Math.max(
      0,
      itemSubtotal - generalDiscount + (Number(freightAmount) || 0),
    ),
    combinedDiscountPercent =
      listSubtotal > 0
        ? ((itemDiscount + generalDiscount) / listSubtotal) * 100
        : 0;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (rows.some((row) => !row.productId || Number(row.quantity) <= 0)) {
      setSection("itens");
      setFormError(
        "Selecione todos os produtos e informe quantidades válidas.",
      );
      return;
    }
    if (generalDiscount > itemSubtotal) {
      setSection("pagamento");
      setFormError("O desconto geral não pode superar o subtotal dos itens.");
      return;
    }
    if (
      combinedDiscountPercent >
      catalog.settings.maxDiscountPercent + 0.0001
    ) {
      setSection("pagamento");
      setFormError(
        `O desconto combinado excede o limite de ${catalog.settings.maxDiscountPercent}%.`,
      );
      return;
    }
    if (
      deliveryType !== "pickup" &&
      (!delivery.street || !delivery.city || !delivery.state)
    ) {
      setSection("entrega");
      setFormError("Informe logradouro, cidade e UF para a entrega.");
      return;
    }
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await submit({
      ...form,
      customerId: customerId || null,
      customerEmail,
      customerPhone,
      contactName,
      discountType,
      discountValue: Number(discountValue) || 0,
      freightAmount: Number(freightAmount) || 0,
      deliveryType,
      deliveryZip: delivery.zip,
      deliveryStreet: delivery.street,
      deliveryNumber: delivery.number,
      deliveryComplement: delivery.complement,
      deliveryDistrict: delivery.district,
      deliveryCity: delivery.city,
      deliveryState: delivery.state,
      items: rows
        .filter((row) => row.productId)
        .map((row) => ({
          productId: Number(row.productId),
          quantity: Number(row.quantity),
          unitPrice: Number(row.unitPrice),
          description: row.description,
          notes: row.notes,
        })),
    });
  }
  return (
    <ErpModal
      className="order-modal"
      close={close}
      label="Novo orçamento ou pedido"
    >
      <form className="order-form" onSubmit={save} noValidate>
        <header>
          <div>
            <small>
              PIPELINE COMERCIAL · {catalog.branch?.code || "FILIAL ATIVA"}
            </small>
            <h2>Novo orçamento ou pedido</h2>
            <p>
              {catalog.branch?.name || "Unidade operacional"} ·{" "}
              {catalog.branch?.defaultWarehouse?.name ||
                "depósito padrão não definido"}
            </p>
          </div>
          <button
            type="button"
            className="order-close"
            onClick={close}
            aria-label="Fechar"
          >
            ×
          </button>
        </header>
        <nav className="order-modal-tabs" aria-label="Etapas do orçamento">
          {[
            ["geral", "1", "Geral"],
            ["itens", "2", "Itens"],
            ["entrega", "3", "Entrega"],
            ["pagamento", "4", "Pagamento"],
            ["observacoes", "5", "Observações"],
          ].map(([id, number, label]) => (
            <button
              type="button"
              className={section === id ? "active" : ""}
              onClick={() => setSection(id)}
              key={id}
            >
              <span>{number}</span>
              {label}
            </button>
          ))}
        </nav>
        {formError && <div className="order-form-error">{formError}</div>}
        <section className="order-modal-section" hidden={section !== "geral"}>
          <div className="order-section-heading">
            <strong>Identificação comercial</strong>
            <small>
              Cliente, responsável, origem e rastreabilidade da negociação.
            </small>
          </div>
          <label>
            Tipo
            <select
              name="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="quote">Orçamento</option>
              <option value="order">Pedido</option>
            </select>
          </label>
          <label>
            Prioridade
            <select name="priority" defaultValue="normal">
              <option value="low">Baixa</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </label>
          <label className="wide">
            Cliente
            <div className="order-inline-field">
              <select
                value={customerId}
                onChange={(event) => chooseCustomer(event.target.value)}
              >
                <option value="">Consumidor final</option>
                {catalog.customers.map((customer) => (
                  <option value={customer.id} key={customer.id}>
                    {customer.tradeName || customer.name} ·{" "}
                    {formatDocument(customer.document)}
                  </option>
                ))}
              </select>
              <Link href={erpRoute("customers")}>Novo cliente</Link>
            </div>
          </label>
          <label>
            Contato
            <input
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
              placeholder="Nome do contato"
            />
          </label>
          <label>
            Vendedor
            <select
              name="salespersonProfileId"
              defaultValue={catalog.currentSalespersonProfileId}
            >
              {catalog.salespeople.map((person) => (
                <option value={person.id} key={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            E-mail
            <input
              type="email"
              value={customerEmail}
              onChange={(event) => setCustomerEmail(event.target.value)}
              placeholder="contato@empresa.com.br"
            />
          </label>
          <label>
            Telefone
            <input
              value={customerPhone}
              onChange={(event) => setCustomerPhone(event.target.value)}
              placeholder="(00) 00000-0000"
            />
          </label>
          <label>
            Canal de venda
            <select name="salesChannel" defaultValue="direct">
              <option value="direct">Venda direta</option>
              <option value="store">Loja / balcão</option>
              <option value="phone">Telefone</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">E-mail</option>
              <option value="field">Venda externa</option>
              <option value="ecommerce">E-commerce</option>
              <option value="marketplace">Marketplace</option>
            </select>
          </label>
          <label>
            Referência externa
            <input
              name="externalReference"
              placeholder="CRM, integração ou campanha"
            />
          </label>
          <label>
            Pedido de compra do cliente
            <input
              name="purchaseOrderNumber"
              placeholder="OC / PO do cliente"
            />
          </label>
          <label>
            Validade
            <input
              name="validUntil"
              type="date"
              defaultValue={defaultValidity}
            />
          </label>
        </section>
        <section
          className="order-modal-section order-items-section"
          hidden={section !== "itens"}
        >
          <div className="order-section-heading order-items-heading">
            <div>
              <strong>Produtos e serviços</strong>
              <small>
                Preço de tabela, valor negociado, desconto e disponibilidade na
                filial.
              </small>
            </div>
            <button
              type="button"
              onClick={() => setRows((current) => [...current, emptyRow()])}
            >
              + Adicionar item
            </button>
          </div>
          <div className="order-lines wide">
            {rows.map((row, index) => {
              const product = catalog.products.find(
                  (item) => item.id === Number(row.productId),
                ),
                lineTotal =
                  (Number(row.quantity) || 0) * (Number(row.unitPrice) || 0),
                lineDiscount = Math.max(
                  0,
                  row.listPrice - (Number(row.unitPrice) || 0),
                );
              return (
                <article key={index}>
                  <header>
                    <span>ITEM {String(index + 1).padStart(2, "0")}</span>
                    <button
                      type="button"
                      disabled={rows.length === 1}
                      onClick={() =>
                        setRows((current) =>
                          current.filter((_, rowIndex) => rowIndex !== index),
                        )
                      }
                    >
                      Remover
                    </button>
                  </header>
                  <div className="order-line-grid">
                    <label className="product-field">
                      Produto ou serviço
                      <select
                        value={row.productId}
                        onChange={(event) => choose(index, event.target.value)}
                      >
                        <option value="">Selecione no catálogo</option>
                        {catalog.products.map((item) => (
                          <option
                            disabled={rows.some(
                              (other, rowIndex) =>
                                rowIndex !== index &&
                                other.productId === String(item.id),
                            )}
                            value={item.id}
                            key={item.id}
                          >
                            {item.name} · {item.sku}
                          </option>
                        ))}
                      </select>
                      {product && (
                        <small
                          className={
                            product.type === "service" || product.stock > 0
                              ? "available"
                              : "unavailable"
                          }
                        >
                          {product.type === "service"
                            ? "Serviço sem estoque"
                            : `${numberValue(product.stock)} ${product.unit} disponível(is)`}
                        </small>
                      )}
                    </label>
                    <label>
                      Quantidade
                      <input
                        type="number"
                        min="0.0001"
                        step="0.0001"
                        value={row.quantity}
                        onChange={(event) =>
                          updateRow(index, { quantity: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Preço de tabela
                      <input value={money.format(row.listPrice)} disabled />
                    </label>
                    <label>
                      Preço negociado
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.unitPrice}
                        onChange={(event) =>
                          updateRow(index, { unitPrice: event.target.value })
                        }
                      />
                    </label>
                    <div className="order-line-value">
                      <small>Desconto unitário</small>
                      <strong>{money.format(lineDiscount)}</strong>
                    </div>
                    <div className="order-line-value total">
                      <small>Total do item</small>
                      <strong>{money.format(lineTotal)}</strong>
                    </div>
                    <label className="wide">
                      Descrição
                      <input
                        value={row.description}
                        onChange={(event) =>
                          updateRow(index, { description: event.target.value })
                        }
                      />
                    </label>
                    <label className="wide">
                      Observação do item
                      <input
                        value={row.notes}
                        onChange={(event) =>
                          updateRow(index, { notes: event.target.value })
                        }
                        placeholder="Prazo, personalização, serial ou instrução específica"
                      />
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        <section className="order-modal-section" hidden={section !== "entrega"}>
          <div className="order-section-heading">
            <strong>Logística e entrega</strong>
            <small>
              Prazo, modalidade, responsabilidade do frete e endereço de
              destino.
            </small>
          </div>
          <label>
            Modalidade
            <select
              value={deliveryType}
              onChange={(event) => setDeliveryType(event.target.value)}
            >
              <option value="pickup">Retirada na filial</option>
              <option value="delivery">Entrega própria</option>
              <option value="carrier">Transportadora</option>
            </select>
          </label>
          <label>
            Previsão de entrega
            <input name="expectedAt" type="date" />
          </label>
          <label>
            Responsabilidade do frete
            <select name="freightType" defaultValue="none">
              <option value="none">Sem frete</option>
              <option value="cif">CIF · remetente paga</option>
              <option value="fob">FOB · destinatário paga</option>
            </select>
          </label>
          <label>
            Valor do frete
            <input
              type="number"
              min="0"
              step="0.01"
              value={freightAmount}
              onChange={(event) => setFreightAmount(event.target.value)}
            />
          </label>
          {deliveryType !== "pickup" && (
            <>
              <label>
                CEP
                <input
                  value={delivery.zip}
                  onChange={(event) =>
                    setDelivery((current) => ({
                      ...current,
                      zip: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                UF
                <input
                  maxLength={2}
                  value={delivery.state}
                  onChange={(event) =>
                    setDelivery((current) => ({
                      ...current,
                      state: event.target.value.toUpperCase(),
                    }))
                  }
                />
              </label>
              <label className="wide">
                Logradouro
                <input
                  value={delivery.street}
                  onChange={(event) =>
                    setDelivery((current) => ({
                      ...current,
                      street: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Número
                <input
                  value={delivery.number}
                  onChange={(event) =>
                    setDelivery((current) => ({
                      ...current,
                      number: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Complemento
                <input
                  value={delivery.complement}
                  onChange={(event) =>
                    setDelivery((current) => ({
                      ...current,
                      complement: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Bairro
                <input
                  value={delivery.district}
                  onChange={(event) =>
                    setDelivery((current) => ({
                      ...current,
                      district: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Cidade
                <input
                  value={delivery.city}
                  onChange={(event) =>
                    setDelivery((current) => ({
                      ...current,
                      city: event.target.value,
                    }))
                  }
                />
              </label>
            </>
          )}
        </section>
        <section
          className="order-modal-section"
          hidden={section !== "pagamento"}
        >
          <div className="order-section-heading">
            <strong>Condições financeiras</strong>
            <small>
              Forma de pagamento, vencimento, desconto geral e composição final.
            </small>
          </div>
          <label>
            Forma de pagamento
            <select
              name="paymentMethod"
              defaultValue={catalog.settings.defaultPaymentMethod}
            >
              <option>Pix</option>
              <option>Boleto</option>
              <option>Cartão de crédito</option>
              <option>Cartão de débito</option>
              <option>Dinheiro</option>
              <option>Transferência bancária</option>
              <option>A definir</option>
            </select>
          </label>
          <label>
            Condição de pagamento
            <input name="paymentTerms" placeholder="Ex.: 30/60/90 dias" />
          </label>
          <label>
            Número de parcelas
            <input
              name="paymentInstallments"
              type="number"
              min="1"
              max="120"
              defaultValue="1"
            />
          </label>
          <label>
            Primeiro vencimento
            <input name="firstDueDate" type="date" />
          </label>
          <label>
            Tipo de desconto
            <select
              value={discountType}
              onChange={(event) => setDiscountType(event.target.value)}
            >
              <option value="value">Valor em reais</option>
              <option value="percent">Percentual</option>
            </select>
          </label>
          <label>
            Desconto geral
            <input
              type="number"
              min="0"
              max={discountType === "percent" ? 100 : undefined}
              step="0.01"
              value={discountValue}
              onChange={(event) => setDiscountValue(event.target.value)}
            />
          </label>
          <div
            className={`order-discount-limit wide ${combinedDiscountPercent > catalog.settings.maxDiscountPercent ? "invalid" : ""}`}
          >
            <span>Desconto combinado</span>
            <strong>{numberValue(combinedDiscountPercent)}%</strong>
            <small>
              Limite autorizado: {catalog.settings.maxDiscountPercent}%
            </small>
          </div>
        </section>
        <section
          className="order-modal-section"
          hidden={section !== "observacoes"}
        >
          <div className="order-section-heading">
            <strong>Observações e condições</strong>
            <small>
              Separe o conteúdo exibido ao cliente das anotações internas da
              equipe.
            </small>
          </div>
          <label className="wide">
            Observações para o cliente
            <textarea
              name="notes"
              placeholder="Informações que poderão aparecer no orçamento ou pedido."
            />
          </label>
          <label className="wide">
            Anotações internas
            <textarea
              name="internalNotes"
              placeholder="Visível apenas para a equipe da organização."
            />
          </label>
          {catalog.settings.termsAndConditions && (
            <div className="order-terms wide">
              <strong>Termos comerciais configurados</strong>
              <p>{catalog.settings.termsAndConditions}</p>
            </div>
          )}
          <label className="order-check wide">
            <input type="checkbox" name="termsAccepted" />
            <span>
              <strong>Condições revisadas com o cliente</strong>
              <small>
                Registra o aceite operacional no histórico do pedido.
              </small>
            </span>
          </label>
        </section>
        <aside className="order-summary">
          <span>
            <small>Tabela</small>
            <strong>{money.format(listSubtotal)}</strong>
          </span>
          <span>
            <small>Desconto nos itens</small>
            <strong>- {money.format(itemDiscount)}</strong>
          </span>
          <span>
            <small>Desconto geral</small>
            <strong>- {money.format(generalDiscount)}</strong>
          </span>
          <span>
            <small>Frete</small>
            <strong>{money.format(Number(freightAmount) || 0)}</strong>
          </span>
          <span className="total">
            <small>Total</small>
            <strong>{money.format(total)}</strong>
          </span>
        </aside>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <div>
            <button
              type="button"
              disabled={section === "geral"}
              onClick={() => {
                const ids = [
                    "geral",
                    "itens",
                    "entrega",
                    "pagamento",
                    "observacoes",
                  ],
                  index = ids.indexOf(section);
                setSection(ids[Math.max(0, index - 1)]);
              }}
            >
              Voltar
            </button>
            {section !== "observacoes" ? (
              <button
                className="primary"
                type="button"
                onClick={() => {
                  const ids = [
                      "geral",
                      "itens",
                      "entrega",
                      "pagamento",
                      "observacoes",
                    ],
                    index = ids.indexOf(section);
                  setSection(ids[Math.min(ids.length - 1, index + 1)]);
                }}
              >
                Continuar
              </button>
            ) : (
              <button className="primary" disabled={busy}>
                {busy
                  ? "Salvando…"
                  : kind === "order"
                    ? "Criar pedido"
                    : "Criar orçamento"}
              </button>
            )}
          </div>
        </footer>
      </form>
    </ErpModal>
  );
}

function TenantSettings() {
  const settingsRouter = useRouter();
  const [data, setData] = useState<TenantSettingsRecord>(),
    [logo, setLogo] = useState<MediaAsset | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setError("");
    const response = await fetch("/api/erp/settings", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) {
      setData(body.settings);
      setLogo(body.settings.logoMedia || null);
    } else
      setError(body.error || "Não foi possível carregar as configurações.");
  }
  useEffect(() => {
    load();
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget),
      payload = {
        ...Object.fromEntries(form),
        requireCustomer: form.has("requireCustomer"),
        lowStockAlerts: form.has("lowStockAlerts"),
        dailySummary: form.has("dailySummary"),
        notifyLowStock: form.has("notifyLowStock"),
        autoGenerateSku: form.has("autoGenerateSku"),
        allowNegativeStock: form.has("allowNegativeStock"),
        notifyOverdueTitles: form.has("notifyOverdueTitles"),
        notifyNewSales: form.has("notifyNewSales"),
        logoMediaId: logo?.id || "",
        version: data.version,
      };
    const response = await fetch("/api/erp/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(
        body.error || "Não foi possível salvar as configurações.",
      );
    setData(body.settings);
    setLogo(body.settings.logoMedia || null);
    settingsRouter.refresh();
    setNotice("Configurações salvas, versionadas e auditadas.");
    window.setTimeout(() => setNotice(""), 2500);
  }
  if (!data)
    return (
      <div className="tenant-loading">
        {error || "Carregando configurações da organização…"}
      </div>
    );
  return (
    <div className="erp-settings">
      {notice && <div className="tenant-notice">{notice}</div>}
      {error && <div className="tenant-error">{error}</div>}
      <section className="settings-summary">
        <article>
          <span>VERSÃO ATIVA</span>
          <strong>{data.version}</strong>
          <small>Concorrência otimista</small>
        </article>
        <article>
          <span>LOCALIZAÇÃO</span>
          <strong>
            {data.locale} · {data.currency}
          </strong>
          <small>{data.timezone}</small>
        </article>
        <article>
          <span>ÚLTIMA ALTERAÇÃO</span>
          <strong>{dateTime(data.updatedAt)}</strong>
          <small>Trilha disponível em Atividades</small>
        </article>
      </section>
      <nav
        className="settings-section-nav"
        aria-label="Seções das configurações"
      >
        {[
          ["settings-identity", "Empresa e aparência"],
          ["settings-sales", "Vendas e estoque"],
          ["settings-notifications", "Notificações"],
          ["settings-documents", "Documentos"],
          ["settings-governance", "Segurança e dados"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            onClick={() =>
              document
                .getElementById(id)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {label}
          </button>
        ))}
      </nav>
      <form className="settings-form" onSubmit={save}>
        <section className="settings-card" id="settings-identity">
          <header>
            <i>01</i>
            <div>
              <h2>Identidade e localização</h2>
              <p>
                Preferências gerais usadas nas telas e operações desta
                organização.
              </p>
            </div>
          </header>
          <div>
            <label>
              Nome da organização
              <input
                name="organizationName"
                defaultValue={data.organizationName}
                required
              />
            </label>
            <label>
              Nome fantasia
              <input name="tradeName" defaultValue={data.tradeName || ""} />
            </label>
            <label>
              Idioma
              <input value="Português (Brasil)" disabled />
            </label>
            <label>
              Moeda
              <input value="Real brasileiro (BRL)" disabled />
            </label>
            <label className="wide">
              Fuso horário
              <select name="timezone" defaultValue={data.timezone}>
                <option value="America/Sao_Paulo">Brasília</option>
                <option value="America/Manaus">Manaus</option>
                <option value="America/Cuiaba">Cuiabá</option>
                <option value="America/Rio_Branco">Rio Branco</option>
                <option value="America/Fortaleza">Fortaleza</option>
                <option value="America/Recife">Recife</option>
                <option value="America/Bahia">Bahia</option>
                <option value="UTC">UTC</option>
              </select>
            </label>
            <label>
              Telefone operacional
              <input
                name="operationalPhone"
                defaultValue={data.operationalPhone || ""}
                placeholder="(49) 3333-0000"
              />
            </label>
            <label>
              Cor principal
              <input
                name="accentColor"
                type="color"
                defaultValue={data.accentColor}
              />
            </label>
            <label>
              Densidade da interface
              <select
                name="interfaceDensity"
                defaultValue={data.interfaceDensity}
              >
                <option value="comfortable">Confortável</option>
                <option value="compact">Compacta</option>
              </select>
            </label>
            <label>
              Menu lateral padrão
              <select
                name="defaultSidebarMode"
                defaultValue={data.defaultSidebarMode}
              >
                <option value="expanded">Expandido</option>
                <option value="compact">Compacto</option>
              </select>
            </label>
            <div className="wide">
              <MediaPicker
                value={logo}
                onChange={setLogo}
                acceptKind="image"
                label="Logotipo da organização"
              />
            </div>
          </div>
        </section>
        <section className="settings-card" id="settings-sales">
          <header>
            <i>02</i>
            <div>
              <h2>PDV e operação comercial</h2>
              <p>
                Estes valores são consumidos pelo backend ao registrar novas
                vendas.
              </p>
            </div>
          </header>
          <div>
            <label>
              Pagamento padrão
              <select
                name="defaultPaymentMethod"
                defaultValue={data.defaultPaymentMethod}
              >
                <option>Pix</option>
                <option>Dinheiro</option>
                <option>Cartão</option>
                <option>Boleto</option>
              </select>
            </label>
            <label>
              Cliente padrão
              <input
                name="defaultCustomerName"
                defaultValue={data.defaultCustomerName}
                required
              />
            </label>
            <Toggle
              name="requireCustomer"
              title="Exigir identificação do cliente"
              detail="Impede concluir a venda sem cliente informado."
              checked={data.requireCustomer}
            />
            <Toggle
              name="lowStockAlerts"
              title="Alertas de estoque baixo"
              detail="Exibe prioridades quando saldo atingir o mínimo."
              checked={data.lowStockAlerts}
            />
            <Toggle
              name="autoGenerateSku"
              title="Gerar SKU automaticamente"
              detail="Cria um código seguro quando o cadastro não informar SKU."
              checked={data.autoGenerateSku}
            />
            <Toggle
              name="allowNegativeStock"
              title="Permitir estoque negativo"
              detail="Autoriza vendas e saídas mesmo sem saldo disponível."
              checked={data.allowNegativeStock}
            />
            <label>
              Validade padrão do orçamento
              <input
                name="quoteValidityDays"
                type="number"
                min="1"
                max="180"
                defaultValue={data.quoteValidityDays}
                required
              />
            </label>
            <label>
              Desconto máximo (%)
              <input
                name="maxDiscountPercent"
                type="number"
                min="0"
                max="100"
                step=".01"
                defaultValue={data.maxDiscountPercent}
                required
              />
            </label>
            <label>
              Tolerância do fechamento (centavos)
              <input
                name="posCloseToleranceCents"
                type="number"
                min="0"
                max="1000000000"
                step="1"
                defaultValue={data.posCloseToleranceCents}
                required
              />
              <small>
                Acima deste total absoluto, o caixa exige aprovação
                independente.
              </small>
            </label>
          </div>
        </section>
        <section className="settings-card" id="settings-notifications">
          <header>
            <i>03</i>
            <div>
              <h2>Notificações operacionais</h2>
              <p>Canal e eventos autorizados para avisos da organização.</p>
            </div>
          </header>
          <div>
            <label className="wide">
              E-mail operacional
              <input
                name="operationalEmail"
                type="email"
                defaultValue={data.operationalEmail || ""}
              />
            </label>
            <Toggle
              name="dailySummary"
              title="Resumo diário"
              detail="Autoriza o consolidado operacional diário."
              checked={data.dailySummary}
            />
            <Toggle
              name="notifyLowStock"
              title="Notificar estoque baixo"
              detail="Autoriza avisos de itens abaixo do mínimo."
              checked={data.notifyLowStock}
            />
            <label>
              Horário do resumo
              <input
                name="dailySummaryTime"
                type="time"
                defaultValue={data.dailySummaryTime}
                required
              />
            </label>
            <Toggle
              name="notifyOverdueTitles"
              title="Títulos vencidos"
              detail="Inclui contas vencidas nas notificações operacionais."
              checked={data.notifyOverdueTitles}
            />
            <Toggle
              name="notifyNewSales"
              title="Novas vendas"
              detail="Notifica o canal operacional a cada venda concluída."
              checked={data.notifyNewSales}
            />
          </div>
        </section>
        <section className="settings-card" id="settings-documents">
          <header>
            <i>04</i>
            <div>
              <h2>Documentos e comunicação</h2>
              <p>
                Textos padronizados usados em orçamentos, comprovantes e termos.
              </p>
            </div>
          </header>
          <div>
            <label className="wide">
              Rodapé dos orçamentos
              <textarea
                name="quoteFooter"
                defaultValue={data.quoteFooter || ""}
                maxLength={1000}
              />
            </label>
            <label className="wide">
              Rodapé dos comprovantes
              <textarea
                name="receiptFooter"
                defaultValue={data.receiptFooter || ""}
                maxLength={1000}
              />
            </label>
            <label className="wide">
              Termos e condições
              <textarea
                name="termsAndConditions"
                defaultValue={data.termsAndConditions || ""}
                maxLength={5000}
              />
            </label>
          </div>
        </section>
        <section className="settings-card" id="settings-governance">
          <header>
            <i>05</i>
            <div>
              <h2>Governança e auditoria</h2>
              <p>Política mínima de preservação das evidências do tenant.</p>
            </div>
          </header>
          <div>
            <label className="wide">
              Retenção da auditoria (dias)
              <input
                name="auditRetentionDays"
                type="number"
                min="365"
                max="3650"
                defaultValue={data.auditRetentionDays}
                required
              />
              <small>
                Entre 1 e 10 anos. A exclusão física requer rotina controlada
                futura; salvar não apaga eventos.
              </small>
            </label>
            <label className="wide">
              E-mail do encarregado de dados (LGPD)
              <input
                name="dataProtectionEmail"
                type="email"
                defaultValue={data.dataProtectionEmail || ""}
                placeholder="privacidade@empresa.com.br"
              />
            </label>
            <div className="settings-security wide">
              <strong>Segredos e credenciais não ficam nesta tela</strong>
              <p>
                Integrações sensíveis usam o cofre cifrado. Esta configuração
                mantém somente preferências operacionais não secretas.
              </p>
            </div>
          </div>
        </section>
        <footer className="settings-save">
          <div>
            <strong>Versão {data.version}</strong>
            <small>
              Se outro usuário salvar antes, o backend exigirá recarregar.
            </small>
          </div>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar configurações"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Toggle({
  name,
  title,
  detail,
  checked,
}: {
  name: string;
  title: string;
  detail: string;
  checked: boolean;
}) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" name={name} defaultChecked={checked} />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function Branches() {
  const branchRouter = useRouter();
  const [data, setData] = useState<BranchCatalog>(),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Branch>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setError("");
    const response = await fetch("/api/erp/branches", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setData(body);
    else setError(body.error || "Não foi possível carregar as filiais.");
  }
  useEffect(() => {
    load();
  }, []);
  async function command(
    url: string,
    method: string,
    payload: Record<string, unknown>,
    success: string,
  ) {
    setBusy(true);
    setError("");
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Não foi possível concluir a operação.");
      return false;
    }
    setNotice(success);
    window.setTimeout(() => setNotice(""), 2500);
    await load();
    return true;
  }
  async function save(payload: Record<string, unknown>) {
    if (
      await command(
        editing ? `/api/erp/branches/${editing.id}` : "/api/erp/branches",
        editing ? "PATCH" : "POST",
        payload,
        editing
          ? "Filial atualizada e auditada."
          : "Filial criada no banco da organização.",
      )
    ) {
      setOpen(false);
      setEditing(undefined);
    }
  }
  async function select(branch: Branch) {
    if (
      await command(
        "/api/erp/branches",
        "POST",
        { action: "branch.select", branchId: branch.id },
        `${branch.name} definida como filial ativa.`,
      )
    )
      branchRouter.refresh();
  }
  async function toggle(branch: Branch) {
    await command(
      `/api/erp/branches/${branch.id}`,
      "PATCH",
      {
        action: "status",
        status: branch.status === "active" ? "inactive" : "active",
      },
      "Status da filial atualizado.",
    );
  }
  if (!data)
    return (
      <div className="tenant-loading">
        {error || "Carregando empresas, filiais e depósitos…"}
      </div>
    );
  return (
    <div className="erp-branches">
      {notice && <div className="tenant-notice">{notice}</div>}
      {error && <div className="tenant-error">{error}</div>}
      <section className="tenant-kpis">
        <Kpi
          label="Unidades cadastradas"
          value={String(data.summary.total)}
          detail="CNPJs deste tenant"
        />
        <Kpi
          label="Unidades ativas"
          value={String(data.summary.active)}
          detail="Liberadas para operação"
        />
        <Kpi
          label="Matrizes"
          value={String(data.summary.headquarters)}
          detail="Sedes jurídicas"
        />
        <Kpi
          label="Depósitos sem filial"
          value={String(data.summary.unassignedWarehouses)}
          detail="Aguardando vínculo"
          alert={data.summary.unassignedWarehouses > 0}
        />
      </section>
      <div className="tenant-toolbar register-toolbar">
        <div>
          <strong>Estrutura da organização</strong>
          <small>
            Cada unidade compartilha o banco isolado do tenant e mantém regras
            fiscais próprias
          </small>
        </div>
        <button
          className="primary"
          onClick={() => {
            setEditing(undefined);
            setOpen(true);
          }}
        >
          + Nova filial
        </button>
      </div>
      <section className="branch-grid">
        {data.branches.map((branch) => (
          <article
            className={`branch-card ${data.activeBranchId === branch.id ? "selected" : ""}`}
            key={branch.id}
          >
            <header>
              <div>
                <span>
                  {branch.type === "headquarters" ? "MATRIZ" : "FILIAL"} ·{" "}
                  {branch.code}
                </span>
                <h2>{branch.name}</h2>
              </div>
              <div>
                {branch.primary && <em>Principal</em>}
                <i className={branch.status}>
                  {branch.status === "active" ? "Ativa" : "Inativa"}
                </i>
              </div>
            </header>
            <p>
              <strong>{branch.legalName}</strong>
              <span>{formatDocument(branch.document)}</span>
            </p>
            <dl>
              <div>
                <dt>Localização</dt>
                <dd>
                  {[branch.city, branch.state].filter(Boolean).join(" / ") ||
                    "Não informada"}
                </dd>
              </div>
              <div>
                <dt>Depósitos</dt>
                <dd>{branch.warehouses.length}</dd>
              </div>
              <div>
                <dt>Saldo disponível</dt>
                <dd>
                  {numberValue(
                    branch.warehouses.reduce(
                      (total, item) =>
                        total +
                        item.balances.reduce(
                          (sum, balance) =>
                            sum + balance.quantity - balance.reservedQuantity,
                          0,
                        ),
                      0,
                    ),
                  )}
                </dd>
              </div>
              <div>
                <dt>Usuários com acesso</dt>
                <dd>{branch._count.userAccesses}</dd>
              </div>
            </dl>
            <section>
              <span>
                <small>Regime fiscal</small>
                <strong>{taxRegimeLabel(branch.settings?.taxRegime)}</strong>
              </span>
              <span>
                <small>Ambiente</small>
                <strong>
                  {branch.settings?.fiscalEnvironment === "production"
                    ? "Produção"
                    : "Homologação"}
                </strong>
              </span>
              <span>
                <small>Depósito padrão</small>
                <strong>
                  {branch.defaultWarehouse?.name || "Não definido"}
                </strong>
              </span>
            </section>
            <footer>
              <button
                onClick={() => {
                  setEditing(branch);
                  setOpen(true);
                }}
              >
                Editar
              </button>
              {!branch.primary && (
                <button disabled={busy} onClick={() => toggle(branch)}>
                  {branch.status === "active" ? "Inativar" : "Ativar"}
                </button>
              )}
              <button
                className="primary"
                disabled={
                  busy ||
                  branch.status !== "active" ||
                  data.activeBranchId === branch.id
                }
                onClick={() => select(branch)}
              >
                {data.activeBranchId === branch.id
                  ? "Filial em uso"
                  : "Usar esta filial"}
              </button>
            </footer>
          </article>
        ))}
      </section>
      {!data.branches.length && (
        <section className="tenant-panel">
          <Empty text="Nenhuma unidade cadastrada." />
        </section>
      )}
      {open && (
        <BranchModal
          branch={editing}
          warehouses={data.warehouses}
          products={data.products}
          profiles={data.profiles}
          busy={busy}
          close={() => {
            setOpen(false);
            setEditing(undefined);
          }}
          submit={save}
        />
      )}
    </div>
  );
}

function BranchModal({
  branch,
  warehouses,
  products,
  profiles,
  busy,
  close,
  submit,
}: {
  branch?: Branch;
  warehouses: BranchWarehouse[];
  products: BranchProductCatalogItem[];
  profiles: BranchProfile[];
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const available = warehouses.filter(
      (item) => !item.branchId || item.branchId === branch?.id,
    ),
    initial = branch?.warehouses.map((item) => item.id) || [],
    [selected, setSelected] = useState<number[]>(initial),
    [section, setSection] = useState("geral"),
    [productQuery, setProductQuery] = useState(""),
    [productConfigurations, setProductConfigurations] = useState<
      BranchProductConfiguration[]
    >(() =>
      products.map(
        (product) =>
          branch?.productConfigurations.find(
            (item) => item.productId === product.id,
          ) || {
            productId: product.id,
            active: product.active,
            saleEnabled: true,
            purchaseEnabled: product.type === "product",
            priceOverride: null,
            costOverride: null,
            minStock: product.type === "product" ? product.minStock : null,
            maxStock: null,
            reorderPoint: product.type === "product" ? product.minStock : null,
            reorderQuantity:
              product.type === "product" ? Math.max(product.minStock, 1) : null,
            preferredWarehouseId: null,
            location: null,
            leadTimeDays: 0,
          },
      ),
    ),
    [userAccesses, setUserAccesses] = useState<BranchUserAccess[]>(
      () =>
        branch?.userAccesses ||
        profiles.map((profile) => ({
          userProfileId: profile.id,
          canSell: true,
          canManageStock: true,
          canIssueFiscal: branch?.type === "headquarters",
          primary: false,
        })),
    );
  function toggleWarehouse(id: number) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
    if (selected.includes(id))
      setProductConfigurations((current) =>
        current.map((item) =>
          item.preferredWarehouseId === id
            ? { ...item, preferredWarehouseId: null }
            : item,
        ),
      );
  }
  function updateProduct(
    productId: number,
    values: Partial<BranchProductConfiguration>,
  ) {
    setProductConfigurations((current) =>
      current.map((item) =>
        item.productId === productId ? { ...item, ...values } : item,
      ),
    );
  }
  function updateAccess(
    userProfileId: number,
    values: Partial<BranchUserAccess>,
  ) {
    setUserAccesses((current) => {
      const existing = current.find(
        (item) => item.userProfileId === userProfileId,
      );
      if (existing)
        return current.map((item) =>
          item.userProfileId === userProfileId ? { ...item, ...values } : item,
        );
      return [
        ...current,
        {
          userProfileId,
          canSell: true,
          canManageStock: false,
          canIssueFiscal: false,
          primary: false,
          ...values,
        },
      ];
    });
  }
  function removeAccess(userProfileId: number) {
    setUserAccesses((current) =>
      current.filter((item) => item.userProfileId !== userProfileId),
    );
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await submit({
      ...values,
      warehouseIds: selected,
      defaultWarehouseId: values.defaultWarehouseId
        ? Number(values.defaultWarehouseId)
        : null,
      productConfigurations,
      userAccesses,
    });
  }
  return (
    <ErpModal
      className="branch-modal"
      close={close}
      label={branch ? "Editar filial" : "Nova filial"}
    >
      <form onSubmit={save}>
        <header>
          <div>
            <small>UNIDADE OPERACIONAL E FISCAL</small>
            <h2>{branch ? "Editar filial" : "Nova filial"}</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </header>
        <nav className="branch-modal-tabs" aria-label="Seções da filial">
          {[
            ["geral", "Dados gerais"],
            ["endereco", "Endereço"],
            ["fiscal", "Fiscal"],
            ["estoque", "Estoque"],
            ["catalogo", "Produtos e serviços"],
            ["usuarios", "Usuários"],
          ].map(([id, label]) => (
            <button
              type="button"
              className={section === id ? "active" : ""}
              onClick={() => setSection(id)}
              key={id}
            >
              {label}
            </button>
          ))}
        </nav>
        <section className="branch-modal-section" hidden={section !== "geral"}>
          <div className="branch-section-heading">
            <strong>Identificação da unidade</strong>
            <small>Dados jurídicos, operacionais e responsável local.</small>
          </div>
          <label>
            Código
            <input
              name="code"
              defaultValue={branch?.code || ""}
              placeholder="Ex.: CENTRO"
              required
            />
          </label>
          <label>
            Tipo
            <select name="type" defaultValue={branch?.type || "branch"}>
              <option value="branch">Filial</option>
              <option value="headquarters">Matriz</option>
            </select>
          </label>
          <label className="wide">
            Nome da unidade
            <input name="name" defaultValue={branch?.name || ""} required />
          </label>
          <label className="wide">
            Razão social
            <input
              name="legalName"
              defaultValue={branch?.legalName || ""}
              required
            />
          </label>
          <label>
            CNPJ
            <input
              name="document"
              defaultValue={formatDocument(branch?.document)}
              required
            />
          </label>
          <label>
            Centro de custo
            <input
              name="costCenterCode"
              defaultValue={branch?.costCenterCode || ""}
              placeholder="Ex.: CC-001"
            />
          </label>
          <label>
            Inscrição estadual
            <input
              name="stateRegistration"
              defaultValue={branch?.stateRegistration || ""}
            />
          </label>
          <label>
            Inscrição municipal
            <input
              name="municipalRegistration"
              defaultValue={branch?.municipalRegistration || ""}
            />
          </label>
          <label>
            E-mail da unidade
            <input
              name="email"
              type="email"
              defaultValue={branch?.email || ""}
            />
          </label>
          <label>
            Telefone da unidade
            <input name="phone" defaultValue={branch?.phone || ""} />
          </label>
          <div className="branch-section-heading">
            <strong>Responsável local</strong>
            <small>Contato para operação, alertas e aprovações.</small>
          </div>
          <label>
            Nome
            <input
              name="managerName"
              defaultValue={branch?.managerName || ""}
            />
          </label>
          <label>
            E-mail
            <input
              name="managerEmail"
              type="email"
              defaultValue={branch?.managerEmail || ""}
            />
          </label>
          <label>
            Telefone
            <input
              name="managerPhone"
              defaultValue={branch?.managerPhone || ""}
            />
          </label>
          <label>
            Fuso horário
            <select
              name="timezone"
              defaultValue={branch?.timezone || "America/Sao_Paulo"}
            >
              <option value="America/Sao_Paulo">Brasília</option>
              <option value="America/Manaus">Manaus</option>
              <option value="America/Cuiaba">Cuiabá</option>
              <option value="America/Rio_Branco">Rio Branco</option>
              <option value="America/Fortaleza">Fortaleza</option>
              <option value="America/Recife">Recife</option>
              <option value="America/Bahia">Bahia</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
        </section>
        <section
          className="branch-modal-section"
          hidden={section !== "endereco"}
        >
          <div className="branch-section-heading">
            <strong>Endereço fiscal e operacional</strong>
            <small>Usado em documentos, expedição e integrações.</small>
          </div>
          <label>
            CEP
            <input
              name="zip"
              defaultValue={branch?.zip || ""}
              inputMode="numeric"
            />
          </label>
          <label>
            UF
            <input
              name="state"
              maxLength={2}
              defaultValue={branch?.state || ""}
            />
          </label>
          <label className="wide">
            Logradouro
            <input name="street" defaultValue={branch?.street || ""} />
          </label>
          <label>
            Número
            <input name="number" defaultValue={branch?.number || ""} />
          </label>
          <label>
            Complemento
            <input name="complement" defaultValue={branch?.complement || ""} />
          </label>
          <label>
            Bairro
            <input name="district" defaultValue={branch?.district || ""} />
          </label>
          <label>
            Cidade
            <input name="city" defaultValue={branch?.city || ""} />
          </label>
        </section>
        <section className="branch-modal-section" hidden={section !== "fiscal"}>
          <div className="branch-section-heading">
            <strong>Emissão fiscal</strong>
            <small>Ambiente e sequências independentes por CNPJ.</small>
          </div>
          <label>
            Regime tributário
            <select
              name="taxRegime"
              defaultValue={branch?.settings?.taxRegime || "simples_nacional"}
            >
              <option value="simples_nacional">Simples Nacional</option>
              <option value="lucro_presumido">Lucro Presumido</option>
              <option value="lucro_real">Lucro Real</option>
              <option value="mei">MEI</option>
            </select>
          </label>
          <label>
            Ambiente fiscal
            <select
              name="fiscalEnvironment"
              defaultValue={
                branch?.settings?.fiscalEnvironment || "homologation"
              }
            >
              <option value="homologation">Homologação</option>
              <option value="production">Produção</option>
            </select>
          </label>
          <label>
            Série NF-e
            <input
              name="nfeSeries"
              type="number"
              min="1"
              max="999"
              defaultValue={branch?.settings?.nfeSeries || 1}
            />
          </label>
          <label>
            Série NFC-e
            <input
              name="nfceSeries"
              type="number"
              min="1"
              max="999"
              defaultValue={branch?.settings?.nfceSeries || 1}
            />
          </label>
          <label>
            Série NFS-e
            <input
              name="nfseSeries"
              type="number"
              min="1"
              max="999"
              defaultValue={branch?.settings?.nfseSeries || 1}
            />
          </label>
        </section>
        <section
          className="branch-modal-section"
          hidden={section !== "estoque"}
        >
          <div className="branch-section-heading">
            <strong>Depósitos e política de atendimento</strong>
            <small>
              O saldo pertence ao depósito; a filial controla disponibilidade e
              reposição.
            </small>
          </div>
          <div className="branch-warehouse-picker wide">
            {available.map((warehouse) => (
              <label key={warehouse.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(warehouse.id)}
                  onChange={() => toggleWarehouse(warehouse.id)}
                />
                <span>
                  <strong>{warehouse.name}</strong>
                  <small>
                    {warehouse.code}
                    {warehouse.primary ? " · principal" : ""}
                  </small>
                </span>
              </label>
            ))}
            {!available.length && (
              <Empty text="Não há depósitos disponíveis para vincular." />
            )}
          </div>
          <label className="wide">
            Depósito padrão
            <select
              name="defaultWarehouseId"
              defaultValue={branch?.defaultWarehouseId || ""}
            >
              <option value="">Nenhum</option>
              {available
                .filter((item) => selected.includes(item.id))
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.code}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Estratégia de alocação
            <select
              name="stockAllocationStrategy"
              defaultValue={
                branch?.settings?.stockAllocationStrategy || "local_first"
              }
            >
              <option value="local_first">Priorizar estoque local</option>
              <option value="highest_stock">Maior saldo disponível</option>
              <option value="lowest_cost">Menor custo logístico</option>
            </select>
          </label>
          <div className="branch-policy-list wide">
            <label>
              <input
                type="checkbox"
                name="reserveStockOnOrder"
                defaultChecked={branch?.settings?.reserveStockOnOrder ?? true}
              />
              <span>
                <strong>Reservar estoque no pedido</strong>
                <small>
                  Evita vender o mesmo saldo em pedidos simultâneos.
                </small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                name="allowCrossBranchFulfillment"
                defaultChecked={
                  branch?.settings?.allowCrossBranchFulfillment ?? false
                }
              />
              <span>
                <strong>Atender por outra filial</strong>
                <small>
                  Permite localizar saldo em depósitos de outra unidade.
                </small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                name="autoTransferEnabled"
                defaultChecked={branch?.settings?.autoTransferEnabled ?? false}
              />
              <span>
                <strong>Sugerir transferência automática</strong>
                <small>Gera sugestão de reposição entre depósitos.</small>
              </span>
            </label>
          </div>
        </section>
        <section
          className="branch-modal-section branch-catalog-section"
          hidden={section !== "catalogo"}
        >
          <div className="branch-section-heading">
            <strong>Catálogo da filial</strong>
            <small>
              Disponibilidade, preço, estoque mínimo e depósito preferencial por
              unidade.
            </small>
          </div>
          <label className="wide branch-product-search">
            Buscar produto ou serviço
            <input
              value={productQuery}
              onChange={(event) => setProductQuery(event.target.value)}
              placeholder="Nome, SKU ou tipo…"
            />
          </label>
          <div className="branch-product-list wide">
            {products
              .filter((product) =>
                `${product.name} ${product.sku} ${product.type}`
                  .toLowerCase()
                  .includes(productQuery.toLowerCase()),
              )
              .map((product) => {
                const config = productConfigurations.find(
                  (item) => item.productId === product.id,
                )!;
                return (
                  <article
                    className={!config.active ? "inactive" : ""}
                    key={product.id}
                  >
                    <header>
                      <label>
                        <input
                          type="checkbox"
                          checked={config.active}
                          onChange={(event) =>
                            updateProduct(product.id, {
                              active: event.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>{product.name}</strong>
                          <small>
                            {product.sku} ·{" "}
                            {product.type === "service"
                              ? "Serviço"
                              : `Produto · ${product.unit}`}
                          </small>
                        </span>
                      </label>
                      <span>
                        {product.type === "service"
                          ? "Sem estoque"
                          : "Controlado por depósito"}
                      </span>
                    </header>
                    <div>
                      <label>
                        Preço na filial
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={config.priceOverride ?? ""}
                          placeholder={money.format(product.price)}
                          onChange={(event) =>
                            updateProduct(product.id, {
                              priceOverride:
                                event.target.value === ""
                                  ? null
                                  : Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Estoque mínimo
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          disabled={product.type === "service"}
                          value={config.minStock ?? ""}
                          onChange={(event) =>
                            updateProduct(product.id, {
                              minStock:
                                event.target.value === ""
                                  ? null
                                  : Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Ponto de reposição
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          disabled={product.type === "service"}
                          value={config.reorderPoint ?? ""}
                          onChange={(event) =>
                            updateProduct(product.id, {
                              reorderPoint:
                                event.target.value === ""
                                  ? null
                                  : Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Depósito preferencial
                        <select
                          disabled={product.type === "service"}
                          value={config.preferredWarehouseId || ""}
                          onChange={(event) =>
                            updateProduct(product.id, {
                              preferredWarehouseId: event.target.value
                                ? Number(event.target.value)
                                : null,
                            })
                          }
                        >
                          <option value="">Padrão da filial</option>
                          {available
                            .filter((item) => selected.includes(item.id))
                            .map((item) => (
                              <option value={item.id} key={item.id}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Localização
                        <input
                          disabled={product.type === "service"}
                          value={config.location || ""}
                          placeholder="Ex.: A-03-02"
                          onChange={(event) =>
                            updateProduct(product.id, {
                              location: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="branch-inline-check">
                        <input
                          type="checkbox"
                          checked={config.saleEnabled}
                          onChange={(event) =>
                            updateProduct(product.id, {
                              saleEnabled: event.target.checked,
                            })
                          }
                        />
                        Venda liberada
                      </label>
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
        <section
          className="branch-modal-section"
          hidden={section !== "usuarios"}
        >
          <div className="branch-section-heading">
            <strong>Usuários autorizados</strong>
            <small>
              O perfil global define permissões; aqui você limita a unidade
              operacional.
            </small>
          </div>
          <div className="branch-access-list wide">
            {profiles.map((profile) => {
              const access = userAccesses.find(
                (item) => item.userProfileId === profile.id,
              );
              return (
                <article key={profile.id}>
                  <label className="branch-access-user">
                    <input
                      type="checkbox"
                      checked={Boolean(access)}
                      onChange={(event) =>
                        event.target.checked
                          ? updateAccess(profile.id, {})
                          : removeAccess(profile.id)
                      }
                    />
                    <span>
                      <strong>{profile.displayName}</strong>
                      <small>{profile.email}</small>
                    </span>
                  </label>
                  {access && (
                    <div>
                      <label>
                        <input
                          type="checkbox"
                          checked={access.canSell}
                          onChange={(event) =>
                            updateAccess(profile.id, {
                              canSell: event.target.checked,
                            })
                          }
                        />
                        Vendas
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={access.canManageStock}
                          onChange={(event) =>
                            updateAccess(profile.id, {
                              canManageStock: event.target.checked,
                            })
                          }
                        />
                        Estoque
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={access.canIssueFiscal}
                          onChange={(event) =>
                            updateAccess(profile.id, {
                              canIssueFiscal: event.target.checked,
                            })
                          }
                        />
                        Fiscal
                      </label>
                    </div>
                  )}
                </article>
              );
            })}
            {!profiles.length && (
              <Empty text="Nenhum usuário ativo para vincular." />
            )}
          </div>
        </section>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar filial"}
          </button>
        </footer>
      </form>
    </ErpModal>
  );
}

function Products({
  data,
  action,
  busy,
}: {
  data: Snapshot;
  action: any;
  busy: boolean;
}) {
  const features = usePlanFeatures();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "price" | "stock">("name");
  const [page, setPage] = useState(1);
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [editing, setEditing] = useState<{
    mode: "create" | "edit" | "view";
    item?: Product;
  } | null>(null);
  const deepLinkHandled = useRef(false);
  const pageSize = 25;
  const categories = useMemo(
    () =>
      [
        ...new Set(
          data.products.map((product) => product.category).filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b, "pt-BR")),
    [data.products],
  );
  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
    return data.products
      .filter((product) => {
        const matchesQuery =
          !normalizedQuery ||
          `${product.name} ${product.sku || ""} ${product.category || ""} ${product.gtin || ""}`
            .toLocaleLowerCase("pt-BR")
            .includes(normalizedQuery);
        return (
          matchesQuery &&
          (typeFilter === "all" || product.type === typeFilter) &&
          (statusFilter === "all" ||
            (statusFilter === "active" ? product.active : !product.active)) &&
          (categoryFilter === "all" || product.category === categoryFilter)
        );
      })
      .sort((a, b) => {
        if (sort === "price") return b.price - a.price;
        if (sort === "stock") return b.stock - a.stock;
        return a.name.localeCompare(b.name, "pt-BR");
      });
  }, [categoryFilter, data.products, query, sort, statusFilter, typeFilter]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visibleRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const active = data.products.filter((product) => product.active).length;
  const services = data.products.filter(
    (product) => product.type === "service",
  ).length;
  const lowStock = data.products.filter(
    (product) =>
      product.type === "product" &&
      product.active &&
      product.manageStock !== false &&
      product.stock <= product.minStock,
  ).length;
  const inventoryValue = data.products.reduce(
    (total, product) =>
      total + (product.type === "product" ? product.stock * product.cost : 0),
    0,
  );
  const hasFilters = Boolean(
    query ||
    typeFilter !== "all" ||
    statusFilter !== "all" ||
    categoryFilter !== "all",
  );

  useEffect(
    () => setPage(1),
    [query, typeFilter, statusFilter, categoryFilter, sort],
  );
  useEffect(() => {
    if (deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const url = new URL(window.location.href);
    const productId = Number(url.searchParams.get("produto"));
    const product = Number.isInteger(productId)
      ? data.products.find((item) => item.id === productId)
      : undefined;
    if (!product) return;
    setEditing({ mode: "view", item: product });
    url.searchParams.delete("produto");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [data.products]);
  useEffect(() => {
    if (openMenu === null) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".product-actions-menu"))
        setOpenMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        document
          .querySelector<HTMLButtonElement>(
            `[data-product-actions="${openMenu}"]`,
          )
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [openMenu]);

  function clearFilters() {
    setQuery("");
    setTypeFilter("all");
    setStatusFilter("all");
    setCategoryFilter("all");
  }

  function navigateActionMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      !openMenu ||
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    )
      return;
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        "[role=menuitem]:not(:disabled)",
      ),
    ];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? current <= 0
              ? items.length - 1
              : current - 1
            : (current + 1) % items.length;
    items[next].focus();
  }

  async function save(product: Record<string, unknown>) {
    const updating = Boolean(product.id);
    return action(
      { action: updating ? "update_product" : "create_product", product },
      updating
        ? "Produto atualizado no banco."
        : "Produto cadastrado no banco.",
    );
  }
  return (
    <div className="product-catalog-page">
      <section className="product-page-heading">
        <div>
          <span>CATÁLOGO</span>
          <h2>{features.services ? "Produtos e serviços" : "Produtos"}</h2>
          <p>
            Gerencie preços, estoque, publicação e dados fiscais em um só lugar.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => setEditing({ mode: "create" })}
        >
          <span aria-hidden="true">＋</span> Novo item
        </button>
      </section>

      <section className="product-summary" aria-label="Resumo do catálogo">
        <article>
          <span>Total no catálogo</span>
          <strong>{data.products.length}</strong>
          <small>{active} ativos</small>
        </article>
        <article>
          <span>Produtos</span>
          <strong>{data.products.length - services}</strong>
          <small>{features.services ? `${services} serviços` : "Peças de vestuário e acessórios"}</small>
        </article>
        <article className={lowStock ? "warning" : ""}>
          <span>Estoque baixo</span>
          <strong>{lowStock}</strong>
          <small>{lowStock ? "Requer atenção" : "Tudo em ordem"}</small>
        </article>
        <article>
          <span>Valor em estoque</span>
          <strong>{money.format(inventoryValue)}</strong>
          <small>Saldo × custo</small>
        </article>
      </section>

      <section className="product-toolbar" aria-label="Filtros do catálogo">
        <label className="product-search">
          <span>Buscar</span>
          <div>
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nome, SKU, GTIN ou categoria"
              aria-label="Buscar no catálogo"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Limpar busca"
              >
                ×
              </button>
            )}
          </div>
        </label>
        <label>
          <span>Tipo</span>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="all">Todos</option>
            <option value="product">Produtos</option>
            {features.services && <option value="service">Serviços</option>}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">Todos</option>
            <option value="active">Ativos</option>
            <option value="inactive">Inativos</option>
          </select>
        </label>
        <label>
          <span>Categoria</span>
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="all">Todas</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Ordenar</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="name">Nome (A–Z)</option>
            <option value="price">Maior preço</option>
            <option value="stock">Maior estoque</option>
          </select>
        </label>
        {hasFilters && (
          <button
            className="product-clear-filters"
            type="button"
            onClick={clearFilters}
          >
            Limpar filtros
          </button>
        )}
      </section>

      <section
        className="tenant-panel tenant-table product-table"
        aria-labelledby="product-results-title"
      >
        <header>
          <div>
            <h3 id="product-results-title">Itens do catálogo</h3>
            <p>
              {rows.length === data.products.length
                ? `${rows.length} itens cadastrados`
                : `${rows.length} de ${data.products.length} itens`}
            </p>
          </div>
          <span>
            Página {Math.min(page, pages)} de {pages}
          </span>
        </header>
        <table>
          <caption className="product-sr-only">
            Lista de produtos e serviços do catálogo
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">SKU</th>
              <th scope="col">Categoria</th>
              <th scope="col" className="product-numeric">
                Preço
              </th>
              <th scope="col">Estoque</th>
              <th scope="col">Status</th>
              <th scope="col" className="product-actions-heading">
                <span className="product-sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((x) => {
              const isLowStock =
                x.type === "product" &&
                x.manageStock !== false &&
                x.stock <= x.minStock;
              return (
                <tr key={x.id}>
                  <td className="product-media-cell" data-label="Item">
                    {x.imageMediaId ? (
                      <img
                        src={`/api/erp/library/${x.imageMediaId}/file`}
                        alt={x.name}
                      />
                    ) : (
                      <span aria-hidden="true">
                        {x.type === "service" ? "◇" : "▧"}
                      </span>
                    )}
                    <div>
                      <strong>{x.name}</strong>
                      <small>
                        {x.type === "service" ? "Serviço" : "Produto"}
                      </small>
                    </div>
                  </td>
                  <td data-label="SKU">
                    <code>{x.sku || "Sem SKU"}</code>
                  </td>
                  <td data-label="Categoria">
                    {x.category || "Sem categoria"}
                  </td>
                  <td data-label="Preço" className="product-numeric">
                    <strong>{money.format(x.price)}</strong>
                  </td>
                  <td data-label="Estoque">
                    {x.type === "service" ? (
                      <span className="product-muted">Não se aplica</span>
                    ) : (
                      <span className={isLowStock ? "product-stock-low" : ""}>
                        {x.stock} {x.unit}
                        {isLowStock && <small>Baixo</small>}
                      </span>
                    )}
                  </td>
                  <td data-label="Status">
                    <span
                      className={`product-status ${x.active ? "active" : "inactive"}`}
                    >
                      <i />
                      {x.active ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td data-label="Ações" className="product-actions-cell">
                    <div
                      className={`product-actions-menu ${openMenu === x.id ? "open" : ""}`}
                      onKeyDown={navigateActionMenu}
                    >
                      <button
                        type="button"
                        data-product-actions={x.id}
                        className="product-actions-trigger"
                        aria-label={`Abrir ações de ${x.name}`}
                        aria-haspopup="menu"
                        aria-expanded={openMenu === x.id}
                        title="Ações"
                        onClick={() =>
                          setOpenMenu((current) =>
                            current === x.id ? null : x.id,
                          )
                        }
                      >
                        •••
                      </button>
                      {openMenu === x.id && (
                        <div role="menu"><button role="menuitem" type="button" onClick={() => { setOpenMenu(null); setEditing({ mode: "view", item: x }); }}>Visualizar item</button>
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setOpenMenu(null);
                              setEditing({ mode: "edit", item: x });
                            }}
                          >
                            Editar item
                          </button>
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              setOpenMenu(null);
                              setEditing({
                                mode: "create",
                                item: {
                                  ...x,
                                  name: `${x.name} (cópia)`,
                                  sku: "",
                                  slug: "",
                                  stock: 0,
                                  variations: (x.variations || []).map((variation: any) => ({ ...variation, id: null, sku: "", stock: 0 })),
                                },
                              });
                            }}
                          >
                            Duplicar
                          </button>
                          {x.type === "product" && (
                            <Link
                              role="menuitem"
                              onClick={() => setOpenMenu(null)}
                              href={`/erp/movimentacoes-estoque?produto=${x.id}`}
                            >
                              Movimentar estoque
                            </Link>
                          )}
                          <Link
                            role="menuitem"
                            onClick={() => setOpenMenu(null)}
                            href={`/erp/relatorios/produtos?search=${encodeURIComponent(x.sku || x.name)}`}
                          >
                            Ver no relatório
                          </Link>
                          <button
                            role="menuitem"
                            type="button"
                            disabled={busy}
                            className={x.active ? "danger" : ""}
                            onClick={async () => {
                              setOpenMenu(null);
                              await action(
                                { action: "toggle_product", id: x.id },
                                x.active ? "Item inativado." : "Item ativado.",
                              );
                            }}
                          >
                            {x.active ? "Inativar" : "Ativar"}
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <div className="product-empty">
            <span aria-hidden="true">⌕</span>
            <h3>
              {hasFilters
                ? "Nenhum item encontrado"
                : "Seu catálogo está vazio"}
            </h3>
            <p>
              {hasFilters
                ? "Tente remover filtros ou usar outro termo de busca."
                : "Cadastre o primeiro produto ou serviço para começar."}
            </p>
            <button
              type="button"
              className={hasFilters ? "" : "primary"}
              onClick={
                hasFilters ? clearFilters : () => setEditing({ mode: "create" })
              }
            >
              {hasFilters ? "Limpar filtros" : "Cadastrar primeiro item"}
            </button>
          </div>
        )}
        {rows.length > pageSize && (
          <footer className="product-pagination">
            <span>
              Exibindo {(currentPage - 1) * pageSize + 1}–
              {Math.min(currentPage * pageSize, rows.length)} de {rows.length}
            </span>
            <div>
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                disabled={page === 1}
              >
                Anterior
              </button>
              <button
                type="button"
                onClick={() => setPage((value) => Math.min(pages, value + 1))}
                disabled={currentPage === pages}
              >
                Próxima
              </button>
            </div>
          </footer>
        )}
      </section>
      {editing && (
        <ProductCatalogForm
          item={editing.item}
          mode={editing.mode}
          products={data.products}
          categories={data.categories || []}
          brands={data.brands || []}
          channels={data.marketplaceChannels || []}
          busy={busy}
          autoGenerateSku={data.settings?.autoGenerateSku ?? true}
          close={() => setEditing(null)}
          submit={save}
        />
      )}
    </div>
  );
}
function Stock({
  data,
  action,
  busy,
}: {
  data: Snapshot;
  action: any;
  busy: boolean;
}) {
  const [productSearch, setProductSearch] = useState("");
  const [productId, setProductId] = useState("");
  const [movementType, setMovementType] = useState<"entry" | "exit">("entry");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [historyType, setHistoryType] = useState<"all" | "entry" | "exit">(
    "all",
  );
  const [historyPeriod, setHistoryPeriod] = useState<
    "today" | "7" | "30" | "all"
  >("30");
  const [historyPage, setHistoryPage] = useState(1);
  const stockDeepLinkHandled = useRef(false);
  const pageSize = 20;
  const products = useMemo(
    () =>
      data.products.filter(
        (product) =>
          product.active &&
          product.type === "product" &&
          product.manageStock !== false,
      ),
    [data.products],
  );
  const visibleProducts = useMemo(() => {
    const search = productSearch.trim().toLocaleLowerCase("pt-BR");
    if (!search) return products;
    return products.filter((product) =>
      `${product.name} ${product.sku || ""} ${product.category || ""}`
        .toLocaleLowerCase("pt-BR")
        .includes(search),
    );
  }, [productSearch, products]);
  const selectedProduct = products.find(
    (product) => String(product.id) === productId,
  );
  const selectableProducts =
    selectedProduct &&
    !visibleProducts.some((product) => product.id === selectedProduct.id)
      ? [selectedProduct, ...visibleProducts]
      : visibleProducts;
  const canManageStock = data.operationalBranch?.canManageStock !== false;
  const parsedQuantity = Number(quantity);
  const validQuantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const projectedStock =
    selectedProduct && validQuantity
      ? selectedProduct.stock +
        (movementType === "entry" ? parsedQuantity : -parsedQuantity)
      : selectedProduct?.stock;
  const today = new Date();
  const todayMovements = data.movements.filter((movement) =>
    sameLocalDay(new Date(movement.createdAt), today),
  );
  const entriesToday = todayMovements
    .filter((movement) => movement.type === "entry")
    .reduce((total, movement) => total + movement.quantity, 0);
  const exitsToday = todayMovements
    .filter((movement) => movement.type === "exit")
    .reduce((total, movement) => total + movement.quantity, 0);
  const inventoryUnits = products.reduce(
    (total, product) => total + product.stock,
    0,
  );
  const reservedUnits = products.reduce(
    (total, product) => total + Number(product.reservedStock || 0),
    0,
  );
  const lowStock = products.filter(
    (product) => product.stock <= product.minStock,
  ).length;
  const filteredMovements = useMemo(() => {
    const search = historySearch.trim().toLocaleLowerCase("pt-BR");
    const now = new Date();
    return data.movements.filter((movement) => {
      const createdAt = new Date(movement.createdAt);
      const matchesSearch =
        !search ||
        `${movement.productName} ${movement.note || ""} ${movement.userName}`
          .toLocaleLowerCase("pt-BR")
          .includes(search);
      const matchesType =
        historyType === "all" || movement.type === historyType;
      const matchesPeriod =
        historyPeriod === "all" ||
        (historyPeriod === "today"
          ? sameLocalDay(createdAt, now)
          : createdAt.getTime() >=
            now.getTime() - Number(historyPeriod) * 86_400_000);
      return matchesSearch && matchesType && matchesPeriod;
    });
  }, [data.movements, historyPeriod, historySearch, historyType]);
  const historyPages = Math.max(
    1,
    Math.ceil(filteredMovements.length / pageSize),
  );
  const visibleMovements = filteredMovements.slice(
    (historyPage - 1) * pageSize,
    historyPage * pageSize,
  );

  useEffect(
    () => setHistoryPage(1),
    [historySearch, historyType, historyPeriod],
  );
  useEffect(() => {
    if (stockDeepLinkHandled.current) return;
    stockDeepLinkHandled.current = true;
    const url = new URL(window.location.href);
    const requestedId = Number(url.searchParams.get("produto"));
    if (products.some((product) => product.id === requestedId)) {
      setProductId(String(requestedId));
      url.searchParams.delete("produto");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  }, [products]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedProduct || !validQuantity) return;
    if (
      await action(
        {
          action: "stock_movement",
          id: selectedProduct.id,
          type: movementType,
          quantity: parsedQuantity,
          note: note.trim(),
        },
        movementType === "entry"
          ? "Entrada registrada no estoque."
          : "Saída registrada no estoque.",
      )
    ) {
      setQuantity("");
      setNote("");
    }
  }

  function exportMovements() {
    const header = [
      "Data",
      "Tipo",
      "Produto",
      "Quantidade",
      "Unidade",
      "Saldo anterior",
      "Saldo atual",
      "Responsável",
      "Observação",
    ];
    const lines = filteredMovements.map((movement) => [
      dateTime(movement.createdAt),
      movement.type === "entry" ? "Entrada" : "Saída",
      movement.productName,
      movement.quantity,
      movement.unit,
      movement.previousStock,
      movement.currentStock,
      movement.userName,
      movement.note || "",
    ]);
    const csv = `\uFEFF${[header, ...lines].map((line) => line.map(stockCsvCell).join(";")).join("\r\n")}`;
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `movimentacoes-estoque-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stock-workspace">
      <section className="stock-page-heading">
        <div>
          <span>CONTROLE OPERACIONAL</span>
          <h2>Movimentações de estoque</h2>
          <p>
            Registre entradas e saídas com rastreabilidade completa do saldo.
          </p>
        </div>
        <aside>
          <small>Filial e depósito ativos</small>
          <strong>
            {data.operationalBranch?.name || "Contexto operacional"}
          </strong>
          <span>
            {data.operationalBranch?.code || "—"} ·{" "}
            {data.operationalBranch?.warehouseName ||
              "Depósito não selecionado"}
          </span>
        </aside>
      </section>

      <section className="stock-summary" aria-label="Resumo do estoque">
        <article>
          <span>Saldo disponível</span>
          <strong>{numberValue(inventoryUnits)}</strong>
          <small>{products.length} itens controlados</small>
        </article>
        <article>
          <span>Reservado</span>
          <strong>{numberValue(reservedUnits)}</strong>
          <small>Não disponível para saída</small>
        </article>
        <article className={lowStock ? "warning" : ""}>
          <span>Estoque baixo</span>
          <strong>{lowStock}</strong>
          <small>{lowStock ? "Itens para revisar" : "Nenhum alerta"}</small>
        </article>
        <article>
          <span>Movimento hoje</span>
          <strong className="stock-net">
            {numberValue(entriesToday - exitsToday)}
          </strong>
          <small>
            <b>+{numberValue(entriesToday)}</b> entradas ·{" "}
            <em>−{numberValue(exitsToday)}</em> saídas
          </small>
        </article>
      </section>

      <div className="stock-main-grid">
        <form className="stock-movement-form" onSubmit={submit}>
          <header>
            <div>
              <span>NOVA OPERAÇÃO</span>
              <h3>Registrar movimentação</h3>
              <p>O saldo é atualizado no depósito ativo após a confirmação.</p>
            </div>
            <i aria-hidden="true">⇅</i>
          </header>
          {!canManageStock ? (
            <div className="stock-no-products">
              <strong>Acesso somente para consulta</strong>
              <p>
                Seu perfil nesta filial não permite registrar entradas ou
                saídas. O histórico continua disponível.
              </p>
            </div>
          ) : !products.length ? (
            <div className="stock-no-products">
              <strong>Nenhum produto controlado</strong>
              <p>
                Ative a gestão de estoque em um produto antes de registrar
                movimentações.
              </p>
              <Link href="/erp/produtos-servicos">
                Abrir produtos e serviços
              </Link>
            </div>
          ) : (
            <>
              <label className="stock-product-search">
                <span>Localizar produto</span>
                <input
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                  placeholder="Busque por nome, SKU ou categoria"
                />
              </label>
              <label>
                <span>Produto</span>
                <select
                  value={productId}
                  onChange={(event) => setProductId(event.target.value)}
                  required
                >
                  <option value="">Selecione um produto</option>
                  {selectableProducts.map((product) => (
                    <option value={product.id} key={product.id}>
                      {product.name} · {product.sku || "sem SKU"}
                    </option>
                  ))}
                </select>
                <small>{visibleProducts.length} produto(s) encontrado(s)</small>
              </label>
              {selectedProduct && (
                <article className="stock-selected-product">
                  {selectedProduct.imageMediaId ? (
                    <img
                      src={`/api/erp/library/${selectedProduct.imageMediaId}/file`}
                      alt=""
                    />
                  ) : (
                    <i aria-hidden="true">▧</i>
                  )}
                  <div>
                    <strong>{selectedProduct.name}</strong>
                    <small>
                      {selectedProduct.sku || "Sem SKU"} ·{" "}
                      {selectedProduct.category || "Sem categoria"}
                    </small>
                  </div>
                  <span>
                    <small>Disponível</small>
                    <b>
                      {numberValue(selectedProduct.stock)}{" "}
                      {selectedProduct.unit}
                    </b>
                  </span>
                </article>
              )}
              <fieldset className="stock-type-picker">
                <legend>Tipo de movimentação</legend>
                <label
                  className={
                    movementType === "entry" ? "active entry" : "entry"
                  }
                >
                  <input
                    type="radio"
                    name="movementType"
                    value="entry"
                    checked={movementType === "entry"}
                    onChange={() => setMovementType("entry")}
                  />
                  <i aria-hidden="true">＋</i>
                  <span>
                    <strong>Entrada</strong>
                    <small>Aumentar o saldo</small>
                  </span>
                </label>
                <label
                  className={movementType === "exit" ? "active exit" : "exit"}
                >
                  <input
                    type="radio"
                    name="movementType"
                    value="exit"
                    checked={movementType === "exit"}
                    onChange={() => setMovementType("exit")}
                  />
                  <i aria-hidden="true">−</i>
                  <span>
                    <strong>Saída</strong>
                    <small>Reduzir o saldo</small>
                  </span>
                </label>
              </fieldset>
              <label>
                <span>Quantidade</span>
                <div className="stock-quantity-field">
                  <input
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    type="number"
                    min="0.001"
                    step="0.001"
                    inputMode="decimal"
                    placeholder="0,000"
                    required
                  />
                  <b>{selectedProduct?.unit || "UN"}</b>
                </div>
              </label>
              <label>
                <span>
                  Motivo ou referência <em>opcional</em>
                </span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="Ex.: recebimento da compra 1042, avaria ou ajuste manual"
                />
                <small>{note.length}/500 caracteres</small>
              </label>
              {selectedProduct && (
                <div className={`stock-balance-preview ${movementType}`}>
                  <span>
                    <small>Saldo atual</small>
                    <strong>
                      {numberValue(selectedProduct.stock)}{" "}
                      {selectedProduct.unit}
                    </strong>
                  </span>
                  <i aria-hidden="true">→</i>
                  <span>
                    <small>Saldo após operação</small>
                    <strong>
                      {projectedStock === undefined
                        ? "—"
                        : `${numberValue(projectedStock)} ${selectedProduct.unit}`}
                    </strong>
                  </span>
                </div>
              )}
              {movementType === "exit" &&
                selectedProduct &&
                validQuantity &&
                parsedQuantity > selectedProduct.stock && (
                  <p className="stock-form-warning" role="alert">
                    A quantidade ultrapassa o saldo disponível. A operação
                    poderá ser recusada conforme reservas e política de estoque.
                  </p>
                )}
              <button
                className={`stock-submit primary ${movementType}`}
                disabled={busy || !selectedProduct || !validQuantity}
              >
                {busy
                  ? "Registrando…"
                  : movementType === "entry"
                    ? "Confirmar entrada"
                    : "Confirmar saída"}
              </button>
            </>
          )}
          <footer>
            <span aria-hidden="true">▣</span>
            <p>
              <strong>Registro auditável</strong>Movimentações confirmadas não
              podem ser editadas ou excluídas.
            </p>
          </footer>
        </form>

        <section
          className="stock-history"
          aria-labelledby="stock-history-title"
        >
          <header>
            <div>
              <span>TRILHA DE ESTOQUE</span>
              <h3 id="stock-history-title">Histórico de movimentações</h3>
              <p>
                {filteredMovements.length === data.movements.length
                  ? `${data.movements.length} registros`
                  : `${filteredMovements.length} de ${data.movements.length} registros`}
              </p>
            </div>
            <button
              type="button"
              onClick={exportMovements}
              disabled={!filteredMovements.length}
            >
              Exportar CSV
            </button>
          </header>
          <div className="stock-history-filters">
            <label className="stock-history-search">
              <span>Buscar</span>
              <input
                value={historySearch}
                onChange={(event) => setHistorySearch(event.target.value)}
                placeholder="Produto, observação ou responsável"
              />
            </label>
            <label>
              <span>Tipo</span>
              <select
                value={historyType}
                onChange={(event) =>
                  setHistoryType(event.target.value as typeof historyType)
                }
              >
                <option value="all">Todos</option>
                <option value="entry">Entradas</option>
                <option value="exit">Saídas</option>
              </select>
            </label>
            <label>
              <span>Período</span>
              <select
                value={historyPeriod}
                onChange={(event) =>
                  setHistoryPeriod(event.target.value as typeof historyPeriod)
                }
              >
                <option value="today">Hoje</option>
                <option value="7">Últimos 7 dias</option>
                <option value="30">Últimos 30 dias</option>
                <option value="all">Todo o período</option>
              </select>
            </label>
          </div>
          <div className="stock-movement-list">
            {visibleMovements.map((movement) => (
              <article key={movement.id} className={movement.type}>
                <i aria-hidden="true">
                  {movement.type === "entry" ? "+" : "−"}
                </i>
                <div className="stock-movement-main">
                  <strong>{movement.productName}</strong>
                  <p>{movement.note || "Movimentação manual sem observação"}</p>
                  <small>
                    {movement.userName} ·{" "}
                    <time dateTime={movement.createdAt}>
                      {dateTime(movement.createdAt)}
                    </time>
                  </small>
                </div>
                <div className="stock-balance-change">
                  <span>
                    <small>Anterior</small>
                    <b>{numberValue(movement.previousStock)}</b>
                  </span>
                  <i aria-hidden="true">→</i>
                  <span>
                    <small>Atual</small>
                    <b>{numberValue(movement.currentStock)}</b>
                  </span>
                </div>
                <strong className="stock-movement-amount">
                  {movement.type === "entry" ? "+" : "−"}
                  {numberValue(movement.quantity)}{" "}
                  <small>{movement.unit}</small>
                </strong>
              </article>
            ))}
            {!visibleMovements.length && (
              <div className="stock-history-empty">
                <span aria-hidden="true">⇅</span>
                <h4>Nenhuma movimentação encontrada</h4>
                <p>
                  {data.movements.length
                    ? "Ajuste os filtros para visualizar outros registros."
                    : "As entradas e saídas confirmadas aparecerão aqui."}
                </p>
                {data.movements.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setHistorySearch("");
                      setHistoryType("all");
                      setHistoryPeriod("all");
                    }}
                  >
                    Limpar filtros
                  </button>
                )}
              </div>
            )}
          </div>
          {filteredMovements.length > pageSize && (
            <footer className="stock-history-pagination">
              <span>
                Exibindo {(historyPage - 1) * pageSize + 1}–
                {Math.min(historyPage * pageSize, filteredMovements.length)} de{" "}
                {filteredMovements.length}
              </span>
              <div>
                <button
                  type="button"
                  onClick={() =>
                    setHistoryPage((page) => Math.max(1, page - 1))
                  }
                  disabled={historyPage === 1}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setHistoryPage((page) => Math.min(historyPages, page + 1))
                  }
                  disabled={historyPage === historyPages}
                >
                  Próxima
                </button>
              </div>
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}
function Sales({ data, report }: { data: Snapshot; report: boolean }) {
  const total = data.sales.reduce((n, x) => n + x.total, 0),
    ticket = data.sales.length ? total / data.sales.length : 0;
  const methods = Object.entries(
    data.sales.reduce<Record<string, number>>((a, x) => {
      a[x.paymentMethod] = (a[x.paymentMethod] || 0) + x.total;
      return a;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  return (
    <>
      {report && (
        <section className="tenant-kpis">
          <Kpi
            label="Faturamento registrado"
            value={money.format(total)}
            detail={`${data.sales.length} vendas`}
          />
          <Kpi
            label="Ticket médio"
            value={money.format(ticket)}
            detail="Média por venda"
          />
          {methods.slice(0, 2).map(([label, value]) => (
            <Kpi
              label={label}
              value={money.format(value)}
              detail="Forma de pagamento"
              key={label}
            />
          ))}
        </section>
      )}
      <section className="tenant-panel tenant-table">
        <header>
          <h2>{report ? "Relatório de vendas" : "Histórico de vendas"}</h2>
          <span>{data.sales.length}</span>
        </header>
        <SalesTable rows={data.sales} />
      </section>
    </>
  );
}
function SalesTable({ rows }: { rows: Sale[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Venda</th>
            <th>Cliente</th>
            <th>Vendedor</th>
            <th>Pagamento</th>
            <th>Total</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.id}>
              <td>{x.saleNumber}</td>
              <td>{x.customer}</td>
              <td>{x.seller}</td>
              <td>{x.paymentMethod}</td>
              <td>
                <strong>{money.format(x.total)}</strong>
              </td>
              <td>{dateTime(x.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <Empty text="Nenhuma venda registrada." />}
    </div>
  );
}
function Kpi({
  label,
  value,
  detail,
  alert = false,
}: {
  label: string;
  value: string;
  detail: string;
  alert?: boolean;
}) {
  return (
    <article className={alert ? "alert" : ""}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="tenant-empty">{text}</div>;
}

function SuiteListFilter({
  search,
  onSearch,
  status,
  onStatus,
  placeholder,
  options,
}: {
  search: string;
  onSearch: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
  placeholder: string;
  options: Array<[string, string]>;
}) {
  return (
    <div className="tenant-toolbar suite-list-filter" role="search">
      <label>
        <span>Buscar</span>
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={placeholder}
        />
      </label>
      {options.length > 0 && (
        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => onStatus(event.target.value)}
          >
            <option value="">Todos</option>
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {(search || status) && (
        <button
          type="button"
          onClick={() => {
            onSearch("");
            onStatus("");
          }}
        >
          Limpar filtros
        </button>
      )}
    </div>
  );
}
function date(value: string | null) {
  return value
    ? new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR", { timeZone: tenantTimeZone() })
    : "—";
}
function dateTime(value: string) {
  return new Date(value).toLocaleString("pt-BR", { timeZone: tenantTimeZone() });
}
function shortDate(value?: string | null) {
  return value
    ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "UTC" })
    : "—";
}
function purchaseStatus(value: string) {
  return (
    (
      {
        draft: "Rascunho",
        ordered: "Enviado",
        partially_received: "Parcial",
        received: "Recebido",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[value] || value
  );
}
function financeStatus(value: string) {
  return (
    (
      {
        open: "Em aberto",
        partial: "Parcial",
        paid: "Liquidado",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[value] || value
  );
}
function inventoryEvent(value: string) {
  return (
    (
      {
        initial: "Saldo inicial",
        entry: "Entrada manual",
        exit: "Saída manual",
        sale: "Venda",
        purchase_receipt: "Recebimento de compra",
        transfer_in: "Transferência recebida",
        transfer_out: "Transferência enviada",
        count_adjustment: "Ajuste de contagem",
      } as Record<string, string>
    )[value] || value
  );
}
function inventoryCountStatus(value: string) {
  return (
    (
      {
        draft: "Em andamento",
        completed: "Concluída",
        cancelled: "Cancelada",
      } as Record<string, string>
    )[value] || value
  );
}
function numberValue(value: number) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 }).format(
    value,
  );
}
function sameLocalDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
function stockCsvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
function formatDocument(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11)
    return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  if (digits.length === 14)
    return digits.replace(
      /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
      "$1.$2.$3/$4-$5",
    );
  return value || "—";
}
function formatPhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11)
    return digits.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
  if (digits.length === 10)
    return digits.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3");
  return value || "—";
}
function actionLabel(value: string) {
  return (
    (
      {
        "customer.created": "Cliente criado",
        "customer.updated": "Cliente atualizado",
        "customer.status_changed": "Status do cliente alterado",
        "category.created": "Categoria criada",
        "category.updated": "Categoria atualizada",
        "category.status_changed": "Status da categoria alterado",
        "supplier.created": "Fornecedor criado",
        "supplier.updated": "Fornecedor atualizado",
        "supplier.status_changed": "Status do fornecedor alterado",
        "purchase_order.created": "Pedido de compra criado",
        "purchase_order.submitted": "Pedido enviado",
        "purchase_order.received": "Compra recebida",
        "purchase_order.cancelled": "Pedido cancelado",
        "financial_title.created": "Título criado",
        "financial_title.settled": "Título liquidado",
        "financial_title.cancelled": "Título cancelado",
        "warehouse.created": "Depósito criado",
        "warehouse.status_changed": "Status do depósito alterado",
        "inventory_count.created": "Contagem aberta",
        "inventory_count.completed": "Contagem concluída",
        "stock_transfer.completed": "Transferência concluída",
        "tenant_role.created": "Perfil criado",
        "tenant_role.updated": "Perfil atualizado",
        "organization_invite.created": "Convite criado",
        "organization_invite.rotated": "Convite rotacionado",
        "organization_invite.revoked": "Convite revogado",
        "organization_invite.accepted": "Convite aceito",
        "membership.updated": "Acesso de usuário atualizado",
        "branch.created": "Filial criada",
        "branch.updated": "Filial atualizada",
        "branch.status_changed": "Status da filial alterado",
        "branch.selected": "Filial ativa selecionada",
        "tenant_settings.updated": "Configurações atualizadas",
        "sales_order.created": "Orçamento criado",
        "sales_order.approved": "Pedido aprovado",
        "sales_order.completed": "Pedido concluído",
        "sales_order.cancelled": "Pedido cancelado",
      } as Record<string, string>
    )[value] || value.replaceAll("_", " ").replaceAll(".", " · ")
  );
}
function entityLabel(value: string) {
  return (
    (
      {
        customer: "Cliente",
        category: "Categoria",
        supplier: "Fornecedor",
        purchase_order: "Pedido de compra",
        financial_title: "Título financeiro",
        warehouse: "Depósito",
        inventory_count: "Contagem",
        stock_transfer: "Transferência",
        tenant_role: "Perfil de acesso",
        organization_invite: "Convite",
        membership: "Membership",
        branch: "Filial",
        tenant_settings: "Configurações",
        sales_order: "Orçamento/pedido",
      } as Record<string, string>
    )[value] || value.replaceAll("_", " ")
  );
}
function fieldLabel(value: string) {
  return (
    (
      {
        name: "Nome",
        slug: "Identificador",
        active: "Ativo",
        status: "Status",
        document: "Documento",
        amount: "Valor",
        paidAmount: "Valor liquidado",
        dueAt: "Vencimento",
        number: "Número",
        supplierId: "Fornecedor",
        warehouseId: "Depósito",
        fromWarehouseId: "Origem",
        toWarehouseId: "Destino",
        itemCount: "Quantidade de itens",
        adjustments: "Ajustes",
        items: "Itens",
      } as Record<string, string>
    )[value] ||
    value
      .replace(/([A-Z])/g, " $1")
      .replaceAll("_", " ")
      .trim()
  );
}
function auditValue(value: unknown) {
  if (value === null || value === undefined || value === "")
    return "Não informado";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") return numberValue(value);
  if (Array.isArray(value)) return `${value.length} item(ns)`;
  if (typeof value === "object") return "Dados estruturados registrados";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return dateTime(text);
  return text;
}
function auditChanges(event: AuditEvent) {
  const before = event.beforeData || {},
    after = event.afterData || {},
    keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((key) => ({
    key,
    before: Object.prototype.hasOwnProperty.call(before, key)
      ? before[key]
      : undefined,
    after: after[key],
  }));
}
function roleDisplay(value: string) {
  return (
    (
      {
        owner: "Proprietário",
        admin: "Administrador",
        sales: "Vendas e atendimento",
        stock: "Estoque e compras",
        finance: "Financeiro",
        viewer: "Consulta",
      } as Record<string, string>
    )[value] || value
  );
}
function inviteStatus(value: string) {
  return (
    (
      {
        pending: "Pendente",
        accepted: "Aceito",
        revoked: "Revogado",
        expired: "Expirado",
      } as Record<string, string>
    )[value] || value
  );
}
function taxRegimeLabel(value?: string | null) {
  return (
    (
      {
        simples_nacional: "Simples Nacional",
        lucro_presumido: "Lucro Presumido",
        lucro_real: "Lucro Real",
        mei: "MEI",
      } as Record<string, string>
    )[value || ""] || "Não definido"
  );
}
function orderStatus(value: string) {
  return (
    (
      {
        draft: "Rascunho",
        approved: "Aprovado",
        completed: "Concluído",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[value] || value
  );
}
function salesChannelLabel(value: string) {
  return (
    (
      {
        direct: "Venda direta",
        store: "Loja / balcão",
        phone: "Telefone",
        whatsapp: "WhatsApp",
        email: "E-mail",
        field: "Venda externa",
        ecommerce: "E-commerce",
        marketplace: "Marketplace",
      } as Record<string, string>
    )[value] || value
  );
}
function priorityLabel(value: string) {
  return (
    (
      {
        low: "Baixa",
        normal: "Normal",
        high: "Alta",
        urgent: "Urgente",
      } as Record<string, string>
    )[value] || value
  );
}
function deliveryTypeLabel(value: string) {
  return (
    (
      {
        pickup: "Retirada",
        delivery: "Entrega própria",
        carrier: "Transportadora",
      } as Record<string, string>
    )[value] || value
  );
}
function serviceStatus(value: string) {
  return (
    (
      {
        open: "Aberta",
        in_progress: "Em execução",
        completed: "Concluída",
        cancelled: "Cancelada",
      } as Record<string, string>
    )[value] || value
  );
}
