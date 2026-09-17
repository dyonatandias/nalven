import { createHmac } from "node:crypto";
import { encryptSecret } from "@/lib/secrets";
import { isValidTaxDocument, normalizeTaxDocument } from "@/lib/erp/customer-input";

export const PRIVACY_REQUEST_TYPES = ["access", "correction", "deletion", "portability", "revocation", "restriction", "objection", "anonymization", "info_sharing"] as const;
export const PRIVACY_REQUEST_STATUSES = ["received", "identity_pending", "verified", "in_progress", "completed", "rejected"] as const;
export const PRIVACY_PRIORITIES = ["normal", "high", "urgent"] as const;
export const PRIVACY_INCIDENT_STATUSES = ["open", "assessing", "contained", "notifying", "resolved"] as const;
export const PRIVACY_RISKS = ["low", "medium", "high", "critical"] as const;
export const PRIVACY_LEGAL_BASES = ["consent", "contract", "legal_obligation", "legitimate_interest", "credit_protection", "public_policy", "research", "health", "legal_claims", "fraud_prevention", "life_protection"] as const;

export class PrivacyGovernanceError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function parsePrivacyQuery(params: URLSearchParams) {
  const page = integer(params.get("page"), 1, 1, 200), limit = integer(params.get("limit"), 50, 20, 100);
  return {
    page, limit,
    search: bounded(params.get("search"), 120),
    status: optionalChoice(params.get("status"), PRIVACY_REQUEST_STATUSES),
    type: optionalChoice(params.get("type"), PRIVACY_REQUEST_TYPES),
    priority: optionalChoice(params.get("priority"), PRIVACY_PRIORITIES),
    sort: params.get("sort") === "oldest" ? "oldest" as const : "newest" as const,
    format: params.get("format") === "csv" ? "csv" as const : "json" as const,
  };
}

export function privacyRequestCreateInput(value: unknown) {
  const input = record(value), document = normalizeTaxDocument(input.subjectDocument);
  if (!isValidTaxDocument(document)) throw new PrivacyGovernanceError("Informe um CPF ou CNPJ válido para identificar o titular.");
  const contact = required(input.contact, 5, 180, "Informe um contato válido."), contactType = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? "email" : "phone";
  if (contactType === "phone" && contact.replace(/\D/g, "").length < 10) throw new PrivacyGovernanceError("Informe um e-mail ou telefone válido.");
  return {
    type: requiredChoice(input.type, PRIVACY_REQUEST_TYPES, "Direito do titular inválido."),
    subjectName: required(input.subjectName, 2, 160, "Informe o nome do titular."),
    document, contact, contactType,
    channel: requiredChoice(input.channel || contactType, ["email", "phone", "portal", "in_person", "letter"] as const, "Canal inválido."),
    priority: requiredChoice(input.priority || "normal", PRIVACY_PRIORITIES, "Prioridade inválida."),
    requesterRelation: requiredChoice(input.requesterRelation || "self", ["self", "legal_representative", "guardian"] as const, "Relação do solicitante inválida."),
    assignedTo: optional(input.assignedTo, 160),
    note: optional(input.note, 2000),
  };
}

export function privacyRequestTransitionInput(value: unknown) {
  const input = record(value), status = requiredChoice(input.status, PRIVACY_REQUEST_STATUSES, "Estado da solicitação inválido."), evidence = optional(input.evidence, 2000), responseSummary = optional(input.responseSummary, 3000), rejectionReason = optional(input.rejectionReason, 2000), identityMethod = optional(input.identityMethod, 240);
  if (status === "verified" && !identityMethod) throw new PrivacyGovernanceError("Registre o método de validação da identidade.");
  if (status === "completed" && (!evidence || !responseSummary)) throw new PrivacyGovernanceError("Conclusão exige evidência e resumo da resposta ao titular.");
  if (status === "rejected" && !rejectionReason) throw new PrivacyGovernanceError("Registre a justificativa do não atendimento.");
  return { id: positiveId(input.requestId, "Solicitação inválida."), expectedVersion: integer(input.expectedVersion, 0, 1, 2_147_483_647), status, note: optional(input.note, 2000), evidence, responseSummary, rejectionReason, identityMethod, assignedTo: optional(input.assignedTo, 160) };
}

export function privacyNoteInput(value: unknown) {
  const input = record(value);
  return { id: positiveId(input.requestId, "Solicitação inválida."), note: required(input.note, 2, 2000, "A anotação deve ter entre 2 e 2.000 caracteres.") };
}

