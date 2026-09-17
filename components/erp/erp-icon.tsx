import type { ReactNode, SVGProps } from "react";

const paths: Record<string, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  pdv: <><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h3M15 13h1M8 17h8"/></>,
  sales: <><path d="M4 19V9M10 19V5M16 19v-7M3 19h18"/><path d="m14 5 3-3 3 3M17 2v7"/></>,
  products: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></>,
  stock: <><path d="M7 7h11l2 3-2 3H7M17 17H6l-2-3 2-3"/><path d="m15 5 2 2-2 2M9 15l-2 2 2 2"/></>,
  finance: <><circle cx="12" cy="12" r="9"/><path d="M15 8.5c-.6-.5-1.5-.8-2.5-.8-1.4 0-2.5.7-2.5 1.8s1 1.6 2.5 2c1.5.4 2.5.9 2.5 2s-1.1 1.8-2.5 1.8c-1.1 0-2.1-.4-2.8-1M12.5 6v12"/></>,
  customers: <><circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2.4-7 6-7s6 3 6 7M16 4.5a3 3 0 0 1 0 6M17 13c2.4.7 4 3.3 4 6"/></>,
  users: <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20c0-4 2.4-7 6-7s6 3 6 7M15 15c3.3 0 5 2 5 5"/></>,
  library: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  support: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 1 1 4.2 2.2c-1 .7-1.7 1.2-1.7 2.3M12 17h.01"/></>,
  account: <><circle cx="12" cy="8" r="4"/><path d="M4 21c.6-4.5 3.2-7 8-7s7.4 2.5 8 7"/></>,
  logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>, collapse: <><path d="M9 4H4v16h5M15 8l-4 4 4 4M20 4v16"/></>, expand: <><path d="M15 4h5v16h-5M9 8l4 4-4 4M4 4v16"/></>, chevron: <path d="m9 6 6 6-6 6"/>, close: <path d="M6 6l12 12M18 6 6 18"/>
};
const aliases: Record<string, string> = { invoices: "sales", orders: "sales", crm: "customers", contracts: "products", "service-orders": "settings", purchases: "products", inventory: "stock", production: "settings", marketplaces: "dashboard", logistics: "stock", accounts: "finance", "cash-close": "finance", reconciliation: "finance", planning: "sales", fiscal: "products", suppliers: "customers", categories: "products", reports: "sales", branches: "dashboard", automations: "settings", activities: "sales", privacy: "account" };
export function ErpIcon({ name, ...props }: { name: string } & SVGProps<SVGSVGElement>) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[aliases[name] || name] || paths.dashboard}</svg>; }
