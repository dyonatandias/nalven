export type NalvenPlanCode = 'essencial' | 'profissional' | 'omnichannel'
export type NalvenPaymentMethod = 'pix' | 'boleto' | 'cartao'
export type NalvenEnvironment = 'local' | 'sandbox' | 'homologacao' | 'producao'

export interface BillingResource {
  codigo: string
  nome?: string
  habilitado: boolean
  limite: number | null
  origem: string
}

export interface BillingLimit {
  codigo: string
  nome?: string
  valor: number | null
  sufixo?: string | null
}

export interface LicenseResponse {
  success: boolean
  valida: boolean
  motivo?: string
  produto?: { codigo: string; nome: string; versao_atual?: string | null }
  plano?: { codigo: NalvenPlanCode; nome: string }
  instalacao?: { external_id: string; ambiente: NalvenEnvironment; status: string }
  recursos?: BillingResource[]
  limites?: BillingLimit[]
  servidor_em?: string
}

export interface ActivateInstallationInput {
  produto_codigo: 'nalven'
  instalacao_id: string
  nome: string
  ambiente: NalvenEnvironment
  url?: string
  versao?: string
}

export interface UsageInput {
  produto_codigo: 'nalven'
  instalacao_id: string
  metrica_codigo: string
  quantidade: number
  unidade: string
  periodo_inicio: string
  periodo_fim: string
  metadata?: Record<string, unknown>
}

export interface BillingWebhookEnvelope {
  event: string
  cliente_id: number
  instance_id: string
  produto_id: number
  instalacao_id?: number | null
  correlation_id?: string
  ocorrido_em: string
  [key: string]: unknown
}
