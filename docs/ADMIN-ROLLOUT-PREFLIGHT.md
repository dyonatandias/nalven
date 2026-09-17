# Pré-publicação da reorganização SaaS

## Evidência verificada em 9 de setembro de 2026

- O publicador instalado foi lido diretamente com privilégio administrativo. Sua ordem é a mesma do arquivo `deploy/publish-current.sh`: dependências limpas, geração, testes, lint, build somente leitura, candidato selado, backup, publicação e verificação. Ele não aplica migrations automaticamente.
- Migrations pendentes impedem a troca da aplicação. O procedimento de seleção explícita do candidato, aprovação root por checksum e execução separada de `production-maintenance.sh migrate` está descrito em `OPERATIONS.md`. Não remover essa proteção para conseguir publicar.
- A cadeia de 17 migrations de controle foi aplicada em PostgreSQL isolado e executada novamente sem pendências. Os testes verificaram histórico/checksums, concorrência de propriedade/capacidade dos planos e transação real do cofre. Evidência: `/tmp/nalven-control-audit.SV8Y76`, cluster encerrado ao terminar.
- A consulta somente leitura de produção mostrou as últimas migrations concluídas ainda em `20260905190000_site_navigation`: as duas migrations novas de planos não foram aplicadas.

## Divergência do catálogo que precisa ser resolvida no rollout

| Plano existente | Ativo | Limite de usuários | Organizações vinculadas | Vínculos ativos |
| --- | --- | --- | --- | --- |
| essential | Sim | 3 | 0 | 0 |
| management | Sim | 8 | 0 | 0 |
| scale | Sim | 25 | 0 | 0 |
| fashion-demo | Não | 25 | 1 | 5 |

A migration de visibilidade atribui `public` por padrão a todos os registros existentes. Assim, aplicar apenas o schema deixará **quatro registros públicos**, embora somente três sejam oferecidos no site. Isso não satisfaz, por si só, a organização solicitada do catálogo.

Antes de considerar o rollout concluído, revalidar os vínculos e classificar o plano de demonstração como exclusivo da única organização vinculada, preservando sua inatividade, preços, capacidade e permissões. Registrar a alteração administrativa na auditoria. Se a cardinalidade tiver mudado, não escolher uma organização arbitrariamente. Não excluir o plano nem mover o cliente para um plano comercial silenciosamente.

## Validações ainda necessárias

### Correção comprovada do método de pagamento

A resposta real do portal contém `subscription.forma_pagamento_preferida`, conforme o contrato de precificação em `vendor/billing-integration/docs/integracao-nalven/catalogo-modular-e-precificacao.md`. O adaptador administrativo só lia `forma_pagamento`/`payment_method` e perdia essa informação. Corrigido para priorizar o campo preferido, preservando os aliases antigos; testes de projeção e autorização passaram.

O diagnóstico repetido com a correção confirmou `paymentMethodPresent=true`, `subscriptionStatusPresent=true` e três meios disponíveis. A consulta de faturas retornou zero registros; portanto ainda não há evidência real de renderização de faturas preenchidas. Nenhum dado pessoal, valor de cobrança ou segredo foi impresso; nenhuma assinatura foi alterada. Esta correção está em preparação de publicação, posterior à release `MXqtq0OA`.

### Financeiro externo: consultas reais verificadas

O diagnóstico `scripts/billing-read-audit.ts` executou como `nalven-app`, com configuração do serviço e banco em modo somente leitura. As três consultas reais pelo cliente Billing existente — catálogo, portal da única conta vinculada e faturas — retornaram com sucesso e envelope objeto. Destino validado estritamente como `https://sistema.agenciaexpresso.com.br/api/v1/saas`; nenhuma reconciliação, cobrança, criação de cliente ou sessão foi executada. Conteúdo remoto e credenciais não foram impressos.

O primeiro empacotamento do diagnóstico falhou localmente por resolução ESM de dependência Prisma (`ERR_MODULE_NOT_FOUND`), antes de chamadas remotas. A instalação root-owned em `billing-read-diagnostic/`, com dependências referenciando o candidato imutável `foC95f`, resolveu o problema. Não era uma falha comprovada do serviço Billing.

Metadados locais mostraram uma conta linked/ativa/valid; um job histórico HTTP_409 e outro completed. Nenhum job foi reenfileirado. Sucesso de consultas não comprova mapeamento integral dos meios de pagamento, paginação, entrega de webhook ou operações financeiras; essas verificações permanecem pendentes.

### Atualização SMTP publicada

