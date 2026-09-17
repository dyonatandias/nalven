# Manutenção de produção e permissões

O usuário operacional `nalven` pode executar sem nova senha somente:

```sh
sudo -n /usr/local/libexec/nalven/production-maintenance.sh status
sudo -n /usr/local/libexec/nalven/production-maintenance.sh migrate
sudo -n /usr/local/libexec/nalven/production-maintenance.sh publish
sudo -n /usr/local/libexec/nalven/production-maintenance.sh verify
```

O executor e a regra sudoers são propriedade de root. Não autorizam shell, argumentos arbitrários ou publicação direta do checkout editável. Uma nova versão exige um candidato revisado por administrador, root-owned, sem escrita por grupo/outros e com manifesto SHA-256. As migrations são limitadas às cinco desta ampliação; não são executados seeds. Backup precede migrations; falha no aceite HTTP da publicação restaura o release anterior.

O runtime continua separado do migrator; segredos permanecem em `/etc/nalven`. Comandos administrativos genéricos continuam exigindo autenticação. Não usar `chmod 777` nem liberar sudo irrestrito sem senha.

O perfil de sistema `stock` recebe `production.read`, `production.write`, `logistics.read` e `logistics.write`, preservando seus outros escopos. Perfis personalizados não são alterados. Leitores continuam sem escrita; usuários suspensos/vencidos não são reativados. A extensão é auditada e idempotente.

## Atualização operacional em 2026-09-08

O fluxo atual está em `docs/OPERATIONS.md`: publicação única com dependências limpas, controle runtime/migrator separados e aprovação de migrations futuras por checksum root-only, substituindo a antiga lista fixa de cinco migrations. O arquivo histórico citado abaixo foi posteriormente restaurado também no checkout, sem reescrever o histórico do banco.

## Histórico de migration preservado

Foi identificada divergência preexistente no arquivo `20260902150000_transactional_email_catalog/migration.sql`: o checkout contém alterações posteriores à aplicação original. No pacote de implantação foi preservado o SQL original do bundle root-owned `20260902123602-2293452`, cujo SHA-256 é `e900946fe40901ea1fe5037d971deec0b5910378fe45e940e5261c1ae1d85d4e`, idêntico ao registro do tenant. Nenhum registro de `_prisma_migrations` foi reescrito, nenhum SQL antigo foi reexecutado e o arquivo do checkout foi preservado. A migration posterior `20260904103000_transactional_email_cipher_drift_repair` já aplicada mantém as colunas de cifra. Diferenças de constraints antigas não foram aplicadas como parte desta entrega.
