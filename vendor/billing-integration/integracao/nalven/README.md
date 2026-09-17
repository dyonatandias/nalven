# Quick start do pacote NALVEN

Este diretório contém artefatos prontos para iniciar a integração do NALVEN com o Billing Expresso. A documentação normativa está em `docs/integracao-nalven/`.

## Ordem recomendada

1. Leia `docs/integracao-nalven/COFRE-MULTIPRODUTO-E-ATIVACAO.md` e abra os painéis administrativos dos dois sistemas.
2. Transfira a chave da API e o segredo HMAC diretamente entre os cofres, conferindo os fingerprints.
3. Leia `catalogo-v2.json` e use códigos, não IDs fixos.
4. Implemente o portal com `headless-billing-client.example.ts` e o contrato normativo `INTEGRACAO-HEADLESS-PARIDADE-TOTAL.md`.
5. Adapte `billing-license-client.example.ts` à camada de autorização do tenant.
6. Implemente e persista a deduplicação de `webhook-handler.example.ts`.
7. Valide a licença em boot e após eventos de assinatura.
8. Reporte cotas com `Idempotency-Key` estável por tenant, métrica e período.
9. Execute o checklist de homologação antes de solicitar a publicação do produto.

## Regras que não podem ser relaxadas

- A chave `lic_...` é servidor a servidor e nunca vai ao navegador.
- A assinatura HMAC deve ser verificada sobre o corpo bruto.
- Recurso ausente ou desabilitado significa acesso negado.
- Webhook é aviso; a API de licença é a fonte de verdade.
- Retry de uso ou webhook precisa ser idempotente.
- O NALVEN não armazena cartão; seu portal consome Pix/boleto, NFS-e, contrato e ticket pela API headless.
- Segredos não transitam por SSH, arquivo, chat ou variável de ambiente específica do produto.

## Endpoints

```text
POST /api/v1/licencas/ativar
POST /api/v1/licencas/validar
GET  /api/v1/licencas/entitlements
POST /api/v1/licencas/uso
```

Base de produção: `https://sistema.agenciaexpresso.com.br/api/v1`.

Gestão e portal headless:

```text
GET  /api/v1/saas/catalogo
POST /api/v1/saas/clientes
GET  /api/v1/saas/clientes/{external_id}/portal
PUT  /api/v1/saas/clientes/{external_id}/assinatura
POST /api/v1/saas/clientes/{external_id}/faturas/{id}/cobrancas
```

Base headless: `https://sistema.agenciaexpresso.com.br/api/v1/saas`.

O catálogo comercial público só responderá depois da homologação:

```text
GET https://sistema.agenciaexpresso.com.br/api/public/planos?produto=nalven
```
