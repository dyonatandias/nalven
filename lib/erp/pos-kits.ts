import { Prisma } from "@/generated/tenant/client";
import { POS_QUANTITY_SCALE, quantityToMicros } from "@/lib/erp/pos-inventory-tracking";

const MAX_KIT_DEPTH = 8;
const MAX_ACTIVE_BOMS = 500;
const MAX_EXPANDED_COMPONENTS = 200;
const MAX_SAFE_MICROS = BigInt("9007199254740991");

export class PosKitError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosKitError";
  }
}

export type PosKitBomNode = {
  id: string;
  version: number;
  name: string;
  productId: number;
  variationId: number | null;
  scopeKey: string;
  components: Array<{ productId: number; variationId: number | null; quantityMicros: bigint; position: number }>;
};

export type PosExpandedKitComponent = {
  productId: number;
  variationId: number | null;
  scopeKey: string;
  unitQuantityMicros: bigint;
  paths: string[][];
};

export type PosExpandedKit = {
  root: PosKitBomNode;
  boms: Array<{ id: string; version: number; scopeKey: string }>;
  components: PosExpandedKitComponent[];
};

export type PosResolvedKitComponent = PosExpandedKitComponent & {
  quantityMicros: bigint;
  quantity: number;
  product: { id: number; name: string; type: string; manageStock: boolean };
  variation: { id: number; productId: number; manageStock: string; enabled: boolean } | null;
};

export type PosResolvedKitPlan = {
  lineKey: string;
  saleQuantity: number;
  root: PosKitBomNode;
  boms: Array<{ id: string; version: number; scopeKey: string }>;
  components: PosResolvedKitComponent[];
  snapshot: Prisma.InputJsonObject;
};

export function posKitScopeKey(productId: number, variationId: number | null) {
  return variationId == null ? `product:${productId}` : `variation:${variationId}`;
}

export function expandPosKitBoms(root: PosKitBomNode, boms: readonly PosKitBomNode[]): PosExpandedKit {
  const byScope = new Map(boms.map(bom => [bom.scopeKey, bom]));
  const leaves = new Map<string, PosExpandedKitComponent>();
  const used = new Map<string, { id: string; version: number; scopeKey: string }>();

  function visit(bom: PosKitBomNode, multiplier: bigint, ancestors: string[], depth: number) {
    if (depth > MAX_KIT_DEPTH) throw new PosKitError(`O kit ${root.name} excede ${MAX_KIT_DEPTH} níveis de composição.`);
    if (ancestors.includes(bom.scopeKey)) throw new PosKitError(`A composição do kit ${root.name} contém um ciclo.`);
    if (!bom.components.length) throw new PosKitError(`A versão ${bom.version} do kit ${bom.name} não possui componentes.`);
    used.set(bom.id, { id: bom.id, version: bom.version, scopeKey: bom.scopeKey });
    const path = [...ancestors, bom.scopeKey];
    for (const component of [...bom.components].sort((a, b) => a.position - b.position || a.productId - b.productId || (a.variationId ?? 0) - (b.variationId ?? 0))) {
      const quantity = multiplyMicros(multiplier, component.quantityMicros);
      const exactNested = byScope.get(posKitScopeKey(component.productId, component.variationId));
      const productNested = component.variationId == null ? null : byScope.get(posKitScopeKey(component.productId, null));
      const nested = exactNested || productNested;
      if (nested) {
        visit(nested, quantity, path, depth + 1);
        continue;
      }
      const scopeKey = posKitScopeKey(component.productId, component.variationId), existing = leaves.get(scopeKey);
      if (existing) {
        existing.unitQuantityMicros = safeAdd(existing.unitQuantityMicros, quantity);
        existing.paths.push([...path, scopeKey]);
      } else {
        if (leaves.size >= MAX_EXPANDED_COMPONENTS) throw new PosKitError(`O kit ${root.name} excede ${MAX_EXPANDED_COMPONENTS} componentes expandidos.`);
        leaves.set(scopeKey, { productId: component.productId, variationId: component.variationId, scopeKey, unitQuantityMicros: quantity, paths: [[...path, scopeKey]] });
      }
    }
  }

  visit(root, POS_QUANTITY_SCALE, [], 1);
  return { root, boms: [...used.values()].sort((a, b) => a.scopeKey.localeCompare(b.scopeKey)), components: [...leaves.values()].sort((a, b) => a.scopeKey.localeCompare(b.scopeKey)) };
}

