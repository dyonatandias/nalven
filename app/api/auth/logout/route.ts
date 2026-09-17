import { destroySession } from "@/lib/auth";
import { assertTrustedMutation, HttpSecurityError, httpSecurityErrorResponse, privateJson, unexpectedErrorResponse } from "@/lib/http-security";

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { contentType: "none", maximumBytes: 0 });
    await destroySession();
    return privateJson({ ok: true });
  } catch (error) {
    if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
    return unexpectedErrorResponse("auth.logout", error);
  }
}
