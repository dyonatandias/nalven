# Cobrança, suporte e webhooks

## Portal central e API headless

O cliente acessa `https://sistema.agenciaexpresso.com.br/cliente` para:

- visualizar e assinar contratos;
- baixar o PDF assinado e documentos fiscais;
- consultar assinatura, plano e licença;
- ver faturas e emitir Pix/boleto disponíveis;
- pagar por cartão quando o gateway estiver habilitado;
- atualizar dados da conta e senha;
- abrir ticket, responder, anexar arquivos e avaliar o atendimento;
- acompanhar projetos e entregas visíveis.

O NALVEN pode manter sua própria interface consumindo `/api/v1/saas/clientes/{external_id}/portal` e as rotas específicas descritas em `INTEGRACAO-HEADLESS-PARIDADE-TOTAL.md`. O portal central permanece como contingência administrativa. O NALVEN não guarda dados bancários nem cria cobrança fora do Billing.

## Banco Inter e cartão

O Billing possui fluxo de cobrança e conciliação do Banco Inter para Pix e boleto. A disponibilidade para uma fatura depende da configuração ativa do Inter, dos dados do pagador e da política da assinatura. Cartão usa o gateway de cartão configurado no Billing; não presuma que estará habilitado em todos os ambientes.

Antes do go-live, validar em homologação:

1. emissão de Pix e cópia do código;
2. emissão e download do boleto;
3. baixa por webhook e conciliação;
4. pagamento por cartão, se ofertado;
5. NFS-e após o evento financeiro correto;
6. reativação da licença após pagamento.

## Webhook de saída

O Billing envia `POST` com JSON e os cabeçalhos:

```http
Content-Type: application/json
X-Billing-Signature: sha256=<hmac-do-corpo-bruto>
X-Webhook-Source: billing-system
X-Webhook-Event: assinatura.suspensa
X-Webhook-Id: 12345
X-Correlation-Id: assinatura-987
```

A assinatura é `HMAC-SHA256(secret, rawBody)`. Compare em tempo constante antes de interpretar o JSON. O segredo fica cifrado no cofre multi-produto do Billing e no cofre do NALVEN; referências `env:...` existem apenas para compatibilidade legada.

Destino de produção cadastrado:

```text
https://nalven.com.br/api/webhooks/billing
```

A conexão de health check está ativa. O receptor recusou uma assinatura adulterada com `401` em 26/08/2026. A assinatura de eventos permanece pausada até o mesmo segredo ser importado nos dois cofres, os fingerprints coincidirem e o teste assinado ser aprovado.

Payload-base:

```json
{
  "event": "assinatura.suspensa",
  "cliente_id": 44,
  "instance_id": "tenant-scalon-modas",
  "produto_id": 10,
  "instalacao_id": 321,
  "correlation_id": "assinatura-987",
  "ocorrido_em": "2026-08-25T12:00:00.000Z"
}
```

Campos adicionais variam por evento. O receptor deve ignorar campos desconhecidos.

## Eventos de interesse

- `cliente.criado`, `cliente.atualizado`;
- `assinatura.atualizada`, `assinatura.suspensa`, `assinatura.reativada`, `assinatura.cancelada`;
- `fatura.paga`, `fatura.vencida`;
- `cobranca.criada`, `cobranca.emitida`, `cobranca.falhou`;
- `pagamento.confirmado`, `pagamento.estornado`;
- `nfse.autorizada`, `nfse.rejeitada`, `nfse.cancelada`.

Ao alterar módulos, `assinatura.atualizada` informa o motivo, a forma de pagamento, o novo valor mensal e os códigos dos adicionais. O receptor deve invalidar seu cache e consultar a licença; o payload do webhook não substitui os entitlements.

Assine somente os eventos necessários. A assinatura deve estar vinculada ao produto NALVEN para evitar eventos de outros produtos.

A assinatura de produção cadastrada consome os 16 eventos devolvidos no handoff: `cliente.criado`, `cliente.atualizado`, quatro eventos de assinatura, duas situações de fatura, três eventos de cobrança, dois de pagamento e três de NFS-e.

## Idempotência e retry

- Use `X-Webhook-Id` como chave de deduplicação.
- Responda `2xx` somente depois de persistir o evento ou sua chave.
- Processamento repetido deve produzir o mesmo estado.
- `410` desativa definitivamente a tentativa; outros erros entram em retentativa.
- O Billing usa outbox e backoff aproximado de 1, 5, 15 e 60 minutos, depois 6 e 24 horas, limitado pela configuração do destino.
- Nunca dependa apenas de webhook para autorização: a API de licença é a verificação final.

## APIs externas legadas

As rotas `/api/external/*` ainda usam `clientes.delivery_instance_id` e chaves do Delivery. Elas **não fazem parte do contrato NALVEN**. O NALVEN usa a API multiproduto `/api/v1/saas/*`, credencial por produto e `/api/v1/licencas/*` para runtime. Não reutilize `EXTERNAL_API_KEY` nem exponha `skp_nalven_...` no frontend.
