import { createHash } from "node:crypto";

export const POS_ADMIN_ACTIONS = [
  "register.create",
  "register.update",
  "register.deactivate",
  "terminal.create",
  "terminal.update",
  "terminal.deactivate",
  "device.create",
  "device.update",
  "device.deactivate",
  "connector.create",
  "connector.update",
  "connector.activate",
  "connector.deactivate",
] as const;

export type PosAdminAction = (typeof POS_ADMIN_ACTIONS)[number];
export type PosAdminJson = Record<string, unknown>;

type Common = { action: PosAdminAction; idempotencyKey: string };
export type PosAdminInput =
  | (Common & {
      action: "register.create";
      branchId: number;
      warehouseId: number | null;
      code: string;
      name: string;
      settings?: PosAdminJson;
    })
  | (Common & {
      action: "register.update";
      registerId: number;
      warehouseId?: number | null;
      code?: string;
      name?: string;
      settings?: PosAdminJson;
    })
  | (Common & { action: "register.deactivate"; registerId: number })
  | (Common & {
      action: "terminal.create";
      registerId: number;
      code: string;
      name: string;
      settings?: PosAdminJson;
    })
  | (Common & {
      action: "terminal.update";
      terminalId: string;
      registerId?: number;
      code?: string;
      name?: string;
      settings?: PosAdminJson;
    })
  | (Common & { action: "terminal.deactivate"; terminalId: string })
  | (Common & {
      action: "device.create";
      terminalId: string;
      type: string;
      name: string;
      provider: string | null;
      vendorId: string | null;
      productId: string | null;
      serialNumber: string | null;
      capabilities?: PosAdminJson;
      settings?: PosAdminJson;
    })
  | (Common & {
      action: "device.update";
      deviceId: string;
      terminalId?: string;
      type?: string;
      name?: string;
      provider?: string | null;
      vendorId?: string | null;
      productId?: string | null;
      serialNumber?: string | null;
      capabilities?: PosAdminJson;
      settings?: PosAdminJson;
    })
  | (Common & { action: "device.deactivate"; deviceId: string })
  | (Common & {
      action: "connector.create";
      branchId: number;
      registerId: number | null;
      type: string;
      provider: string;
      mode: string;
      credentialRef: string | null;
      settings?: PosAdminJson;
    })
  | (Common & {
      action: "connector.update";
      connectorId: string;
      registerId?: number | null;
      type?: string;
      provider?: string;
      mode?: string;
      credentialRef?: string | null;
      settings?: PosAdminJson;
    })
  | (Common & { action: "connector.activate"; connectorId: string })
  | (Common & { action: "connector.deactivate"; connectorId: string });

export class PosAdminError extends Error {
  constructor(
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "PosAdminError";
  }
}

const common = ["action", "idempotencyKey"];

