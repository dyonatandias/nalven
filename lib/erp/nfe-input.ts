export class NfeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NfeInputError";
  }
}

const XML_MAX_BYTES = 5_000_000;
const ITEM_LIMIT = 2_000;

export function parseNfeXml(value: unknown) {
  if (typeof value !== "string") throw new NfeInputError("Informe um arquivo XML de NF-e válido.");
  const xml = value.trim();
  const xmlBytes = Buffer.byteLength(xml, "utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new NfeInputError("XML com entidades externas não é permitido.");
  if (!xml.startsWith("<") || xmlBytes < 100 || xmlBytes > XML_MAX_BYTES) throw new NfeInputError("XML da NF-e inválido ou excede 5 MB.");
  const accessKey = match(xml, /<(?:\w+:)?infNFe[^>]*\bId=["']NFe(\d{44})["']/i) || match(xml, /<(?:\w+:)?chNFe>(\d{44})<\//i);
  if (!validAccessKey(accessKey)) throw new NfeInputError("Chave de acesso da NF-e ausente ou inválida.");

  const emit = block(xml, "emit"), dest = block(xml, "dest"), ide = block(xml, "ide"), totalBlock = block(xml, "ICMSTot");
  const supplierDocument = match(emit, /<(?:\w+:)?CNPJ>(\d{14})<\//i);
  if (!validCnpj(supplierDocument)) throw new NfeInputError("CNPJ do emitente ausente ou inválido.");
  const supplierName = boundedText(text(emit, "xNome"), 2, 200, "Razão social do emitente inválida.");
  const recipientDocument = (text(dest, "CNPJ") || text(dest, "CPF")).replace(/\D/g, "");
  if (recipientDocument && !validTaxDocument(recipientDocument)) throw new NfeInputError("Documento do destinatário inválido.");
  const number = numericText(text(ide, "nNF"), 1, 9, "Número da NF-e inválido.");
  const series = numericText(text(ide, "serie"), 1, 3, "Série da NF-e inválida.");
  const rows = [...xml.matchAll(/<(?:\w+:)?det\b[^>]*\bnItem=["'](\d+)["'][^>]*>([\s\S]*?)<\/(?:\w+:)?det>/gi)];
  if (!rows.length) throw new NfeInputError("A NF-e não possui itens comerciais.");
  if (rows.length > ITEM_LIMIT) throw new NfeInputError(`A NF-e excede o limite de ${ITEM_LIMIT} itens.`);
  const itemNumbers = new Set<number>();
  const items = rows.map((row) => {
    const itemNumber = positiveInteger(row[1], "Número de item inválido.");
    if (itemNumbers.has(itemNumber)) throw new NfeInputError("A NF-e possui números de item duplicados.");
    itemNumbers.add(itemNumber);
    const prod = block(row[2] || "", "prod");
    return {
      itemNumber,
      supplierCode: optionalBoundedText(text(prod, "cProd"), 60),
      description: boundedText(text(prod, "xProd"), 1, 500, `Descrição inválida no item ${itemNumber}.`),
      barcode: optionalCode(text(prod, "cEAN"), 8, 14),
      ncm: optionalCode(text(prod, "NCM"), 8, 8),
      cfop: optionalCode(text(prod, "CFOP"), 4, 4),
      unit: boundedText(text(prod, "uCom") || "UN", 1, 10, `Unidade inválida no item ${itemNumber}.`),
      quantity: decimal(prod, "qCom", 0.000001, 1_000_000_000),
      unitCost: decimal(prod, "vUnCom", 0, 1_000_000_000),
      total: decimal(prod, "vProd", 0, 1_000_000_000_000),
    };
  });
  const issue = text(ide, "dhEmi") || text(ide, "dEmi"), issueDate = new Date(issue);
  if (!issue || Number.isNaN(issueDate.getTime())) throw new NfeInputError("Data de emissão inválida.");
  const total = decimal(totalBlock, "vNF", 0, 1_000_000_000_000);
  const environmentCode = text(ide, "tpAmb");
  const environment = environmentCode === "1" ? "production" : environmentCode === "2" ? "homologation" : "legacy";
  const address = block(emit, "enderEmit");
  const supplierProfile = {
    tradeName: optionalBoundedText(text(emit, "xFant"), 200),
    stateRegistration: optionalBoundedText(text(emit, "IE"), 40),
    municipalRegistration: optionalBoundedText(text(emit, "IM"), 40),
    email: optionalBoundedText(text(emit, "email"), 200),
    phone: optionalBoundedText(text(address, "fone"), 30),
    address: {
      zip: optionalBoundedText(text(address, "CEP"), 10),
      street: optionalBoundedText(text(address, "xLgr"), 180),
      number: optionalBoundedText(text(address, "nro"), 30),
      complement: optionalBoundedText(text(address, "xCpl"), 120),
      district: optionalBoundedText(text(address, "xBairro"), 120),
      city: optionalBoundedText(text(address, "xMun"), 120),
      state: optionalBoundedText(text(address, "UF"), 2),
    },
  };
  return { xml, accessKey, number, series, supplierDocument, supplierName, supplierProfile, recipientDocument, issueDate, total, items, environment };
}

export function invoiceId(value: unknown) { return positiveInteger(value, "NF-e inválida."); }

export function matchItems(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > ITEM_LIMIT) throw new NfeInputError("Informe o vínculo de todos os itens.");
  const links = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new NfeInputError("Vínculo inválido.");
    const row = item as Record<string, unknown>;
    return { itemId: invoiceId(row.itemId), productId: invoiceId(row.productId) };
  });
  if (new Set(links.map((item) => item.itemId)).size !== links.length) throw new NfeInputError("Cada item da NF-e deve ser vinculado exatamente uma vez.");
  return links;
}

export function receiveInvoiceInput(value: Record<string, unknown>) {
  const warehouseId = invoiceId(value.warehouseId);
  const dueAtText = typeof value.dueAt === "string" ? value.dueAt.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueAtText)) throw new NfeInputError("Informe uma data de vencimento válida.");
  const dueAt = new Date(`${dueAtText}T12:00:00.000Z`);
  if (Number.isNaN(dueAt.getTime()) || dueAt.toISOString().slice(0, 10) !== dueAtText) throw new NfeInputError("Informe uma data de vencimento válida.");
  return { warehouseId, dueAt };
}

export function validAccessKey(value: string) {
  if (!/^\d{44}$/.test(value)) return false;
  const digits = value.slice(0, 43).split("").reverse().map(Number);
  const sum = digits.reduce((total, digit, index) => total + digit * (2 + index % 8), 0);
  const candidate = 11 - sum % 11;
  return Number(value[43]) === (candidate === 10 || candidate === 11 ? 0 : candidate);
}

export function validCnpj(value: string) {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const base = value.slice(0, 12).split("").map(Number);
  const digit = (numbers: number[], weights: number[]) => {
    const remainder = numbers.reduce((sum, number, index) => sum + number * (weights[index] || 0), 0) % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = digit([...base, first], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return value.endsWith(`${first}${second}`);
}

function validTaxDocument(value: string) {
  if (value.length === 14) return validCnpj(value);
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digit = (base: string, factor: number) => {
    let sum = 0;
    for (const character of base) { sum += Number(character) * factor--; if (factor === 1) factor = 9; }
    const result = 11 - sum % 11;
    return result > 9 ? 0 : result;
  };
  const first = digit(value.slice(0, 9), 10), second = digit(`${value.slice(0, 9)}${first}`, 11);
  return value.endsWith(`${first}${second}`);
}

function block(source: string, name: string) { return match(source, new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i")); }
function match(source: string, expression: RegExp) { return source.match(expression)?.[1]?.trim() || ""; }
function text(source: string, name: string) { return decode(match(source, new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i"))); }
function decimal(source: string, name: string, minimum: number, maximum: number) { const value = Number(text(source, name).replace(",", ".")); if (!Number.isFinite(value) || value < minimum || value > maximum) throw new NfeInputError(`Campo ${name} inválido.`); return value; }
function positiveInteger(value: unknown, message: string) { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw new NfeInputError(message); return number; }
function boundedText(value: string, minimum: number, maximum: number, message: string) { const clean = value.trim(); if (clean.length < minimum || clean.length > maximum) throw new NfeInputError(message); return clean; }
function optionalBoundedText(value: string, maximum: number) { const clean = value.trim(); if (!clean || clean === "SEM GTIN") return null; if (clean.length > maximum) throw new NfeInputError("Código de item excede o tamanho permitido."); return clean; }
function optionalCode(value: string, minimum: number, maximum: number) { const clean = value.trim(); if (!clean || clean === "SEM GTIN") return null; if (!new RegExp(`^\\d{${minimum},${maximum}}$`).test(clean)) return null; return clean; }
function numericText(value: string, minimum: number, maximum: number, message: string) { if (!new RegExp(`^\\d{${minimum},${maximum}}$`).test(value)) throw new NfeInputError(message); return value; }
function decode(value: string) { return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }
