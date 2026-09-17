import { PosDomainError } from "@/lib/erp/pos-domain";

export type PosClosingPolicy = {
  totalDifferenceCents: number;
  absoluteDifferenceCents: number;
  approvalRequired: boolean;
};

/**
 * Applies the cash-close policy without exposing expected tender balances to the
 * operator. Offsetting tender discrepancies are deliberately not netted for the
 * approval threshold: cash short and card over are two discrepancies, not zero.
 */
export function evaluatePosClosingPolicy(input: {
  differencesCents: readonly number[];
  toleranceCents: number;
  notes: string | null;
  approvalId: string | null;
}): PosClosingPolicy {
  if (!Number.isSafeInteger(input.toleranceCents) || input.toleranceCents < 0) {
    throw new PosDomainError("A tolerância de fechamento está configurada incorretamente.");
  }
  if (!input.differencesCents.length || input.differencesCents.some((value) => !Number.isSafeInteger(value))) {
    throw new PosDomainError("As diferenças do fechamento são inválidas.");
  }
  const totalDifferenceCents = input.differencesCents.reduce((sum, value) => sum + value, 0);
  const absoluteDifferenceCents = input.differencesCents.reduce((sum, value) => sum + Math.abs(value), 0);
  if (!Number.isSafeInteger(totalDifferenceCents) || !Number.isSafeInteger(absoluteDifferenceCents)) {
    throw new PosDomainError("Os totais do fechamento excedem o limite suportado.");
  }
  if (absoluteDifferenceCents > 0 && (!input.notes || input.notes.trim().length < 8)) {
    throw new PosDomainError("Justifique a divergência do fechamento com pelo menos 8 caracteres.");
  }
  const approvalRequired = absoluteDifferenceCents > input.toleranceCents;
  if (approvalRequired && !input.approvalId) {
    throw new PosDomainError("A divergência supera a tolerância. Solicite uma aprovação independente para este turno e tente novamente.");
  }
  return { totalDifferenceCents, absoluteDifferenceCents, approvalRequired };
}
