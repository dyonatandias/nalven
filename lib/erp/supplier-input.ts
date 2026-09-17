import { isValidTaxDocument, normalizeTaxDocument } from "./customer-input";

export const SUPPLIER_CATEGORIES = ["goods", "services", "logistics", "technology", "utilities", "other"] as const;
export const SUPPLIER_ORIGINS = ["manual", "purchase", "invoice", "import", "referral"] as const;
export const SUPPLIER_RISKS = ["unrated", "low", "medium", "high", "blocked"] as const;
export const SUPPLIER_HOMOLOGATION = ["pending", "approved", "conditional", "rejected", "expired"] as const;
export const SUPPLIER_TAX_REGIMES = ["not_informed", "mei", "simples", "presumed", "actual", "individual"] as const;
export const SUPPLIER_INTERACTIONS = ["note", "call", "email", "meeting", "task", "negotiation"] as const;
export const SUPPLIER_DOCUMENT_TYPES = ["tax", "license", "certificate", "insurance", "contract", "bank", "other"] as const;
export const SUPPLIER_DOCUMENT_STATUS = ["valid", "pending", "expired", "rejected"] as const;

export type SupplierInput = {
  type: "PF" | "PJ"; name: string; tradeName: string | null; document: string; email: string | null; phone: string | null;
  category: (typeof SUPPLIER_CATEGORIES)[number]; origin: (typeof SUPPLIER_ORIGINS)[number]; buyer: string | null;
  riskRating: (typeof SUPPLIER_RISKS)[number]; homologationStatus: (typeof SUPPLIER_HOMOLOGATION)[number];
  taxRegime: (typeof SUPPLIER_TAX_REGIMES)[number]; stateRegistration: string | null; municipalRegistration: string | null; website: string | null;
  paymentTerms: string | null; paymentTermsDays: number; deliveryLeadTimeDays: number; minimumOrder: number; notes: string | null;
  address: { zip: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null };
};

export class SupplierInputError extends Error {}

export function supplierInput(value: unknown): SupplierInput {
  const input = record(value), document = normalizeTaxDocument(input.document);
  if (!isValidTaxDocument(document)) throw new SupplierInputError("Informe um CPF ou CNPJ válido.");
  const state = optional(input.state, 2)?.toUpperCase() || null, website = optional(input.website, 300);
  if (state && !/^[A-Z]{2}$/.test(state)) throw new SupplierInputError("UF inválida.");
  if (website && !/^https?:\/\/[^\s]+$/i.test(website)) throw new SupplierInputError("Site inválido. Informe uma URL iniciada por http:// ou https://.");
  return {
    type: document.length === 14 ? "PJ" : "PF", name: limited(input.name, 2, 180, "Nome / razão social"), tradeName: optional(input.tradeName, 180), document,
    email: emailValue(input.email), phone: phoneValue(input.phone), category: choice(input.category || "goods", SUPPLIER_CATEGORIES, "Categoria inválida."),
    origin: choice(input.origin || "manual", SUPPLIER_ORIGINS, "Origem inválida."), buyer: optional(input.buyer, 120), riskRating: choice(input.riskRating || "unrated", SUPPLIER_RISKS, "Classificação de risco inválida."),
    homologationStatus: choice(input.homologationStatus || "pending", SUPPLIER_HOMOLOGATION, "Situação de homologação inválida."), taxRegime: choice(input.taxRegime || "not_informed", SUPPLIER_TAX_REGIMES, "Regime tributário inválido."),
    stateRegistration: optional(input.stateRegistration, 40), municipalRegistration: optional(input.municipalRegistration, 40), website, paymentTerms: optional(input.paymentTerms, 120),
    paymentTermsDays: integerValue(input.paymentTermsDays || 0, 0, 365, "Prazo de pagamento inválido."), deliveryLeadTimeDays: integerValue(input.deliveryLeadTimeDays || 0, 0, 365, "Prazo de entrega inválido."),
    minimumOrder: money(numberValue(input.minimumOrder || 0, 0, 100_000_000, "Pedido mínimo inválido.")), notes: optional(input.notes, 3000),
    address: { zip: optional(input.zip, 10)?.replace(/\D/g, "") || null, street: optional(input.street, 180), number: optional(input.number, 30), complement: optional(input.complement, 120), district: optional(input.district, 120), city: optional(input.city, 120), state },
  };
}

