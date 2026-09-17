"use client";

import { tenantTimeZone } from "@/lib/client-timezone";
import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { gsap } from "gsap";
import { PdvAccessibleModal } from "@/components/erp/pdv-accessible-modal";
import { PdvAdminDialog } from "@/components/erp/pdv-admin-dialog";
import { PdvApprovalDialog } from "@/components/erp/pdv-approval-dialog";
import { PdvOfflineWorkspace } from "@/components/erp/pdv-offline-workspace";
import { isPdvPaymentIntentCaptured, isPdvPaymentIntentLocked, parsePdvOperatorPaymentIntent, PdvPaymentIntentControl, posPaymentIntentContextSignature, type PdvOperatorPaymentIntent } from "@/components/erp/pdv-payment-intent-control";
import { buildPosDiscountApproval } from "@/lib/erp/pos-discount-approval";
import { calculatePosReturnRefundCents } from "@/lib/erp/pos-returns";
import { POS_SETTINGS_REQUIRED, requirePosSettings } from "@/lib/erp/pos-settings";
import {
  createPosScannerCaptureConfiguration,
  PosScannerCaptureCore,
  type PosScannerCaptureResult,
  type PosScannerCaptureTarget,
  type PosScannerProcessingDecision,
} from "@/lib/erp/pos-scanner-capture";

type Product = {
  id: number;
  name: string;
  sku: string;
  barcode?: string | null;
  gtin?: string | null;
  type: string;
  unit: string;
  category?: string;
  imageUrl?: string | null;
  priceCents: number;
  stock: number | null;
  soldIndividually: boolean;
  resolvedVariationId?: number | null;
  variations?: Array<{ id: number; sku: string; gtin?: string | null; attributes?: unknown; stock: number | null; priceCents: number }>;
};
type Customer = { id: number; name: string; tradeName?: string | null; document: string };
type CartLine = { product: Product; quantity: number; discountCents: number; scanData?: Record<string, unknown> };
type PaymentMethod = "cash" | "pix" | "credit" | "debit" | "voucher" | "store_credit";
type FulfillmentMode = "on_site" | "pickup" | "delivery";
type ManualPaymentReference = { id: string; approvalId: string; status: string; signature: string; expiresAt: string; recovered?: boolean };
type Payment = { key: string; method: PaymentMethod; amount: string; tendered: string; needsChange: boolean; proofMode: "intent" | "manual"; connectorId: string; terminalId: string; installments: string; electronicIntent: PdvOperatorPaymentIntent | null; provider: string; reference: string; confirmationOccurredAt: string; confirmationReason: string; manualReference: ManualPaymentReference | null; valueAccountId: string; valueUnits: string; giftCode: string; giftPin: string; giftQrToken: string };
type ValueAccount = { id: string; kind: "loyalty_points" | "cashback" | "store_credit"; unit: "points" | "cents"; label: string; balanceUnits: string; reservedUnits: string; availableUnits: string; expiresAt: string | null; program: { name: string; redeemCentsPerUnit: number } | null };
type PromotionQuote = {
  requestSignature: string;
  quoteHash: string;
  promotionId: string | null;
  promotionName: string | null;
  couponLastFour: string | null;
  subtotalCents: number;
  manualDiscountCents: number;
  manualDiscountBasisPoints: number;
  discountApprovalRequired: boolean;
  discountApprovalId: string | null;
  promotionDiscountCents: number;
  surchargeCents: number;
  totalCents: number;
  evaluatedAt: string;
};
type PaymentPlanSlot = { paymentIndex: number; method: PaymentMethod; amountCents: number; installments: number; proofKind: "cash" | "value" | "intent" | "manual"; connectorId: string | null; provider: string | null };
type PaymentPlan = { id: string; saleDraftId: string; draftRevision: number; quoteHash: string; totalCents: number; currency: string; state: "quoted" | "active" | "expired" | "superseded" | "consumed"; version: number; evaluatedAt: string; expiresAt: string; activatedAt: string | null; consumedAt: string | null; slots: PaymentPlanSlot[] };
type Register = {
  id: number;
  code: string;
  name: string;
  access: { active: boolean; canOpen: boolean; canClose: boolean; canSell: boolean; canSupply: boolean; canWithdraw: boolean; canCancel: boolean; canRefund: boolean; canReprint: boolean; canManualPayment: boolean; canTransferHeld: boolean; maxDiscountBasisPoints: number };
  terminals: Array<{ id: string; code: string; name: string; status: string; appVersion?: string | null; lastSeenAt?: string | null; devices: Array<{ id: string; type: string; name: string; status: string }> }>;
};
type PdvData = {
  branch: { id: number; code: string; name: string };
  operator: { id: number; name: string };
  registers: Register[];
  session: null | { id: number; number: string; registerId: number; terminalId?: string | null; status: "open" | "suspended"; version: number; suspendedAt?: string | null; suspendedReason?: string | null; openedAt: string; openingAmountCents: number; register: Register; events: Array<{ id: number; type: string; amountCents: number; description: string; createdAt: string }> };
  products: Product[];
  customers: Customer[];
  settings: { defaultPaymentMethod: string; defaultCustomerName: string; requireCustomer: boolean; maxDiscountPercent: number; receiptFooter?: string | null; currency: string; locale: string };
  heldSales: Array<{ id: string; revision: number; label?: string | null; customerId?: number | null; notes?: string | null; fulfillmentMode?: FulfillmentMode; discountCents: number; surchargeCents: number; items: Array<{ productId: number; variationId?: number | null; quantity: number; unitPriceCents: number; discountCents: number; scanData?: Record<string, unknown>; product?: Omit<Product, "priceCents" | "stock"> }> }>;
  recentSales: Array<{
    id: number;
    saleNumber: string;
    customer: string;
    status: string;
    totalCents: number;
    changeCents: number;
    createdAt: string;
    payments: Array<{ id: number; type: string; method: string; status: string; amountCents: number }>;
    items: Array<{ id: number; productName: string; quantity: number; returnedQuantity?: number; returnedCents?: number; unitPriceCents: number; discountCents: number; totalCents: number }>;
  }>;
  connectors: Array<{ id: string; registerId: number | null; type: string; provider: string; mode: string; settings?: { methods?: string[] } | null; lastHealthOk?: boolean | null }>;
  staffAccess?: Array<{ id: number; displayName: string; email: string; role: { key: string; name: string }; posRegisterAccesses: Array<Register["access"] & { registerId: number; validFrom?: string | null; validUntil?: string | null }> }> | null;
  closingTenders: Array<{ method: PaymentMethod; provider: string }>;
};
type RecoveryDraft = PdvData["heldSales"][number] & { status: string; customer?: Customer | null; updatedAt?: string };
type RecoveryManualPaymentReference = { id: string; paymentPlanId: string; saleDraftId: string; quoteHash: string; paymentIndex: number; method: PaymentMethod; amountCents: number; installments: number; provider: string; referenceLastFour: string; occurredAt: string; status: string; approvalId: string; expiresAt: string };
type DraftRecovery = {
  loading: boolean;
  mode: "none" | "restore" | "blocked" | "error";
  drafts: RecoveryDraft[];
  intents: PdvOperatorPaymentIntent[];
  manualReferences: RecoveryManualPaymentReference[];
  paymentPlans: PaymentPlan[];
  issues: Array<{ code: string; draftId?: string; intentId?: string; manualReferenceId?: string }>;
};
type RecoveryFeedback = { kind: "success" | "warning" | "error"; title: string; text: string; at: number };
type HeldTransferTarget = { sessionId: number; sessionNumber: string; registerId: number; registerCode: string; registerName: string; operatorProfileId: number; operatorName: string };
type SessionHandoff = { id: string; sessionId: number; branchId: number; registerId: number; fromOperatorProfileId: number; toOperatorProfileId: number; state: string; reason: string; expiresAt: string; revision: number; transferredHeldSaleCount: number; createdAt: string; resolvedAt: string | null };
type SessionLifecycleData = {
  session: null | { id: number; number: string; registerId: number; status: string; version: number; suspendedAt?: string | null; suspendedReason?: string | null; register: { id: number; code: string; name: string }; handoffs: SessionHandoff[] };
  incoming: Array<SessionHandoff & { session: { id: number; number: string; version: number; status: string }; register: { id: number; code: string; name: string }; fromOperatorProfile: { id: number; displayName: string } }>;
  targets: Array<{ id: number; displayName: string }>;
};
type PosOrderLookup = {
  order: {
    id: number;
    number: string;
    status: string;
    customer: Customer | null;
    customerId: number | null;
    customerName: string;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    paymentMethod: PaymentMethod | null;
    paymentInstallments: number;
    notes: string | null;
    items: Array<{ id: number; productId: number; variationId: number | null; quantity: number; listPriceCents: number; unitPriceCents: number; discountCents: number; totalCents: number; product: Product | null }>;
  };
  eligibility: { eligible: boolean; code: string; reason?: string };
  activeClaim: { busy: boolean; leaseExpiresAt: string } | null;
  convertedSale: { id: number; saleNumber: string; status: string; totalCents: number; createdAt: string } | null;
};
type ActiveOrderClaim = { id: string; salesOrderId: number; state: string; version: number; leaseExpiresAt: string; order: { id: number; number: string; status: string } };
type CatalogView = "grid" | "list" | "compact";
type CheckoutStep = "items" | "payment";

const paymentLabels: Record<string, string> = {
  cash: "Dinheiro",
  pix: "Pix",
  credit: "Crédito",
  debit: "Débito",
  voucher: "Voucher",
  store_credit: "Crédito da loja",
  other: "Outro",
};
const paymentMethods: PaymentMethod[] = ["cash", "pix", "credit", "debit", "voucher", "store_credit"];
const posScannerConfiguration = createPosScannerCaptureConfiguration({
  prefixKeys: ["F9"],
  suffixKeys: ["Enter"],
  interKeyTimeoutMs: 120,
  duplicateWindowMs: 250,
  minimumLength: 3,
  maximumLength: 512,
  queueLimit: 32,
  resultLimit: 64,
});

