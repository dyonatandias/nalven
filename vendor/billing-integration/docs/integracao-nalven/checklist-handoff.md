# Checklist de handoff e go-live

## Informações que a equipe NALVEN deve devolver

- [x] URL pública de produção do SaaS (`https://nalven.com.br`);
- [ ] URL separada de homologação;
- [x] endpoint HTTPS receptor (`https://nalven.com.br/api/webhooks/billing`);
- [x] nome da variável de segredo no servidor Billing (`NALVEN_WEBHOOK_SECRET`);
- [x] convenção definitiva do `instalacao_id`/tenant slug (`organization.slug`);
- [x] e-mail técnico/operacional devolvido no handoff privado;
- [x] versão inicial `0.9.0` e releases imutáveis com rollback de symlink;
- [x] contrato headless 3.0.1 e release ativa `/srv/nalven/releases/20260826195946`;
- [x] cache de licença de 300 segundos; falha fechada para mutações e leitura/exportação preservada durante regularização;
- [x] lista de 16 eventos de webhook realmente consumidos;
- [x] retorno para `https://nalven.com.br/portal`, com navegação interna por faturas, contratos e suporte;
- [x] varredura integral de reconciliação disponível sob comando administrativo;
- [x] documentação 3.0.1 incorporada em `nalven/vendor/billing-integration` e handoff em `nalven/docs/BILLING-HANDOFF-PENDING.md`;
- [ ] ambientes e credenciais de Mercado Livre, Shopee, fiscal e demais terceiros, quando aplicável.

Não enviar segredos por este documento, commit, ticket público ou mensagem comum. Entregar por cofre de segredos ou canal seguro.

## Configuração no Billing

- [x] criar conexão de integração com `provider=nalven`, `tipo=saas`, escopo produto;
- [x] usar `configuracao.base_url` com a URL HTTPS do ambiente;
- [x] registrar `secret_ref=env:NALVEN_WEBHOOK_SECRET` sem armazenar o segredo no banco;
- [ ] instalar a variável `NALVEN_WEBHOOK_SECRET` no ambiente do Billing e validar o fingerprint combinado;
- [x] testar a conexão (`GET https://nalven.com.br/api/health` respondeu `200`);
- [x] criar assinatura de webhook vinculada ao produto NALVEN, inicialmente pausada;
- [x] confirmar que assinatura adulterada retorna `401`;
- [ ] testar assinatura válida e deduplicação após instalar o segredo no Billing;
- [x] confirmar worker de outbox ativo a cada 2 minutos;
- [ ] criar credenciais headless separadas para homologação e produção diretamente com acesso aos cofres;
- [ ] testar escopos, expiração, CIDR, rate limit e rotação sem downtime;
- [x] confirmar autenticação e endpoints Banco Inter em produção;
- [ ] ativar Mercado Pago somente após cadastrar callback e segredo de assinatura no Billing;
- [ ] conferir dados fiscais da contratada;
- [ ] revisar a minuta com jurídico;
- [ ] somente então definir `produtos_saas.publicado=true` para `codigo=nalven`.

## Testes de aceite

- [x] catálogo interno retorna 12 módulos e preços de Pix, boleto e cartão;
- [x] Essencial, Profissional e Omnichannel incluem respectivamente 4, 10 e 12 módulos;
- [ ] módulo já incluído nunca é cobrado novamente;
- [ ] soma exibida pelo configurador é recalculada no servidor;
- [ ] assinatura separa `valor_plano_mensal` e `valor_modulos_mensal`;
- [ ] módulo adicional aparece na licença com `origem=modulo`;
- [ ] alteração de módulos invalida o cache de entitlements;
- [ ] cadastro Essencial cria trial de 14 dias;
- [ ] cadastro Profissional/Omnichannel começa ativo, sem trial fictício;
- [ ] segredo da licença aparece uma vez e depois somente o prefixo;
- [ ] ativação recusa `produto_codigo` diferente de `nalven`;
- [ ] tenant recebe apenas os recursos do plano;
- [ ] limite zero de canais bloqueia canais nos dois planos menores;
- [ ] adicional altera a cota efetiva sem mudar o plano público;
- [ ] upgrade atualiza entitlements;
- [ ] downgrade não apaga dados e bloqueia excesso;
- [ ] suspensão financeira invalida/restringe a licença conforme carência;
- [ ] pagamento reativa o acesso;
- [ ] Pix e boleto Inter conciliam a fatura correta;
- [x] cartão não aparece quando o gateway não estiver habilitado;
- [ ] contrato é gerado, assinado por OTP e baixado com hash/evidências;
- [ ] ticket criado no portal aparece no painel administrativo;
- [ ] portal NALVEN lista faturas, NFS-e, contratos, tickets e licença sem cookie do Billing;
- [x] toda mutação rejeita ausência de `Idempotency-Key`; resposta é cifrada e `202` também é preservado para replay;
- [ ] cartão é tokenizado no navegador pelo SDK do gateway e PAN/CVV não chegam aos backends;
- [ ] contrato é assinado no NALVEN por OTP via API headless;
- [ ] upload e download de anexo funcionam por proxy do backend NALVEN; o Billing valida conteúdo e o ClamAV local falha fechado quando estiver indisponível;
- [ ] reconciliação `GET /api/v1/saas/clientes` percorre todos os cursores;
- [x] webhook adulterado é recusado (`401 Assinatura inválida` em 26/08/2026);
- [ ] webhook repetido não duplica tenant, pagamento ou ação;
- [ ] exportação e cancelamento seguem as janelas contratuais.

