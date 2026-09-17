/** Headless response adapters; missing remote data is never presented as a zero balance. */
export type PortalRecord = Record<string, unknown>;
export function object(value: unknown): PortalRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PortalRecord : {};
}
export function billingList(value: unknown, keys = ["items", "data", "documents"]): unknown[] {
  if (Array.isArray(value)) return value;
  const record = object(value);
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  throw new Error("Formato de coleção financeira inválido.");
}
export function detailPayload(value: unknown, resource: "contract" | "ticket" | "invoice") {
  const record = object(value);
  const detail = object(record[resource] ?? record[{contract:"contrato",ticket:"chamado",invoice:"fatura"}[resource]]);
  return Object.keys(detail).length ? {...record,...detail} : record;
}
export function displayMoney(value: unknown) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—";
}
export function safePaymentUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url=new URL(value);return url.protocol==="https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function visibleLicenseResources(value: unknown, services: boolean, marketplaces: boolean): PortalRecord[] {
  return (Array.isArray(value)?value:[]).map(object).filter(item=>item.habilitado===true && item.limite!==0 && (services || item.codigo!=="nalven_servicos_recorrencia") && (marketplaces || !["nalven_marketplaces","nalven_canais_digitais"].includes(String(item.codigo)))).map(item=>({...item,nome:item.codigo==="nalven_catalogo"&&!services?"Produtos":item.nome}));
}
export function publicPortalData(value: unknown): unknown {
  if(Array.isArray(value))return value.map(publicPortalData);
  if(value && typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:^api_?key$|^key$|^key_?prefix$|^secret$|secret_cipher|^chave(?:_prefix)?$|^license_?(?:key|secret)$|^authorization$|^responsavel_cpf$|^metadata$)/i.test(key)).map(([key,v])=>[key,publicPortalData(v)]));
  return value;
}
