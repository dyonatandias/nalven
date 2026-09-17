# Conformidade local dos boundaries do PDV

## Escopo e comando

Esta suíte exercita, de forma determinística e sem rede, os contratos de pagamento, fiscal e agente/periféricos definidos em `lib/erp/pos-connectors.ts`. Ela é uma evidência de conformidade do software local, não de integração com um fornecedor.

```bash
npm run test:pos:conformance
```

O comando executa os cenários e, somente se todos passarem, imprime um relatório JSON estável, sem timestamp, com `result: LOCAL_TESTS_PASSED`, `homologated: false`, `certificationStatus: NOT_CERTIFIED`, `externalHomologationStatus: NOT_PERFORMED`, capabilities, dados proibidos e lacunas. Se um teste falhar, o runner escreve `POS_LOCAL_CONFORMANCE_FAILED`, inclui o diagnóstico e termina com código diferente de zero.

## Matriz coberta

| Boundary | Cenários locais exercitados |
|---|---|
| PSP | captura, recusa, processamento, resultado desconhecido, timeout após captura, consulta, cancelamento, estorno parcial/total, retry idempotente, colisão de chave, callback duplicado e fora de ordem |
| Fiscal | autorização, rejeição, processamento, resultado desconhecido, timeout após autorização, consulta, cancelamento, contingência, artefatos DANFE/XML, retry e colisão de chave |
| Agente/dispositivo | comando e ACK assinados, vetor reproduzível, tamper, replay de sequência/nonce e dispositivo offline/em erro |
| Impressão | claim, lease, reclaim, limite de tentativas, ACK idempotente, replay alterado e terminal offline |

Os cenários `timeout_after_capture` e `timeout_after_authorize` persistem o resultado no simulador e deixam a chamada expirar. O teste então consulta a referência determinística. Isso preserva a regra operacional: depois de um timeout com efeito possivelmente aplicado, consultar antes de tentar capturar ou emitir novamente.

## Segurança e determinismo

- O simulador não faz chamadas de rede nem lê variáveis de ambiente.
- Não há credencial real, PAN completo, CVV, PIN ou trilha magnética em fixtures, respostas ou relatório.
- Evidências de cartão usam somente identificadores sintéticos e quatro últimos dígitos; Pix usa um EndToEndId sintético com formato válido.
- Chaves de idempotência, referências, access keys, claims e ACKs derivam de entradas fixas por SHA-256.
- `createDeviceCommand` e `createDeviceAck` aceitam identificadores UUID v4 opcionais e validados. A omissão mantém a geração aleatória anterior; a injeção existe para vetores locais reproduzíveis e não muda os callers existentes.
- Exceções internas do adapter são normalizadas pelo registry para `PosConnectorError`, evitando que mensagens ou detalhes do fornecedor vazem pelo boundary.

## Capabilities e lacunas

O módulo `lib/erp/pos-conformance-simulators.ts` exporta `POS_LOCAL_CONFORMANCE_CAPABILITIES`, que é a fonte do relatório. O resultado local não cobre:

- PSP/eventos/credenciais reais; HMAC, ordenação e persistência transacional de callbacks são cobertos por suítes unitárias/contratuais/PostgreSQL separadas, não por este simulador;
- XML fiscal real, certificado, schemas oficiais, transmissão SEFAZ e regras por UF;
- binário do agente, drivers ESC/POS/TEF, USB, serial, rede, firmware ou equipamento físico;
- conciliação, MDR/recebíveis, laboratório, piloto ou procedimentos do fornecedor.

Assim, um resultado verde não altera os gates externos do PRD: pagamento, fiscal e matriz de hardware continuam exigindo seleção de fornecedor, credenciais mantidas fora do código, homologação oficial e teste físico.