export function PdvWorkspace() {
  const [data, setData] = useState<PdvData | null>(null);
  const [sessionLifecycle, setSessionLifecycle] = useState<SessionLifecycleData>({ session: null, incoming: [], targets: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [checkoutStep, setCheckoutStep] = useState<CheckoutStep>("items");
  const [expandedLineKey, setExpandedLineKey] = useState<string | null>(null);
  const [pdvMenuCollapsed, setPdvMenuCollapsed] = useState(false);
  const [pdvMenuOpen, setPdvMenuOpen] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [quickTool, setQuickTool] = useState<"products" | "customer" | "order" | "scanner" | null>("products");
  const [catalogView, setCatalogView] = useState<CatalogView>("grid");
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>("on_site");
  const [cashOperation, setCashOperation] = useState<"supply" | "withdrawal">("withdrawal");
  const [online, setOnline] = useState(true);
  const [query, setQuery] = useState("");
  const [saleQuery, setSaleQuery] = useState("");
  const [saleResults, setSaleResults] = useState<PdvData["recentSales"]>([]);
  const [saleLoading, setSaleLoading] = useState(false);
  const [saleSearchError, setSaleSearchError] = useState("");
  const [saleNextCursor, setSaleNextCursor] = useState<string | null>(null);
  const saleRequest = useRef<AbortController | null>(null);
  const [variationProduct, setVariationProduct] = useState<Product | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "available" | "low">("all");
  const [mobileCamera, setMobileCamera] = useState(false);
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [catalogNextCursor, setCatalogNextCursor] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerNextCursor, setCustomerNextCursor] = useState<string | null>(null);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerSearchError, setCustomerSearchError] = useState("");
  const [scan, setScan] = useState("");
  const [scanQueueDepth, setScanQueueDepth] = useState(0);
  const [scanQueueProcessing, setScanQueueProcessing] = useState(false);
  const [scanQueueError, setScanQueueError] = useState("");
  const [lastScanResult, setLastScanResult] = useState<PosScannerCaptureResult | null>(null);
  const [orderLookupInput, setOrderLookupInput] = useState("");
  const [orderLookup, setOrderLookup] = useState<PosOrderLookup | null>(null);
  const [activeOrderClaim, setActiveOrderClaim] = useState<ActiveOrderClaim | null>(null);
  const [orderClaimError, setOrderClaimError] = useState("");
  const [orderClaimClock, setOrderClaimClock] = useState(0);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [customerId, setCustomerId] = useState("");
  const [discount, setDiscount] = useState("0,00");
  const [couponCode, setCouponCode] = useState("");
  const [couponQrToken, setCouponQrToken] = useState("");
  const [valueAccounts, setValueAccounts] = useState<ValueAccount[]>([]);
  const [promotionQuote, setPromotionQuote] = useState<PromotionQuote | null>(null);
  const [paymentPlan, setPaymentPlan] = useState<PaymentPlan | null>(null);
  const [discountApproval, setDiscountApproval] = useState<{ id: string; contextSignature: string } | null>(null);
  const [discountApprovalReason, setDiscountApprovalReason] = useState("");
  const [notes, setNotes] = useState("");
  const [noteExpanded, setNoteExpanded] = useState(false);
  const [payments, setPayments] = useState<Payment[]>(() => [newPayment("cash")]);
  const [draftRecovery, setDraftRecovery] = useState<DraftRecovery>({ loading: true, mode: "none", drafts: [], intents: [], manualReferences: [], paymentPlans: [], issues: [] });
  const [persistedDraft, setPersistedDraft] = useState<{ id: string; revision: number; signature: string; source: "draft" | "held" } | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftSaveError, setDraftSaveError] = useState("");
  const [recoveryFeedback, setRecoveryFeedback] = useState<RecoveryFeedback | null>(null);
  const [heartbeatTerminalId, setHeartbeatTerminalId] = useState<string | null>(null);
  const [activeHeldSaleId, setActiveHeldSaleId] = useState<string | null>(null);
  const [heldTransfer, setHeldTransfer] = useState<PdvData["heldSales"][number] | null>(null);
  const [heldTransferTargets, setHeldTransferTargets] = useState<HeldTransferTarget[]>([]);
  const [operation, setOperation] = useState<"cash" | "close" | "camera" | "receipt" | "access" | "approval" | "configuration" | "offline" | "recent" | "recovery" | "more" | "cancel" | "return" | "customer" | "held-transfer" | "shift-lifecycle" | "variation" | null>(null);
  const [lastSale, setLastSale] = useState<PdvData["recentSales"][number] | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const quickbarContentRef = useRef<HTMLDivElement>(null);
  const scanCaptureSequence = useRef(0);
  const scanInputRevision = useRef(0);
  const [scannerCapture] = useState(() => new PosScannerCaptureCore(posScannerConfiguration, "hid"));
  const scanQueueDraining = useRef(false);
  const scanQueueRetryTimer = useRef<number | null>(null);
  const scanCodeProcessor = useRef<(code: string) => Promise<PosScannerProcessingDecision>>(async () => ({ accepted: false, reasonCode: "processor_error" }));
  const scanQueueDrain = useRef<() => void>(() => undefined);
  const cartRef = useRef<Record<string, CartLine>>({});
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const cameraDecoderControls = useRef<{ stop(): void } | null>(null);
  const cameraDecoderCancel = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestLock = useRef(false);
  const submitting = useRef(false);
  const authenticationExpired = useRef(false);
  const defaultPaymentInitialized = useRef(false);
  const saleIdempotencyKey = useRef(crypto.randomUUID());
  const discountApprovalAttempt = useRef({ signature: "", key: crypto.randomUUID() });
  const manualPaymentAttempts = useRef<Record<string, { signature: string; key: string }>>({});
  const paymentPlanActivationAttempt = useRef({ signature: "", key: crypto.randomUUID() });
  const holdAttempt = useRef({ signature: "", key: crypto.randomUUID(), label: "" });
  const discardIdempotencyKeys = useRef<Record<string, string>>({});
  const heldTransferAttempts = useRef<Record<string, { signature: string; key: string }>>({});
  const sessionLifecycleAttempts = useRef<Record<string, { signature: string; key: string }>>({});
  const noticeTimer = useRef<number | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const customerRequest = useRef<AbortController | null>(null);
  const recoverySession = useRef<number | null>(null);
  const draftSaveTimer = useRef<number | null>(null);
  const draftSaveRequest = useRef<AbortController | null>(null);
  const draftSaveFailedSignature = useRef("");
  const draftSaveAttempts = useRef<Record<string, string>>({});
  const recoveryCancelAttempts = useRef<Record<string, string>>({});
  const recoveryRetryAttempts = useRef<Record<string, string>>({});
  const recoveryDiscardAttempts = useRef<Record<string, string>>({});
  const recoveryManualRevokeAttempts = useRef<Record<string, { reason: string; key: string }>>({});
  const orderClaimAttempt = useRef<{ orderId: number; key: string } | null>(null);
  const orderClaimRenewAttempts = useRef<Record<number, string>>({});
  const orderClaimRenewBlockedVersion = useRef<number | null>(null);
  const orderClaimReleaseAttempts = useRef<Record<number, string>>({});

  useEffect(() => {
    if (!data || !workspaceRef.current) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(Array.from(workspaceRef.current?.children || []).slice(0, 4), { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: .28, stagger: .035, ease: "power2.out", clearProps: "all" });
    });
    return () => media.revert();
  }, [data]);

  useEffect(() => {
    if (!quickTool || !quickbarContentRef.current) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(quickbarContentRef.current, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: .22, ease: "power2.out", clearProps: "all" });
    });
    return () => media.revert();
  }, [quickTool]);

  function showNotice(message: string, duration = 3500) {
    if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => {
      setNotice("");
      noticeTimer.current = null;
    }, duration);
  }

  function handleUnauthorized(response: Response) {
    if (response.status !== 401) return false;
    if (!authenticationExpired.current) {
      authenticationExpired.current = true;
      draftSaveRequest.current?.abort();
      setDraftSaveError("Sua sessão expirou. Entre novamente para continuar com o carrinho protegido.");
      setError("Sua sessão expirou. Redirecionando para uma nova autenticação…");
      window.setTimeout(() => window.location.replace("/login?next=%2Ferp%2Fpdv&reason=session-expired"), 700);
    }
    return true;
  }

  function scheduleScanQueueDrain() {
    if (scanQueueDraining.current || scanQueueRetryTimer.current != null) return;
    scanQueueRetryTimer.current = window.setTimeout(() => {
      scanQueueRetryTimer.current = null;
      scanQueueDrain.current();
    }, requestLock.current ? 50 : 0);
  }

  function reflectScannerResult(result: PosScannerCaptureResult) {
    setLastScanResult(result);
    if (result.status === "duplicate") {
      showNotice("Reenvio físico do leitor ignorado; a captura já foi recebida.", 1800);
      return;
    }
    if (result.status === "rejected") setScanQueueError(posScannerResultMessage(result));
  }

  function enqueueScanCode(code: string, captureId: string) {
    const result = scannerCapture.offerCode({
      captureId,
      code,
      atMs: performance.now(),
      context: { operationActive: false, wedgeSessionActive: true, target: { tagName: "INPUT", purpose: "scanner" } },
    });
    setScanQueueDepth(result.queueDepth);
    if (result.result) reflectScannerResult(result.result);
    if (!result.queued) return false;
    setScanQueueError("");
    scheduleScanQueueDrain();
    return true;
  }

  async function processScanQueue() {
    if (scanQueueDraining.current) return;
    if (requestLock.current) {
      scheduleScanQueueDrain();
      return;
    }

    scanQueueDraining.current = true;
    requestLock.current = true;
    setScanQueueProcessing(true);
    setBusy(true);
    try {
      const completed = await scannerCapture.drain(async (item) => {
        setScanQueueDepth(scannerCapture.queueDepth);
        return scanCodeProcessor.current(item.code);
      }, () => performance.now());
      completed.forEach(reflectScannerResult);
    } finally {
      requestLock.current = false;
      scanQueueDraining.current = false;
      setScanQueueDepth(scannerCapture.queueDepth);
      setScanQueueProcessing(false);
      setBusy(false);
      if (scannerCapture.queueDepth > 0) scheduleScanQueueDrain();
    }
  }

  scanQueueDrain.current = () => void processScanQueue();

  function syncSinglePayment(nextTotalCents: number) {
    setPayments((current) => {
      if (current.length !== 1) return current;
      const payment = current[0];
      const previousAmount = parseMoney(payment.amount);
      const nextAmount = formatInput(nextTotalCents);
      if (isPdvPaymentIntentLocked(payment.electronicIntent) && previousAmount !== nextTotalCents) return current;
      const tendered = payment.method === "cash" && parseMoney(payment.tendered) <= previousAmount ? nextAmount : payment.tendered;
      return [{ ...payment, amount: nextAmount, tendered }];
    });
  }

  function replaceCart(next: Record<string, CartLine>, orderDiscountCents = parseMoney(discount)) {
    cartRef.current = next;
    setCart(next);
    setPromotionQuote(null);
    setPaymentPlan(null);
    setDiscountApproval(null);
    discountApprovalAttempt.current = { signature: "", key: crypto.randomUUID() };
    const nextSubtotal = Object.values(next).reduce((sum, line) => sum + Math.round(line.product.priceCents * line.quantity) - line.discountCents, 0);
    syncSinglePayment(Math.max(0, nextSubtotal - orderDiscountCents));
  }

  function defaultPaymentMethod() {
    return supportedPaymentMethod(data?.settings.defaultPaymentMethod);
  }

  function resetSale(method = defaultPaymentMethod()) {
    if (draftSaveTimer.current != null) window.clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = null;
    draftSaveRequest.current?.abort();
    draftSaveRequest.current = null;
    replaceCart({});
    setCustomerId("");
    setSelectedCustomer(null);
    setDiscount("0,00");
    setCouponCode("");
    setCouponQrToken("");
    setValueAccounts([]);
    setPromotionQuote(null);
    setPaymentPlan(null);
    setDiscountApproval(null);
    setDiscountApprovalReason("");
    setNotes("");
    setNoteExpanded(false);
    setCheckoutStep("items");
    setExpandedLineKey(null);
    setFulfillmentMode("on_site");
    setPayments([newPayment(method)]);
    setActiveHeldSaleId(null);
    setActiveOrderClaim(null);
    setOrderClaimError("");
    setPersistedDraft(null);
    draftSaveFailedSignature.current = "";
    setDraftSaving(false);
    setDraftSaveError("");
    orderClaimAttempt.current = null;
    orderClaimRenewAttempts.current = {};
    orderClaimRenewBlockedVersion.current = null;
    orderClaimReleaseAttempts.current = {};
    saleIdempotencyKey.current = crypto.randomUUID();
    paymentPlanActivationAttempt.current = { signature: "", key: crypto.randomUUID() };
    holdAttempt.current = { signature: "", key: crypto.randomUUID(), label: "" };
  }

  async function load() {
    setError("");
    try {
      const [response, lifecycleResponse] = await Promise.all([
        fetch("/api/erp/pdv", { cache: "no-store" }),
        fetch("/api/erp/pdv/session-lifecycle", { cache: "no-store" }),
      ]);
      const [body, lifecycleBody] = await Promise.all([responseBody(response), responseBody(lifecycleResponse)]);
      if (!response.ok || !lifecycleResponse.ok) {
        setError(stringValue(response.ok ? lifecycleBody.error : body.error) || "Não foi possível carregar o PDV e a posse do turno.");
        return;
      }
      const payload = body as Omit<PdvData, "settings"> & { settings?: PdvData["settings"] | null };
      if (!payload.settings) {
        setData(null);
        setError(POS_SETTINGS_REQUIRED);
        return;
      }
      const nextData: PdvData = { ...payload, settings: requirePosSettings(payload.settings) };
      setData(nextData);
      setCatalogProducts(nextData.products);
      setCustomerResults(nextData.customers);
      setCatalogNextCursor(null);
      setCustomerNextCursor(null);
      setSessionLifecycle(lifecycleBody as SessionLifecycleData);
      if (nextData.session?.status === "open" && recoverySession.current !== nextData.session.id) {
        recoverySession.current = nextData.session.id;
        await loadDraftRecovery(nextData);
      } else if (!nextData.session) {
        recoverySession.current = null;
        setDraftRecovery({ loading: false, mode: "none", drafts: [], intents: [], manualReferences: [], paymentPlans: [], issues: [] });
      }
    } catch {
      setError("Não foi possível conectar ao PDV. Verifique a rede e tente novamente.");
    }
  }

  async function loadDraftRecovery(nextData: PdvData, notify = true): Promise<Omit<RecoveryFeedback, "at">> {
    const session = nextData.session;
    if (!session || session.status !== "open") return { kind: "success", title: "Nenhuma recuperação necessária", text: "Não há turno aberto para verificar." };
    setDraftRecovery(current => ({ ...current, loading: true }));
    try {
      const response = await fetch(`/api/erp/pdv/payment-intents?recovery=1&sessionId=${session.id}`, { cache: "no-store" });
      const body = await responseBody(response), rawRecovery = isRecord(body.recovery) ? body.recovery : null;
      const drafts = Array.isArray(body.drafts) ? body.drafts.filter(isRecord) as RecoveryDraft[] : [];
      const intents = Array.isArray(body.intents) ? body.intents.map(parsePdvOperatorPaymentIntent).filter((intent): intent is PdvOperatorPaymentIntent => Boolean(intent)) : [];
      const manualReferences = Array.isArray(body.manualReferences) ? body.manualReferences.filter(isRecoveryManualPaymentReference) : [];
      const paymentPlans = Array.isArray(body.paymentPlans) ? body.paymentPlans.map(parsePaymentPlan).filter((plan): plan is PaymentPlan => Boolean(plan)) : [];
      if (!response.ok || !rawRecovery) throw new Error(stringValue(body.error) || "Não foi possível consultar a recuperação server-side.");
      const mode = stringValue(rawRecovery.mode);
      const issues = Array.isArray(rawRecovery.issues) ? rawRecovery.issues.filter(isRecord).map(issue => ({ code: stringValue(issue.code), draftId: nullableString(issue.draftId) || undefined, intentId: nullableString(issue.intentId) || undefined, manualReferenceId: nullableString(issue.manualReferenceId) || undefined })) : [];
      if (mode === "none") {
        setDraftRecovery({ loading: false, mode: "none", drafts, intents, manualReferences, paymentPlans, issues });
        return { kind: "success", title: "Estado atualizado", text: "Nenhum rascunho pendente ou estado financeiro órfão foi encontrado." };
      }
      if (mode !== "restore") {
        setDraftRecovery({ loading: false, mode: "blocked", drafts, intents, manualReferences, paymentPlans, issues });
        setDraftSaveError("A recuperação exige reconciliação explícita; nenhum carrinho foi reconstruído por aproximação.");
        return { kind: "warning", title: "Ação necessária", text: "Existem estados que precisam de reconciliação antes do checkout." };
      }
      const draftId = stringValue(rawRecovery.draftId), draft = drafts.find(candidate => candidate.id === draftId);
      const intentIds = Array.isArray(rawRecovery.paymentIntentIds) ? rawRecovery.paymentIntentIds.map(stringValue) : [];
      const manualReferenceIds = Array.isArray(rawRecovery.manualReferenceIds) ? rawRecovery.manualReferenceIds.map(stringValue) : [];
      const linkedIntents = intentIds.map(id => intents.find(intent => intent.id === id)).filter((intent): intent is PdvOperatorPaymentIntent => Boolean(intent));
      const linkedManualReferences = manualReferenceIds.map(id => manualReferences.find(reference => reference.id === id)).filter((reference): reference is RecoveryManualPaymentReference => Boolean(reference));
      const linkedPaymentPlan = paymentPlans.find(plan => plan.saleDraftId === draftId && ["quoted", "active"].includes(plan.state)) ?? null;
      if (!draft || linkedIntents.length !== intentIds.length || linkedManualReferences.length !== manualReferenceIds.length || !restoreRecoveryDraft(nextData, draft, linkedIntents, linkedManualReferences, linkedPaymentPlan)) {
        setDraftRecovery({ loading: false, mode: "blocked", drafts, intents, manualReferences, paymentPlans, issues: [...issues, { code: "invalid_recovery_payload", draftId }] });
        setDraftSaveError("O payload persistido não pôde ser restaurado integralmente. O checkout permanece bloqueado.");
        return { kind: "warning", title: "Rascunho não confirmado", text: "O conteúdo persistido diverge do estado esperado e precisa ser revisado." };
      }
      await recoverOrderClaim(draft.id, session.id, draft, linkedIntents, linkedManualReferences);
      setDraftRecovery({ loading: false, mode: "restore", drafts, intents, manualReferences, paymentPlans, issues: [] });
      if (notify) showNotice(linkedIntents.length || linkedManualReferences.length ? "Rascunho e provas financeiras exatas recuperados do servidor." : "Rascunho recuperado do servidor.", 5000);
      return { kind: "success", title: "Rascunho recuperado", text: linkedIntents.length || linkedManualReferences.length ? "Carrinho e estados financeiros vinculados foram confirmados pelo servidor." : "O carrinho foi restaurado e está protegido no servidor." };
    } catch (cause) {
      setDraftRecovery({ loading: false, mode: "error", drafts: [], intents: [], manualReferences: [], paymentPlans: [], issues: [] });
      const text = cause instanceof Error ? cause.message : "Não foi possível recuperar o rascunho server-side.";
      setDraftSaveError(text);
      return { kind: "error", title: "Verificação não concluída", text };
    }
  }

  function restoreRecoveryDraft(nextData: PdvData, draft: RecoveryDraft, intents: PdvOperatorPaymentIntent[], manualReferences: RecoveryManualPaymentReference[], recoveredPaymentPlan: PaymentPlan | null) {
    const restored: Record<string, CartLine> = {};
    for (const item of draft.items) {
      const baseProduct = item.product || nextData.products.find(product => product.id === item.productId);
      if (!baseProduct) return false;
      const product = { ...baseProduct, resolvedVariationId: item.variationId, priceCents: item.unitPriceCents, stock: null } as Product;
      restored[cartKey(product)] = { product, quantity: product.soldIndividually ? 1 : item.quantity, discountCents: item.discountCents, scanData: item.scanData };
    }
    if (!Object.keys(restored).length) return false;
    saleIdempotencyKey.current = draft.id;
    defaultPaymentInitialized.current = true;
    setCustomerId(draft.customerId ? String(draft.customerId) : "");
    setSelectedCustomer(draft.customer || null);
    setDiscount(formatInput(draft.discountCents));
    setCouponCode("");
    setCouponQrToken("");
    setPromotionQuote(null);
    setDiscountApproval(null);
    setNotes(draft.notes || "");
    setNoteExpanded(Boolean(draft.notes));
    setFulfillmentMode(draft.fulfillmentMode || "on_site");
    const recoveredPayments = [
      ...intents.map(intent => ({ paymentIndex: intent.paymentIndex, payment: paymentFromRecoveredIntent(intent) })),
      ...manualReferences.map(reference => ({ paymentIndex: reference.paymentIndex, payment: paymentFromRecoveredManualReference(reference) })),
    ].sort((left, right) => left.paymentIndex - right.paymentIndex);
    if (recoveredPayments.some((item, index) => item.paymentIndex !== index)) return false;
    setPayments(recoveredPayments.length ? recoveredPayments.map(item => item.payment) : [newPayment(supportedPaymentMethod(nextData.settings.defaultPaymentMethod))]);
    replaceCart(restored, draft.discountCents);
    setPaymentPlan(recoveredPaymentPlan);
    setActiveHeldSaleId(null);
    const signature = recoveryDraftSignature(draft.id, nextData.session?.id || 0, draft.customerId ?? null, draft.notes || "", draft.fulfillmentMode || "on_site", draft.discountCents, draft.surchargeCents || 0, Object.values(restored));
    setPersistedDraft({ id: draft.id, revision: draft.revision, signature, source: "draft" });
    draftSaveFailedSignature.current = "";
    setDraftSaveError("");
    return true;
  }

  async function loadValueAccounts(nextCustomerId: string) {
    if (!data?.session || !nextCustomerId) { setValueAccounts([]); return; }
    try {
      const response = await fetch("/api/erp/pdv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "value.accounts", sessionId: data.session.id, customerId: Number(nextCustomerId) }), cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok || !Array.isArray(body.accounts)) throw new Error(stringValue(body.error) || "Não foi possível consultar os saldos do cliente.");
      setValueAccounts(body.accounts as ValueAccount[]);
    } catch (cause) {
      setValueAccounts([]);
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar os saldos do cliente.");
    }
  }

  async function loadCatalogPage(search: string, cursor: string | null = null) {
    const controller = new AbortController();
    catalogRequest.current?.abort();
    catalogRequest.current = controller;
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const params = new URLSearchParams({ resource: "products", q: search, limit: "24" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/erp/pdv?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await responseBody(response), page = isRecord(body.page) ? body.page : null;
      if (!response.ok || !Array.isArray(body.items) || !page) throw new Error(stringValue(body.error) || "Não foi possível consultar o catálogo.");
      const incoming = body.items as Product[];
      setCatalogProducts((current) => cursor ? mergeById(current, incoming) : incoming);
      setCatalogNextCursor(page.hasMore === true && typeof page.nextCursor === "string" ? page.nextCursor : null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setCatalogError(cause instanceof Error ? cause.message : "Não foi possível consultar o catálogo.");
    } finally {
      if (catalogRequest.current === controller) {
        catalogRequest.current = null;
        setCatalogLoading(false);
      }
    }
  }

  async function loadCustomerPage(search: string, cursor: string | null = null) {
    const controller = new AbortController();
    customerRequest.current?.abort();
    customerRequest.current = controller;
    setCustomerLoading(true);
    setCustomerSearchError("");
    try {
      const params = new URLSearchParams({ resource: "customers", q: posCustomerSearchQuery(search), limit: "25" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/erp/pdv?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await responseBody(response), page = isRecord(body.page) ? body.page : null;
      if (!response.ok || !Array.isArray(body.items) || !page) throw new Error(stringValue(body.error) || "Não foi possível consultar os clientes.");
      const incoming = body.items as Customer[];
      setCustomerResults((current) => cursor ? mergeById(current, incoming) : incoming);
      setCustomerNextCursor(page.hasMore === true && typeof page.nextCursor === "string" ? page.nextCursor : null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setCustomerSearchError(cause instanceof Error ? cause.message : "Não foi possível consultar os clientes.");
    } finally {
      if (customerRequest.current === controller) {
        customerRequest.current = null;
        setCustomerLoading(false);
      }
    }
  }

  async function loadSalePage(search: string, cursor: string | null = null) {
    const controller = new AbortController();
    saleRequest.current?.abort();
    saleRequest.current = controller;
    setSaleLoading(true);
    setSaleSearchError("");
    try {
      const params = new URLSearchParams({ resource: "sales", q: search.trim(), limit: "25" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/erp/pdv?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await responseBody(response), page = isRecord(body.page) ? body.page : null;
      if (!response.ok || !Array.isArray(body.items) || !page) throw new Error(stringValue(body.error) || "Não foi possível buscar vendas.");
      if (controller.signal.aborted) return;
      setSaleResults(current => cursor ? mergeById(current, body.items as PdvData["recentSales"]) : body.items as PdvData["recentSales"]);
      setSaleNextCursor(page.hasMore === true && typeof page.nextCursor === "string" ? page.nextCursor : null);
    } catch (cause) {
      if (!controller.signal.aborted) setSaleSearchError(cause instanceof Error ? cause.message : "Não foi possível buscar vendas.");
    } finally {
      if (saleRequest.current === controller) { saleRequest.current = null; setSaleLoading(false); }
    }
  }

  useEffect(() => {
    if (operation !== "recent") return;
    const timer = window.setTimeout(() => void loadSalePage(saleQuery), 250);
    return () => { window.clearTimeout(timer); saleRequest.current?.abort(); };
  }, [operation, saleQuery]);

  const loadInitialWorkspace = useEffectEvent(load);
  const renewOrderClaim = useEffectEvent(renewOrderClaimRequest);
  const recoverLatestDraft = useEffectEvent(() => { if (data) void loadDraftRecovery(data); });
  const reflectScannerEffectResult = useEffectEvent(reflectScannerResult);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadInitialWorkspace());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const pointer = window.matchMedia("(pointer: coarse)");
    const update = () => setMobileCamera(pointer.matches && Boolean(navigator.mediaDevices?.getUserMedia));
    update();
    pointer.addEventListener("change", update);
    return () => pointer.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!data || defaultPaymentInitialized.current) return;
    defaultPaymentInitialized.current = true;
    setPayments([newPayment(supportedPaymentMethod(data.settings.defaultPaymentMethod))]);
  }, [data]);

  const catalogSessionId = data?.session?.status === "open" ? data.session.id : null;
  const activeRegister = data?.session ? data.registers.find((item) => item.id === data.session?.registerId) : null;
  const activeTerminal = activeRegister?.terminals.find((terminal) => terminal.id === data?.session?.terminalId);
  const activeDevices = activeTerminal?.devices.filter((device) => !["disabled", "error", "revoked"].includes(device.status)) || [];
  const scannerConfigured = activeDevices.some((device) => ["scanner", "barcode_scanner", "qr_scanner"].includes(device.type));
  const cameraConfigured = activeDevices.some((device) => ["camera", "usb_camera"].includes(device.type));
  const cameraAvailable = mobileCamera || cameraConfigured;

  useEffect(() => {
    const terminalId = data?.session?.status === "open" ? data.session.terminalId : null;
    if (!terminalId || !online) {
      const frame = window.requestAnimationFrame(() => setHeartbeatTerminalId(null));
      return () => window.cancelAnimationFrame(frame);
    }
    let active = true;
    let running = false;
    let confirmed = false;
    const beat = async () => {
      if (running) return;
      running = true;
      try {
        const response = await fetch("/api/erp/pdv/offline-credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "terminal.heartbeat", terminalId }),
        });
        const body = await responseBody(response);
        if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível confirmar o terminal online.");
        const credentialExpiresAt = Date.parse(stringValue(body.credentialExpiresAt));
        if (!Number.isFinite(credentialExpiresAt) || credentialExpiresAt <= Date.now() + 30 * 60_000) {
          const renewalResponse = await fetch("/api/erp/pdv/offline-credentials", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "credential.issue", terminalId, ttlMinutes: 480, idempotencyKey: `online.renew:${crypto.randomUUID()}` }),
          });
          const renewal = await responseBody(renewalResponse);
          if (!renewalResponse.ok) throw new Error(stringValue(renewal.error) || "Não foi possível renovar a ativação segura deste terminal.");
        }
        if (!active) return;
        const firstConfirmation = !confirmed;
        confirmed = true;
        setHeartbeatTerminalId(terminalId);
        setDraftSaveError(current => current.includes("heartbeat") || current.includes("agente do terminal") ? "" : current);
        draftSaveFailedSignature.current = "";
        if (firstConfirmation) recoverLatestDraft();
      } catch (cause) {
        if (!active) return;
        confirmed = false;
        setHeartbeatTerminalId(null);
        setDraftSaveError(cause instanceof Error ? cause.message : "O terminal web não conseguiu renovar o heartbeat.");
      } finally {
        running = false;
      }
    };
    void beat();
    const timer = window.setInterval(() => void beat(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [data?.session?.id, data?.session?.status, data?.session?.terminalId, online]);

  useEffect(() => {
    if (!catalogSessionId) return;
    const timer = window.setTimeout(() => void loadCatalogPage(query), 250);
    return () => {
      window.clearTimeout(timer);
      catalogRequest.current?.abort();
      catalogRequest.current = null;
    };
  }, [catalogSessionId, query]);

  useEffect(() => {
    if (!catalogSessionId) return;
    const timer = window.setTimeout(() => void loadCustomerPage(customerQuery), 250);
    return () => {
      window.clearTimeout(timer);
      customerRequest.current?.abort();
      customerRequest.current = null;
    };
  }, [catalogSessionId, customerQuery]);

  useEffect(() => {
    if (!activeOrderClaim || !catalogSessionId) return;
    const tick = () => {
      const now = Date.now(), remaining = new Date(activeOrderClaim.leaseExpiresAt).valueOf() - now;
      setOrderClaimClock(now);
      if (remaining <= 0) {
        setOrderClaimError("A posse do pedido expirou. O checkout permanece bloqueado até uma nova reivindicação segura.");
        return;
      }
      if (orderClaimRenewBlockedVersion.current !== activeOrderClaim.version && remaining <= 60_000) void renewOrderClaim(activeOrderClaim);
    };
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
  }, [activeOrderClaim, catalogSessionId]);

  useEffect(() => {
    if (!scannerConfigured) return;
    function keyboard(event: KeyboardEvent) {
      if (event.key === "F2") {
        if (!operation) {
          event.preventDefault();
          setQuickTool("scanner");
          window.requestAnimationFrame(() => scanRef.current?.focus());
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      const outcome = scannerCapture.feed({
        key: event.key,
        atMs: performance.now(),
        context: {
          operationActive: Boolean(operation || requestLock.current),
          wedgeSessionActive: false,
          target: posScannerTarget(event.target, scanRef.current),
        },
      });
      if (outcome.consumed) event.preventDefault();
      setScanQueueDepth(outcome.queueDepth);
      outcome.immediateResults.forEach(reflectScannerEffectResult);
      if (outcome.disposition === "queued") {
        setScanQueueError("");
        scheduleScanQueueDrain();
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [scannerConfigured, operation, scannerCapture]);

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (operation || event.ctrlKey || event.metaKey || event.altKey) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes((event.target as HTMLElement | null)?.tagName || "")) return;
      const key = event.key.toUpperCase();
      if (!["F1", "F3", "F4", "F5", "F6", "F7", "F12"].includes(key)) return;
      event.preventDefault();
      if (key === "F1") { if (Object.keys(cartRef.current).length) void clearCurrentSale(); else { resetSale(); showNotice("Nova venda preparada."); } }
      if (key === "F3") setQuickTool("customer");
      if (key === "F4") setQuickTool("order");
      if (key === "F5") document.querySelector<HTMLElement>(".pos-held")?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (key === "F6" && data?.session?.status === "open") openOperation("cash");
      if (key === "F7") openOperation("recent");
      if (key === "F12") {
        if (checkoutStep === "items") {
          if (activePromotionQuote && lines.length) {
            setCheckoutStep("payment");
            setMobileCartOpen(true);
          }
        } else document.querySelector<HTMLFormElement>("#pos-current-sale")?.requestSubmit();
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  });

  useEffect(() => {
    if (!operation) return;
    function dialogKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) closeOperation();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".pos-workspace .tenant-modal[role=dialog]");
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", dialogKeyboard);
    return () => window.removeEventListener("keydown", dialogKeyboard);
  });

  useEffect(() => () => {
    stopCamera();
    if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
    if (scanQueueRetryTimer.current != null) window.clearTimeout(scanQueueRetryTimer.current);
    catalogRequest.current?.abort();
    customerRequest.current?.abort();
  }, []);

  const lines = Object.values(cart);
  const manualPaymentProviders = useMemo(() => [...new Set((data?.connectors || []).filter((connector) => connector.type.startsWith("payment") && (connector.registerId == null || connector.registerId === activeRegister?.id)).map((connector) => connector.provider))].sort(), [data?.connectors, activeRegister?.id]);
  const electronicPaymentConnectors = useMemo(() => (data?.connectors || []).filter((connector) => connector.type.startsWith("payment") && connector.provider !== "manual_pos" && (connector.registerId == null || connector.registerId === activeRegister?.id)), [data?.connectors, activeRegister?.id]);
  const grossCents = lines.reduce((sum, line) => sum + Math.round(line.product.priceCents * line.quantity), 0);
  const lineDiscountCents = lines.reduce((sum, line) => sum + line.discountCents, 0);
  const subtotalCents = lines.reduce((sum, line) => sum + Math.round(line.product.priceCents * line.quantity) - line.discountCents, 0);
  const discountCents = parseMoney(discount);
  const manualDiscountCents = lineDiscountCents + discountCents;
  const discountApprovalPolicy = data?.session && activeRegister && grossCents > 0 && manualDiscountCents <= grossCents ? buildPosDiscountApproval({
    saleDraftId: saleIdempotencyKey.current,
    sessionId: data.session.id,
    grossCents,
    orderDiscountCents: discountCents,
    lineDiscountCents,
    settingsMaximumPercent: data.settings.maxDiscountPercent,
    accessMaximumBasisPoints: activeRegister.access.maxDiscountBasisPoints,
  }) : null;
  const discountApprovalContextSignature = discountApprovalPolicy ? JSON.stringify(discountApprovalPolicy.context) : "";
  const activeDiscountApproval = discountApproval?.contextSignature === discountApprovalContextSignature ? discountApproval : null;
  const promotionRequestSignature = JSON.stringify({
    saleDraftId: saleIdempotencyKey.current,
    sessionId: data?.session?.id ?? null,
    customerId: customerId || null,
    couponCode: couponCode.normalize("NFKC").trim().toUpperCase(),
    couponQrToken,
    discountCents,
    discountApprovalId: activeDiscountApproval?.id ?? null,
    items: [...lines].sort((left, right) => cartKey(left.product).localeCompare(cartKey(right.product))).map((line) => ({ productId: line.product.id, variationId: line.product.resolvedVariationId ?? null, quantity: line.quantity, discountCents: line.discountCents })),
  });
  const activePromotionQuote = promotionQuote?.requestSignature === promotionRequestSignature ? promotionQuote : null;
  const currentPaymentPlan = paymentPlan && activePromotionQuote
    && paymentPlan.saleDraftId === saleIdempotencyKey.current
    && paymentPlan.quoteHash === activePromotionQuote.quoteHash
    && paymentPlan.totalCents === activePromotionQuote.totalCents
    && paymentPlan.currency === "BRL"
    && new Date(paymentPlan.expiresAt).valueOf() > Date.now()
    && ["quoted", "active"].includes(paymentPlan.state) ? paymentPlan : null;
  const promotionDiscountCents = activePromotionQuote?.promotionDiscountCents ?? 0;
  const totalCents = activePromotionQuote?.totalCents ?? Math.max(0, subtotalCents - discountCents);
  const paidCents = payments.reduce((sum, payment) => sum + parseMoney(payment.amount), 0);
  const remainingCents = totalCents - paidCents;
  const anyPaymentIntentLocked = payments.some(payment => isPdvPaymentIntentLocked(payment.electronicIntent));
  const currentDraftSignature = lines.length && data?.session ? recoveryDraftSignature(saleIdempotencyKey.current, data.session.id, customerId ? Number(customerId) : null, notes, fulfillmentMode, discountCents, 0, lines) : "";
  const draftReady = Boolean(currentDraftSignature && persistedDraft?.id === saleIdempotencyKey.current && persistedDraft.signature === currentDraftSignature);
  const intentDraftDiverged = anyPaymentIntentLocked && Boolean(currentDraftSignature) && !draftReady;
  const draftOperationalError = intentDraftDiverged ? "O carrinho mudou após a criação de uma intenção eletrônica. Reverta a alteração ou reconcilie/cancele com segurança." : draftReady && draftSaveError.startsWith("O carrinho mudou após") ? "" : draftSaveError;
  const hasServerRecovery = draftRecovery.mode !== "none" || draftRecovery.drafts.length > 0 || draftRecovery.intents.length > 0 || draftRecovery.manualReferences.length > 0;
  const recoveryCheckoutBlocked = draftRecovery.loading || draftRecovery.mode === "blocked" || draftRecovery.mode === "error" || draftSaving || Boolean(draftOperationalError) || Boolean(lines.length && !draftReady);
  const orderClaimCheckoutBlocked = Boolean(activeOrderClaim && (orderClaimError || activeOrderClaim.state !== "active" || new Date(activeOrderClaim.leaseExpiresAt).valueOf() <= orderClaimClock));
  const proposedPaymentPlanSlots: PaymentPlanSlot[] = payments.map((payment, paymentIndex) => {
    const connector = electronicPaymentConnectors.find(candidate => candidate.id === payment.connectorId);
    return {
      paymentIndex,
      method: payment.method,
      amountCents: parseMoney(payment.amount),
      installments: payment.method === "credit" ? positiveInteger(payment.installments, 1) : 1,
      proofKind: payment.method === "cash" ? "cash" : payment.method === "store_credit" ? "value" : payment.proofMode === "manual" ? "manual" : "intent",
      connectorId: payment.method !== "cash" && payment.method !== "store_credit" && payment.proofMode === "intent" ? payment.connectorId || null : null,
      provider: payment.method !== "cash" && payment.method !== "store_credit" ? (payment.proofMode === "intent" ? connector?.provider ?? null : payment.provider.trim().toLocaleLowerCase("en-US") || null) : null,
    };
  });
  const paymentPlanSlotsMatch = Boolean(currentPaymentPlan?.state === "active" && JSON.stringify(currentPaymentPlan.slots) === JSON.stringify(proposedPaymentPlanSlots));
  const paymentPlanConfigurationLocked = currentPaymentPlan?.state === "active";
  const manualPaymentSignature = (payment: Payment, paymentIndex: number) => JSON.stringify({
    saleDraftId: saleIdempotencyKey.current,
    quoteHash: activePromotionQuote?.quoteHash ?? null,
    sessionId: data?.session?.id ?? null,
    registerId: data?.session?.registerId ?? null,
    paymentIndex,
    method: payment.method,
    amountCents: parseMoney(payment.amount),
    installments: positiveInteger(payment.installments, 1),
    provider: payment.provider.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
    reference: payment.reference.normalize("NFKC").trim(),
    operatorClaimedOccurredAt: manualOccurrenceIso(payment.confirmationOccurredAt),
  });
  const paymentIntentSignature = (payment: Payment, paymentIndex: number) => posPaymentIntentContextSignature({ sessionId: data?.session?.id ?? 0, registerId: data?.session?.registerId ?? 0, operatorProfileId: data?.operator.id ?? 0, saleDraftId: saleIdempotencyKey.current, paymentPlanId: currentPaymentPlan?.id ?? "", paymentIndex, amountCents: parseMoney(payment.amount), method: payment.method, installments: positiveInteger(payment.installments, 1), connectorId: payment.connectorId, terminalId: payment.terminalId });
  const paymentsValid = paymentPlanSlotsMatch && paidCents === totalCents && payments.every((payment, paymentIndex) => {
    const amount = parseMoney(payment.amount);
    if (amount <= 0) return false;
    if (payment.method === "cash") return parseMoney(payment.tendered) >= amount;
    if (payment.method === "store_credit") {
      if (payment.valueAccountId) {
        const account = valueAccounts.find(item => item.id === payment.valueAccountId);
        if (!account) return false;
        const requestedUnits = account.unit === "points" ? positiveBigInt(payment.valueUnits) : BigInt(amount);
        const availableUnits = positiveBigInt(account.availableUnits);
        if (requestedUnits <= BigInt(0) || requestedUnits > availableUnits) return false;
        return account.unit !== "points" || requestedUnits * BigInt(account.program?.redeemCentsPerUnit || 0) === BigInt(amount);
      }
      return Boolean((payment.giftCode.trim() || payment.giftQrToken) && /^\d{6,12}$/.test(payment.giftPin));
    }
    if (payment.proofMode === "intent") return isPdvPaymentIntentCaptured(payment.electronicIntent, paymentIntentSignature(payment, paymentIndex));
    return Boolean(payment.manualReference?.status === "approved" && (payment.manualReference.recovered || payment.manualReference.signature === manualPaymentSignature(payment, paymentIndex)));
  });
  const categories = useMemo(() => [...new Set(catalogProducts.map((product) => product.category || "").filter(Boolean))].sort((left, right) => left.localeCompare(right, "pt-BR")), [catalogProducts]);
  const products = useMemo(() => catalogProducts.filter((product) => {
    if (categoryFilter && product.category !== categoryFilter) return false;
    const stocks = product.variations?.length ? product.variations.map(variation => variation.stock) : [product.stock];
    if (stockFilter === "available" && !stocks.some(stock => stock == null || stock > 0)) return false;
    if (stockFilter === "low" && !stocks.some(stock => stock != null && stock > 0 && stock <= 10)) return false;
    return true;
  }), [catalogProducts, categoryFilter, stockFilter]);
  const customerOptions = useMemo(() => selectedCustomer && !customerResults.some((customer) => customer.id === selectedCustomer.id) ? [selectedCustomer, ...customerResults] : customerResults, [customerResults, selectedCustomer]);

  useEffect(() => {
    if (!data?.session || data.session.status !== "open" || !online || !lines.length || !draftReady || activePromotionQuote || quoteBusy || busy || anyPaymentIntentLocked) return;
    if (!discountApprovalPolicy || discountApprovalPolicy.requiresApproval && !activeDiscountApproval) return;
    const timer = window.setTimeout(() => void quoteBestPromotion(), 450);
    return () => window.clearTimeout(timer);
    // quoteBestPromotion is intentionally tied to the full promotion signature below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promotionRequestSignature, data?.session, online, lines.length, draftReady, activePromotionQuote, quoteBusy, busy, anyPaymentIntentLocked, discountApprovalPolicy, activeDiscountApproval]);

  useEffect(() => {
    if (authenticationExpired.current || !data?.session || data.session.status !== "open" || !online || heartbeatTerminalId !== data.session.terminalId || !currentDraftSignature || activeHeldSaleId || draftSaving || draftSaveRequest.current || draftRecovery.loading || ["blocked", "error"].includes(draftRecovery.mode) || draftSaveFailedSignature.current === currentDraftSignature) return;
    if (persistedDraft?.id === saleIdempotencyKey.current && persistedDraft.signature === currentDraftSignature) return;
    if (anyPaymentIntentLocked) return;
    if (draftSaveTimer.current != null) window.clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = window.setTimeout(() => {
      draftSaveTimer.current = null;
      const controller = new AbortController();
      draftSaveRequest.current?.abort();
      draftSaveRequest.current = controller;
      const signature = currentDraftSignature;
      draftSaveAttempts.current[signature] ||= crypto.randomUUID();
      setDraftSaving(true);
      setDraftSaveError("");
      void fetch("/api/erp/pdv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action: "cart.draft.save",
          sessionId: data.session!.id,
          saleDraftId: saleIdempotencyKey.current,
          ...(persistedDraft?.id === saleIdempotencyKey.current && persistedDraft.source === "draft" ? { expectedRevision: persistedDraft.revision } : {}),
          idempotencyKey: draftSaveAttempts.current[signature],
          customerId: customerId ? Number(customerId) : undefined,
          notes,
          fulfillmentMode,
          discountCents,
          surchargeCents: 0,
          items: lines.map(line => ({ productId: line.product.id, variationId: line.product.resolvedVariationId, quantity: line.quantity, unitPriceCents: line.product.priceCents, discountCents: line.discountCents, scanData: line.scanData })),
        }),
      }).then(async response => {
        handleUnauthorized(response);
        return { response, body: await responseBody(response) };
      }).then(({ response, body }) => {
        if (controller.signal.aborted) return;
        const draft = isRecord(body.draft) ? body.draft : null, revision = Number(draft?.revision);
        if (!response.ok || stringValue(draft?.id) !== saleIdempotencyKey.current || !Number.isSafeInteger(revision)) throw Object.assign(new Error(stringValue(body.error) || "O servidor não confirmou o rascunho."), { status: response.status });
        draftSaveFailedSignature.current = "";
        setPersistedDraft({ id: saleIdempotencyKey.current, revision, signature, source: "draft" });
        delete draftSaveAttempts.current[signature];
      }).catch(cause => {
        if (!controller.signal.aborted) {
          draftSaveFailedSignature.current = signature;
          setDraftSaveError(cause instanceof Error ? cause.message : "O rascunho não pôde ser persistido.");
          if ((cause as { status?: number })?.status === 409) recoverLatestDraft();
        }
      }).finally(() => {
        if (draftSaveRequest.current === controller) {
          draftSaveRequest.current = null;
          setDraftSaving(false);
        }
      });
    }, 350);
    return () => {
      if (draftSaveTimer.current != null) window.clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
    };
  }, [activeHeldSaleId, anyPaymentIntentLocked, currentDraftSignature, customerId, data?.session, discountCents, draftRecovery.loading, draftRecovery.mode, draftSaveError, draftSaving, fulfillmentMode, heartbeatTerminalId, lines, notes, online, persistedDraft]);

  async function mutate(payload: Record<string, unknown>, success: string, globalBusy = true) {
    if (requestLock.current) {
      setError("Aguarde a operação atual terminar.");
      return null;
    }
    requestLock.current = true;
    if (globalBusy) setBusy(true);
    draftSaveFailedSignature.current = "";
    setError("");
    try {
      const response = await fetch("/api/erp/pdv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await responseBody(response);
      if (handleUnauthorized(response)) return null;
      if (!response.ok) {
        setError(stringValue(body.error) || "Operação não concluída.");
        return null;
      }
      if (success) showNotice(success);
      return body;
    } catch {
      setError("A operação não pôde ser confirmada. Verifique a rede antes de tentar novamente.");
      return null;
    } finally {
      requestLock.current = false;
      if (globalBusy) setBusy(false);
    }
  }

  async function lookupOrder(value: string, signedQr = false) {
    const normalized = value.trim();
    if (!normalized || activeOrderClaim) return;
    const payload = { action: "order.lookup", ...(signedQr ? { qrToken: normalized } : { lookup: normalized }) };
    let result: Record<string, unknown> | null;
    if (scanQueueDraining.current && requestLock.current) {
      const response = await fetch("/api/erp/pdv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) {
        setError(stringValue(body.error) || "Pedido não encontrado.");
        return;
      }
      result = body;
      showNotice("Pedido consultado; o QR apenas identificou o registro.");
    } else result = await mutate(payload, "Pedido consultado; o QR apenas identificou o registro.");
    if (!result || !isRecord(result.order) || !isRecord(result.eligibility)) return;
    const lookup = result as unknown as PosOrderLookup;
    setOrderLookup(lookup);
    if (!lookup.eligibility.eligible) setOrderClaimError(lookup.eligibility.reason || "O pedido não está elegível para o PDV.");
    else setOrderClaimError("");
  }

  async function claimOrder() {
    if (!data?.session || !orderLookup?.eligibility.eligible || activeOrderClaim) return;
    if (Object.keys(cartRef.current).length) {
      setOrderClaimError("Suspenda ou limpe a venda atual antes de reivindicar um pedido.");
      return;
    }
    if (!orderLookup.order.paymentMethod || orderLookup.order.items.some(item => !item.product)) {
      setOrderClaimError("O pedido não possui produtos ou pagamento integralmente compatíveis com o PDV.");
      return;
    }
    if (orderClaimAttempt.current?.orderId !== orderLookup.order.id) orderClaimAttempt.current = { orderId: orderLookup.order.id, key: crypto.randomUUID() };
    const result = await mutate({ action: "order.claim", sessionId: data.session.id, orderId: orderLookup.order.id, idempotencyKey: orderClaimAttempt.current.key }, "Pedido reivindicado por este terminal.");
    if (!result || !isRecord(result.claim)) return;
    const rawClaim = result.claim, claimId = stringValue(rawClaim.id), version = Number(rawClaim.version), leaseExpiresAt = stringValue(rawClaim.leaseExpiresAt);
    if (!claimId || !Number.isSafeInteger(version) || !leaseExpiresAt || stringValue(rawClaim.state) !== "active" || Number(rawClaim.salesOrderId) !== orderLookup.order.id) {
      setOrderClaimError("O servidor não retornou uma posse íntegra do pedido.");
      orderClaimAttempt.current = { orderId: orderLookup.order.id, key: crypto.randomUUID() };
      return;
    }
    if (!window.confirm("Limpar todos os itens e ajustes desta venda?")) return;
    resetSale();
    const restored: Record<string, CartLine> = {};
    for (const item of orderLookup.order.items) {
      const product = { ...item.product!, resolvedVariationId: item.variationId, priceCents: item.listPriceCents };
      restored[cartKey(product)] = { product, quantity: item.quantity, discountCents: item.discountCents };
    }
    saleIdempotencyKey.current = claimId;
    setDiscount(formatInput(orderLookup.order.discountCents));
    setCustomerId(orderLookup.order.customerId ? String(orderLookup.order.customerId) : "");
    setSelectedCustomer(orderLookup.order.customer);
    if (orderLookup.order.customer) setCustomerResults(current => mergeById(current, [orderLookup.order.customer!]));
    setNotes(orderLookup.order.notes || "");
    setNoteExpanded(Boolean(orderLookup.order.notes));
    setFulfillmentMode("pickup");
    setPayments([{ ...newPayment(orderLookup.order.paymentMethod, orderLookup.order.totalCents), installments: String(orderLookup.order.paymentInstallments) }]);
    replaceCart(restored, orderLookup.order.discountCents);
    setPersistedDraft(null);
    setActiveOrderClaim({ id: claimId, salesOrderId: orderLookup.order.id, state: "active", version, leaseExpiresAt, order: { id: orderLookup.order.id, number: orderLookup.order.number, status: orderLookup.order.status } });
    setOrderClaimError("");
    void loadValueAccounts(orderLookup.order.customerId ? String(orderLookup.order.customerId) : "");
  }

  async function releaseOrderClaim() {
    if (!data?.session || !activeOrderClaim) return false;
    orderClaimReleaseAttempts.current[activeOrderClaim.version] ||= crypto.randomUUID();
    const result = await mutate({ action: "order.claim.release", sessionId: data.session.id, claimId: activeOrderClaim.id, expectedVersion: activeOrderClaim.version, idempotencyKey: orderClaimReleaseAttempts.current[activeOrderClaim.version] }, "Pedido liberado; o rascunho sem pagamento pendente foi descartado.");
    if (!result) return false;
    resetSale();
    setOrderLookup(null);
    return true;
  }

  async function recoverOrderClaim(claimId: string, sessionId: number, draft: RecoveryDraft, intents: PdvOperatorPaymentIntent[], manualReferences: RecoveryManualPaymentReference[]) {
    const response = await fetch("/api/erp/pdv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "order.claim.recover", sessionId, claimId }), cache: "no-store" });
    const body = await responseBody(response);
    if (!response.ok) throw new Error(stringValue(body.error) || "O claim vinculado ao rascunho não pôde ser recuperado.");
    if (body.claim == null) return;
    if (!isRecord(body.claim) || !isRecord(body.claim.order)) throw new Error("O servidor retornou um claim de pedido incompleto.");
    const order = body.claim.order, version = Number(body.claim.version), leaseExpiresAt = stringValue(body.claim.leaseExpiresAt), orderId = Number(body.claim.salesOrderId), paymentMethod = supportedPaymentMethod(order.paymentMethod), paymentInstallments = Number(order.paymentInstallments), totalCents = Number(order.totalCents);
    const expectedItems = Array.isArray(order.items) ? order.items.filter(isRecord).map(item => ({ productId: Number(item.productId), variationId: item.variationId == null ? null : Number(item.variationId), quantity: Number(item.quantity), discountCents: Number(item.discountCents) })).sort(orderLineSort) : [];
    const draftItems = draft.items.map(item => ({ productId: item.productId, variationId: item.variationId ?? null, quantity: item.quantity, discountCents: item.discountCents })).sort(orderLineSort);
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(orderId) || !leaseExpiresAt || !stringValue(order.paymentMethod) || !Number.isSafeInteger(paymentInstallments) || !Number.isSafeInteger(totalCents) || Number(order.customerId || 0) !== (draft.customerId || 0) || Number(order.discountCents) !== draft.discountCents || JSON.stringify(expectedItems) !== JSON.stringify(draftItems)) throw new Error("O rascunho recuperado diverge do pedido reivindicado; checkout bloqueado para reconciliação.");
    if (intents.length && (intents.length !== 1 || intents[0].method !== paymentMethod || intents[0].amountCents !== totalCents || intents[0].installments !== paymentInstallments)) throw new Error("A intenção eletrônica recuperada diverge da condição de pagamento do pedido; reconcilie sem repetir a cobrança.");
    if (manualReferences.length && (manualReferences.length !== 1 || manualReferences[0].method !== paymentMethod || manualReferences[0].amountCents !== totalCents || manualReferences[0].installments !== paymentInstallments || manualReferences[0].paymentIndex !== 0)) throw new Error("A referência manual recuperada diverge da condição de pagamento do pedido; reconcilie sem criar nova prova.");
    if (!intents.length && !manualReferences.length) setPayments([{ ...newPayment(paymentMethod, totalCents), installments: String(paymentInstallments) }]);
    setActiveOrderClaim({ id: claimId, salesOrderId: orderId, state: stringValue(body.claim.state), version, leaseExpiresAt, order: { id: Number(body.claim.order.id), number: stringValue(body.claim.order.number), status: stringValue(body.claim.order.status) } });
    setOrderClaimError("");
  }

  async function renewOrderClaimRequest(claim: ActiveOrderClaim) {
    if (!data?.session || requestLock.current) return;
    orderClaimRenewAttempts.current[claim.version] ||= crypto.randomUUID();
    requestLock.current = true;
    try {
      const response = await fetch("/api/erp/pdv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "order.claim.renew", sessionId: data.session.id, claimId: claim.id, expectedVersion: claim.version, idempotencyKey: orderClaimRenewAttempts.current[claim.version] }), cache: "no-store" });
      const body = await responseBody(response), renewed = isRecord(body.claim) ? body.claim : null;
      const version = Number(renewed?.version), leaseExpiresAt = stringValue(renewed?.leaseExpiresAt);
      if (!response.ok || stringValue(renewed?.id) !== claim.id || version !== claim.version + 1 || !leaseExpiresAt) throw new Error(stringValue(body.error) || "A renovação da posse não foi confirmada.");
      setActiveOrderClaim(current => current?.id === claim.id && current.version === claim.version ? { ...current, version, leaseExpiresAt } : current);
      orderClaimRenewBlockedVersion.current = null;
      setOrderClaimError("");
    } catch (cause) {
      orderClaimRenewBlockedVersion.current = claim.version;
      setOrderClaimError(cause instanceof Error ? cause.message : "A posse do pedido não pôde ser renovada; checkout bloqueado.");
    } finally {
      requestLock.current = false;
    }
  }

  async function refreshDraftRecovery() {
    if (!data?.session || requestLock.current) return;
    requestLock.current = true;
    setBusy(true);
    draftSaveFailedSignature.current = "";
    setDraftSaveError("");
    setRecoveryFeedback(null);
    try { const result = await loadDraftRecovery(data, false); setRecoveryFeedback({ ...result, at: Date.now() }); }
    finally { requestLock.current = false; setBusy(false); }
  }

  async function cancelRecoveryIntent(intent: PdvOperatorPaymentIntent) {
    if (!data?.session || requestLock.current || intent.status !== "created") return;
    const attemptKey = `${intent.id}:${intent.version}`;
    recoveryCancelAttempts.current[attemptKey] ||= crypto.randomUUID();
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/payment-intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "intent.cancel", intentId: intent.id, expectedVersion: intent.version, idempotencyKey: recoveryCancelAttempts.current[attemptKey] }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "A intenção não pôde ser cancelada com segurança.");
      delete recoveryCancelAttempts.current[attemptKey];
      const state = await loadDraftRecovery(data, false);
      setRecoveryFeedback({ kind: state.kind, title: "Intenção cancelada", text: "O pré-dispatch foi cancelado e o estado da venda foi reavaliado.", at: Date.now() });
    } catch (cause) { setRecoveryFeedback({ kind: "error", title: "Cancelamento não concluído", text: cause instanceof Error ? cause.message : "Não foi possível cancelar a intenção pré-dispatch.", at: Date.now() }); }
    finally { requestLock.current = false; setBusy(false); }
  }

  async function reconcileRecoveryIntent(intent: PdvOperatorPaymentIntent) {
    if (!data?.session || requestLock.current || !["processing", "authorized", "unknown", "manual_review"].includes(intent.status)) return;
    const attemptKey = `${intent.id}:${intent.version}`;
    recoveryRetryAttempts.current[attemptKey] ||= crypto.randomUUID();
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/payment-intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "intent.retry", intentId: intent.id, expectedVersion: intent.version, idempotencyKey: recoveryRetryAttempts.current[attemptKey] }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "A consulta de reconciliação não pôde ser enfileirada.");
      delete recoveryRetryAttempts.current[attemptKey];
      await loadDraftRecovery(data, false);
      setRecoveryFeedback({ kind: "success", title: "Consulta registrada", text: "A reconciliação foi solicitada sem presumir uma nova captura.", at: Date.now() });
    } catch (cause) { setRecoveryFeedback({ kind: "error", title: "Reconciliação não solicitada", text: cause instanceof Error ? cause.message : "Não foi possível solicitar a reconciliação.", at: Date.now() }); }
    finally { requestLock.current = false; setBusy(false); }
  }

  async function revokeRecoveryManualReference(reference: RecoveryManualPaymentReference) {
    if (!data?.session || requestLock.current || reference.status !== "rejected") return;
    const reason = window.prompt("Justifique o encerramento desta referência rejeitada de forma independente.", "Referência externa rejeitada pelo supervisor")?.trim() || "";
    if (reason.length < 8) { setRecoveryFeedback({ kind: "warning", title: "Justificativa necessária", text: "Informe ao menos 8 caracteres para registrar a revogação.", at: Date.now() }); return; }
    const current = recoveryManualRevokeAttempts.current[reference.id];
    if (!current || current.reason !== reason) recoveryManualRevokeAttempts.current[reference.id] = { reason, key: crypto.randomUUID() };
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/manual-payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "manual-payment.revoke", sessionId: data.session.id, id: reference.id, reason, idempotencyKey: recoveryManualRevokeAttempts.current[reference.id].key }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "A referência manual não pôde ser resolvida.");
      delete recoveryManualRevokeAttempts.current[reference.id];
      await loadDraftRecovery(data, false);
      setRecoveryFeedback({ kind: "success", title: "Referência revogada", text: "A decisão foi auditada sem presumir captura ou estorno.", at: Date.now() });
    } catch (cause) { setRecoveryFeedback({ kind: "error", title: "Referência não resolvida", text: cause instanceof Error ? cause.message : "Não foi possível resolver a referência manual.", at: Date.now() }); }
    finally { requestLock.current = false; setBusy(false); }
  }

  async function discardServerDraft(draft: RecoveryDraft | { id: string; revision: number }, resetAfter = false) {
    if (!data?.session || requestLock.current) return false;
    const attemptKey = `${draft.id}:${draft.revision}`;
    recoveryDiscardAttempts.current[attemptKey] ||= crypto.randomUUID();
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cart.draft.discard", sessionId: data.session.id, saleDraftId: draft.id, expectedRevision: draft.revision, idempotencyKey: recoveryDiscardAttempts.current[attemptKey] }) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "O rascunho não pôde ser descartado com segurança.");
      delete recoveryDiscardAttempts.current[attemptKey];
      if (resetAfter || persistedDraft?.id === draft.id) resetSale();
      if (operation === "recovery") {
        await loadDraftRecovery(data, false);
        setRecoveryFeedback({ kind: "success", title: "Rascunho descartado", text: "O carrinho foi removido sem cancelar, capturar ou estornar pagamentos.", at: Date.now() });
      } else {
        showNotice("Rascunho descartado sem operar pagamentos.", 5000);
        await loadDraftRecovery(data);
      }
      return true;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "Não foi possível descartar o rascunho.";
      if (operation === "recovery") setRecoveryFeedback({ kind: "error", title: "Rascunho não descartado", text, at: Date.now() });
      else setError(text);
      return false;
    } finally { requestLock.current = false; setBusy(false); }
  }

  async function clearCurrentSale() {
    if (!lines.length) return;
    if (anyPaymentIntentLocked) {
      setError("Há intenção eletrônica ativa. Atualize, reconcilie ou cancele apenas o pré-dispatch antes de limpar o carrinho.");
      return;
    }
    if (activeOrderClaim) {
      if (!window.confirm(`Liberar o pedido ${activeOrderClaim.order.number}? O rascunho só será descartado se não houver intenção eletrônica pendente.`)) return;
      await releaseOrderClaim();
      return;
    }
    if (persistedDraft?.source === "draft") {
      if (!window.confirm("Descartar o rascunho persistido desta venda? Esta ação não cancela nem estorna pagamentos.")) return;
      await discardServerDraft(persistedDraft, true);
      return;
    }
    resetSale();
  }

  async function mutateSessionLifecycle(payload: Record<string, unknown>, success: string) {
    if (requestLock.current) {
      setError("Aguarde a operação atual terminar.");
      return null;
    }
    const signature = JSON.stringify(payload), action = stringValue(payload.action), current = sessionLifecycleAttempts.current[action];
    const attempt = current?.signature === signature ? current : { signature, key: crypto.randomUUID() };
    sessionLifecycleAttempts.current[action] = attempt;
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/session-lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: attempt.key }) });
      const body = await responseBody(response);
      if (!response.ok) {
        setError(stringValue(body.error) || "Não foi possível alterar a posse do turno.");
        return null;
      }
      delete sessionLifecycleAttempts.current[action];
      showNotice(body.replayed ? `${success} A operação já havia sido confirmada.` : success, 5000);
      resetSale();
      closeOperation();
      await load();
      return body;
    } catch {
      setError("A posse do turno não pôde ser confirmada. Recarregue antes de repetir com outra chave.");
      return null;
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function requestDiscountApproval() {
    if (!data?.session || !discountApprovalPolicy?.requiresApproval || requestLock.current) return;
    const reason = discountApprovalReason.trim();
    if (reason.length < 8) {
      setError("Informe uma justificativa de ao menos 8 caracteres para o desconto excepcional.");
      return;
    }
    const payload = {
      action: "approval.request",
      approvalAction: "discount.override",
      entityId: saleIdempotencyKey.current,
      reason,
      expiryMinutes: 10,
      context: discountApprovalPolicy.context,
    };
    const signature = JSON.stringify(payload);
    if (discountApprovalAttempt.current.signature !== signature) discountApprovalAttempt.current = { signature, key: crypto.randomUUID() };
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: discountApprovalAttempt.current.key }) });
      const body = await responseBody(response);
      const approval = isRecord(body.approval) ? body.approval : null;
      const approvalId = stringValue(approval?.id);
      if (!response.ok || !approvalId || approval?.action !== "discount.override" || approval?.entityType !== "sale_draft" || approval?.entityId !== saleIdempotencyKey.current) {
        setError(stringValue(body.error) || "Não foi possível solicitar a aprovação deste desconto.");
        return;
      }
      setDiscountApproval({ id: approvalId, contextSignature: discountApprovalContextSignature });
      setPromotionQuote(null);
      showNotice(body.replayed ? "Pedido de desconto recuperado. Aguarde a decisão do supervisor." : "Pedido de desconto enviado ao supervisor.");
    } catch {
      setError("O pedido não pôde ser confirmado. Tente novamente sem alterar a venda para consultar a mesma chave.");
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function requestManualPaymentReference(payment: Payment, paymentIndex: number) {
    if (!data?.session || !activePromotionQuote || requestLock.current) return;
    const signature = manualPaymentSignature(payment, paymentIndex);
    const operatorClaimedOccurredAt = manualOccurrenceIso(payment.confirmationOccurredAt);
    if (!payment.provider.trim() || !payment.reference.trim() || !operatorClaimedOccurredAt || payment.confirmationReason.trim().length < 8) {
      setError("Informe instituição, referência externa, horário alegado do comprovante e justificativa de ao menos 8 caracteres.");
      return;
    }
    const currentAttempt = manualPaymentAttempts.current[payment.key];
    if (!currentAttempt || currentAttempt.signature !== signature) manualPaymentAttempts.current[payment.key] = { signature, key: crypto.randomUUID() };
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/manual-payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: data.session.id,
          saleDraftId: saleIdempotencyKey.current,
          quoteHash: activePromotionQuote.quoteHash,
          paymentIndex,
          method: payment.method,
          amountCents: parseMoney(payment.amount),
          installments: positiveInteger(payment.installments, 1),
          provider: payment.provider,
          reference: payment.reference,
          occurredAt: operatorClaimedOccurredAt,
          reason: payment.confirmationReason,
          idempotencyKey: manualPaymentAttempts.current[payment.key].key,
        }),
      });
      const body = await responseBody(response);
      const value = isRecord(body.manualReference) ? body.manualReference : null;
      const id = stringValue(value?.id), approvalId = stringValue(value?.approvalId), status = stringValue(value?.status), expiresAt = stringValue(value?.expiresAt);
      if (!response.ok || !id || !approvalId || !status || value?.saleDraftId !== saleIdempotencyKey.current || value?.quoteHash !== activePromotionQuote.quoteHash || Number(value?.paymentIndex) !== paymentIndex) {
        setError(stringValue(body.error) || "Não foi possível registrar a referência manual.");
        return;
      }
      setPayments((current) => current.map((item) => item.key === payment.key ? { ...item, manualReference: { id, approvalId, status, expiresAt, signature } } : item));
      showNotice(body.replayed ? "Pedido de confirmação manual recuperado." : "Referência registrada. Aguarde a aprovação independente com step-up.", 6000);
    } catch {
      setError("A referência manual não pôde ser confirmada. Repita sem alterar os dados para consultar a mesma chave.");
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function refreshManualPaymentReference(payment: Payment) {
    const manualReference = payment.manualReference;
    if (!manualReference || requestLock.current) return;
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/erp/pdv/manual-payments?id=${encodeURIComponent(manualReference.id)}`, { cache: "no-store" });
      const body = await responseBody(response);
      const value = isRecord(body.manualReference) ? body.manualReference : null;
      if (!response.ok || value?.id !== manualReference.id) {
        setError(stringValue(body.error) || "Não foi possível atualizar a confirmação manual.");
        return;
      }
      const status = stringValue(value.status);
      setPayments((current) => current.map((item) => item.key === payment.key && item.manualReference?.id === manualReference.id ? { ...item, manualReference: { ...manualReference, status } } : item));
      showNotice(status === "approved" ? "Referência aprovada; a venda pode ser concluída sem alegar captura do PSP." : `Estado da referência: ${status}.`, 5000);
    } catch {
      setError("Não foi possível consultar a confirmação manual.");
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function copyDiscountApprovalId() {
    if (!activeDiscountApproval) return;
    try {
      await navigator.clipboard.writeText(activeDiscountApproval.id);
      showNotice("ID da aprovação copiado.");
    } catch {
      setError("Não foi possível copiar automaticamente. Selecione o ID exibido e copie manualmente.");
    }
  }

  function replaceDiscountApprovalRequest() {
    setDiscountApproval(null);
    setPromotionQuote(null);
    discountApprovalAttempt.current = { signature: "", key: crypto.randomUUID() };
    showNotice("ID anterior descartado para esta tentativa. Você pode criar um novo pedido sem perder a venda.");
  }

  async function createQuickCustomer(payload: Record<string, unknown>) {
    if (!data?.session || requestLock.current) return false;
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/customers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, sessionId: data.session.id }) });
      const body = await responseBody(response);
      if (!response.ok || !isRecord(body.customer)) {
        setError(stringValue(body.error) || "Não foi possível cadastrar o cliente.");
        return false;
      }
      const customer = body.customer as PdvData["customers"][number];
      setData((current) => current ? { ...current, customers: [...current.customers.filter((item) => item.id !== customer.id), customer].sort((left, right) => left.name.localeCompare(right.name, "pt-BR")) } : current);
      setCustomerResults((current) => mergeById([customer], current));
      setSelectedCustomer(customer);
      setCustomerId(String(customer.id));
      await loadValueAccounts(String(customer.id));
      setPromotionQuote(null);
      setDiscountApproval(null);
      discountApprovalAttempt.current = { signature: "", key: crypto.randomUUID() };
      showNotice(body.reused ? "Cliente já existente selecionado." : "Cliente cadastrado e selecionado.");
      closeOperation();
      return true;
    } catch {
      setError("O cadastro não pôde ser confirmado. Consulte pelo CPF/CNPJ antes de repetir.");
      return false;
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function queueReceipt(saleId: number, terminalId: string, copy: "original" | "reprint", reason: string, idempotencyKey: string) {
    if (!data?.session || requestLock.current) return false;
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/print-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: data.session.id, saleId, terminalId, copy, reason: copy === "reprint" ? reason : undefined, idempotencyKey }) });
      const body = await responseBody(response);
      if (!response.ok) {
        setError(stringValue(body.error) || "Não foi possível enfileirar a impressão.");
        return false;
      }
      showNotice(body.alreadyQueued ? "A via original já estava na fila." : body.replayed ? "Pedido de impressão confirmado novamente." : "Comprovante enviado à fila do terminal.");
      return true;
    } catch {
      setError("A impressão não pôde ser confirmada. Repita sem trocar os dados para consultar a mesma chave.");
      return false;
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  function add(product: Product, scanData?: Record<string, unknown>) {
    if (draftRecovery.loading || ["blocked", "error"].includes(draftRecovery.mode)) {
      setError("Confirme a recuperação da venda antes de adicionar itens ao carrinho.");
      return;
    }
    if (anyPaymentIntentLocked) {
      setError("O carrinho está vinculado a uma intenção eletrônica ativa. Reconcilie ou cancele com segurança antes de alterar itens.");
      return;
    }
    if (!product.resolvedVariationId && product.variations?.length) {
      setVariationProduct(product);
      openOperation("variation");
      return;
    }
    const increment = typeof scanData?.measuredQuantity === "number" && scanData.measuredQuantity > 0 ? scanData.measuredQuantity : typeof scanData?.packageQuantity === "number" && scanData.packageQuantity > 0 ? scanData.packageQuantity : 1;
    const current = cartRef.current;
    const key = cartKey(product), existing = current[key];
    if (activeOrderClaim) {
      if (!existing) {
        setError(`${product.name} não pertence ao pedido reivindicado. Libere o claim antes de iniciar outra venda.`);
        return;
      }
      if (!scanData) {
        showNotice(`${product.name} já está no pedido; a quantidade aprovada não foi alterada.`);
        return;
      }
      replaceCart({ ...current, [key]: { ...existing, scanData: mergeTrackingScanData(existing, scanData, increment) } });
      showNotice(`Leitura vinculada a ${product.name} sem alterar a quantidade do pedido.`, 1800);
      return;
    }
    const incomingCodeRead = isRecord(scanData?.codeRead);
    if (existing && ((incomingCodeRead && !hasCodeReads(existing.scanData)) || (!incomingCodeRead && hasCodeReads(existing.scanData)))) {
      setError(`Não misture quantidade manual e leituras autoritativas em ${product.name}. Remova o item e adicione-o novamente.`);
      return;
    }
    if (product.soldIndividually && existing) {
      showNotice(`${product.name} só pode ser vendido uma vez.`);
      return;
    }
    const nextQuantity = product.soldIndividually ? 1 : Math.round(((existing?.quantity || 0) + increment) * 1000) / 1000;
    if (product.stock != null && product.stock < nextQuantity) {
      setError(`Estoque disponível esgotado para ${product.name}.`);
      return;
    }
    replaceCart({
      ...current,
      [key]: {
        product,
        quantity: nextQuantity,
        discountCents: existing?.discountCents || 0,
        scanData: mergeTrackingScanData(existing, scanData, increment),
      },
    });
    setError("");
    showNotice(product.soldIndividually && existing ? `${product.name} só pode ser vendido uma vez.` : `${product.name} adicionado.`, 1200);
  }

  async function processScanCode(code: string): Promise<PosScannerProcessingDecision> {
    const clean = code.trim();
    if (!clean) return { accepted: false, reasonCode: "invalid_code" };
    setError("");
    try {
      if (clean.startsWith("NALVEN-POS.v1.")) {
        if (!data?.session) throw new Error("A leitura de QR interno exige turno aberto.");
        const response = await fetch("/api/erp/pdv/internal-qrs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "qr.resolve", sessionId: data.session.id, token: clean }), cache: "no-store" });
        const body = await responseBody(response), target = isRecord(body.target) ? body.target : null;
        if (!response.ok || !target) throw new Error(stringValue(body.error) || "QR interno indisponível.");
        const action = stringValue(target.action);
        if (activeOrderClaim && ["select_customer", "resume_held_cart", "apply_coupon_qr", "select_gift_card"].includes(action)) throw new Error("Este QR alteraria dados fixos do pedido reivindicado. Libere o claim antes de usá-lo.");
        if (action === "select_customer" && isRecord(target.customer)) {
          const customer = target.customer as PdvData["customers"][number];
          setData(current => current ? { ...current, customers: [...current.customers.filter(item => item.id !== customer.id), customer].sort((left, right) => left.name.localeCompare(right.name, "pt-BR")) } : current);
          setCustomerResults((current) => mergeById([customer], current));
          setSelectedCustomer(customer);
          setCustomerId(String(customer.id));
          await loadValueAccounts(String(customer.id));
          setPromotionQuote(null); setDiscountApproval(null); showNotice("Cliente identificado pelo QR interno.");
        } else if (action === "resume_held_cart" && isRecord(target.held)) {
          resume(target.held as PdvData["heldSales"][number]);
        } else if (action === "apply_coupon_qr" && isRecord(target.coupon)) {
          setCouponCode(""); setCouponQrToken(clean); setPromotionQuote(null); setDiscountApproval(null); showNotice(`Cupom QR ••••${stringValue(target.coupon.codeLastFour)} selecionado; recalcule a oferta.`);
        } else if (action === "select_gift_card" && isRecord(target.account)) {
          const payment = { ...newPayment("store_credit", Math.max(0, totalCents)), giftQrToken: clean };
          setPayments(current => current.length === 1 ? [payment] : [...current, payment]);
          showNotice(`Gift card ${stringValue(target.account.label)} selecionado; informe o PIN no pagamento.`);
        } else if (action === "open_receipt" && isRecord(target.sale)) {
          setLastSale(target.sale as PdvData["recentSales"][number]); openOperation("receipt"); showNotice("Recibo localizado pelo QR interno.");
        } else if (action === "lookup_order" && isRecord(target.order)) {
          setOrderLookupInput(stringValue(target.order.number) || String(target.order.id || ""));
          await lookupOrder(clean, true);
        } else throw new Error("O QR interno não possui uma ação operacional reconhecida.");
        return { accepted: true };
      }
      const response = await fetch("/api/erp/pdv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "scan.resolve", code: clean }) });
      const body = await responseBody(response);
      if (!response.ok) {
        setError(stringValue(body.error) || "Código não reconhecido.");
        return { accepted: false, reasonCode: response.status === 404 ? "not_found" : "processor_error" };
      }
      const rawProduct = isRecord(body.product) ? body.product : null;
      const fallback = data?.products.find((item) => item.id === Number(rawProduct?.id));
      const product = normalizeResolvedProduct(rawProduct, fallback);
      if (!product) {
        setError("O código foi reconhecido, mas o produto não possui dados suficientes para venda.");
        return { accepted: false, reasonCode: "invalid_code" };
      }
      setData((current) => current && !current.products.some((item) => item.id === product.id) ? { ...current, products: [product, ...current.products] } : current);
      add(product, isRecord(body.scan) ? body.scan : undefined);
      return { accepted: true };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar o código. Verifique a rede e tente novamente.");
      return { accepted: false, reasonCode: "processor_error" };
    }
  }

  scanCodeProcessor.current = processScanCode;

  async function quoteBestPromotion() {
    if (!data?.session || !lines.length) return;
    if (!discountApprovalPolicy) {
      setError("Revise o desconto manual: ele não pode superar o valor bruto da venda.");
      return;
    }
    if (discountApprovalPolicy.requiresApproval && !activeDiscountApproval) {
      setError("Solicite a aprovação excepcional e informe ao supervisor o ID gerado antes de recalcular.");
      return;
    }
    const requestSignature = promotionRequestSignature;
    setPromotionQuote(null);
    setQuoteBusy(true);
    const result = await mutate({
      action: "promotion.quote",
      sessionId: data.session.id,
      saleDraftId: saleIdempotencyKey.current,
      ...(activeOrderClaim ? { orderClaimId: activeOrderClaim.id, orderClaimVersion: activeOrderClaim.version } : {}),
      discountApprovalId: activeDiscountApproval?.id,
      customerId: customerId || undefined,
      couponCode: couponCode.trim() || undefined,
      couponQrToken: couponQrToken || undefined,
      discountCents,
      items: lines.map((line) => ({ productId: line.product.id, variationId: line.product.resolvedVariationId, quantity: line.quantity, discountCents: line.discountCents })),
    }, "", false).finally(() => setQuoteBusy(false));
    if (!result || !isRecord(result.quote)) return;
    const raw = result.quote;
    const quoted: PromotionQuote = {
      requestSignature,
      quoteHash: stringValue(raw.quoteHash),
      promotionId: nullableString(raw.promotionId),
      promotionName: nullableString(raw.promotionName),
      couponLastFour: nullableString(raw.couponLastFour),
      subtotalCents: Number(raw.subtotalCents),
      manualDiscountCents: Number(raw.manualDiscountCents),
      manualDiscountBasisPoints: Number(raw.manualDiscountBasisPoints),
      discountApprovalRequired: raw.discountApprovalRequired === true,
      discountApprovalId: nullableString(raw.discountApprovalId),
      promotionDiscountCents: Number(raw.promotionDiscountCents),
      surchargeCents: Number(raw.surchargeCents),
      totalCents: Number(raw.totalCents),
      evaluatedAt: stringValue(raw.evaluatedAt),
    };
    const quotedPaymentPlan = parsePaymentPlan(result.paymentPlan);
    if (!quoted.quoteHash || !quoted.evaluatedAt || !quotedPaymentPlan || quotedPaymentPlan.saleDraftId !== saleIdempotencyKey.current || quotedPaymentPlan.quoteHash !== quoted.quoteHash || quotedPaymentPlan.totalCents !== quoted.totalCents || !["quoted", "active"].includes(quotedPaymentPlan.state) || ![quoted.subtotalCents, quoted.manualDiscountCents, quoted.manualDiscountBasisPoints, quoted.promotionDiscountCents, quoted.surchargeCents, quoted.totalCents].every(Number.isSafeInteger) || quoted.totalCents <= 0 || quoted.manualDiscountCents !== discountApprovalPolicy.context.manualDiscountCents || quoted.discountApprovalRequired !== discountApprovalPolicy.requiresApproval || quoted.discountApprovalRequired && quoted.discountApprovalId !== activeDiscountApproval?.id) {
      setError("O servidor retornou uma cotação promocional inválida.");
      return;
    }
    setPromotionQuote(quoted);
    setPaymentPlan(quotedPaymentPlan);
    syncSinglePayment(quoted.totalCents);
  }

  async function activatePaymentPlan() {
    if (!data?.session || !currentPaymentPlan || currentPaymentPlan.state !== "quoted" || requestLock.current) return;
    if (proposedPaymentPlanSlots.some(slot => slot.proofKind === "manual")) {
      setError("A confirmação manual permanece desabilitada até o workflow de reconciliação 320000. Use intent eletrônico, dinheiro ou saldo local.");
      return;
    }
    if (proposedPaymentPlanSlots.some(slot => slot.amountCents <= 0 || slot.proofKind === "intent" && (!slot.connectorId || !slot.provider)) || proposedPaymentPlanSlots.reduce((sum, slot) => sum + slot.amountCents, 0) !== currentPaymentPlan.totalCents) {
      setError("Revise valores e conectores: as divisões devem ser contíguas e somar exatamente o total cotado.");
      return;
    }
    const signature = JSON.stringify({ planId: currentPaymentPlan.id, expectedVersion: currentPaymentPlan.version, slots: proposedPaymentPlanSlots });
    if (paymentPlanActivationAttempt.current.signature !== signature) paymentPlanActivationAttempt.current = { signature, key: crypto.randomUUID() };
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/payment-plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "plan.activate", sessionId: data.session.id, planId: currentPaymentPlan.id, expectedVersion: currentPaymentPlan.version, slots: proposedPaymentPlanSlots, idempotencyKey: paymentPlanActivationAttempt.current.key }),
      });
      const body = await responseBody(response), activated = parsePaymentPlan(body.paymentPlan);
      if (!response.ok || !activated || activated.id !== currentPaymentPlan.id || activated.state !== "active" || activated.version !== currentPaymentPlan.version + 1 || JSON.stringify(activated.slots) !== JSON.stringify(proposedPaymentPlanSlots)) {
        throw new Error(stringValue(body.error) || "O servidor não confirmou as divisões autoritativas.");
      }
      setPaymentPlan(activated);
      showNotice(body.replayed ? "Plano de pagamento ativo recuperado." : "Divisões e fontes de prova congeladas no servidor.", 5000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível ativar o plano de pagamento.");
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function submitSale(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || !data?.session || !lines.length) return;
    if (checkoutStep === "items") {
      if (!activePromotionQuote) {
        setError(quoteBusy ? "Aguarde a validação automática do total." : "Não foi possível validar o total automaticamente. Use Atualizar total e tente novamente.");
        return;
      }
      setError("");
      setCheckoutStep("payment");
      return;
    }
    if (!online) {
      setError("Reconecte o terminal antes de concluir a venda.");
      return;
    }
    if (recoveryCheckoutBlocked) {
      setError(draftOperationalError || "Aguarde a persistência e a validação do rascunho server-side antes de concluir.");
      return;
    }
    if (orderClaimCheckoutBlocked) {
      setError(orderClaimError || "A posse do pedido não está vigente. Atualize ou libere o claim antes de cobrar.");
      return;
    }
    if (!activePromotionQuote) {
      setError("Recalcule os preços e a melhor oferta antes de concluir a venda.");
      return;
    }
    if (!paymentsValid) {
      setError(!paymentPlanSlotsMatch ? "Ative e confirme o plano autoritativo destas divisões antes de concluir." : remainingCents > 0 ? `Ainda faltam ${money(remainingCents)} em pagamentos.` : remainingCents < 0 ? `Os pagamentos excedem o total em ${money(Math.abs(remainingCents))}.` : "Revise os valores recebidos e as confirmações dos pagamentos.");
      return;
    }
    submitting.current = true;
    try {
      const normalizedPayments = payments.map((payment) => {
        if (payment.method === "cash") return { tenderedCents: payment.needsChange ? parseMoney(payment.tendered) : parseMoney(payment.amount) };
        if (payment.method === "store_credit") return {
          valueAccountId: payment.valueAccountId || undefined,
          valueUnits: payment.valueAccountId && valueAccounts.find((account) => account.id === payment.valueAccountId)?.unit === "points" ? payment.valueUnits : undefined,
          giftCode: payment.giftCode.trim() || undefined,
          giftPin: payment.giftPin,
          giftQrToken: payment.giftQrToken || undefined,
        };
        return payment.proofMode === "intent" ? { paymentIntentId: payment.electronicIntent?.id } : { manualReferenceId: payment.manualReference?.id };
      });
      const result = await mutate({
        action: "sale.commit",
        sessionId: data.session.id,
        idempotencyKey: saleIdempotencyKey.current,
        paymentPlanId: currentPaymentPlan!.id,
        paymentPlanVersion: currentPaymentPlan!.version,
        discountApprovalId: activeDiscountApproval?.id,
        customerId: customerId || undefined,
        couponCode: couponCode.trim() || undefined,
        couponQrToken: couponQrToken || undefined,
        discountCents,
        promotionQuote: {
          quoteHash: activePromotionQuote.quoteHash,
          promotionId: activePromotionQuote.promotionId,
          promotionDiscountCents: activePromotionQuote.promotionDiscountCents,
          totalCents: activePromotionQuote.totalCents,
        },
        notes,
        fulfillmentMode,
        ...(activeHeldSaleId ? { heldSaleId: activeHeldSaleId } : {}),
        ...(activeOrderClaim ? { orderClaimId: activeOrderClaim.id, orderClaimVersion: activeOrderClaim.version } : {}),
        items: lines.map((line) => ({ productId: line.product.id, variationId: line.product.resolvedVariationId, quantity: line.quantity, discountCents: line.discountCents, scanData: line.scanData })),
        payments: normalizedPayments,
      }, "Venda concluída com estoque, caixa e auditoria atualizados.");
      if (!result) return;
      const sale = result.sale as PdvData["recentSales"][number];
      setLastSale(sale);
      resetSale();
      openOperation("receipt");
      await load();
    } finally {
      submitting.current = false;
    }
  }

  async function hold() {
    if (!data?.session || !lines.length) return;
    if (activeOrderClaim) {
      setError("Pedidos reivindicados não podem virar suspensão comum. Conclua ou libere o claim com segurança.");
      return;
    }
    if (anyPaymentIntentLocked) {
      setError("Reconcilie ou cancele com segurança a intenção eletrônica antes de suspender esta venda.");
      return;
    }
    if (!draftReady) {
      setError("Aguarde a confirmação server-side do rascunho antes de suspender a venda.");
      return;
    }
    if (activeHeldSaleId) {
      setError("Esta venda já veio de uma suspensão. Conclua-a ou limpe a venda para manter apenas a suspensão original.");
      return;
    }
    const command = { action: "cart.hold", sessionId: data.session.id, customerId: customerId || undefined, notes, fulfillmentMode, discountCents, items: lines.map((line) => ({ productId: line.product.id, variationId: line.product.resolvedVariationId, quantity: line.quantity, unitPriceCents: line.product.priceCents, discountCents: line.discountCents, scanData: line.scanData })) };
    const signature = JSON.stringify(command);
    if (holdAttempt.current.signature !== signature) {
      holdAttempt.current = { signature, key: crypto.randomUUID(), label: `Carrinho ${new Date().toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone(), hour: "2-digit", minute: "2-digit" })}` };
    }
    const result = await mutate({ ...command, idempotencyKey: holdAttempt.current.key, label: holdAttempt.current.label }, "Venda suspensa para retomada.");
    if (result) {
      if (persistedDraft?.source === "draft" && !await discardServerDraft(persistedDraft, true)) return;
      else if (persistedDraft?.source !== "draft") resetSale();
      await load();
    }
  }

  async function discardHeld(held: PdvData["heldSales"][number]) {
    if (!data?.session) return;
    const clearResumedCart = activeHeldSaleId === held.id;
    const confirmed = window.confirm(clearResumedCart ? `Descartar ${held.label || "esta venda suspensa"} e limpar o carrinho retomado?` : `Descartar definitivamente ${held.label || "esta venda suspensa"}?`);
    if (!confirmed) return;
    const idempotencyKey = discardIdempotencyKeys.current[held.id] || crypto.randomUUID();
    discardIdempotencyKeys.current[held.id] = idempotencyKey;
    const result = await mutate({ action: "cart.discard", sessionId: data.session.id, heldSaleId: held.id, expectedRevision: held.revision, idempotencyKey }, "Venda suspensa descartada.");
    if (!result) return;
    delete discardIdempotencyKeys.current[held.id];
    if (clearResumedCart) resetSale();
    await load();
  }

  async function openHeldTransfer(held: PdvData["heldSales"][number]) {
    if (!data?.session || requestLock.current) return;
    if (activeHeldSaleId === held.id) {
      setError("Limpe o carrinho retomado antes de transferir sua suspensão para outro operador.");
      return;
    }
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ heldSaleId: held.id, sourceSessionId: String(data.session.id) });
      const response = await fetch(`/api/erp/pdv/held-sales/transfer?${params}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok || !Array.isArray(body.targets)) throw new Error(stringValue(body.error) || "Não foi possível consultar os destinos autorizados.");
      const revision = Number(body.revision);
      if (!Number.isSafeInteger(revision) || revision !== held.revision) {
        await load();
        throw new Error("O carrinho mudou. A lista foi atualizada; selecione-o novamente.");
      }
      setHeldTransfer(held);
      setHeldTransferTargets(body.targets as HeldTransferTarget[]);
      openOperation("held-transfer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível consultar os destinos autorizados.");
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function transferHeld(targetSessionId: number, reason: string) {
    if (!data?.session || !heldTransfer || requestLock.current) return false;
    const signature = JSON.stringify({ heldSaleId: heldTransfer.id, sourceSessionId: data.session.id, targetSessionId, expectedRevision: heldTransfer.revision, reason });
    const current = heldTransferAttempts.current[heldTransfer.id];
    const attempt = current?.signature === signature ? current : { signature, key: crypto.randomUUID() };
    heldTransferAttempts.current[heldTransfer.id] = attempt;
    requestLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/pdv/held-sales/transfer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ heldSaleId: heldTransfer.id, sourceSessionId: data.session.id, targetSessionId, expectedRevision: heldTransfer.revision, idempotencyKey: attempt.key, reason }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(stringValue(body.error) || "Não foi possível transferir o carrinho.");
      delete heldTransferAttempts.current[heldTransfer.id];
      setHeldTransfer(null);
      setHeldTransferTargets([]);
      closeOperation();
      showNotice(body.replayed ? "Transferência já confirmada anteriormente." : "Carrinho transferido e auditado no turno receptor.", 5000);
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível transferir o carrinho.");
      return false;
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  function resume(held: PdvData["heldSales"][number]) {
    if (!data) return;
    if (Object.keys(cartRef.current).length) {
      setError("Limpe ou suspenda a venda atual antes de retomar outra.");
      return;
    }
    const restored: Record<string, CartLine> = {};
    for (const item of held.items) {
      const baseProduct = data.products.find((entry) => entry.id === item.productId) || (item.product ? { ...item.product, priceCents: item.unitPriceCents, stock: null } : null);
      if (baseProduct) {
        const product = { ...baseProduct, resolvedVariationId: item.variationId, priceCents: item.unitPriceCents };
        restored[cartKey(product)] = { product, quantity: product.soldIndividually ? 1 : item.quantity, discountCents: item.discountCents, scanData: item.scanData };
      }
    }
    if (!Object.keys(restored).length) {
      setError("Os produtos desta venda suspensa não estão disponíveis no catálogo carregado.");
      return;
    }
    resetSale();
    saleIdempotencyKey.current = held.id;
    setDiscount(formatInput(held.discountCents));
    replaceCart(restored, held.discountCents);
    setActiveHeldSaleId(held.id);
    const heldCustomer = held.customerId ? [...customerResults, ...data.customers].find((customer) => customer.id === held.customerId) || null : null;
    setCustomerId(held.customerId ? String(held.customerId) : "");
    setSelectedCustomer(heldCustomer);
    void loadValueAccounts(held.customerId ? String(held.customerId) : "");
    setNotes(held.notes || "");
    setNoteExpanded(Boolean(held.notes));
    setFulfillmentMode(held.fulfillmentMode || "on_site");
    setPersistedDraft({ id: held.id, revision: held.revision, signature: recoveryDraftSignature(held.id, data.session?.id || 0, held.customerId ?? null, held.notes || "", held.fulfillmentMode || "on_site", held.discountCents, held.surchargeCents || 0, Object.values(restored)), source: "held" });
    showNotice("Venda suspensa retomada.");
  }

  function updateQuantity(key: string, rawValue: string) {
    if (activeOrderClaim) { setOrderClaimError("A quantidade aprovada do pedido não pode ser alterada no PDV."); return; }
    const current = cartRef.current;
    const line = current[key];
    if (!line || line.product.soldIndividually) return;
    if (anyPaymentIntentLocked || hasCodeReads(line.scanData)) return;
    if (hasTrackingReads(line.scanData)) {
      setError("A quantidade de uma linha com lote/série é definida pelas leituras. Remova a linha e leia novamente para alterá-la.");
      return;
    }
    if (!rawValue.trim()) return;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const quantity = Number.isFinite(parsed) ? Math.max(0.001, Math.round(parsed * 1000) / 1000) : line.quantity;
    if (line.product.stock != null && quantity > line.product.stock) {
      setError(`A quantidade supera o estoque disponível de ${line.product.name}.`);
      return;
    }
    replaceCart({ ...current, [key]: { ...line, quantity } });
    setError("");
  }

  function updateLineDiscount(key: string, value: string) {
    if (activeOrderClaim) { setOrderClaimError("O desconto aprovado do item não pode ser alterado no PDV."); return; }
    const current = cartRef.current;
    const line = current[key];
    if (!line) return;
    const maximum = Math.round(line.product.priceCents * line.quantity);
    replaceCart({ ...current, [key]: { ...line, discountCents: Math.min(parseMoney(value), maximum) } });
  }

  function addPayment() {
    if (activeOrderClaim) { setOrderClaimError("O pagamento aprovado do pedido não pode ser dividido no PDV."); return; }
    const remaining = Math.max(0, totalCents - paidCents);
    setPayments((current) => [...current, { ...newPayment("pix", remaining), terminalId: activeTerminal?.id || "" }]);
  }

  function removePayment(key: string) {
    if (activeOrderClaim) { setOrderClaimError("O pagamento aprovado do pedido não pode ser removido no PDV."); return; }
    setPayments((current) => {
      if (current.some(payment => payment.key === key && isPdvPaymentIntentLocked(payment.electronicIntent))) return current;
      const next = current.filter((payment) => payment.key !== key).map((payment) => ({ ...payment, manualReference: null }));
      if (next.length !== 1) return next;
      const payment = next[0];
      const amount = formatInput(totalCents);
      return [{ ...payment, amount, tendered: payment.method === "cash" ? amount : payment.tendered }];
    });
  }

  function updateOrderDiscount(value: string) {
    if (activeOrderClaim) { setOrderClaimError("O desconto aprovado do pedido não pode ser alterado no PDV."); return; }
    setDiscount(value);
    setPromotionQuote(null);
    setDiscountApproval(null);
    discountApprovalAttempt.current = { signature: "", key: crypto.randomUUID() };
    syncSinglePayment(Math.max(0, subtotalCents - parseMoney(value)));
  }

  function changePaymentMethod(key: string, rawMethod: string) {
    if (activeOrderClaim) { setOrderClaimError("O meio aprovado do pedido não pode ser alterado no PDV."); return; }
    const method = supportedPaymentMethod(rawMethod);
    const eligibleConnectors = electronicPaymentConnectors.filter(connector => !connector.settings?.methods?.length || connector.settings.methods.includes(method));
    setPayments((current) => current.map((payment) => payment.key === key ? {
      ...payment,
      method,
      tendered: method === "cash" ? formatInput(Math.max(parseMoney(payment.tendered), parseMoney(payment.amount))) : payment.tendered,
      reference: "",
      provider: "",
      confirmationOccurredAt: "",
      confirmationReason: "",
      manualReference: null,
      electronicIntent: null,
      connectorId: eligibleConnectors.length === 1 ? eligibleConnectors[0].id : "",
      terminalId: activeTerminal?.id || "",
      installments: "1",
      proofMode: "intent",
      valueAccountId: "",
      valueUnits: "",
      giftCode: "",
      giftPin: "",
      giftQrToken: "",
    } : payment));
  }

  function openOperation(next: Exclude<typeof operation, null>) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOperation(next);
  }

  function restoreFocus() {
    window.setTimeout(() => returnFocus.current?.focus(), 0);
  }

  function stopCamera() {
    cameraDecoderCancel.current?.();
    cameraDecoderCancel.current = null;
    cameraDecoderControls.current?.stop();
    cameraDecoderControls.current = null;
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    if (cameraVideo.current) cameraVideo.current.srcObject = null;
  }

  function closeOperation() {
    if (operation === "camera") stopCamera();
    if (operation === "held-transfer") { setHeldTransfer(null); setHeldTransferTargets([]); }
    setOperation(null);
    restoreFocus();
  }

  async function openCamera() {
    if (busy) return;
    if (!cameraAvailable) {
      setError("Nenhuma câmera está configurada neste terminal. Cadastre uma câmera USB nas configurações do PDV ou use um celular.");
      return;
    }
    openOperation("camera");
    setError("");
    let detectedCode: string | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador não oferece acesso à câmera.");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      cameraStream.current = stream;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!cameraVideo.current) throw new Error("Não foi possível iniciar a visualização da câmera.");
      cameraVideo.current.srcObject = stream;
      await cameraVideo.current.play();
      detectedCode = await detectCamera();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível acessar a câmera. Verifique a permissão do navegador.");
    } finally {
      stopCamera();
      setOperation((current) => current === "camera" ? null : current);
      restoreFocus();
    }
    if (detectedCode) enqueueScanCode(detectedCode, `camera:${++scanCaptureSequence.current}`);
  }

  async function detectCamera() {
    const Detector = (window as unknown as { BarcodeDetector?: new (settings: { formats: string[] }) => { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    if (Detector) {
      const detector = new Detector({ formats: ["ean_8", "ean_13", "upc_a", "upc_e", "code_39", "code_128", "itf", "qr_code", "data_matrix"] });
      while (cameraStream.current && cameraVideo.current) {
        try {
          const codes = await detector.detect(cameraVideo.current);
          if (codes[0]?.rawValue) return codes[0].rawValue;
        } catch {
          // Alguns navegadores rejeitam os primeiros quadros enquanto o vídeo estabiliza.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      return null;
    }
    const stream = cameraStream.current, video = cameraVideo.current;
    if (!stream || !video) return null;
    const { BrowserMultiFormatReader } = await import("@zxing/browser");
    const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 500 });
    return new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const finish = (value: string | null, cause?: unknown) => {
        if (settled) return;
        settled = true;
        cameraDecoderCancel.current = null;
        if (cause) reject(cause);
        else resolve(value);
      };
      cameraDecoderCancel.current = () => finish(null);
      void reader.decodeFromStream(stream, video, (result, _error, controls) => {
        cameraDecoderControls.current = controls;
        const value = result?.getText().trim();
        if (!value) return;
        controls.stop();
        finish(value);
      }).then((controls) => {
        cameraDecoderControls.current = controls;
        if (settled) controls.stop();
      }).catch((cause) => finish(null, cause));
    });
  }

  function requestCloseShift() {
    if (Object.keys(cartRef.current).length) {
      setError("Limpe ou suspenda a venda atual antes de fechar o turno.");
      scanRef.current?.focus();
      return;
    }
    openOperation("close");
  }

  function requestShiftLifecycle() {
    if (Object.keys(cartRef.current).length) {
      setError("Limpe ou suspenda a venda atual antes de pausar ou passar o turno.");
      scanRef.current?.focus();
      return;
    }
    openOperation("shift-lifecycle");
  }

  function startPostSale(sale: PdvData["recentSales"][number], kind: "cancel" | "return") {
    if (kind === "cancel" ? sale.status !== "completed" : !isReturnEligibleSale(sale)) {
      setError(kind === "cancel" ? "Somente vendas concluídas e ainda não devolvidas podem ser canceladas." : "A venda não possui saldo de itens elegível para uma nova devolução.");
      return;
    }
    if (!isLocallyReversibleSale(sale)) {
      setError("O pós-venda de meios eletrônicos externos permanece bloqueado até existir confirmação server-side de um conector homologado.");
      return;
    }
    setError("");
    setLastSale(sale);
    openOperation(kind);
  }

  if (!data) return <section className="pos-bootstrap-state" role="status"><span>PDV</span><h2>{error ? "Não foi possível iniciar o caixa" : "Preparando seu ambiente de venda"}</h2><p>{error || "Carregando usuário, caixas atribuídos, terminal e catálogo…"}</p><div><button className="button primary" type="button" onClick={() => void load()}>Tentar novamente</button>{error && <Link className="button ghost" href="/login">Entrar novamente</Link>}</div></section>;
  const currentRegister = activeRegister;

  return <div ref={workspaceRef} className={`pos-workspace pos-shell${pdvMenuCollapsed ? " menu-collapsed" : ""}${pdvMenuOpen ? " menu-open" : ""}`} aria-busy={busy}>
    <button type="button" className="pos-rail-backdrop" aria-label="Fechar menu do PDV" onClick={() => setPdvMenuOpen(false)} />
    <aside className="pos-rail" aria-label="Menu do ponto de venda">
      <header><span className="pos-rail-mark">N</span><strong>PDV</strong><button type="button" title={pdvMenuCollapsed ? "Expandir menu do PDV" : "Recolher menu do PDV"} aria-label={pdvMenuCollapsed ? "Expandir menu do PDV" : "Recolher menu do PDV"} onClick={() => setPdvMenuCollapsed(value => !value)}>{pdvMenuCollapsed ? "›" : "‹"}</button></header>
      <nav>
        <button type="button" onClick={() => { setPdvMenuOpen(false); if (Object.keys(cartRef.current).length) void clearCurrentSale(); else { resetSale(); showNotice("Nova venda preparada."); } }}><span>▱</span><b>Nova venda</b><kbd>F1</kbd></button>
        <button type="button" className={quickTool === "products" ? "active" : ""} onClick={() => { setQuickTool("products"); setPdvMenuOpen(false); }}><span>✣</span><b>Produtos</b><kbd>F2</kbd></button>
        <button type="button" className={quickTool === "customer" ? "active" : ""} onClick={() => { setQuickTool("customer"); setPdvMenuOpen(false); }}><span>♙</span><b>Cliente</b><kbd>F3</kbd></button>
        <button type="button" className={quickTool === "order" ? "active" : ""} onClick={() => { setQuickTool("order"); setPdvMenuOpen(false); }}><span>▤</span><b>Pedido</b><kbd>F4</kbd></button>
        <button type="button" disabled={!data.heldSales.length} onClick={() => { setPdvMenuOpen(false); document.querySelector<HTMLElement>(".pos-held")?.scrollIntoView({ behavior: "smooth", block: "center" }); }}><span>◷</span><b>Vendas suspensas</b><em>{data.heldSales.length}</em></button>
        <button type="button" disabled={!data.session || busy} onClick={() => { setPdvMenuOpen(false); openOperation("cash"); }}><span>⇅</span><b>Movimentar caixa</b><kbd>F6</kbd></button>
        <button type="button" onClick={() => { setPdvMenuOpen(false); openOperation("recent"); }}><span>▧</span><b>Consultar vendas</b><kbd>F7</kbd></button>
      </nav>
      <footer>
        <button className="pos-rail-checkout" type="button" title={checkoutStep === "items" ? "Abrir pagamento (F12)" : "Concluir venda (F12)"} disabled={busy || !online || recoveryCheckoutBlocked || orderClaimCheckoutBlocked || !lines.length || !activePromotionQuote || totalCents <= 0 || checkoutStep === "payment" && !paymentsValid} onClick={() => { setPdvMenuOpen(false); if (checkoutStep === "items") { setCheckoutStep("payment"); setMobileCartOpen(true); } else document.querySelector<HTMLFormElement>("#pos-current-sale")?.requestSubmit(); }}><span>✓</span><b>{checkoutStep === "items" ? "Cobrar" : "Concluir venda"}</b><kbd>F12</kbd></button>
        <button type="button" disabled={!activeHeldSaleId} onClick={() => { setPdvMenuOpen(false); const held = data.heldSales.find(item => item.id === activeHeldSaleId); if (held) void openHeldTransfer(held); }}><span>⇄</span><b>Transferir carrinho</b></button>
        <button type="button" disabled={!lines.length} onClick={() => { setPdvMenuOpen(false); void clearCurrentSale(); }}><span>⌫</span><b>Descartar venda</b></button>
        <button type="button" onClick={() => { setPdvMenuOpen(false); openOperation("more"); }}><span>?</span><b>Recursos e atalhos</b></button>
      </footer>
    </aside>
    <header className={`pos-statusbar${statusExpanded ? " details-open" : " details-collapsed"}`}>
      <div className="pos-status-title"><button type="button" className="pos-mobile-menu" aria-label="Abrir menu do PDV" onClick={() => setPdvMenuOpen(true)}>☰</button><span><small>OPERAÇÃO · {data.branch.name} ({data.branch.code})</small><strong>Ponto de venda</strong></span></div>
      <div className="pos-status-summary">
        <span className={data.session ? "ok pos-shift-chip" : "warn pos-shift-chip"}><i /><b>{data.session ? "Caixa aberto" : "Caixa fechado"}</b></span>
        <span className="ok pos-branch-chip"><i /><b>Filial: {data.branch.name}</b></span>
        <span className="pos-operator-chip"><small>Operador:</small><b>{data.operator.name}</b></span>
        <span className="pos-register-chip"><b>{currentRegister?.name || "Sem caixa"}</b></span>
        <span className={`pos-online-chip ${online ? "ok" : "warn"}`}><i /><b>{online ? "Online" : "Offline"}</b></span>
        <span className={heartbeatTerminalId ? "ok pos-terminal-chip" : "warn pos-terminal-chip"}><i /><b>{heartbeatTerminalId ? "Terminal sincronizado" : "Validando terminal"}</b></span>
      </div>
      <nav className="pos-status-actions" aria-label="Ações do PDV">
        {data.session?.status === "open" && <><button type="button" disabled={busy || !currentRegister?.access.canSupply} onClick={() => { setCashOperation("supply"); openOperation("cash"); }}>⇩ Entrada de caixa</button><button type="button" disabled={busy} onClick={() => { setCashOperation("withdrawal"); openOperation("cash"); }}>⇧ Retirada / Sangria</button><button type="button" disabled={busy || !lines.length || Boolean(activeOrderClaim)} onClick={() => void hold()}>◉ Suspender venda</button></>}
        <button type="button" disabled={busy} onClick={() => openOperation("recent")}>▧ Consultar</button>
        <button type="button" disabled={busy} onClick={() => openOperation("more")}>⋮ Mais opções⌄</button>
      </nav>
    </header>
    <PdvToastViewport notice={notice} error={error} clearNotice={() => setNotice("")} clearError={() => setError("")} />
    {data.session?.status === "open" && (draftRecovery.loading || hasServerRecovery || draftOperationalError || lines.length > 0) && <button type="button" className={`pos-recovery-trigger ${draftRecovery.mode === "blocked" || draftRecovery.mode === "error" || draftOperationalError ? "blocked" : ""}`} onClick={() => { setRecoveryFeedback(null); openOperation("recovery"); }}><span><i />{draftReady ? draftSaving ? "Salvando venda…" : "Venda protegida no servidor" : draftRecovery.loading && hasServerRecovery ? "Verificando recuperação…" : draftOperationalError ? "Falha ao salvar a venda" : "Salvando venda no servidor…"}</span><small>Detalhes</small></button>}
    {operation === "recovery" && data.session?.status === "open" && <PdvAccessibleModal open title="Proteção da venda" description="Acompanhe o salvamento do carrinho e recupere somente estados confirmados pelo servidor." busy={busy} returnFocusRef={returnFocus} overlayClassName="pos-recovery-dialog" dialogClassName="pos-recovery-modal" onRequestClose={closeOperation}><section className={`pos-draft-recovery ${draftRecovery.mode === "blocked" || draftRecovery.mode === "error" || draftOperationalError ? "blocked" : ""}`} aria-busy={draftRecovery.loading}>
      <header><div><strong>{draftRecovery.mode === "restore" ? "Rascunho recuperado" : hasServerRecovery ? "Recuperação pendente" : "Venda atual"}</strong><small>{draftRecovery.loading ? "Consultando o servidor…" : draftRecovery.mode === "restore" ? "Carrinho restaurado e protegido" : draftRecovery.mode === "blocked" ? "Ação necessária antes do checkout" : draftRecovery.mode === "error" ? "Não foi possível confirmar o estado" : draftReady ? draftSaving ? "Atualizando a proteção…" : "Carrinho protegido no servidor" : "Aguardando confirmação do servidor"}</small></div><button type="button" disabled={busy || draftRecovery.loading} onClick={() => void refreshDraftRecovery()}>{draftRecovery.loading ? "Atualizando…" : "Atualizar estado"}</button></header>
      {recoveryFeedback && <PdvRecoveryFeedback feedback={recoveryFeedback} />}
      {draftOperationalError && <p className="tenant-error" role="alert">{draftOperationalError}</p>}
      {draftRecovery.mode === "blocked" && <div role="alert"><strong>Recuperação ambígua ou pagamento órfão</strong><p>Nenhum carrinho foi escolhido por valor, horário ou proximidade. Reconcilie os IDs exatos ou descarte somente rascunhos sem prova financeira ativa.</p>{draftRecovery.issues.length > 0 && <ul>{draftRecovery.issues.map((issue, index) => <li key={`${issue.code}:${issue.intentId || issue.manualReferenceId || issue.draftId || index}`}>{draftRecoveryIssueLabel(issue.code)}{issue.intentId ? ` · intent ${issue.intentId}` : issue.manualReferenceId ? ` · referência ${issue.manualReferenceId}` : ""}</li>)}</ul>}</div>}
      {draftRecovery.drafts.length > 0 && draftRecovery.mode === "blocked" && <div className="pos-draft-recovery-list"><strong>Rascunhos persistidos</strong>{draftRecovery.drafts.map(draft => <article key={draft.id}><code>{draft.id}</code><small>{draft.items.length} itens · revisão {draft.revision}</small><button type="button" disabled={busy || draftRecovery.intents.some(intent => intent.saleDraftId === draft.id) || draftRecovery.manualReferences.some(reference => reference.saleDraftId === draft.id)} onClick={() => { if (window.confirm("Descartar este rascunho server-side? Pagamentos não serão cancelados nem estornados.")) void discardServerDraft(draft); }}>Descartar rascunho seguro</button></article>)}</div>}
      {draftRecovery.intents.length > 0 && <div className="pos-draft-recovery-list"><strong>Intenções não consumidas</strong>{draftRecovery.intents.map(intent => <article key={intent.id}><code>{intent.id}</code><small>{paymentLabels[intent.method] || intent.method} · {money(intent.amountCents)} · {intent.status} · draft {intent.saleDraftId}</small>{intent.status === "created" ? <button type="button" disabled={busy} onClick={() => void cancelRecoveryIntent(intent)}>Cancelar somente pré-dispatch</button> : ["processing", "authorized", "unknown", "manual_review"].includes(intent.status) ? <button type="button" disabled={busy || !online} onClick={() => void reconcileRecoveryIntent(intent)}>Consultar / reconciliar</button> : <span>{intent.status === "captured" ? "Captura órfã: não descartar, estornar nem repetir cobrança." : "Atualize o estado antes de agir."}</span>}</article>)}</div>}
      {draftRecovery.manualReferences.length > 0 && <div className="pos-draft-recovery-list"><strong>Referências manuais não consumidas</strong>{draftRecovery.manualReferences.map(reference => <article key={reference.id}><code>{reference.id}</code><small>{paymentLabels[reference.method] || reference.method} · {money(reference.amountCents)} · {reference.status} · final ••••{reference.referenceLastFour} · draft {reference.saleDraftId}</small>{reference.status === "rejected" ? <button type="button" disabled={busy || !online} onClick={() => void revokeRecoveryManualReference(reference)}>Revogar rejeição com auditoria</button> : <span>{reference.status === "approved" ? "Aprovação vigente recuperável; não crie outra prova." : reference.status === "pending" ? "Aguarde decisão independente e atualize o estado." : "Estado expirado: o slot permanece bloqueado até existir reconciliação contextual aprovada; não repita a cobrança."}</span>}</article>)}</div>}
      <small>{hasServerRecovery ? "Nenhum dado desta recuperação é salvo em localStorage; PINs, tokens, segredos, aprovações e prova eletrônica não fazem parte do rascunho." : "A venda atual é persistida somente no servidor; PINs, tokens, segredos, aprovações e provas eletrônicas não são armazenados no navegador."}</small>
    </section></PdvAccessibleModal>}
    {!data.registers.length ? <section className="tenant-panel pos-blocked"><h2>Nenhum caixa liberado</h2><p>Associe este funcionário a um caixa ativo na filial {data.branch.name}.</p></section> : !data.session ? <>
      {sessionLifecycle.incoming.length > 0 && <IncomingSessionHandoffs handoffs={sessionLifecycle.incoming} busy={busy} onAccept={async (handoff) => Boolean(await mutateSessionLifecycle({ action: "session.handoff.accept", sessionId: handoff.session.id, handoffId: handoff.id, expectedSessionVersion: handoff.session.version, expectedHandoffRevision: handoff.revision }, "Turno recebido com identidade própria e carrinhos suspensos preservados."))} />}
      <OpenShift operatorName={data.operator.name} branchName={data.branch.name} registers={data.registers} busy={busy} onSubmit={async (payload) => {
      setBusy(true); setError("");
      try {
        const activationResponse = await fetch("/api/erp/pdv/offline-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "credential.issue", terminalId: payload.terminalId, ttlMinutes: 480, idempotencyKey: `online.activate:${crypto.randomUUID()}` }) });
        const activation = await responseBody(activationResponse);
        if (!activationResponse.ok) throw new Error(stringValue(activation.error) || "Não foi possível ativar este terminal para o operador.");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Não foi possível ativar este terminal para o operador.");
        return false;
      } finally {
        setBusy(false);
      }
      const result = await mutate({ action: "session.open", ...payload }, "Turno aberto e vinculado ao terminal.");
      if (!result) return false;
      resetSale();
      await load();
      return true;
      }} />
    </> : data.session.status === "suspended" ? <SuspendedSessionPanel session={data.session} handoff={sessionLifecycle.session?.id === data.session.id ? sessionLifecycle.session.handoffs[0] || null : null} busy={busy} onResume={async () => Boolean(await mutateSessionLifecycle({ action: "session.resume", sessionId: data.session!.id, expectedVersion: data.session!.version }, "Turno retomado."))} onCancel={async (handoff, reason) => Boolean(await mutateSessionLifecycle({ action: "session.handoff.cancel", sessionId: data.session!.id, handoffId: handoff.id, expectedSessionVersion: data.session!.version, expectedHandoffRevision: handoff.revision, reason }, "Passagem cancelada; o turno voltou ao operador de origem."))} /> : <>
      <div className="pos-main"><div className="pos-left-stack">
      <section className={`pos-quickbar${quickTool ? " expanded" : ""}`} aria-label="Busca e ferramentas da venda">
        <nav className="pos-quickbar-tabs" aria-label="Ferramentas rápidas">
          <button type="button" className={quickTool === "products" ? "active" : ""} aria-expanded={quickTool === "products"} onClick={() => setQuickTool("products")}><span aria-hidden="true">◆</span><b>Buscar por Produtos</b><small>{products.length} exibidos</small></button>
          <button type="button" className={quickTool === "customer" ? "active" : ""} aria-expanded={quickTool === "customer"} onClick={() => setQuickTool("customer")}><span aria-hidden="true">♙</span><b>Buscar por Cliente</b><small>{selectedCustomer?.tradeName || selectedCustomer?.name || data.settings.defaultCustomerName}</small></button>
          <button type="button" aria-haspopup="dialog" onClick={() => openOperation("recent")}><span aria-hidden="true">▧</span><b>Buscar por Venda</b><small>Consultar vendas</small></button>
        </nav>
        <p className="pos-search-help">Detalhe: busque produtos para adicionar ao carrinho, selecione o cliente ou consulte uma venda. <button type="button" onClick={() => setQuickTool("order")}>Buscar pedido aprovado</button></p>
        <label className="pos-quickbar-info-toggle">Mostrar informações<input type="checkbox" checked={statusExpanded} onChange={(event) => setStatusExpanded(event.target.checked)} /><span aria-hidden="true" /></label>
        <div ref={quickbarContentRef} className="pos-quickbar-content">
        {quickTool === "scanner" && scannerConfigured && <form className="pos-reader-control" aria-busy={scanQueueProcessing} onSubmit={(event) => {
          event.preventDefault();
          if (enqueueScanCode(scan, `input:${scanInputRevision.current}`)) setScan("");
        }}>
          <div className="pos-control-heading"><label htmlFor="pos-scan">Leitor de código</label><kbd>F2</kbd><span>{activeTerminal?.name}</span></div>
          <div className="pos-reader-input"><input id="pos-scan" ref={scanRef} disabled={Boolean(operation)} value={scan} aria-describedby="pos-scan-queue-status" aria-keyshortcuts="F2 Enter" onChange={(event) => { scanInputRevision.current += 1; setScan(event.target.value); }} placeholder="EAN, GTIN, SKU, GS1 ou QR" autoComplete="off" /><button className="button primary" disabled={Boolean(operation) || !scan.trim()}>Adicionar</button>{cameraAvailable && <button className="button ghost" type="button" disabled={busy} onClick={() => void openCamera()}>Câmera</button>}</div>
          <small id="pos-scan-queue-status" role="status" aria-live="polite">{scanQueueProcessing ? "Processando leitura" : busy ? "Leitor temporariamente bloqueado" : "Leitor pronto"} · {scanQueueDepth} na fila{lastScanResult ? ` · ${posScannerResultStatus(lastScanResult)}` : ""}</small>
          {scanQueueError && <div className="tenant-error" role="alert">{scanQueueError}<button type="button" onClick={() => setScanQueueError("")}>Fechar</button></div>}
        </form>}
        {quickTool === "scanner" && !scannerConfigured && cameraAvailable && <div className="pos-camera-panel"><span>Use a câmera deste dispositivo para ler códigos.</span><button type="button" className="button primary" disabled={busy} onClick={() => void openCamera()}>Abrir câmera</button></div>}
        {quickTool === "products" && <div className="pos-catalog-controls"><label htmlFor="pos-catalog-search"><span className="sr-only">Buscar produto</span><div className="pos-search-field"><span aria-hidden="true">⌕</span><input id="pos-catalog-search" autoFocus type="search" value={query} maxLength={100} aria-controls="pos-catalog-grid" aria-describedby="pos-catalog-search-status" onChange={(event) => { setCatalogLoading(true); setQuery(event.target.value); }} placeholder="Buscar produto, SKU ou código de barras" /><button type="button" disabled={!scannerConfigured} title={scannerConfigured ? "Abrir leitor de código" : "Nenhum leitor configurado"} onClick={() => { setQuickTool("scanner"); window.requestAnimationFrame(() => scanRef.current?.focus()); }}>▥</button><button type="button" disabled={!scannerConfigured} title="Atalho do leitor" onClick={() => { setQuickTool("scanner"); window.requestAnimationFrame(() => scanRef.current?.focus()); }}><kbd>F2</kbd></button>{cameraAvailable && <button type="button" aria-label="Abrir câmera" onClick={() => void openCamera()}>◎</button>}</div></label><label className={statusExpanded ? "pos-inline-filter visible" : "pos-inline-filter"}>Estoque<select value={stockFilter} onChange={(event) => setStockFilter(event.target.value as "all" | "available" | "low")}><option value="all">Todos</option><option value="available">Disponível</option><option value="low">Baixo (até 10)</option></select></label><small className="sr-only" id="pos-catalog-search-status" role="status" aria-live="polite">{catalogLoading ? "Consultando…" : catalogError ? "Consulta indisponível" : `${products.length} exibidos`}</small></div>}
        {quickTool === "order" && <form className="pos-order-lookup" aria-label="Consultar pedido para venda" onSubmit={(event) => { event.preventDefault(); void lookupOrder(orderLookupInput); }}><label htmlFor="pos-order-lookup">Pedido aprovado<input id="pos-order-lookup" autoFocus type="search" value={orderLookupInput} maxLength={120} disabled={busy || Boolean(activeOrderClaim)} onChange={(event) => { setOrderLookupInput(event.target.value); setOrderLookup(null); setOrderClaimError(""); }} placeholder="ID ou número do pedido" autoComplete="off" /></label><button disabled={busy || Boolean(activeOrderClaim) || !orderLookupInput.trim()}>Consultar</button></form>}
        {quickTool === "customer" && <div className="pos-customer-toolbar" aria-label="Cliente da venda">
          <div className="pos-customer-search"><label htmlFor="pos-customer-search">Buscar cliente<input id="pos-customer-search" autoFocus type="search" value={customerQuery} maxLength={100} aria-controls="pos-customer-select" aria-describedby="pos-customer-search-status" onChange={(event) => { setCustomerLoading(true); setCustomerQuery(event.target.value); }} placeholder="Nome, fantasia ou final do documento" autoComplete="off" /></label><small id="pos-customer-search-status" role="status" aria-live="polite">{customerLoading ? "Consultando…" : customerSearchError ? "Consulta indisponível" : customerResults.length ? `${customerResults.length} clientes` : "Nenhum cliente"}</small></div>
          <label className="pos-customer-select">Cliente da venda<select id="pos-customer-select" disabled={busy || anyPaymentIntentLocked || Boolean(activeOrderClaim)} value={customerId} required={data.settings.requireCustomer} aria-busy={customerLoading} onChange={(event) => { const nextCustomerId = event.target.value; setCustomerId(nextCustomerId); setSelectedCustomer(customerOptions.find((customer) => String(customer.id) === nextCustomerId) || null); void loadValueAccounts(nextCustomerId); setPromotionQuote(null); setDiscountApproval(null); discountApprovalAttempt.current = { signature: "", key: crypto.randomUUID() }; }}><option value="">{data.settings.defaultCustomerName}</option>{customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.tradeName || customer.name} · {maskDocument(customer.document)}</option>)}</select></label>
          {customerNextCursor && <button type="button" disabled={customerLoading} onClick={() => void loadCustomerPage(customerQuery, customerNextCursor)}>Carregar mais clientes</button>}
          {!customerLoading && !customerSearchError && !customerResults.length && customerQuery.trim() && <p className="tenant-empty">Nenhum cliente ativo corresponde à busca.</p>}
          {customerSearchError && <button type="button" disabled={customerLoading} onClick={() => void loadCustomerPage(customerQuery)}>Repetir</button>}
          <button className="button primary" type="button" disabled={busy || Boolean(activeOrderClaim)} onClick={() => openOperation("customer")}>Novo cliente</button>
        </div>}
        {!quickTool && <div className="pos-quickbar-hint"><span><b>{selectedCustomer?.tradeName || selectedCustomer?.name || data.settings.defaultCustomerName}</b><small>Cliente da venda</small></span><span><b>{categoryFilter || "Todas as categorias"}</b><small>{stockFilter === "all" ? "Todo o estoque" : stockFilter === "available" ? "Somente disponíveis" : "Estoque baixo"}</small></span><em>Escolha uma ferramenta para pesquisar ou alterar.</em></div>}
        </div>
      </section>
      {(orderLookup || activeOrderClaim) && <section className={`tenant-panel pos-order-claim ${orderClaimError ? "blocked" : ""}`} aria-labelledby="pos-order-claim-title"><header><div><h2 id="pos-order-claim-title">Pedido no PDV</h2><small>QR assinado identifica; somente claim com terminal vivo reserva a conversão.</small></div>{activeOrderClaim && <button type="button" disabled={busy || anyPaymentIntentLocked} onClick={() => { if (window.confirm(`Liberar o pedido ${activeOrderClaim.order.number}?`)) void releaseOrderClaim(); }}>Liberar pedido</button>}</header>{activeOrderClaim ? <div role="status" aria-live="polite"><strong>{activeOrderClaim.order.number} reivindicado neste terminal</strong><p>Versão {activeOrderClaim.version} · lease até {new Date(activeOrderClaim.leaseExpiresAt).toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone() })}. Itens, cliente, descontos e condição de pagamento ficam bloqueados; leituras de lote/série/código continuam disponíveis.</p></div> : orderLookup && <div><strong>{orderLookup.order.number} · {orderLookup.order.customerName}</strong><p>{orderLookup.order.items.length} itens · {money(orderLookup.order.totalCents)} · status {orderLookup.order.status}</p>{orderLookup.convertedSale ? <p>Já convertido na venda {orderLookup.convertedSale.saleNumber}.</p> : orderLookup.eligibility.eligible ? <button type="button" disabled={busy || Boolean(orderLookup.activeClaim?.busy)} onClick={() => void claimOrder()}>{orderLookup.activeClaim?.busy ? `Em uso até ${new Date(orderLookup.activeClaim.leaseExpiresAt).toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone() })}` : "Reivindicar e carregar pedido"}</button> : <p role="alert">{orderLookup.eligibility.reason}</p>}</div>}{orderClaimError && <p className="tenant-error" role="alert">{orderClaimError}</p>}</section>}
      {data.heldSales.length > 0 && <section className="pos-held" aria-label="Vendas suspensas"><strong>Vendas suspensas</strong>{data.heldSales.map((held) => <Fragment key={held.id}><button type="button" disabled={busy} aria-pressed={activeHeldSaleId === held.id} onClick={() => resume(held)}>{held.label || "Sem nome"} · {held.items.length} itens · rev. {held.revision}</button>{(currentRegister?.access.canTransferHeld || data.staffAccess) && <button type="button" disabled={busy || activeHeldSaleId === held.id} aria-label={`Transferir suspensão: ${held.label || "venda suspensa"}`} onClick={() => void openHeldTransfer(held)}>Transferir</button>}<button type="button" disabled={busy} aria-label={`Descartar ${held.label || "venda suspensa"}`} onClick={() => void discardHeld(held)}>Descartar</button></Fragment>)}</section>}
      <button className="pos-mobile-cart-trigger" type="button" aria-expanded={mobileCartOpen} aria-controls="pos-current-sale" onClick={() => setMobileCartOpen(true)}><span>Venda atual</span><b>{lines.length} {lines.length === 1 ? "item" : "itens"}</b><strong>{money(totalCents)}</strong></button>
        <section className={`pos-catalog view-${catalogView}`} aria-labelledby="pos-catalog-title" aria-busy={catalogLoading}>
          <h2 id="pos-catalog-title" className="pos-visually-hidden">Produtos</h2>
          <div className="pos-catalog-toolbar">
            <div className="pos-category-strip" aria-label="Categorias"><button type="button" className={!categoryFilter ? "active" : ""} onClick={() => setCategoryFilter("")}>Todos</button>{categories.slice(0, 8).map(category => <button type="button" key={category} className={categoryFilter === category ? "active" : ""} onClick={() => setCategoryFilter(category)}>{category}</button>)}</div>
            <div className="pos-catalog-view" aria-label="Modo de visualização"><button type="button" className={catalogView === "grid" ? "active" : ""} aria-label="Grade" title="Visualização em grade" onClick={() => setCatalogView("grid")}>▦</button><button type="button" className={catalogView === "list" ? "active" : ""} aria-label="Lista" title="Visualização em lista" onClick={() => setCatalogView("list")}>☷</button><button type="button" className={catalogView === "compact" ? "active" : ""} aria-label="Grade compacta" title="Grade compacta" onClick={() => setCatalogView("compact")}>▤</button></div>
          </div>
          <div id="pos-catalog-grid">{products.map((product) => <button type="button" key={product.id} disabled={busy || anyPaymentIntentLocked || draftRecovery.loading} aria-label={`Adicionar ${product.name} ao carrinho`} onClick={() => add(product)}>{product.imageUrl ? <><Image src={product.imageUrl} alt={product.name} width={180} height={120} unoptimized onError={(event) => { event.currentTarget.hidden = true; const fallback = event.currentTarget.nextElementSibling; if (fallback instanceof HTMLElement) fallback.hidden = false; }} /><span className="pos-product-placeholder" aria-hidden="true" hidden>{product.name.slice(0, 1)}</span></> : <span className="pos-product-placeholder" aria-hidden="true">{product.name.slice(0, 1)}</span>}<small>{product.sku}{product.gtin ? ` · ${product.gtin}` : ""}</small><strong>{product.name}</strong><b>{money(product.priceCents)}</b><span>{product.variations?.length ? "Selecionar variação" : product.stock == null ? "Sem controle de saldo" : product.stock <= 0 ? "Sem estoque disponível" : `${product.stock} ${product.unit}`}</span><i className="pos-product-add" aria-hidden="true">+</i></button>)}</div>
          {catalogError && <p className="tenant-error pos-catalog-message" role="alert">{catalogError}<button type="button" disabled={catalogLoading} onClick={() => void loadCatalogPage(query)}>Tentar novamente</button></p>}{!catalogLoading && !catalogError && !products.length && <p className="tenant-empty">Nenhum produto ativo corresponde à busca.</p>}<footer className="pos-catalog-footer">{catalogLoading && <span role="status">Carregando produtos…</span>}{catalogNextCursor && <button type="button" disabled={catalogLoading} onClick={() => void loadCatalogPage(query, catalogNextCursor)}>Carregar mais produtos</button>}{!catalogLoading && !catalogNextCursor && products.length > 0 && <span>Fim dos resultados carregados.</span>}</footer>
        </section></div>
        <button className={`pos-cart-backdrop${mobileCartOpen ? " open" : ""}`} type="button" aria-label="Fechar carrinho" onClick={() => setMobileCartOpen(false)} />
        <form id="pos-current-sale" className={`pos-cart tenant-panel step-${checkoutStep}${mobileCartOpen ? " mobile-open" : ""}`} onSubmit={submitSale}>
          <header><div><h2>{checkoutStep === "items" ? "Venda atual" : "Pagamento"}</h2><small>{lines.length} {lines.length === 1 ? "item" : "itens"}{activeHeldSaleId ? " · retomada" : ""}{draftReady ? " · protegida" : " · aguardando servidor"}</small></div><nav className="pos-checkout-steps" aria-label="Etapas da venda"><button type="button" aria-current={checkoutStep === "items" ? "step" : undefined} disabled={checkoutStep === "items" || anyPaymentIntentLocked} onClick={() => setCheckoutStep("items")}>Itens</button><span aria-hidden="true">›</span><button type="button" aria-current={checkoutStep === "payment" ? "step" : undefined} disabled={checkoutStep === "payment" || !activePromotionQuote || !lines.length} onClick={() => setCheckoutStep("payment")}>Pagamento</button></nav><div className="pos-cart-header-actions">{activeHeldSaleId && <button type="button" onClick={() => { const held = data.heldSales.find(item => item.id === activeHeldSaleId); if (held) void openHeldTransfer(held); }}>⇄ Transferir</button>}<button className="pos-clear-sale" type="button" disabled={busy || !lines.length || anyPaymentIntentLocked} onClick={() => void clearCurrentSale()}>Limpar</button><button className="pos-cart-more" type="button" aria-label="Mais opções do PDV" onClick={() => openOperation("more")}>⋮</button><button className="pos-cart-mobile-close" type="button" aria-label="Fechar carrinho" onClick={() => setMobileCartOpen(false)}>Fechar</button></div></header>
          <div className="pos-cart-customer"><span>♙</span><b>{selectedCustomer?.tradeName || selectedCustomer?.name || data.settings.defaultCustomerName}</b><button type="button" onClick={() => setQuickTool("customer")}>Alterar</button></div>
          <div className="pos-fulfillment" aria-label="Modalidade de atendimento">{([['on_site','⌂','No local'],['pickup','▱','Retirada'],['delivery','♢','Delivery']] as Array<[FulfillmentMode,string,string]>).map(([mode, icon, label]) => <button type="button" key={mode} className={fulfillmentMode === mode ? "active" : ""} aria-pressed={fulfillmentMode === mode} disabled={busy || anyPaymentIntentLocked || Boolean(activeOrderClaim)} onClick={() => setFulfillmentMode(mode)}><span>{icon}</span>{label}</button>)}</div>
          <div className="pos-lines">{lines.map((line) => { const key = cartKey(line.product); const quantityLocked = busy || anyPaymentIntentLocked || Boolean(activeOrderClaim) || line.product.soldIndividually || hasTrackingReads(line.scanData) || hasCodeReads(line.scanData); const actionsOpen = expandedLineKey === key; return <article className={actionsOpen ? "actions-open" : undefined} key={key}>
            {line.product.imageUrl ? <Image className="pos-cart-thumb" src={line.product.imageUrl} alt="" width={40} height={40} unoptimized onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <span className="pos-cart-thumb pos-cart-thumb-fallback" aria-hidden="true">{line.product.name.slice(0, 1)}</span>}
            <div className="pos-line-info"><strong>{line.product.name}</strong><small>{money(line.product.priceCents)} · {line.product.unit}{line.product.soldIndividually ? " · venda unitária" : ""}{trackingSummary(line.scanData)}</small></div>
            <span className="pos-line-quantity-summary" aria-label={`Quantidade ${line.quantity}`}>{line.quantity}×</span>
            <div id={`pos-line-actions-${key.replaceAll(":", "-")}`} className="pos-line-controls" aria-hidden={!actionsOpen} inert={!actionsOpen}><div className="pos-line-control-block"><span>Quantidade</span><span className="pos-quantity-stepper"><button type="button" disabled={quantityLocked || line.quantity <= 1} aria-label={`Diminuir ${line.product.name}`} onClick={() => updateQuantity(key, String(Math.max(0.001, line.quantity - 1)))}>−</button><input aria-label={`Quantidade de ${line.product.name}`} type="number" min="0.001" step="0.001" disabled={quantityLocked || Boolean(activeOrderClaim)} value={line.quantity} onChange={(event) => updateQuantity(key, event.target.value)} /><button type="button" disabled={quantityLocked || hasCodeReads(line.scanData)} aria-label={`Aumentar ${line.product.name}`} onClick={() => updateQuantity(key, String(line.quantity + 1))}>+</button></span></div><label><span>Desconto do item</span><span className="pos-line-discount"><input aria-label={`Desconto de ${line.product.name}`} disabled={busy || anyPaymentIntentLocked || Boolean(activeOrderClaim)} inputMode="decimal" value={formatInput(line.discountCents)} onChange={(event) => updateLineDiscount(key, event.target.value)} /><i aria-hidden="true">✎</i></span></label><button className="pos-line-scan-action" type="button" disabled={busy} onClick={() => { setQuickTool("scanner"); setExpandedLineKey(null); window.requestAnimationFrame(() => scanRef.current?.focus()); }}>Ler lote, série ou complemento</button></div>
            <b aria-label={`Total de ${line.product.name}`}>{money(Math.max(0, Math.round(line.product.priceCents * line.quantity) - line.discountCents))}</b>
            <div className="pos-line-actions"><button className="pos-line-more" type="button" disabled={busy} aria-expanded={actionsOpen} aria-controls={`pos-line-actions-${key.replaceAll(":", "-")}`} aria-label={`Ações de ${line.product.name}`} title="Quantidade, desconto e outras ações" onClick={() => setExpandedLineKey(current => current === key ? null : key)}>•••</button><button className="pos-line-remove" type="button" disabled={busy || anyPaymentIntentLocked || Boolean(activeOrderClaim)} aria-label={`Remover ${line.product.name}`} onClick={() => { if (Object.keys(cartRef.current).length === 1) { void clearCurrentSale(); return; } const changed = { ...cartRef.current }; delete changed[key]; replaceCart(changed); setExpandedLineKey(null); }}>Remover</button></div>
          </article>; })}{!lines.length && <p className="tenant-empty">Leia um código ou selecione um produto.</p>}</div>
          <button className="pos-add-note" type="button" onClick={() => { setNoteExpanded(true); document.querySelector<HTMLDetailsElement>(".pos-sale-options")?.setAttribute("open", ""); window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#pos-sale-note")?.focus()); }}>＋ {noteExpanded || notes ? "Editar observação" : "Adicionar observação"}</button>
          <details className="pos-sale-options" ref={(node) => { if (node && !node.dataset.initialized) { node.open = true; node.dataset.initialized = "true"; } }}>
            <summary><span>Ajustes da venda</span><small>{discountCents > 0 || couponCode || couponQrToken || notes ? "Há informações preenchidas" : "Desconto, cupom e observação"}</small></summary>
          <div className="pos-checkout-fields">
            <label>Desconto da venda<input disabled={busy || anyPaymentIntentLocked || Boolean(activeOrderClaim)} value={discount} inputMode="decimal" onChange={(event) => updateOrderDiscount(event.target.value)} /></label>
            <label>Cupom<input disabled={busy || Boolean(couponQrToken) || Boolean(activeOrderClaim)} value={couponCode} maxLength={64} autoComplete="off" spellCheck={false} placeholder={couponQrToken ? "Cupom QR assinado selecionado" : "Código do cupom"} onChange={(event) => { setCouponCode(event.target.value); setCouponQrToken(""); setPromotionQuote(null); setDiscountApproval(null); discountApprovalAttempt.current = { signature: "", key: crypto.randomUUID() }; }} /></label>
            {couponQrToken && <div className="wide"><small>Cupom interno assinado selecionado; o token não é exibido nem persistido na tela.</small> <button type="button" disabled={busy} onClick={() => { setCouponQrToken(""); setPromotionQuote(null); }}>Remover cupom QR</button></div>}
            {discountApprovalPolicy?.requiresApproval && <div className="wide pos-discount-approval" role="group" aria-labelledby="pos-discount-approval-title">
              <div><strong id="pos-discount-approval-title">Desconto excepcional</strong><small>Manual: {money(discountApprovalPolicy.context.manualDiscountCents)} ({(discountApprovalPolicy.context.basisPoints / 100).toFixed(2)}%) · sua alçada: {discountApprovalPolicy.maximumPercent.toFixed(2)}%</small></div>
              <label className="wide">Justificativa para o supervisor<input disabled={busy || Boolean(activeDiscountApproval)} value={discountApprovalReason} minLength={8} maxLength={500} onChange={(event) => setDiscountApprovalReason(event.target.value)} placeholder="Explique a exceção comercial" /></label>
              {activeDiscountApproval ? <div className="pos-discount-approval-id" role="status" aria-live="polite"><span>Pedido criado. Aguarde a aprovação e depois recalcule. Se ele for rejeitado ou expirar, descarte o ID e solicite outro.</span><code>{activeDiscountApproval.id}</code><div><button type="button" disabled={busy} onClick={() => void copyDiscountApprovalId()}>Copiar ID</button><button type="button" disabled={busy} onClick={replaceDiscountApprovalRequest}>Criar novo pedido</button></div></div> : <button type="button" disabled={busy || !online || discountApprovalReason.trim().length < 8} onClick={() => void requestDiscountApproval()}>Solicitar aprovação excepcional</button>}
            </div>}
            {(noteExpanded || notes) && <label className="wide pos-note-field">Observação<input id="pos-sale-note" disabled={busy || anyPaymentIntentLocked || Boolean(activeOrderClaim)} value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} /></label>}
          </div>
          <div className="pos-pricing-action"><div className={`pos-quote-status${activePromotionQuote ? " ready" : ""}`} aria-live="polite">{quoteBusy ? <small>Validando total e ofertas…</small> : activePromotionQuote ? activePromotionQuote.promotionName ? <small><b>{activePromotionQuote.promotionName}</b> · economia {money(activePromotionQuote.promotionDiscountCents)}{activePromotionQuote.couponLastFour ? ` · cupom ••••${activePromotionQuote.couponLastFour}` : ""}</small> : <small>Total validado automaticamente.</small> : <small>{draftReady ? "Preparando a validação automática…" : "Salvando a venda antes de validar…"}</small>}</div>{!activePromotionQuote && !quoteBusy && draftReady && <button className="pos-quote-action" type="button" disabled={busy || !lines.length || Boolean(discountApprovalPolicy?.requiresApproval && !activeDiscountApproval)} onClick={() => void quoteBestPromotion()}>Atualizar total</button>}</div>
          </details>
          <div className="pos-payments">
            <header><div><button className="pos-payment-back" type="button" disabled={anyPaymentIntentLocked} onClick={() => setCheckoutStep("items")}>← Itens</button><strong>Forma de pagamento</strong></div><button type="button" disabled={busy || anyPaymentIntentLocked || paymentPlanConfigurationLocked || Boolean(activeOrderClaim)} onClick={addPayment}>＋ Dividir</button></header>
            <div className="pos-payment-shortcuts" aria-label="Formas rápidas de pagamento">
              {(["pix", "credit", "debit", "cash", "voucher"] as PaymentMethod[]).map(method => <button type="button" key={method} className={payments.length === 1 && payments[0].method === method ? "active" : ""} disabled={busy || anyPaymentIntentLocked || paymentPlanConfigurationLocked || Boolean(activeOrderClaim)} onClick={() => { if (payments.length === 1) changePaymentMethod(payments[0].key, method); else setPayments([newPayment(method)]); }}><span>{method === "pix" ? "◆" : method === "cash" ? "▤" : "▣"}</span>{paymentLabels[method]}</button>)}
            </div>
            <div className="wide" role="status" aria-live="polite">
              {currentPaymentPlan?.state === "active"
                ? <small>Pagamento preparado em {currentPaymentPlan.slots.length} {currentPaymentPlan.slots.length === 1 ? "forma" : "formas"} · válido até {new Date(currentPaymentPlan.expiresAt).toLocaleTimeString("pt-BR", { timeZone: tenantTimeZone() })}</small>
                : currentPaymentPlan?.state === "quoted"
                  ? <><small>Revise os valores antes de iniciar a cobrança.</small> <button type="button" disabled={busy || recoveryCheckoutBlocked || orderClaimCheckoutBlocked || proposedPaymentPlanSlots.some(slot => slot.proofKind === "manual")} onClick={() => void activatePaymentPlan()}>Ativar divisões autoritativas</button></>
                  : <small>Valide os preços para liberar as formas de pagamento.</small>}
            </div>
            <p className={`pos-payment-balance ${remainingCents === 0 ? "settled" : remainingCents < 0 ? "over" : ""}`} aria-live="polite"><span>Pago <b>{money(paidCents)}</b></span><span>{remainingCents < 0 ? "Excesso" : "Restante"} <b>{money(Math.abs(remainingCents))}</b></span></p>
            {payments.map((payment, index) => { const intentLocked = isPdvPaymentIntentLocked(payment.electronicIntent); return <div className="pos-payment-row" role="group" aria-label={`Pagamento ${index + 1}`} key={payment.key}>
              <label className="pos-payment-basic"><span>Forma</span><select aria-label={`Forma do pagamento ${index + 1}`} disabled={busy || intentLocked || paymentPlanConfigurationLocked || Boolean(activeOrderClaim)} value={payment.method} onChange={(event) => changePaymentMethod(payment.key, event.target.value)}>{paymentMethods.map((key) => <option key={key} value={key}>{paymentLabels[key]}</option>)}</select></label>
              <label className="pos-payment-basic"><span>Valor</span><input aria-label={`Valor do pagamento ${index + 1}`} disabled={busy || intentLocked || paymentPlanConfigurationLocked || Boolean(activeOrderClaim)} value={payment.amount} inputMode="decimal" onChange={(event) => changePayment(setPayments, payment.key, "amount", event.target.value)} /></label>
              {payment.method === "cash" ? <><label className="pos-cash-toggle"><input type="checkbox" checked={payment.needsChange} disabled={busy} onChange={(event) => setPayments(current => current.map(item => item.key === payment.key ? { ...item, needsChange: event.target.checked, tendered: event.target.checked ? item.tendered : item.amount } : item))} /><span>Cliente precisa de troco?</span></label>{payment.needsChange && <label className="pos-cash-received"><span>Valor recebido</span><input aria-label={`Valor recebido no pagamento ${index + 1}`} disabled={busy} value={payment.tendered} inputMode="decimal" placeholder="0,00" onChange={(event) => changePayment(setPayments, payment.key, "tendered", event.target.value)} /></label>}</> : payment.method === "store_credit" ? <>
                <select aria-label={`Saldo do pagamento ${index + 1}`} disabled={busy} value={payment.valueAccountId} onChange={(event) => changePayment(setPayments, payment.key, "valueAccountId", event.target.value)}><option value="">Gift card por código ou QR</option>{valueAccounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {valueBalance(account)}</option>)}</select>
                {payment.valueAccountId ? valueAccounts.find((account) => account.id === payment.valueAccountId)?.unit === "points" ? <input aria-label={`Pontos do pagamento ${index + 1}`} disabled={busy} required inputMode="numeric" pattern="[0-9]+" value={payment.valueUnits} placeholder="Pontos" onChange={(event) => changePayment(setPayments, payment.key, "valueUnits", event.target.value.replace(/\D/g, ""))} /> : <small>O valor informado será reservado e debitado do saldo monetário.</small> : <>
                  {!payment.giftQrToken && <input aria-label={`Código do gift card no pagamento ${index + 1}`} disabled={busy} required value={payment.giftCode} autoComplete="off" placeholder="Código do gift card" onChange={(event) => changePayment(setPayments, payment.key, "giftCode", event.target.value)} />}
                  {payment.giftQrToken && <small>Gift card identificado por QR interno assinado.</small>}
                  <input aria-label={`PIN do gift card no pagamento ${index + 1}`} disabled={busy} required type="password" inputMode="numeric" minLength={6} maxLength={12} value={payment.giftPin} autoComplete="off" placeholder="PIN do gift card" onChange={(event) => changePayment(setPayments, payment.key, "giftPin", event.target.value.replace(/\D/g, ""))} />
                </>}
              </> : <><input aria-label={`Parcelas do pagamento ${index + 1}`} disabled={busy || intentLocked || paymentPlanConfigurationLocked || Boolean(activeOrderClaim) || payment.method !== "credit"} type="number" min="1" max="24" value={payment.installments} onChange={(event) => changePayment(setPayments, payment.key, "installments", event.target.value.replace(/\D/g, ""))} /><div className="pos-payment-proof">
                <select aria-label={`Prova do pagamento ${index + 1}`} disabled={busy || intentLocked || paymentPlanConfigurationLocked || orderClaimCheckoutBlocked} value={payment.proofMode} onChange={(event) => setPayments(current => current.map(item => item.key === payment.key ? { ...item, proofMode: event.target.value === "manual" ? "manual" : "intent", manualReference: null, electronicIntent: null } : item))}><option value="intent">Intent eletrônico persistido</option><option value="manual" disabled>Referência manual · disponível na wave 320000</option></select>
                {payment.proofMode === "intent" && data.session && activeRegister ? <PdvPaymentIntentControl disabled={busy || !activePromotionQuote || !draftReady || recoveryCheckoutBlocked} createDisabled={orderClaimCheckoutBlocked || !paymentPlanSlotsMatch} configurationLocked={paymentPlanConfigurationLocked} online={online} sessionId={data.session.id} registerId={activeRegister.id} operatorProfileId={data.operator.id} saleDraftId={saleIdempotencyKey.current} paymentPlanId={currentPaymentPlan?.id ?? ""} paymentIndex={index} amountCents={parseMoney(payment.amount)} method={payment.method} installments={positiveInteger(payment.installments, 1)} connectors={electronicPaymentConnectors.filter(connector => !connector.settings?.methods?.length || connector.settings.methods.includes(payment.method))} terminals={activeRegister.terminals} connectorId={payment.connectorId} terminalId={payment.terminalId} intent={payment.electronicIntent} onConnectorId={(connectorId) => setPayments(current => current.map(item => item.key === payment.key ? { ...item, connectorId, electronicIntent: null } : item))} onTerminalId={(terminalId) => setPayments(current => current.map(item => item.key === payment.key ? { ...item, terminalId, electronicIntent: null } : item))} onIntent={(electronicIntent) => setPayments(current => current.map(item => item.key === payment.key ? { ...item, electronicIntent } : item))} onError={setError} onNotice={showNotice} /> : <div className="pos-manual-payment-reference">
                  <select aria-label={`Instituição do pagamento ${index + 1}`} disabled={busy || orderClaimCheckoutBlocked || Boolean(payment.manualReference)} required value={payment.provider} onChange={(event) => changePayment(setPayments, payment.key, "provider", event.target.value)}><option value="">Selecione o conector</option>{manualPaymentProviders.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select>
                  <input aria-label={`Referência externa do pagamento ${index + 1}`} disabled={busy || orderClaimCheckoutBlocked || Boolean(payment.manualReference)} required value={payment.reference} maxLength={160} autoComplete="off" placeholder={payment.method === "pix" ? "EndToEndId Pix" : "Transação/autorização externa"} onChange={(event) => changePayment(setPayments, payment.key, "reference", event.target.value)} />
                  <label>Horário alegado no comprovante<input aria-label={`Horário alegado do comprovante ${index + 1}`} disabled={busy || orderClaimCheckoutBlocked || Boolean(payment.manualReference)} required type="datetime-local" value={payment.confirmationOccurredAt} onChange={(event) => changePayment(setPayments, payment.key, "confirmationOccurredAt", event.target.value)} /></label>
                  <input aria-label={`Justificativa da confirmação manual ${index + 1}`} disabled={busy || orderClaimCheckoutBlocked || Boolean(payment.manualReference)} required value={payment.confirmationReason} minLength={8} maxLength={500} placeholder="Por que esta exceção é necessária?" onChange={(event) => changePayment(setPayments, payment.key, "confirmationReason", event.target.value)} />
                  {payment.manualReference ? <div role="status" aria-live="polite"><small>Confirmação manual: <b>{payment.manualReference.status}</b>. Não equivale a captura homologada.</small><code>{payment.manualReference.id}</code><code>Aprovação: {payment.manualReference.approvalId}</code><button type="button" disabled={busy} onClick={() => void refreshManualPaymentReference(payment)}>Atualizar estado</button><button type="button" disabled={busy} onClick={() => void navigator.clipboard?.writeText(payment.manualReference!.approvalId).then(() => showNotice("ID da aprovação copiado."))}>Copiar aprovação</button><button type="button" disabled={busy || Boolean(activeOrderClaim)} onClick={() => setPayments((current) => current.map((item) => item.key === payment.key ? { ...item, manualReference: null } : item))}>Descartar e solicitar outra</button></div> : <button type="button" disabled={busy || orderClaimCheckoutBlocked || !online || !activePromotionQuote || payment.provider.trim().length < 2 || payment.reference.trim().length < 6 || !manualOccurrenceIso(payment.confirmationOccurredAt) || payment.confirmationReason.trim().length < 8 || !(currentRegister?.access.canManualPayment || data.staffAccess)} onClick={() => void requestManualPaymentReference(payment, index)}>Solicitar confirmação independente</button>}
                </div>}
              </div></>}
              {payments.length > 1 && <button type="button" disabled={busy || anyPaymentIntentLocked || paymentPlanConfigurationLocked || Boolean(activeOrderClaim)} aria-label={`Remover pagamento ${index + 1}`} onClick={() => removePayment(payment.key)}>×</button>}
              {payment.method === "cash" && payment.needsChange && <small className="pos-cash-change">Troco <b>{money(Math.max(0, parseMoney(payment.tendered) - parseMoney(payment.amount)))}</b></small>}
              {payment.method === "store_credit" ? <small>Saldo reservado e capturado atomicamente pelo servidor.</small> : payment.method !== "cash" && <small>{payment.proofMode === "intent" ? "Intent acompanha o ledger eletrônico sem chamar ou simular PSP." : "Referência manual exige aprovação independente com step-up; permanece identificada como confirmação local, sem homologação do PSP."}</small>}
            </div>})}
          </div>
          <footer className="pos-cart-totals"><div className="pos-total-breakdown"><span><small>Subtotal</small><b>{money(activePromotionQuote?.subtotalCents ?? subtotalCents)}</b></span><span><small>Desconto manual</small><b className="discount">− {money(discountCents)}</b></span>{promotionDiscountCents > 0 && <span><small>Promoção</small><b className="discount">− {money(promotionDiscountCents)}</b></span>}<span className="total"><small>Total</small><b>{money(totalCents)}</b></span></div><div className="pos-total-payment"><span><small>Pago</small><b>{money(paidCents)}</b></span><span><small>Restante</small><b className={remainingCents > 0 ? "remaining" : ""}>{money(Math.max(0, remainingCents))}</b></span></div></footer>
          <button className={`primary pos-finish${activePromotionQuote ? "" : " pending-quote"}`} title={checkoutStep === "items" ? activePromotionQuote ? "Ir para o pagamento" : "Aguarde a validação automática do total" : "Concluir a venda confirmada"} disabled={busy || !online || recoveryCheckoutBlocked || orderClaimCheckoutBlocked || !lines.length || !activePromotionQuote || totalCents <= 0 || checkoutStep === "payment" && !paymentsValid}>{busy ? "PROCESSANDO…" : checkoutStep === "items" ? `COBRAR · ${money(totalCents)} · F12` : `CONCLUIR VENDA · ${money(totalCents)} · F12`}</button>
        </form>
      </div>
      <footer className="pos-device-footer" aria-label="Status do terminal e atalhos"><span className={online ? "ok" : "warn"}><i />{online ? "Sincronizado com o servidor" : "Sem conexão com o servidor"}</span><span>▧ {currentRegister?.terminals.some(terminal => terminal.devices.some(device => device.type === "printer" && device.status === "active")) ? "Impressora conectada" : "Impressora não configurada"}</span><span className="pos-footer-shortcuts"><b>Atalhos:</b> F1 Nova venda · F2 Leitor · F3 Cliente · F6 Caixa · F7 Vendas · F12 Finalizar</span></footer>
      {operation === "recent" && <PdvAccessibleModal open title="Vendas recentes" description="Comprovantes, cancelamentos, devoluções e trocas deste caixa." busy={busy} returnFocusRef={returnFocus} overlayClassName="pos-recent-dialog" dialogClassName="pos-recent-modal" onRequestClose={closeOperation}><section className="pos-recent"><label>Buscar por Venda<input autoFocus type="search" value={saleQuery} onChange={event => { saleRequest.current?.abort(); setSaleResults([]); setSaleNextCursor(null); setSaleLoading(true); setSaleQuery(event.target.value); }} placeholder="Número da venda ou cliente" maxLength={120} /></label><small role="status">{saleLoading ? "Buscando vendas…" : `${saleResults.length} vendas encontradas neste turno`}</small>{saleSearchError && <p role="alert">{saleSearchError}<button type="button" onClick={() => void loadSalePage(saleQuery)}>Tentar novamente</button></p>}<div>{saleResults.map((sale) => {
        const locallyReversible = isLocallyReversibleSale(sale);
        const completed = sale.status === "completed";
        const returnEligible = isReturnEligibleSale(sale);
        return <article className="pos-recent-sale" key={sale.id}>
          <button type="button" className="pos-recent-open" disabled={busy} onClick={() => { setLastSale(sale); openOperation("receipt"); }}><b>{sale.saleNumber}</b><span>{sale.customer}</span><small>{new Date(sale.createdAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small><strong>{money(sale.totalCents)}</strong><em>{sale.status}</em></button>
          <div className="pos-recent-actions">
            {!locallyReversible && <small>Meio externo: conector obrigatório</small>}
            {currentRegister && <button type="button" disabled={busy || !completed || !locallyReversible} title={!locallyReversible ? "Pagamento externo exige conector homologado" : !completed ? "Venda não elegível" : currentRegister.access.canCancel || data.staffAccess ? "Cancelar venda inteira" : "Exige aprovação"} onClick={() => startPostSale(sale, "cancel")}>Cancelar</button>}
            {currentRegister && <button type="button" disabled={busy || !returnEligible || !locallyReversible} title={!locallyReversible ? "Pagamento externo exige conector homologado" : !returnEligible ? "Sem saldo de itens para devolver" : currentRegister.access.canRefund || data.staffAccess ? "Devolver itens ou iniciar troca" : "Exige aprovação"} onClick={() => startPostSale(sale, "return")}>Devolver / trocar</button>}
          </div>
        </article>;
      })}{!saleLoading && !saleSearchError && !saleResults.length && <p className="tenant-empty">Nenhuma venda deste turno corresponde à busca.</p>}{saleNextCursor && <button type="button" disabled={saleLoading} onClick={() => void loadSalePage(saleQuery, saleNextCursor)}>Carregar mais vendas</button>}</div></section></PdvAccessibleModal>}
    </>}
    {operation === "variation" && variationProduct && <PdvAccessibleModal open title={`Selecionar variação de ${variationProduct.name}`} description="Escolha a opção para adicionar ao carrinho." busy={busy} returnFocusRef={returnFocus} onRequestClose={closeOperation}><div className="pos-variation-options">{variationProduct.variations?.map(variation => <button type="button" key={variation.id} onClick={() => { closeOperation(); add({ ...variationProduct, resolvedVariationId: variation.id, sku: variation.sku || variationProduct.sku, gtin: variation.gtin, priceCents: variation.priceCents, stock: variation.stock, name: `${variationProduct.name} · ${variation.sku || variation.id}` }); }}><strong>{variation.sku || `Opção ${variation.id}`}</strong><span>{isRecord(variation.attributes) ? Object.values(variation.attributes).filter(value => typeof value === "string").join(" · ") : ""}</span><b>{money(variation.priceCents)}</b><small>{variation.stock == null ? "Sem controle de saldo" : variation.stock <= 0 ? "Sem estoque disponível" : `${variation.stock} ${variationProduct.unit}`}</small></button>)}</div></PdvAccessibleModal>}
    {operation === "more" && <PdvAccessibleModal open title="Mais opções do PDV" description="Operação, equipe, continuidade e administração do ponto de venda." busy={busy} returnFocusRef={returnFocus} overlayClassName="pos-more-dialog" dialogClassName="pos-more-modal" onRequestClose={closeOperation}><div className="pos-more-grid">
      {data.session?.status === "open" && <div className="pos-shift-actions"><button type="button" onClick={requestShiftLifecycle}><span>⇄</span><strong>Pausar / passar turno</strong><small>Pausar ou passar a posse do caixa</small></button><button type="button" className="danger" onClick={requestCloseShift}><span>×</span><strong>Fechar turno</strong><small>Conferência e encerramento seguro</small></button></div>}
      {data.staffAccess && <button type="button" onClick={() => setOperation("access")}><span>♙</span><strong>Equipe e caixas</strong><small>Acessos, operadores e alçadas</small></button>}
      <button type="button" onClick={() => setOperation("approval")}><span>✓</span><strong>Aprovações</strong><small>Solicitações e decisões pendentes</small></button>
      {data.staffAccess && <button type="button" onClick={() => setOperation("configuration")}><span>⚙</span><strong>Configurações</strong><small>Terminais, integrações e operação</small></button>}
      <button type="button" onClick={() => setOperation("offline")}><span>☁</span><strong>Rascunhos offline</strong><small>Continuidade e sincronização segura</small></button>
      <button type="button" onClick={() => setOperation("recent")}><span>▤</span><strong>Vendas recentes</strong><small>Recibos, cancelamentos e devoluções</small></button>
      {data.session?.status === "open" && <button type="button" onClick={() => setOperation("recovery")}><span>↻</span><strong>Recuperação da venda</strong><small>Rascunho e estados financeiros</small></button>}
    </div></PdvAccessibleModal>}
    {operation === "camera" && <PdvAccessibleModal open title="Aponte para o código" description="Compatível com EAN, UPC, Code 39/128, ITF, QR Code e Data Matrix por API nativa ou decoder ZXing local." busy={busy} error={error} returnFocusRef={returnFocus} onRequestClose={closeOperation}><video ref={cameraVideo} aria-label="Imagem da câmera para leitura do código" playsInline muted /><p role="status" aria-live="polite">Autorize a câmera e mantenha o código centralizado até a confirmação da leitura.</p></PdvAccessibleModal>}
    {operation === "offline" && <PdvAccessibleModal open title="Rascunhos offline" description="Continuidade segura do carrinho neste dispositivo, sem concluir venda ou movimentar valores offline." busy={busy} returnFocusRef={returnFocus} overlayClassName="pos-offline-dialog" dialogClassName="pos-offline-modal" onRequestClose={closeOperation}><PdvOfflineWorkspace embedded /></PdvAccessibleModal>}
    {operation === "cash" && data.session && <CashDialog sessionId={data.session.id} register={currentRegister!} initialType={cashOperation} privileged={Boolean(data.staffAccess)} busy={busy} onClose={closeOperation} onSubmit={async (payload) => { const result = await mutate(payload, "Movimento de caixa registrado."); if (result) { closeOperation(); await load(); } }} />}
    {operation === "close" && data.session && <CloseDialog sessionId={data.session.id} tenders={data.closingTenders} busy={busy} onClose={closeOperation} onSubmit={async (payload) => { const result = await mutate(payload, "Turno fechado e conferido por meio de pagamento."); if (!result) return false; closeOperation(); resetSale(); await load(); return true; }} />}
    {operation === "receipt" && lastSale && <Receipt sale={lastSale} footer={data.settings.receiptFooter} terminals={(currentRegister?.terminals || []).filter((terminal) => !["unpaired", "revoked"].includes(terminal.status) && terminal.devices.some((device) => device.type === "printer"))} busy={busy} requestError={error} returnFocusRef={returnFocus} onQueue={queueReceipt} onClose={closeOperation} />}
    {operation === "cancel" && lastSale && data.session && currentRegister && <CancelSaleDialog sale={lastSale} sessionId={data.session.id} approvalRequired={!currentRegister.access.canCancel && !data.staffAccess} busy={busy} requestError={error} onClose={closeOperation} onSubmit={async (payload) => {
      const result = await mutate(payload, "Venda cancelada e meios locais estornados.");
      if (!result) return false;
      closeOperation();
      setLastSale(null);
      await load();
      return true;
    }} />}
    {operation === "return" && lastSale && data.session && currentRegister && <ReturnSaleDialog sale={lastSale} sessionId={data.session.id} approvalRequired={!currentRegister.access.canRefund && !data.staffAccess} busy={busy} requestError={error} onClose={closeOperation} onSubmit={async (payload) => {
      const result = await mutate(payload, "Devolução registrada e meios locais reembolsados.");
      if (!result) return false;
      const exchangeDraft = isRecord(result.exchangeDraft) ? result.exchangeDraft as PdvData["heldSales"][number] : null;
      closeOperation();
      setLastSale(null);
      if (exchangeDraft && !Object.keys(cartRef.current).length) resume(exchangeDraft);
      else if (exchangeDraft) showNotice("Devolução concluída. A troca vinculada ficou suspensa para retomada após a venda atual.", 6000);
      await load();
      return true;
    }} />}
    {operation === "access" && data.staffAccess && <AccessDialog staff={data.staffAccess} registers={data.registers} busy={busy} requestError={error} returnFocusRef={returnFocus} onClose={closeOperation} onSubmit={async (payload) => { const result = await mutate(payload, "Acesso operacional atualizado e auditado."); if (result) await load(); }} />}
    {operation === "approval" && <PdvApprovalDialog sessionId={data.session?.id} onClose={closeOperation} />}
    {operation === "customer" && data.session && <QuickCustomerDialog busy={busy} requestError={error} returnFocusRef={returnFocus} onClose={closeOperation} onSubmit={createQuickCustomer} />}
    {operation === "shift-lifecycle" && data.session?.status === "open" && <SessionLifecycleDialog session={data.session} targets={sessionLifecycle.targets} heldSaleCount={data.heldSales.length} busy={busy} requestError={error} returnFocusRef={returnFocus} onClose={closeOperation} onSubmit={async (mode, reason, targetProfileId) => Boolean(await mutateSessionLifecycle(mode === "handoff" ? { action: "session.handoff.request", sessionId: data.session!.id, expectedVersion: data.session!.version, targetProfileId, reason } : { action: "session.suspend", sessionId: data.session!.id, expectedVersion: data.session!.version, reason }, mode === "handoff" ? "Passagem solicitada; o turno aguarda o aceite do destino." : "Turno pausado com a posse preservada."))} />}
    {operation === "held-transfer" && heldTransfer && <HeldCartTransferDialog held={heldTransfer} targets={heldTransferTargets} busy={busy} requestError={error} returnFocusRef={returnFocus} onClose={closeOperation} onSubmit={transferHeld} />}
    {operation === "configuration" && data.staffAccess && <PdvAdminDialog onClose={closeOperation} onChanged={load} />}
  </div>;
}

function CancelSaleDialog({ sale, sessionId, approvalRequired, busy, requestError, onClose, onSubmit }: { sale: PdvData["recentSales"][number]; sessionId: number; approvalRequired: boolean; busy: boolean; requestError: string; onClose(): void; onSubmit(payload: Record<string, unknown>): Promise<boolean> }) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const approvalAttempt = useRef({ signature: "", key: crypto.randomUUID() });
  const formRef = useRef<HTMLFormElement>(null);
  const [approvalId, setApprovalId] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState("");
  const [localError, setLocalError] = useState("");

  function invalidateApproval() {
    setApprovalId("");
    setApprovalNotice("");
    approvalAttempt.current = { signature: "", key: crypto.randomUUID() };
  }

  async function requestExactApproval() {
    setLocalError("");
    setApprovalNotice("");
    if (!formRef.current) return;
    const form = new FormData(formRef.current);
    const reason = String(form.get("reason") || "").trim();
    if (reason.length < 8) {
      setLocalError("Descreva o motivo do cancelamento com ao menos 8 caracteres.");
      return;
    }
    const signature = JSON.stringify({ saleId: sale.id, sessionId, reason });
    if (approvalAttempt.current.signature !== signature) approvalAttempt.current = { signature, key: crypto.randomUUID() };
    setApprovalBusy(true);
    try {
      const response = await fetch("/api/erp/pdv/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approval.request", approvalAction: "sale.cancel", entityId: String(sale.id), reason, expiryMinutes: 10, context: { sessionId }, idempotencyKey: approvalAttempt.current.key }),
      });
      const result = await responseBody(response);
      if (!response.ok) throw new Error(String(result.error || "Não foi possível solicitar a aprovação."));
      const approval = result.approval && typeof result.approval === "object" && !Array.isArray(result.approval) ? result.approval as Record<string, unknown> : null;
      const createdId = typeof approval?.id === "string" ? approval.id : "";
      if (!createdId) throw new Error("A aprovação foi criada sem identificador utilizável.");
      setApprovalId(createdId);
      setApprovalNotice("Pedido exato enviado. O supervisor deve conferir o snapshot, reautenticar e aprovar antes do cancelamento.");
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Não foi possível solicitar a aprovação.");
    } finally {
      setApprovalBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");
    if (sale.status !== "completed" || !isLocallyReversibleSale(sale)) {
      setLocalError("Cancelamento bloqueado: a venda não está concluída ou possui pagamento externo.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const reason = String(form.get("reason") || "").trim();
    if (!reason) {
      setLocalError("Informe o motivo do cancelamento.");
      return;
    }
    await onSubmit({ action: "sale.cancel", sessionId, saleId: sale.id, reason, idempotencyKey: idempotencyKey.current, approvalId: approvalId.trim() || undefined });
  }

  return <div className="tenant-modal pos-dialog pos-postsale-dialog" role="dialog" aria-modal="true" aria-labelledby="pos-cancel-title"><form ref={formRef} onSubmit={(event) => void submit(event)}>
    <header><div><h2 id="pos-cancel-title">Cancelar {sale.saleNumber}</h2><p>O cancelamento estorna toda a venda, devolve os itens ao estoque e restitui {money(sale.totalCents)} nos meios locais originais.</p></div><button type="button" disabled={busy} onClick={onClose}>Fechar</button></header>
    <div className="pos-postsale-summary"><span>Cliente <b>{sale.customer}</b></span><span>Pagamento <b>{localPaymentSummary(sale)}</b></span><span>Total <b>{money(sale.totalCents)}</b></span></div>
    {approvalRequired && <div className="wide"><label>ID da aprovação<input name="approvalId" required disabled={busy || approvalBusy} value={approvalId} onChange={(event) => { setApprovalId(event.target.value); setApprovalNotice(""); }} placeholder="Solicite o snapshot exato abaixo ou cole um ID aprovado" /></label><button type="button" disabled={busy || approvalBusy} onClick={() => void requestExactApproval()}>{approvalBusy ? "Solicitando…" : "Solicitar aprovação deste conteúdo"}</button></div>}
    <label className="wide">Motivo do cancelamento<textarea autoFocus disabled={busy || approvalBusy} name="reason" required minLength={8} maxLength={500} onChange={invalidateApproval} placeholder="Descreva por que a venda inteira deve ser cancelada." /></label>
    <label className="wide pos-confirm-check"><input disabled={busy} name="confirmed" type="checkbox" required /> Confirmo a restituição nos meios locais originais e o cancelamento integral da venda.</label>
    {approvalNotice && <div className="tenant-success" role="status">{approvalNotice}</div>}
    {(localError || requestError) && <div className="tenant-error pos-local-error" role="alert">{localError || requestError}</div>}
    <footer><button type="button" disabled={busy} onClick={onClose}>Voltar</button><button className="pos-danger" disabled={busy}>Confirmar cancelamento</button></footer>
  </form></div>;
}

function ReturnSaleDialog({ sale, sessionId, approvalRequired, busy, requestError, onClose, onSubmit }: { sale: PdvData["recentSales"][number]; sessionId: number; approvalRequired: boolean; busy: boolean; requestError: string; onClose(): void; onSubmit(payload: Record<string, unknown>): Promise<boolean> }) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const approvalAttempt = useRef({ signature: "", key: crypto.randomUUID() });
  const formRef = useRef<HTMLFormElement>(null);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [dispositions, setDispositions] = useState<Record<number, "restock" | "quarantine" | "discard">>({});
  const [approvalId, setApprovalId] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState("");
  const [localError, setLocalError] = useState("");
  const selected = sale.items.flatMap((item) => {
    const quantity = parseSaleQuantity(quantities[item.id] || "0");
    const available = Math.max(0, item.quantity - (item.returnedQuantity || 0));
    if (quantity <= 0 || quantity > available) return [];
    const refundCents = calculatePosReturnRefundCents({ totalQuantity: item.quantity, returnedQuantity: item.returnedQuantity || 0, totalCents: item.totalCents, returnedCents: item.returnedCents || 0 }, quantity);
    return [{ item, quantity, available, refundCents, disposition: dispositions[item.id] || "restock" }];
  });
  const refundCents = selected.reduce((sum, line) => sum + line.refundCents, 0);

  function invalidateApproval() {
    setApprovalId("");
    setApprovalNotice("");
    approvalAttempt.current = { signature: "", key: crypto.randomUUID() };
  }

  async function requestExactApproval() {
    setLocalError("");
    setApprovalNotice("");
    if (!selected.length || !formRef.current) {
      setLocalError("Selecione ao menos um item antes de solicitar a aprovação.");
      return;
    }
    const form = new FormData(formRef.current);
    const description = String(form.get("description") || "").trim();
    if (description.length < 8) {
      setLocalError("Descreva o motivo da devolução com ao menos 8 caracteres.");
      return;
    }
    const reasonCode = String(form.get("reasonCode") || "customer_return");
    const exchangeRequested = form.get("exchange") === "on";
    const context = {
      sessionId,
      items: selected.map((line) => ({ saleItemId: line.item.id, quantity: line.quantity, disposition: line.disposition })),
      reasonCode,
      description,
      exchangeRequested,
    };
    const signature = JSON.stringify({ saleId: sale.id, context });
    if (approvalAttempt.current.signature !== signature) approvalAttempt.current = { signature, key: crypto.randomUUID() };
    setApprovalBusy(true);
    try {
      const response = await fetch("/api/erp/pdv/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approval.request",
          approvalAction: "return.create",
          entityId: String(sale.id),
          reason: description,
          expiryMinutes: 10,
          context,
          idempotencyKey: approvalAttempt.current.key,
        }),
      });
      const result = await responseBody(response);
      if (!response.ok) throw new Error(String(result.error || "Não foi possível solicitar a aprovação."));
      const approval = result.approval && typeof result.approval === "object" && !Array.isArray(result.approval) ? result.approval as Record<string, unknown> : null;
      const createdId = typeof approval?.id === "string" ? approval.id : "";
      if (!createdId) throw new Error("A aprovação foi criada sem identificador utilizável.");
      setApprovalId(createdId);
      setApprovalNotice("Pedido exato enviado. O supervisor deve conferir o snapshot, reautenticar e aprovar antes da devolução.");
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Não foi possível solicitar a aprovação.");
    } finally {
      setApprovalBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");
    if (!isReturnEligibleSale(sale) || !isLocallyReversibleSale(sale)) {
      setLocalError("Devolução bloqueada: a venda não possui saldo elegível ou contém pagamento externo.");
      return;
    }
    const invalid = sale.items.some((item) => {
      const quantity = parseSaleQuantity(quantities[item.id] || "0");
      const available = Math.max(0, item.quantity - (item.returnedQuantity || 0));
      return quantity < 0 || quantity > available;
    });
    if (invalid) {
      setLocalError("Uma quantidade supera o saldo disponível do item.");
      return;
    }
    if (!selected.length) {
      setLocalError("Informe a quantidade de ao menos um item para devolver.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const description = String(form.get("description") || "").trim();
    if (!description) {
      setLocalError("Descreva o motivo da devolução.");
      return;
    }
    await onSubmit({
      action: "return.create",
      sessionId,
      saleId: sale.id,
      idempotencyKey: idempotencyKey.current,
      reasonCode: form.get("reasonCode"),
      description,
      exchange: form.get("exchange") === "on",
      approvalId: approvalId.trim() || undefined,
      items: selected.map((line) => ({ saleItemId: line.item.id, quantity: line.quantity, disposition: line.disposition })),
    });
  }

  return <div className="tenant-modal pos-dialog pos-postsale-dialog pos-return-dialog" role="dialog" aria-modal="true" aria-labelledby="pos-return-title"><form ref={formRef} onSubmit={(event) => void submit(event)}>
    <header><div><h2 id="pos-return-title">Devolver ou trocar itens de {sale.saleNumber}</h2><p>Selecione os saldos atuais e o destino físico. O reembolso local é independente da nova venda da troca.</p></div><button type="button" disabled={busy} onClick={onClose}>Fechar</button></header>
    <div className="pos-return-items" role="group" aria-label="Itens disponíveis para devolução">{sale.items.map((item, index) => {
      const available = Math.max(0, item.quantity - (item.returnedQuantity || 0));
      return <div className="pos-return-line" key={item.id}>
        <div><strong>{item.productName}</strong><small>Vendido {formatQuantity(item.quantity)} · disponível {formatQuantity(available)} · saldo {money(Math.max(0, item.totalCents - (item.returnedCents || 0)))}</small></div>
        <label>Quantidade<input autoFocus={index === 0} disabled={busy || approvalBusy || available <= 0} type="number" min="0" max={available} step="0.001" value={quantities[item.id] || ""} placeholder="0" onChange={(event) => { invalidateApproval(); setQuantities((current) => ({ ...current, [item.id]: event.target.value })); }} /></label>
        <label>Destino<select disabled={busy || approvalBusy || available <= 0} value={dispositions[item.id] || "restock"} onChange={(event) => { invalidateApproval(); setDispositions((current) => ({ ...current, [item.id]: event.target.value as "restock" | "quarantine" | "discard" })); }}><option value="restock">Retornar ao estoque</option><option value="quarantine">Quarentena</option><option value="discard">Descartar</option></select></label>
      </div>;
    })}</div>
    <div className="pos-refund-total"><span>Itens selecionados <b>{selected.length}</b></span><span>Reembolso estimado <b>{money(refundCents)}</b></span></div>
    {approvalRequired && <div className="wide"><label>ID da aprovação<input name="approvalId" required disabled={busy || approvalBusy} value={approvalId} onChange={(event) => { setApprovalId(event.target.value); setApprovalNotice(""); }} placeholder="Solicite o snapshot exato abaixo ou cole um ID aprovado" /></label><button type="button" disabled={busy || approvalBusy || !selected.length} onClick={() => void requestExactApproval()}>{approvalBusy ? "Solicitando…" : "Solicitar aprovação deste conteúdo"}</button></div>}
    <label>Motivo<select disabled={busy || approvalBusy} name="reasonCode" onChange={invalidateApproval}><option value="customer_return">Devolução do cliente</option><option value="defective">Produto com defeito</option><option value="wrong_item">Item incorreto</option><option value="other">Outro</option></select></label>
    <label className="wide">Descrição<textarea disabled={busy || approvalBusy} name="description" required minLength={8} maxLength={500} onChange={invalidateApproval} placeholder="Registre o motivo e as condições dos itens recebidos." /></label>
    <label className="wide pos-confirm-check"><input disabled={busy || approvalBusy} name="exchange" type="checkbox" onChange={invalidateApproval} /> Iniciar troca vinculada após devolver. A reposição será uma nova venda online, com preços, descontos, lote/série, estoque e pagamento revalidados.</label>
    <label className="wide pos-confirm-check"><input disabled={busy} name="confirmed" type="checkbox" required /> Confirmo o recebimento dos itens e o reembolso de {money(refundCents)} nos meios locais originais.</label>
    {approvalNotice && <div className="tenant-success" role="status">{approvalNotice}</div>}
    {(localError || requestError) && <div className="tenant-error pos-local-error" role="alert">{localError || requestError}</div>}
    <footer><button type="button" disabled={busy} onClick={onClose}>Voltar</button><button className="primary" disabled={busy || !selected.length}>Confirmar devolução</button></footer>
  </form></div>;
}

function IncomingSessionHandoffs({ handoffs, busy, onAccept }: { handoffs: SessionLifecycleData["incoming"]; busy: boolean; onAccept(handoff: SessionLifecycleData["incoming"][number]): Promise<boolean> }) {
  return <section className="tenant-panel pos-session-handoffs" aria-labelledby="pos-incoming-handoffs-title">
    <header><div><h2 id="pos-incoming-handoffs-title">Turnos aguardando seu aceite</h2><p>Assuma somente com sua própria identidade. O aceite transfere também os carrinhos suspensos fotografados na solicitação.</p></div><span>{handoffs.length}</span></header>
    <div>{handoffs.map((handoff, index) => <article key={handoff.id}>
      <div><strong>{handoff.register.name} · {handoff.session.number}</strong><small>Origem: {handoff.fromOperatorProfile.displayName} · expira em {new Date(handoff.expiresAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}</small><p>{handoff.reason}</p></div>
      <button type="button" autoFocus={index === 0} className="primary" disabled={busy} onClick={() => void onAccept(handoff)}>Aceitar responsabilidade</button>
    </article>)}</div>
  </section>;
}

function SuspendedSessionPanel({ session, handoff, busy, onResume, onCancel }: { session: NonNullable<PdvData["session"]>; handoff: SessionHandoff | null; busy: boolean; onResume(): Promise<boolean>; onCancel(handoff: SessionHandoff, reason: string): Promise<boolean> }) {
  const [reason, setReason] = useState("");
  return <section className="tenant-panel pos-session-suspended" aria-labelledby="pos-session-suspended-title">
    <header><div><h2 id="pos-session-suspended-title">Turno pausado</h2><p>{session.number} permanece ocupando o caixa e não aceita operações comerciais até uma retomada ou passagem válida.</p></div><span>rev. {session.version}</span></header>
    <p><strong>Motivo:</strong> {session.suspendedReason || "Pausa operacional"}</p>
    {handoff ? <div className="pos-session-handoff-pending">
      <p>Passagem pendente para o operador #{handoff.toOperatorProfileId}, válida até {new Date(handoff.expiresAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })}. O destino precisa entrar com a própria conta e aceitar.</p>
      <label>Motivo do cancelamento<input autoFocus disabled={busy} minLength={8} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explique por que a passagem foi cancelada" /></label>
      <button type="button" disabled={busy || reason.trim().length < 8} onClick={() => void onCancel(handoff, reason.trim())}>Cancelar passagem e retomar</button>
    </div> : <button type="button" autoFocus className="primary" disabled={busy} onClick={() => void onResume()}>Retomar este turno</button>}
  </section>;
}

function SessionLifecycleDialog({ session, targets, heldSaleCount, busy, requestError, returnFocusRef, onClose, onSubmit }: { session: NonNullable<PdvData["session"]>; targets: SessionLifecycleData["targets"]; heldSaleCount: number; busy: boolean; requestError: string; returnFocusRef: React.RefObject<HTMLElement | null>; onClose(): void; onSubmit(mode: "pause" | "handoff", reason: string, targetProfileId: number | null): Promise<boolean> }) {
  const [mode, setMode] = useState<"pause" | "handoff">("pause"), [localError, setLocalError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget), reason = String(form.get("reason") || "").trim(), targetProfileId = mode === "handoff" ? Number(form.get("targetProfileId")) : null;
    if (reason.length < 8 || mode === "handoff" && (!Number.isSafeInteger(targetProfileId) || Number(targetProfileId) <= 0)) {
      setLocalError(mode === "handoff" ? "Selecione o funcionário de destino e informe um motivo com ao menos oito caracteres." : "Informe um motivo com ao menos oito caracteres.");
      return;
    }
    setLocalError("");
    await onSubmit(mode, reason, targetProfileId);
  }
  return <PdvAccessibleModal open title="Pausar ou passar o turno" description={`${session.number} · revisão ${session.version}. Nenhuma destas ações fecha ou reconcilia a gaveta.`} busy={busy} error={localError || requestError} returnFocusRef={returnFocusRef} onRequestClose={onClose}><form onSubmit={(event) => void submit(event)}>
    <label>Operação<select disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as "pause" | "handoff")}><option value="pause">Pausar para o mesmo operador</option><option value="handoff">Passar responsabilidade</option></select></label>
    {mode === "handoff" && <label>Funcionário de destino<select disabled={busy} required name="targetProfileId" defaultValue=""><option value="" disabled>Selecione quem aceitará</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.displayName}</option>)}</select></label>}
    <label className="wide">Motivo<textarea disabled={busy} required name="reason" minLength={8} maxLength={500} placeholder="Registre a causa operacional e a continuidade esperada" /></label>
    <small className="wide">Há {heldSaleCount} carrinho(s) suspenso(s). {mode === "handoff" ? "Eles serão transferidos atomicamente por ID/revisão quando o destino aceitar." : "Eles continuarão sob sua responsabilidade durante a pausa."}</small>
    {mode === "handoff" && !targets.length && <div className="tenant-error wide" role="alert">Não há outro funcionário com acesso vigente de abertura e venda neste caixa.</div>}
    <footer><button type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="primary" disabled={busy || mode === "handoff" && !targets.length}>{mode === "handoff" ? "Solicitar aceite" : "Pausar turno"}</button></footer>
  </form></PdvAccessibleModal>;
}

