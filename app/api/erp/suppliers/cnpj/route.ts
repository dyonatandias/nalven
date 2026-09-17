import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { readJsonObject, HttpSecurityError } from "@/lib/http-security";
import { validCnpj } from "@/lib/erp/nfe-input";
import { persistentRateLimit } from "@/lib/integrations/core";

export async function POST(request: Request) {
  const headers = { "cache-control": "private, no-store" };
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "suppliers.write");
    const body = await readJsonObject(request);
    const cnpj = typeof body.document === "string" ? body.document.replace(/\D/g, "") : "";
    if (!validCnpj(cnpj)) return Response.json({ error: "Informe um CNPJ válido." }, { status: 422, headers });
    await persistentRateLimit(await tenantDb(organization.id), `supplier-cnpj:${access.user.id}`, 10, 60);
    const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return Response.json({ error: response.status === 404 ? "CNPJ não encontrado na base consultada." : "Consulta indisponível. Tente novamente mais tarde." }, { status: 422, headers });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) { await reader.cancel(); throw new Error("Response too large"); } chunks.push(part.value); }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (String(data.cnpj).replace(/\D/g, "") !== cnpj) throw new Error("Identity mismatch");
    const field = (key: string, max = 180) => typeof data[key] === "string" ? data[key].trim().slice(0, max) : "";
    return Response.json({ source: "BrasilAPI / Minha Receita", consultedAt: new Date().toISOString(),
      fields: { name: field("razao_social"), tradeName: field("nome_fantasia"), email: field("email"),
        phone: field("ddd_telefone_1", 30), zip: field("cep", 10), street: field("logradouro"),
        number: field("numero", 30), complement: field("complemento", 120), district: field("bairro", 120),
        city: field("municipio", 120), state: field("uf", 2) },
    }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    if (error instanceof HttpSecurityError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: 403, headers });
    return Response.json({ error: "Não foi possível consultar o CNPJ. O cadastro existente foi preservado." }, { status: 503, headers });
  }
}
