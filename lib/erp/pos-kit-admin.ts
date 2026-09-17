import { createHash } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { expandPosKitBoms, posKitScopeKey, PosKitError, type PosKitBomNode } from "@/lib/erp/pos-kits";
import { POS_QUANTITY_SCALE, quantityToMicros } from "@/lib/erp/pos-inventory-tracking";

export const POS_KIT_ADMIN_ACTIONS = ["kit.create", "kit.update", "kit.activate", "kit.retire"] as const;
type Action = typeof POS_KIT_ADMIN_ACTIONS[number];
type ComponentInput = { productId: number; variationId: number | null; quantityMicros: bigint; position: number };
type Common = { action: Action; idempotencyKey: string; branchId: number };
type DraftFields = { kitProductId: number; kitVariationId: number | null; name: string; effectiveFrom: Date | null; components: ComponentInput[] };
export type PosKitAdminInput =
  | Common & DraftFields & { action: "kit.create" }
  | Common & DraftFields & { action: "kit.update"; bomId: string }
  | Common & { action: "kit.activate" | "kit.retire"; bomId: string };

export class PosKitAdminError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosKitAdminError";
  }
}

export function parsePosKitAdminInput(body: Record<string, unknown>): PosKitAdminInput {
  const action = choice(body.action, POS_KIT_ADMIN_ACTIONS, "Ação"), idempotencyKey = key(body.idempotencyKey), branchId = id(body.branchId, "Filial");
  if (action === "kit.activate" || action === "kit.retire") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "bomId"]);
    return { action, idempotencyKey, branchId, bomId: stringId(body.bomId, "Composição") };
  }
  onlyKeys(body, ["action", "idempotencyKey", "branchId", ...(action === "kit.update" ? ["bomId"] : []), "kitProductId", "kitVariationId", "name", "effectiveFrom", "components"]);
  const componentsValue = array(body.components, "Componentes");
  if (!componentsValue.length || componentsValue.length > 100) throw new PosKitAdminError("Informe entre 1 e 100 componentes.");
  const seen = new Set<string>();
  const components = componentsValue.map((value, position) => {
    const item = object(value, "Componente");
    onlyKeys(item, ["productId", "variationId", "quantity"]);
    const productId = id(item.productId, "Produto componente"), variationId = nullableId(item.variationId, "Variação componente");
    const scope = posKitScopeKey(productId, variationId);
    if (seen.has(scope)) throw new PosKitAdminError("Cada produto ou variação componente deve aparecer uma única vez.");
    seen.add(scope);
    let quantityMicros: bigint;
    try { quantityMicros = quantityToMicros(Number(item.quantity)); } catch { throw new PosKitAdminError("Quantidade de componente inválida; use até seis casas decimais."); }
    return { productId, variationId, quantityMicros, position };
  });
  return {
    action, idempotencyKey, branchId,
    ...(action === "kit.update" ? { bomId: stringId(body.bomId, "Composição") } : {}),
    kitProductId: id(body.kitProductId, "Produto kit"),
    kitVariationId: nullableId(body.kitVariationId, "Variação do kit"),
    name: text(body.name, "Nome", 2, 160),
    effectiveFrom: nullableDate(body.effectiveFrom, "Início da vigência"),
    components,
  } as PosKitAdminInput;
}

