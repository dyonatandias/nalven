import { controlDb } from "@/db/control";
import { enforceControlRateLimit, privateJson } from "@/lib/http-security";
import { portalLicenseContext, portalLicenseFailure, readPortalLicense } from "@/lib/billing/portal-license-service";

export async function GET(request: Request) {
  try {
    const context = await portalLicenseContext(request);
    await enforceControlRateLimit(controlDb, `portal:${context.organizationId}:${context.userId}:license-read`, 60, 60);
    return privateJson(await readPortalLicense(context, new URL(request.url).searchParams));
  } catch (error) { return portalLicenseFailure(error); }
}