function HeldCartTransferDialog({ held, targets, busy, requestError, returnFocusRef, onClose, onSubmit }: { held: PdvData["heldSales"][number]; targets: HeldTransferTarget[]; busy: boolean; requestError: string; returnFocusRef: React.RefObject<HTMLElement | null>; onClose(): void; onSubmit(targetSessionId: number, reason: string): Promise<boolean> }) {
  const [localError, setLocalError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const targetSessionId = Number(form.get("targetSessionId"));
    const reason = String(form.get("reason") || "").trim();
    if (!Number.isSafeInteger(targetSessionId) || targetSessionId <= 0 || reason.length < 4) {
      setLocalError("Selecione um turno receptor e registre um motivo com ao menos quatro caracteres.");
      return;
    }
    setLocalError("");
    await onSubmit(targetSessionId, reason);
  }
  return <PdvAccessibleModal open title="Transferir carrinho suspenso" description={`${held.label || "Carrinho sem nome"} · revisão ${held.revision}. A posse passará integralmente ao turno receptor.`} busy={busy} error={localError || requestError} returnFocusRef={returnFocusRef} onRequestClose={onClose}><form onSubmit={(event) => void submit(event)}>
    {targets.length ? <label className="wide">Operador e caixa receptores<select name="targetSessionId" required disabled={busy} defaultValue=""><option value="" disabled>Selecione um turno autorizado</option>{targets.map(target => <option key={target.sessionId} value={target.sessionId}>{target.operatorName} · {target.registerName} ({target.registerCode}) · {target.sessionNumber}</option>)}</select></label> : <p className="tenant-empty wide">Não há outro turno aberto com operador autorizado nesta filial.</p>}
    <label className="wide">Motivo<textarea name="reason" required minLength={4} maxLength={300} disabled={busy || !targets.length} placeholder="Ex.: troca de operador, continuidade do atendimento" /></label>
    <small className="wide">A operação exige alçada de transferência, usa a revisão atual e gera um evento imutável de auditoria. O receptor ainda revalidará preços, promoções, estoque e pagamentos ao concluir.</small>
    <footer><button type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="primary" disabled={busy || !targets.length}>Transferir posse</button></footer>
  </form></PdvAccessibleModal>;
}

