import { createHash } from "node:crypto";
import { PosAgentError } from "./pos-agent-auth";

export type PosPrintAckInput = {
  terminalId: string;
  jobId: string;
  claimId: string;
  state: "printed" | "failed";
  error: string | null;
};

export type PosPrintAckRecord = {
  terminalId: string;
  jobId: string;
  claimId: string;
  requestHash: string;
  resultStatus: string;
};

export function hashPosPrintAck(input: PosPrintAckInput) {
  const canonical = JSON.stringify([
    "pos.print.ack",
    "v1",
    input.terminalId,
    input.jobId,
    input.claimId,
    input.state,
    input.error,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function replayPosPrintAck(record: PosPrintAckRecord, input: PosPrintAckInput) {
  if (record.terminalId !== input.terminalId || record.jobId !== input.jobId || record.claimId !== input.claimId || record.requestHash !== hashPosPrintAck(input)) {
    throw new PosAgentError("O claim de impressão já foi confirmado com outro contexto ou payload.", 409);
  }
  return { id: record.jobId, status: record.resultStatus, replayed: true as const };
}
