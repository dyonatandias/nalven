import { isValidTaxDocument } from "@/lib/erp/customer-input";
import type { CustomerInput } from "./types";

export const BILLING_CONFLICT_MESSAGE = "Documento ou vínculo em conflito no Billing. Pare o provisionamento e faça a vinculação pelo painel administrativo do Billing, conferindo o mesmo e-mail do responsável entre produtos. Não haverá nova tentativa automática.";

export function customerIdentityError(payload: CustomerInput, organization: { id: string; document: string; email: string }, externalId?: string | null): string | null {
  if (!payload || payload.external_id !== organization.id || (externalId && externalId !== organization.id)) return "External ID legado ou divergente. O ID interno da organização é obrigatório; regularize o vínculo no Billing sem criar outra instância. Não renomeie o vínculo automaticamente.";
  if (typeof payload.documento !== "string" || !isValidTaxDocument(payload.documento) || payload.documento.replace(/\D/g, "") !== organization.document.replace(/\D/g, "")) return "CPF/CNPJ obrigatório, válido e igual ao cadastro da organização. Corrija o onboarding antes de provisionar.";
  const email = payload.responsavel?.email;
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.trim().toLowerCase() !== organization.email.trim().toLowerCase()) return "E-mail do responsável divergente ou inválido. Confira o cadastro e use o mesmo e-mail do Billing em todos os produtos.";
  return null;
}
