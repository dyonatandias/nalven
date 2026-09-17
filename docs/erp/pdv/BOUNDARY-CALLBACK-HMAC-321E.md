# Boundary interno de callback HMAC 321e

O módulo `pos-manual-payment-callback-adapter.ts` fecha a cadeia local entre a
verificação dos bytes HTTP e `pos_manual_record_callback_v1`. Ele deve receber
uma conexão exclusiva autenticada como `*_mc`; não cria rota HTTP e não aceita
uma conexão runtime genérica.

O event ID cru é autenticado e imediatamente convertido em
`evt:sha256("nalven-pos-manual-callback-event-id-v1" || provider || eventId)`.
Somente digests, campos financeiros fechados e o contexto confiável de revisão
da credencial chegam ao SQL. O resultado e os erros usam allowlists e não
expõem body, segredo, nonce ou event ID cru.

Esse SHA-256 é um pseudônimo de domínio, não um segredo nem um MAC. Event IDs de
baixa entropia ainda podem ser enumerados; ACL da role `_mc`, DLP do DTO e
restrição de leitura no banco continuam sendo controles obrigatórios.

O enablement de produção continua bloqueado até a entrega e homologação da rota
privada, keyring com rotação/KMS, processo segregado e conexão `_mc` no deploy,
PSP/TEF e laboratório. Claim/reprocess e T2 também permanecem fora desta fatia.
