export type TransactionalEmailCatalogItem = {
  eventKey: string;
  label: string;
  category: string;
  description: string;
  critical?: boolean;
  variables: string[];
};

const BASE_VARIABLES = [
  "organization.name",
  "recipient.name",
  "action.url",
  "event.date",
];
const DOMAIN_VARIABLES: Record<string, string[]> = {
  auth: ["auth.code", "auth.expires_minutes", "auth.device", "auth.location"],
  customer: ["customer.name", "customer.document"],
  quote: ["quote.number", "quote.total", "quote.expires_at"],
  order: ["order.number", "order.status", "order.total"],
  contract: ["contract.number", "contract.renewal_at"],
  payment: ["payment.reference", "payment.amount", "payment.method"],
  receivable: ["receivable.document", "receivable.amount", "receivable.due_at"],
  payable: ["payable.document", "payable.amount", "payable.due_at"],
  cash: ["cash.session", "cash.difference"],
  reconciliation: ["reconciliation.reference", "reconciliation.difference"],
  fiscal: ["fiscal.number", "fiscal.series", "fiscal.access_key", "fiscal.status"],
  stock: ["product.name", "product.sku", "stock.available", "stock.minimum"],
  inventory: ["inventory.reference", "inventory.warehouse", "inventory.difference"],
  purchase: ["purchase.number", "purchase.supplier", "purchase.total"],
  supplier: ["supplier.name", "supplier.document"],
  shipment: ["shipment.reference", "shipment.carrier", "shipment.tracking_code", "shipment.tracking_url"],
  service: ["service.number", "service.scheduled_at", "service.status"],
  integration: ["integration.name", "integration.provider", "integration.error"],
  webhook: ["webhook.name", "webhook.topic"],
  report: ["report.name", "report.period", "report.download_url"],
  export: ["export.name", "export.download_url", "export.expires_at"],
  privacy: ["privacy.protocol", "privacy.request_type", "privacy.deadline"],
  audit: ["audit.action", "audit.actor", "audit.ip"],
};

function variablesFor(eventKey: string) {
  const domain = eventKey.split(".")[0];
  return [...BASE_VARIABLES, ...(DOMAIN_VARIABLES[domain] || [])];
}

const group = (
  category: string,
  entries: Array<[string, string, string?, boolean?]>,
): TransactionalEmailCatalogItem[] =>
  entries.map(([eventKey, label, description, critical]) => ({
    eventKey,
    label,
    category,
    description: description || label,
    critical,
    variables: variablesFor(eventKey),
  }));

