import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import {
  ProductionInputError,
  productionOrderMetadataInput,
} from "./production-input";
import {
  asQuantity,
  assertScheduleWithinShifts,
  boundedText,
  cents,
  instant,
  integer,
  materialNeeds,
  object,
  quantity,
  reportCosts,
  requestHash,
  safeJson,
  shiftsInput,
  snapshotInput,
  uuid,
  ZERO,
  type ProductionSnapshot,
} from "./production-domain";
import {
  consumeProductionMaterials,
  decideProductionOutput,
  lockProductionStock,
  productionScope,
  quarantineProductionOutput,
  releaseProductionMaterials,
  reserveProductionMaterials,
  transferProductionMaterial,
} from "./production-stock";
import { productionRequirements } from "./production-query";

type Tx = Prisma.TransactionClient;
export type ProductionActor = { id: string; name: string };
export async function executeProductionCommand(
  db: PrismaClient,
  raw: unknown,
  actor: ProductionActor,
) {
  const body = object(raw),
    key = uuid(body.idempotencyKey);
  const action = boundedText(body.action, "Ação", 80, true),
    hash = requestHash(body);
  // The key, response and all inventory effects commit together; a lost response can be replayed.
  const runTransaction = () =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`production-command:${key}`}, 0))`;
        const prior = await tx.productionCommand.findUnique({ where: { key } });
        if (prior) {
          if (
            prior.actorId !== actor.id ||
            prior.requestHash !== hash ||
            prior.action !== action
          )
            throw new ProductionInputError(
              "A chave de operação já foi usada com outro conteúdo ou usuário.",
            );
          return prior.response;
        }
        const result = await dispatch(tx, action, body, actor);
        const response = safeJson({ ...result, correlationId: key });
        await tx.productionCommand.create({
          data: { key, actorId: actor.id, action, requestHash: hash, response },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: actor.id,
            action: `production.${action}`,
            entityType: "production",
            entityId: String(result.orderId ?? result.bomId ?? result.id ?? ""),
            correlationId: key,
            afterData: response,
          },
        });
        return response;
      },
      { isolationLevel: "Serializable", timeout: 30000 },
    );
  for (let attempt = 0; ; attempt++) {
    try {
      return await runTransaction();
    } catch (error) {
      // PostgreSQL has rolled back P2034 transactions. Replay the same key and
      // entire transaction, never just an individual stock write.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        attempt >= 3
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 25 * 2 ** attempt + Math.random() * 25),
      );
    }
  }
}

async function dispatch(
  tx: Tx,
  action: string,
  body: Record<string, unknown>,
  actor: ProductionActor,
): Promise<Record<string, unknown>> {
  if (action === "bom.create" || action === "bom.revise") {
    const snapshot = snapshotInput(body.snapshot);
    await validateComposition(tx, snapshot);
    let bomId: number;
    if (action === "bom.create") {
      const bom = await tx.billOfMaterial.create({
        data: {
          name: snapshot.name,
          code: snapshot.code,
          outputProductId: snapshot.outputProductId,
          yieldQuantity: snapshot.yieldQuantity,
          notes: snapshot.notes,
          items: { create: aggregateLegacyItems(snapshot) },
        },
      });
      bomId = bom.id;
    } else {
      bomId = integer(body.bomId, "Ficha", 1);
      await tx.$queryRaw`SELECT id FROM bills_of_material WHERE id = ${bomId} FOR UPDATE`;
      const bom = await tx.billOfMaterial.findUniqueOrThrow({
        where: { id: bomId },
      });
      if (snapshot.outputProductId !== bom.outputProductId)
        throw new ProductionInputError(
          "Uma revisão deve manter o produto acabado da ficha.",
        );
    }
    const last = await tx.productionBomRevision.aggregate({
      where: { bomId },
      _max: { version: true },
    });
    const revision = await tx.productionBomRevision.create({
      data: {
        bomId,
        version: (last._max.version ?? 0) + 1,
        snapshot: safeJson(snapshot),
        createdBy: actor.id,
      },
    });
    return {
      bomId,
      revisionId: revision.id,
      version: revision.version,
      message: "Revisão criada para aprovação.",
    };
  }
  if (action === "bom.approve") {
    const revisionId = uuid(body.revisionId);
    await tx.$queryRaw`SELECT id FROM production_bom_revisions WHERE id = ${revisionId}::uuid FOR UPDATE`;
    const revision = await tx.productionBomRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    if (revision.status !== "draft")
      throw new ProductionInputError(
        "Somente revisões em rascunho podem ser aprovadas.",
      );
    const snapshot = snapshotInput(revision.snapshot);
    await validateComposition(tx, snapshot);
    const effectiveAt = body.effectiveAt
      ? instant(body.effectiveAt)
      : new Date();
    await tx.productionBomRevision.update({
      where: { id: revisionId },
      data: {
        status: "approved",
        effectiveAt,
        approvedAt: new Date(),
        approvedBy: actor.id,
      },
    });
    return {
      bomId: revision.bomId,
      revisionId,
      message:
        "Revisão aprovada. Novas ordens usarão esta versão a partir da vigência.",
    };
  }
  if (action === "bom.toggle") {
    const bomId = integer(body.bomId, "Ficha", 1);
    await tx.$queryRaw`SELECT id FROM bills_of_material WHERE id = ${bomId} FOR UPDATE`;
    const bom = await tx.billOfMaterial.findUniqueOrThrow({
      where: { id: bomId },
    });
    if (
      bom.active &&
      (await tx.productionOrder.count({
        where: { bomId, status: { in: ["planned", "in_progress", "paused"] } },
      }))
    )
      throw new ProductionInputError(
        "Encerre as ordens abertas antes de arquivar a ficha.",
      );
    await tx.billOfMaterial.update({
      where: { id: bomId },
      data: { active: !bom.active },
    });
    return { bomId, active: !bom.active };
  }
  if (action === "center.save") {
    const id = body.centerId ? uuid(body.centerId) : randomUUID();
    const kind = String(body.kind || "machine");
    if (!["machine", "team", "line"].includes(kind))
      throw new ProductionInputError("Tipo de recurso inválido.");
    const timeZone = boundedText(
      body.timeZone || "America/Sao_Paulo",
      "Fuso",
      80,
      true,
    );
    try {
      new Intl.DateTimeFormat("pt-BR", { timeZone }).format(new Date());
    } catch {
      throw new ProductionInputError("Fuso inválido.");
    }
    const data = {
      name: boundedText(body.name, "Nome", 180, true),
      kind,
      timeZone,
      shifts: safeJson(shiftsInput(body.shifts)),
      wipLimit: integer(body.wipLimit ?? 1, "Limite simultâneo", 1, 1000),
      hourlyCostCents: cents(body.hourlyCostCents ?? 0),
      active: body.active !== false,
    };
    if (body.centerId) {
      await tx.$queryRaw`SELECT id FROM production_work_centers WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.productionWorkCenter.findUniqueOrThrow({
        where: { id },
      });
      if (existing.version !== integer(body.version, "Versão"))
        throw new ProductionInputError("O recurso foi alterado. Atualize.");
      const activeOrders = await tx.productionOrder.findMany({
        where: {
          workCenterId: id,
          status: { in: ["planned", "in_progress", "paused"] },
        },
      });
      if (!data.active && activeOrders.length)
        throw new ProductionInputError(
          "Realoque as ordens abertas antes de desativar o recurso.",
        );
      for (const order of activeOrders)
        if (order.scheduledStart && order.scheduledEnd)
          assertScheduleWithinShifts(
            order.scheduledStart,
            order.scheduledEnd,
            shiftsInput(body.shifts),
            timeZone,
          );
      if (
        activeOrders.filter((order) => order.status === "in_progress").length >
        data.wipLimit
      )
        throw new ProductionInputError(
          "Há mais ordens em execução que o novo limite.",
        );
      const scheduledPoints = activeOrders
        .flatMap((order) =>
          order.scheduledStart && order.scheduledEnd
            ? [
                { at: order.scheduledStart.getTime(), delta: 1 },
                { at: order.scheduledEnd.getTime(), delta: -1 },
              ]
            : [],
        )
        .sort((a, b) => a.at - b.at || a.delta - b.delta);
      let scheduledConcurrent = 0;
      for (const point of scheduledPoints) {
        scheduledConcurrent += point.delta;
        if (scheduledConcurrent > data.wipLimit)
          throw new ProductionInputError(
            "O novo limite conflita com as ordens já agendadas. Realoque os horários antes de reduzir a capacidade.",
          );
      }
      await tx.productionWorkCenter.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
    } else await tx.productionWorkCenter.create({ data: { id, ...data } });
    return { id, message: "Recurso e turnos salvos." };
  }
  if (action === "order.create") return createOrder(tx, body, actor);
  if (action === "order.bulk") {
    if (
      !Array.isArray(body.orders) ||
      !body.orders.length ||
      body.orders.length > 50
    )
      throw new ProductionInputError("Selecione de 1 a 50 ordens.");
    const operation = String(body.operation);
    if (
      !["order.transition", "order.update", "order.cancel"].includes(operation)
    )
      throw new ProductionInputError("Operação em lote inválida.");
    const entries = body.orders
      .map((entry) => object(entry))
      .sort(
        (a, b) =>
          integer(a.orderId, "Ordem", 1) - integer(b.orderId, "Ordem", 1),
      );
    if (new Set(entries.map((entry) => entry.orderId)).size !== entries.length)
      throw new ProductionInputError("Ordem repetida na seleção.");
    const results = [];
    for (const entry of entries)
      results.push(
        await dispatch(
          tx,
          operation,
          {
            ...object(body.changes),
            orderId: entry.orderId,
            version: entry.version,
          },
          actor,
        ),
      );
    return { results, message: `${results.length} ordens atualizadas.` };
  }

  const id = integer(body.orderId, "Ordem", 1);
  await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id} FOR UPDATE`;
  const order = await tx.productionOrder.findUniqueOrThrow({
    where: { id },
    include: {
      dependencies: { include: { predecessor: true } },
    },
  });
  if (order.version !== integer(body.version, "Versão"))
    throw new ProductionInputError(
      "A ordem foi alterada por outro usuário. Atualize antes de continuar.",
    );
  const snapshot = snapshotInput(order.snapshot);
  const reportGroups = await tx.productionReport.groupBy({
    by: ["status"],
    where: { orderId: id },
    _count: { _all: true },
    _sum: { producedMicros: true, scrapMicros: true, reworkMicros: true },
  });
  const processedBefore = reportGroups.reduce(
    (sum, group) =>
      sum +
      (group._sum.producedMicros ?? ZERO) +
      (group._sum.scrapMicros ?? ZERO) +
      (group._sum.reworkMicros ?? ZERO),
    ZERO,
  );
  const closed = ["completed", "cancelled"].includes(order.status);
  let result: Record<string, unknown> = {};

  if (action === "order.update") {
    const metadata = productionOrderMetadataInput({
      ...order,
      ...body,
      dueAt:
        body.dueAt === undefined
          ? order.dueAt?.toISOString().slice(0, 10)
          : body.dueAt,
      orderId: id,
    });
    const { orderId: _orderId, ...data } = metadata;
    void _orderId;
    await tx.productionOrder.update({
      where: { id },
      data: {
        ...data,
        position:
          body.position === undefined
            ? order.position
            : integer(body.position, "Posição", 0, 1_000_000),
      },
    });
    result = { message: "Planejamento atualizado." };
  } else if (action === "order.schedule") {
    if (closed || order.status === "in_progress")
      throw new ProductionInputError(
        "Reagende somente ordens planejadas ou pausadas.",
      );
    const workCenterId = uuid(body.workCenterId),
      start = instant(body.scheduledStart),
      end = instant(body.scheduledEnd);
    await tx.$queryRaw`SELECT id FROM production_work_centers WHERE id = ${workCenterId}::uuid FOR UPDATE`;
    const center = await tx.productionWorkCenter.findUniqueOrThrow({
      where: { id: workCenterId },
    });
    if (!center.active) throw new ProductionInputError("Recurso inativo.");
    assertScheduleWithinShifts(
      start,
      end,
      shiftsInput(center.shifts),
      center.timeZone,
    );
    const overlaps = await tx.productionOrder.findMany({
      where: {
        id: { not: id },
        workCenterId,
        status: { in: ["planned", "in_progress", "paused"] },
        scheduledStart: { lt: end },
        scheduledEnd: { gt: start },
      },
      select: { scheduledStart: true, scheduledEnd: true },
    });
    const points = [
      { at: start.getTime(), delta: 1 },
      { at: end.getTime(), delta: -1 },
      ...overlaps.flatMap((item) => [
        {
          at: Math.max(start.getTime(), item.scheduledStart!.getTime()),
          delta: 1,
        },
        {
          at: Math.min(end.getTime(), item.scheduledEnd!.getTime()),
          delta: -1,
        },
      ]),
    ].sort((a, b) => a.at - b.at || a.delta - b.delta);
    let concurrent = 0;
    for (const point of points) {
      concurrent += point.delta;
      if (concurrent > center.wipLimit)
        throw new ProductionInputError(
          "O agendamento excede a capacidade simultânea do recurso.",
        );
    }
    const dependencyIds =
      body.predecessorIds ??
      order.dependencies.map((item) => item.predecessorId);
    if (!Array.isArray(dependencyIds) || dependencyIds.length > 50)
      throw new ProductionInputError("Dependências inválidas.");
    const predecessors = [
      ...new Set(
        dependencyIds.map((value) => integer(value, "Dependência", 1)),
      ),
    ];
    for (const predecessorId of predecessors) {
      if (predecessorId === id)
        throw new ProductionInputError(
          "Uma ordem não pode depender dela mesma.",
        );
      const cycle = await tx.$queryRaw<
        Array<{ id: number }>
      >`WITH RECURSIVE chain(id) AS (SELECT ${predecessorId}::integer UNION SELECT d.predecessor_id FROM production_dependencies d JOIN chain c ON d.order_id = c.id) SELECT id FROM chain WHERE id = ${id}`;
      if (cycle.length)
        throw new ProductionInputError("As dependências formam um ciclo.");
      const prior = await tx.productionOrder.findUniqueOrThrow({
        where: { id: predecessorId },
      });
      if (
        prior.status === "cancelled" ||
        (!prior.completedAt && !prior.scheduledEnd) ||
        (prior.completedAt ?? prior.scheduledEnd)! > start
      )
        throw new ProductionInputError(
          "A ordem anterior precisa terminar antes deste agendamento.",
        );
    }
    const conflictingSuccessor = await tx.productionDependency.findFirst({
      where: {
        predecessorId: id,
        order: {
          status: { in: ["planned", "in_progress", "paused"] },
          scheduledStart: { lt: end },
        },
      },
      include: { order: { select: { number: true } } },
    });
    if (conflictingSuccessor)
      throw new ProductionInputError(
        `Este horário termina após o início da ordem dependente ${conflictingSuccessor.order.number}. Reagende a sucessora primeiro.`,
      );
    await tx.productionDependency.deleteMany({ where: { orderId: id } });
    await tx.productionDependency.createMany({
      data: predecessors.map((predecessorId) => ({
        orderId: id,
        predecessorId,
      })),
    });
    await tx.productionOrder.update({
      where: { id },
      data: { workCenterId, scheduledStart: start, scheduledEnd: end },
    });
    result = { message: "Agendamento e dependências salvos." };
  } else if (action === "order.transition" || action === "order.reserve") {
    const target =
      action === "order.reserve" ? order.status : String(body.status);
    const allowed: Record<string, string[]> = {
      planned: ["in_progress"],
      in_progress: ["paused"],
      paused: ["in_progress"],
    };
    if (
      closed ||
      (action === "order.transition" &&
        !allowed[order.status]?.includes(target))
    )
      throw new ProductionInputError("Transição de produção inválida.");
    await lockProductionStock(
      tx,
      order.warehouseId,
      snapshot.items.map((item) => item.productId),
    );
    if (target === "in_progress" || action === "order.reserve") {
      if (
        order.dependencies.some(
          (item) =>
            item.predecessor.status !== "completed" ||
            item.predecessor.qualityStatus !== "approved",
        )
      )
        throw new ProductionInputError(
          "Conclua e aprove a qualidade das ordens anteriores.",
        );
      if (target === "in_progress" && order.workCenterId) {
        await tx.$queryRaw`SELECT id FROM production_work_centers WHERE id = ${order.workCenterId}::uuid FOR UPDATE`;
        const center = await tx.productionWorkCenter.findUniqueOrThrow({
          where: { id: order.workCenterId },
        });
        const occupied = await tx.productionOrder.count({
          where: {
            workCenterId: center.id,
            status: "in_progress",
            id: { not: id },
          },
        });
        if (!center.active || occupied >= center.wipLimit)
          throw new ProductionInputError(
            "O recurso atingiu seu limite de ordens em execução.",
          );
      }
      const processed = processedBefore;
      const left = quantity(order.plannedQuantity) - processed;
      if (left > ZERO)
        await reserveProductionMaterials(
          tx,
          order,
          materialNeeds(snapshot, left),
          actor.name,
        );
    }
    await tx.productionOrder.update({
      where: { id },
      data: {
        status: target,
        ...(target === "in_progress"
          ? { startedAt: order.startedAt || new Date(), pausedAt: null }
          : target === "paused"
            ? { pausedAt: new Date() }
            : {}),
      },
    });
    result = {
      status: target,
      message:
        action === "order.reserve"
          ? "Materiais reservados."
          : "Etapa atualizada.",
    };
  } else if (
    action === "order.release" ||
    action === "order.cancel" ||
    action === "order.close"
  ) {
    if (closed) throw new ProductionInputError("Esta ordem já foi encerrada.");
    if (action === "order.release" && order.status === "in_progress")
      throw new ProductionInputError(
        "Pause a ordem antes de liberar os materiais.",
      );
    const reason = boundedText(body.reason, "Justificativa", 1000, true);
    if (
      action !== "order.release" &&
      reportGroups.some((report) => report.status === "quarantine")
    )
      throw new ProductionInputError(
        "Conclua as inspeções de qualidade antes de encerrar a ordem.",
      );
    if (action === "order.close" && !reportGroups.length)
      throw new ProductionInputError(
        "Registre pelo menos um apontamento antes de concluir.",
      );
    await lockProductionStock(
      tx,
      order.warehouseId,
      snapshot.items.map((item) => item.productId),
    );
    await releaseProductionMaterials(tx, order, actor.name);
    if (action !== "order.release")
      await tx.productionOrder.update({
        where: { id },
        data: {
          status: action === "order.close" ? "completed" : "cancelled",
          completedAt: action === "order.close" ? new Date() : null,
          pausedAt: null,
        },
      });
    result = {
      reason,
      message:
        action === "order.release"
          ? "Reservas remanescentes liberadas."
          : "Ordem encerrada e reservas liberadas.",
    };
  } else if (action === "order.reopen") {
    if (order.status !== "cancelled")
      throw new ProductionInputError(
        "Somente ordens canceladas podem ser reabertas.",
      );
    await tx.productionOrder.update({
      where: { id },
      data: { status: "planned", completedAt: null, pausedAt: null },
    });
    result = { message: "Ordem reaberta, mantendo seu histórico." };
  } else if (action === "order.report") {
    if (order.status !== "in_progress")
      throw new ProductionInputError("Inicie a ordem antes do apontamento.");
    const producedMicros = quantity(body.producedQuantity ?? 0, true),
      scrapMicros = quantity(body.scrapQuantity ?? 0, true),
      reworkMicros = quantity(body.reworkQuantity ?? 0, true);
    const processed = producedMicros + scrapMicros + reworkMicros;
    if (processed === ZERO)
      throw new ProductionInputError(
        "Informe quantidade produzida, refugada ou destinada a retrabalho.",
      );
    const prior = processedBefore;
    if (prior + processed > quantity(order.plannedQuantity) * BigInt(2))
      throw new ProductionInputError(
        "Os apontamentos acumulados excedem 200% do planejado.",
      );
    const notes = boundedText(
      body.notes,
      "Observações",
      2000,
      scrapMicros + reworkMicros > ZERO,
    );
    const reportId = randomUUID(),
      expected = materialNeeds(snapshot, processed);
    let demands = expected;
    if (body.materials !== undefined) {
      if (
        !Array.isArray(body.materials) ||
        body.materials.length !== expected.length
      )
        throw new ProductionInputError(
          "Confira o consumo real de todos os materiais.",
        );
      const seen = new Set<string>();
      demands = body.materials.map((raw) => {
        const line = object(raw),
          productId = integer(line.productId, "Material", 1),
          variationId = line.variationId
            ? integer(line.variationId, "Variação", 1)
            : null;
        const material = expected.find(
            (item) =>
              item.productId === productId && item.variationId === variationId,
          ),
          key = `${productId}:${variationId}`;
        if (!material || seen.has(key))
          throw new ProductionInputError(
            "Consumo de material desconhecido ou repetido.",
          );
        seen.add(key);
        return { ...material, requiredMicros: quantity(line.quantity, true) };
      });
      if (
        demands.some(
          (item) =>
            item.requiredMicros !==
            expected.find(
              (line) =>
                line.productId === item.productId &&
                line.variationId === item.variationId,
            )!.requiredMicros,
        ) &&
        !notes
      )
        throw new ProductionInputError(
          "Justifique a variação no consumo de materiais.",
        );
    }
    await lockProductionStock(tx, order.warehouseId, [
      snapshot.outputProductId,
      ...snapshot.items.map((item) => item.productId),
    ]);
    const consumed = await consumeProductionMaterials(
      tx,
      order,
      demands.filter((item) => item.requiredMicros > ZERO),
      reportId,
      actor.name,
    );
    const laborMinutes = integer(
        body.laborMinutes ?? 0,
        "Minutos de mão de obra",
        0,
        525600,
      ),
      machineMinutes = integer(
        body.machineMinutes ?? 0,
        "Minutos de máquina",
        0,
        525600,
      );
    const workCenter = order.workCenterId
      ? await tx.productionWorkCenter.findUniqueOrThrow({
          where: { id: order.workCenterId },
        })
      : null;
    const costingSnapshot = {
      ...snapshot,
      machineHourlyCents:
        workCenter?.hourlyCostCents ?? snapshot.machineHourlyCents,
    };
    const { totalCostCents, ...costs } = reportCosts(costingSnapshot, {
      materialCostCents: consumed.materialCostCents,
      laborMinutes,
      machineMinutes,
      processedMicros: processed,
    });
    const outputIdentity = await quarantineProductionOutput(
      tx,
      order,
      snapshot,
      reportId,
      producedMicros,
      object(body.output ?? {}),
      actor.name,
    );
    await tx.productionReport.create({
      data: {
        id: reportId,
        orderId: id,
        producedMicros,
        scrapMicros,
        reworkMicros,
        ...costs,
        laborMinutes,
        machineMinutes,
        notes,
        actor: actor.name,
        outputIdentity: safeJson(outputIdentity),
        consumptions: { create: consumed.lines },
      },
    });
    await tx.productionOrder.update({
      where: { id },
      data: {
        qualityStatus: "quarantine",
        actualCost:
          (Math.round((order.actualCost ?? 0) * 100) + totalCostCents) / 100,
      },
    });
    result = {
      reportId,
      producedQuantity: asQuantity(producedMicros),
      totalCostCents,
      costBasis: {
        workCenterId: workCenter?.id ?? null,
        workCenterVersion: workCenter?.version ?? null,
        machineHourlyCents: costingSnapshot.machineHourlyCents,
        laborHourlyCents: snapshot.laborHourlyCents,
        energyBatchCents: snapshot.energyBatchCents,
        overheadBatchCents: snapshot.overheadBatchCents,
      },
      message: "Apontamento registrado. Saída aguardando inspeção.",
    };
  } else if (action === "report.inspect") {
    const reportId = uuid(body.reportId);
    const report = await tx.productionReport.findFirst({
      where: { id: reportId, orderId: id },
    });
    if (!report || report.status !== "quarantine")
      throw new ProductionInputError(
        "Apontamento não encontrado ou já inspecionado.",
      );
    const decision = String(body.decision);
    if (!["approved", "rejected"].includes(decision))
      throw new ProductionInputError("Decisão de qualidade inválida.");
    const notes = boundedText(body.notes, "Parecer de qualidade", 2000, true);
    if (
      !Array.isArray(body.checklist) ||
      body.checklist.length !== snapshot.checklist.length
    )
      throw new ProductionInputError("Responda todo o checklist de qualidade.");
    const checks = body.checklist.map((raw) => {
      const entry = object(raw);
      if (typeof entry.passed !== "boolean")
        throw new ProductionInputError(
          "Informe o resultado de cada verificação.",
        );
      return {
        name: boundedText(entry.name, "Verificação", 180, true),
        passed: entry.passed,
      };
    });
    if (
      new Set(checks.map((check) => check.name)).size !== checks.length ||
      snapshot.checklist.some(
        (name) => !checks.some((check) => check.name === name),
      ) ||
      (decision === "approved" && checks.some((check) => !check.passed))
    )
      throw new ProductionInputError(
        "Aprovação exige todas as verificações conformes.",
      );
    await lockProductionStock(tx, order.warehouseId, [
      snapshot.outputProductId,
    ]);
    const totalCostCents =
      report.materialCostCents +
      report.laborCostCents +
      report.machineCostCents +
      report.energyCostCents +
      report.overheadCostCents;
    await decideProductionOutput(
      tx,
      order,
      snapshot,
      report,
      decision === "approved",
      totalCostCents,
      actor.name,
    );
    const certificate = `CQ-${reportId}`;
    await tx.productionInspection.create({
      data: {
        reportId,
        decision,
        notes,
        checklist: checks,
        actor: actor.name,
        certificate,
      },
    });
    await tx.productionReport.update({
      where: { id: reportId },
      data: { status: decision },
    });
    const decidedGroups = await tx.productionReport.groupBy({
      by: ["status"],
      where: { orderId: id },
      _sum: { producedMicros: true },
    });
    const statuses = decidedGroups.map((item) => item.status);
    const qualityStatus = statuses.includes("quarantine")
      ? "quarantine"
      : statuses.every((status) => status === "approved")
        ? "approved"
        : statuses.every((status) => status === "rejected")
          ? "rejected"
          : "mixed";
    const producedQuantity = asQuantity(
      decidedGroups.find((item) => item.status === "approved")?._sum
        .producedMicros ?? ZERO,
    );
    await tx.productionOrder.update({
      where: { id },
      data: { qualityStatus, producedQuantity },
    });
    result = {
      reportId,
      certificate,
      decision,
      message:
        decision === "approved"
          ? "Qualidade aprovada e estoque liberado."
          : "Produto reprovado e descartado da quarentena.",
    };
  } else if (action === "mrp.purchase" || action === "mrp.transfer") {
    if (closed) throw new ProductionInputError("A ordem está encerrada.");
    const productId = integer(body.productId, "Material", 1),
      variationId = body.variationId
        ? integer(body.variationId, "Variação", 1)
        : null;
    const material = (await productionRequirements(tx, id)).find(
      (item) =>
        item.productId === productId && item.variationId === variationId,
    );
    if (!material || material.netShortage <= 0)
      throw new ProductionInputError(
        "Não há necessidade líquida pendente para este material.",
      );
    const requiredMicros = quantity(body.quantity);
    if (requiredMicros > quantity(material.netShortage))
      throw new ProductionInputError(
        "A quantidade supera a necessidade líquida da ordem.",
      );
    if (action === "mrp.purchase") {
      const supplierId = integer(body.supplierId, "Fornecedor", 1);
      if (
        !(await tx.supplier.findFirst({
          where: { id: supplierId, status: "active" },
        }))
      )
        throw new ProductionInputError("Fornecedor inativo ou não encontrado.");
      const unitCost = cents(body.unitCostCents) / 100,
        amount = asQuantity(requiredMicros),
        total = Math.round(amount * unitCost * 100) / 100;
      const purchase = await tx.purchaseOrder.create({
        data: {
          number: `PC-OP-${randomUUID().slice(0, 12).toUpperCase()}`,
          supplierId,
          subtotal: total,
          total,
          createdBy: actor.name,
          expectedAt: order.dueAt,
          notes: `Necessidade de ${order.number} · depósito ${order.warehouseId}`,
          items: { create: { productId, variationId, quantity: amount, unitCost, total } },
        },
      });
      await tx.productionProcurement.create({
        data: {
          orderId: id,
          productId,
          quantityMicros: requiredMicros,
          kind: "purchase",
          variationId,
          purchaseOrderId: purchase.id,
        },
      });
      result = {
        purchaseOrderId: purchase.id,
        message: "Pedido de compra em rascunho criado para esta necessidade.",
      };
    } else {
      const fromWarehouseId = integer(
        body.fromWarehouseId,
        "Depósito de origem",
        1,
      );
      const transfer = await transferProductionMaterial(
        tx,
        order,
        { productId, variationId, requiredMicros },
        fromWarehouseId,
        actor.name,
      );
      await tx.productionProcurement.create({
        data: {
          orderId: id,
          productId,
          quantityMicros: requiredMicros,
          kind: "transfer",
          variationId,
          transferId: transfer.id,
        },
      });
      result = {
        transferId: transfer.id,
        productId,
        variationId,
        message: "Material transferido para o depósito da produção.",
      };
    }
  } else if (action === "order.rework") {
    const reportId = uuid(body.reportId),
      report = await tx.productionReport.findFirst({
        where: { id: reportId, orderId: id },
      });
    if (
      !report ||
      (report.status !== "rejected" && report.reworkMicros === ZERO)
    )
      throw new ProductionInputError(
        "Selecione um apontamento com reprovação ou retrabalho.",
      );
    const reworkQuantity = asQuantity(
      report.reworkMicros +
        (report.status === "rejected" ? report.producedMicros : ZERO),
    );
    if (reworkQuantity <= 0)
      throw new ProductionInputError(
        "Não há quantidade para reposição/retrabalho.",
      );
    const duplicate = await tx.productionEvent.findFirst({
      where: {
        orderId: id,
        action,
        data: { path: ["sourceReportId"], equals: reportId },
      },
    });
    if (duplicate)
      throw new ProductionInputError(
        "Este apontamento já gerou uma ordem de retrabalho.",
      );
    const created = await tx.productionOrder.create({
      data: {
        number: `OP-${randomUUID().slice(0, 12).toUpperCase()}`,
        bomId: order.bomId,
        revisionId: order.revisionId,
        snapshot: safeJson(snapshot),
        outputProductId: order.outputProductId,
        warehouseId: order.warehouseId,
        plannedQuantity: reworkQuantity,
        priority: "high",
        tags: ["retrabalho"],
        notes: `Reposição/retrabalho de ${order.number}. ${boundedText(body.reason, "Justificativa", 1000, true)}`,
        createdBy: actor.name,
      },
    });
    await event(tx, created.id, "order.created", actor, {
      sourceOrderId: id,
      sourceReportId: reportId,
    });
    result = {
      newOrderId: created.id,
      sourceReportId: reportId,
      message:
        "Ordem de reposição/retrabalho criada com consumo e custos próprios.",
    };
  } else throw new ProductionInputError("Ação de produção inválida.");

  const updated = await tx.productionOrder.update({
    where: { id },
    data: { version: { increment: 1 } },
  });
  await event(tx, id, action, actor, { ...result, version: updated.version });
  return { orderId: id, version: updated.version, ...result };
}

async function createOrder(
  tx: Tx,
  body: Record<string, unknown>,
  actor: ProductionActor,
) {
  const bomId = integer(body.bomId, "Ficha", 1),
    warehouseId = integer(body.warehouseId, "Depósito", 1);
  await tx.$queryRaw`SELECT id FROM bills_of_material WHERE id = ${bomId} FOR UPDATE`;
  const bom = await tx.billOfMaterial.findFirst({
    where: { id: bomId, active: true },
  });
  const revision = await tx.productionBomRevision.findFirst({
    where: { bomId, status: "approved", effectiveAt: { lte: new Date() } },
    orderBy: [{ effectiveAt: "desc" }, { version: "desc" }],
  });
  if (!bom || !revision)
    throw new ProductionInputError(
      "Selecione uma ficha ativa com revisão aprovada e vigente.",
    );
  const snapshot = snapshotInput(revision.snapshot);
  await productionScope(
    tx,
    warehouseId,
    snapshot.outputProductId,
    snapshot.outputVariationId,
  );
  const metadata = productionOrderMetadataInput({ ...body, orderId: 1 });
  const { orderId: _ignored, ...planning } = metadata;
  void _ignored;
  const order = await tx.productionOrder.create({
    data: {
      ...planning,
      number: `OP-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 12).toUpperCase()}`,
      bomId,
      warehouseId,
      plannedQuantity: asQuantity(quantity(body.plannedQuantity)),
      outputProductId: snapshot.outputProductId,
      revisionId: revision.id,
      snapshot: safeJson(snapshot),
      createdBy: actor.name,
    },
  });
  await event(tx, order.id, "order.created", actor, {
    revisionId: revision.id,
    version: revision.version,
  });
  return {
    orderId: order.id,
    number: order.number,
    version: 0,
    message: "Ordem criada com versão preservada da ficha.",
  };
}
async function validateComposition(tx: Tx, snapshot: ProductionSnapshot) {
  for (const item of [
    {
      productId: snapshot.outputProductId,
      variationId: snapshot.outputVariationId,
    },
    ...snapshot.items,
  ]) {
    const product = await tx.product.findFirst({
      where: { id: item.productId, active: true },
      include: { variations: { where: { enabled: true } } },
    });
    if (!product || !product.manageStock || product.type === "service")
      throw new ProductionInputError(
        "A ficha exige produtos ativos com controle de estoque.",
      );
    if (
      item.variationId !== null &&
      !product.variations.some(
        (variation) =>
          variation.id === item.variationId && variation.manageStock === "true",
      )
    )
      throw new ProductionInputError("Variação incompatível com o material.");
    if (item.variationId === null && product.catalogType === "variable")
      throw new ProductionInputError(
        `Selecione a variação de ${product.name}.`,
      );
  }
}
function aggregateLegacyItems(snapshot: ProductionSnapshot) {
  const materials = new Map<
    number,
    { productId: number; quantity: number; wastePercent: number }
  >();
  for (const item of snapshot.items) {
    const prior = materials.get(item.productId);
    const effective = item.quantity * (1 + item.wastePercent / 100);
    materials.set(item.productId, {
      productId: item.productId,
      quantity: (prior?.quantity ?? 0) + effective,
      wastePercent: 0,
    });
  }
  return [...materials.values()];
}
async function event(
  tx: Tx,
  orderId: number,
  action: string,
  actor: ProductionActor,
  data: Record<string, unknown>,
) {
  await tx.productionEvent.create({
    data: { orderId, action, actor: actor.name, data: safeJson(data) },
  });
}