function AccessDialog({ staff, registers, busy, requestError, returnFocusRef, onClose, onSubmit }: { staff: NonNullable<PdvData["staffAccess"]>; registers: Register[]; busy: boolean; requestError: string; returnFocusRef: React.RefObject<HTMLElement | null>; onClose(): void; onSubmit(payload: Record<string, unknown>): Promise<void> }) {
  const [profileFilter, setProfileFilter] = useState(""), [registerFilter, setRegisterFilter] = useState("");
  const visibleStaff = profileFilter ? staff.filter(profile => String(profile.id) === profileFilter) : staff;
  const visibleRegisters = registerFilter ? registers.filter(register => String(register.id) === registerFilter) : registers;
  return <PdvAccessibleModal open title="Funcionários por caixa" description="Escolha uma pessoa e um caixa. Abra somente a ficha que deseja alterar." busy={busy} error={requestError} returnFocusRef={returnFocusRef} overlayClassName="pos-access-dialog" onRequestClose={onClose}>
    <section className="pos-access-help"><span>COMO CONFIGURAR</span><strong>1. Escolha a pessoa e o caixa</strong><p>2. Libere o acesso. 3. Marque somente as ações necessárias. 4. Defina o limite de desconto e a validade. 5. Salve.</p></section>
    <div className="pos-access-filters"><label>Funcionário<select value={profileFilter} onChange={event => setProfileFilter(event.target.value)}><option value="">Todos</option>{staff.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label><label>Caixa<select value={registerFilter} onChange={event => setRegisterFilter(event.target.value)}><option value="">Todos</option>{registers.map(register => <option key={register.id} value={register.id}>{register.name}</option>)}</select></label></div>
    <div className="pos-access-list">{visibleStaff.flatMap((profile) => visibleRegisters.map((register) => {
    const access = profile.posRegisterAccesses.find((item) => item.registerId === register.id);
    return <form key={`${profile.id}:${register.id}`} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void onSubmit({ action: "access.update", userProfileId: profile.id, registerId: register.id, active: form.get("active") === "on", canOpen: form.get("canOpen") === "on", canClose: form.get("canClose") === "on", canSell: form.get("canSell") === "on", canSupply: form.get("canSupply") === "on", canWithdraw: form.get("canWithdraw") === "on", canCancel: form.get("canCancel") === "on", canRefund: form.get("canRefund") === "on", canReprint: form.get("canReprint") === "on", canManualPayment: form.get("canManualPayment") === "on", canTransferHeld: form.get("canTransferHeld") === "on", maxDiscountBasisPoints: Math.round(Number(form.get("maxDiscountPercent") || 0) * 100), validFrom: form.get("validFrom") || undefined, validUntil: form.get("validUntil") || undefined }); }}><details open={visibleStaff.length * visibleRegisters.length === 1 || undefined}><summary><div><strong>{profile.displayName}</strong><small>{profile.role.name} · {register.name}</small></div><span className={access?.active ? "active" : "inactive"}>{access?.active ? "Acesso liberado" : "Sem acesso"}</span></summary><div className="pos-access-body"><label className="pos-access-master"><input name="active" type="checkbox" defaultChecked={access?.active ?? false} /><span><strong>Liberar este caixa</strong><small>Sem esta opção, nenhuma permissão abaixo terá efeito.</small></span></label><fieldset><legend>Ações permitidas</legend><div className="pos-access-permissions">{[["canOpen", "Abrir turno"], ["canClose", "Fechar turno"], ["canSell", "Realizar vendas"], ["canSupply", "Fazer suprimento"], ["canWithdraw", "Fazer sangria"], ["canCancel", "Cancelar venda"], ["canRefund", "Devolver ou estornar"], ["canReprint", "Reimprimir comprovante"], ["canManualPayment", "Confirmar pagamento manual"], ["canTransferHeld", "Transferir venda suspensa"]].map(([name, label]) => <label key={name}><input name={name} type="checkbox" defaultChecked={Boolean(access?.[name as keyof typeof access])} /> {label}</label>)}</div></fieldset><div className="pos-access-validity"><label>Desconto máximo (%)<input name="maxDiscountPercent" type="number" min="0" max="100" step="0.01" defaultValue={(access?.maxDiscountBasisPoints || 0) / 100} /></label><label>Válido a partir de<input name="validFrom" type="datetime-local" defaultValue={localDateTime(access?.validFrom)} /></label><label>Válido até<input name="validUntil" type="datetime-local" defaultValue={localDateTime(access?.validUntil)} /></label><button className="primary" disabled={busy}>Salvar acesso</button></div></div></details></form>;
  }))}{!visibleStaff.length || !visibleRegisters.length ? <p className="tenant-empty">Nenhuma combinação encontrada.</p> : null}</div>
  </PdvAccessibleModal>;
}

