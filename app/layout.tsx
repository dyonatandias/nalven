import { siteOrigin } from "@/lib/site/seo";
import type { Metadata } from "next";
import AnalyticsTracker from "@/components/analytics-tracker";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> { return {
  metadataBase: new URL(await siteOrigin()),
  title: "NALVEN", robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "NALVEN PDV", statusBarStyle: "black-translucent" },
}; }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}<AnalyticsTracker/></body></html>;
}
