export class OmnichannelInputError extends Error {}

export function channelInput(value: unknown) {
  const input = record(value);
  return {
    name: text(input.name, "Nome do canal"),
    provider: choice(input.provider, [
      "mercado_livre",
      "shopee",
      "woocommerce",
      "shopify",
      "amazon",
      "magalu",
      "nuvemshop",
      "tiktok_shop",
      "other",
    ]),
    environment: choice(input.environment || "production", [
      "sandbox",
      "production",
    ]),
    autoImport: boolean(input.autoImport, true),
    stockBuffer: number(input.stockBuffer || 0, 0),
    priceAdjustment: rangedNumber(input.priceAdjustment || 0, -90, 500),
    syncInterval: integer(input.syncInterval ?? 15, 1, 1440),
  };
}

export function listingInput(value: unknown) {
  const input = record(value);
  return {
    channelId: id(input.channelId),
    productId: id(input.productId),
    externalId: text(input.externalId, "Código externo", 120),
    title: text(input.title, "Título"),
    price: number(input.price, 0),
  };
}

export function marketplaceOrderInput(value: unknown) {
  const input = record(value),
    rows = Array.isArray(input.items) ? input.items : [];
  if (!rows.length)
    throw new OmnichannelInputError("Informe os itens do pedido.");
  const seen = new Set<number>();
  const items = rows.map((raw) => {
    const row = record(raw),
      productId = id(row.productId);
    if (seen.has(productId))
      throw new OmnichannelInputError("Produto repetido no pedido.");
    seen.add(productId);
    return {
      productId,
      quantity: number(row.quantity, 0.0001),
      unitPrice: number(row.unitPrice, 0),
    };
  });
  const total =
    Math.round(
      items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) *
        100,
    ) / 100;
  return {
    channelId: id(input.channelId),
    externalId: text(input.externalId, "Pedido externo", 120),
    customerName: text(input.customerName, "Cliente"),
    customerDocument: optional(input.customerDocument, 30),
    customerEmail: optional(input.customerEmail, 254),
    customerPhone: optional(input.customerPhone, 30),
    deliveryZip: optional(input.deliveryZip, 12)?.replace(/\D/g, "") || null,
    deliveryStreet: optional(input.deliveryStreet, 180),
    deliveryNumber: optional(input.deliveryNumber, 30),
    deliveryComplement: optional(input.deliveryComplement, 120),
    deliveryDistrict: optional(input.deliveryDistrict, 120),
    deliveryCity: optional(input.deliveryCity, 120),
    deliveryState: optional(input.deliveryState, 2)?.toUpperCase() || null,
    fee: number(input.fee || 0, 0),
    marketplaceStatus: optional(input.marketplaceStatus, 120),
    paymentStatus: choice(input.paymentStatus || "unknown", [
      "unknown",
      "pending",
      "paid",
      "partially_refunded",
      "refunded",
      "cancelled",
    ]),
    riskStatus: choice(input.riskStatus || "unknown", [
      "unknown",
      "approved",
      "review",
      "blocked",
    ]),
    buyerCancelRequested: boolean(input.buyerCancelRequested, false),
    shipByAt: dateTime(input.shipByAt),
    deliverByAt: dateTime(input.deliverByAt),
    cancelByAt: dateTime(input.cancelByAt),
    connectionId: optional(input.connectionId, 160),
    shipmentExternalId: optional(input.shipmentExternalId, 160),
    logisticType: optional(input.logisticType, 80),
    buyerShippingCost: number(input.buyerShippingCost || 0, 0),
    sellerShippingCost: number(input.sellerShippingCost || 0, 0),
    commission: number(input.commission || input.fee || 0, 0),
    invoiceExternalId: optional(input.invoiceExternalId, 160),
    invoiceStatus: optional(input.invoiceStatus, 80),
    eventKey: optional(input.eventKey, 200),
    eventType: optional(input.eventType, 120) || "order.created",
    rawData: safeJson(input.rawData),
    items,
    total,
  };
}

export function marketplaceOrderStateInput(value: unknown) {
  const input = record(value);
  return {
    orderId: id(input.orderId),
    paymentStatus: choice(input.paymentStatus || "unknown", [
      "unknown",
      "pending",
      "paid",
      "partially_refunded",
      "refunded",
      "cancelled",
    ]),
    riskStatus: choice(input.riskStatus || "unknown", [
      "unknown",
      "approved",
      "review",
      "blocked",
    ]),
    buyerCancelRequested: boolean(input.buyerCancelRequested, false),
    marketplaceStatus: optional(input.marketplaceStatus, 120),
    invoiceStatus: optional(input.invoiceStatus, 80),
    shipByAt: dateTime(input.shipByAt),
    deliverByAt: dateTime(input.deliverByAt),
    cancelByAt: dateTime(input.cancelByAt),
  };
}