export function legalBasisInput(value: unknown) {
  const input = record(value), internationalTransfer = boolean(input.internationalTransfer), safeguards = optional(input.safeguards, 2000);
  if (internationalTransfer && !safeguards) throw new PrivacyGovernanceError("Informe as salvaguardas da transferência internacional.");
  return {
    id: optionalId(input.basisId), expectedVersion: optionalVersion(input.expectedVersion),
    name: required(input.name, 2, 160, "Informe o nome do tratamento."),
    basis: requiredChoice(input.basis, PRIVACY_LEGAL_BASES, "Hipótese legal inválida."),
    purpose: required(input.purpose, 5, 1000, "Descreva a finalidade do tratamento."),
    dataCategory: required(input.dataCategory, 2, 160, "Informe a categoria de dados."),
    description: optional(input.description, 2000), dataSubjects: stringList(input.dataSubjects, 30), sourceSystems: stringList(input.sourceSystems, 30), recipients: stringList(input.recipients, 30),
    internationalTransfer, safeguards, owner: optional(input.owner, 160), reviewAt: optionalDate(input.reviewAt, "Data de revisão inválida."), active: input.active !== false,
  };
}

export function retentionRuleInput(value: unknown) {
  const input = record(value);
  return {
    id: optionalId(input.ruleId), expectedVersion: optionalVersion(input.expectedVersion),
    dataCategory: required(input.dataCategory, 2, 160, "Informe a categoria de dados."), retentionDays: integer(input.retentionDays, 0, 1, 36_500), legalReason: required(input.legalReason, 5, 1000, "Informe o fundamento da retenção."),
    action: requiredChoice(input.retentionAction || input.action || "anonymize", ["anonymize", "delete", "review"] as const, "Destino final inválido."), appliesTo: optional(input.appliesTo, 1000), owner: optional(input.owner, 160), reviewAt: optionalDate(input.reviewAt, "Data de revisão inválida."), active: input.active !== false,
  };
}

export function treatmentInput(value: unknown) {
  const input = record(value), internationalTransfer = boolean(input.internationalTransfer), transferSafeguards = optional(input.transferSafeguards, 2000);
  if (internationalTransfer && !transferSafeguards) throw new PrivacyGovernanceError("Informe as salvaguardas da transferência internacional.");
  return {
    id: optionalIdentifier(input.treatmentId), expectedVersion: optionalVersion(input.expectedVersion), name: required(input.name, 3, 180, "Informe o nome da operação de tratamento."), department: required(input.department, 2, 120, "Informe a área responsável."), purpose: required(input.purpose, 5, 1500, "Descreva a finalidade."), legalBasis: requiredChoice(input.legalBasis, PRIVACY_LEGAL_BASES, "Hipótese legal inválida."),
    dataCategories: requiredList(input.dataCategories, "Informe ao menos uma categoria de dados."), dataSubjects: requiredList(input.dataSubjects, "Informe ao menos uma categoria de titulares."), operations: requiredList(input.operations, "Informe ao menos uma operação de tratamento."), collectionSource: optional(input.collectionSource, 500), recipients: stringList(input.recipients, 40), systems: stringList(input.systems, 40), sensitiveData: boolean(input.sensitiveData), childrenData: boolean(input.childrenData), internationalTransfer, transferSafeguards, securityMeasures: optional(input.securityMeasures, 3000), retentionSummary: optional(input.retentionSummary, 1000), owner: required(input.owner, 2, 160, "Informe o responsável pelo tratamento."), riskLevel: requiredChoice(input.riskLevel || "medium", PRIVACY_RISKS, "Risco inválido."), status: requiredChoice(input.status || "active", ["draft", "active", "review_due", "archived"] as const, "Estado inválido."), lastReviewedAt: optionalDate(input.lastReviewedAt, "Data da última revisão inválida."), nextReviewAt: optionalDate(input.nextReviewAt, "Próxima revisão inválida."),
  };
}

export function impactAssessmentInput(value: unknown) {
  const input = record(value), status = requiredChoice(input.status || "draft", ["draft", "in_review", "approved", "superseded"] as const, "Estado do RIPD inválido."), dpoOpinion = optional(input.dpoOpinion, 3000);
  if (status === "approved" && !dpoOpinion) throw new PrivacyGovernanceError("A aprovação exige o parecer do encarregado ou da governança de privacidade.");
  return {
    id: optionalIdentifier(input.assessmentId), expectedVersion: optionalVersion(input.expectedVersion), treatmentId: optionalIdentifier(input.treatmentId), title: required(input.title, 3, 180, "Informe o título do RIPD."), reason: required(input.reason, 5, 2000, "Informe a justificativa do RIPD."), status,
    inherentRisk: requiredChoice(input.inherentRisk || "high", PRIVACY_RISKS, "Risco inerente inválido."), residualRisk: requiredChoice(input.residualRisk || "medium", PRIVACY_RISKS, "Risco residual inválido."), risks: requiredList(input.risks, "Registre ao menos um risco."), safeguards: requiredList(input.safeguards, "Registre ao menos uma salvaguarda."), necessity: optional(input.necessity, 3000), proportionality: optional(input.proportionality, 3000), dpoOpinion, reviewAt: optionalDate(input.reviewAt, "Revisão do RIPD inválida."),
  };
}

export function incidentCreateInput(value: unknown) {
  const input = record(value), riskRelevant = boolean(input.riskRelevant), decisionReason = optional(input.decisionReason, 2000);
  if (!riskRelevant && !decisionReason) throw new PrivacyGovernanceError("Registre por que o incidente não apresenta risco ou dano relevante.");
  return { title: required(input.title, 3, 180, "Informe o título do incidente."), severity: requiredChoice(input.severity || "medium", PRIVACY_RISKS, "Severidade inválida."), description: required(input.description, 10, 3000, "Descreva o incidente."), affectedSubjects: integer(input.affectedSubjects, 0, 0, 100_000_000), riskRelevant, dataCategories: requiredList(input.dataCategories, "Informe as categorias de dados envolvidas."), detectedAt: requiredDate(input.detectedAt || new Date().toISOString(), "Detecção inválida."), decisionReason, assignedTo: optional(input.assignedTo, 160) };
}

export function incidentTransitionInput(value: unknown) {
  const input = record(value), status = requiredChoice(input.status, PRIVACY_INCIDENT_STATUSES, "Estado do incidente inválido."), riskRelevant = boolean(input.riskRelevant), rootCause = optional(input.rootCause, 3000), containmentMeasures = optional(input.containmentMeasures, 3000), correctiveActions = optional(input.correctiveActions, 3000), decisionReason = optional(input.decisionReason, 2000);
  if (["contained", "notifying", "resolved"].includes(status) && !containmentMeasures) throw new PrivacyGovernanceError("Registre as medidas de contenção.");
  if (status === "resolved" && (!rootCause || !correctiveActions)) throw new PrivacyGovernanceError("A resolução exige causa raiz e ações corretivas.");
  if (!riskRelevant && !decisionReason) throw new PrivacyGovernanceError("Registre a justificativa da avaliação de relevância.");
  return { id: positiveId(input.incidentId, "Incidente inválido."), expectedVersion: integer(input.expectedVersion, 0, 1, 2_147_483_647), status, riskRelevant, rootCause, containmentMeasures, correctiveActions, decisionReason, assignedTo: optional(input.assignedTo, 160), markAnpdNotified: boolean(input.markAnpdNotified), markSubjectsNotified: boolean(input.markSubjectsNotified), note: optional(input.note, 2000) };
}

export function privacySettingsInput(value: unknown) {
  const input = record(value), email = optional(input.dataProtectionEmail, 180), phone = optional(input.dataProtectionPhone, 40);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PrivacyGovernanceError("E-mail do encarregado inválido.");
  return { dataProtectionOfficerName: optional(input.dataProtectionOfficerName, 160), dataProtectionEmail: email, dataProtectionPhone: phone, privacySmallAgent: boolean(input.privacySmallAgent), privacyDefaultRequestDays: integer(input.privacyDefaultRequestDays, 15, 1, 60), privacyProgramReviewAt: optionalDate(input.privacyProgramReviewAt, "Data de revisão do programa inválida.") };
}

export function protectPrivacySubject(document: string, contact: string) {
  const master = process.env.NALVEN_SECRETS_MASTER_KEY;
  if (!master) throw new PrivacyGovernanceError("Proteção criptográfica indisponível.", 503);
  const token = createHmac("sha256", master).update(`nalven:privacy-subject:v1\0${document}`, "utf8").digest("hex");
  return { subjectDocument: encryptSecret(document), subjectDocumentHash: `hmac-sha256:v1:${token}`, subjectDocumentLast4: document.slice(-4), contact: encryptSecret(contact), contactPreview: maskContact(contact) };
}

export function isProtectedPrivacySecret(value: string) { return /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value); }
export function maskContact(value: string) { const source = value.trim(); if (source.includes("@")) { const [name, domain] = source.split("@"); return `${name.slice(0, 2)}***@${domain}`; } const digits = source.replace(/\D/g, ""); return digits.length >= 4 ? `(**) *****-${digits.slice(-4)}` : "Contato protegido"; }
export function maskDocument(last4: string | null | undefined) { return last4 ? `••••••••${last4}` : "Documento protegido"; }

