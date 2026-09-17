import type { Prisma } from "@/generated/tenant/client";
import { applyPosValueCommand, hashPosValueCommand, issuePosValueAccount, resolvePosGiftCard, type PosValueKind, PosValueError } from "@/lib/erp/pos-value-accounts";
import { verifyPosGiftPin } from "@/lib/erp/pos-value-secrets";

export type PosSaleValuePaymentInput = {
  paymentIndex: number;
  amountCents: number;
  accountId?: string | null;
  units?: number | null;
  giftCode?: string | null;
  giftPin?: string | null;
  authorizedGiftAccountId?: string | null;
};

type ValueAccount = {
  id: string;
  branchId: number;
  customerId: number | null;
  programId: string | null;
  kind: string;
  unit: string;
  status: string;
  expiresAt: Date | null;
  pinHash: string | null;
  program: { id: string; redeemCentsPerUnit: number } | null;
};

export function posValueUnitsForPayment(account: Pick<ValueAccount, "kind" | "unit" | "program">, amountCents: number, requestedUnits?: number | null) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new PosValueError("Valor do pagamento por saldo inválido.");
  if (account.unit === "cents") {
    if (requestedUnits != null && requestedUnits !== amountCents) throw new PosValueError("Unidades monetárias devem corresponder aos centavos do pagamento.");
    return amountCents;
  }
  if (account.kind !== "loyalty_points" || !account.program || !Number.isSafeInteger(account.program.redeemCentsPerUnit) || account.program.redeemCentsPerUnit <= 0) throw new PosValueError("Programa de pontos sem conversão de resgate válida.", 409);
  if (!Number.isSafeInteger(requestedUnits) || Number(requestedUnits) <= 0 || Number(requestedUnits) * account.program.redeemCentsPerUnit !== amountCents) throw new PosValueError("O resgate de pontos deve corresponder exatamente ao valor convertido.");
  return Number(requestedUnits);
}

export function posValueRefundUnits(paymentUnits: number, paymentCents: number, refundCents: number) {
  if (!Number.isSafeInteger(paymentUnits) || paymentUnits <= 0 || !Number.isSafeInteger(paymentCents) || paymentCents <= 0 || !Number.isSafeInteger(refundCents) || refundCents <= 0 || refundCents > paymentCents) throw new PosValueError("Unidades de estorno do saldo inválidas.");
  const numerator = BigInt(paymentUnits) * BigInt(refundCents), divisor = BigInt(paymentCents);
  if (numerator % divisor !== BigInt(0)) throw new PosValueError("A devolução parcial não corresponde a unidades inteiras do saldo utilizado.", 409);
  const result = numerator / divisor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new PosValueError("O estorno do saldo excede o limite seguro.");
  return Number(result);
}

export function posValueAccrualClawbackUnits(accruedUnits: number, saleTotalCents: number, returnedCents: number, alreadyClawedBackUnits = 0) {
  if (![accruedUnits, saleTotalCents, returnedCents, alreadyClawedBackUnits].every(Number.isSafeInteger) || accruedUnits < 0 || saleTotalCents <= 0 || returnedCents < 0 || returnedCents > saleTotalCents || alreadyClawedBackUnits < 0 || alreadyClawedBackUnits > accruedUnits) throw new PosValueError("Rateio de reversão da recompensa inválido.");
  const target = returnedCents === saleTotalCents ? accruedUnits : Math.floor(accruedUnits * returnedCents / saleTotalCents);
  return Math.max(0, target - alreadyClawedBackUnits);
}

