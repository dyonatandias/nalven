import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BillingWebhookEnvelope } from './types'

export interface WebhookPersistence {
  hasProcessed(webhookId: string): Promise<boolean>
  persistAndApply(webhookId: string, event: BillingWebhookEnvelope): Promise<void>
}

function expectedSignature(rawBody: Buffer, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

export function verifyBillingSignature(rawBody: Buffer, received: string, secret: string) {
  if (!received.startsWith('sha256=') || !secret) return false
  const expected = Buffer.from(expectedSignature(rawBody, secret), 'utf8')
  const actual = Buffer.from(received, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export async function handleBillingWebhook(input: {
  rawBody: Buffer
  signature: string
  webhookId: string
  secret: string
  persistence: WebhookPersistence
}) {
  if (!verifyBillingSignature(input.rawBody, input.signature, input.secret)) {
    return { status: 401, body: { success: false, error: 'Assinatura inválida' } }
  }
  if (!input.webhookId) {
    return { status: 400, body: { success: false, error: 'X-Webhook-Id ausente' } }
  }
  if (await input.persistence.hasProcessed(input.webhookId)) {
    return { status: 200, body: { success: true, duplicate: true } }
  }

  let event: BillingWebhookEnvelope
  try {
    event = JSON.parse(input.rawBody.toString('utf8')) as BillingWebhookEnvelope
  } catch {
    return { status: 400, body: { success: false, error: 'JSON inválido' } }
  }

  if (!event.event || !event.instance_id || !event.ocorrido_em) {
    return { status: 400, body: { success: false, error: 'Envelope incompleto' } }
  }

  // A transação deve gravar o webhookId e aplicar o evento de forma atômica.
  await input.persistence.persistAndApply(input.webhookId, event)

  const invalidatesLicense = [
    'plano.alterado',
    'limites.atualizados',
    'assinatura.atualizada',
    'assinatura.suspensa',
    'assinatura.reativada',
    'assinatura.cancelada'
  ].includes(event.event)

  return { status: 200, body: { success: true, invalidatesLicense } }
}
