# Runbook de sincronização offline do PDV

## Estado e limite de confiança

O cliente PWA em `/erp/pdv-offline` e o servidor `POST /api/pos-agent/{organizationId}/{terminalId}/sync` formam um canal de **armazenamento operacional e reconciliação**, não um autorizador financeiro ou fiscal. O agente físico continua podendo fazer push com a credencial longa; pull e ACK do navegador exigem credencial curta vinculada ao usuário.

Implementado nesta fase:

| Tipo | Resultado | Payload persistido |
|---|---|---|
| `terminal.heartbeat` | `applied` | `appVersion`, `queueDepth` |
| `cart.draft.upsert` | `applied` ou `conflict` | IDs, `baseRevision`/`revision` e quantidade em micros |
| `cart.draft.discard` | `applied` ou `conflict` | tombstone revisionado |

Rejeitado deterministicamente com `offline_operation_not_supported` e `requiresOnline: true`: abertura/fechamento de sessão, sangria/suprimento, conclusão/cancelamento de venda, devolução, captura/confirmação de pagamento e emissão/autorização fiscal. A rejeição é um resultado final do ledger e avança o cursor; o cliente deve executar uma nova operação no canal online apropriado, nunca trocar o conteúdo do mesmo `operationId`.

Um rascunho `applied` significa somente que a versão foi preservada na projeção de reconciliação. Preços do snapshot são referências visuais; promoção, estoque, limite, permissão e commit continuam autoritativos no servidor online. Não existe `sale.commit` offline nesta fase.

## PWA, cofre e credencial curta

1. Abrir `/erp/pdv-offline` online ao menos uma vez para instalar o shell do service worker.
2. Escolher um terminal autorizado e emitir `credential.issue` em `/api/erp/pdv/offline-credentials`. A validade padrão é quatro horas e o teto padrão é oito horas.
3. Criar uma frase local de 12–256 caracteres. A frase nunca é enviada nem persistida; PBKDF2-SHA-256 (310.000 iterações) deriva uma chave AES-256-GCM mantida apenas em memória.
4. Credencial, payloads da fila, catálogo, permissões e projeções são cifrados com IV aleatório e AAD que vincula versão, tenant/terminal, tipo e ID do registro. Alteração ou troca de contexto falha na autenticação GCM.
5. Bloquear a aba elimina a chave da memória. Revogar/purgar elimina todos os object stores daquele escopo. `401` ou expiração também dispara purge fail-closed.

O service worker só armazena o shell visitado e assets estáticos. Ele ignora método diferente de GET, `Authorization` e todo `/api/`; respostas `private`/`no-store` não entram no cache. Não há token, chave ou frase hardcoded. Como a chave fica apenas em memória, não há sincronização em background com a tela fechada.

Operador não privilegiado precisa simultaneamente de `BranchUserAccess.canSell` e `PosRegisterAccess.active/canSell` vigentes para a filial/caixa do terminal. Emissão, push, pull e ACK revalidam terminal, usuário, filial e caixa sob lock/transação. Rotação da credencial do terminal invalida a credencial curta por `credentialVersion`.

## Contrato de push

O agente envia `Content-Type: application/json`, `Authorization: Bearer <token>` e um lote de uma a cinquenta operações:

```json
{
  "action": "sync.push",
  "operations": [
    {
      "operationId": "74d4699d-3434-42db-8130-a38bbbd00001",
      "sequence": "1",
      "type": "terminal.heartbeat",
      "occurredAt": "2026-08-29T12:00:00.000Z",
      "payload": { "appVersion": "1.2.3", "queueDepth": 2 }
    }
  ]
}
```

- `operationId` é UUID v4 estável durante todos os retries da mesma operação lógica;
- `sequence` é inteiro positivo decimal, estritamente crescente no lote e contíguo ao cursor do terminal para operações novas;
- `occurredAt` é UTC em formato ISO com `Z` e precisa estar na janela do servidor;
- o payload tem allowlist por tipo, limite de 16 KiB por operação e varredura contra PAN, trilha, CVV, PIN, tokens e segredos;
- preço, total, status de pagamento, evidência de PSP/fiscal e texto livre não pertencem ao rascunho.

A resposta contém o cursor autoritativo e, por operação, `state`, `response`, `conflict` e `replayed`. Retry idêntico devolve a resposta persistida com `idempotency-replayed: true` quando todo o lote é replay. Reutilizar `operationId` com outro terminal, sequência, tipo, data ou payload retorna `409`.

Rascunho novo usa `baseRevision: 0` e `revision: 1`. Cada mutação seguinte deve usar a revisão atual como base e incrementá-la exatamente uma vez. Divergência produz resultado final `conflict` com revisões cliente/servidor e sem devolver o conteúdo do outro rascunho.

## Pull e ACK

O navegador usa a mesma rota com a credencial `posoff_v1_...`:

- `sync.pull`: `{ "afterSequence": "0", "catalogVersion": null, "permissionVersion": null }`; devolve no máximo 100 resultados finais por página, projeções de rascunho e snapshots somente quando o hash SHA-256 mudou. O DTO do ledger não contém payload nem `requestHash`.
- `sync.ack`: `{ "throughSequence": "7" }`; só aceita cursor final existente, nunca à frente de `lastSyncCursor` e nunca reduz `lastSyncAckCursor`. ACK repetido retorna sucesso/replay sem nova auditoria.

