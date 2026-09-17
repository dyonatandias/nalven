# Runbook — fundação de LGPD executável do PDV

## Estado e limite desta entrega

`POS-1104` está **PARTIAL**. Esta fundação torna o fluxo governável e verificável, mas **não apaga nem anonimiza dados e não gera um pacote de exportação real**. Todo job e toda linha de outbox nascem em `blocked`. O serviço não expõe operação para reivindicar ou executar esses jobs.

Isso é intencional: ainda não existem adapters homologados por domínio, storage de exportação, KMS/chaves de dados, processo jurídico aprovado nem producers que provem o efeito em cada sistema. Não há seed de prazo ou política legal e não se afirma que PII legada esteja cifrada/tokenizada.

## O que existe

- solicitação de titular com identificadores derivados por HMAC-SHA-256, pepper dedicado obrigatório, separação de domínio, `token_key_id`/versão, tipo, escopo por hash, prazo, estados e versão CAS;
- ledger de estados encadeado e append-only; toda alteração de estado exige evento correspondente na mesma transação;
- política de retenção versionada, sem seed, ativada somente com referência jurídica, maker-checker e prova de step-up por hash;
- inventário de objetos por tipo, hash da chave, token do titular, categoria e hash do manifesto — nunca por cópia da PII;
- legal hold por titular, categoria ou objeto, com aprovação e liberação maker-checker/step-up;
- jobs idempotentes de `export`, `anonymize` e `delete`, outbox separada e evidências por hashes e contagens inteiras;
- invariantes PostgreSQL contra mutação de ledger/evidência, salto de estado, job incompatível, política divergente, legal hold ativo e publicação de outbox bloqueada;
- auditoria no `tenant_audit_events` sem copiar PII.

## Fluxo operacional seguro

1. O canal de atendimento verifica a identidade fora deste módulo e entrega somente material opaco/pseudonimizado. O serviço deriva HMAC-SHA-256 com `POS_LGPD_TOKEN_PEPPER` (mínimo 32 bytes), `POS_LGPD_TOKEN_KEY_ID`, versão e domínio separados para titular, contato, objeto e idempotência. Não existe fallback e o valor de entrada nunca é persistido.
2. A solicitação nasce `received` com prazo explícito; não existe prazo legal padrão no código.
3. Operadores registram `identity_pending`, `verified` e `scoping` usando CAS.
4. Uma decisão destrutiva passa por `decision_pending`; proponente e aprovador precisam ser pessoas distintas e o checker fornece prova de step-up representada somente por hash.
5. O inventário relaciona objetos usando hashes e uma política de retenção explicitamente homologada.
6. Legal hold vigente transforma o motivo do bloqueio em `legal_hold`. Sem hold, o motivo continua `adapter_not_configured`.
7. O planejamento muda a solicitação aprovada para `queued`, cria job/outbox bloqueados e evidência imutável na mesma transação serializável.
8. Nenhum operador deve alterar `blocked` manualmente. O desbloqueio depende de uma entrega futura de adapter/produtor, revisão de segurança e teste de restauração/auditoria por domínio.

## Incidente e reconciliação

- Job ou outbox fora de `blocked` sem adapter homologado: tratar como incidente de segurança, interromper o worker, preservar banco/logs e acionar DPO/SecOps.
- Divergência de ledger/hash: não reparar por `UPDATE`; preservar evidência, investigar a transação e registrar uma nova evidência quando existir procedimento aprovado.
- Prazo vencido: escalar ao DPO; o sistema não inventa extensão de prazo nem conclui automaticamente.
- Legal hold indevido: liberar somente pelo fluxo maker-checker com step-up; nunca excluir a linha.
- Falha parcial futura de adapter: o resultado deverá registrar contagens `matched/processed/failed`, hash de manifesto e resultado; esta fundação não implementa esse adapter.

## Gates obrigatórios para produção

- DPO/jurídico homologam bases legais, categorias, prazos, precedência de legal hold e matriz de decisões por tipo de solicitação;
- segurança provisiona `POS_LGPD_TOKEN_PEPPER`/`POS_LGPD_TOKEN_KEY_ID` fora do repositório e define KMS, segregação de chaves, storage cifrado, expiração de links e proteção de backups; rotação ainda exige estratégia explícita de retokenização/alias e dual-read, pois esta fundação registra key-id/versão mas não implementa migração de digests;
- cada domínio implementa adapter explícito para localizar/exportar/corrigir/anonimizar/eliminar, com dry-run, idempotência e reconciliação;
- revisão confirma dependências fiscais, contábeis, antifraude, chargeback e demais obrigações de conservação;
- permissões e step-up são integrados ao IAM real, com segregação maker-checker;
- testes E2E provam acesso, exportação, correção, anonimização/eliminação, bloqueio por hold, restauração, prazo e evidência sem PII;
- observabilidade alerta prazo, fila bloqueada, divergência, falha, retry/dead-letter e tentativa de bypass.

Enquanto qualquer gate estiver pendente, `POS-1104` permanece **PARTIAL** e os jobs devem continuar bloqueados.
