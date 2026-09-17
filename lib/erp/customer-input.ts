import { assertRequestOrigin } from "@/lib/http-security";
export const CUSTOMER_SEGMENTS = ["standard", "vip", "wholesale", "strategic"] as const;
export const CUSTOMER_RISKS = ["unrated", "low", "medium", "high", "blocked"] as const;
export const CUSTOMER_CHANNELS = ["email", "phone", "whatsapp", "in_person"] as const;
export const CUSTOMER_ORIGINS = ["manual", "referral", "website", "marketplace", "campaign", "store"] as const;
export const CUSTOMER_INTERACTIONS = ["note", "call", "email", "meeting", "task"] as const;
export const CUSTOMER_CONSENT_PURPOSES = ["marketing_email", "marketing_whatsapp", "profiling", "service"] as const;
export const CUSTOMER_LEGAL_BASES = ["consent", "contract", "legal_obligation", "legitimate_interest", "credit_protection"] as const;

export type CustomerInput = {
  type: "PF" | "PJ"; name: string; tradeName: string | null; document: string; email: string | null; phone: string | null;
  creditLimit: number; notes: string | null; segment: (typeof CUSTOMER_SEGMENTS)[number]; origin: (typeof CUSTOMER_ORIGINS)[number];
  salesperson: string | null; paymentTermsDays: number; riskRating: (typeof CUSTOMER_RISKS)[number]; preferredChannel: (typeof CUSTOMER_CHANNELS)[number];
  address: { zip: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null };
};

export class CustomerInputError extends Error {}

export function customerInput(value: unknown): CustomerInput {
  const input = record(value), document = normalizeTaxDocument(input.document);
  if (!isValidTaxDocument(document)) throw new CustomerInputError("Informe um CPF ou CNPJ válido.");
  const email = emailValue(input.email), creditLimit = numberValue(input.creditLimit || 0, 0, 100_000_000, "Limite de crédito inválido.");
  const state = optional(input.state, 2)?.toUpperCase() || null;
  if (state && !/^[A-Z]{2}$/.test(state)) throw new CustomerInputError("UF inválida.");
  return {
    type: document.length === 14 ? "PJ" : "PF", name: limited(input.name, 2, 180, "Nome"), tradeName: optional(input.tradeName, 180), document, email,
    phone: phoneValue(input.phone), creditLimit: money(creditLimit), notes: optional(input.notes, 2000),
    segment: choice(input.segment || "standard", CUSTOMER_SEGMENTS, "Segmento inválido."), origin: choice(input.origin || "manual", CUSTOMER_ORIGINS, "Origem inválida."),
    salesperson: optional(input.salesperson, 120), paymentTermsDays: integerValue(input.paymentTermsDays || 0, 0, 365, "Prazo de pagamento inválido."),
    riskRating: choice(input.riskRating || "unrated", CUSTOMER_RISKS, "Classificação de risco inválida."), preferredChannel: choice(input.preferredChannel || "email", CUSTOMER_CHANNELS, "Canal preferencial inválido."),
    address: { zip: optional(input.zip, 10)?.replace(/\D/g, "") || null, street: optional(input.street, 180), number: optional(input.number, 30), complement: optional(input.complement, 120), district: optional(input.district, 120), city: optional(input.city, 120), state },
  };
}

export function customerContactInput(value: unknown) {
  const input = record(value);
  return { name: limited(input.name, 2, 120, "Nome do contato"), role: optional(input.role, 100), email: emailValue(input.email), phone: phoneValue(input.phone), primary: booleanValue(input.primary) };
}

export function customerInteractionInput(value: unknown) {
  const input = record(value), dueAt = input.dueAt ? dateValue(input.dueAt, "Prazo inválido.") : null;
  return { type: choice(input.type || "note", CUSTOMER_INTERACTIONS, "Tipo de interação inválido."), subject: limited(input.subject, 2, 180, "Assunto"), notes: optional(input.notes, 2000), dueAt };
}

export function customerConsentInput(value: unknown) {
  const input = record(value), purpose = choice(input.purpose, CUSTOMER_CONSENT_PURPOSES, "Finalidade inválida."), status = choice(input.status, ["granted", "revoked"] as const, "Estado do consentimento inválido."), legalBasis = choice(input.legalBasis, CUSTOMER_LEGAL_BASES, "Base legal inválida.");
  const proofReference = optional(input.proofReference, 500);
  if (legalBasis === "consent" && !proofReference) throw new CustomerInputError("Registre a evidência do consentimento.");
  return { purpose, status, legalBasis, channel: optional(input.channel, 60), source: limited(input.source, 2, 120, "Origem do registro"), proofReference, expiresAt: input.expiresAt ? dateValue(input.expiresAt, "Validade inválida.") : null };
}