export async function consumePosSaleValues(tx: Prisma.TransactionClient, input: {
  branchId: number;
  customerId: number | null;
  saleDraftId: string;
  payments: readonly PosSaleValuePaymentInput[];
  actor: string;
  now: Date;
}) {
  const results: Array<{ paymentIndex: number; accountId: string; accountKind: PosValueKind; amountUnits: number; reservationId: string; captureEntryId: string }> = [];
  for (const payment of [...input.payments].sort((left, right) => left.paymentIndex - right.paymentIndex)) {
    const account = await resolvePaymentAccount(tx, input.branchId, input.customerId, payment, input.now);
    const amountUnits = posValueUnitsForPayment(account, payment.amountCents, payment.units);
    const fingerprint = { purpose: "pos.sale.value-payment", version: 1, branchId: input.branchId, customerId: input.customerId, saleDraftId: input.saleDraftId, paymentIndex: payment.paymentIndex, accountId: account.id, amountCents: payment.amountCents, amountUnits };
    const reserveKey = operationKey(input.saleDraftId, `value:${payment.paymentIndex}:reserve`);
    const reserved = await applyPosValueCommand(tx, {
      type: "reserve",
      accountId: account.id,
      branchId: input.branchId,
      amountUnits,
      expectedCustomerId: account.kind === "gift_card" ? account.customerId : input.customerId,
      expiresAt: new Date(input.now.valueOf() + 15 * 60_000),
      operationKey: reserveKey,
      requestHash: hashPosValueCommand({ ...fingerprint, operation: "reserve" }),
      referenceType: "sale_draft",
      referenceId: input.saleDraftId,
      reason: "Reserva transacional do pagamento no PDV",
    }, { actor: input.actor, now: input.now });
    if (!reserved.reservation) throw new PosValueError("A reserva do pagamento por saldo não foi persistida.", 409);
    const captured = await applyPosValueCommand(tx, {
      type: "capture",
      reservationId: reserved.reservation.id,
      branchId: input.branchId,
      operationKey: operationKey(input.saleDraftId, `value:${payment.paymentIndex}:capture`),
      requestHash: hashPosValueCommand({ ...fingerprint, operation: "capture", reservationId: reserved.reservation.id }),
      referenceType: "sale_draft",
      referenceId: input.saleDraftId,
      reason: "Captura transacional do pagamento no PDV",
    }, { actor: input.actor, now: input.now });
    results.push({ paymentIndex: payment.paymentIndex, accountId: account.id, accountKind: account.kind as PosValueKind, amountUnits, reservationId: reserved.reservation.id, captureEntryId: captured.entry.id });
  }
  return results;
}

export async function accruePosSaleValues(tx: Prisma.TransactionClient, input: { branchId: number; customerId: number | null; customerName: string | null; saleId: number; saleKey: string; totalCents: number; actor: string; now: Date }) {
  if (!input.customerId) return [];
  const programs = await tx.posValueProgram.findMany({ where: { branchId: input.branchId, status: "active", kind: { in: ["loyalty_points", "cashback"] } }, orderBy: { id: "asc" } });
  const accrued: Array<{ programId: string; accountId: string; units: number; entryId: string }> = [];
  for (const program of programs) {
    const earned = Math.floor(input.totalCents / program.spendCents) * program.earnUnits;
    if (!Number.isSafeInteger(earned) || earned <= 0) continue;
    let account = await tx.posValueAccount.findUnique({ where: { programId_customerId: { programId: program.id, customerId: input.customerId } } });
    if (!account) {
      const issued = await issuePosValueAccount(tx, {
        branchId: input.branchId,
        customerId: input.customerId,
        programId: program.id,
        kind: program.kind as "loyalty_points" | "cashback",
        label: `${program.name} · ${input.customerName || `cliente ${input.customerId}`}`.slice(0, 160),
        initialUnits: 0,
        expiresAt: null,
        operationKey: operationKey(input.saleKey, `accrual:${program.id}:issue`),
        requestHash: hashPosValueCommand({ purpose: "pos.sale.accrual-account", version: 1, branchId: input.branchId, customerId: input.customerId, programId: program.id }),
        referenceType: "sale_accrual_account",
        referenceId: String(input.customerId),
        reason: "Abertura automática da conta de fidelidade pelo PDV",
      }, { actor: input.actor, now: input.now });
      account = await tx.posValueAccount.findUniqueOrThrow({ where: { id: issued.account.id } });
    }
    const result = await applyPosValueCommand(tx, {
      type: "credit",
      accountId: account.id,
      branchId: input.branchId,
      expectedCustomerId: input.customerId,
      amountUnits: earned,
      operationKey: operationKey(input.saleKey, `accrual:${program.id}:credit`),
      requestHash: hashPosValueCommand({ purpose: "pos.sale.accrual", version: 1, saleId: input.saleId, accountId: account.id, programId: program.id, totalCents: input.totalCents, earned }),
      referenceType: "sale_accrual",
      referenceId: String(input.saleId),
      reason: `Crédito automático da venda ${input.saleId}`,
    }, { actor: input.actor, now: input.now });
    accrued.push({ programId: program.id, accountId: account.id, units: earned, entryId: result.entry.id });
  }
  return accrued;
}