Catálogo é allowlist de até 2.000 produtos vendáveis da filial, variações, códigos e preço de referência. Permissões explicitam `saleCommit/payment/cash/fiscal: false`. Não há clientes, documentos, dados de cartão, comprovantes ou segredo nos snapshots.

## Sequência, concorrência e revogação

O servidor bloqueia a linha do terminal, revalida dentro da mesma transação o hash e a versão da credencial, expiração, estado do terminal, usuário, caixa e filial ativos, e então processa em isolamento `SERIALIZABLE`. Cada operação percorre `received -> processing -> applied|rejected|conflict`. Só a primeira aplicação gera auditoria.

O cursor nunca é aceito do cliente. Para operação nova, o único valor válido é `lastSyncCursor + 1`. O ledger possui unicidade por `(terminal, operationId)` e `(terminal, sequence)`. Rotação ou revogação que vencer a disputa invalida o request; uma mutação já sob lock conclui atomicamente antes da alteração da credencial.

## Configuração

| Variável | Padrão | Faixa |
|---|---:|---:|
| `POS_OFFLINE_SYNC_MAX_AGE_HOURS` | `168` | 1–720 horas |
| `POS_OFFLINE_SYNC_MAX_FUTURE_SECONDS` | `300` | 0–3600 segundos |
| `POS_OFFLINE_CREDENTIAL_MAX_MINUTES` | `480` | 15–720 minutos |

Configuração inválida falha fechada com `500`. Ajustar a janela é decisão de risco: ela limita a idade do evento recebido, mas não substitui criptografia/assinatura da fila local nem autorização comercial.

O endpoint também aplica limite persistente de autenticação por terminal/IP e limite de `sync.push` por terminal. Respostas usam `cache-control: no-store`.

## Incidentes e reconciliação

- `401`: interromper a fila, verificar revogação/expiração/caixa/filial e parear ou rotacionar por procedimento administrativo; não copiar token de outro terminal.
- `409` por sequência: executar pull desde o último cursor local e investigar o gap. Não renumerar uma operação já enviada nem reutilizar seu ID.
- `409` por contexto/hash: tratar como possível corrupção/replay; preservar o ledger, versão do agente, IDs e timestamps para investigação.
- `rejected`: preservar o erro na tela e conduzir a intenção pelo fluxo online aplicável. Não transformar rejeição em `applied` no cliente.
- `conflict`: preservar a fila e escolher conscientemente uma nova revisão baseada no estado atual; nunca sobrescrever silenciosamente.
- `processing` persistente: interromper o terminal e investigar antes de alterar dados. A transação atual normalmente não deixa estados intermediários após rollback.

Consultas de diagnóstico (sempre no banco do tenant correto):

```sql
SELECT terminal_id, last_sync_cursor, last_sync_ack_cursor, status, last_seen_at
FROM pos_terminals
WHERE id = :terminal_id;

SELECT operation_id, sequence, type, state, occurred_at, received_at, processed_at
FROM pos_sync_operations
WHERE terminal_id = :terminal_id
ORDER BY sequence DESC
LIMIT 100;
```

Não exportar `payload`, credenciais ou conteúdo sensível em tickets. A auditoria registra apenas terminal, IDs, sequência, tipo, estado e hash.

## Rollout da migration

A migration `20260828160000_pos_offline_sync_hardening` instala checks como `NOT VALID`: novos writes já são protegidos e linhas legadas não bloqueiam o deploy. Antes de validar os checks, auditar e corrigir de forma rastreável qualquer legado incompatível; não apagar o ledger para fazer a validação passar.

A migration aditiva `20260829100000_pos_offline_client_pull` cria credenciais curtas, projeções revisionadas e o cursor de ACK. O check `last_sync_ack_cursor <= last_sync_cursor` é validado na própria migration porque o backfill conhecido é zero.

Depois da auditoria:

```sql
ALTER TABLE pos_terminals VALIDATE CONSTRAINT pos_terminals_last_sync_cursor_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_sequence_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_operation_id_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_type_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_state_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_request_hash_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_payload_object_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_response_object_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_conflict_object_check;
ALTER TABLE pos_sync_operations VALIDATE CONSTRAINT pos_sync_operations_lifecycle_check;
```

## Lacunas e limites honestos

- teste E2E em navegadores reais para crash, quota, storage eviction, relógio errado, múltiplas abas e perda de rede durante cada fronteira push/pull/ACK;
- catálogo hoje é snapshot integral limitado a 2.000 produtos, não delta/paginação; rollout deve medir tamanho e tempo;
- resolução de conflito é determinística e visível, mas a UI ainda não oferece merge assistido entre versões;
- retenção/arquivamento do ledger com garantia de replay;
- WebAuthn/keystore do SO para substituir frase digitada e bridge/binário homologado;
- qualquer pagamento, venda definitiva ou documento fiscal offline homologado.

Até essas lacunas serem resolvidas, habilitar somente em piloto controlado e para os três tipos da matriz. A ausência de venda/pagamento/caixa/fiscal offline é política de segurança, não defeito a contornar.