const CASH_DENOMINATIONS = [[20000, "R$ 200"], [10000, "R$ 100"], [5000, "R$ 50"], [2000, "R$ 20"], [1000, "R$ 10"], [500, "R$ 5"], [200, "R$ 2"], [100, "R$ 1"], [50, "R$ 0,50"], [25, "R$ 0,25"], [10, "R$ 0,10"], [5, "R$ 0,05"]] as const;

function OpenShift({ operatorName, branchName, registers, busy, onSubmit }: { operatorName: string; branchName: string; registers: Register[]; busy: boolean; onSubmit(payload: { registerId: number; terminalId: string; openingAmountCents: number; businessDate: string; openingNotes?: string; openingCount?: Record<string, number>; idempotencyKey: string }): Promise<boolean> }) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [registerId, setRegisterId] = useState(registers[0]?.id || 0), [countCash, setCountCash] = useState(false);
  const selectedRegister = registers.find(register => register.id === registerId) || registers[0];
  const availableTerminals = selectedRegister?.terminals.filter(terminal => !["unpaired", "revoked"].includes(terminal.status)) || [];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let openingCount: Record<string, number> | undefined;
    if (countCash) {
      openingCount = {};
      for (const [value] of CASH_DENOMINATIONS) {
        const count = Math.max(0, Number(form.get(`denomination-${value}`) || 0));
        if (count > 0) openingCount[String(value)] = count;
      }
    }
    const countedCents = openingCount ? Object.entries(openingCount).reduce((total, [value, count]) => total + Number(value) * count, 0) : null;
    const succeeded = await onSubmit({ registerId: Number(form.get("registerId")), terminalId: String(form.get("terminalId")), openingAmountCents: countedCents ?? parseMoney(String(form.get("amount"))), businessDate: String(form.get("businessDate")), openingNotes: String(form.get("openingNotes") || "").trim() || undefined, openingCount, idempotencyKey: idempotencyKey.current });
    if (succeeded) idempotencyKey.current = crypto.randomUUID();
  }

  return <section className="tenant-panel pos-open"><header><div><span>ABERTURA DE CAIXA</span><h2>Iniciar turno</h2><p>Identifique o caixa físico, o terminal desta estação e confira o numerário sob sua responsabilidade.</p></div><aside><small>Operador</small><strong>{operatorName}</strong><small>{branchName}</small></aside></header><form onChange={() => { idempotencyKey.current = crypto.randomUUID(); }} onSubmit={(event) => void submit(event)}>
    <label>Caixa atribuído<select disabled={busy} name="registerId" value={registerId} onChange={event => setRegisterId(Number(event.target.value))}>{registers.map(register => <option key={register.id} value={register.id}>{register.name} · {register.code}</option>)}</select><small>{selectedRegister?.access.canOpen ? "Você pode abrir e operar este caixa." : "Seu perfil não possui alçada de abertura."}</small></label>
    <label>Terminal desta estação<select disabled={busy || !availableTerminals.length} name="terminalId" required defaultValue={availableTerminals[0]?.id || ""} key={registerId}><option value="" disabled>{availableTerminals.length ? "Selecione" : "Nenhum terminal pareado"}</option>{availableTerminals.map(terminal => <option key={terminal.id} value={terminal.id}>{terminal.name} · {terminal.code} · {terminal.status}</option>)}</select><small>{availableTerminals.length ? "A ativação segura vale por até 8 horas neste navegador." : "Configure e pareie um terminal antes de abrir o turno."}</small></label>
    <label>Data operacional<input disabled={busy} name="businessDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
    {!countCash && <label>Fundo de troco<input disabled={busy} name="amount" inputMode="decimal" defaultValue="0,00" required /></label>}
    <label className="pos-open-toggle"><input type="checkbox" checked={countCash} onChange={event => setCountCash(event.target.checked)} /> Contar cédulas e moedas</label>
    {countCash && <fieldset className="pos-cash-count"><legend>Contagem física do fundo</legend>{CASH_DENOMINATIONS.map(([value, label]) => <label key={value}>{label}<input disabled={busy} name={`denomination-${value}`} type="number" min="0" max="10000" step="1" defaultValue="0" /></label>)}</fieldset>}
    <label className="wide">Observação de abertura<textarea disabled={busy} name="openingNotes" maxLength={500} placeholder="Ex.: fundo recebido da tesouraria, lacre ou ocorrência inicial" /></label>
    <label className="pos-open-confirm wide"><input required type="checkbox" /> Confirmo que conferi o caixa físico, o terminal selecionado e o fundo informado.</label>
    <footer className="wide"><span>{availableTerminals.length ? "A abertura gera vínculo exclusivo entre operador, caixa e terminal." : "Abertura bloqueada até existir terminal operacional."}</span><button className="button primary" disabled={busy || !selectedRegister?.access.canOpen || !availableTerminals.length}>{busy ? "Abrindo…" : "Abrir turno"}</button></footer>
  </form></section>;
}