export async function reversePosSaleAccruals(tx: Prisma.TransactionClient, input: { branchId: number; saleId: number; saleTotalCents: number; returnedCents: number; operationKeyRoot: string; reason: string; actor: string; now: Date }) {
  const entries = await tx.posValueLedgerEntry.findMany({ where: { type: "credit", referenceType: "sale_accrual", referenceId: String(input.saleId), reversedBy: { none: {} } }, orderBy: { id: "asc" } });
  const results = [];
  for (const entry of entries) {
    const alreadyClawedBack = await tx.posValueLedgerEntry.aggregate({ where: { accountId: entry.accountId, type: "debit", referenceType: "sale_accrual_clawback", referenceId: String(input.saleId) }, _sum: { amountUnits: true } });
    const amountUnits = posValueAccrualClawbackUnits(Number(entry.amountUnits), input.saleTotalCents, input.returnedCents, Number(alreadyClawedBack._sum.amountUnits || BigInt(0)));
    if (!amountUnits) continue;
    results.push(await applyPosValueCommand(tx, {
      type: "debit",
      accountId: entry.accountId,
      branchId: input.branchId,
      amountUnits,
      operationKey: operationKey(input.operationKeyRoot, `accrual-clawback:${entry.id}`),
      requestHash: hashPosValueCommand({ purpose: "pos.sale.accrual-clawback", version: 1, saleId: input.saleId, entryId: entry.id.toString(), saleTotalCents: input.saleTotalCents, returnedCents: input.returnedCents, amountUnits, reason: input.reason }),
      referenceType: "sale_accrual_clawback",
      referenceId: String(input.saleId),
      reason: input.reason,
    }, { actor: input.actor, now: input.now }));
  }
  return results;
}

export async function refundPosSaleValue(tx: Prisma.TransactionClient, input: { branchId: number; accountId: string; amountUnits: number; referenceType: "sale_cancel" | "pos_return"; referenceId: string; operationKey: string; actor: string; now: Date }) {
  return applyPosValueCommand(tx, {
    type: "credit",
    accountId: input.accountId,
    branchId: input.branchId,
    amountUnits: input.amountUnits,
    operationKey: input.operationKey,
    requestHash: hashPosValueCommand({ purpose: "pos.sale.value-refund", version: 1, accountId: input.accountId, amountUnits: input.amountUnits, referenceType: input.referenceType, referenceId: input.referenceId }),
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    reason: input.referenceType === "sale_cancel" ? "Estorno de saldo por cancelamento" : "Crédito de saldo por devolução",
  }, { actor: input.actor, now: input.now });
}

async function resolvePaymentAccount(tx: Prisma.TransactionClient, branchId: number, customerId: number | null, payment: PosSaleValuePaymentInput, now: Date): Promise<ValueAccount> {
  const code = cleanSecret(payment.giftCode, 160), pin = cleanSecret(payment.giftPin, 20);
  const authorizedGiftAccountId = String(payment.authorizedGiftAccountId || "").trim();
  if (authorizedGiftAccountId) {
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(authorizedGiftAccountId) || !pin || code || payment.accountId) throw new PosValueError("Autorização do gift card inválida.");
    const account = await tx.posValueAccount.findFirst({ where: { id: authorizedGiftAccountId, branchId, kind: "gift_card", status: "active", AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] }, include: { program: { select: { id: true, redeemCentsPerUnit: true } } } });
    if (!account?.pinHash || !await verifyPosGiftPin(pin, account.pinHash) || account.customerId != null && account.customerId !== customerId) throw new PosValueError("Gift card ou PIN inválido.", 404);
    return account;
  }
  if (code || pin) {
    if (!code || !pin || payment.accountId) throw new PosValueError("Informe código e PIN do gift card sem combinar com outra conta.");
    const resolved = await resolvePosGiftCard(tx, { branchId, code, pin, expectedCustomerId: customerId, now });
    const account = await tx.posValueAccount.findUnique({ where: { id: resolved.id }, include: { program: { select: { id: true, redeemCentsPerUnit: true } } } });
    if (!account) throw new PosValueError("Gift card indisponível.", 404);
    return account;
  }
  const accountId = String(payment.accountId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(accountId)) throw new PosValueError("Conta de valor inválida.");
  const account = await tx.posValueAccount.findUnique({ where: { id: accountId }, include: { program: { select: { id: true, redeemCentsPerUnit: true } } } });
  if (!account || account.branchId !== branchId || account.kind === "gift_card") throw new PosValueError("Conta de valor indisponível.", 404);
  if (!customerId || account.customerId !== customerId) throw new PosValueError("A conta de valor exige o cliente titular.", 403);
  return account;
}

function cleanSecret(value: unknown, maximum: number) {
  const result = String(value || "").trim();
  if (result.length > maximum || /[\u0000-\u001f]/.test(result)) throw new PosValueError("Credencial de valor inválida.");
  return result;
}

function operationKey(root: string, suffix: string) {
  const result = `${root}:${suffix}`;
  if (result.length < 16 || result.length > 200) throw new PosValueError("Chave operacional do saldo inválida.", 500);
  return result;
}