O publicador corrigido concluiu uma execução completa após a rotação: candidato `/var/lib/nalven-production-build.foC95f`, release `/srv/nalven/releases/production-MXqtq0OA`. Dependências limpas, testes completos (incluindo 29 testes administrativos), lint, TypeScript e build passaram; backup e checks de migrations precederam a troca. Esta release inclui validação estrita de entrada SMTP e persistência conjunta de cofre/auditoria com rollback. Não configura um provedor nem comprova entrega de e-mail: o SMTP ainda precisa de configuração operacional e teste autorizado.

### Publicação efetivamente executada

As duas migrations de planos foram aprovadas por checksum e aplicadas pelo executor instalado após backup. O controle chegou a 17 migrations; as 120 migrations do tenant já estavam aplicadas. Grants reconciliados e histórico verificado pelo executor, sem seeds.

A reconciliação revisada `deploy/reconcile-admin-plan-catalog.sql` confirmou um único vínculo para o plano demonstrativo inativo e tornou-o privado dessa organização, sem alterar preços, capacidade ou permissões, com `plan.save` registrado na auditoria. `essential`, `management` e `scale` permaneceram públicos e ativos.

O candidato `Jzktvx` foi publicado como `/srv/nalven/releases/production-ZmMKKUsY`. O executor reportou `PUBLICATION_OK`; página inicial retornou 200, APIs protegidas retornaram 401/403 conforme esperado. A tentativa inicial de conexão durante o restart falhou transitoriamente; o processo ficou pronto e os checks seguintes passaram. Isso confirma publicação e smoke checks, não substitui a homologação autenticada da release ativa nem as integrações externas ainda pendentes.

### Candidato gerado pelo publicador instalado

O publicador gerou `/var/lib/nalven-production-build.Jzktvx` com instalação limpa, testes, lint e build aprovados. A publicação encerrou com código 1 na proteção de migration pendente não autorizada (`20260909090000_plan_visibility_ownership`) e restaurou os ponteiros anteriores. Não repetir todo o build apenas por esse bloqueio esperado: revisar e selecionar explicitamente o candidato conforme `OPERATIONS.md`.

Durante o diagnóstico, a listagem de argumentos de processos exibiu a credencial runtime do controle, pois o publicador a passava ao comando `env`. A correção local em `deploy/publish-current.sh` transfere o valor por stdin e passou nos cinco testes de manutenção, mas **ainda precisa ser instalada**. A credencial exposta precisa ser rotacionada com atualização coordenada de seus consumidores; não copiar o valor para documentos nem repetir listagens de argumentos. Resolver essa pendência de segurança antes da próxima publicação.

**Remediação executada:** publicador corrigido instalado root:root 0750 e comparado por SHA-256 com a fonte. A credencial de `nalven_app` foi rotacionada sob o lock de manutenção, sem valor em argumentos ou saída; os arquivos `app.env` e `tenant-provisioner.env` foram atualizados preservando proprietário e permissões. Login PostgreSQL com a nova credencial validado e `nalven.service` reiniciado. A release da aplicação não foi alterada. O helper revisado fica root-only em `/usr/local/libexec/nalven/rotate-control-runtime-credential.cjs`, sem concessão sudo adicional. Backups históricos devem permanecer protegidos e não devem restaurar a credencial antiga em uso.

### Revalidação integrada do código local

Após as correções de entradas numéricas de planos e confirmações de encerramento de sessões, `npm run test:unit` e `npm run lint` terminaram com código zero. O build completo, incluindo TypeScript, passou em `/tmp/nalven-admin-build.PyzlfY`.

O aplicativo standalone desse build passou no ensaio nativo `/tmp/nalven-native.hg6Svf`: login real, 25 destinos administrativos, persistência de cadastro da organização, criação/atribuição de plano exclusivo, três ofertas públicas, rejeição entre clientes, bloqueio de permissões do proprietário e mutações de usuários com falha deliberada no tenant. Nenhuma exceção JavaScript ou falha inesperada de API foi observada nos caminhos exercitados. Os processos de teste foram encerrados e a produção permaneceu em `production-gN8JqvTI`.

O ensaio de upgrade sintético também passou (`/tmp/nalven-control-audit.mfLNPp`), preservando registros anteriores às migrations. Isso não equivale a testar a release anterior completa nem a homologar integrações externas.

- Validar upgrade com dados representativos do catálogo existente e compatibilidade da aplicação anterior com o schema novo; o teste de banco vazio não substitui isso.
- Executar os gates finais sobre o candidato exato e aprovar apenas os checksums revisados.
- Aplicar migrations pelo executor instalado, reconciliar o catálogo, publicar e testar as páginas autenticadas e a separação de organizações na release efetivamente ativa.
- A integração financeira externa e o erro original `VM…startTime` permanecem sem homologação conclusiva. Não declarar conclusão global com base somente nos testes de migrations.
