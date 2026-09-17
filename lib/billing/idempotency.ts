import { createHash } from "node:crypto";

/** Keep existing short keys stable across deploys. Long identifiers must not
 * truncate the command suffix and turn distinct commands into the same write. */
export function billingCommandKey(customerId: string, action: string, commandId: string) {
  const complete = `nalven:${customerId}:${action}:${commandId}`;
  return Buffer.byteLength(complete, "utf8") <= 200
    ? complete
    : `nalven:sha256:${createHash("sha256").update(complete).digest("hex")}`;
}
