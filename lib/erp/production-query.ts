import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import {
  asQuantity,
  integer,
  materialNeeds,
  quantity,
  snapshotInput,
  ZERO,
} from "./production-domain";
import { ProductionInputError } from "./production-input";
import { posBusinessDate } from "./pos-inventory-operations";

type Reader = PrismaClient | Prisma.TransactionClient;
const productSelect = {
  id: true,
  name: true,
  sku: true,
  unit: true,
  cost: true,
  catalogType: true,
  manageStock: true,
} as const;

export async function productionRead(
  db: PrismaClient,
  params: URLSearchParams,
) {
  const resource = params.get("resource") || "orders";
  const take = integer(params.get("limit") || 30, "Limite", 1, 100);
  const after = params.has("after")
    ? integer(params.get("after"), "Cursor", 1)
    : undefined;
  const search = (params.get("search") || "").trim().slice(0, 180);
  if (resource === "changes") {
    const latest = await db.productionEvent.findFirst({
      orderBy: { id: "desc" },
      select: { id: true },
    });
    const latestCommand = await db.productionCommand.findFirst({
      orderBy: [{ createdAt: "desc" }, { key: "desc" }],
      select: { key: true, createdAt: true },
    });
    return {
      revision: `${latest?.id ?? 0}:${latestCommand?.createdAt.toISOString() ?? ""}:${latestCommand?.key ?? ""}`,
    };
  }
  if (resource === "detail") {
    const id = integer(params.get("id"), "Ordem", 1);
    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id },
      include: {
        bom: { select: { id: true, code: true, name: true } },
        revision: true,
        warehouse: { select: { id: true, name: true } },
        outputProduct: { select: productSelect },
        workCenter: true,
        dependencies: {
          include: {
            predecessor: {
              select: {
                id: true,
                number: true,
                status: true,
                scheduledEnd: true,
              },
            },
          },
        },
        reservations: { orderBy: [{ productId: "asc" }, { createdAt: "asc" }] },
        reports: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
          include: {
            inspections: true,
            consumptions: { include: { reservation: true } },
          },
        },
        _count: { select: { reports: true } },
      },
    });
    const lots = await db.posInventoryLot.findMany({
      where: {
        id: {
          in: order.reservations.flatMap((row) =>
            row.lotId ? [row.lotId] : [],
          ),
        },
      },
      select: {
        id: true,
        lotCode: true,
        serialNumber: true,
        expiresOn: true,
        status: true,
      },
    });
    const events = await db.productionEvent.findMany({
      where: { orderId: id },
      orderBy: { id: "desc" },
      take: 50,
    });
    const materials = await productionRequirements(db, id);
    return {
      order,
      materials,
      lots,
      events,
      reportsHaveMore: order._count.reports > order.reports.length,
    };
  }
  if (resource === "reports") {
    const orderId = integer(params.get("orderId"), "Ordem", 1),
      reportAfter = params.get("reportAfter");
    const rows = await db.productionReport.findMany({
      where: { orderId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(reportAfter ? { cursor: { id: reportAfter }, skip: 1 } : {}),
      take: take + 1,
      include: {
        inspections: true,
        consumptions: { include: { reservation: true } },
      },
    });
    return {
      items: rows.slice(0, take),
      nextCursor: rows.length > take ? rows[take - 1].id : null,
    };
  }
  if (resource === "events") {
    const orderId = integer(params.get("orderId"), "Ordem", 1);
    const rows = await db.productionEvent.findMany({
      where: { orderId, ...(after ? { id: { lt: BigInt(after) } } : {}) },
      orderBy: { id: "desc" },
      take: take + 1,
    });
    return {
      items: rows.slice(0, take),
      nextCursor: rows.length > take ? String(rows[take - 1].id) : null,
    };
  }
  if (resource === "products") {
    const rows = await db.product.findMany({
      where: {
        active: true,
        manageStock: true,
        type: { not: "service" },
        ...(after ? { id: { gt: after } } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { sku: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { id: "asc" },
      take: take + 1,
      select: {
        ...productSelect,
        variations: {
          where: { enabled: true, manageStock: "true" },
          take: 200,
          select: { id: true, sku: true, attributes: true },
        },
      },
    });
    return page(rows, take);
  }
  if (resource === "warehouses") {
    const rows = await db.warehouse.findMany({
      where: {
        active: true,
        ...(after ? { id: { gt: after } } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { code: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { id: "asc" },
      take: take + 1,
      select: { id: true, name: true, code: true, branchId: true },
    });
    return page(rows, take);
  }
  if (resource === "suppliers") {
    const rows = await db.supplier.findMany({
      where: {
        status: "active",
        ...(after ? { id: { gt: after } } : {}),
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      orderBy: { id: "asc" },
      take: take + 1,
      select: { id: true, name: true },
    });
    return page(rows, take);
  }
  if (resource === "centers") {
    const cursor = params.get("centerAfter");
    const rows = await db.productionWorkCenter.findMany({
      where: search ? { name: { contains: search, mode: "insensitive" } } : {},
      orderBy: [{ name: "asc" }, { id: "asc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: take + 1,
    });
    return {
      items: rows.slice(0, take),
      nextCursor: rows.length > take ? rows[take - 1].id : null,
    };
  }
  if (resource === "boms") {
    const rows = await db.billOfMaterial.findMany({
      where: {
        ...(after ? { id: { lt: after } } : {}),
        ...(params.get("active") === "true" ? { active: true } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { code: { contains: search, mode: "insensitive" } },
                {
                  outputProduct: {
                    name: { contains: search, mode: "insensitive" },
                  },
                },
              ],
            }
          : {}),
      },
      take: take + 1,
      orderBy: { id: "desc" },
      include: {
        outputProduct: { select: productSelect },
        revisions: { orderBy: { version: "desc" }, take: 1 },
        _count: { select: { orders: true, revisions: true } },
      },
    });
    return page(rows, take);
  }
  if (resource === "revisions") {
    const bomId = integer(params.get("bomId"), "Ficha", 1);
    const rows = await db.productionBomRevision.findMany({
      where: { bomId, ...(after ? { version: { lt: after } } : {}) },
      orderBy: { version: "desc" },
      take: take + 1,
    });
    return {
      items: rows.slice(0, take),
      nextCursor: rows.length > take ? rows[take - 1].version : null,
    };
  }
  if (resource === "mrp")
    return {
      materials: await productionRequirements(
        db,
        integer(params.get("orderId"), "Ordem", 1),
      ),
    };
  if (resource === "summary") {
    const groups = await db.productionOrder.groupBy({
      by: ["status"],
      _count: { _all: true },
      _sum: { actualCost: true, plannedQuantity: true, producedQuantity: true },
    });
    const overdue = await db.productionOrder.count({
      where: {
        status: { in: ["planned", "in_progress", "paused"] },
        dueAt: { lt: new Date(new Date().toISOString().slice(0, 10)) },
      },
    });
    const quarantine = await db.productionReport.count({
      where: { status: "quarantine" },
    });
    return { groups, overdue, quarantine };
  }
  if (resource === "orders" || resource === "calendar") {
    const status = params.get("status"),
      priority = params.get("priority"),
      tag = params.get("tag");
    const where: Prisma.ProductionOrderWhereInput = {
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
      ...(params.get("overdue") === "true"
        ? {
            status: { in: ["planned", "in_progress", "paused"] },
            dueAt: { lt: new Date(new Date().toISOString().slice(0, 10)) },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search, mode: "insensitive" } },
              { assignedTo: { contains: search, mode: "insensitive" } },
              {
                outputProduct: {
                  name: { contains: search, mode: "insensitive" },
                },
              },
              { bom: { name: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    if (resource === "calendar") {
      const start = new Date(params.get("start") || new Date().toISOString()),
        end = new Date(
          params.get("end") ||
            new Date(Date.now() + 7 * 86400000).toISOString(),
        );
      if (
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        end <= start ||
        end.getTime() - start.getTime() > 31 * 86400000
      )
        throw new ProductionInputError("Consulte até 31 dias do calendário.");
      where.scheduledStart = { lt: end };
      where.scheduledEnd = { gt: start };
    }
    const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (params.get("overdue") === "true") {
      clauses.push(Prisma.sql`o.status IN ('planned','in_progress','paused') AND o.due_at < ${new Date(new Date().toISOString().slice(0, 10))}`);
    } else if (status) clauses.push(Prisma.sql`o.status = ${status}`);
    if (priority) clauses.push(Prisma.sql`o.priority = ${priority}`);
    if (tag) clauses.push(Prisma.sql`${tag} = ANY(o.tags)`);
    if (search) {
      const term = `%${search}%`;
      clauses.push(Prisma.sql`(o.number ILIKE ${term} OR o.assigned_to ILIKE ${term} OR p.name ILIKE ${term} OR b.name ILIKE ${term})`);
    }
    if (resource === "calendar") {
      const start = (where.scheduledEnd as Prisma.DateTimeNullableFilter).gt as Date;
      const end = (where.scheduledStart as Prisma.DateTimeNullableFilter).lt as Date;
      clauses.push(Prisma.sql`o.scheduled_start < ${end} AND o.scheduled_end > ${start}`);
    }
    // Rank before applying the page boundary: manual queue, urgency, deadline,
    // stable ID. Sorting only the visible page would hide urgent older orders.
    const rankedIds = await db.$queryRaw<Array<{ id: number }>>(Prisma.sql`
      WITH ranked AS (
        SELECT o.id, o.position,
          CASE o.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END AS urgency,
          COALESCE(o.due_at, 'infinity'::timestamp) AS deadline
        FROM production_orders o
        JOIN products p ON p.id = o.output_product_id
        JOIN bills_of_material b ON b.id = o.bom_id
        WHERE ${Prisma.join(clauses, " AND ")}
      )
      SELECT r.id FROM ranked r
      ${after ? Prisma.sql`WHERE (r.position,r.urgency,r.deadline,r.id) > (SELECT position,urgency,deadline,id FROM ranked WHERE id = ${after})` : Prisma.empty}
      ORDER BY r.position,r.urgency,r.deadline,r.id LIMIT ${take + 1}
    `);
    const [unordered, count] = await Promise.all([
      db.productionOrder.findMany({
        where: { id: { in: rankedIds.map((row) => row.id) } },
        include: {
          outputProduct: { select: productSelect },
          warehouse: { select: { id: true, name: true } },
          bom: { select: { id: true, name: true, code: true } },
          workCenter: { select: { id: true, name: true, wipLimit: true } },
          revision: { select: { version: true } },
          _count: { select: { reports: true } },
        },
      }),
      db.productionOrder.count({ where }),
    ]);
    const byId = new Map(unordered.map((row) => [row.id, row]));
    const rows = rankedIds.flatMap((row) => byId.has(row.id) ? [byId.get(row.id)!] : []);
    return { ...page(rows, take), total: count };
  }
  throw new ProductionInputError("Recurso de produção inválido.");
}

function page<T extends { id: number }>(rows: T[], take: number) {
  return {
    items: rows.slice(0, take),
    nextCursor: rows.length > take ? rows[take - 1].id : null,
  };
}

export async function productionRequirements(db: Reader, orderId: number) {
  const order = await db.productionOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      reservations: true,
      procurements: true,
    },
  });
  const snapshot = snapshotInput(order.snapshot);
  const totals = await db.productionReport.aggregate({
    where: { orderId },
    _sum: { producedMicros: true, scrapMicros: true, reworkMicros: true },
  });
  const processed =
    (totals._sum.producedMicros ?? ZERO) +
    (totals._sum.scrapMicros ?? ZERO) +
    (totals._sum.reworkMicros ?? ZERO);
  const left = quantity(order.plannedQuantity) - processed;
  const demands = materialNeeds(snapshot, left > ZERO ? left : ZERO);
  const ids = demands.map((item) => item.productId);
  const [
    products,
    balances,
    variations,
    incoming,
    trackedDimensions,
    lotBalances,
    reservedLots,
  ] = await Promise.all([
    db.product.findMany({
      where: { id: { in: ids } },
      select: {
        ...productSelect,
        active: true,
        expiry: true,
        expiryDate: true,
      },
    }),
    db.warehouseBalance.findMany({
      where: {
        productId: { in: ids },
        warehouse: {
          active: true,
          OR: [{ branchId: null }, { branch: { status: "active" } }],
        },
      },
      include: {
        warehouse: {
          select: {
            id: true,
            name: true,
            branch: { select: { timezone: true } },
          },
        },
      },
      take: 10001,
    }),
    db.warehouseVariationBalance.findMany({
      where: { productId: { in: ids } },
    }),
    db.purchaseOrder.findMany({
      where: {
        id: {
          in: order.procurements.flatMap((row) =>
            row.purchaseOrderId ? [row.purchaseOrderId] : [],
          ),
        },
        status: { notIn: ["cancelled", "completed"] },
      },
      include: { items: true },
    }),
    db.posInventoryLot.groupBy({
      by: ["productId", "variationId"],
      where: { productId: { in: ids } },
    }),
    db.posInventoryLot.groupBy({
      by: ["warehouseId", "productId", "variationId", "expiresOn"],
      where: {
        productId: { in: ids },
        status: "available",
        bucketKey: "sellable",
      },
      _sum: { quantityMicros: true, reservedMicros: true },
    }),
    db.posInventoryLot.findMany({
      where: {
        id: {
          in: order.reservations.flatMap((row) =>
            row.lotId ? [row.lotId] : [],
          ),
        },
      },
      select: { id: true, status: true, bucketKey: true, expiresOn: true },
    }),
  ]);
  if (balances.length > 10000)
    throw new ProductionInputError(
      "Limite de saldos excedido para esta consulta de materiais.",
    );
  return demands.map((item) => {
    const product = products.find((row) => row.id === item.productId)!;
    const balance = balances.find(
      (row) =>
        row.warehouseId === order.warehouseId &&
        row.productId === item.productId,
    );
    const tracked =
      Boolean(product.expiryDate || product.expiry?.trim()) ||
      trackedDimensions.some(
        (row) =>
          row.productId === item.productId &&
          row.variationId === item.variationId,
      );
    const businessDate = (row: (typeof balances)[number] | undefined) =>
      posBusinessDate(row?.warehouse.branch?.timezone || "America/Sao_Paulo");
    const freeStock = (row: (typeof balances)[number] | undefined) => {
      if (!row || !product.active || !product.manageStock) return 0;
      let available = Math.max(0, row.quantity - row.reservedQuantity);
      if (item.variationId !== null) {
        const variation = variations.find(
          (variant) =>
            variant.warehouseId === row.warehouseId &&
            variant.variationId === item.variationId,
        );
        available = Math.min(
          available,
          variation
            ? Math.max(0, variation.quantity - variation.reservedQuantity)
            : 0,
        );
      }
      if (tracked) {
        const date = businessDate(row);
        const sellable = lotBalances
          .filter(
            (lot) =>
              lot.warehouseId === row.warehouseId &&
              lot.productId === item.productId &&
              lot.variationId === item.variationId &&
              (!lot.expiresOn ||
                lot.expiresOn.toISOString().slice(0, 10) >= date),
          )
          .reduce(
            (sum, lot) =>
              sum +
              (lot._sum.quantityMicros ?? ZERO) -
              (lot._sum.reservedMicros ?? ZERO),
            ZERO,
          );
        available = Math.min(available, Math.max(0, asQuantity(sellable)));
      }
      return available;
    };
    const available = freeStock(balance);
    const reservedMicros = order.reservations
      .filter(
        (row) =>
          row.productId === item.productId &&
          row.variationId === item.variationId &&
          (!row.lotId ||
            reservedLots.some(
              (lot) =>
                lot.id === row.lotId &&
                lot.status === "available" &&
                lot.bucketKey === "sellable" &&
                (!lot.expiresOn ||
                  lot.expiresOn.toISOString().slice(0, 10) >=
                    businessDate(balance)),
            )),
      )
      .reduce(
        (sum, row) =>
          sum + row.quantityMicros - row.consumedMicros - row.releasedMicros,
        ZERO,
      );
    const incomingQuantity = incoming
          .flatMap((row) => row.items)
          .filter((row) => row.productId === item.productId && row.variationId === item.variationId)
          .reduce(
            (sum, row) =>
              sum + Math.max(0, row.quantity - row.receivedQuantity),
            0,
          );
    const required = asQuantity(item.requiredMicros),
      reserved = asQuantity(reservedMicros);
    const shortage = Math.max(
      0,
      Math.round((required - reserved - available) * 1e6) / 1e6,
    );
    return {
      product,
      productId: item.productId,
      variationId: item.variationId,
      required,
      available,
      reserved,
      shortage,
      incomingQuantity,
      netShortage: Math.max(0, shortage - incomingQuantity),
      sources: balances
        .filter(
          (row) =>
            row.productId === item.productId &&
            row.warehouseId !== order.warehouseId &&
            row.quantity > row.reservedQuantity,
        )
        .map((row) => ({
          warehouseId: row.warehouseId,
          name: row.warehouse.name,
          available: freeStock(row),
        }))
        .filter((row) => row.available > 0),
    };
  });
}