function QuickCustomerDialog({ busy, requestError, returnFocusRef, onClose, onSubmit }: { busy: boolean; requestError: string; returnFocusRef: React.RefObject<HTMLElement | null>; onClose(): void; onSubmit(payload: Record<string, unknown>): Promise<boolean> }) {
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await onSubmit({ name: form.get("name"), tradeName: form.get("tradeName"), document: form.get("document"), email: form.get("email"), phone: form.get("phone") });
  }
  return <PdvAccessibleModal open title="Cliente rápido" description="Cadastro mínimo para identificar a venda. Crédito e endereço permanecem no cadastro completo." busy={busy} error={requestError} returnFocusRef={returnFocusRef} onRequestClose={onClose}><form onSubmit={(event) => void submit(event)}><label>Nome / razão social<input autoFocus disabled={busy} name="name" minLength={2} maxLength={180} required autoComplete="name" /></label><label>CPF ou CNPJ<input disabled={busy} name="document" inputMode="numeric" required autoComplete="off" /></label><label>Nome fantasia<input disabled={busy} name="tradeName" maxLength={180} /></label><label>Telefone<input disabled={busy} name="phone" maxLength={24} autoComplete="tel" /></label><label className="wide">E-mail<input disabled={busy} name="email" maxLength={254} type="email" autoComplete="email" /></label><small className="wide">Se o documento já existir, o cadastro ativo será apenas selecionado; nenhum dado será sobrescrito no caixa.</small><footer><button type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>Cadastrar e selecionar</button></footer></form></PdvAccessibleModal>;
}

