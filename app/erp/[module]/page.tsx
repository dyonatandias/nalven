import { notFound, permanentRedirect } from "@/lib/site/server-navigation";
import { erpPageFromRoute, erpRoute } from "@/lib/erp/modules";
import ErpShell from "../erp-shell";

export default async function ErpModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const page = erpPageFromRoute(module);
  if (!page) return await notFound();
  const canonical = erpRoute(page);
  if (canonical !== `/erp/${module}`) return await permanentRedirect(canonical);
  return <ErpShell initialPage={page} />;
}
