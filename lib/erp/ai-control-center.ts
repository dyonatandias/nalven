export const AI_PERIODS = [7, 30, 90] as const;
export const AI_STATUSES = ["completed", "failed", "incomplete", "in_progress"] as const;
export const AI_KEY_SOURCES = ["platform", "byok"] as const;
export const AI_ROUTING_MODES = ["platform", "byok", "hybrid"] as const;
export const AI_REASONING_EFFORTS = ["low", "medium", "high"] as const;

export type AiFeatureDefinition = {
  id: string;
  label: string;
  area: string;
  description: string;
};

export const AI_FEATURE_CATALOG: AiFeatureDefinition[] = [
  {
    id: "ai.playground",
    label: "Laboratório seguro",
    area: "Plataforma",
    description: "Testes manuais controlados pela equipe administradora.",
  },
  {
    id: "dashboard.executive_insights",
    label: "Insights executivos",
    area: "Gestão",
    description: "Síntese de indicadores, desvios e prioridades do negócio.",
  },
  {
    id: "reports.narrative",
    label: "Narrativa de relatórios",
    area: "Gestão",
    description: "Explicações objetivas para relatórios e análises do ERP.",
  },
  {
    id: "crm.next_action",
    label: "Próxima ação comercial",
    area: "Comercial",
    description: "Sugestões de acompanhamento para oportunidades e clientes.",
  },
  {
    id: "catalog.description",
    label: "Descrição de produtos",
    area: "Comercial",
    description: "Rascunhos de descrições comerciais e conteúdo de catálogo.",
  },
  {
    id: "finance.anomaly",
    label: "Anomalias financeiras",
    area: "Financeiro",
    description: "Explicação assistida de variações e lançamentos atípicos.",
  },
  {
    id: "cash.forecast",
    label: "Projeção de caixa",
    area: "Financeiro",
    description: "Interpretação de cenários de liquidez e vencimentos.",
  },
  {
    id: "fiscal.review",
    label: "Revisão fiscal assistida",
    area: "Fiscal",
    description: "Apoio na leitura de rejeições e inconsistências fiscais.",
  },
  {
    id: "inventory.replenishment",
    label: "Sugestão de reposição",
    area: "Suprimentos",
    description: "Recomendações explicáveis para cobertura e reposição de estoque.",
  },
  {
    id: "purchases.quote_summary",
    label: "Resumo de cotações",
    area: "Suprimentos",
    description: "Comparação textual de propostas, prazos e condições.",
  },
  {
    id: "service.order_summary",
    label: "Resumo de ordem de serviço",
    area: "Operações",
    description: "Síntese de histórico, diagnóstico e próximos passos.",
  },
  {
    id: "support.reply_draft",
    label: "Rascunho de atendimento",
    area: "Operações",
    description: "Respostas sugeridas para revisão humana antes do envio.",
  },
];

export type AiUsageQuery = {
  days: (typeof AI_PERIODS)[number];
  page: number;
  limit: number;
  search: string;
  feature: string;
  model: string;
  status: string;
  keySource: string;
  csv: boolean;
};

export function parseAiUsageQuery(params: URLSearchParams): AiUsageQuery {
  const requestedDays = Number(params.get("days"));
  const days = AI_PERIODS.includes(requestedDays as AiUsageQuery["days"])
    ? (requestedDays as AiUsageQuery["days"])
    : 30;
  const page = clampInteger(params.get("page"), 1, 400, 1);
  const limit = clampInteger(params.get("limit"), 1, 100, 25);
  const status = limited(params.get("status"), 40);
  const keySource = limited(params.get("keySource"), 40);
  return {
    days,
    page,
    limit,
    search: limited(params.get("search"), 120),
    feature: limited(params.get("feature"), 120),
    model: limited(params.get("model"), 100),
    status: (AI_STATUSES as readonly string[]).includes(status) ? status : "",
    keySource: (AI_KEY_SOURCES as readonly string[]).includes(keySource)
      ? keySource
      : "",
    csv: params.get("format") === "csv",
  };
}

export type AiPolicy = {
  enabled: boolean;
  routing_mode: (typeof AI_ROUTING_MODES)[number];
  default_model: string;
  allowed_models: string[];
  redact_pii: boolean;
  log_prompts: false;
  max_tokens: number;
  reasoning_effort: (typeof AI_REASONING_EFFORTS)[number];
  monthly_budget: number;
  monthly_request_limit: number;
  alert_threshold_pct: number;
  per_feature_limits: Record<string, number>;
  consumers: Record<string, boolean>;
};