export function shipmentInput(value: unknown) {
  const input = record(value),
    rawItems = Array.isArray(input.items) ? input.items : [],
    seen = new Set<number>();
  return {
    salesOrderId: id(input.salesOrderId),
    warehouseId: id(input.warehouseId),
    carrier: optional(input.carrier, 120),
    service: optional(input.service, 120),
    freight: number(input.freight || 0, 0),
    deadlineAt: date(input.deadlineAt),
    dispatchDeadlineAt: dateTime(input.dispatchDeadlineAt),
    priority: choice(input.priority || "normal", [
      "low",
      "normal",
      "high",
      "urgent",
    ]),
    packageCount: integer(input.packageCount ?? 1, 1, 999),
    weightKg: optionalNumber(input.weightKg, 0.001),
    lengthCm: optionalNumber(input.lengthCm, 0.01),
    widthCm: optionalNumber(input.widthCm, 0.01),
    heightCm: optionalNumber(input.heightCm, 0.01),
    items: rawItems.map((raw) => {
      const row = record(raw),
        orderItemId = id(row.orderItemId);
      if (seen.has(orderItemId))
        throw new OmnichannelInputError("Item repetido na expedição.");
      seen.add(orderItemId);
      return {
        orderItemId,
        quantity: number(row.quantity, 0.0001),
      };
    }),
  };
}

export function shipmentPackingInput(value: unknown) {
  const input = record(value),
    rawPackages = Array.isArray(input.packages) ? input.packages : [];
  const parsed = {
    shipmentId: id(input.shipmentId),
    packageCount: integer(input.packageCount ?? 1, 1, 999),
    weightKg: optionalNumber(input.weightKg, 0.001),
    lengthCm: optionalNumber(input.lengthCm, 0.01),
    widthCm: optionalNumber(input.widthCm, 0.01),
    heightCm: optionalNumber(input.heightCm, 0.01),
    packages: rawPackages.map((raw, index) => {
      const row = record(raw),
        rawItems = Array.isArray(row.items) ? row.items : [];
      return {
        sequence: integer(row.sequence ?? index + 1, 1, 999),
        weightKg: number(row.weightKg, 0.001),
        lengthCm: number(row.lengthCm, 0.01),
        widthCm: number(row.widthCm, 0.01),
        heightCm: number(row.heightCm, 0.01),
        sscc: optional(row.sscc, 18),
        trackingCode: optional(row.trackingCode, 160),
        labelUrl: optionalHttpUrl(row.labelUrl),
        labelFormat: choice(row.labelFormat || "pdf", ["pdf", "zpl"]),
        items: rawItems.map((rawItem) => {
          const item = record(rawItem);
          return {
            shipmentItemId: id(item.shipmentItemId),
            quantity: number(item.quantity, 0.0001),
          };
        }),
      };
    }),
  };
  if (parsed.packages.length && parsed.packages.length !== parsed.packageCount)
    throw new OmnichannelInputError(
      "A quantidade de volumes não corresponde ao detalhamento informado.",
    );
  if (
    new Set(parsed.packages.map((item) => item.sequence)).size !==
    parsed.packages.length
  )
    throw new OmnichannelInputError(
      "A sequência dos volumes não pode se repetir.",
    );
  if (
    [parsed.weightKg, parsed.lengthCm, parsed.widthCm, parsed.heightCm].some(
      (item) => item === null,
    )
  )
    throw new OmnichannelInputError(
      "Informe peso, comprimento, largura e altura antes de embalar.",
    );
  return parsed;
}

export function shipmentPickingInput(value: unknown) {
  const input = record(value),
    rows = Array.isArray(input.items) ? input.items : [];
  if (!rows.length)
    throw new OmnichannelInputError("Informe os itens separados.");
  const seen = new Set<number>();
  return {
    shipmentId: id(input.shipmentId),
    items: rows.map((raw) => {
      const row = record(raw),
        itemId = id(row.itemId);
      if (seen.has(itemId))
        throw new OmnichannelInputError("Item repetido na separação.");
      seen.add(itemId);
      const allocations = Array.isArray(row.allocations)
        ? row.allocations.map((rawAllocation) => {
            const allocation = record(rawAllocation);
            return {
              lotId: optional(allocation.lotId, 120),
              quantity: number(allocation.quantity, 0.0001),
              location: optional(allocation.location, 120),
              scannedCode: optional(allocation.scannedCode, 160),
            };
          })
        : [];
      return {
        itemId,
        pickedQuantity: number(row.pickedQuantity, 0),
        shortQuantity: number(row.shortQuantity || 0, 0),
        location: optional(row.location, 120),
        allocations,
      };
    }),
  };
}

