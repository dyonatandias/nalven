import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NALVEN PDV Offline",
    short_name: "NALVEN PDV",
    description: "Preparação offline segura de rascunhos do PDV NALVEN.",
    start_url: "/erp/pdv-offline",
    scope: "/erp/",
    display: "standalone",
    background_color: "#f4f7f6",
    theme_color: "#102a43",
    orientation: "any",
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
