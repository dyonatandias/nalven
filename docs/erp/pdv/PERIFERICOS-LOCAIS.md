# Contratos locais de periféricos do PDV

Este documento descreve a camada interna que fica entre os snapshots autorizados pelo servidor e os adapters do agente local. Ela está implementada e testada sem hardware em `lib/erp/pos-peripherals.ts`. Isso não certifica nenhum modelo físico, driver, firmware ou conexão.

## Impressão ESC/POS

O renderizador recebe um snapshot fechado, e não uma página HTML nem texto arbitrário. Ele valida:

- 1 a 200 itens, textos limitados e quantidades positivas;
- `subtotal - desconto + acréscimo = total`;
- soma dos pagamentos igual ao total;
- perfil de 32 ou 48 colunas, code page declarada, corte e capability de QR;
- QR limitado e emitido com os comandos ESC/POS de armazenamento/impressão;
- saída determinística para o mesmo snapshot e perfil.

O renderer inicializa a impressora, formata itens/totais, emite QR opcional, avança papel e corta conforme a capability. O modo ASCII translitera caracteres; UTF-8 só deve ser ativado em modelo que declare esse suporte.

O byte de abertura da gaveta nunca é incluído no comprovante. A gaveta usa `drawer.open`, autorização e idempotência próprias. O renderer de pulso limita pino e duração ao intervalo do comando ESC/POS. Assim, retry de impressão não abre a gaveta novamente.

## Balança

A resposta canônica contém:

- identificador do dispositivo;
- peso bruto e tara normalizados em gramas inteiros;
- peso líquido calculado;
- indicador de estabilidade;
- instante da captura.

A política de produto/operação define idade máxima, peso mínimo/máximo, incremento de precisão e se estabilidade é obrigatória. Leitura futura, expirada, instável, fora do limite, com tara maior que o bruto ou fora do incremento é recusada antes de entrar no carrinho. Produtos pesados devem usar `KG` ou `G`.

O perfil serial de referência aceita o layout ASCII estrito `ST|US,GS|NT,+000.000kg|g`, limitado a 128 bytes. Layouts de fabricante devem ser adapters separados e aprovados na matriz de laboratório; não se deve ampliar o parser genérico com expressões livres vindas da configuração.

## Display do cliente

O DTO allowlisted possui apenas:

- estado público (`idle`, `item`, `payment`, `completed`);
- descrição, quantidade, preço unitário e desconto aplicáveis;
- total e troco;
- QR Pix somente no estado de pagamento.

Qualquer campo adicional é rejeitado. Perfil do operador, e-mail, CPF/CNPJ, custo, estoque, mensagens internas, credenciais e evidências do provedor não fazem parte do contrato.

## Envelope do agente

Os bytes e DTOs são payloads dos comandos já allowlisted e assinados em `lib/erp/pos-connectors.ts`:

- `print.receipt`;
- `drawer.open`;
- `scale.read`;
- `display.render`.

O envelope possui terminal/dispositivo, sequência monotônica, nonce, expiração, digest e HMAC. O ACK é vinculado ao digest do comando. O job persistido, o claim/lease e o ACK de impressão continuam sendo a fonte de verdade de entrega.

## Gate físico obrigatório

Para cada combinação de SO, agente, fabricante, modelo, firmware e conexão ainda é necessário testar:

- impressão 58/80 mm, acentos/code page, QR, corte, papel ausente e tampa aberta;
- retry após queda antes/depois do papel sair, sem duplicar gaveta;
- pino/duração da gaveta e política `cash_sale`/`no_sale_open`;
- balança zerada, tara, estabilidade, unidade, precisão, overload, cabo removido e timeout;
- display desconectado, reconexão, QR Pix e ausência de dados proibidos;
- assinatura, expiração, replay, rotação/revogação e atualização do agente.

Até a evidência física ser anexada, o estado permanece parcial e a produção continua bloqueada.