function CashDialog({ sessionId, register, initialType, privileged, busy, onClose, onSubmit }: { sessionId: number; register: Register; initialType: "supply" | "withdrawal"; privileged: boolean; busy: boolean; onClose(): void; onSubmit(payload: Record<string, unknown>): Promise<void> }) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [type, setType] = useState<"supply" | "withdrawal">(initialType === "supply" && register.access.canSupply ? "supply" : "withdrawal");
  const approvalRequired = type === "withdrawal" && !register.access.canWithdraw && !privileged;
  return <div className="tenant-modal pos-dialog" role="dialog" aria-modal="true" aria-labelledby="pos-cash-title"><form onChange={() => { idempotencyKey.current = crypto.randomUUID(); }} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void onSubmit({ action: "cash.event", sessionId, idempotencyKey: idempotencyKey.current, type, amountCents: parseMoney(String(form.get("amount"))), reasonCode: form.get("reasonCode"), description: form.get("description"), approvalId: String(form.get("approvalId") || "").trim() || undefined }); }}><header><h2 id="pos-cash-title">Sangria ou suprimento</h2><button type="button" onClick={onClose}>Fechar</button></header><label>Operação<select disabled={busy} name="type" value={type} onChange={(event) => setType(event.target.value as "supply" | "withdrawal")}><option value="withdrawal">Sangria{!register.access.canWithdraw ? " · exige aprovação" : ""}</option><option value="supply" disabled={!register.access.canSupply}>Suprimento</option></select></label><label>Valor<input autoFocus disabled={busy} name="amount" required inputMode="decimal" /></label><label>Motivo<select disabled={busy} name="reasonCode"><option value="treasury">Tesouraria</option><option value="change_fund">Fundo de troco</option><option value="expense">Despesa autorizada</option><option value="other">Outro</option></select></label>{approvalRequired && <label className="wide">ID da aprovação<input disabled={busy} name="approvalId" required placeholder="Use uma aprovação de sangria vinculada a este turno" /></label>}<label className="wide">Descrição<input disabled={busy} name="description" required maxLength={300} /></label><footer><button type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>Registrar</button></footer></form></div>;
}

