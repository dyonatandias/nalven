import { Prisma } from "@/generated/tenant/client";

type TransactionClient = Prisma.TransactionClient;

export async function preparePosManualSessionTransition(tx: TransactionClient, input: {
  action: "close" | "suspend" | "resume";
  sessionId: number;
  expectedVersion: number;
  actorProfileId: number;
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
}) {
  await tx.$queryRaw(Prisma.sql`
    SELECT public."pos_manual_prepare_session_transition_v1"(
      ${input.action}, ${input.sessionId}, ${input.expectedVersion}, ${input.actorProfileId},
      ${input.actorUserId}, ${input.idempotencyKey}, ${input.requestHash}
    )
  `);
}

export async function preparePosManualHandoffTransition(tx: TransactionClient, input: {
  action: "request" | "accept" | "cancel" | "expire";
  handoffId: string;
  sessionId: number;
  expectedSessionVersion: number;
  expectedHandoffRevision: number;
  targetOperatorProfileId: number | null;
  actorProfileId: number;
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
  reason: string | null;
  expiresAt: Date | null;
  heldSaleSnapshot: Prisma.InputJsonValue | null;
}) {
  await tx.$queryRaw(Prisma.sql`
    SELECT public."pos_manual_prepare_handoff_transition_v1"(
      ${input.action}, ${input.handoffId}, ${input.sessionId}, ${input.expectedSessionVersion},
      ${input.expectedHandoffRevision}, CAST(${input.targetOperatorProfileId} AS integer),
      ${input.actorProfileId}, ${input.actorUserId}, ${input.idempotencyKey}, ${input.requestHash},
      CAST(${input.reason} AS text), CAST(${input.expiresAt} AS timestamptz),
      CAST(${input.heldSaleSnapshot === null ? null : JSON.stringify(input.heldSaleSnapshot)} AS jsonb)
    )
  `);
}
