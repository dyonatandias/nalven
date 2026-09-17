# API de licenciamento do NALVEN

Base de produção atual:

```text
https://sistema.agenciaexpresso.com.br/api/v1
```

Use `BILLING_BASE_URL` por ambiente. Todas as chamadas são servidor a servidor por HTTPS.

## Autenticação

```http
Authorization: License lic_SEGREDO_EMITIDO_UMA_VEZ
```

Também são aceitos `Authorization: Bearer` e `X-License-Key`. Não envie a chave no corpo ou na URL. O Billing persiste apenas SHA-256 e prefixo.

## Ativar uma instalação

```bash
curl --fail-with-body "$BILLING_BASE_URL/api/v1/licencas/ativar" \
  -H "Authorization: License $NALVEN_LICENSE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{
    "produto_codigo":"nalven",
    "instalacao_id":"tenant-scalon-modas",
    "nome":"Scalon Modas",
    "ambiente":"homologacao",
    "url":"https://scalon.hml.nalven.example",
    "versao":"0.1.0"
  }'
```

Ambientes aceitos: `local`, `sandbox`, `homologacao`, `producao`. `instalacao_id` é estável, único no produto e não deve conter dado secreto.

## Validar

```bash
curl --fail-with-body "$BILLING_BASE_URL/api/v1/licencas/validar" \
  -H "Authorization: License $NALVEN_LICENSE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"produto_codigo":"nalven","instalacao_id":"tenant-scalon-modas"}'
```

Uma resposta válida contém `licenca`, `cliente`, `produto`, `plano`, `instalacao`, `recursos`, `limites` e `servidor_em`.

## Consultar entitlements

```bash
curl --fail-with-body \
  "$BILLING_BASE_URL/api/v1/licencas/entitlements?produto_codigo=nalven&instalacao_id=tenant-scalon-modas" \
  -H "Authorization: License $NALVEN_LICENSE_KEY"
```

Exemplo reduzido:

```json
{
  "success": true,
  "valida": true,
  "produto": { "codigo": "nalven", "nome": "NALVEN" },
  "plano": { "codigo": "omnichannel", "nome": "Omnichannel" },
  "recursos": [
    { "codigo": "nalven_ecommerce", "habilitado": true, "limite": null, "origem": "plano" },
    { "codigo": "nalven_usuarios_nomeados", "habilitado": true, "limite": 15, "origem": "plano" }
  ],
  "limites": [
    { "codigo": "nalven_usuarios_nomeados", "valor": 15, "sufixo": "usuários" }
  ]
}
```

O exemplo mostra a forma do contrato; os valores reais devem sempre vir da resposta. Um adicional individual muda `recursos[].limite` e pode deixar `origem="licenca"`.

## Registrar uso

```bash
curl --fail-with-body "$BILLING_BASE_URL/api/v1/licencas/uso" \
  -H "Authorization: License $NALVEN_LICENSE_KEY" \
  -H 'Idempotency-Key: tenant-scalon-pedidos-2026-08' \
  -H 'Content-Type: application/json' \
  --data '{
    "produto_codigo":"nalven",
    "instalacao_id":"tenant-scalon-modas",
    "metrica_codigo":"nalven_pedidos_mes",
    "quantidade":347,
    "unidade":"pedidos",
    "periodo_inicio":"2026-08-01T00:00:00-03:00",
    "periodo_fim":"2026-08-31T23:59:59-03:00",
    "metadata":{"origem":"fechamento_mensal"}
  }'
```

Repetir a mesma `Idempotency-Key` e o mesmo corpo retorna a medição existente. Reutilizar a chave com conteúdo diferente retorna `409`.

## Tratamento de erro

| HTTP | Conduta |
|---|---|
| 400 | corrigir payload; não repetir sem mudança |
| 401 | credencial ausente/perdida; solicitar rotação |
| 403 | licença/tenant/produto não autorizado; aplicar bloqueio e orientar o portal |
| 409 | colisão de idempotência; não gerar nova chave silenciosamente |
| 429 | respeitar `Retry-After` |
| 5xx/rede | backoff exponencial; usar apenas cache ainda válido |

Limites atuais: 60 req/min em entitlements, 120 req/min em uso e 100 req/min por padrão em validar/ativar. As respostas usam `Cache-Control: no-store`.

## Regra de segurança no consumidor

```text
valida=false                 => negar novas operações
recurso ausente              => negar o recurso
habilitado=false             => negar o recurso
limite=0                     => recurso/cota sem capacidade
limite=null em habilitação   => recurso sem cota numérica
```

