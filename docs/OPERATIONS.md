# Operação de produção

## Publicação de código

Comando único: `sudo -n /usr/local/libexec/nalven/publish-current.sh`.

O executor instalado pertence a root e não recebe argumentos. Usa lock compartilhado com migrations, snapshot separado do checkout, `npm ci --ignore-scripts`, geração explícita de Prisma, testes, lint e build. A aplicação não executa como root. O build usa consultas de leitura ao controle; não aplica schema nem seeds. O candidato é copiado para um artefato root-owned, validado por SHA-256 e publicado com troca atômica e rollback de código após backup e verificação das migrations.

Scripts antigos de publicação são bloqueados. Bootstrap serve somente à instalação inicial, não à atualização deste servidor. Não usar `migrate dev`, `db push`, `migrate reset` ou seed em produção.

## Migrations futuras

1. Criar uma migration nova e testar a cadeia e a compatibilidade com a release anterior em ambiente isolado. Nunca editar uma migration já aplicada.
2. Preparar e revisar o candidato completo. Um deploy com migrations pendentes deve falhar antes de trocar a aplicação; o candidato selado é preservado em `/var/lib/nalven-production-build.*`.
3. Um administrador deve selecionar explicitamente o candidato root-owned no ponteiro `/usr/local/libexec/nalven/production-release-candidate` e aprovar cada SQL em `/etc/nalven/migration-approvals.sha256`, root:root 0600. Formato: `SHA256  tenant/NOME/migration.sql` ou `SHA256  control/NOME/migration.sql`. Não aprovar SQL sem revisão.
4. Executar `sudo -n /usr/local/libexec/nalven/production-maintenance.sh migrate`. Exige backup, histórico íntegro e aprovação exata de cada migration pendente. Usa credenciais migrator isoladas, reaplica grants e verifica checksums. A versão do tenant é derivada do histórico concluído, não de uma constante.
5. Executar `publish` e `verify` do mesmo executor. Remover as aprovações usadas mediante revisão administrativa.

Rollback da aplicação não desfaz schema ou dados. Migrations destrutivas exigem plano específico de compatibilidade, janela operacional e restauração testada.

## Identidades

- Linux: `nalven` constrói; `nalven-app` executa aplicação; `nalven-jobs` executa jobs comuns; `nalven-migrator` executa Prisma. Serviços privilegiados de provisionamento/backup usam root para ações explicitamente necessárias.
- Controle: `nalven_control_migrator` é proprietário; `nalven_app` recebe DML, sem CREATE no schema ou acesso ao histórico Prisma. Credencial de migração em `/etc/nalven/control-migrator.env`, root:root 0600.
- Tenant: ownership permanece com a role migrator e runtime segregado.
- Não reutilizar a senha pessoal em scripts, arquivos de configuração ou sudoers.

## Inicialização e recuperação

systemd é o gerenciador, não PM2. `nalven.service` depende da ordem de inicialização do cluster PostgreSQL 18/main e reinicia em falha. Nginx, PostgreSQL, aplicação e timers devem permanecer enabled. Os quatro templates opcionais de issuer/binder do PDV não representam integrações instaladas; só habilitar instâncias depois de instalar e homologar os executáveis reais.

Verificação não destrutiva: `systemctl --failed`, `systemctl list-timers --all`, `sudo -n /usr/local/libexec/nalven/production-maintenance.sh status` e `verify`.

Backup diário dos bancos: `/var/backups/nalven`, manifesto SHA-256 e retenção de 30 dias. `deploy/verify-backup-restore.sh` restaura o backup completo em cluster descartável via socket privado, sem alterar bancos de produção, e para o cluster ao terminar. Artefatos de diagnóstico permanecem restritos ao usuário postgres para revisão.

Backup diário adicional: `nalven-recovery-backup.timer`, arquivos em `/var/backups/nalven-recovery`, root-only, retenção de 30 dias. Contém código-fonte (`source/`, sem dependências e build), uploads, segredos e configuração: tratar como material sensível, nunca publicar no repositório ou disponibilizar via HTTP. Dependências são reconstruídas pelo lockfile; os bundles gerados não são duplicados nesse arquivo.

A cópia externa depende de destino e credenciais fornecidos pelo responsável. Backup local não protege contra perda do disco/servidor. Teste de reboot deve ser realizado em janela operacional com acesso ao console de recuperação; nenhum reboot é presumido pela verificação estática.

## Evidência de implantação — 2026-09-08

- Release publicada pelo pipeline limpo: `/srv/nalven/releases/production-gN8JqvTI`. Instalação por lockfile, geração Prisma, suíte unitária, lint e build concluídos; aceite HTTP aprovado.
- Ownership do controle transferido para `nalven_control_migrator`. Consultas de privilégios confirmaram runtime sem CREATE no schema e sem UPDATE no histórico, com UPDATE em organizations mantido. Jobs e health permaneceram saudáveis.
- Migration histórica restaurada no checkout: SHA-256 `e900946fe40901ea1fe5037d971deec0b5910378fe45e940e5261c1ae1d85d4e`.
- Roles `nalven_audit_clone_role` e `nalven_audit_clone_native2_role`: zero sessões/objetos próprios antes de desabilitar LOGIN. As roles foram preservadas, não excluídas.
- Restauração real dos dumps de controle e tenant de `20260908T200818Z`: `RESTORE_OK` nos dois bancos isolados. Histórico restaurado com 15 e 125 registros respectivamente (o segundo inclui cinco tentativas revertidas). Cluster parado ao concluir; não foi restauração sobre produção.
- Nginx, PostgreSQL, aplicação e timer adicional de recuperação confirmados enabled. Não houve reboot completo do host.
- Executor de migrations validado com 15 migrations de controle e 120 de tenant: nenhuma pendente; grants verificados e versão do catálogo atualizada a partir do histórico real, sem seeds.
- Backup de arquivos `recovery-20260908T200837Z.tar.gz` validado, aproximadamente 5,6 MB. Provisionamento usa lock compartilhado; publicação/migrations usam lock exclusivo em `/run/lock/nalven-production-maintenance.lock`.
