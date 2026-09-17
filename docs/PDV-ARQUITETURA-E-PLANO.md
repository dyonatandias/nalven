# PDV — arquitetura, experiência e plano de ativação

Atualizado em 02/09/2026. Este documento registra as decisões implantadas e separa o que é produto NALVEN do que exige credencial, equipamento ou homologação externa.

## 1. Princípios adotados

1. O operador precisa enxergar produtos e total antes dos detalhes financeiros. Por isso o carrinho é uma coluna estável no desktop e uma superfície acionável no mobile; não é um botão flutuante no desktop.
2. Complexidade aparece por demanda. Quantidade, desconto e exclusão ficam em ações recolhidas; campos de troco, terminal, QR e link só aparecem para o meio selecionado.
3. Preço autoritativo é recalculado automaticamente após mudanças, mantendo um controle compacto para falha ou atualização explícita.
4. O pagamento é uma máquina de estados, não um campo do formulário. Cada parcela possui intent, versão, idempotência, tentativa, estado desconhecido/reconciliação e consumo único pela venda.
5. O ERP nunca captura dados brutos de cartão. Dispositivos de pagamento fazem parte do escopo de segurança PCI e devem permanecer sob gestão e homologação adequadas ([PCI SSC — PTS POI](https://www.pcisecuritystandards.org/standards/pts-point-of-interaction-poi/)).
6. Código linear, GS1 DataBar e 2D são tratados como entradas distintas; a GS1 confirma que os símbolos podem carregar GTIN, lote, série, data e peso ([GS1 Barcodes](https://www.gs1.org/standards/barcodes)).

## 2. Experiência do carrinho e checkout

### Carrinho

- Card compacto com foto efetiva da variação/produto, nome, unidade, preço e total da linha.
- Ações secundárias recolhidas por item: quantidade, desconto e remoção.
- Fechamento/limpeza com área de clique clara e confirmação nas ações destrutivas.
- Lista de itens com rolagem própria; resumo e chamada principal permanecem visíveis.
- Desktop em duas colunas persistentes; mobile com alternância catálogo/carrinho.

### Pagamentos progressivos

- Dinheiro: pergunta primeiro se haverá troco; `valor recebido` só abre quando necessário.
- Pix: seleciona rota habilitada e exibe QR, copia-e-cola ou link retornado pelo provider.
- Crédito/débito: escolhe maquininha/TEF/SmartPOS/link conforme as capacidades da rota e solicita parcelamento somente quando aplicável.
- Pagamento dividido: cada parte tem método, valor e execução independente, sem duplicar captura.
- O comprovante final referencia o pagamento concluído; link e QR possuem expiração e não viram prova de quitação por si mesmos.

O desenho acompanha o fluxo documentado pelo Mercado Pago: o backend cria a ordem, o terminal recebe a cobrança e a confirmação retorna ao PDV para conciliação ([Mercado Pago Point](https://www.mercadopago.com.br/developers/pt/docs/mp-point/overview)).

## 3. Arquitetura das configurações

### Configurações do PDV

- Filial, caixa e depósito de baixa.
- Terminais pareados, credencial rotacionável, heartbeat, versão e revogação.
- Perfil `balcão/operador` ou `autoatendimento`, com entrada priorizando leitor, touch ou modo híbrido.
- Periféricos por terminal: leitor, câmera, impressora, balança, gaveta, pinpad e display.
- Códigos EAN/GTIN, GS1, embalagens, PLU/peso, QR internos, promoções, kits e valores locais.
- Observabilidade, reconciliação, inventário e aplicações manuais ficam em áreas operacionais próprias dentro do domínio do PDV.

### Central de pagamentos

- Contas/credenciais separadas das rotas usadas por cada caixa.
- Matriz de capacidades: Pix, QR, link, TEF, SmartPOS, cartão presente e parcelamento.
- Providers catalogados: Mercado Pago, Banco Inter, Cielo, Stone e PagBank.
- Uma rota só ativa com credencial vinculada, família habilitada e último teste aprovado.
- Segredos cifrados e nunca devolvidos ao navegador; callbacks assinados, anti-replay e idempotentes.

SmartPOS não é um conector universal. O PagBank, por exemplo, exige parceria, terminal de desenvolvimento e homologação, além de usar SDK nativo no equipamento ([requisitos PagBank](https://developer.pagbank.com.br/docs/primeiros-passos), [FAQ SmartPOS](https://developer.pagbank.com.br/docs/faq-smartpos)). O boundary de adapters do NALVEN existe para acomodar essas diferenças sem poluir o checkout.

## 4. Integrações, comunicação e IA

- WhatsApp não aparece como integração interna. Um integrador externo recebe tópicos neutros por webhook HMAC e decide como entregar a mensagem.
- OTP aceita somente e-mail e usa SMTP.
- A central transacional possui 66 eventos em acesso, comercial, financeiro, fiscal, estoque, entrega e governança; versões são publicáveis e auditáveis.
- A fila transacional é idempotente, cifra destinatário/variáveis, aplica opt-out apenas aos eventos não críticos, recupera execução abandonada e usa backoff/dead letter.
- OpenAI usa a Responses API no servidor, com `store: false`, identificador de segurança derivado, redação de PII, chave da plataforma ou BYOK, orçamento por tenant e métricas de tokens/latência.
- Auditoria operacional unifica eventos do tenant e integrações, com filtros, paginação e exportação CSV segura.

## 5. Plano de ativação

### Código concluído

- [x] Checkout e carrinho progressivos e responsivos.
- [x] Subpágina dedicada do PDV e cadastro de equipamentos/perfis.
- [x] Hub multiprovedor e associação de rotas a caixa/terminal.
- [x] Artefatos Pix/link cifrados e visíveis somente ao operador autorizado.
- [x] Webhooks neutros; remoção de WhatsApp direto; OTP SMTP.
- [x] Central versionada com mais de 50 eventos e worker de entrega.
- [x] OpenAI gerenciada/BYOK com controles de custo e privacidade.
- [x] Auditoria unificada, migrações e testes de arquitetura.

### Go-live por adquirente e loja

1. Aplicar migrações em todos os tenants e configurar a chave mestra do cofre.
2. Cadastrar SMTP, testar identidade/remetente e publicar os templates críticos.
3. Criar conta sandbox da adquirente, cadastrar credenciais e callbacks e executar a matriz de sucesso, recusa, timeout, cancelamento e estorno.
4. Parear cada terminal, cadastrar seus periféricos e validar leitor/câmera/impressora/balança no equipamento real.
5. Homologar o adapter e o dispositivo com a adquirente; somente então ativar a rota no caixa.
6. Fazer piloto controlado por filial, acompanhar intents desconhecidos, divergências e latência, e só depois expandir.
7. Para autoatendimento, usar terminal e identidade operacional próprios, limitar métodos/equipamentos disponíveis e testar acessibilidade, abandono e recuperação de sessão.

Nenhuma rota de pagamento deve ser marcada como pronta para produção apenas porque o código compilou: o provider precisa confirmar ambiente, credencial, dispositivo e homologação.
