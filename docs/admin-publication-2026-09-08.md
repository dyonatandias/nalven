# Publicação administrativa concluída — 2026-09-08

A publicação foi executada com autenticação autorizada pelo responsável. Release ativa: `/srv/nalven/releases/production-Ih5XDgbb`. O build concluiu, o backup obrigatório passou e o executor retornou `PUBLICATION_OK`. Serviço confirmado como `active` após a publicação.

Snapshot completo: /home/nalven/admin-release.YkmN8r.

SHA-256 de SOURCE.sha256: 9e298566555a742bf20d6ad168bce5c53c6f6689cae1ed93079cb158fceda1bc.

O snapshot preserva o SQL histórico de 20260902150000_transactional_email_catalog obtido do candidato root-owned, conforme docs/erp/production-maintenance.md. O checkout original não foi alterado. Todas as migrations de controle e tenant coincidem com o candidato anteriormente aprovado.

Procedimento revisável: deploy/publish-admin-reviewed.sh. Exige autenticação sudo/root; verifica o snapshot, refaz build com consultas de leitura ao controle de produção, sela o novo candidato, executa backup, publica pelo executor instalado e verifica HTTP. Falhas após a troca restauram os ponteiros anteriores.

Comando usado nesta publicação:

```sh
sudo bash /home/nalven/nalven/deploy/publish-admin-reviewed.sh
```

Verificação pós-publicação aprovada: / 200, /api/erp 401, /api/saas 403, /api/erp/production 401, /api/erp/production/operations 401. Pelo HTTPS público, a página inicial retorna 200 e `/admin/organizacoes` redireciona ao login (307), como esperado sem sessão. A navegação autenticada pelas 17 páginas foi validada anteriormente em ambiente isolado; não foi repetida com uma conta de produção.

## Permissão permanente restrita

Instalados o executor root-owned `/usr/local/libexec/nalven/publish-current.sh` (0750) e a regra `/etc/sudoers.d/nalven-publish-current` (0440), validada com `visudo`. A regra permite somente esse comando sem argumentos, sem senha; não libera shell root nem sudo genérico. A senha fornecida não foi gravada em arquivos.

Para futuras publicações autorizadas:

```sh
sudo -n /usr/local/libexec/nalven/publish-current.sh
```

Fontes revisáveis: `deploy/publish-current.sh` e `deploy/publish-current.sudoers`. O executor prepara snapshot, executa testes unitários/lint/build, preserva a migration histórica aprovada, sela o candidato, exige backup e publica com verificação e rollback. Não executa seeds ou migrations. A instalação e a autorização sem senha foram verificadas; esse novo executor reutilizável ainda não passou por uma publicação completa própria.