export function parsePosAdminInput(
  body: Record<string, unknown>,
): PosAdminInput {
  const action = choice(
    body.action,
    POS_ADMIN_ACTIONS,
    "Ação",
  ) as PosAdminAction;
  const idempotencyKey = key(body.idempotencyKey);
  if (action === "register.create") {
    onlyKeys(body, [
      ...common,
      "branchId",
      "warehouseId",
      "code",
      "name",
      "settings",
    ]);
    return {
      action,
      idempotencyKey,
      branchId: id(body.branchId, "Filial"),
      warehouseId: nullableId(body.warehouseId, "Depósito"),
      code: code(body.code),
      name: name(body.name),
      ...optionalJson(body, "settings"),
    };
  }
  if (action === "register.update") {
    onlyKeys(body, [
      ...common,
      "registerId",
      "warehouseId",
      "code",
      "name",
      "settings",
    ]);
    const result: PosAdminInput = {
      action,
      idempotencyKey,
      registerId: id(body.registerId, "Caixa"),
      ...(has(body, "warehouseId")
        ? { warehouseId: nullableId(body.warehouseId, "Depósito") }
        : {}),
      ...(has(body, "code") ? { code: code(body.code) } : {}),
      ...(has(body, "name") ? { name: name(body.name) } : {}),
      ...optionalJson(body, "settings"),
    };
    requirePatch(result, ["warehouseId", "code", "name", "settings"]);
    return result;
  }
  if (action === "register.deactivate") {
    onlyKeys(body, [...common, "registerId"]);
    return { action, idempotencyKey, registerId: id(body.registerId, "Caixa") };
  }
  if (action === "terminal.create") {
    onlyKeys(body, [...common, "registerId", "code", "name", "settings"]);
    return {
      action,
      idempotencyKey,
      registerId: id(body.registerId, "Caixa"),
      code: code(body.code),
      name: name(body.name),
      ...optionalJson(body, "settings"),
    };
  }
  if (action === "terminal.update") {
    onlyKeys(body, [
      ...common,
      "terminalId",
      "registerId",
      "code",
      "name",
      "settings",
    ]);
    const result: PosAdminInput = {
      action,
      idempotencyKey,
      terminalId: stringId(body.terminalId, "Terminal"),
      ...(has(body, "registerId")
        ? { registerId: id(body.registerId, "Caixa") }
        : {}),
      ...(has(body, "code") ? { code: code(body.code) } : {}),
      ...(has(body, "name") ? { name: name(body.name) } : {}),
      ...optionalJson(body, "settings"),
    };
    requirePatch(result, ["registerId", "code", "name", "settings"]);
    return result;
  }
  if (action === "terminal.deactivate") {
    onlyKeys(body, [...common, "terminalId"]);
    return {
      action,
      idempotencyKey,
      terminalId: stringId(body.terminalId, "Terminal"),
    };
  }
  if (action === "device.create") {
    onlyKeys(body, [
      ...common,
      "terminalId",
      "type",
      "name",
      "provider",
      "vendorId",
      "productId",
      "serialNumber",
      "capabilities",
      "settings",
    ]);
    return {
      action,
      idempotencyKey,
      terminalId: stringId(body.terminalId, "Terminal"),
      type: slug(body.type, "Tipo"),
      name: name(body.name),
      provider: nullableSlug(body.provider, "Provider"),
      vendorId: nullableText(body.vendorId, "Vendor ID", 100),
      productId: nullableText(body.productId, "Product ID", 100),
      serialNumber: nullableText(body.serialNumber, "Número de série", 160),
      ...optionalJson(body, "capabilities"),
      ...optionalJson(body, "settings"),
    };
  }
  if (action === "device.update") {
    onlyKeys(body, [
      ...common,
      "deviceId",
      "terminalId",
      "type",
      "name",
      "provider",
      "vendorId",
      "productId",
      "serialNumber",
      "capabilities",
      "settings",
    ]);
    const result: PosAdminInput = {
      action,
      idempotencyKey,
      deviceId: stringId(body.deviceId, "Dispositivo"),
      ...(has(body, "terminalId")
        ? { terminalId: stringId(body.terminalId, "Terminal") }
        : {}),
      ...(has(body, "type") ? { type: slug(body.type, "Tipo") } : {}),
      ...(has(body, "name") ? { name: name(body.name) } : {}),
      ...(has(body, "provider")
        ? { provider: nullableSlug(body.provider, "Provider") }
        : {}),
      ...(has(body, "vendorId")
        ? { vendorId: nullableText(body.vendorId, "Vendor ID", 100) }
        : {}),
      ...(has(body, "productId")
        ? { productId: nullableText(body.productId, "Product ID", 100) }
        : {}),
      ...(has(body, "serialNumber")
        ? {
            serialNumber: nullableText(
              body.serialNumber,
              "Número de série",
              160,
            ),
          }
        : {}),
      ...optionalJson(body, "capabilities"),
      ...optionalJson(body, "settings"),
    };
    requirePatch(result, [
      "terminalId",
      "type",
      "name",
      "provider",
      "vendorId",
      "productId",
      "serialNumber",
      "capabilities",
      "settings",
    ]);
    return result;
  }
  if (action === "device.deactivate") {
    onlyKeys(body, [...common, "deviceId"]);
    return {
      action,
      idempotencyKey,
      deviceId: stringId(body.deviceId, "Dispositivo"),
    };
  }
  if (action === "connector.create") {
    onlyKeys(body, [
      ...common,
      "branchId",
      "registerId",
      "type",
      "provider",
      "mode",
      "credentialRef",
      "settings",
    ]);
    return {
      action,
      idempotencyKey,
      branchId: id(body.branchId, "Filial"),
      registerId: nullableId(body.registerId, "Caixa"),
      type: slug(body.type, "Tipo"),
      provider: slug(body.provider, "Provider"),
      mode: connectorMode(body.mode),
      credentialRef: nullableText(
        body.credentialRef,
        "Referência da credencial",
        100,
      ),
      ...optionalJson(body, "settings"),
    };
  }
  if (action === "connector.update") {
    onlyKeys(body, [
      ...common,
      "connectorId",
      "registerId",
      "type",
      "provider",
      "mode",
      "credentialRef",
      "settings",
    ]);
    const result: PosAdminInput = {
      action,
      idempotencyKey,
      connectorId: stringId(body.connectorId, "Conector"),
      ...(has(body, "registerId")
        ? { registerId: nullableId(body.registerId, "Caixa") }
        : {}),
      ...(has(body, "type") ? { type: slug(body.type, "Tipo") } : {}),
      ...(has(body, "provider")
        ? { provider: slug(body.provider, "Provider") }
        : {}),
      ...(has(body, "mode") ? { mode: connectorMode(body.mode) } : {}),
      ...(has(body, "credentialRef")
        ? {
            credentialRef: nullableText(
              body.credentialRef,
              "Referência da credencial",
              100,
            ),
          }
        : {}),
      ...optionalJson(body, "settings"),
    };
    requirePatch(result, [
      "registerId",
      "type",
      "provider",
      "mode",
      "credentialRef",
      "settings",
    ]);
    return result;
  }
  onlyKeys(body, [...common, "connectorId"]);
  return {
    action,
    idempotencyKey,
    connectorId: stringId(body.connectorId, "Conector"),
  };
}