export function supplierContactInput(value: unknown) { const input = record(value); return { name: limited(input.name, 2, 120, "Nome do contato"), role: optional(input.role, 100), email: emailValue(input.email), phone: phoneValue(input.phone), primary: booleanValue(input.primary) }; }
export function supplierAddressInput(value: unknown) { const input = record(value), state = optional(input.state, 2)?.toUpperCase() || null; if (state && !/^[A-Z]{2}$/.test(state)) throw new SupplierInputError("UF inválida."); return { label: limited(input.label || "Endereço", 2, 80, "Identificação do endereço"), zip: optional(input.zip, 10)?.replace(/\D/g, "") || null, street: optional(input.street, 180), number: optional(input.number, 30), complement: optional(input.complement, 120), district: optional(input.district, 120), city: optional(input.city, 120), state, primary: booleanValue(input.primary) }; }
export function supplierInteractionInput(value: unknown) { const input = record(value); return { type: choice(input.type || "note", SUPPLIER_INTERACTIONS, "Tipo de interação inválido."), subject: limited(input.subject, 2, 180, "Assunto"), notes: optional(input.notes, 3000), dueAt: input.dueAt ? dateValue(input.dueAt, "Prazo inválido.") : null }; }
export function supplierDocumentInput(value: unknown) { const input = record(value), issuedAt = input.issuedAt ? dateValue(input.issuedAt, "Data de emissão inválida.") : null, expiresAt = input.expiresAt ? dateValue(input.expiresAt, "Data de validade inválida.") : null; if (issuedAt && expiresAt && expiresAt < issuedAt) throw new SupplierInputError("A validade não pode ser anterior à emissão."); return { type: choice(input.documentType || input.type, SUPPLIER_DOCUMENT_TYPES, "Tipo de documento inválido."), name: limited(input.name, 2, 160, "Nome do documento"), number: optional(input.number, 100), status: choice(input.status || "valid", SUPPLIER_DOCUMENT_STATUS, "Situação do documento inválida."), issuedAt, expiresAt, fileReference: optional(input.fileReference, 500), notes: optional(input.notes, 2000) }; }
export function supplierEvaluationInput(value: unknown) { const input = record(value); return { qualityScore: integerValue(input.qualityScore, 0, 100, "Nota de qualidade inválida."), deliveryScore: integerValue(input.deliveryScore, 0, 100, "Nota de entrega inválida."), commercialScore: integerValue(input.commercialScore, 0, 100, "Nota comercial inválida."), complianceScore: integerValue(input.complianceScore, 0, 100, "Nota de conformidade inválida."), notes: optional(input.notes, 2000) }; }
export function supplierProductInput(value: unknown) { const input = record(value); return { productId: supplierEntityId(input.productId, "Produto"), supplierCode: optional(input.supplierCode, 80), lastCost: nullableMoney(input.lastCost, "Último custo inválido."), leadTimeDays: nullableInteger(input.leadTimeDays, 0, 365, "Prazo de entrega inválido."), minimumOrder: nullableMoney(input.productMinimumOrder, "Lote mínimo inválido."), preferred: booleanValue(input.preferred) }; }
export function supplierTagInput(value: unknown) { const input = record(value), color = String(input.color || "#168151").trim(); if (!/^#[0-9a-f]{6}$/i.test(color)) throw new SupplierInputError("Cor da etiqueta inválida."); return { name: limited(input.name, 2, 40, "Etiqueta"), color: color.toLowerCase() }; }
export function supplierIds(value: unknown, maximum = 200) { if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new SupplierInputError(`Selecione entre 1 e ${maximum} fornecedores.`); const ids = [...new Set(value.map(Number))]; if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new SupplierInputError("Seleção de fornecedores inválida."); return ids; }
export function supplierEntityId(value: unknown, label = "Fornecedor") { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new SupplierInputError(`${label} inválido.`); return id; }
export function supplierVersion(value: unknown) { return integerValue(value, 1, 2_147_483_647, "Versão do fornecedor inválida."); }

function record(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new SupplierInputError("Dados do fornecedor inválidos."); return value as Record<string, unknown>; }
function optional(value: unknown, max: number) { const text = String(value || "").trim(); if (text.length > max) throw new SupplierInputError("Um dos campos excede o tamanho permitido."); return text || null; }
function limited(value: unknown, min: number, max: number, label: string) { const text = String(value || "").trim(); if (text.length < min || text.length > max) throw new SupplierInputError(`${label} inválido.`); return text; }
function choice<T extends string>(value: unknown, values: readonly T[], message: string): T { const parsed = String(value) as T; if (!values.includes(parsed)) throw new SupplierInputError(message); return parsed; }
function integerValue(value: unknown, min: number, max: number, message: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new SupplierInputError(message); return parsed; }
function numberValue(value: unknown, min: number, max: number, message: string) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new SupplierInputError(message); return parsed; }
function nullableInteger(value: unknown, min: number, max: number, message: string) { return value === "" || value == null ? null : integerValue(value, min, max, message); }
function nullableMoney(value: unknown, message: string) { return value === "" || value == null ? null : money(numberValue(value, 0, 100_000_000, message)); }
function booleanValue(value: unknown) { return value === true || value === "true" || value === "on" || value === 1; }
function emailValue(value: unknown) { const email = optional(value, 254)?.toLowerCase() || null; if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SupplierInputError("E-mail inválido."); return email; }
function phoneValue(value: unknown) { const phone = optional(value, 24)?.replace(/[^\d+]/g, "") || null; if (phone && phone.replace(/\D/g, "").length < 8) throw new SupplierInputError("Telefone inválido."); return phone; }
function dateValue(value: unknown, message: string) { const date = new Date(String(value)); if (Number.isNaN(date.valueOf())) throw new SupplierInputError(message); return date; }
function money(value: number) { return Math.round(value * 100) / 100; }
