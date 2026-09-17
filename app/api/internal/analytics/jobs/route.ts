import { pruneNavigation } from "@/lib/site/navigation";
import { aggregateAnalytics } from "@/lib/analytics/service";
import { assertInternalJob } from "@/lib/internal-jobs";
import { authErrorResponse } from "@/lib/auth";
import { privateJson } from "@/lib/http-security";

export async function POST(request: Request) {
  try {
    assertInternalJob(request);
    return privateJson({ summary: await aggregateAnalytics(), navigation: await pruneNavigation() });
  } catch (error) { return authErrorResponse(error); }
}
