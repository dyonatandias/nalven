# Validação nativa do superadmin

## Executar

1. `npm run test:admin:build`
2. `npm run test:admin:native`

O segundo comando exige autenticação administrativa para criar namespaces de rede e montagem. Não altera sudoers nem instala permissões permanentes. Não usar este procedimento como publicador.

O executor exige namespaces distintos dos originais, cria dois clusters PostgreSQL temporários, aplica as cadeias completas de controle e tenant, fornece somente registros sintéticos e executa o servidor standalone já compilado. Rede externa fica indisponível; `/etc/nalven` e arquivos `.env` conhecidos ficam ocultos somente dentro do namespace. A resolução de tenant mantém o contrato real de autoridade, usuário e porta. Migrações, servidor e Chromium executam como `nalven`, não root.

O teste verifica o diretório temporário do controle, nomes de tenant exclusivos de homologação e a correspondência entre cookie autenticado e sessão persistida nesse banco. O encerramento para servidor e clusters; evidências temporárias ficam em `/tmp/nalven-native.*` e capturas em `outputs/admin-native`. Não são apagados bancos ou arquivos de produção.

## Evidência de 09/09/2026

Execução completa aprovada em `/tmp/nalven-native.DObrFc`:

- Login real e 25 destinos administrativos com HTTP 200 e um título principal.
- Página individual da organização e edição por sua API própria, confirmada no banco e na listagem.
- Layout da listagem em desktop e 320 px, sem transbordamento da página.
- Criação/atribuição real de plano exclusivo e propagação de módulos no banco.
- Três planos públicos; rejeição de um quarto; plano privado ausente da API pública.
- Rejeição da atribuição privada a outro cliente.
- Proprietário autenticado recusado nas APIs de superadmin e em recurso não permitido pelo plano.
- Nenhuma exceção JavaScript nem falha inesperada de API durante a navegação. Respostas 400/403/409 dos testes negativos são verificadas explicitamente.

A primeira ampliação usou o cliente HTTP auxiliar, que não enviou a sessão segura como o Chromium no endereço HTTP de loopback. As operações autenticadas passaram a usar `fetch` do navegador real; nenhuma proteção de autenticação da aplicação foi removida.

## Limites da evidência

Ampliação aprovada em `/tmp/nalven-native.Dtn33K`: fixture com usuário e perfil tenant reais; ativação pela API administrativa; falha de auditoria provocada com trigger somente no tenant descartável; confirmação de rollback no vínculo, perfil e revogação da sessão; bloqueio em lote após remover o trigger. O percurso de 25 destinos, planos exclusivos e autorização também foi repetido com sucesso no build atualizado.

Não prova publicação, Billing real, envio SMTP, histórico remoto completo ou todas as mutações do tenant. As consultas de usuários e fiscal usam banco real, mas a fixture é mínima. Não reproduziu `startTime` nesse percurso isolado; isso não identifica a origem de um script `VM…` no navegador original. A validação sobre cópia do histórico de produção e a revisão de compensações entre bancos continuam necessárias.
