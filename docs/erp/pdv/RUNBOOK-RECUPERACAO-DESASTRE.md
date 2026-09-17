# Runbook de backup e recuperação do PDV

Status: **PARTIAL / não autoriza produção**.

O deploy mantém um backup lógico diário do control plane e de cada banco tenant. A implementação local agora publica somente archives `pg_dump --format=custom` que passam por `pg_restore --list`, usa arquivo parcial antes do rename atômico, registra SHA-256 por arquivo e valida o manifesto completo antes de considerar o conjunto concluído.

Isso reduz o risco de aceitar um dump truncado, mas não entrega sozinho o RPO/RTO do PDV. Backup lógico diário não satisfaz o alvo de RPO de cinco minutos para vendas, caixa, pagamentos ou fiscal.

## Operação local

- Unit: `nalven-backup.service`.
- Timer: `nalven-backup.timer`, diariamente com atraso aleatório.
- Destino: `/var/backups/nalven`, modo `0700`, arquivos `0600`.
- Retenção padrão: 30 dias; o script aceita somente 7 a 365 dias.
- Publicação: `*.dump.partial → *.dump`; o manifesto só é renomeado depois de todos os archives passarem pela inspeção.
- Expiração: remove apenas nomes exatos listados em manifesto vencido; dump órfão ou manifesto inválido é preservado para investigação.

Falha de qualquer tenant torna o serviço inteiro falho. Não apague parciais ou órfãos antes de verificar logs, espaço, credenciais e a presença de um conjunto posterior completo.

## Verificação mínima por conjunto

1. Executar `sha256sum --check --strict manifest-<timestamp>.sha256` dentro do diretório de backup.
2. Executar `pg_restore --list` em cada archive.
3. Conferir que o manifesto contém `control` e todos os tenants ativos esperados.
4. Registrar timestamp, schema version, tamanho, duração, responsável e resultado em evidência operacional externa ao host.

Esses passos provam integridade estrutural do archive, não uma restauração funcional.

## Restore drill obrigatório

Em ambiente isolado e sem rotas para adquirente, SEFAZ, e-mail ou hardware:

1. Provisionar PostgreSQL compatível, vazio e cifrado.
2. Validar o manifesto e restaurar primeiro o control plane e depois um tenant representativo.
3. Aplicar somente o procedimento de versão aprovado; nunca apontar o aplicativo produtivo ao clone.
4. Reconciliar contagens de vendas, itens, pagamentos, intents, callbacks, documentos fiscais, eventos de caixa, subledger, outboxes, incidentes, auditoria e solicitações LGPD.
5. Rodar migrações/readiness/testes de leitura no clone e medir RTO.
6. Destruir o clone pelo processo de mídia segura e preservar apenas a evidência redigida do drill.

## Gates ainda abertos

- PITR com WAL contínuo e restore até timestamp testado;
- cópia off-site imutável/WORM, cifrada com chave segregada do host;
- catálogo de tenants e manifests exportado fora do servidor;
- alerta de ausência, atraso, checksum inválido, duração, crescimento e espaço;
- restore drill automatizado e periódico com reconciliação de domínio;
- rotação/escrow/KMS das chaves e teste de perda do host/região;
- RPO/RTO aprovados por negócio, segurança, fiscal e DPO.

Até esses gates terem evidência, o status permanece **PARTIAL** e nenhuma validação local deve ser descrita como recuperação de desastre completa.
