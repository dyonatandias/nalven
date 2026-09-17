/** Login may return only to a canonical invitation path, never an arbitrary URL. */
export function safeInviteReturnTo(value: unknown) {
  return typeof value === "string" && /^\/convite\/[A-Za-z0-9_-]{40,100}$/.test(value) ? value : undefined;
}
