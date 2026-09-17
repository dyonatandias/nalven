export function validBillingHeadlessUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/$/, "") === "/api/v1/saas"; } catch { return false; }
}
