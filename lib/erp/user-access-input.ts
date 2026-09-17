import { createHash } from "node:crypto";
import { PERMISSION_RESOURCES } from "./permission-resources";

export class UserAccessInputError extends Error {}
const resources = new Set<string>(PERMISSION_RESOURCES.map(item => item[0]));

export function roleInput(value: unknown) {
  const input = record(value);
  const name = text(input.name, 2, 100, "Nome do perfil inválido.");
  const key = String(input.key || name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  if (key.length < 2 || ["owner"].includes(key)) throw new UserAccessInputError("Identificador do perfil inválido ou reservado.");
  if (!Array.isArray(input.permissions) || input.permissions.length > 100) throw new UserAccessInputError("Permissões inválidas.");
  const permissions = [...new Set(input.permissions.map(String))];
  for (const permission of permissions) { const [resource, action] = permission.split("."); if ((resource !== "*" && !resources.has(resource)) || !["read", "write"].includes(action)) throw new UserAccessInputError("Uma das permissões é inválida."); }
  return { name, key, description: optional(input.description, 500), permissions, active: input.active !== false };
}

export function inviteInput(value: unknown) {
  const input = record(value);
  const email = String(input.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new UserAccessInputError("E-mail inválido.");
  const expiresInDays = integer(input.expiresInDays ?? 7, 1, 30, "Validade do convite inválida.");
  return { email, name: optional(input.name, 160), roleKey: text(input.roleKey, 2, 50, "Perfil inválido."), expiresInDays };
}

export function memberInput(value: unknown) {
  const input = record(value);
  if (input.status !== "active" && input.status !== "disabled") throw new UserAccessInputError("Informe explicitamente uma situação de acesso válida.");
  return {
    membershipId: text(input.membershipId, 5, 100, "Usuário inválido."),
    roleKey: text(input.roleKey, 2, 50, "Perfil inválido."),
    status: input.status,
    jobTitle: optional(input.jobTitle, 120),
    department: optional(input.department, 120),
    phone: phone(input.phone),
    accessExpiresAt: dateOrNull(input.accessExpiresAt),
    branchAccesses: input.branchAccesses === undefined ? undefined : branchGrants(input.branchAccesses),
  };
}

export function memberIds(value: unknown) {
  const input = record(value);
  if (!Array.isArray(input.membershipIds) || !input.membershipIds.length || input.membershipIds.length > 100) throw new UserAccessInputError("Selecione entre 1 e 100 usuários.");
  return [...new Set(input.membershipIds.map(item => text(item, 5, 100, "Usuário inválido.")))];
}

export function roleId(value: unknown) {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new UserAccessInputError("Perfil inválido.");
  return result;
}

export function identifier(value: unknown, label = "Registro inválido.") { return text(value, 5, 100, label); }
export function inviteHash(token: string) { return createHash("sha256").update(token).digest("hex"); }

function record(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserAccessInputError("Dados de acesso inválidos."); return value as Record<string, unknown>; }
function text(value: unknown, min: number, max: number, message: string) { const result = String(value || "").trim(); if (result.length < min || result.length > max) throw new UserAccessInputError(message); return result; }
function optional(value: unknown, max: number) { const result = String(value || "").trim(); if (result.length > max) throw new UserAccessInputError("Campo excede o tamanho permitido."); return result || null; }
function integer(value: unknown, min: number, max: number, message: string) { const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new UserAccessInputError(message); return result; }
function phone(value: unknown) { const result = optional(value, 30); if (result && !/^[+()\d\s.-]{8,30}$/.test(result)) throw new UserAccessInputError("Telefone inválido."); return result; }
function dateOrNull(value: unknown) { if (value === undefined || value === null || value === "") return null; const result = new Date(String(value)); if (Number.isNaN(result.getTime())) throw new UserAccessInputError("Validade do acesso inválida."); return result; }
function branchGrants(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new UserAccessInputError("Escopos por filial inválidos.");
  const seen = new Set<number>();
  const grants = value.map(item => {
    const input = record(item), branchId = integer(input.branchId, 1, Number.MAX_SAFE_INTEGER, "Filial inválida.");
    if (seen.has(branchId)) throw new UserAccessInputError("Uma filial foi informada mais de uma vez.");
    seen.add(branchId);
    return { branchId, canSell: input.canSell === true, canManageStock: input.canManageStock === true, canIssueFiscal: input.canIssueFiscal === true, primary: input.primary === true };
  });
  if (grants.filter(item => item.primary).length > 1) throw new UserAccessInputError("Defina somente uma filial principal.");
  return grants;
}