export function shipmentDeliveryInput(value: unknown) {
  const input = record(value);
  return {
    shipmentId: id(input.shipmentId),
    recipient: text(input.recipient, "Recebedor", 180),
    document: optional(input.document, 30),
    notes: optional(input.notes, 500),
    proofUrl: optionalHttpUrl(input.proofUrl),
  };
}

export function shipmentDispatchInput(value: unknown) {
  const input = record(value);
  return {
    shipmentId: id(input.shipmentId),
    carrier: text(input.carrier, "Transportadora", 120),
    service: optional(input.service, 120),
    trackingCode: text(input.trackingCode, "Código de rastreio", 120),
  };
}

export function entityId(value: unknown) {
  return id(value);
}
export function incidentInput(value: unknown) {
  const input = record(value);
  const dueAt = dateTime(input.dueAt);
  if (!dueAt) throw new OmnichannelInputError("Informe o prazo da ocorrência.");
  return {
    shipmentId: id(input.shipmentId),
    category: choice(input.category || "operational", [
      "operational",
      "stock",
      "carrier",
      "address",
      "damage",
      "fiscal",
      "customer",
      "other",
    ]),
    owner: text(input.owner, "Responsável", 120),
    severity: choice(input.severity || "medium", [
      "low",
      "medium",
      "high",
      "critical",
    ]),
    dueAt,
    description: text(input.description, "Descrição", 500),
    rootCause: optional(input.rootCause, 500),
    claimCents: Math.round(number(input.claimAmount || 0, 0) * 100),
  };
}
export function incidentResolutionInput(value: unknown) {
  const input = record(value);
  return {
    shipmentId: id(input.shipmentId),
    resolution: text(input.resolution, "Resolução", 500),
    rootCause: optional(input.rootCause, 500),
  };
}
export function shipmentTrackingInput(value: unknown) {
  const input = record(value),
    occurredAt = dateTime(input.occurredAt);
  if (!occurredAt)
    throw new OmnichannelInputError("Informe a data do checkpoint.");
  return {
    shipmentId: id(input.shipmentId),
    packageId: optional(input.packageId, 120),
    status: choice(input.status || "in_transit", [
      "in_transit",
      "out_for_delivery",
      "delivery_failed",
      "awaiting_pickup",
      "returned_to_sender",
      "delivered",
    ]),
    description: text(input.description, "Descrição", 500),
    location: optional(input.location, 180),
    occurredAt,
  };
}
export function shippingManifestInput(value: unknown) {
  const input = record(value),
    rawIds = Array.isArray(input.shipmentIds) ? input.shipmentIds : [],
    shipmentIds = [...new Set(rawIds.map(id))];
  if (!shipmentIds.length || shipmentIds.length > 100)
    throw new OmnichannelInputError(
      "Selecione de 1 a 100 expedições para o romaneio.",
    );
  return {
    shipmentIds,
    manifestNumber: optional(input.manifestNumber, 120),
    carrier: optional(input.carrier, 120),
    confirmHandoff: boolean(input.confirmHandoff, false),
    pickupWindow: dateTime(input.pickupWindow),
    dock: optional(input.dock, 80),
    vehiclePlate: optional(input.vehiclePlate, 12)?.toUpperCase() || null,
    driverName: optional(input.driverName, 160),
    driverDocument: optional(input.driverDocument, 30),
    protocol: optional(input.protocol, 160),
  };
}
export function reverseLogisticsInput(value: unknown) {
  const input = record(value);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  return {
    shipmentId: id(input.shipmentId),
    reason: choice(input.reason || "other", [
      "withdrawal",
      "defect",
      "wrong_item",
      "damage",
      "delivery_failure",
      "other",
    ]),
    description: text(input.description, "Descrição", 500),
    customerEmail: email(input.customerEmail),
    provider: optional(input.provider, 120),
    reverseCode: optional(input.reverseCode, 160),
    trackingCode: optional(input.trackingCode, 160),
    labelUrl: optionalHttpUrl(input.labelUrl),
    items: rawItems.map((raw) => {
      const item = record(raw);
      return {
        orderItemId: id(item.orderItemId),
        quantity: number(item.quantity, 0.0001),
      };
    }),
  };
}
export function reverseLogisticsStateInput(value: unknown) {
  const input = record(value);
  return {
    returnId: id(input.returnId),
    status: choice(input.status, [
      "authorized",
      "in_transit",
      "received",
      "completed",
      "rejected",
      "cancelled",
    ]),
    provider: optional(input.provider, 120),
    reverseCode: optional(input.reverseCode, 160),
    trackingCode: optional(input.trackingCode, 160),
    labelUrl: optionalHttpUrl(input.labelUrl),
    notes: optional(input.notes, 500),
  };
}
export function returnInspectionInput(value: unknown) {
  const input = record(value),
    rawItems = Array.isArray(input.items) ? input.items : [];
  if (!rawItems.length)
    throw new OmnichannelInputError(
      "Informe os itens recebidos para inspeção.",
    );
  return {
    returnId: id(input.returnId),
    warehouseId: id(input.warehouseId),
    notes: optional(input.notes, 500),
    items: rawItems.map((raw) => {
      const item = record(raw);
      return {
        returnItemId: id(item.returnItemId),
        receivedQuantity: number(item.receivedQuantity, 0),
        condition: choice(item.condition || "opened", [
          "new",
          "opened",
          "used",
          "damaged",
          "defective",
        ]),
        disposition: choice(item.disposition || "quarantine", [
          "restock",
          "quarantine",
          "repair",
          "scrap",
          "return_to_supplier",
        ]),
        lotId: optional(item.lotId, 120),
        notes: optional(item.notes, 500),
      };
    }),
  };
}
export function shipmentCancellationInput(value: unknown) {
  const input = record(value);
  return {
    shipmentId: id(input.shipmentId),
    confirmation: String(input.confirmation || ""),
    reason: text(input.reason, "Motivo", 500),
  };
}
function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OmnichannelInputError("Dados inválidos.");
  return value as Record<string, unknown>;
}
function id(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new OmnichannelInputError("Registro inválido.");
  return parsed;
}
function text(value: unknown, label: string, max = 180) {
  const parsed = String(value || "").trim();
  if (parsed.length < 2 || parsed.length > max)
    throw new OmnichannelInputError(`${label} inválido.`);
  return parsed;
}
function optional(value: unknown, max: number) {
  const parsed = String(value || "").trim();
  if (parsed.length > max)
    throw new OmnichannelInputError("Texto muito longo.");
  return parsed || null;
}
function number(value: unknown, min: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > 1e9)
    throw new OmnichannelInputError("Valor inválido.");
  return parsed;
}
function rangedNumber(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new OmnichannelInputError("Valor fora do intervalo permitido.");
  return parsed;
}
function integer(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new OmnichannelInputError("Número inteiro inválido.");
  return parsed;
}
function optionalNumber(value: unknown, min: number) {
  if (value === undefined || value === null || value === "") return null;
  return number(value, min);
}
function choice(value: unknown, values: string[]) {
  const parsed = String(value);
  if (!values.includes(parsed))
    throw new OmnichannelInputError("Opção inválida.");
  return parsed;
}
function boolean(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === true || value === "true" || value === "on";
}
function date(value: unknown) {
  if (!value) return null;
  const parsed = new Date(`${String(value)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()))
    throw new OmnichannelInputError("Data inválida.");
  return parsed;
}
export function calendarDateInTimezone(value: unknown, timezone: string) {
  const parsed = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed))
    throw new OmnichannelInputError("Data inválida.");
  const guess = new Date(`${parsed}T12:00:00.000Z`);
  if (Number.isNaN(guess.valueOf()))
    throw new OmnichannelInputError("Data inválida.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(guess);
  if (parts !== parsed)
    throw new OmnichannelInputError("Data inválida para o fuso da filial.");
  return parsed;
}
function dateTime(value: unknown) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.valueOf()))
    throw new OmnichannelInputError("Data e hora inválidas.");
  return parsed;
}
function optionalHttpUrl(value: unknown) {
  const parsed = optional(value, 1000);
  if (!parsed) return null;
  try {
    const url = new URL(parsed);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new OmnichannelInputError("URL do comprovante inválida.");
  }
}
function email(value: unknown) {
  const parsed = String(value || "")
    .trim()
    .toLowerCase();
  if (parsed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed))
    throw new OmnichannelInputError("E-mail inválido.");
  return parsed;
}
function safeJson(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new OmnichannelInputError(
        "Payload original precisa ser um JSON válido.",
      );
    }
  }
  const serialized = JSON.stringify(parsed);
  if (!serialized || serialized.length > 1_000_000)
    throw new OmnichannelInputError(
      "Payload original excede o limite de 1 MB.",
    );
  return parsed as object;
}