export function hashPosKitAdminInput(input: PosKitAdminInput) {
  const payload = {
    ...input,
    idempotencyKey: undefined,
    ...(input.action === "kit.create" || input.action === "kit.update" ? {
      effectiveFrom: input.effectiveFrom?.toISOString() ?? null,
      components: input.components.map(component => ({ ...component, quantityMicros: component.quantityMicros.toString() })),
    } : {}),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export async function applyPosKitAdminMutation(tx: Prisma.TransactionClient, input: PosKitAdminInput, actorId: string) {
  await activeBranch(tx, input.branchId);
  if (input.action === "kit.create" || input.action === "kit.update") {
    await validateDraftTargets(tx, input);
    const scopeKey = posKitScopeKey(input.kitProductId, input.kitVariationId);
    await lockScope(tx, input.branchId, scopeKey);
    if (input.action === "kit.create") {
      const latest = await tx.posKitBom.aggregate({ where: { branchId: input.branchId, scopeKey }, _max: { version: true } });
      const created = await tx.posKitBom.create({ data: {
        branchId: input.branchId, kitProductId: input.kitProductId, kitVariationId: input.kitVariationId, scopeKey,
        version: (latest._max.version ?? 0) + 1, name: input.name, effectiveFrom: input.effectiveFrom, createdBy: actorId,
        components: { create: componentData(input.components) },
      }, include: { components: { orderBy: { position: "asc" } } } });
      return { status: 201, entityType: "pos_kit_bom", entityId: created.id, before: null, body: { bom: posKitBomDto(created) } };
    }
    const before = await lockedBom(tx, input.bomId);
    assertBranch(before, input.branchId);
    if (before.status !== "draft") throw new PosKitAdminError("Somente uma versão em rascunho pode ser editada.", 409);
    if (before.scopeKey !== scopeKey) throw new PosKitAdminError("O produto ou a variação do kit não podem ser trocados; crie outra versão.", 409);
    await tx.posKitBomComponent.deleteMany({ where: { bomId: before.id } });
    const saved = await tx.posKitBom.update({ where: { id: before.id }, data: {
      name: input.name, effectiveFrom: input.effectiveFrom, components: { create: componentData(input.components) },
    }, include: { components: { orderBy: { position: "asc" } } } });
    return { status: 200, entityType: "pos_kit_bom", entityId: saved.id, before: posKitBomDto(before), body: { bom: posKitBomDto(saved) } };
  }

  const before = await lockedBom(tx, input.bomId);
  assertBranch(before, input.branchId);
  await lockScope(tx, input.branchId, before.scopeKey);
  if (input.action === "kit.retire") {
    if (before.status !== "active") throw new PosKitAdminError("Somente uma composição ativa pode ser desativada.", 409);
    await validateRetirementGraph(tx, before);
    const saved = await tx.posKitBom.update({ where: { id: before.id }, data: { status: "retired", retiredBy: actorId, retiredAt: new Date() }, include: { components: { orderBy: { position: "asc" } } } });
    return { status: 200, entityType: "pos_kit_bom", entityId: saved.id, before: posKitBomDto(before), body: { bom: posKitBomDto(saved) } };
  }
  if (before.status !== "draft") throw new PosKitAdminError("Somente uma composição em rascunho pode ser ativada.", 409);
  const now = new Date();
  if (before.effectiveFrom && before.effectiveFrom.valueOf() > now.valueOf()) throw new PosKitAdminError("A versão futura só pode ser ativada quando sua vigência começar; a versão ativa atual foi preservada.", 409);
  await validateActivationGraph(tx, before);
  await tx.posKitBom.updateMany({ where: { branchId: input.branchId, scopeKey: before.scopeKey, status: "active" }, data: { status: "retired", retiredBy: actorId, retiredAt: now } });
  const saved = await tx.posKitBom.update({ where: { id: before.id }, data: { status: "active", activatedBy: actorId, activatedAt: now }, include: { components: { orderBy: { position: "asc" } } } });
  return { status: 200, entityType: "pos_kit_bom", entityId: saved.id, before: posKitBomDto(before), body: { bom: posKitBomDto(saved) } };
}

export function posKitBomDto(value: { id: string; branchId: number; kitProductId: number; kitVariationId: number | null; scopeKey: string; version: number; name: string; status: string; effectiveFrom: Date | null; activatedAt: Date | null; retiredAt: Date | null; createdAt: Date; updatedAt: Date; components: Array<{ id: string; productId: number; variationId: number | null; quantityMicros: bigint; position: number }> }) {
  return {
    id: value.id, branchId: value.branchId, kitProductId: value.kitProductId, kitVariationId: value.kitVariationId, scopeKey: value.scopeKey,
    version: value.version, name: value.name, status: value.status, effectiveFrom: value.effectiveFrom, activatedAt: value.activatedAt, retiredAt: value.retiredAt,
    components: value.components.map(component => ({ id: component.id, productId: component.productId, variationId: component.variationId, quantity: Number(component.quantityMicros) / Number(POS_QUANTITY_SCALE), position: component.position })),
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function componentData(components: ComponentInput[]) {
  return components.map(component => ({ productId: component.productId, variationId: component.variationId, componentScopeKey: posKitScopeKey(component.productId, component.variationId), quantityMicros: component.quantityMicros, position: component.position }));
}

async function activeBranch(tx: Prisma.TransactionClient, branchId: number) {
  if (!await tx.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } })) throw new PosKitAdminError("Filial ativa não encontrada.", 404);
}

async function validateDraftTargets(tx: Prisma.TransactionClient, input: Extract<PosKitAdminInput, { action: "kit.create" | "kit.update" }>) {
  const ids = [...new Set([input.kitProductId, ...input.components.map(component => component.productId)])];
  const products = await tx.product.findMany({ where: { id: { in: ids }, active: true, branchConfigurations: { some: { branchId: input.branchId, active: true, saleEnabled: true } } }, select: { id: true, type: true } });
  if (products.length !== ids.length) throw new PosKitAdminError("Todos os produtos devem estar ativos e vendáveis na filial.");
  if (products.find(product => product.id === input.kitProductId)?.type !== "kit") throw new PosKitAdminError("O produto de saída deve ser do tipo kit.");
  if (input.components.some(component => component.productId === input.kitProductId && component.variationId === input.kitVariationId)) throw new PosKitAdminError("Um kit não pode ser componente direto de si mesmo.");
  const variations = [...new Set([input.kitVariationId, ...input.components.map(component => component.variationId)].filter((value): value is number => value != null))];
  if (variations.length) {
    const found = await tx.productVariation.findMany({ where: { id: { in: variations }, enabled: true }, select: { id: true, productId: true } });
    if (found.length !== variations.length) throw new PosKitAdminError("Uma variação informada está inativa ou não existe.");
    const parentByVariation = new Map(found.map(variation => [variation.id, variation.productId]));
    if (input.kitVariationId && parentByVariation.get(input.kitVariationId) !== input.kitProductId) throw new PosKitAdminError("A variação do kit não pertence ao produto de saída.");
    for (const component of input.components) if (component.variationId && parentByVariation.get(component.variationId) !== component.productId) throw new PosKitAdminError("Uma variação componente não pertence ao produto informado.");
  }
}

async function validateActivationGraph(tx: Prisma.TransactionClient, draft: Awaited<ReturnType<typeof lockedBom>>) {
  const active = await tx.posKitBom.findMany({ where: { branchId: draft.branchId, status: "active", scopeKey: { not: draft.scopeKey } }, include: { components: true }, take: 501 });
  if (active.length > 500) throw new PosKitAdminError("A filial excede o limite de 500 composições ativas.");
  const rows = [...active, draft];
  const nodes: PosKitBomNode[] = rows.map(row => ({ id: row.id, version: row.version, name: row.name, productId: row.kitProductId, variationId: row.kitVariationId, scopeKey: row.scopeKey, components: row.components.map(component => ({ productId: component.productId, variationId: component.variationId, quantityMicros: component.quantityMicros, position: component.position })) }));
  try {
    const expanded = expandPosKitBoms(nodes[nodes.length - 1], nodes);
    await assertNoKitLeaves(tx, expanded.components.map(component => component.productId));
  } catch (error) { if (error instanceof PosKitError) throw new PosKitAdminError(error.message); throw error; }
}

async function validateRetirementGraph(tx: Prisma.TransactionClient, retiring: Awaited<ReturnType<typeof lockedBom>>) {
  const active = await tx.posKitBom.findMany({ where: { branchId: retiring.branchId, status: "active", id: { not: retiring.id } }, include: { components: true }, take: 501 });
  if (active.length > 500) throw new PosKitAdminError("A filial excede o limite de 500 composições ativas.");
  const nodes: PosKitBomNode[] = active.map(row => ({ id: row.id, version: row.version, name: row.name, productId: row.kitProductId, variationId: row.kitVariationId, scopeKey: row.scopeKey, components: row.components.map(component => ({ productId: component.productId, variationId: component.variationId, quantityMicros: component.quantityMicros, position: component.position })) }));
  try {
    for (const node of nodes) {
      const expanded = expandPosKitBoms(node, nodes);
      await assertNoKitLeaves(tx, expanded.components.map(component => component.productId), "A composição não pode ser desativada porque deixaria outro kit ativo sem os componentes do subkit.");
    }
  } catch (error) { if (error instanceof PosKitError) throw new PosKitAdminError(error.message); throw error; }
}

async function assertNoKitLeaves(tx: Prisma.TransactionClient, productIds: number[], message = "Um subkit da composição não possui BOM ativa.") {
  if (!productIds.length) return;
  if (await tx.product.findFirst({ where: { id: { in: [...new Set(productIds)] }, type: "kit" }, select: { id: true } })) throw new PosKitError(message);
}

async function lockedBom(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_kit_boms" WHERE "id" = ${id} FOR UPDATE`);
  const row = await tx.posKitBom.findUnique({ where: { id }, include: { components: { orderBy: { position: "asc" } } } });
  if (!row) throw new PosKitAdminError("Composição não encontrada.", 404);
  return row;
}

async function lockScope(tx: Prisma.TransactionClient, branchId: number, scopeKey: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_kit_boms" WHERE "branch_id" = ${branchId} AND "scope_key" = ${scopeKey} ORDER BY "id" FOR UPDATE`);
}

function assertBranch(value: { branchId: number }, branchId: number) { if (value.branchId !== branchId) throw new PosKitAdminError("Composição não pertence à filial.", 404); }
function object(value: unknown, label: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosKitAdminError(`${label} inválido.`); return value as Record<string, unknown>; }
function array(value: unknown, label: string) { if (!Array.isArray(value)) throw new PosKitAdminError(`${label} inválidos.`); return value; }
function id(value: unknown, label: string) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PosKitAdminError(`${label} inválido.`); return parsed; }
function nullableId(value: unknown, label: string) { return value == null || value === "" ? null : id(value, label); }
function stringId(value: unknown, label: string) { return text(value, label, 8, 160); }
function text(value: unknown, label: string, min: number, max: number) { if (typeof value !== "string") throw new PosKitAdminError(`${label} inválido.`); const parsed = value.trim(); if (parsed.length < min || parsed.length > max || /[\u0000-\u001F\u007F]/.test(parsed)) throw new PosKitAdminError(`${label} inválido.`); return parsed; }
function key(value: unknown) { const parsed = text(value, "Chave idempotente", 16, 160); if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) throw new PosKitAdminError("Chave idempotente inválida."); return parsed; }
function nullableDate(value: unknown, label: string) { if (value == null || value === "") return null; if (typeof value !== "string" || value.length > 40) throw new PosKitAdminError(`${label} inválido.`); const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new PosKitAdminError(`${label} inválido.`); return date; }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { if (typeof value !== "string" || !choices.includes(value)) throw new PosKitAdminError(`${label} inválida.`); return value as T[number]; }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) { const extras = Object.keys(value).filter(item => !allowed.includes(item)); if (extras.length) throw new PosKitAdminError(`Campos não suportados: ${extras.join(", ")}.`); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`; return JSON.stringify(value); }
