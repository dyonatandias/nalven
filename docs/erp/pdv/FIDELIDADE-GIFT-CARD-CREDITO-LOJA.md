# Fidelidade, cashback, gift card e crédito-loja

## Escopo entregue

A fundação de contas de valor do PDV separa quatro naturezas: pontos, cashback em centavos, gift card em centavos e crédito-loja em centavos. O banco continua isolado por organização; cada conta também pertence a uma filial e, exceto gift card ao portador, a um cliente ativo.

A migration `20260829110000_pos_value_accounts` cria:

- programa com regra inteira de acúmulo e resgate;
- conta com saldo, reserva, versão CAS, expiração e estado;
- reserva com ciclo `active -> captured|released|expired`;
- ledger imutável com valores antes/depois e equações validadas no PostgreSQL.

O banco admite no máximo uma conta para cada par programa/cliente e um crédito-loja por filial/cliente. O `UNIQUE` normal do PostgreSQL no par programa/cliente permite contas sem programa, mas elimina a corrida de duas emissões simultâneas para o mesmo participante.

O serviço transacional em `lib/erp/pos-value-accounts.ts` suporta emissão, crédito, débito, reserva, captura, liberação, expiração e estorno compensatório. O saldo nunca pode ficar negativo, reserva nunca excede o saldo e o histórico não é editado nem apagado. Lock de linha, CAS e transação `SERIALIZABLE` fecham disputas concorrentes.

Emissão zerada de pontos, cashback ou crédito-loja cria um lançamento `issue` de zero para manter replay determinístico; gift card exige saldo inicial positivo. Uma reserva liberada permanece histórica. Retry com a mesma chave devolve a mesma liberação, enquanto uma nova tentativa de negócio usa nova chave e pode criar outra reserva com a mesma referência.

## Segredos e API

O código de gift card é gerado pelo servidor com entropia criptográfica e devolvido somente na resposta original de emissão. O banco recebe apenas HMAC SHA-256, quatro últimos caracteres e PIN em scrypt. Replay persistente nunca reexibe o código; DTOs não incluem hashes, chaves idempotentes ou hashes de requisição.

`POS_VALUE_SECRET_PEPPER` é obrigatório, com pelo menos 32 bytes. Sem ele, emissão e resolução falham fechadas. A rota de resolução limita cada operador a 10 tentativas em cinco minutos, exige `pdv.write`, mesma origem, JSON limitado, licença ativa e filial compatível. Gift card vinculado a cliente exige o mesmo cliente na resolução.

As rotas são isoladas:

- `GET|POST /api/erp/pdv/value-accounts`: administração `owner|admin`, idempotência persistente e auditoria;
- `POST /api/erp/pdv/value-accounts/resolve`: validação de código/PIN para integração operacional futura.

O diálogo administrativo permite gerir programas, emitir contas, movimentar saldo, reservar/capturar/liberar, processar expiração e emitir estorno compensatório.

## Integração entregue na venda

A venda online usa `lib/erp/pos-value-sale.ts` dentro da mesma transação `SERIALIZABLE` que cria `Sale`, pagamentos, estoque, auditoria e outbox:

1. conta de pontos/cashback/crédito-loja exige cliente titular; gift card aceita código ou QR assinado e sempre exige PIN;
2. o servidor resolve a conta, cria reserva por pagamento e captura a reserva antes do commit da venda;
3. metadados do pagamento guardam somente conta, unidades e referências opacas; código, PIN e token QR não são persistidos abertos, e o hash idempotente usa HMAC para segredos de baixa entropia;
4. programas ativos acumulam pontos/cashback automaticamente depois da criação da venda, ainda na mesma transação;
5. cancelamento e devolução restituem o meio local original; pontos usados só admitem rateio em unidades inteiras;
6. recompensa ganha sofre clawback pelo valor devolvido acumulado, com arredondamento conservador durante parciais e fechamento exato na devolução integral.

O workspace consulta somente as contas ativas do cliente selecionado, mostra saldo disponível, aceita divisão com outros meios e nunca recebe hashes internos. Gift card ao portador também funciona em venda identificada sem mudar seu titular.

## Lacunas deliberadas

- A varredura de reservas vencidas e expiração de contas está ligada ao timer local `nalven-pos-maintenance.timer`. Isso não substitui alerta de atraso/backlog, teste de recuperação nem homologação contábil do passivo.
- Níveis/tier, campanhas de bonificação, transferência entre contas, compartilhamento entre filiais e relatório contábil de passivo ficam fora desta fundação.
- Não há uso offline: código/PIN, reserva e captura devem permanecer online.
- O formato de hash usa versão `v1`, mas ainda não há chaveiro de peppers. Rotação exige manter a chave v1 disponível ou executar uma estratégia de reemissão; trocar a variável diretamente invalida códigos e PINs atuais.
- Busca administrativa de clientes está limitada aos primeiros 500 registros ativos; instalações grandes precisam de consulta paginada.

## Validação

Os testes unitários cobrem parser estrito, centavos/pontos inteiros, emissão zero, segredo, PIN, conversão de pagamento, estorno proporcional e clawback acumulado. Contratos verificam permissão, anti-CSRF, rate limit, isolamento tenant, integração da venda, replay sem segredo, fechamento sem contagem fictícia, schema e trigger imutável. O teste PostgreSQL, quando `POS_TEST_DATABASE_URL` está definido, disputa débitos concorrentes, exercita liberação e nova reserva para a mesma referência, captura, estorno, expiração e rejeição de `UPDATE`/`DELETE` no ledger.
