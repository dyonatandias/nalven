import type {
  ActivateInstallationInput,
  LicenseResponse,
  UsageInput
} from './types'

export class BillingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: string | null
  ) {
    super(message)
    this.name = 'BillingApiError'
  }
}

interface ClientOptions {
  baseUrl: string
  licenseKey: string
  timeoutMs?: number
}

export class NalvenBillingClient {
  private readonly baseUrl: string
  private readonly licenseKey: string
  private readonly timeoutMs: number

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.licenseKey = options.licenseKey.trim()
    this.timeoutMs = options.timeoutMs ?? 5000

    if (!this.baseUrl.startsWith('https://')) throw new Error('BILLING_BASE_URL deve usar HTTPS')
    if (!this.licenseKey.startsWith('lic_')) throw new Error('NALVEN_LICENSE_KEY inválida')
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `License ${this.licenseKey}`,
          Accept: 'application/json',
          ...init.headers
        }
      })
      const body = await response.json() as { error?: string } & T
      if (!response.ok) {
        throw new BillingApiError(
          body.error || `Billing respondeu HTTP ${response.status}`,
          response.status,
          response.headers.get('retry-after')
        )
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  activate(input: ActivateInstallationInput) {
    return this.request<LicenseResponse>('/licencas/ativar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
  }

  validate(installationId: string) {
    return this.request<LicenseResponse>('/licencas/validar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        produto_codigo: 'nalven',
        instalacao_id: installationId
      })
    })
  }

  entitlements(installationId: string) {
    const query = new URLSearchParams({
      produto_codigo: 'nalven',
      instalacao_id: installationId
    })
    return this.request<LicenseResponse>(`/licencas/entitlements?${query}`)
  }

  reportUsage(input: UsageInput, idempotencyKey: string) {
    if (!idempotencyKey.trim()) throw new Error('Idempotency-Key é obrigatória')
    return this.request<{ success: boolean; medicao_id?: number }>('/licencas/uso', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(input)
    })
  }
}

export function hasResource(license: LicenseResponse, code: string) {
  return license.valida === true && license.recursos?.some(resource => (
    resource.codigo === code && resource.habilitado === true
  )) === true
}

export function resourceLimit(license: LicenseResponse, code: string) {
  const resource = license.recursos?.find(item => item.codigo === code)
  if (!license.valida || !resource?.habilitado) return 0
  return resource.limite
}
