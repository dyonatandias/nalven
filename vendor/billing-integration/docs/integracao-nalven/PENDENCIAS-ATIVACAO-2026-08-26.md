# Pendências de ativação do NALVEN

Data da auditoria: 26/08/2026  
Contrato headless do Billing e implementação NALVEN: 3.0.1, compatível com clientes 3.0.0  
NALVEN: `https://nalven.com.br`, versão `0.9.0`, release `20260826195946`

Este documento separa o que foi efetivamente validado do que ainda exige um segredo, dado fiscal ou ativação de terceiro. O produto permanece `publicado=false` até o aceite completo.

## Evidências concluídas

| Item | Evidência |
|---|---|
| Produto e catálogo | produto ativo e não publicado; 3 planos, 12 módulos, composição 4/10/12, 62 recursos e 9 cotas |
| API headless | 23 caminhos e 29 operações REST, 14 escopos, isolamento por `produto_id` e `external_id`, 300 req/min configurável |
| Deploy | build de produção publicado; `/api/health` saudável e API headless validada pela URL pública |
| Idempotência | obrigatória nas mutações; respostas, inclusive chave inicial de licença, cifradas em AES-256-GCM |
| Concorrência | onboarding e alterações de assinatura serializados por produto/tenant com lock transacional |
| Banco Inter | configuração de produção ativa; Pix e boleto não usam fallback para outro gateway |
| Cartão | oculto enquanto o Mercado Pago estiver inativo ou sem callback assinado do Billing |
| Receptor NALVEN | `/api/health` respondeu `200`; webhook com assinatura adulterada respondeu `401` |
| Proxies NALVEN | boleto PDF, DANFSe/XML, contrato PDF e anexos privados implementados com `no-store`, chave apenas no backend e validação local de arquivo |
| Testes NALVEN | build, TypeScript e ESLint aprovados; download sem credencial falhou controladamente com `503`; ZIP recusado com `415`; cadastro oferece Pix/boleto e backend recusa cartão |
| Webhook Billing | destino de produção e 16 eventos cadastrados, 8 tentativas, timeout de 10 s, estado pausado |
| Outbox | execução a cada 2 minutos confirmada por respostas `200` |
| NFS-e | ambiente de produção, certificado válido até 15/04/2027, emissão automática desabilitada |
| Contrato | minuta `nalven_assinatura_saas_mensal`, versão 1, ativa |
| Suporte | anexos privados, validação por conteúdo, MIME/extensão, hash e persistência somente após aprovação; ClamAV ativo e validado com arquivo limpo e assinatura EICAR |
| Runtime NALVEN | `organization.slug`, cache de licença de 300 s, reconciliação por fila a cada minuto, varredura administrativa e release imutável `20260826195946` |
| Pacote | versão 3.0.2, contrato 3.0.1; bytes e SHA-256 autoritativos publicados no arquivo de versão externo ao ZIP |

O smoke de produção usou uma credencial descartável de homologação, revogada no bloco de limpeza. Foram confirmados: `401` sem credencial, catálogo com 3 planos e 12 módulos, Pix/boleto ativos, cartão ausente, listagem de clientes `200`, `external_id` acima do limite `404`, mutação sem `Idempotency-Key` `400`, cabeçalhos de rate limit e replay de resposta `202` cifrada sem JSON em claro. Nenhum cliente, assinatura, licença ou cobrança foi criado durante esse teste.

## Bloqueios externos reais

### 1. Credencial permanente do produto

Não existe credencial ativa permanente; as credenciais descartáveis de smoke test estão revogadas. A credencial de produção deve ter os 14 escopos documentados, `ambiente=producao`, 300 req/min e expiração máxima de 12 meses, com rotação iniciada 30 dias antes.

O segredo completo aparece uma vez. Por isso ele não deve ser gerado enquanto o operador não tiver acesso de escrita ao cofre remoto `/etc/nalven/app.env`. Esta máquina não possui acesso SSH ao servidor NALVEN e não há endpoint de provisionamento secreto autorizado; gerar agora deixaria uma chave órfã ou exigiria transmiti-la por canal proibido.

Procedimento com acesso ao cofre:

1. abrir uma sessão administrativa segura no Billing e outra no servidor NALVEN;
2. emitir a credencial de produção com os 14 escopos e expiração definida;
3. gravar a resposta diretamente como `NALVEN_PRODUCT_API_KEY` no cofre, sem copiar para chat, shell history ou arquivo versionado;
4. reiniciar somente o backend NALVEN;
5. testar `GET /api/v1/saas/catalogo` e confirmar `X-RateLimit-*`;
6. registrar a data de rotação e revogar a credencial anterior apenas depois do teste.

### 2. Segredo do webhook

O Billing conhece apenas a referência `env:NALVEN_WEBHOOK_SECRET` e o fingerprint esperado `2d01107bcefaac01`. O valor não existe no ambiente Billing e não pode ser derivado do fingerprint.

Procedimento com acesso aos dois cofres:

1. transferir o valor já existente no cofre NALVEN diretamente para a variável `NALVEN_WEBHOOK_SECRET` do ambiente Billing;
2. conferir localmente o fingerprint, sem imprimir o segredo;
3. reiniciar `billing-sistema`;
4. executar `POST /api/webhook-subscriptions/1/testar` no painel administrativo;
5. confirmar `2xx`, HMAC válido e deduplicação de replay no NALVEN;
6. permitir que o próprio teste altere a assinatura de `pausada` para `ativa`.

Não altere o status diretamente no banco: o teste assinado é a condição de ativação.

### 3. Mercado Pago

As configurações existentes estão inativas, apontam para callback de outro produto e não possuem segredo de assinatura válido para o Billing. O cartão permanece corretamente ausente de `payment_methods`.

Para homologar, é necessário cadastrar no Mercado Pago o callback exclusivo do Billing, instalar o segredo de assinatura e executar pagamento tokenizado de valor controlado, incluindo confirmação, estorno e idempotência. Nenhum PAN, CVV ou validade pode chegar aos backends.

### 4. NFS-e

A configuração fiscal ainda não possui inscrição municipal nem código de serviço LC 116. Esses dados não podem ser inferidos tecnicamente. Após validação contábil, preencher os campos, emitir uma NFS-e controlada, validar XML/DANFSe e cancelamento e somente então habilitar `emissao_automatica`.

### 5. Primeiro tenant e publicação

O vínculo `scalon-modas` continua apenas em provisionamento de homologação, sem assinatura comercial ativa. O tenant `demo` será criado pelo worker NALVEN quando a credencial entrar no cofre. Não criar assinatura Scalon nem publicar o produto sem plano, método, vigência e aceite comercial explícitos.

## Ordem final de aceite

1. instalar a credencial no cofre NALVEN;
2. executar **Billing Expresso → Testar conexão → Reconciliar tenants** no NALVEN;
3. confirmar onboarding idempotente do `demo`, chave de licença exibida uma vez e cache de 300 s;
4. instalar o segredo no Billing, testar webhook assinado e replay, e ativar a assinatura;
5. homologar Pix e boleto Banco Inter;
6. homologar OTP/PDF, suporte e licença;
7. homologar Mercado Pago e NFS-e com os dados externos faltantes;
8. executar a varredura integral de reconciliação;
9. somente com todas as evidências registrar o aceite e definir `publicado=true`.
