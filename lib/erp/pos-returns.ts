export type PosReturnBalance = {
  totalQuantity: number;
  returnedQuantity: number;
  totalCents: number;
  returnedCents: number;
};

/**
 * Allocates the original immutable line value across repeated returns.
 * The last return always receives the exact remaining cents, eliminating
 * rounding drift without ever refunding more than the persisted line total.
 */
export function calculatePosReturnRefundCents(balance: PosReturnBalance, requestedQuantity: number) {
  const remainingQuantity = Math.max(0, balance.totalQuantity - balance.returnedQuantity);
  const remainingCents = Math.max(0, balance.totalCents - balance.returnedCents);
  if (requestedQuantity <= 0 || remainingQuantity <= 0 || remainingCents <= 0) return 0;
  if (requestedQuantity >= remainingQuantity - 0.000_001) return remainingCents;
  return Math.min(remainingCents, Math.max(0, Math.round(balance.totalCents * requestedQuantity / balance.totalQuantity)));
}
