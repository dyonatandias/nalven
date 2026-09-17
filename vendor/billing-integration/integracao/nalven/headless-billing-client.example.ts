/**
 * Exemplo servidor-a-servidor. Nunca importe este cliente no bundle do navegador.
 * O segredo `skp_nalven_...` deve vir do cofre do backend NALVEN.
 */

export interface HeadlessCustomerInput {
  external_id: string
  razao_social: string
  nome_fantasia?: string
  tipo_pessoa: 'PF' | 'PJ'
  documento: string
  inscricao_estadual?: string
  responsavel: { nome: string; email: string; telefone: string; cpf?: string }
  endereco?: {
    cep?: string
    logradouro?: string
    numero?: string
    complemento?: string
    bairro?: string
    cidade?: string
    estado?: string
  }
  plano_codigo: 'essencial' | 'profissional' | 'omnichannel'
  forma_pagamento: 'pix' | 'boleto' | 'cartao'
  modulos: string[]
  dia_vencimento?: number
  tenant: {
    nome: string
    url?: string
    ambiente: 'local' | 'sandbox' | 'homologacao' | 'producao'
    versao?: string
    metadata?: Record<string, unknown>
  }
}

interface BillingEnvelope<T> {
  success: boolean
  data?: T
  error?: string
  request_id?: string
}