export function customerAddressInput(value: unknown) {
  const input = record(value), state = optional(input.state, 2)?.toUpperCase() || null;
  if (state && !/^[A-Z]{2}$/.test(state)) throw new CustomerInputError("UF inválida.");
  return { label: limited(input.label || "Endereço", 2, 80, "Identificação do endereço"), zip: optional(input.zip, 10)?.replace(/\D/g, "") || null, street: optional(input.street, 180), number: optional(input.number, 30), complement: optional(input.complement, 120), district: optional(input.district, 120), city: optional(input.city, 120), state, primary: booleanValue(input.primary) };
}

export function customerTagInput(value: unknown) {
  const input = record(value), color = String(input.color || "#168151").trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new CustomerInputError("Cor da etiqueta inválida.");
  return { name: limited(input.name, 2, 40, "Etiqueta"), color: color.toLowerCase() };
}

export function customerIds(value: unknown, maximum = 200) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new CustomerInputError(`Selecione entre 1 e ${maximum} clientes.`);
  const ids = [...new Set(value.map((item) => Number(item)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new CustomerInputError("Seleção de clientes inválida.");
  return ids;
}

export function customerEntityId(value: unknown, label = "Cliente") { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new CustomerInputError(`${label} inválido.`); return id; }
export function customerVersion(value: unknown) { return integerValue(value, 1, 2_147_483_647, "Versão do cliente inválida."); }

export function assertSameOrigin(request: Request) {
  try { assertRequestOrigin(request); }
  catch { throw new CustomerInputError("Origem da operação inválida."); }
}

function record(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new CustomerInputError("Dados do cliente inválidos."); return value as Record<string, unknown>; }
function optional(value: unknown, max: number) { const text = String(value || "").trim(); if (text.length > max) throw new CustomerInputError("Um dos campos excede o tamanho permitido."); return text || null; }
function limited(value: unknown, min: number, max: number, label: string) { const text = String(value || "").trim(); if (text.length < min || text.length > max) throw new CustomerInputError(`${label} inválido.`); return text; }
function choice<T extends string>(value: unknown, values: readonly T[], message: string): T { const parsed = String(value) as T; if (!values.includes(parsed)) throw new CustomerInputError(message); return parsed; }
function numberValue(value: unknown, min: number, max: number, message: string) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new CustomerInputError(message); return parsed; }
function integerValue(value: unknown, min: number, max: number, message: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new CustomerInputError(message); return parsed; }
function booleanValue(value: unknown) { return value === true || value === "true" || value === "on" || value === 1; }
function emailValue(value: unknown) { const email = optional(value, 254)?.toLowerCase() || null; if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CustomerInputError("E-mail inválido."); return email; }
function phoneValue(value: unknown) { const phone = optional(value, 24)?.replace(/[^\d+]/g, "") || null; if (phone && phone.replace(/\D/g, "").length < 8) throw new CustomerInputError("Telefone inválido."); return phone; }
function dateValue(value: unknown, message: string) { const date = new Date(String(value)); if (Number.isNaN(date.valueOf())) throw new CustomerInputError(message); return date; }
function money(value: number) { return Math.round(value * 100) / 100; }
export function normalizeTaxDocument(value: unknown) { return String(value || "").replace(/\D/g, ""); }
export function isValidTaxDocument(value: string) { return value.length === 11 ? validCpf(value) : value.length === 14 ? validCnpj(value) : false; }
function validCpf(value: string) { if (/^(\d)\1+$/.test(value)) return false; let sum = 0; for (let i = 0; i < 9; i++) sum += Number(value[i]) * (10 - i); let digit = (sum * 10) % 11; if (digit === 10) digit = 0; if (digit !== Number(value[9])) return false; sum = 0; for (let i = 0; i < 10; i++) sum += Number(value[i]) * (11 - i); digit = (sum * 10) % 11; if (digit === 10) digit = 0; return digit === Number(value[10]); }
function validCnpj(value: string) { if (/^(\d)\1+$/.test(value)) return false; const calc = (base: string, weights: number[]) => { const sum = weights.reduce((total, weight, index) => total + Number(base[index]) * weight, 0); const rest = sum % 11; return rest < 2 ? 0 : 11 - rest; }; const first = calc(value.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); const second = calc(value.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return `${first}${second}` === value.slice(-2); }
