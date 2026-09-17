import { privateJson } from "@/lib/erp/report-server";
import { GET as salesReport } from "../sales/route";

export async function GET(request: Request) {
  const response = await salesReport(request);
  if (!response.ok) return response;
  const payload = await response.json();
  return privateJson({ top_sellers: payload.top_sellers, period: payload.period });
}