export function hashPosAdminInput(input: PosAdminInput) {
  const payload = { ...input } as Record<string, unknown>;
  delete payload.idempotencyKey;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function optionalJson(
  body: Record<string, unknown>,
  field: "settings" | "capabilities",
) {
  return has(body, field)
    ? {
        [field]: safeJsonObject(
          body[field],
          field === "settings" ? "Configurações" : "Capacidades",
        ),
      }
    : {};
}

function safeJsonObject(value: unknown, label: string): PosAdminJson {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PosAdminError(`${label} devem ser um objeto.`);
  inspectJson(value, label, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16_384)
    throw new PosAdminError(`${label} excedem o limite permitido.`);
  return value as PosAdminJson;
}

function inspectJson(value: unknown, label: string, depth: number): void {
  if (depth > 6)
    throw new PosAdminError(`${label} excedem a profundidade permitida.`);
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 2_048)
    throw new PosAdminError(`${label} contêm texto muito longo.`);
  if (value == null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new PosAdminError(`${label} contêm número inválido.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100)
      throw new PosAdminError(`${label} contêm uma lista muito grande.`);
    for (const item of value) inspectJson(item, label, depth + 1);
    return;
  }
  if (typeof value !== "object")
    throw new PosAdminError(`${label} contêm valor inválido.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100)
    throw new PosAdminError(`${label} contêm campos demais.`);
  for (const [field, item] of entries) {
    if (
      !field ||
      field.length > 80 ||
      ["__proto__", "prototype", "constructor"].includes(field)
    )
      throw new PosAdminError(`${label} contêm campo inválido.`);
    if (
      /(secret|token|password|passphrase|private.?key|api.?key|credential|certificate|card.?number|cvv|cvc|track.?data)/i.test(
        field,
      )
    )
      throw new PosAdminError(
        `${label} não podem conter segredos ou dados de cartão.`,
      );
    inspectJson(item, label, depth + 1);
  }
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).find((field) => !allowed.includes(field));
  if (extra) throw new PosAdminError(`Campo não permitido: ${extra}.`);
}

function requirePatch(value: object, fields: string[]) {
  if (!fields.some((field) => field in value))
    throw new PosAdminError("Informe ao menos um campo para atualizar.");
}

function key(value: unknown) {
  const result = String(value ?? "").trim();
  if (
    result.length < 16 ||
    result.length > 160 ||
    !/^[A-Za-z0-9._:-]+$/.test(result)
  )
    throw new PosAdminError("Chave de idempotência inválida.");
  return result;
}

function id(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new PosAdminError(`${label} inválido.`);
  return result;
}

function nullableId(value: unknown, label: string) {
  return value == null || value === "" ? null : id(value, label);
}
function stringId(value: unknown, label: string) {
  return text(value, label, 1, 100);
}
function name(value: unknown) {
  return text(value, "Nome", 2, 160);
}
function nullableText(value: unknown, label: string, maximum: number) {
  return value == null || value === "" ? null : text(value, label, 1, maximum);
}
function text(value: unknown, label: string, minimum: number, maximum: number) {
  const result = String(value ?? "").trim();
  if (result.length < minimum || result.length > maximum)
    throw new PosAdminError(`${label} inválido.`);
  return result;
}
function code(value: unknown) {
  const result = text(value, "Código", 1, 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(result))
    throw new PosAdminError("Código inválido.");
  return result;
}
function slug(value: unknown, label: string) {
  const result = text(value, label, 2, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result))
    throw new PosAdminError(`${label} inválido.`);
  return result;
}
function nullableSlug(value: unknown, label: string) {
  return value == null || value === "" ? null : slug(value, label);
}
function connectorMode(value: unknown) {
  return choice(
    value ?? "server",
    ["server", "local_agent", "terminal"] as const,
    "Modo",
  );
}
function choice<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] {
  const result = String(value ?? "");
  if (!choices.includes(result)) throw new PosAdminError(`${label} inválida.`);
  return result as T[number];
}
function has(value: object, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((field) => `${JSON.stringify(field)}:${canonicalJson(record[field])}`)
    .join(",")}}`;
}
