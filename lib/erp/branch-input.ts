import { isValidTaxDocument, normalizeTaxDocument } from "./customer-input";
import { normalizeBusinessHours, validateBusinessHours } from "./branch-control";
import { isBrazilTimeZone } from "@/lib/timezone";

export class BranchInputError extends Error {}

export function branchInput(value: unknown) {
  const input = record(value);
  const name = required(input.name, 2, 120, "Nome da filial inválido.");
  const document = normalizeTaxDocument(input.document);
  if (document.length !== 14 || !isValidTaxDocument(document)) throw new BranchInputError("Informe um CNPJ válido.");
  const email = optional(input.email, 254)?.toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BranchInputError("E-mail inválido.");
  const managerEmail = optional(input.managerEmail, 254)?.toLowerCase();
  if (managerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) throw new BranchInputError("E-mail do responsável inválido.");
  const state = optional(input.state, 2)?.toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) throw new BranchInputError("UF inválida.");
  const zip = optional(input.zip, 10)?.replace(/\D/g, "") || null;
  if (zip && zip.length !== 8) throw new BranchInputError("CEP inválido.");
  const activityCode = optional(input.activityCode, 12)?.replace(/\D/g, "") || null;
  if (activityCode && activityCode.length !== 7) throw new BranchInputError("CNAE principal inválido.");
  const type = input.type === "headquarters" ? "headquarters" : "branch";
  const parentBranchId = type === "branch" && input.parentBranchId ? positive(input.parentBranchId, "Matriz vinculada inválida.") : null;
  const status = ["planned", "active", "inactive"].includes(String(input.status)) ? String(input.status) : "active";
  const openingDate = optionalDate(input.openingDate, "Data de início inválida.");
  const warehouseIds = Array.isArray(input.warehouseIds) ? [...new Set(input.warehouseIds.map(value => positive(value, "Depósito inválido.")))] : [];
  const defaultWarehouseId = input.defaultWarehouseId ? positive(input.defaultWarehouseId, "Depósito padrão inválido.") : null;
  if (defaultWarehouseId && !warehouseIds.includes(defaultWarehouseId)) throw new BranchInputError("O depósito padrão precisa estar vinculado à filial.");
  const productConfigurations = uniqueRecords(input.productConfigurations, "productId", "Produto duplicado na configuração da filial.").map(item => {
    const productId = positive(item.productId, "Produto inválido."), preferredWarehouseId = item.preferredWarehouseId ? positive(item.preferredWarehouseId, "Depósito preferencial inválido.") : null;
    if (preferredWarehouseId && !warehouseIds.includes(preferredWarehouseId)) throw new BranchInputError("O depósito preferencial do produto precisa estar vinculado à filial.");
    const minStock = optionalNumber(item.minStock, 0, 999999999, "Estoque mínimo inválido."), maxStock = optionalNumber(item.maxStock, 0, 999999999, "Estoque máximo inválido.");
    if (minStock !== null && maxStock !== null && maxStock < minStock) throw new BranchInputError("O estoque máximo não pode ser menor que o mínimo.");
    return { productId, active: bool(item.active), saleEnabled: bool(item.saleEnabled), purchaseEnabled: bool(item.purchaseEnabled), priceOverride: optionalNumber(item.priceOverride, 0, 999999999, "Preço da filial inválido."), costOverride: optionalNumber(item.costOverride, 0, 999999999, "Custo da filial inválido."), minStock, maxStock, reorderPoint: optionalNumber(item.reorderPoint, 0, 999999999, "Ponto de reposição inválido."), reorderQuantity: optionalNumber(item.reorderQuantity, 0, 999999999, "Quantidade de reposição inválida."), preferredWarehouseId, location: optional(item.location, 80), leadTimeDays: integer(item.leadTimeDays, 0, 365, "Prazo de reposição inválido.") };
  });
  const userAccesses = uniqueRecords(input.userAccesses, "userProfileId", "Usuário duplicado nos acessos da filial.").map(item => ({ userProfileId: positive(item.userProfileId, "Usuário inválido."), canSell: bool(item.canSell), canManageStock: bool(item.canManageStock), canIssueFiscal: bool(item.canIssueFiscal), primary: bool(item.primary) }));
  const series = (value: unknown, label: string) => { const number = Number(value || 1); if (!Number.isInteger(number) || number < 1 || number > 999) throw new BranchInputError(`${label} inválida.`); return number; };
  let businessHours;
  try { businessHours = input.businessHours === undefined ? normalizeBusinessHours(undefined) : validateBusinessHours(input.businessHours); } catch (error) { throw new BranchInputError(error instanceof Error ? error.message : "Horários de funcionamento inválidos."); }
  return {
    branch: {
      code: code(input.code || name), name, legalName: required(input.legalName, 2, 180, "Razão social inválida."), document,
      type, status, parentBranchId, openingDate, activityCode, notes: optional(input.notes, 2000), stateRegistration: optional(input.stateRegistration, 30), stateRegistrationExempt: bool(input.stateRegistrationExempt), municipalRegistration: optional(input.municipalRegistration, 30), email: email || null,
      phone: optional(input.phone, 24)?.replace(/[^\d+]/g, "") || null, managerName: optional(input.managerName, 160), managerEmail: managerEmail || null, managerPhone: optional(input.managerPhone, 24)?.replace(/[^\d+]/g, "") || null, costCenterCode: optional(input.costCenterCode, 40), zip, street: optional(input.street, 180), number: optional(input.number, 30),
      complement: optional(input.complement, 120), district: optional(input.district, 120), city: optional(input.city, 120), state: state || null, timezone: timezone(input.timezone)
    },
    settings: { taxRegime: ["simples_nacional", "lucro_presumido", "lucro_real", "mei"].includes(String(input.taxRegime)) ? String(input.taxRegime) : "simples_nacional", fiscalEnvironment: input.fiscalEnvironment === "production" ? "production" : "homologation", nfeSeries: series(input.nfeSeries, "Série da NF-e"), nfceSeries: series(input.nfceSeries, "Série da NFC-e"), nfseSeries: series(input.nfseSeries, "Série da NFS-e"), reserveStockOnOrder: bool(input.reserveStockOnOrder), allowCrossBranchFulfillment: bool(input.allowCrossBranchFulfillment), autoTransferEnabled: bool(input.autoTransferEnabled), stockAllocationStrategy: ["local_first", "lowest_cost", "highest_stock"].includes(String(input.stockAllocationStrategy)) ? String(input.stockAllocationStrategy) : "local_first", salesEnabled: boolDefaultTrue(input.salesEnabled), purchasesEnabled: boolDefaultTrue(input.purchasesEnabled), stockEnabled: boolDefaultTrue(input.stockEnabled), fiscalEnabled: boolDefaultTrue(input.fiscalEnabled), servicesEnabled: boolDefaultTrue(input.servicesEnabled), businessHours },
    warehouseIds, defaultWarehouseId, productConfigurations, userAccesses,
    expectedVersion: input.expectedVersion === undefined ? null : positive(input.expectedVersion, "Versão da filial inválida.")
  };
}

