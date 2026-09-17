import {
  CUSTOMER_RISKS,
  CUSTOMER_SEGMENTS,
  CustomerInputError,
} from "@/lib/erp/customer-input";

export type CustomerQuery = {
  search: string; status: string; segment: string; risk: string; attention: string;
  sort: "name" | "recent" | "credit"; page: number; limit: number; format: "json" | "csv";
};

export function parseCustomerQuery(parameters: URLSearchParams): CustomerQuery {
  const status = optionalChoice(parameters.get("status"), ["active", "inactive"]);
  const segment = optionalChoice(parameters.get("segment"), CUSTOMER_SEGMENTS);
  const risk = optionalChoice(parameters.get("risk"), CUSTOMER_RISKS);
  const attention = optionalChoice(parameters.get("attention"), ["overdue", "incomplete", "tasks"]);
  const sort = optionalChoice(parameters.get("sort"), ["name", "recent", "credit"] as const) || "name";
  const format = parameters.get("format") === "csv" ? "csv" : "json";
  return { search: String(parameters.get("search") || "").trim().slice(0, 100), status, segment, risk, attention, sort, format, page: integer(parameters.get("page"), 1, 10_000), limit: integer(parameters.get("limit"), 25, 100) };
}

export function customerHealth(customer: { email?: string | null; phone?: string | null; document?: string | null; addresses?: unknown[]; riskRating: string; status: string; overdueBalance: number; pendingTasks: number }) {
  let score = 100;
  const issues: string[] = [];
  if (!customer.email) { score -= 15; issues.push("sem e-mail"); }
  if (!customer.phone) { score -= 15; issues.push("sem telefone"); }
  if (!customer.document) { score -= 20; issues.push("sem documento"); }
  if (!customer.addresses?.length) { score -= 15; issues.push("sem endereço"); }
  if (customer.overdueBalance > 0) { score -= 25; issues.push("recebíveis vencidos"); }
  if (customer.pendingTasks > 0) { score -= 5; issues.push("tarefas pendentes"); }
  if (["high", "blocked"].includes(customer.riskRating)) { score -= 15; issues.push("risco elevado"); }
  if (customer.status === "inactive") { score -= 5; issues.push("inativo"); }
  return { score: Math.max(0, score), issues };
}

export function duplicateCustomerGroups(customers: Array<{ id: number; name: string; email: string | null; phone: string | null }>) {
  const buckets = new Map<string, Array<{ id: number; name: string }>>();
  for (const customer of customers) {
    const keys = [customer.email ? `email:${customer.email.trim().toLowerCase()}` : "", customer.phone ? `phone:${customer.phone.replace(/\D/g, "")}` : ""].filter((key) => key.length > 9);
    for (const key of keys) buckets.set(key, [...(buckets.get(key) || []), { id: customer.id, name: customer.name }]);
  }
  return [...buckets.entries()].filter(([, items]) => items.length > 1).slice(0, 20).map(([key, items]) => ({ field: key.startsWith("email:") ? "E-mail" : "Telefone", value: maskDuplicateValue(key.slice(key.indexOf(":") + 1), key.startsWith("email:")), items }));
}

export function customerCsv(items: Array<Record<string, unknown>>) {
  const headings = ["Nome", "Nome fantasia", "Tipo", "CPF/CNPJ", "E-mail", "Telefone", "Status", "Segmento", "Risco", "Responsável", "Cidade", "UF", "Limite de crédito", "Receita", "Recebíveis em aberto", "Recebíveis vencidos", "Última atualização"];
  const keys = ["name", "tradeName", "type", "document", "email", "phone", "status", "segment", "riskRating", "salesperson", "city", "state", "creditLimit", "revenue", "openBalance", "overdueBalance", "updatedAt"];
  return `\uFEFF${[headings, ...items.map((item) => keys.map((key) => item[key]))].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

export function parseCustomerCsv(source: string) {
  if (!source.trim()) throw new CustomerInputError("O arquivo CSV está vazio.");
  if (new TextEncoder().encode(source).byteLength > 2_097_152) throw new CustomerInputError("O CSV excede o limite de 2 MB.");
  const firstLine = source.split(/\r?\n/, 1)[0] || "", delimiter = occurrences(firstLine, ";") >= occurrences(firstLine, ",") ? ";" : ",";
  const table = parseDelimited(source, delimiter).filter((row) => row.some((cell) => cell.trim()));
  if (table.length < 2) throw new CustomerInputError("O CSV deve conter cabeçalho e ao menos um cliente.");
  if (table.length > 501) throw new CustomerInputError("Importe no máximo 500 clientes por arquivo.");
  const aliases: Record<string, string> = {
    nome: "name", name: "name", razao_social: "name", nome_fantasia: "tradeName", fantasia: "tradeName", trade_name: "tradeName",
    cpf_cnpj: "document", documento: "document", document: "document", email: "email", telefone: "phone", phone: "phone",
    limite_credito: "creditLimit", credit_limit: "creditLimit", segmento: "segment", segment: "segment", origem: "origin", origin: "origin",
    responsavel: "salesperson", vendedor: "salesperson", prazo_dias: "paymentTermsDays", risco: "riskRating", canal_preferencial: "preferredChannel",
    cep: "zip", logradouro: "street", rua: "street", numero: "number", complemento: "complement", bairro: "district", cidade: "city", uf: "state",
  };
  const headers = table[0].map((header) => aliases[normalizeHeader(header)] || "");
  if (!headers.includes("name") || !headers.includes("document")) throw new CustomerInputError("O CSV precisa das colunas nome e cpf_cnpj.");
  return table.slice(1).map((row, index) => {
    const item: Record<string, string> = {};
    headers.forEach((key, column) => { if (key) item[key] = String(row[column] || "").trim(); });
    return { row: index + 2, value: item };
  });
}

function optionalChoice<T extends string>(value: string | null, allowed: readonly T[]): T | "" { if (!value) return ""; if (!allowed.includes(value as T)) throw new CustomerInputError("Filtro de clientes inválido."); return value as T; }
function integer(value: string | null, fallback: number, maximum: number) { const parsed = Number(value || fallback); if (!Number.isInteger(parsed) || parsed < 1) throw new CustomerInputError("Paginação inválida."); return Math.min(parsed, maximum); }
function maskDuplicateValue(value: string, email: boolean) { if (email) { const [name, domain] = value.split("@"); return `${name.slice(0, 2)}***@${domain || ""}`; } return value.length > 4 ? `${"*".repeat(value.length - 4)}${value.slice(-4)}` : "****"; }
function csvCell(value: unknown) { const text = value instanceof Date ? value.toISOString() : String(value ?? ""); return `"${text.replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`; }
function occurrences(value: string, character: string) { return [...value].filter((item) => item === character).length; }
function normalizeHeader(value: string) { return value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }
function parseDelimited(source: string, delimiter: string) {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') { if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted; continue; }
    if (!quoted && character === delimiter) { row.push(cell); cell = ""; continue; }
    if (!quoted && (character === "\n" || character === "\r")) { if (character === "\r" && source[index + 1] === "\n") index += 1; row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += character;
  }
  if (quoted) throw new CustomerInputError("O CSV contém aspas não finalizadas.");
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