export const TRANSACTIONAL_EMAIL_CATALOG: TransactionalEmailCatalogItem[] = [
  ...group("Acesso e segurança", [
    [
      "auth.email_verification",
      "Verificação de e-mail",
      "Confirma o endereço informado.",
      true,
    ],
    [
      "auth.otp",
      "Código de acesso",
      "OTP enviado exclusivamente por SMTP.",
      true,
    ],
    [
      "auth.password_reset",
      "Redefinição de senha",
      "Link de recuperação de acesso.",
      true,
    ],
    [
      "auth.password_changed",
      "Senha alterada",
      "Alerta de alteração concluída.",
      true,
    ],
    ["auth.login_alert", "Novo acesso", "Novo dispositivo ou localização."],
    [
      "auth.email_changed",
      "E-mail alterado",
      "Confirma a troca de endereço.",
      true,
    ],
    ["auth.mfa_enabled", "Autenticação adicional ativada"],
    [
      "auth.mfa_disabled",
      "Autenticação adicional desativada",
      "Alerta de segurança.",
      true,
    ],
    ["auth.invitation", "Convite de usuário"],
    [
      "auth.account_locked",
      "Conta bloqueada",
      "Bloqueio por tentativas ou risco.",
      true,
    ],
  ]),
  ...group("Comercial", [
    ["customer.welcome", "Boas-vindas do cliente"],
    ["quote.created", "Orçamento criado"],
    ["quote.updated", "Orçamento atualizado"],
    ["quote.expiring", "Orçamento próximo do vencimento"],
    ["quote.approved", "Orçamento aprovado"],
    ["quote.rejected", "Orçamento recusado"],
    ["order.created", "Pedido criado"],
    ["order.confirmed", "Pedido confirmado"],
    ["order.updated", "Pedido atualizado"],
    ["order.cancelled", "Pedido cancelado"],
    ["contract.created", "Contrato criado"],
    ["contract.renewal_due", "Renovação de contrato"],
  ]),
  ...group("Pagamentos e financeiro", [
    ["payment.pending", "Pagamento pendente"],
    ["payment.link_created", "Link de pagamento criado"],
    ["payment.approved", "Pagamento aprovado", undefined, true],
    ["payment.declined", "Pagamento recusado"],
    ["payment.expired", "Pagamento expirado"],
    ["payment.refunded", "Pagamento estornado", undefined, true],
    ["payment.chargeback", "Contestação recebida", undefined, true],
    ["receivable.due_soon", "Conta a receber próxima"],
    ["receivable.overdue", "Conta a receber vencida"],
    ["payable.due_soon", "Conta a pagar próxima"],
    [
      "cash.close_difference",
      "Diferença no fechamento de caixa",
      undefined,
      true,
    ],
    [
      "reconciliation.divergence",
      "Divergência de conciliação",
      undefined,
      true,
    ],
  ]),
  ...group("Fiscal", [
    ["fiscal.nfe_authorized", "NF-e autorizada", undefined, true],
    ["fiscal.nfe_rejected", "NF-e rejeitada", undefined, true],
    ["fiscal.nfe_cancelled", "NF-e cancelada", undefined, true],
    ["fiscal.nfce_authorized", "NFC-e autorizada"],
    ["fiscal.nfce_contingency", "NFC-e em contingência", undefined, true],
    ["fiscal.nfse_authorized", "NFS-e autorizada"],
    ["fiscal.document_available", "Documento fiscal disponível"],
    [
      "fiscal.certificate_expiring",
      "Certificado próximo do vencimento",
      undefined,
      true,
    ],
  ]),
  ...group("Estoque e suprimentos", [
    ["stock.low", "Estoque baixo"],
    ["stock.out", "Produto sem estoque", undefined, true],
    ["inventory.started", "Inventário iniciado"],
    ["inventory.divergence", "Divergência de inventário"],
    ["purchase.approval_requested", "Compra aguardando aprovação"],
    ["purchase.approved", "Compra aprovada"],
    ["purchase.received", "Compra recebida"],
    ["supplier.invitation", "Convite de fornecedor"],
  ]),
  ...group("Entrega e serviços", [
    ["shipment.ready", "Pedido pronto para envio"],
    ["shipment.dispatched", "Pedido despachado"],
    ["shipment.in_transit", "Pedido em trânsito"],
    ["shipment.delivered", "Pedido entregue"],
    ["shipment.exception", "Ocorrência na entrega", undefined, true],
    ["service.scheduled", "Serviço agendado"],
    ["service.reminder", "Lembrete de serviço"],
    ["service.completed", "Serviço concluído"],
  ]),
  ...group("Plataforma e governança", [
    ["integration.failure", "Falha de integração", undefined, true],
    ["integration.recovered", "Integração recuperada"],
    ["webhook.disabled", "Webhook desativado", undefined, true],
    ["report.ready", "Relatório disponível"],
    ["export.ready", "Exportação disponível"],
    ["privacy.request_received", "Solicitação LGPD recebida", undefined, true],
    [
      "privacy.request_completed",
      "Solicitação LGPD concluída",
      undefined,
      true,
    ],
    ["audit.suspicious_activity", "Atividade suspeita", undefined, true],
  ]),
];

export function defaultEmailContent(item: TransactionalEmailCatalogItem) {
  return {
    subject: `${item.label} · {{organization.name}}`,
    textBody: `Olá {{recipient.name}},\n\n${item.description}\n\n{{action.url}}`,
    htmlBody: `<p>Olá <strong>{{recipient.name}}</strong>,</p><p>${item.description}</p><p><a href="{{action.url}}">Ver detalhes</a></p>`,
  };
}