export function branchId(value: unknown) { return positive(value, "Filial inválida."); }
function record(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new BranchInputError("Dados da filial inválidos."); return value as Record<string, unknown>; }
function required(value: unknown, min: number, max: number, message: string) { const text = String(value || "").trim(); if (text.length < min || text.length > max) throw new BranchInputError(message); return text; }
function optional(value: unknown, max: number) { const text = String(value || "").trim(); if (text.length > max) throw new BranchInputError("Campo excede o tamanho permitido."); return text || null; }
function positive(value: unknown, message: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new BranchInputError(message); return id; }
function integer(value: unknown, min: number, max: number, message: string) { const number = Number(value || 0); if (!Number.isInteger(number) || number < min || number > max) throw new BranchInputError(message); return number; }
function optionalNumber(value: unknown, min: number, max: number, message: string) { if (value === undefined || value === null || value === "") return null; const number = Number(value); if (!Number.isFinite(number) || number < min || number > max) throw new BranchInputError(message); return number; }
function bool(value: unknown) { return value === true || value === "true" || value === "on" || value === 1; }
function boolDefaultTrue(value: unknown) { return value === undefined ? true : bool(value); }
function uniqueRecords(value: unknown, key: string, message: string) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new BranchInputError("Lista de vínculos inválida."); const records = value.map(record), ids = records.map(item => String(item[key] ?? "")); if (new Set(ids).size !== ids.length) throw new BranchInputError(message); return records; }
function code(value: unknown) { const result = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30); if (result.length < 2) throw new BranchInputError("Código inválido."); return result; }
function timezone(value: unknown) { const result = String(value || "America/Sao_Paulo"); if (!isBrazilTimeZone(result)) throw new BranchInputError("Selecione um fuso horário brasileiro válido."); return result; }
function optionalDate(value: unknown, message: string) { if (value === undefined || value === null || value === "") return null; const text = String(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BranchInputError(message); const date = new Date(`${text}T00:00:00.000Z`); if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text) throw new BranchInputError(message); return date; }
