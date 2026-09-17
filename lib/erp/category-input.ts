export class CategoryInputError extends Error {}

const CATEGORY_TYPES = ["product", "service", "both"] as const;
const CATEGORY_VISIBILITIES = ["visible", "catalog", "hidden"] as const;
const ATTRIBUTE_TYPES = ["text", "number", "select", "boolean", "date"] as const;
const MAPPING_STATUSES = ["mapped", "pending", "error"] as const;

export function categoryInput(value: unknown) {
  const input = record(value, "Dados da categoria");
  const name = text(input.name, "Nome", 2, 100);
  const suppliedSlug = optionalText(input.slug, "Slug", 100);
  const slug = suppliedSlug ? slugValue(suppliedSlug) : slugValue(name);
  const rawCode = optionalText(input.code, "Código", 40);
  const code = rawCode ? rawCode.toUpperCase().replace(/\s+/g, "-") : null;
  if (code && !/^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(code)) throw new CategoryInputError("Código deve usar letras, números, ponto, hífen, barra ou sublinhado.");
  const color = String(input.color || "#168151").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new CategoryInputError("Cor inválida.");
  return {
    name,
    slug,
    code,
    description: optionalText(input.description, "Descrição", 1_000),
    type: choice(input.type ?? "both", CATEGORY_TYPES, "Aplicação"),
    color: color.toLowerCase(),
    active: input.active !== false,
    visibility: choice(input.visibility ?? "visible", CATEGORY_VISIBILITIES, "Visibilidade"),
    menuOrder: integer(input.menuOrder ?? 0, "Ordem", 0, 999_999),
    seoTitle: optionalText(input.seoTitle, "Título de SEO", 70),
    seoDescription: optionalText(input.seoDescription, "Descrição de SEO", 180),
    seoNoindex: input.seoNoindex === true,
    parentId: nullableId(input.parentId, "Categoria superior"),
  };
}

export function categoryAttributeInput(value: unknown) {
  const input = record(value, "Atributo");
  const type = choice(input.type ?? "text", ATTRIBUTE_TYPES, "Tipo do atributo");
  const options = arrayText(input.options, "Opções", 30, 80);
  if (type === "select" && options.length < 1) throw new CategoryInputError("Atributos de seleção precisam de ao menos uma opção.");
  if (type !== "select" && options.length) throw new CategoryInputError("Opções são permitidas somente em atributos de seleção.");
  return {
    name: text(input.name, "Nome do atributo", 2, 100),
    type,
    required: input.required === true,
    options,
    unit: optionalText(input.unit, "Unidade", 20),
    sortOrder: integer(input.sortOrder ?? 0, "Ordem", 0, 999_999),
    active: input.active !== false,
  };
}

export function categoryMappingInput(value: unknown) {
  const input = record(value, "Mapeamento");
  return {
    platform: codeValue(input.platform, "Canal", 2, 40),
    remoteCategoryId: text(input.remoteCategoryId, "ID remoto", 1, 120),
    remoteCategoryName: optionalText(input.remoteCategoryName, "Categoria remota", 160),
    status: choice(input.status ?? "mapped", MAPPING_STATUSES, "Situação do mapeamento"),
  };
}

export function categoryIds(value: unknown, label = "Categorias") {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new CategoryInputError(`${label}: selecione entre 1 e 200 registros.`);
  const ids = value.map((item) => entityId(item, "Categoria"));
  if (new Set(ids).size !== ids.length) throw new CategoryInputError("Há categorias repetidas na seleção.");
  return ids;
}

export function entityId(value: unknown, label = "Categoria") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new CategoryInputError(`${label} inválida.`);
  return id;
}

export function categoryVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 2_147_483_646) throw new CategoryInputError("Versão da categoria inválida. Atualize a página.");
  return version;
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CategoryInputError(`${label} inválidos.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, min: number, max: number) {
  const result = String(value ?? "").trim();
  if (result.length < min || result.length > max) throw new CategoryInputError(`${label} deve ter entre ${min} e ${max} caracteres.`);
  return result;
}

function optionalText(value: unknown, label: string, max: number) {
  const result = String(value ?? "").trim();
  if (result.length > max) throw new CategoryInputError(`${label} excede ${max} caracteres.`);
  return result || null;
}

function nullableId(value: unknown, label: string) {
  return value == null || value === "" ? null : entityId(value, label);
}

function integer(value: unknown, label: string, min: number, max: number) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new CategoryInputError(`${label} inválida.`);
  return result;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const result = String(value);
  if (!allowed.includes(result as T)) throw new CategoryInputError(`${label} inválida.`);
  return result as T;
}

function slugValue(value: string) {
  const result = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  if (result.length < 2) throw new CategoryInputError("Slug inválido.");
  return result;
}

function codeValue(value: unknown, label: string, min: number, max: number) {
  const result = text(value, label, min, max).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  if (result.length < min) throw new CategoryInputError(`${label} inválido.`);
  return result;
}

function arrayText(value: unknown, label: string, maximumItems: number, maximumLength: number) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const items = raw.map((item) => String(item).trim()).filter(Boolean);
  if (items.length > maximumItems || items.some((item) => item.length > maximumLength)) throw new CategoryInputError(`${label} inválidas.`);
  const unique = [...new Set(items)];
  if (unique.length !== items.length) throw new CategoryInputError(`${label} contêm valores repetidos.`);
  return unique;
}
