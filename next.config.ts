import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    const globalHeaders = [
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    ];
    const documentHeaders = [
      {
        key: "Content-Security-Policy",
        value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
      },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    return [
      { source: "/:path*", headers: globalHeaders },
      {
        source: "/:path((?!api(?:/|$)|_next(?:/|$)).*)",
        headers: documentHeaders,
      },
    ];
  },
};

export default nextConfig;