export function allowedRequestTransition(from: string, to: string) {
  const allowed: Record<string, string[]> = { received: ["identity_pending", "verified", "rejected"], identity_pending: ["verified", "rejected"], verified: ["in_progress", "completed", "rejected"], in_progress: ["completed", "rejected"], completed: [], rejected: [] };
  return allowed[from]?.includes(to) === true;
}

export function allowedIncidentTransition(from: string, to: string) {
  const allowed: Record<string, string[]> = { open: ["assessing", "contained", "resolved"], assessing: ["contained", "notifying", "resolved"], contained: ["notifying", "resolved"], notifying: ["resolved"], resolved: [] };
  return allowed[from]?.includes(to) === true;
}

export function addBusinessDays(source: Date, amount: number) {
  const result = new Date(source), direction = amount < 0 ? -1 : 1; let remaining = Math.abs(amount);
  while (remaining) { result.setUTCDate(result.getUTCDate() + direction); const day = result.getUTCDay(); if (day !== 0 && day !== 6) remaining -= 1; }
  return result;
}

export function privacyCsv(items: Array<{ number: string; type: string; subjectName: string; subjectDocument: string; contact: string; status: string; priority: string; assignedTo: string | null; dueAt: Date | string; createdAt: Date | string }>) {
  const rows = [["Protocolo", "Direito", "Titular", "Documento", "Contato", "Estado", "Prioridade", "Responsável", "Prazo", "Recebida em"], ...items.map((item) => [item.number, item.type, item.subjectName, item.subjectDocument, item.contact, item.status, item.priority, item.assignedTo || "", String(item.dueAt), String(item.createdAt)])];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

function csvCell(value: unknown) { let source = String(value ?? ""); if (/^[=+\-@]/.test(source)) source = `'${source}`; return `"${source.replaceAll('"', '""')}"`; }
function record(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivacyGovernanceError("Payload de privacidade inválido."); return value as Record<string, unknown>; }
function bounded(value: unknown, maximum: number) { const result = String(value || "").trim(); if (result.length > maximum) throw new PrivacyGovernanceError("Um filtro excede o tamanho permitido."); return result; }
function required(value: unknown, minimum: number, maximum: number, message: string) { const result = bounded(value, maximum); if (result.length < minimum) throw new PrivacyGovernanceError(message); return result; }
function optional(value: unknown, maximum: number) { return bounded(value, maximum) || null; }
function requiredChoice<T extends string>(value: unknown, values: readonly T[], message: string) { const result = String(value || "") as T; if (!values.includes(result)) throw new PrivacyGovernanceError(message); return result; }
function optionalChoice<T extends string>(value: unknown, values: readonly T[]) { const source = String(value || ""); return values.includes(source as T) ? source as T : ""; }
function integer(value: unknown, fallback: number, minimum: number, maximum: number) { if (value == null || value === "") return fallback; const result = Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum) throw new PrivacyGovernanceError("Número inválido."); return result; }
function positiveId(value: unknown, message: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new PrivacyGovernanceError(message); return id; }
function optionalId(value: unknown) { return value == null || value === "" ? null : positiveId(value, "Registro inválido."); }
function optionalVersion(value: unknown) { return value == null || value === "" ? null : integer(value, 0, 1, 2_147_483_647); }
function optionalIdentifier(value: unknown) { const result = String(value || ""); if (!result) return null; if (!/^[A-Za-z0-9_-]{8,160}$/.test(result)) throw new PrivacyGovernanceError("Identificador inválido."); return result; }
function boolean(value: unknown) { return value === true || value === "true" || value === "on" || value === "1"; }
function optionalDate(value: unknown, message: string) { if (value == null || value === "") return null; const result = new Date(String(value)); if (Number.isNaN(result.valueOf())) throw new PrivacyGovernanceError(message); return result; }
function requiredDate(value: unknown, message: string) { const result = optionalDate(value, message); if (!result) throw new PrivacyGovernanceError(message); return result; }
function stringList(value: unknown, maximum: number) { const source = Array.isArray(value) ? value : String(value || "").split(/[\n,;]/); const items = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))]; if (items.length > maximum || items.some((item) => item.length > 160)) throw new PrivacyGovernanceError("Uma lista excede o limite permitido."); return items; }
function requiredList(value: unknown, message: string) { const items = stringList(value, 40); if (!items.length) throw new PrivacyGovernanceError(message); return items; }
