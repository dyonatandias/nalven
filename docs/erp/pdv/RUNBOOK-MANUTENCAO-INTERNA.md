# Runbook da manutenção interna do PDV

Status: **implementado localmente / integrações externas continuam bloqueadas**.

O timer `nalven-pos-maintenance.timer` chama, pelo listener `127.0.0.1`, as manutenções persistentes de pagamentos, compensações, fiscal, conciliação e ciclo de saldos. O bearer fica em arquivo temporário `0600` e não é colocado no argv do `curl`; respostas e cursores são validados e um tenant com falha torna a execução fail-closed.

O timer não chama endpoints de outbox de provider. Portanto ele:

- recupera leases vencidas, classifica `unknown`, agenda consultas e fecha entregas esgotadas segundo os serviços existentes;
- processa lotes de conciliação já importados;
- libera reservas/expira passivos locais conforme política;
- não envia cobrança, estorno, TEF, Pix, documento fiscal ou comando de hardware;
- não transforma timeout em sucesso ou falha conhecida.
- não consulta referências da wave 320000 enquanto os endpoints, vault e adapter homologado não existirem; quando implementada, a manutenção local apenas agenda/recupera leases/expira/finaliza, e o boundary externo separado executa a consulta.

## Operação

- Unit: `nalven-pos-maintenance.service`.
- Frequência: um minuto após a conclusão anterior, com jitter.
- Timeout: cinco minutos; systemd não sobrepõe a mesma unit oneshot.
- Autorização: `NALVEN_INTERNAL_JOB_TOKEN`, mínimo de 32 caracteres, provisionado fora do repositório.
- Paginação: até 100 organizações/itens por página, cursor estritamente crescente e limite de 1.000 páginas.

Uma resposta HTTP não-2xx, `ok != true`, cursor inválido/estagnado ou timeout falha a unit. Investigue com `systemctl status nalven-pos-maintenance.service` e `journalctl -u nalven-pos-maintenance.service`; não faça retry manual de efeito externo.

## Gates restantes

- tokens distintos/rotacionáveis por domínio e identidade mTLS/PoP do worker;
- métricas e alertas fora do host para atraso, backlog, DLQ, `unknown` e incidentes bloqueantes;
- adapters homologados executando outbox em boundary separado;
- chaos/crash tests e reconciliação com PSP/SEFAZ reais;
- owner, SLA, acknowledge e resolução imutável de incidente.
- implementação e homologação integral da reconciliação manual 320000; suas flags de criação/consulta/aplicação permanecem desligadas sem vault/KMS e adapter real.

Enquanto esses gates estiverem abertos, o timer prova execução das manutenções locais, não prontidão de integrações financeiras ou fiscais reais.