export function normalizeAiPolicy(
  value: unknown,
  fallback: Record<string, unknown>,
): AiPolicy {
  const source = objectValue(value);
  const merged = { ...fallback, ...source };
  const allowedModels = uniqueStrings(merged.allowed_models, 20, 100);
  const defaultModel = modelId(merged.default_model || allowedModels[0] || "gpt-5-mini");
  if (!allowedModels.length) allowedModels.push(defaultModel);
  if (!allowedModels.includes(defaultModel))
    throw new Error("O modelo padrão precisa estar na lista de modelos permitidos.");
  const routingMode = String(merged.routing_mode || "platform");
  if (!(AI_ROUTING_MODES as readonly string[]).includes(routingMode))
    throw new Error("Modo de roteamento de IA inválido.");
  const reasoningEffort = String(merged.reasoning_effort || "medium");
  if (!(AI_REASONING_EFFORTS as readonly string[]).includes(reasoningEffort))
    throw new Error("Nível de raciocínio inválido.");
  const monthlyBudget = finiteNumber(merged.monthly_budget, 0, 1_000_000_000, "Orçamento mensal");
  const monthlyRequestLimit = integer(merged.monthly_request_limit, 0, 10_000_000, "Limite mensal de requisições");
  const alertThreshold = integer(merged.alert_threshold_pct, 1, 100, "Percentual de alerta");
  const maxTokens = integer(merged.max_tokens, 1, 100_000, "Máximo de tokens de saída");
  const rawLimits = objectValue(merged.per_feature_limits);
  const rawConsumers = objectValue(merged.consumers);
  const perFeatureLimits = Object.fromEntries(
    AI_FEATURE_CATALOG.map((feature) => [
      feature.id,
      integer(rawLimits[feature.id], 0, 1_000_000, `Limite de ${feature.label}`),
    ]),
  );
  const consumers = Object.fromEntries(
    AI_FEATURE_CATALOG.map((feature) => [feature.id, rawConsumers[feature.id] !== false]),
  );
  return {
    enabled: merged.enabled === true,
    routing_mode: routingMode as AiPolicy["routing_mode"],
    default_model: defaultModel,
    allowed_models: allowedModels.map(modelId),
    redact_pii: merged.redact_pii !== false,
    log_prompts: false,
    max_tokens: maxTokens,
    reasoning_effort: reasoningEffort as AiPolicy["reasoning_effort"],
    monthly_budget: monthlyBudget,
    monthly_request_limit: monthlyRequestLimit,
    alert_threshold_pct: alertThreshold,
    per_feature_limits: perFeatureLimits,
    consumers,
  };
}

export function publicAiError(status: number) {
  if (status === 400) return "A solicitação foi recusada pelo provedor. Revise modelo e limites.";
  if (status === 401 || status === 403)
    return "A credencial de IA foi recusada. Revise a chave, o projeto e as permissões.";
  if (status === 404) return "O modelo solicitado não está disponível para esta credencial.";
  if (status === 408) return "O provedor excedeu o tempo limite da solicitação.";
  if (status === 429) return "O provedor limitou temporariamente as solicitações. Tente novamente em instantes.";
  return "O provedor de IA não concluiu a solicitação.";
}

export function aiUsageCsv(
  rows: Array<{
    id: string;
    feature: string;
    model: string;
    status: string;
    keySource: string;
    units: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    cost: number;
    createdAt: string | Date;
  }>,
) {
  const header = [
    "ID",
    "Funcionalidade",
    "Modelo",
    "Status",
    "Origem da chave",
    "Unidades",
    "Tokens de entrada",
    "Tokens de saída",
    "Latência (ms)",
    "Custo contabilizado",
    "Criado em",
  ];
  return [
    header.map(csvCell).join(","),
    ...rows.map((row) =>
      [
        row.id,
        row.feature,
        row.model,
        row.status,
        row.keySource,
        row.units,
        row.inputTokens,
        row.outputTokens,
        row.latencyMs,
        row.cost,
        new Date(row.createdAt).toISOString(),
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\r\n");
}

export function featureLabel(id: string) {
  return AI_FEATURE_CATALOG.find((item) => item.id === id)?.label || id;
}

export function statusLabel(status: string) {
  return (
    {
      completed: "Concluída",
      failed: "Falhou",
      incomplete: "Incompleta",
      in_progress: "Em processamento",
    }[status] || status
  );
}

function modelId(value: unknown) {
  const result = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._:-]{1,99}$/i.test(result))
    throw new Error("Identificador de modelo inválido.");
  return result;
}

function uniqueStrings(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, maxItems)
        .map((item) => item.slice(0, maxLength)),
    ),
  ];
}

function finiteNumber(
  value: unknown,
  min: number,
  max: number,
  label: string,
) {
  const result = Number(value ?? min);
  if (!Number.isFinite(result) || result < min || result > max)
    throw new Error(`${label} inválido.`);
  return Math.round(result * 100) / 100;
}

function integer(
  value: unknown,
  min: number,
  max: number,
  label: string,
) {
  const result = Number(value ?? min);
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error(`${label} inválido.`);
  return result;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function limited(value: unknown, max: number) {
  return String(value || "").trim().slice(0, max);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
