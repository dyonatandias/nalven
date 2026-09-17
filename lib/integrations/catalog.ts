export type CredentialField = {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "email" | "number" | "boolean" | "select";
  secret?: boolean;
  required?: boolean;
  options?: string[];
  placeholder?: string;
};

export type ProviderDefinition = {
  id: string;
  family:
    | "messaging"
    | "payment"
    | "fiscal"
    | "shipping"
    | "marketplace"
    | "ai"
    | "storage"
    | "crm";
  label: string;
  description: string;
  recipientType: "phone" | "email" | "none";
  authType: "api_key" | "oauth2" | "basic" | "none";
  capabilities: {
    text?: boolean;
    media?: boolean;
    template?: boolean;
    bulk?: boolean;
    inbound?: boolean;
    fiscal?: boolean;
    pixDynamic?: boolean;
    pixRefund?: boolean;
    paymentLink?: boolean;
    cardPresent?: boolean;
    tef?: boolean;
    smartPos?: boolean;
    reconciliation?: boolean;
    refund?: boolean;
    responsesApi?: boolean;
  };
  fields: CredentialField[];
  supportsTest: boolean;
  docsUrl?: string;
  priority: number;
};

type PaymentProviderInput = Pick<
  ProviderDefinition,
  "id" | "label" | "description" | "priority" | "docsUrl" | "capabilities"
> & {
  accountFields: CredentialField[];
  secretFields: Array<{ key: string; label: string; required?: boolean }>;
};