export class BillingHeadlessClient {
  constructor(
    private readonly baseUrl = process.env.BILLING_HEADLESS_BASE_URL ||
      'https://sistema.agenciaexpresso.com.br/api/v1/saas',
    private readonly apiKey = process.env.NALVEN_PRODUCT_API_KEY || ''
  ) {
    if (!this.apiKey) throw new Error('NALVEN_PRODUCT_API_KEY não configurada')
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    idempotencyKey?: string
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...init.headers
      },
      signal: init.signal || AbortSignal.timeout(10_000),
      cache: 'no-store'
    })
    const payload = await response.json() as BillingEnvelope<T>
    if (!response.ok || !payload.success || payload.data === undefined) {
      const error = new Error(payload.error || `Billing HTTP ${response.status}`)
      Object.assign(error, { status: response.status, requestId: payload.request_id })
      throw error
    }
    return payload.data
  }

  private async requestBinary(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...init.headers
      },
      signal: init.signal || AbortSignal.timeout(15_000),
      cache: 'no-store'
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as BillingEnvelope<unknown> | null
      throw new Error(payload?.error || `Billing HTTP ${response.status}`)
    }
    return response
  }

  catalog() {
    return this.request<Record<string, unknown>>('/catalogo')
  }

  paymentConfig() {
    return this.request<Record<string, unknown>>('/payment-config')
  }

  createCustomer(input: HeadlessCustomerInput, commandId: string) {
    return this.request<Record<string, unknown>>('/clientes', {
      method: 'POST', body: JSON.stringify(input)
    }, `nalven:${input.external_id}:customer:${commandId}`)
  }

  getCustomer(externalId: string) {
    return this.request<Record<string, unknown>>(`/clientes/${encodeURIComponent(externalId)}`)
  }

  updateCustomer(externalId: string, input: Record<string, unknown>, commandId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      `nalven:${externalId}:customer-update:${commandId}`
    )
  }

  listCustomers(cursor = '0', updatedSince?: string) {
    const params = new URLSearchParams({ cursor, limit: '100' })
    if (updatedSince) params.set('updated_since', updatedSince)
    return this.request<{ items: unknown[]; next_cursor: string | null; has_more: boolean }>(
      `/clientes?${params}`
    )
  }

  updateSubscription(
    externalId: string,
    input: { plano_codigo: string; forma_pagamento: string; modulos: string[]; dia_vencimento?: number },
    commandId: string
  ) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/assinatura`,
      { method: 'PUT', body: JSON.stringify(input) },
      `nalven:${externalId}:subscription:${commandId}`
    )
  }

  subscription(externalId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/assinatura`
    )
  }

  subscriptionAction(
    externalId: string,
    action: 'suspender' | 'reativar' | 'cancelar',
    reason: string | undefined,
    commandId: string
  ) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/assinatura/acoes`,
      { method: 'POST', body: JSON.stringify({ acao: action, motivo: reason }) },
      `nalven:${externalId}:subscription-action:${commandId}`
    )
  }

  portal(externalId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/portal`
    )
  }

  invoices(externalId: string, status?: string) {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : ''
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/faturas${suffix}`
    )
  }

  invoice(externalId: string, invoiceId: number) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/faturas/${invoiceId}`
    )
  }

  createCharge(
    externalId: string,
    invoiceId: number,
    input: Record<string, unknown>,
    commandId: string
  ) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/faturas/${invoiceId}/cobrancas`,
      { method: 'POST', body: JSON.stringify(input) },
      `nalven:${externalId}:invoice:${invoiceId}:charge:${commandId}`
    )
  }

  boletoPdf(externalId: string, invoiceId: number) {
    return this.requestBinary(
      `/clientes/${encodeURIComponent(externalId)}/faturas/${invoiceId}/boleto`
    )
  }

  fiscalDocuments(externalId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/documentos-fiscais`
    )
  }

  fiscalDocument(externalId: string, token: string, type: 'danfse' | 'xml') {
    return this.requestBinary(
      `/clientes/${encodeURIComponent(externalId)}/documentos-fiscais/${token}/download?tipo=${type}`
    )
  }

  contracts(externalId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/contratos`
    )
  }

  contract(externalId: string, token: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/contratos/${token}`
    )
  }

  contractPdf(externalId: string, token: string) {
    return this.requestBinary(
      `/clientes/${encodeURIComponent(externalId)}/contratos/${token}/pdf`
    )
  }

  requestContractOtp(externalId: string, token: string, commandId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/contratos/${token}/otp`,
      { method: 'POST', body: '{}' },
      `nalven:${externalId}:contract:${token}:otp:${commandId}`
    )
  }

  signContract(externalId: string, token: string, otp: string, commandId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/contratos/${token}/assinar`,
      { method: 'POST', body: JSON.stringify({ codigo_otp: otp, aceite_termos: true }) },
      `nalven:${externalId}:contract:${token}:sign:${commandId}`
    )
  }

  tickets(externalId: string, status?: string) {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : ''
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/tickets${suffix}`
    )
  }

  createTicket(externalId: string, input: Record<string, unknown>, commandId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/tickets`,
      { method: 'POST', body: JSON.stringify(input) },
      `nalven:${externalId}:ticket:${commandId}`
    )
  }

  ticket(externalId: string, token: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/tickets/${token}`
    )
  }

  replyTicket(externalId: string, token: string, message: string, commandId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/tickets/${token}`,
      { method: 'POST', body: JSON.stringify({ mensagem: message }) },
      `nalven:${externalId}:ticket:${token}:reply:${commandId}`
    )
  }

  uploadTicketAttachment(
    externalId: string,
    token: string,
    messageId: number,
    file: Blob,
    filename: string,
    commandId: string
  ) {
    const form = new FormData()
    form.set('mensagem_id', String(messageId))
    form.set('file', file, filename)
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/tickets/${token}/anexos`,
      { method: 'POST', body: form },
      `nalven:${externalId}:ticket:${token}:attachment:${commandId}`
    )
  }

  ticketAttachment(externalId: string, token: string, attachmentId: number) {
    return this.requestBinary(
      `/clientes/${encodeURIComponent(externalId)}/tickets/${token}/anexos?anexo_id=${attachmentId}`
    )
  }

  license(externalId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/licenca`
    )
  }

  rotateLicense(externalId: string, commandId: string) {
    return this.request<Record<string, unknown>>(
      `/clientes/${encodeURIComponent(externalId)}/licenca/rotacionar-chave`,
      { method: 'POST', body: '{}' },
      `nalven:${externalId}:license-rotate:${commandId}`
    )
  }
}