function CloseDialog({ sessionId, tenders, busy, onClose, onSubmit }: { sessionId: number; tenders: PdvData["closingTenders"]; busy: boolean; onClose(): void; onSubmit(payload: Record<string, unknown>): Promise<boolean> }) {
  const idempotencyKey = useRef(crypto.randomUUID());

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const succeeded = await onSubmit({ action: "session.close", sessionId, idempotencyKey: idempotencyKey.current, counts: tenders.map((tender, index) => ({ ...tender, declaredCents: parseMoney(String(form.get(`tender-${index}`) || "0")) })), notes: form.get("notes"), approvalId: String(form.get("approvalId") || "").trim() || undefined });
    if (succeeded) idempotencyKey.current = crypto.randomUUID();
  }

  return <div className="tenant-modal pos-dialog" role="dialog" aria-modal="true" aria-labelledby="pos-close-title"><form onChange={() => { idempotencyKey.current = crypto.randomUUID(); }} onSubmit={(event) => void submit(event)}><header><div><h2 id="pos-close-title">Fechamento cego</h2><p>Informe o apurado sem visualizar o valor esperado.</p></div><button type="button" disabled={busy} onClick={onClose}>Fechar</button></header>{tenders.map((tender, index) => <label key={`${tender.method}:${tender.provider}`}>{paymentLabels[tender.method] || tender.method}{tender.provider ? ` · ${tender.provider}` : ""}<input autoFocus={index === 0} disabled={busy} name={`tender-${index}`} inputMode="decimal" defaultValue="0,00" /></label>)}<label className="wide">Justificativa de divergência<input disabled={busy} name="notes" maxLength={1000} placeholder="Obrigatória se houver diferença" /></label><label className="wide">ID da aprovação independente<input disabled={busy} name="approvalId" maxLength={100} placeholder="Informe apenas se a primeira conferência exigir aprovação" /></label><small className="wide">Diferenças acima da tolerância só fecham com uma aprovação vinculada a este turno.</small><footer><button type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>Conferir e fechar</button></footer></form></div>;
}

function Receipt({ sale, footer, terminals, busy, requestError, returnFocusRef, onQueue, onClose }: { sale: PdvData["recentSales"][number]; footer?: string | null; terminals: Register["terminals"]; busy: boolean; requestError: string; returnFocusRef: React.RefObject<HTMLElement | null>; onQueue(saleId: number, terminalId: string, copy: "original" | "reprint", reason: string, idempotencyKey: string): Promise<boolean>; onClose(): void }) {
  const [terminalId, setTerminalId] = useState(terminals[0]?.id || ""), [copy, setCopy] = useState<"original" | "reprint">("original"), [reason, setReason] = useState("");
  const attempt = useRef({ signature: "", key: crypto.randomUUID() });
  async function enqueue() {
    const signature = JSON.stringify({ saleId: sale.id, terminalId, copy, reason: copy === "reprint" ? reason.trim() : null });
    if (attempt.current.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    if (await onQueue(sale.id, terminalId, copy, reason, attempt.current.key)) attempt.current = { signature: "", key: crypto.randomUUID() };
  }
  return <PdvAccessibleModal open title="Comprovante comercial" description="Não substitui documento fiscal" busy={busy} error={requestError} returnFocusRef={returnFocusRef} overlayClassName="pos-receipt-dialog" dialogClassName="pos-receipt" onRequestClose={onClose}><h3>{sale.saleNumber}</h3><p>{new Date(sale.createdAt).toLocaleString("pt-BR", { timeZone: tenantTimeZone() })} · {sale.customer}</p>{sale.items?.map((item, index) => <div className="receipt-line" key={index}><span>{item.quantity}× {item.productName}</span><b>{money(item.totalCents)}</b></div>)}<hr />{sale.payments?.map((payment, index) => <div className="receipt-line" key={index}><span>{paymentLabels[payment.method] || payment.method}{payment.status === "manual_confirmed" ? " · confirmação manual local" : ""}</span><b>{money(payment.amountCents)}</b></div>)}<div className="receipt-total"><span>Total</span><b>{money(sale.totalCents)}</b></div>{sale.changeCents > 0 && <div className="receipt-line"><span>Troco</span><b>{money(sale.changeCents)}</b></div>}{footer && <p>{footer}</p>}<button className="primary" onClick={() => window.print()}>Imprimir / salvar PDF</button>{terminals.length ? <section className="pos-receipt-queue"><strong>Impressora do terminal</strong><label>Terminal<select disabled={busy} value={terminalId} onChange={(event) => setTerminalId(event.target.value)}>{terminals.map((terminal) => <option value={terminal.id} key={terminal.id}>{terminal.name} · {terminal.status}</option>)}</select></label><label>Via<select disabled={busy} value={copy} onChange={(event) => setCopy(event.target.value as "original" | "reprint")}><option value="original">Via original</option><option value="reprint">Reimpressão auditada</option></select></label>{copy === "reprint" && <label>Motivo<input disabled={busy} value={reason} minLength={8} maxLength={500} required onChange={(event) => setReason(event.target.value)} /></label>}<button disabled={busy || !terminalId || copy === "reprint" && reason.trim().length < 8} onClick={() => void enqueue()}>Enviar à fila local</button></section> : <small>Nenhuma impressora está configurada em um terminal deste caixa.</small>}</PdvAccessibleModal>;
}

function posScannerTarget(eventTarget: EventTarget | null, scannerInput: HTMLInputElement | null): PosScannerCaptureTarget | undefined {
  if (!(eventTarget instanceof HTMLElement)) return undefined;
  const tagName = eventTarget.tagName;
  if (eventTarget === scannerInput) return { tagName, contentEditable: eventTarget.isContentEditable, purpose: "scanner" };
  if (eventTarget instanceof HTMLInputElement) {
    const autocomplete = eventTarget.autocomplete.toLowerCase();
    if (eventTarget.type === "password" || autocomplete.includes("password") || autocomplete === "one-time-code") {
      return { tagName, purpose: "credential" };
    }
    if (eventTarget.inputMode === "decimal" || eventTarget.closest(".pos-payments, .pos-open, .pos-checkout-fields")) {
      return { tagName, purpose: "financial" };
    }
  }
  return { tagName, contentEditable: eventTarget.isContentEditable, purpose: "ordinary" };
}

function posScannerResultStatus(result: PosScannerCaptureResult) {
  if (result.status === "accepted") return "última captura processada";
  if (result.status === "duplicate") return "reenvio físico ignorado";
  return `última captura rejeitada (${result.reasonCode})`;
}

function posScannerResultMessage(result: PosScannerCaptureResult) {
  const messages: Partial<Record<PosScannerCaptureResult["reasonCode"], string>> = {
    operation_active: "Leitura rejeitada: conclua ou feche a operação atual antes de ler novamente.",
    protected_target: "Leitura rejeitada: o foco estava em um campo protegido.",
    capture_timeout: "Leitura incompleta: o leitor excedeu o intervalo configurado entre teclas.",
    capture_too_short: "Leitura curta demais para ser processada.",
    capture_too_long: "Leitura maior que o limite seguro configurado.",
    invalid_key: "O frame do leitor contém uma tecla inválida.",
    queue_full: `Fila do leitor cheia (${posScannerConfiguration.queueLimit}). Aguarde a fila baixar e leia novamente.`,
    not_found: "Código não encontrado.",
    invalid_code: "Código inválido ou incompleto.",
    unsupported_format: "Formato de código não compatível com este PDV.",
    not_sellable: "O item lido não está disponível para venda.",
    stock_unavailable: "O item lido não possui estoque disponível.",
    processor_error: "A leitura não pôde ser processada; verifique a rede e tente novamente.",
  };
  return messages[result.reasonCode] || "A captura do leitor foi rejeitada com segurança.";
}

function newPayment(method: PaymentMethod, amountCents = 0): Payment {
  const amount = formatInput(amountCents);
  return { key: crypto.randomUUID(), method, amount, tendered: method === "cash" ? amount : "0,00", needsChange: false, proofMode: "intent", connectorId: "", terminalId: "", installments: "1", electronicIntent: null, provider: "", reference: "", confirmationOccurredAt: "", confirmationReason: "", manualReference: null, valueAccountId: "", valueUnits: "", giftCode: "", giftPin: "", giftQrToken: "" };
}

function paymentFromRecoveredIntent(intent: PdvOperatorPaymentIntent): Payment {
  const payment = newPayment(supportedPaymentMethod(intent.method), intent.amountCents);
  return {
    ...payment,
    proofMode: "intent",
    connectorId: intent.connectorId,
    terminalId: intent.terminalId || "",
    installments: String(intent.installments),
    electronicIntent: intent,
    provider: intent.provider,
  };
}

function paymentFromRecoveredManualReference(reference: RecoveryManualPaymentReference): Payment {
  const payment = newPayment(reference.method, reference.amountCents);
  return {
    ...payment,
    proofMode: "manual",
    installments: String(reference.installments),
    provider: reference.provider,
    confirmationOccurredAt: reference.occurredAt,
    manualReference: { id: reference.id, approvalId: reference.approvalId, status: reference.status, expiresAt: reference.expiresAt, signature: "", recovered: true },
  };
}

function isRecoveryManualPaymentReference(value: unknown): value is RecoveryManualPaymentReference {
  if (!isRecord(value)) return false;
  return Boolean(stringValue(value.id) && stringValue(value.paymentPlanId) && stringValue(value.saleDraftId) && stringValue(value.quoteHash) && Number.isSafeInteger(Number(value.paymentIndex)) && paymentMethods.includes(value.method as PaymentMethod) && Number.isSafeInteger(Number(value.amountCents)) && Number(value.amountCents) > 0 && Number.isSafeInteger(Number(value.installments)) && Number(value.installments) >= 1 && Number(value.installments) <= 24 && stringValue(value.provider) && /^\d{1,4}$/.test(stringValue(value.referenceLastFour)) && stringValue(value.status) && stringValue(value.approvalId) && stringValue(value.expiresAt));
}

function parsePaymentPlan(value: unknown): PaymentPlan | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id), saleDraftId = stringValue(value.saleDraftId), quoteHash = stringValue(value.quoteHash), currency = stringValue(value.currency), state = stringValue(value.state);
  const draftRevision = Number(value.draftRevision), totalCents = Number(value.totalCents), version = Number(value.version);
  const evaluatedAt = stringValue(value.evaluatedAt), expiresAt = stringValue(value.expiresAt);
  if (!id || !saleDraftId || !/^[0-9a-f]{64}$/.test(quoteHash) || currency !== "BRL" || !["quoted", "active", "expired", "superseded", "consumed"].includes(state)
    || ![draftRevision, totalCents, version].every(Number.isSafeInteger) || draftRevision < 0 || totalCents <= 0 || version < 0
    || !Number.isFinite(new Date(evaluatedAt).valueOf()) || !Number.isFinite(new Date(expiresAt).valueOf())) return null;
  const rawSlots = Array.isArray(value.slots) ? value.slots : [], slots: PaymentPlanSlot[] = [];
  for (const [position, raw] of rawSlots.entries()) {
    if (!isRecord(raw)) return null;
    const paymentIndex = Number(raw.paymentIndex), amountCents = Number(raw.amountCents), installments = Number(raw.installments);
    const method = stringValue(raw.method) as PaymentMethod, proofKind = stringValue(raw.proofKind) as PaymentPlanSlot["proofKind"];
    if (paymentIndex !== position || !paymentMethods.includes(method) || !["cash", "value", "intent", "manual"].includes(proofKind)
      || !Number.isSafeInteger(amountCents) || amountCents <= 0 || !Number.isSafeInteger(installments) || installments < 1 || installments > 24) return null;
    slots.push({ paymentIndex, method, amountCents, installments, proofKind, connectorId: nullableString(raw.connectorId), provider: nullableString(raw.provider) });
  }
  if (state === "active" && (!slots.length || slots.reduce((sum, slot) => sum + slot.amountCents, 0) !== totalCents)) return null;
  return { id, saleDraftId, draftRevision, quoteHash, totalCents, currency, state: state as PaymentPlan["state"], version, evaluatedAt, expiresAt, activatedAt: nullableString(value.activatedAt), consumedAt: nullableString(value.consumedAt), slots };
}

function recoveryDraftSignature(draftId: string, sessionId: number, customerId: number | null, notes: string, fulfillmentMode: FulfillmentMode, discountCents: number, surchargeCents: number, lines: CartLine[]) {
  return stableJson({
    draftId,
    sessionId,
    customerId,
    notes,
    fulfillmentMode,
    discountCents,
    surchargeCents,
    items: lines.map(line => ({
      productId: line.product.id,
      variationId: line.product.resolvedVariationId || null,
      quantity: line.quantity,
      unitPriceCents: line.product.priceCents,
      discountCents: line.discountCents,
      scanData: line.scanData || null,
    })).sort((left, right) => left.productId - right.productId || (left.variationId || 0) - (right.variationId || 0)),
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function draftRecoveryIssueLabel(code: string) {
  return ({
    multiple_drafts: "Há mais de um rascunho ativo; seleção automática recusada",
    orphan_intent: "Intenção ativa sem o rascunho exato",
    captured_orphan: "Captura confirmada sem o rascunho exato",
    unknown_orphan: "Resultado desconhecido sem o rascunho exato",
    orphan_manual_reference: "Referência manual ativa sem o rascunho exato",
    manual_reference_rejected: "Referência manual rejeitada exige revogação auditada",
    manual_reference_expired: "Aprovação manual pendente expirou e exige resolução por outro supervisor",
    manual_reference_approved_expired: "Aprovação manual expirou após aprovada e exige reconciliação explícita",
    duplicate_payment_index: "Mais de uma prova financeira ocupa a mesma divisão",
    payment_index_gap: "Há divisão local não persistida entre as provas financeiras",
    invalid_recovery_payload: "Resposta de recuperação incompleta",
  } as Record<string, string>)[code] || `Pendência de recuperação: ${code}`;
}

function manualOccurrenceIso(value: string) { const parsed = new Date(value); return value && Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : ""; }

function supportedPaymentMethod(value: unknown): PaymentMethod {
  return paymentMethods.includes(value as PaymentMethod) ? value as PaymentMethod : "cash";
}


function cartKey(product: Product) { return `${product.id}:${product.resolvedVariationId || 0}`; }
function orderLineSort(left: { productId: number; variationId: number | null }, right: { productId: number; variationId: number | null }) { return left.productId - right.productId || (left.variationId || 0) - (right.variationId || 0); }

function mergeTrackingScanData(existing: CartLine | undefined, incoming: Record<string, unknown> | undefined, increment: number) {
  if (!incoming) return existing?.scanData;
  const merged: Record<string, unknown> = { ...existing?.scanData, ...incoming };
  if (isRecord(incoming.codeRead)) merged.codeReads = [...codeReads(existing?.scanData), incoming.codeRead];
  const lot = stringValue(incoming.lot).trim();
  const serial = stringValue(incoming.serial).trim();
  if (!lot && !serial) return merged;
  const previous = trackingReads(existing?.scanData, existing?.quantity);
  return { ...merged, tracking: [...previous, { ...(lot ? { lot } : {}), ...(serial ? { serial } : {}), quantity: increment }] };
}

function hasTrackingReads(scanData?: Record<string, unknown>) {
  return trackingReads(scanData).length > 0;
}

function trackingSummary(scanData?: Record<string, unknown>) {
  const reads = trackingReads(scanData);
  const identities = reads.map((read) => stringValue(read.serial).trim() ? `série ${stringValue(read.serial).trim()}` : `lote ${stringValue(read.lot).trim()}`);
  const tracked = identities.length ? ` · ${identities.slice(0, 2).join(" · ")}${identities.length > 2 ? ` · +${identities.length - 2} leituras` : ""}` : "";
  const codes = codeReads(scanData);
  return `${tracked}${codes.length ? ` · ${codes.length} código(s) revalidado(s)` : ""}`;
}

function hasCodeReads(scanData?: Record<string, unknown>) { return codeReads(scanData).length > 0; }
function codeReads(scanData?: Record<string, unknown>) {
  if (!scanData) return [] as Record<string, unknown>[];
  if (Array.isArray(scanData.codeReads)) return scanData.codeReads.filter(isRecord);
  return isRecord(scanData.codeRead) ? [scanData.codeRead] : [];
}

function trackingReads(scanData?: Record<string, unknown>, legacyQuantity = 1) {
  if (!scanData) return [] as Record<string, unknown>[];
  if (Array.isArray(scanData.tracking)) return scanData.tracking.filter(isRecord);
  const lot = stringValue(scanData.lot).trim();
  const serial = stringValue(scanData.serial).trim();
  return lot || serial ? [{ ...(lot ? { lot } : {}), ...(serial ? { serial } : {}), quantity: legacyQuantity }] : [];
}

function isLocallyReversibleSale(sale: PdvData["recentSales"][number]) {
  const originalPayments = sale.payments.filter((payment) => payment.type === "payment");
  return originalPayments.length > 0 && originalPayments.every((payment) => ["cash", "store_credit"].includes(payment.method) && ["authorized", "captured", "paid", "partially_refunded", "refunded"].includes(payment.status));
}

function isReturnEligibleSale(sale: PdvData["recentSales"][number]) {
  return ["completed", "partially_returned"].includes(sale.status) && sale.items.some((item) => item.quantity - (item.returnedQuantity || 0) > 0.000001);
}

function localPaymentSummary(sale: PdvData["recentSales"][number]) {
  return [...new Set(sale.payments.filter((payment) => payment.type === "payment").map((payment) => paymentLabels[payment.method] || payment.method))].join(" + ");
}

function positiveBigInt(value: string) {
  return /^\d+$/.test(value) ? BigInt(value) : BigInt(0);
}

function valueBalance(account: ValueAccount) {
  return account.unit === "cents" ? money(Number(positiveBigInt(account.availableUnits))) : `${account.availableUnits} pontos`;
}

function parseSaleQuantity(value: string) {
  const quantity = Number(value.trim().replace(",", "."));
  if (!Number.isFinite(quantity)) return 0;
  return Math.round(quantity * 1000) / 1000;
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(value);
}

function changePayment(setter: React.Dispatch<React.SetStateAction<Payment[]>>, key: string, field: keyof Payment, value: string) {
  setter((current) => current.map((item) => item.key === key ? { ...item, [field]: value, manualReference: null, electronicIntent: null } : item));
}

function positiveInteger(value: string, fallback: number) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 24 ? parsed : fallback; }

function parseMoney(value: string) {
  const compact = value.trim().replace(/[^\d,.-]/g, "").replace(/-/g, "");
  if (!compact) return 0;
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  let normalized = compact;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    normalized = compact.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const parts = compact.split(separator);
    const fraction = parts.at(-1) || "";
    normalized = fraction.length > 0 && fraction.length <= 2 ? `${parts.slice(0, -1).join("")}.${fraction}` : parts.join("");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : 0;
}

function formatInput(cents: number) {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function money(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function maskDocument(value: string) {
  return value.length <= 4 ? value : `${"•".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function mergeById<T extends { id: number }>(current: T[], incoming: T[]) {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

function posCustomerSearchQuery(value: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!/^[\d./\s-]+$/.test(normalized)) return normalized;
  const digits = normalized.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : digits;
}

function PdvToastViewport({ notice, error, clearNotice, clearError }: { notice: string; error: string; clearNotice(): void; clearError(): void }) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const items = Array.from(viewport.current?.children || []);
    if (!items.length) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(items, { autoAlpha: 0, x: 24, scale: .98 }, { autoAlpha: 1, x: 0, scale: 1, duration: .26, stagger: .04, ease: "power2.out", clearProps: "all" });
    });
    return () => media.revert();
  }, [notice, error]);
  if (!notice && !error) return null;
  return <aside ref={viewport} className="pos-toast-viewport" aria-label="Notificações do PDV">
    {error && <div className="pos-toast error" role="alert"><span aria-hidden="true">!</span><div><strong>Não foi possível concluir</strong><p>{error}</p></div><button type="button" onClick={clearError} aria-label="Fechar erro">×</button></div>}
    {notice && <div className="pos-toast success" role="status" aria-live="polite"><span aria-hidden="true">✓</span><div><strong>Concluído</strong><p>{notice}</p></div><button type="button" onClick={clearNotice} aria-label="Fechar aviso">×</button></div>}
  </aside>;
}

function PdvRecoveryFeedback({ feedback }: { feedback: RecoveryFeedback }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(element.current, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: .24, ease: "power2.out", clearProps: "all" });
    });
    return () => media.revert();
  }, [feedback.at]);
  return <div ref={element} className={`pos-recovery-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}><span aria-hidden="true">{feedback.kind === "success" ? "✓" : feedback.kind === "warning" ? "!" : "×"}</span><div><strong>{feedback.title}</strong><p>{feedback.text}</p></div></div>;
}

function normalizeResolvedProduct(value: Record<string, unknown> | null, fallback?: Product): Product | null {
  if (!value) return fallback || null;
  const id = Number(value.id);
  const priceCents = Number.isFinite(Number(value.priceCents)) ? Number(value.priceCents) : Number.isFinite(Number(value.price)) ? Math.round(Number(value.price) * 100) : fallback?.priceCents;
  const name = stringValue(value.name) || fallback?.name;
  const sku = stringValue(value.sku) || fallback?.sku;
  if (!Number.isSafeInteger(id) || id <= 0 || priceCents == null || !Number.isFinite(priceCents) || !name || !sku) return null;
  const rawStock = value.stock;
  const stock = rawStock == null ? fallback?.stock ?? null : Number.isFinite(Number(rawStock)) ? Number(rawStock) : fallback?.stock ?? null;
  return {
    id,
    name,
    sku,
    barcode: nullableString(value.barcode) ?? fallback?.barcode,
    gtin: nullableString(value.gtin) ?? fallback?.gtin,
    type: stringValue(value.type) || fallback?.type || "product",
    unit: stringValue(value.unit) || fallback?.unit || "UN",
    category: stringValue(value.category) || fallback?.category,
    imageUrl: nullableString(value.imageUrl) ?? fallback?.imageUrl,
    priceCents: Math.round(priceCents),
    stock,
    soldIndividually: typeof value.soldIndividually === "boolean" ? value.soldIndividually : fallback?.soldIndividually || false,
    resolvedVariationId: Number.isSafeInteger(Number(value.resolvedVariationId)) && Number(value.resolvedVariationId) > 0 ? Number(value.resolvedVariationId) : fallback?.resolvedVariationId || null,
  };
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function localDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