function paymentProvider(input: PaymentProviderInput): ProviderDefinition {
  return {
    id: input.id,
    family: "payment",
    label: input.label,
    description: input.description,
    recipientType: "none",
    authType: "api_key",
    capabilities: input.capabilities,
    supportsTest: true,
    docsUrl: input.docsUrl,
    priority: input.priority,
    fields: [
      {
        key: "environment",
        label: "Ambiente",
        type: "select",
        options: ["sandbox", "production"],
        required: true,
      },
      { key: "base_url", label: "URL base do produto contratado", type: "url" },
      ...input.accountFields,
      ...input.secretFields.map((field) => ({
        ...field,
        type: "password" as const,
        secret: true,
      })),
    ],
  };
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "smtp",
    family: "messaging",
    label: "SMTP",
    description: "Servidor próprio para e-mail transacional.",
    recipientType: "email",
    authType: "basic",
    capabilities: { text: true, bulk: true },
    supportsTest: true,
    priority: 20,
    fields: [
      { key: "host", label: "Servidor", type: "text", required: true },
      { key: "port", label: "Porta", type: "number", required: true },
      {
        key: "encryption",
        label: "Criptografia",
        type: "select",
        options: ["none", "ssl", "tls"],
      },
      { key: "username", label: "Usuário", type: "text" },
      { key: "password", label: "Senha", type: "password", secret: true },
      {
        key: "from_email",
        label: "E-mail remetente",
        type: "email",
        required: true,
      },
      { key: "from_name", label: "Nome remetente", type: "text" },
      { key: "timeout_sec", label: "Timeout (s)", type: "number" },
    ],
  },
  {
    id: "openai",
    family: "ai",
    label: "OpenAI",
    description:
      "Responses API com conta gerenciada pela plataforma ou chave própria do tenant.",
    recipientType: "none",
    authType: "api_key",
    capabilities: { text: true, media: true, responsesApi: true },
    supportsTest: true,
    priority: 10,
    fields: [
      { key: "project_id", label: "Project ID", type: "text" },
      {
        key: "api_key",
        label: "Chave da API",
        type: "password",
        secret: true,
        required: true,
      },
      { key: "organization_id", label: "Organization ID", type: "text" },
    ],
  },
  paymentProvider({
    id: "mercado_pago",
    label: "Mercado Pago",
    description: "Pix dinâmico, link/checkout e terminais Mercado Pago Point.",
    priority: 10,
    docsUrl: "https://www.mercadopago.com.br/developers/pt/docs",
    capabilities: {
      inbound: true,
      pixDynamic: true,
      pixRefund: true,
      paymentLink: true,
      cardPresent: true,
      smartPos: true,
      reconciliation: true,
      refund: true,
    },
    accountFields: [
      { key: "user_id", label: "User ID", type: "text" },
      { key: "pos_id", label: "POS/loja padrão", type: "text" },
    ],
    secretFields: [
      { key: "access_token", label: "Access token", required: true },
      { key: "webhook_secret", label: "Segredo da assinatura do webhook" },
    ],
  }),
  paymentProvider({
    id: "banco_inter",
    label: "Banco Inter",
    description: "Cobrança Pix imediata, consulta, devolução e webhook.",
    priority: 20,
    docsUrl: "https://developers.inter.co/references/pix",
    capabilities: {
      inbound: true,
      pixDynamic: true,
      pixRefund: true,
      reconciliation: true,
      refund: true,
    },
    accountFields: [
      { key: "client_id", label: "Client ID", type: "text", required: true },
      {
        key: "pix_key",
        label: "Chave Pix recebedora",
        type: "text",
        required: true,
      },
    ],
    secretFields: [
      { key: "client_secret", label: "Client secret", required: true },
      { key: "certificate_pem", label: "Certificado mTLS PEM", required: true },
      {
        key: "private_key_pem",
        label: "Chave privada mTLS PEM",
        required: true,
      },
    ],
  }),
  paymentProvider({
    id: "cielo",
    label: "Cielo",
    description:
      "Link/checkout, Pix e soluções presenciais Cielo Smart/Conecta.",
    priority: 30,
    docsUrl: "https://docs.cielo.com.br/",
    capabilities: {
      inbound: true,
      pixDynamic: true,
      paymentLink: true,
      cardPresent: true,
      tef: true,
      smartPos: true,
      reconciliation: true,
      refund: true,
    },
    accountFields: [
      {
        key: "merchant_id",
        label: "Merchant ID",
        type: "text",
        required: true,
      },
      {
        key: "establishment_number",
        label: "Número do estabelecimento",
        type: "text",
      },
    ],
    secretFields: [
      { key: "merchant_key", label: "Merchant Key", required: true },
      { key: "client_secret", label: "Client secret" },
      { key: "webhook_secret", label: "Segredo do webhook" },
    ],
  }),
  paymentProvider({
    id: "stone",
    label: "Stone",
    description: "Crédito, débito, voucher e Pix em POS Android Stone.",
    priority: 40,
    docsUrl: "https://sdkandroid.stone.com.br/reference/bem-vindo-sdk-android",
    capabilities: {
      inbound: true,
      pixDynamic: true,
      cardPresent: true,
      tef: true,
      smartPos: true,
      reconciliation: true,
      refund: true,
    },
    accountFields: [
      { key: "stone_code", label: "Stone Code", type: "text", required: true },
      { key: "terminal_serial", label: "Terminal padrão", type: "text" },
    ],
    secretFields: [
      { key: "access_token", label: "Token de integração", required: true },
      { key: "webhook_secret", label: "Segredo do webhook" },
    ],
  }),
  paymentProvider({
    id: "pagbank",
    label: "PagBank",
    description: "Pix, links e SmartPOS PagBank em um adaptador independente.",
    priority: 50,
    docsUrl: "https://developer.pagbank.com.br/",
    capabilities: {
      inbound: true,
      pixDynamic: true,
      pixRefund: true,
      paymentLink: true,
      cardPresent: true,
      smartPos: true,
      reconciliation: true,
      refund: true,
    },
    accountFields: [{ key: "merchant_id", label: "Merchant ID", type: "text" }],
    secretFields: [
      { key: "token", label: "Token", required: true },
      { key: "webhook_secret", label: "Segredo do webhook" },
    ],
  }),
  {
    id: "fiscal_provider",
    family: "fiscal",
    label: "Provedor fiscal",
    description:
      "Conta de integração para um adapter fiscal específico. Conectividade não equivale a homologação SEFAZ.",
    recipientType: "none",
    authType: "api_key",
    capabilities: { inbound: true, fiscal: true },
    supportsTest: true,
    priority: 10,
    fields: [
      { key: "base_url", label: "URL base HTTPS", type: "url", required: true },
      {
        key: "account_id",
        label: "Conta/estabelecimento",
        type: "text",
        required: true,
      },
      {
        key: "api_key",
        label: "Chave da API",
        type: "password",
        secret: true,
        required: true,
      },
      {
        key: "callback_secret",
        label: "Segredo do callback",
        type: "password",
        secret: true,
        required: true,
      },
      {
        key: "callback_key_id",
        label: "ID da chave do callback",
        type: "text",
        required: true,
      },
      { key: "timeout_sec", label: "Timeout (s)", type: "number" },
    ],
  },
  {
    id: "shipping",
    family: "shipping",
    label: "Frete e etiquetas",
    description: "Cotação, emissão de etiquetas e rastreamento.",
    recipientType: "none",
    authType: "api_key",
    capabilities: {},
    supportsTest: true,
    priority: 10,
    fields: [
      { key: "base_url", label: "URL base", type: "url", required: true },
      {
        key: "token",
        label: "Token",
        type: "password",
        secret: true,
        required: true,
      },
      {
        key: "origin_postcode",
        label: "CEP de origem",
        type: "text",
        required: true,
      },
      {
        key: "fallback_flat_rate",
        label: "Tarifa fallback",
        type: "number",
        required: true,
      },
    ],
  },
  {
    id: "marketplace",
    family: "marketplace",
    label: "Marketplace OAuth",
    description: "Conexões OAuth multi-conta para canais de venda.",
    recipientType: "none",
    authType: "oauth2",
    capabilities: { inbound: true },
    supportsTest: true,
    priority: 10,
    fields: [
      { key: "platform", label: "Plataforma", type: "text", required: true },
      { key: "base_url", label: "URL base", type: "url", required: true },
      {
        key: "authorization_url",
        label: "URL de autorização",
        type: "url",
        required: true,
      },
      { key: "token_url", label: "URL de token", type: "url", required: true },
      { key: "client_id", label: "Client ID", type: "text", required: true },
      {
        key: "client_secret",
        label: "Client secret",
        type: "password",
        secret: true,
        required: true,
      },
      {
        key: "access_token",
        label: "Access token",
        type: "password",
        secret: true,
      },
      {
        key: "refresh_token",
        label: "Refresh token",
        type: "password",
        secret: true,
      },
    ],
  },
  {
    id: "storage_s3",
    family: "storage",
    label: "Armazenamento S3",
    description: "Offload de mídia em storage compatível com S3 e CDN.",
    recipientType: "none",
    authType: "api_key",
    capabilities: { media: true },
    supportsTest: true,
    priority: 10,
    fields: [
      { key: "endpoint", label: "Endpoint", type: "url", required: true },
      { key: "region", label: "Região", type: "text", required: true },
      { key: "bucket", label: "Bucket", type: "text", required: true },
      {
        key: "access_key",
        label: "Access key",
        type: "password",
        secret: true,
        required: true,
      },
      {
        key: "secret_key",
        label: "Secret key",
        type: "password",
        secret: true,
        required: true,
      },
      { key: "public_url_base", label: "URL pública/CDN", type: "url" },
    ],
  },
  {
    id: "crm",
    family: "crm",
    label: "CRM e marketing",
    description: "Sincronização com CRM e automações de marketing.",
    recipientType: "none",
    authType: "api_key",
    capabilities: { bulk: true, inbound: true },
    supportsTest: true,
    priority: 10,
    fields: [
      { key: "base_url", label: "URL base", type: "url", required: true },
      {
        key: "api_key",
        label: "Chave da API",
        type: "password",
        secret: true,
        required: true,
      },
    ],
  },
];

