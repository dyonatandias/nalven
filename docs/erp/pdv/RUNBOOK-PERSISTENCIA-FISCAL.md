# Runbook — persistência e recuperação fiscal do PDV

## Escopo e estado atual

A fundação local persiste perfil versionado, snapshot da venda, documento, tentativa, outbox, callback, evento de estado, artefato, resultado de entrega e incidente de integridade. Ela está preparada para homologação, mas não transmite à SEFAZ e não habilita produção sem adapter, storage e gates externos.

## Fluxo normal

1. O commit da venda resolve um perfil NFC-e ativo e vigente da filial.
2. Na mesma transação da venda, valida política/cadastro tributário, congela o snapshot e cria documento `queued`, tentativa e outbox.
3. O worker autenticado faz claim com lease e recebe contexto/credencial/snapshot imutáveis.
4. Falha conhecida antes de efeito pode agendar retry com a mesma idempotência.
5. Timeout depois de dispatch vira `unknown`/`cancellation_pending`; manutenção agenda consulta, nunca novo efeito cego.
6. Resultado/callback grava artefatos por hash/metadata antes de `authorized` ou `cancelled`.
7. Callback HMAC usa corpo cru, timestamp, evento único, provider e chave em rotação/grace.

## Estados que exigem ação

| Estado | Ação segura |
|---|---|
| `queued` antigo | verificar outbox, `nextAttemptAt`, worker e credencial; não autorizar manualmente |
| `processing` com lease vencida | manutenção marca resultado incerto e agenda query |
| `unknown` | consultar pela referência/idempotência original; não retransmitir emissão |
| `technical_error` | corrigir dependência conhecida e reprocessar apenas conforme grafo |
| `rejected` | corrigir dado/regra com nova revisão; nunca editar snapshot antigo |
| `cancellation_pending` | consultar cancelamento; não repetir cegamente |
| `manual_review` | investigar incidente/evidência; produção permanece bloqueada quando indicado |

## Incidente de integridade

Contradição de provider, valor/moeda/contexto, chave/protocolo ou artefato abre `PosFiscalIntegrityIncident` bloqueante. O worker encerra a entrega divergente, marca a tentativa como falha, não promove artefato inválido e conduz o documento a revisão manual. Resolver exige evidência externa e ação auditada; nunca apagar callback, evento, artefato ou resultado.

## Verificações operacionais

- comparar idade e estado de `pos_fiscal_outbox`/attempts/documents;
- conferir callbacks inválidos/duplicados e incidentes abertos;
- validar que XML/protocolo e hash estão no storage antes do estado final;
- confirmar provider, credencial congelada, ambiente, filial, modelo e total;
- registrar correlation ID, horários, referência, sequência e decisão no ticket;
- manter venda/recibo comercial distinguíveis do documento fiscal.

## Proibições

- não escrever `authorized`/`cancelled` por tela ou SQL;
- não reenviar após timeout sem consulta;
- não trocar credencial/provider de documento em andamento;
- não guardar certificado/segredo/XML bruto em log;
- não ativar perfil `production` ou numeração local sem gate externo explícito;
- não tratar simulador/conformidade local como homologação SEFAZ.

## Gate de produção

Provider selecionado, contrato assinado, schemas vigentes, certificado/CSC, homologação por UF, object storage/backup/retention, contingência/cancelamento/inutilização, alertas, runbook exercitado e piloto reconciliado.
