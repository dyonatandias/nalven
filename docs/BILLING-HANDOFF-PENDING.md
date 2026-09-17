# Handoff para ativação do Billing Expresso — contrato 3.0.1

O NALVEN implementa o contrato headless 3.0.1 e está pronto para homologação. Nenhum segredo deve ser enviado por Git, chat, ticket ou e-mail.
O pacote 3.0.1 foi validado em 26/08/2026 e permanece compatível com o cliente 3.0.0. Nenhum segredo permanente está incluído no ZIP.
O pacote documental 3.0.2, SHA-256 `3e38b979c5fc7ff57ee71edfe33483445727dee17920423573ed8ba06454b86f`, foi incorporado sem alteração do contrato 3.0.1. A migration 138 pertence ao Billing e já consta aplicada no ambiente externo.

## Ações necessárias no Billing

1. Emitir uma credencial permanente do produto `nalven`, separada por ambiente, com os 14 escopos documentados:
   `catalog:read`, `customers:read`, `customers:write`, `subscriptions:read`, `subscriptions:write`, `invoices:read`, `charges:write`, `contracts:read`, `contracts:write`, `tickets:read`, `tickets:write`, `licenses:read`, `licenses:write` e `portal:read`.
2. Usar limite de 300 requisições/minuto e definir expiração/rotação operacional.
3. Emitir a chave `skp_nalven_…` e cadastrá-la em **Admin → Integrações → Billing Expresso**. O valor fica cifrado no banco e não no `.env`.
4. Gerar/rotacionar o segredo HMAC pelo mesmo painel e instalar no cofre do servidor Billing. O valor é revelado apenas uma vez; depois o painel mostra somente máscara e fingerprint.
5. A assinatura de produção já foi criada, vinculada exclusivamente ao produto NALVEN e contém:
   `cliente.criado`, `cliente.atualizado`, `assinatura.atualizada`, `assinatura.suspensa`, `assinatura.reativada`, `assinatura.cancelada`, `fatura.paga`, `fatura.vencida`, `cobranca.criada`, `cobranca.emitida`, `cobranca.falhou`, `pagamento.confirmado`, `pagamento.estornado`, `nfse.autorizada`, `nfse.rejeitada` e `nfse.cancelada`.
6. O destino é `https://nalven.com.br/api/webhooks/billing`. Falta instalar no Billing o segredo gerado pelo painel, executar o teste assinado e despausar a assinatura.
7. Banco Inter e outbox estão ativos. Mercado Pago permanece corretamente oculto até callback/segredo; NFS-e está configurada, mas a emissão automática segue desabilitada. Esses dois itens precisam ser homologados antes da publicação.

## Dados devolvidos pelo NALVEN

- Produção: `https://nalven.com.br`
- Webhook: `https://nalven.com.br/api/webhooks/billing`
- Identificador estável: `organization.slug`
- Ambiente: `producao`
- Produto: `nalven`
- Versão inicial: `0.9.0`; atualização por releases imutáveis com rollback de symlink
- Contato técnico/operacional: `dyonatandias@gmail.com`
- Cache de licença: 300 segundos; falha fechada para mutações e leitura/exportação preservada durante regularização
- URLs de retorno: `https://nalven.com.br/portal` para faturas, contratos e suporte, com navegação interna por seção
- Reconciliação: fila a cada minuto, varredura integral sob comando administrativo e atualização ao abrir o portal.

## Primeiro aceite

O seed cria o tenant `demo` e uma operação idempotente de onboarding. Assim que a credencial for instalada, o worker criará/vinculará automaticamente o cliente no Billing e armazenará a licença retornada uma vez, criptografada por AES-256-GCM. Depois, executar no painel NALVEN: **Billing Expresso → Testar conexão → Reconciliar tenants**.

O produto somente deve receber `publicado=true` no Billing após os testes de catálogo, onboarding, Pix, boleto, cartão, contrato OTP, NFS-e, suporte, licença, webhook adulterado/repetido e reconciliação.
