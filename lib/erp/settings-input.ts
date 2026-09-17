import { isBrazilTimeZone } from "@/lib/timezone";

export class SettingsInputError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export const SETTINGS_FIELD_LABELS = {
  organizationName: "Nome da organização",
  tradeName: "Nome fantasia",
  locale: "Idioma",
  currency: "Moeda",
  timezone: "Fuso horário",
  defaultPaymentMethod: "Pagamento padrão",
  defaultCustomerName: "Cliente padrão",
  requireCustomer: "Identificação obrigatória do cliente",
  lowStockAlerts: "Alertas de estoque baixo",
  operationalEmail: "E-mail operacional",
  dailySummary: "Resumo diário",
  notifyLowStock: "Notificação de estoque baixo",
  auditRetentionDays: "Retenção da auditoria",
  logoMediaId: "Logotipo",
  accentColor: "Cor principal",
  interfaceDensity: "Densidade da interface",
  defaultSidebarMode: "Menu lateral padrão",
  operationalPhone: "Telefone operacional",
  autoGenerateSku: "Geração automática de SKU",
  allowNegativeStock: "Estoque negativo",
  quoteValidityDays: "Validade dos orçamentos",
  maxDiscountPercent: "Desconto máximo",
  posCloseToleranceCents: "Tolerância de fechamento",
  dailySummaryTime: "Horário do resumo",
  notifyOverdueTitles: "Notificação de títulos vencidos",
  notifyNewSales: "Notificação de novas vendas",
  quoteFooter: "Rodapé dos orçamentos",
  receiptFooter: "Rodapé dos comprovantes",
  termsAndConditions: "Termos e condições",
  dataProtectionEmail: "E-mail do encarregado de dados",
} as const;

export type SettingsField = keyof typeof SETTINGS_FIELD_LABELS;
export type SettingsInput = ReturnType<typeof settingsInput>;
export type SettingsFacts = {
  activeBranches: number;
  branchesWithWarehouse: number;
  branchesWithFiscalSettings: number;
  productionFiscalBranches: number;
  activeFiscalCertificates: number;
  activeProfiles: number;
  expiredProfiles: number;
  activeRoles: number;
  activeIntegrations: number;
  healthyIntegrations: number;
  activeSmtpCredentials: number;
  healthySmtpCredentials: number;
  reportSettingsConfigured: boolean;
};

export type SettingsReadinessItem = {
  id: string;
  label: string;
  detail: string;
  state: "ready" | "attention" | "blocked";
  href: string;
};

const payments = new Set(["Pix", "Dinheiro", "Cartão", "Boleto"]);
const multilineFields = new Set<SettingsField>([
  "quoteFooter",
  "receiptFooter",
  "termsAndConditions",
]);

export function settingsInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SettingsInputError("Configurações inválidas.");
  const input = value as Record<string, unknown>;
  const organizationName = text(
    input.organizationName,
    2,
    160,
    "Nome da organização inválido.",
  );
  const tradeName = optional(input.tradeName, 160, "tradeName");
  const timezone = String(input.timezone || "America/Sao_Paulo");
  if (!isBrazilTimeZone(timezone))
    throw new SettingsInputError("Selecione um fuso horário brasileiro válido.");
  const defaultPaymentMethod = String(input.defaultPaymentMethod || "Pix");
  if (!payments.has(defaultPaymentMethod))
    throw new SettingsInputError("Forma de pagamento padrão inválida.");
  const operationalEmail = email(input.operationalEmail, "E-mail operacional inválido.");
  const dataProtectionEmail = email(
    input.dataProtectionEmail,
    "E-mail do encarregado de dados inválido.",
  );
  const operationalPhone = optional(input.operationalPhone, 30, "operationalPhone");
  if (operationalPhone && !/^[+\d() .-]{8,30}$/.test(operationalPhone))
    throw new SettingsInputError("Telefone operacional inválido.");
  const auditRetentionDays = integer(
    input.auditRetentionDays ?? 1825,
    365,
    3650,
    "A retenção da auditoria deve ficar entre 365 e 3.650 dias.",
  );
  const accentColor = String(input.accentColor || "#168151").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(accentColor))
    throw new SettingsInputError("Cor principal inválida.");
  const interfaceDensity = enumValue(
    input.interfaceDensity,
    ["comfortable", "compact"],
    "Densidade da interface inválida.",
  );
  const defaultSidebarMode = enumValue(
    input.defaultSidebarMode,
    ["expanded", "compact"],
    "Modo padrão do menu inválido.",
  );
  const quoteValidityDays = integer(
    input.quoteValidityDays,
    1,
    180,
    "A validade do orçamento deve ficar entre 1 e 180 dias.",
  );
  const maxDiscountPercent = decimal(
    input.maxDiscountPercent,
    0,
    100,
    "O desconto máximo deve ficar entre 0% e 100%.",
  );
  const posCloseToleranceCents = integer(
    input.posCloseToleranceCents ?? 0,
    0,
    1_000_000_000,
    "A tolerância do fechamento deve ficar entre 0 e 1 bilhão de centavos.",
  );
  const dailySummaryTime = String(input.dailySummaryTime || "18:00");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailySummaryTime))
    throw new SettingsInputError("Horário do resumo diário inválido.");
  const logoMediaId = optional(input.logoMediaId, 40, "logoMediaId");
  if (logoMediaId && !/^[a-zA-Z0-9_-]{8,40}$/.test(logoMediaId))
    throw new SettingsInputError("Logotipo inválido.");
  return {
    organizationName,
    tradeName,
    locale: "pt-BR",
    currency: "BRL",
    timezone,
    defaultPaymentMethod,
    defaultCustomerName: text(
      input.defaultCustomerName || "Consumidor final",
      2,
      160,
      "Cliente padrão inválido.",
    ),
    requireCustomer: boolean(input.requireCustomer),
    lowStockAlerts: boolean(input.lowStockAlerts),
    operationalEmail,
    dailySummary: boolean(input.dailySummary),
    notifyLowStock: boolean(input.notifyLowStock),
    auditRetentionDays,
    logoMediaId,
    accentColor,
    interfaceDensity,
    defaultSidebarMode,
    operationalPhone,
    autoGenerateSku: boolean(input.autoGenerateSku),
    allowNegativeStock: boolean(input.allowNegativeStock),
    quoteValidityDays,
    maxDiscountPercent,
    posCloseToleranceCents,
    dailySummaryTime,
    notifyOverdueTitles: boolean(input.notifyOverdueTitles),
    notifyNewSales: boolean(input.notifyNewSales),
    quoteFooter: optional(input.quoteFooter, 1000, "quoteFooter"),
    receiptFooter: optional(input.receiptFooter, 1000, "receiptFooter"),
    termsAndConditions: optional(
      input.termsAndConditions,
      5000,
      "termsAndConditions",
    ),
    dataProtectionEmail,
  };
}

