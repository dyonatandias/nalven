# Cutover da role manual vault binder

Execute como root o artefato instalado, informando o env migrator do tenant:

```bash
/usr/local/libexec/nalven/cutover-tenant-manual-vault-binder.sh /etc/nalven/tenant-migrators/TENANT.env
```

A ferramenta aceita o formato migrator antigo de oito chaves ou o novo de nove,
valida banco e roles exatos, cria ou endurece `${database}_mb`, publica a
credencial atomicamente como `root:nalven-pos-vault-binder:0640`, acrescenta
somente o nome da role ao env migrator e executa o reconcile. Ela nunca imprime
a senha nem habilita a unit ou o gate.

Execuções concorrentes do mesmo tenant e banco são serializadas por um lock
root-only em `/run/lock/nalven`. A execução seguinte aguarda e então revalida o
estado completo antes de convergir, evitando disputa de senha e env divergente.

Estados parciais seguros convergem: role sem env recebe senha nova; env válido
com role ausente recria a role usando a credencial existente; formato, owner,
permissão ou identidade divergentes falham fechado. Repita o mesmo comando após
falha recuperável. Não edite ou copie os envs manualmente.

> Bloqueio P1 de homologação: o serviço binder ainda usa uma identidade OS
> compartilhada entre tenants. Isolamento de credenciais por instância/unit e
> testes multi-tenant são obrigatórios antes de produção; gate e serviço devem
> permanecer hard-off até esse redesenho ser aprovado.
