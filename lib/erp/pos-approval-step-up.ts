import { createHash } from "node:crypto";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { normalizePosApprovalDecision, type PosApprovalDecision } from "@/lib/erp/pos-approvals";

const ALLOWED_KEYS = new Set(["action", "approvalId", "email", "password", "decision", "decisionReason"]);

export type PosApprovalStepUpInput = {
  action: "approval.step-up.decide";
  approvalId: string;
  email: string;
  password: string;
  decision: PosApprovalDecision;
  decisionReason: string | null;
};

export function normalizePosApprovalStepUpInput(value: Record<string, unknown>): PosApprovalStepUpInput {
  for (const key of Object.keys(value)) if (!ALLOWED_KEYS.has(key)) throw new PosDomainError(`Campo não permitido na aprovação reforçada: ${key}.`);
  if (value.action !== "approval.step-up.decide") throw new PosDomainError("Ação de aprovação reforçada inválida.");
  const approvalId = boundedText(value.approvalId, 1, 120, "Aprovação");
  const email = boundedText(value.email, 3, 320, "E-mail").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PosDomainError("E-mail do supervisor inválido.");
  if (typeof value.password !== "string" || value.password.length < 1 || new TextEncoder().encode(value.password).byteLength > 512) {
    throw new PosDomainError("Credencial do supervisor inválida.");
  }
  const { decision, decisionReason } = normalizePosApprovalDecision(value);
  return { action: value.action, approvalId, email, password: value.password, decision, decisionReason };
}

export function posApprovalStepUpTargetKey(email: string) {
  return `supervisor:${createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex").slice(0, 32)}`;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "string") throw new PosDomainError(`${label} inválida.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PosDomainError(`${label} inválida.`);
  return normalized;
}