export async function readSettingsJson(request: Request, maximumBytes = 32_768) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json"))
    throw new SettingsInputError("A operação aceita somente payload JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new SettingsInputError("Tamanho do payload inválido.");
    if (length > maximumBytes)
      throw new SettingsInputError("A configuração excede o limite permitido.", 413);
  }
  if (!request.body) throw new SettingsInputError("Payload ausente.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("settings payload limit exceeded");
        throw new SettingsInputError(
          "A configuração excede o limite permitido.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SettingsInputError) throw error;
    throw new SettingsInputError("JSON de configurações inválido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new SettingsInputError("O payload deve ser um objeto.");
  return parsed as Record<string, unknown>;
}

export function settingsSnapshot(value: Record<string, unknown>) {
  return Object.fromEntries(
    (Object.keys(SETTINGS_FIELD_LABELS) as SettingsField[]).map((field) => [
      field,
      value[field] ?? null,
    ]),
  ) as Record<SettingsField, unknown>;
}

export function settingsChangedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
) {
  if (!before || !after) return [];
  return (Object.keys(SETTINGS_FIELD_LABELS) as SettingsField[])
    .filter((field) => stable(before[field]) !== stable(after[field]))
    .map((field) => ({ field, label: SETTINGS_FIELD_LABELS[field] }));
}

export function settingsExport(
  value: Record<string, unknown>,
  organizationId: string,
  generatedAt = new Date(),
) {
  return `${JSON.stringify(
    {
      schema: "nalven.tenant-settings.v1",
      organizationId,
      generatedAt: generatedAt.toISOString(),
      version: value.version,
      settings: settingsSnapshot(value),
    },
    null,
    2,
  )}\n`;
}

export function buildSettingsReadiness(
  settings: SettingsInput,
  facts: SettingsFacts,
) {
  const notificationsEnabled =
    settings.dailySummary ||
    settings.notifyLowStock ||
    settings.notifyOverdueTitles ||
    settings.notifyNewSales;
  const branchReady =
    facts.activeBranches > 0 &&
    facts.branchesWithWarehouse === facts.activeBranches;
  const fiscalReady =
    facts.activeBranches > 0 &&
    facts.branchesWithFiscalSettings === facts.activeBranches &&
    (facts.productionFiscalBranches === 0 || facts.activeFiscalCertificates > 0);
  const items: SettingsReadinessItem[] = [
    {
      id: "identity",
      label: "Identidade e contato",
      state:
        settings.organizationName &&
        settings.tradeName &&
        settings.operationalEmail &&
        settings.operationalPhone
          ? "ready"
          : "attention",
      detail:
        settings.operationalEmail && settings.operationalPhone
          ? "Dados operacionais e de contato completos."
          : "Complete e-mail e telefone operacionais.",
      href: "/erp/configuracoes",
    },
    {
      id: "branches",
      label: "Filiais e depósitos",
      state: facts.activeBranches === 0 ? "blocked" : branchReady ? "ready" : "attention",
      detail:
        facts.activeBranches === 0
          ? "Nenhuma filial ativa foi encontrada."
          : `${facts.branchesWithWarehouse}/${facts.activeBranches} filiais ativas possuem depósito padrão.`,
      href: "/erp/empresas-filiais",
    },
    {
      id: "commercial",
      label: "Política comercial",
      state:
        settings.quoteValidityDays > 0 && settings.maxDiscountPercent <= 100
          ? "ready"
          : "blocked",
      detail: `${settings.quoteValidityDays} dias de validade e desconto máximo de ${settings.maxDiscountPercent}%.`,
      href: "/erp/orcamentos-pedidos",
    },
    {
      id: "notifications",
      label: "Notificações",
      state: !notificationsEnabled
        ? "attention"
        : !settings.operationalEmail || facts.activeSmtpCredentials === 0
          ? "blocked"
          : facts.healthySmtpCredentials > 0
            ? "ready"
            : "attention",
      detail: !notificationsEnabled
        ? "Nenhum evento operacional está habilitado."
        : !settings.operationalEmail
          ? "Defina o destinatário operacional."
          : facts.activeSmtpCredentials === 0
            ? "Conecte uma conta SMTP ativa para realizar os envios."
            : facts.healthySmtpCredentials > 0
              ? "Destinatário e SMTP homologado disponíveis."
              : "A conta SMTP ativa ainda precisa de teste bem-sucedido.",
      href: "/erp/emails-transacionais",
    },
    {
      id: "fiscal",
      label: "Operação fiscal",
      state: fiscalReady ? "ready" : facts.activeBranches === 0 ? "blocked" : "attention",
      detail:
        facts.productionFiscalBranches > 0 && facts.activeFiscalCertificates === 0
          ? "Filial em produção sem certificado fiscal ativo."
          : `${facts.branchesWithFiscalSettings}/${facts.activeBranches} filiais possuem política fiscal.`,
      href: "/erp/central-fiscal",
    },
    {
      id: "access",
      label: "Acesso e segregação",
      state:
        facts.activeProfiles === 0
          ? "blocked"
          : facts.expiredProfiles > 0
            ? "attention"
            : "ready",
      detail:
        facts.activeProfiles === 0
          ? "Nenhum perfil operacional ativo."
          : `${facts.activeProfiles} perfis ativos, ${facts.expiredProfiles} acessos vencidos e ${facts.activeRoles} papéis.`,
      href: "/erp/usuarios",
    },
    {
      id: "governance",
      label: "Governança e LGPD",
      state: settings.dataProtectionEmail ? "ready" : "attention",
      detail: settings.dataProtectionEmail
        ? `Auditoria preservada por ${settings.auditRetentionDays} dias e canal LGPD definido.`
        : "Defina o canal do encarregado de dados.",
      href: "/erp/privacidade-lgpd",
    },
    {
      id: "integrations",
      label: "Integrações",
      state:
        facts.activeIntegrations === 0
          ? "attention"
          : facts.healthyIntegrations > 0
            ? "ready"
            : "attention",
      detail: `${facts.activeIntegrations} conexões ativas e ${facts.healthyIntegrations} homologadas.`,
      href: "/erp/integracoes",
    },
  ];
  const weights = { ready: 1, attention: 0.5, blocked: 0 } as const;
  const score = Math.round(
    (items.reduce((total, item) => total + weights[item.state], 0) /
      items.length) *
      100,
  );
  return {
    score,
    state: items.some((item) => item.state === "blocked")
      ? ("blocked" as const)
      : items.some((item) => item.state === "attention")
        ? ("attention" as const)
        : ("ready" as const),
    ready: items.filter((item) => item.state === "ready").length,
    attention: items.filter((item) => item.state === "attention").length,
    blocked: items.filter((item) => item.state === "blocked").length,
    items,
  };
}

function text(value: unknown, min: number, max: number, message: string) {
  const result = normalize(value, false);
  if (result.length < min || result.length > max)
    throw new SettingsInputError(message);
  return result;
}

function optional(value: unknown, max: number, field: SettingsField) {
  const result = normalize(value, multilineFields.has(field));
  if (result.length > max)
    throw new SettingsInputError(
      `${SETTINGS_FIELD_LABELS[field]} excede o tamanho permitido.`,
    );
  return result || null;
}

function email(value: unknown, message: string) {
  const result = normalize(value, false).toLowerCase();
  if (result.length > 254 || (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)))
    throw new SettingsInputError(message);
  return result || null;
}

function normalize(value: unknown, multiline: boolean) {
  const result = String(value ?? "").normalize("NFC").trim();
  const disallowed = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (disallowed.test(result))
    throw new SettingsInputError("O campo contém caracteres de controle inválidos.");
  return result;
}

function boolean(value: unknown) {
  return value === true || value === "true" || value === "on" || value === 1;
}

function enumValue(value: unknown, allowed: string[], message: string) {
  const result = String(value || "");
  if (!allowed.includes(result)) throw new SettingsInputError(message);
  return result;
}

function integer(value: unknown, min: number, max: number, message: string) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max)
    throw new SettingsInputError(message);
  return result;
}

function decimal(value: unknown, min: number, max: number, message: string) {
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    Math.round(result * 100) !== result * 100
  )
    throw new SettingsInputError(message);
  return result;
}

function stable(value: unknown) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}