export const PROVIDER_MAP = new Map(
  PROVIDERS.map((provider) => [provider.id, provider]),
);
export const ROUTING_CONTEXTS = [
  "notification",
  "payment_link",
  "automation",
] as const;
export const OTP_CONTEXTS = new Set([
  "checkout",
  "login",
  "register",
  "password_reset",
]);
export const WEBHOOK_TOPICS = new Set([
  "order.created",
  "order.updated",
  "order.deleted",
  "order.restored",
  "product.created",
  "product.updated",
  "product.deleted",
  "product.restored",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "customer.message.requested",
  "order.status_changed",
  "payment.link_created",
  "payment.pending",
  "payment.confirmed",
  "payment.declined",
  "payment.refunded",
  "document.issued",
  "shipment.status_changed",
  "integration.delivery_status",
  "coupon.created",
  "coupon.updated",
  "coupon.deleted",
]);

export const DEFAULT_SETTINGS = {
  general: {
    default_provider: "auto",
    default_fallback: "",
    code_length: 6,
    code_expiry_sec: 600,
    allow_leading_zero: true,
    alphanumeric: false,
    max_sends_per_window: 3,
    send_window_sec: 3600,
    max_verifies_per_window: 5,
    verify_window_sec: 900,
    cooldown_between_sends_sec: 60,
    fraud: { enabled: true, suspect_threshold: 50, block_threshold: 80 },
  },
  email: {
    enabled: true,
    transport: "smtp",
  },
  smtp: {
    enabled: false,
    port: 587,
    encryption: "tls",
    timeout_sec: 30,
    auth: true,
  },
  whatsapp: {
    enabled: false,
    removed: true,
  },
  webhookOtp: {
    enabled: false,
    removed: true,
  },
  otp: Object.fromEntries(
    ["checkout", "login", "register", "password_reset"].map((context) => [
      context,
      {
        enabled: true,
        provider: "smtp",
        code_length: 6,
        code_expiry_sec: 600,
        template: "Seu código é {code}.",
      },
    ]),
  ),
  ai: {
    enabled: false,
    routing_mode: "platform",
    default_model: "gpt-5-mini",
    allowed_models: ["gpt-5-mini"],
    redact_pii: true,
    log_prompts: false,
    default_temperature: 0.7,
    max_tokens: 1000,
    reasoning_effort: "medium",
    image: {
      default_size: "auto",
      default_quality: "auto",
      default_background: "opaque",
      input_fidelity: "high",
      n: 1,
    },
    monthly_budget: 0,
    monthly_request_limit: 0,
    alert_threshold_pct: 80,
    per_feature_limits: {},
    consumers: {},
  },
  monitor: {
    enabled: null,
    interval_min: 5,
    realert_interval_min: 60,
    failure_threshold: 2,
    max_daily_alerts: 12,
    events_window: 20,
  },
  payment: {
    enabled: false,
    sandbox: true,
    supported_methods: ["pix"],
    installments_max: 1,
    capture_mode: "automatic",
  },
  shipping: {
    enabled: false,
    services: [],
    markup_pct: 0,
    markup_fixed: 0,
    cache_ttl_sec: 900,
    fallback_flat_rate: 0,
  },
  storage: {
    enabled: false,
    path_prefix: "media/",
    delete_local_after_upload: false,
    keep_local_copy_days: 30,
  },
} as const;
