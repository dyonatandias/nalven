# Integrações de hardware, pagamentos e fiscal

## Referências normativas verificadas

- A [GS1 General Specifications Release 26.0](https://ref.gs1.org/standards/genspecs/) é a fonte para GTIN, simbologias, AIs e dados 2D.
- O [Banco Central publica os regulamentos e manuais vigentes do Pix](https://www.bcb.gov.br/estabilidadefinanceira/pix-normas), incluindo iniciação, experiência, segurança e validação de QR.
- O [Portal Nacional da NF-e/NFC-e](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?AspxAutoDetectCookieSupport=1&tipoConteudo=04BIflQt1aY%3D) publica notas técnicas vigentes. Em 2026 há alterações de RTC, CNPJ alfanumérico e assinatura/autorização; layouts não podem ser congelados no código.
- O portal mantém o [Manual de Contingência Offline da NFC-e](https://www.nfe.fazenda.gov.br/pOrtaL/listaHistorico.aspx?tipoConteudo=GKxb5ZZeQIM%3D); contingência deve seguir a versão/modalidade aplicável.
- O [PCI SSC esclarece o escopo de terminais](https://www.pcisecuritystandards.org/faqs/1300/) e mantém a [família PCI DSS v4.x](https://www.pcisecuritystandards.org/standards/pci-dss/).
- A [ANPD orienta segurança desde a concepção](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/anonimizado___guia_orientat-_seg_da_inf_p_atpp.pdf) e medidas técnicas/administrativas proporcionais ao risco.

Estas referências orientam arquitetura; homologação jurídica, contábil, fiscal e do adquirente continua obrigatória.

## Matriz de leitura

| Simbologia/contexto | Canal | Resultado |
|---|---|---|
| EAN/UPC/GTIN | HID, serial, câmera | produto/variação/embalagem |
| Code 39/128, ITF-14 | HID, serial, câmera quando suportada | SKU/logística/caixa |
| GS1-128/DataMatrix/QR | HID 2D, serial, câmera | GTIN + lote/validade/serial/peso |
| GS1 Digital Link | 2D/câmera | GTIN e AIs extraídos sem navegar |
| etiqueta de balança | HID/serial | PLU + peso ou preço conforme layout da loja |
| QR interno assinado | 2D/câmera | cliente, cupom, vale, carrinho e recibo; pedido está bloqueado até claim/conversão atômicos |
| Pix copia-e-cola | nunca como item | contexto de pagamento isolado |

`PosProductCode` é o índice canônico, com escopo, prioridade, variação e multiplicador. Código duplicado/ambíguo bloqueia a venda.

## Agente local

### Requisitos

- serviço com usuário sem privilégio administrativo;
- TLS/mTLS ou canal local autenticado;
- origem web allowlisted e proteção CSRF/replay;
- certificado/token por terminal, rotação e revogação;
- descoberta limitada por vendor/product ID;
- comando assinado com nonce, expiração e idempotência;
- fila local cifrada e logs sem PAN/segredo;
- atualização assinada, rollback e versão mínima;
- health/heartbeat por dispositivo.

### Adapters

- `scanner.hid`, `scanner.serial`;
- `printer.escpos.usb|serial|tcp` e `printer.browser`;
- `drawer.escpos`;
- `scale.serial|tcp`;
- `display.serial|web`;
- `payment.tef.<provider>`;
- `payment.smartpos.<provider>`.

Cada adapter informa capabilities. O frontend não presume impressão, corte, gaveta, tara ou cancelamento.

## Pagamentos

### Envelope canônico

- identidade: intent/attempt/transaction, venda, terminal e idempotência;
- valor/moeda, método, parcelas e expiração;
- provider/adquirente, NSU, autorização, bandeira e últimos dígitos permitidos;
- estados e timestamps do provedor;
- evidência de assinatura/webhook/consulta;
- erro técnico versus rejeição de negócio;
- bruto, taxa, líquido e agenda na liquidação.

A fundação local já persiste intent, tentativa, outbox, resultado de cada entrega, callback, evento de estado e incidente de integridade. O intent congela a credencial/conta usada; callback exige HMAC sobre o corpo cru, janela temporal e evento único. Isso não executa rede do adquirente: o worker/provider homologado continua sendo o gate que transforma o comando persistido em efeito externo real. Cancelamento/refund eletrônico não deve reutilizar esse aggregate: exige operação compensatória própria, valor delta, referência e dois commits (resultado externo e aplicação local).

### Pix

1. servidor cria cobrança dinâmica/txid no PSP;
2. UI mostra QR e copia-e-cola com expiração;
3. confirmação chega por webhook nativo autenticado e/ou consulta;
4. evento é deduplicado e aplicado monotonicamente;
5. venda só avança após confirmação; expiração visual não cancela pagamento já recebido;
6. refund usa referência original e idempotência.

Nunca aceitar screenshot, “comprovante” visual ou ação do operador como confirmação automática.

### TEF/pinpad

1. API cria intent;
2. agente local inicia adapter no pinpad;
3. UI exibe mensagens não sensíveis;
4. adapter devolve NSU/autorização/token e comprovantes permitidos;
5. servidor confirma/captura e persiste;
6. timeout entra em `unknown`; consulta/desfaz antes de tentar novamente.

### SmartPOS e POS autônoma

- SmartPOS: pareamento, envio remoto, callback/poll e recuperação após queda;
- POS autônoma: registro manual somente com conector/método habilitado, referência externa formal, contexto exato e aprovação independente com step-up; o estado permanece `manual_confirmed` e exige conciliação;
- nunca digitar/guardar número completo do cartão no ERP.

## Fiscal

### Contrato do adapter

- `validateSale(snapshot, profile)`;
- `issue(idempotencyKey)`;
- `status(reference)`;
- `cancel(reference, reason, idempotencyKey)`;
- `contingency(snapshot, reason)`;
- `renderDanfe(reference)`;
- `downloadXml(reference)`.

### Artefatos

Perfil fiscal versionado, snapshot tributário por item, XML, assinatura, recibo/protocolo, chave, QR, DANFE, eventos e retorno bruto redigido. Certificado e senha ficam cifrados fora do navegador.

A persistência local de perfil/documento/attempt/outbox/callback/state event/artifact/delivery/incident e o worker com lease/query já existem para homologação. Uma resposta divergente vai para revisão manual e incidente bloqueante. Isso não significa que XML, assinatura, DANFE, object storage ou transmissão SEFAZ estejam implementados.

### Gates

- contador confirma regime/operação/UF;
- adapter acompanha schemas/notas técnicas vigentes;
- testes em homologação cobrem autorização, rejeição, contingência, cancelamento e timeout;
- numeração concorrente e retry são validados;
- storage/backup/retention dos XMLs é comprovado;
- produção é habilitada por filial e feature flag.

## Impressão e gaveta

Venda cria `PosPrintJob`; agente faz claim, imprime e envia ACK/erro. Retry não duplica gaveta: abertura é comando separado e idempotente. Reimpressão exige motivo/ator. Falha deixa a venda concluída e job pendente.

## Balança

Adapter fornece peso, unidade, estabilidade, tara, timestamp e dispositivo. Produto define precisão/limites. Entrada manual é contingência autorizada. Etiqueta variável usa layout configurado e checksum; prefixos nunca são hard-coded globalmente.

## Display do cliente

Recebe apenas descrição pública, quantidade, preço, desconto, total, troco e QR Pix. CPF, custo, estoque, erros internos e dados de operador não são exibidos.

## Laboratório de homologação

Registrar por combinação: SO, navegador/PWA, agente, fabricante/modelo/firmware, conexão, adapter/provider e capacidades. Testar happy path, cabo removido, papel ausente, queda entre captura/ACK, callback duplicado, reboot, atualização e recuperação.