export async function resolvePosKitPlans(
  tx: Prisma.TransactionClient,
  input: { branchId: number; evaluatedAt: Date; lockForCommit: boolean; lines: Array<{ productId: number; variationId?: number | null; quantity: number; productType: string }> },
) {
  if (input.lockForCommit) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_kit_boms" WHERE "branch_id" = ${input.branchId} ORDER BY "id" FOR UPDATE`);
  }
  const rows = await tx.posKitBom.findMany({
    where: { branchId: input.branchId, status: "active", OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: input.evaluatedAt } }] },
    include: {
      components: {
        include: {
          product: { select: { id: true, name: true, type: true, manageStock: true, active: true, branchConfigurations: { where: { branchId: input.branchId }, select: { active: true, saleEnabled: true } } } },
          variation: { select: { id: true, productId: true, manageStock: true, enabled: true } },
        },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ scopeKey: "asc" }, { version: "desc" }],
    take: MAX_ACTIVE_BOMS + 1,
  });
  if (rows.length > MAX_ACTIVE_BOMS) throw new PosKitError(`A filial excede o limite operacional de ${MAX_ACTIVE_BOMS} composições ativas.`);
  const nodes: PosKitBomNode[] = rows.map(row => ({
    id: row.id, version: row.version, name: row.name, productId: row.kitProductId, variationId: row.kitVariationId, scopeKey: row.scopeKey,
    components: row.components.map(component => ({ productId: component.productId, variationId: component.variationId, quantityMicros: component.quantityMicros, position: component.position })),
  }));
  const nodeByScope = new Map(nodes.map(node => [node.scopeKey, node]));
  const detailByScope = new Map(rows.flatMap(row => row.components.map(component => [component.componentScopeKey, component] as const)));
  const plans = new Map<string, PosResolvedKitPlan>();

  for (const line of input.lines) {
    const lineKey = `${line.productId}:${line.variationId ?? 0}`;
    const root = nodeByScope.get(posKitScopeKey(line.productId, line.variationId ?? null)) || nodeByScope.get(posKitScopeKey(line.productId, null));
    if (!root) {
      if (line.productType === "kit") throw new PosKitError("Kit sem composição ativa e vigente nesta filial.");
      continue;
    }
    if (line.productType !== "kit") throw new PosKitError("Uma composição ativa está vinculada a um produto que não é do tipo kit.");
    if (!Number.isSafeInteger(line.quantity)) throw new PosKitError(`O kit ${root.name} somente pode ser vendido em unidades inteiras.`);
    const expanded = expandPosKitBoms(root, nodes), saleUnits = BigInt(line.quantity);
    const components = expanded.components.map(component => {
      const detail = detailByScope.get(component.scopeKey);
      if (!detail || !detail.product.active || !detail.product.branchConfigurations[0]?.active || !detail.product.branchConfigurations[0]?.saleEnabled) throw new PosKitError(`Um componente de ${root.name} não está ativo e disponível nesta filial.`);
      if (detail.product.type === "kit") throw new PosKitError(`O subkit ${detail.product.name} não possui composição ativa e vigente; a venda foi bloqueada para não omitir seus componentes.`);
      if (component.variationId != null && (!detail.variation?.enabled || detail.variation.productId !== component.productId)) throw new PosKitError(`Uma variação componente de ${root.name} não está disponível.`);
      const quantityMicros = safeMultiplyInteger(component.unitQuantityMicros, saleUnits);
      return { ...component, quantityMicros, quantity: microsToQuantity(quantityMicros), product: detail.product, variation: detail.variation };
    });
    const snapshot = JSON.parse(JSON.stringify({
      root: { id: root.id, version: root.version, name: root.name, scopeKey: root.scopeKey },
      boms: expanded.boms,
      components: components.map(component => ({ productId: component.productId, variationId: component.variationId, scopeKey: component.scopeKey, unitQuantityMicros: component.unitQuantityMicros.toString(), quantityMicros: component.quantityMicros.toString(), paths: component.paths })),
    })) as Prisma.InputJsonObject;
    plans.set(lineKey, { lineKey, saleQuantity: line.quantity, root, boms: expanded.boms, components, snapshot });
  }
  return plans;
}

export function posKitReturnMicros(unitQuantityMicros: bigint, returnedKitQuantity: number) {
  if (!Number.isSafeInteger(returnedKitQuantity) || returnedKitQuantity <= 0) throw new PosKitError("A devolução de kit deve usar unidades inteiras.");
  return safeMultiplyInteger(unitQuantityMicros, BigInt(returnedKitQuantity));
}

export function posKitSnapshotForHash(plans: ReadonlyMap<string, PosResolvedKitPlan>) {
  return [...plans.values()].sort((a, b) => a.lineKey.localeCompare(b.lineKey)).map(plan => plan.snapshot);
}

function multiplyMicros(left: bigint, right: bigint) {
  const multiplied = left * right;
  if (multiplied % POS_QUANTITY_SCALE !== BigInt(0)) throw new PosKitError("A composição aninhada excede seis casas decimais.");
  const result = multiplied / POS_QUANTITY_SCALE;
  if (result <= BigInt(0) || result > MAX_SAFE_MICROS) throw new PosKitError("Quantidade expandida do kit excede o limite permitido.");
  return result;
}

function safeMultiplyInteger(value: bigint, multiplier: bigint) {
  const result = value * multiplier;
  if (result <= BigInt(0) || result > MAX_SAFE_MICROS) throw new PosKitError("Quantidade expandida do kit excede o limite permitido.");
  return result;
}

function safeAdd(left: bigint, right: bigint) {
  const result = left + right;
  if (result > MAX_SAFE_MICROS) throw new PosKitError("Quantidade agregada do kit excede o limite permitido.");
  return result;
}

function microsToQuantity(value: bigint) {
  const result = Number(value) / Number(POS_QUANTITY_SCALE);
  quantityToMicros(result);
  return result;
}
