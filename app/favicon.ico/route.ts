/** Compatibility for browsers and bookmarks requesting the legacy icon URL. */
export function GET() {
  return new Response(null, { status: 307, headers: { location: "/favicon.svg", "cache-control": "no-store" } });
}