Implementação devolvida pelo NALVEN em 26/08/2026:

- [x] proxies privados implementados para boleto PDF, DANFSe/XML, contrato PDF e anexos;
- [x] upload ZIP recusado localmente com `415` e validação de tamanho/formato antes do Billing;
- [x] respostas privadas usam `Cache-Control: no-store` e a chave Billing permanece somente no backend;
- [x] cadastro oferece apenas Pix/boleto e o backend recusa cartão enquanto indisponível;
- [x] build, TypeScript e ESLint do NALVEN aprovados; serviço e release `20260826195946` ativos;
- [ ] validar os mesmos proxies ponta a ponta após instalar a credencial permanente; o teste atual sem credencial termina controladamente em `503`.

## Validação do pacote

```bash
curl --fail-with-body -o integracao-billing-nalven.zip \
  https://sistema.agenciaexpresso.com.br/integracao-billing-nalven.zip
unzip -t integracao-billing-nalven.zip
```

Conferir `manifest.json`, `docs/integracao-nalven/README.md` e os exemplos em `integracao/nalven/` antes de iniciar a implementação.

## Publicação

```sql
-- Executar apenas depois do aceite técnico e comercial.
UPDATE produtos_saas
SET publicado=true,
    metadata=metadata || jsonb_build_object(
      'produto_publicado',true,
      'publicado_em',NOW(),
      'publicacao_bloqueada_motivo',NULL
    ),
    updated_at=NOW()
WHERE codigo='nalven';
```

Essa alteração é operacional e não deve virar nova migration até o ambiente externo existir: cada ambiente pode ser homologado em data diferente.

## Auditoria operacional de 26/08/2026

- conexão NALVEN produção: ativa, health check `200`;
- assinatura NALVEN: cadastrada com 16 eventos, 8 tentativas, timeout de 10 segundos e estado `pausada`;
- `secret_ref`: cadastrado, mas ainda não resolvível no processo Billing;
- Banco Inter: OAuth mTLS, saldo, extrato, BolePix e APIs Pix responderam `200`, sem mock;
- Mercado Pago: token de produção autenticou em consulta sem mutação, mas o gateway permanece inativo porque o callback atual não é o do Billing e não há segredo de assinatura armazenado;
- NFS-e: produção ativa, certificado válido até 15/04/2027 e emissão automática desabilitada;
- minuta `nalven_assinatura_saas_mensal`: ativa, versão 1;
- produto `nalven`: permanece `publicado=false`.
- NALVEN produção: health `200`, versão `0.9.0`, contrato 3.0.1, release `20260826195946` e tenant `organization.slug`;
- credenciais de produto: apenas smokes revogados; nenhuma permanente ativa;
- anexo headless: extensão/MIME/magic byte, hash SHA-256, persistência segura e ClamAV implementados; arquivo limpo e assinatura EICAR validados localmente;
- deploy 3.0.1: health público saudável; smoke headless confirmou autenticação, catálogo 3/12, Pix/boleto ativos, cartão oculto, isolamento de identificador, rate limit e idempotência obrigatória;
- idempotência: replay de `202` confirmado e resposta persistida somente no campo cifrado; registro de smoke removido ao final;
- pacote público 3.0.2: contrato 3.0.1; bytes e SHA-256 autoritativos ficam no arquivo público de versão, fora do ZIP;
- detalhes e ordem de desbloqueio: `PENDENCIAS-ATIVACAO-2026-08-26.md`.
