import { Prisma } from "@/generated/tenant/client";

type TransactionClient = Prisma.TransactionClient;
type QueryClient = Pick<TransactionClient, "$queryRaw">;

export type PosPaymentPlanGraphAction = "quote" | "activate" | "consume" | "supersede" | "expire";

export type PosPaymentPlanGraphWrite = {
  action: PosPaymentPlanGraphAction;
  planId: string;
  expectedVersion: number;
  actorUserId: string;
  idempotencyKey: string;
  targetPlan: Prisma.InputJsonObject;
  quoteLines: Prisma.InputJsonObject[];
  slots: Prisma.InputJsonObject[];
};

/**
 * Opens the T2 payment-plan graph roots and returns the database-bound request
 * hash that the following DML must persist. The preview and capability must run
 * in the same transaction and before any protected graph write.
 */
export async function preparePosPaymentPlanGraphWrite(
  tx: TransactionClient,
  input: PosPaymentPlanGraphWrite,
) {
  const requestHash = await previewPosPaymentPlanGraphWriteHash(tx, input);
  const targetPlan = JSON.stringify(input.targetPlan);
  const quoteLines = JSON.stringify(input.quoteLines);
  const slots = JSON.stringify(input.slots);
  await tx.$queryRaw(Prisma.sql`
    SELECT public."pos_manual_prepare_payment_plan_graph_write_v1"(
      ${input.action}, ${input.planId}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, ${requestHash}, CAST(${targetPlan} AS jsonb),
      CAST(${quoteLines} AS jsonb), CAST(${slots} AS jsonb)
    )
  `);
  return requestHash;
}

export async function previewPosPaymentPlanGraphWriteHash(
  db: QueryClient,
  input: PosPaymentPlanGraphWrite,
) {
  const targetPlan = JSON.stringify(input.targetPlan);
  const quoteLines = JSON.stringify(input.quoteLines);
  const slots = JSON.stringify(input.slots);
  const preview = await db.$queryRaw<Array<{ requestHash: string }>>(Prisma.sql`
    SELECT public."pos_manual_t2_payment_plan_graph_request_hash_v1"(
      ${input.action}, ${input.planId}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, CAST(${targetPlan} AS jsonb),
      CAST(${quoteLines} AS jsonb), CAST(${slots} AS jsonb)
    ) AS "requestHash"
  `);
  const requestHash = preview[0]?.requestHash;
  if (!requestHash) throw new Error("A capability do grafo de pagamento não retornou request hash.");
  return requestHash;
}
