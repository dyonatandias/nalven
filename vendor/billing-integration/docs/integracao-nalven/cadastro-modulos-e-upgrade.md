# Cadastro, módulos e mudança de assinatura

## Catálogo público

Depois da homologação e publicação do produto:

```http
GET /api/public/planos?produto=nalven
```

Cada plano retorna `precos_metodo`, `modulo_ids_inclusos`, `modulos` e `recursos`. Exemplo reduzido:

```json
{
  "codigo": "essencial",
  "nome": "Essencial",
  "precos_metodo": {
    "pix": { "mensal": 149, "anual": 1490 },
    "boleto": { "mensal": 149, "anual": 1490 },
    "cartao": { "mensal": 169, "anual": 1690 }
  },
  "modulo_ids_inclusos": [101, 102, 103, 104],
  "modulos": [
    {
      "id": 105,
      "codigo": "vendas_pedidos",
      "preco_pix": 49,
      "preco_boleto": 49,
      "preco_cartao": 69,
      "incluido": false
    }
  ]
}
```

IDs são ilustrativos. Nunca fixe IDs de plano ou módulo no NALVEN.

## Cadastro público

A interface usa uma URL semelhante a:

```text
/cadastro?produto=nalven&plano=12&pagamento=pix&modulos=105,106
```

O request final inclui todos os dados empresariais exigidos pelo formulário e:

```json
{
  "plano_id": 12,
  "forma_pagamento": "pix",
  "modulo_ids": [105, 106]
}
```

O backend recalcula tudo, ignora adicionais já incluídos no plano, grava os snapshots comerciais, cria a assinatura, emite a licença e publica `cliente.criado`. A resposta separa:

```json
{
  "configuracao": {
    "plano_id": 12,
    "forma_pagamento": "pix",
    "valor_plano_mensal": 149,
    "valor_modulos_mensal": 148,
    "valor_mensal": 297,
    "modulos": [
      { "codigo": "vendas_pedidos", "preco": 49 },
      { "codigo": "compras_fiscal", "preco": 99 }
    ]
  }
}
```

O cadastro fica indisponível enquanto `produtos_saas.publicado=false`. Isso é proposital até o receptor de webhook e o provisionamento do NALVEN passarem na homologação.

## Administração

Rotas autenticadas do painel Billing:

- `GET|POST|PUT /api/produtos/{produtoId}/modulos`;
- `GET|PUT /api/planos/{planoId}/precos-metodo`;
- `PUT /api/assinaturas/{assinaturaId}/modulos`.

Exemplo de alteração de uma assinatura:

```http
PUT /api/assinaturas/987/modulos
Content-Type: application/json
Cookie: sessão administrativa

{
  "forma_pagamento": "cartao",
  "modulo_ids": [105, 106, 107]
}
```

A operação substitui os adicionais vigentes, recalcula plano e módulos, ressincroniza entitlements e publica `assinatura.atualizada`.

## Self-service no NALVEN

Não reutilizar `/api/external/upgrade`: essa API é legada e vinculada ao identificador/chave do Delivery. Até existir uma API multiproduto com autenticação própria, o NALVEN deve direcionar o cliente ao portal Billing ou abrir uma solicitação de suporte.

Um self-service futuro precisa incluir:

- autenticação da instalação e do responsável;
- cotação servidor-side com expiração;
- aceite do valor, pró-rata e data de vigência;
- idempotência;
- confirmação de pagamento quando aplicável;
- downgrade agendado e tratamento de objetos acima da nova cota;
- auditoria e webhook de conclusão.

## Aplicação da licença

```text
plano -> módulos incluídos -> recursos
assinatura -> módulos adicionais -> recursos
licença = união dos recursos efetivos
```

Após `assinatura.atualizada`, invalidar o cache e consultar novamente `/api/v1/licencas/entitlements`. O NALVEN não deve reconstruir a composição por nome de plano.
