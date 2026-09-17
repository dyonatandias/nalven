import { createHash } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { canonicalizePosManualT2, type T2CanonicalValue } from "@/lib/erp/pos-manual-t2-canonical";

export type PosHeldSaleItemsCapabilityAction = "insert" | "replace_batch";

export type PosHeldSaleItemsCapabilityItem = {
  productId: number;
  variationId: number | null;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  scanData?: unknown;
  notes?: string | null;
};

export type PosHeldSaleItemsCapabilityInput = {
  action: PosHeldSaleItemsCapabilityAction;
  heldSaleId: string;
  expectedRevision: number;
  actorUserId: string;
  idempotencyKey: string;
  operationalContext: {
    branchId: number;
    registerId: number;
    sessionId: number;
    operatorProfileId: number;
    terminalId: string;
    orderClaimId: string | null;
  };
  items: readonly PosHeldSaleItemsCapabilityItem[];
};

/**
 * Opens the owner-only T2 capability immediately before a nested
 * `pos_held_sale_items` DML.  The request hash is intentionally not the HTTP
 * or parent request hash: PostgreSQL reconstructs the closed material
 * projections and binds them to the current database/session role. The
 * PostgreSQL derives the float8 representation used by the application-side
 * canonical digest. The owner-only preparation then independently rebuilds
 * the same documents with pos_manual_canonical_json_v1 before opening the
 * one-shot capability. Runtime needs EXECUTE only on:
 *
 * - pos_manual_t2_write_observation_multiset_digest_v1(text[])
 * - pos_manual_t2_float8_hex_v1(double precision)
 * - pos_manual_t2_held_sale_items_request_hash_v1(text,text,integer,text,text,integer,integer,integer,integer,text,text,text)
 * - pos_manual_prepare_held_sale_items_write_v1(text,text,integer,text,text,text,jsonb,jsonb)
 */
export async function preparePosHeldSaleItemsCapability(
  tx: Prisma.TransactionClient,
  input: PosHeldSaleItemsCapabilityInput,
) {
  if (!input.items.length || input.items.length > 200 || input.expectedRevision < 0 || !Number.isSafeInteger(input.expectedRevision)) {
    throw new Error("Capacidade de itens do carrinho inválida.");
  }
  const targetItems = input.items.map((item, transportOrdinal) => {
    if (!Number.isSafeInteger(item.productId) || item.productId <= 0
      || item.variationId !== null && (!Number.isSafeInteger(item.variationId) || item.variationId <= 0)
      || !Number.isFinite(item.quantity) || item.quantity <= 0
      || !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0
      || !Number.isSafeInteger(item.discountCents) || item.discountCents < 0) {
      throw new Error("Item do carrinho inválido para capability T2.");
    }
    return {
      transportOrdinal,
      productId: item.productId,
      variationId: item.variationId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      discountCents: item.discountCents,
      scanData: item.scanData ?? null,
      notes: item.notes ?? null,
    };
  });
  const targetItemsJson = JSON.stringify(targetItems);
  const operationalContextJson = JSON.stringify(input.operationalContext);
  const quantityRows = await tx.$queryRaw<Array<{ transportOrdinal: number; quantityFloat8Hex: string }>>(Prisma.sql`
    SELECT (item->>'transportOrdinal')::integer AS "transportOrdinal",
      public."pos_manual_t2_float8_hex_v1"((item->>'quantity')::double precision) AS "quantityFloat8Hex"
    FROM pg_catalog.jsonb_array_elements(${targetItemsJson}::jsonb) AS item
    ORDER BY (item->>'transportOrdinal')::integer
  `);
  if (quantityRows.length !== targetItems.length) throw new Error("Não foi possível canonicalizar as quantidades dos itens no banco.");
  const requestDigests = targetItems.map((item) => {
    const quantityFloat8Hex = quantityRows[item.transportOrdinal]?.quantityFloat8Hex;
    if (!quantityFloat8Hex) throw new Error("A quantidade canônica de um item não foi retornada pelo banco.");
    const document = {
      heldSaleId: input.heldSaleId,
      productId: item.productId,
      variationId: item.variationId,
      quantityFloat8Hex,
      unitPriceCents: item.unitPriceCents,
      discountCents: item.discountCents,
      scanData: jsonCanonicalValue(item.scanData),
      notes: item.notes,
    } satisfies T2CanonicalValue;
    return createHash("sha256").update(canonicalizePosManualT2(document), "utf8").digest("hex");
  });
  const hashRows = await tx.$queryRaw<Array<{ requestHash: string; databaseName: string; sessionRole: string }>>(Prisma.sql`
    SELECT current_database() AS "databaseName", session_user AS "sessionRole",
      public."pos_manual_t2_held_sale_items_request_hash_v1"(
        ${input.action}::text, ${input.heldSaleId}::text, ${input.expectedRevision}::integer,
        ${input.actorUserId}::text, ${input.idempotencyKey}::text,
        ${input.operationalContext.branchId}::integer, ${input.operationalContext.registerId}::integer,
        ${input.operationalContext.sessionId}::integer, ${input.operationalContext.operatorProfileId}::integer,
        ${input.operationalContext.terminalId}::text, ${input.operationalContext.orderClaimId}::text,
        public."pos_manual_t2_write_observation_multiset_digest_v1"(
          ARRAY[${Prisma.join(requestDigests.map((digest) => Prisma.sql`${digest}::text`))}]::text[]
        )
      ) AS "requestHash"
  `);
  const hash = hashRows[0];
  if (!hash?.requestHash || !hash.databaseName || !hash.sessionRole) throw new Error("Não foi possível vincular a capability T2 à sessão de banco.");
  await tx.$executeRaw(Prisma.sql`
    SELECT public."pos_manual_prepare_held_sale_items_write_v1"(
      ${input.action}::text, ${input.heldSaleId}::text, ${input.expectedRevision}::integer,
      ${input.actorUserId}::text, ${input.idempotencyKey}::text, ${hash.requestHash}::text,
      ${operationalContextJson}::jsonb, ${targetItemsJson}::jsonb
    )
  `);
}

function jsonCanonicalValue(value: unknown): T2CanonicalValue {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value)) as T2CanonicalValue;
}
