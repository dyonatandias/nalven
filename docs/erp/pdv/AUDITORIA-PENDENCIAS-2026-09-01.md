# Auditoria consolidada de pendências do PDV

Data-base: 01/09/2026. Este documento consolida a matriz técnica, o código atualmente publicado, a interface observada e o estado dos serviços de produção. Ele complementa, sem substituir, o PRD e a matriz de rastreabilidade.

> Atualização operacional de 02/09/2026: os três primeiros incidentes de infraestrutura listados no P0 imediato foram corrigidos e validados em produção. `nalven-pos-maintenance.service`, `nalven-pos-manual-sweep.service` e os jobs gerais de tenant encerram com `Result=success`; a execução automática subsequente dos timers também passou e `systemctl --failed` ficou vazio. As demais linhas continuam como backlog funcional ou dependência de homologação, conforme descrito.

## Veredito executivo

O PDV possui uma fundação de domínio ampla, mas ainda não é um produto completo nem está pronto para rollout irrestrito. O gate automatizado encontra 56 capacidades: 8 `DONE`, 43 `PARTIAL`, 2 `TODO` e 3 `EXTERNAL`. Portanto, 48 capacidades ainda bloqueiam produção completa.

O principal problema já não é apenas ausência de tabelas ou rotas. Há quatro distâncias diferentes até a conclusão:

1. capacidades implementadas no domínio, mas ainda não fechadas na interface;
2. capacidades expostas na interface, mas sem jornada simples, consistente e homologada;
3. infraestrutura persistida, mas sem worker, adapter ou serviço operacional saudável;
4. integrações que dependem de PSP, adquirente, SEFAZ ou hardware real.

## P0 imediato — produção e continuidade

| Item | Estado encontrado | Entrega necessária | Aceite |
|---|---|---|---|
| Worker de manutenção do PDV | Resolvido em produção em 02/09/2026: executor `root:nalven-app:0750`, lote de conciliação compatível e timer saudável | manter o contrato de instalação e o smoke operacional no deploy | aceito: execução manual e automática com `Result=success` |
| Sweep de pagamento manual | Resolvido em produção em 02/09/2026: `RuntimeDirectory` privado e identidade PostgreSQL causal preservada | manter o contrato do diretório e de `PGAPPNAME` no deploy | aceito: sweep executado com role dedicada, evidência causal e `Result=success` |
| Jobs gerais de tenant | Resolvido em produção em 02/09/2026: bundle root-owned homologado e timers habilitados | manter reconciliação fail-closed e monitoramento dos jobs aprovados | aceito: unidades executadas com `Result=success` |
| Erros 401/409/500 do comando central | houve recorrência no uso real; a rota concentra muitas ações | adicionar log estruturado por `action`, correlação, ator, sessão e classe de erro; separar falha de autenticação, conflito e erro interno | nenhum erro comercial vira 500; toast/modal recebe código e orientação acionável |
| Recuperação de rascunho | fundação server-side existe, mas o checkout ainda depende de uma máquina de estados complexa no workspace | tornar recuperação contextual, silenciosa quando não há conflito e bloqueante somente com evidência financeira real | abrir turno vazio nunca mostra recuperação; refresh restaura exatamente uma venda; retry atualiza somente o modal |
| Clone real e reconciliação | migrations foram exercitadas em bases limpas/sintéticas | executar migração, contagem e reconciliação em clone representativo | relatório pré/pós sem perda, duplicidade ou órfão |

## P0 de interface e experiência operacional

### Estrutura e consistência

- Dividir `pdv-workspace.tsx`, atualmente com cerca de 2.950 linhas, em catálogo, busca, cliente, carrinho, pagamento, sessão, recuperação e orquestração. O componente atual aumenta regressões visuais e de estado.
- Substituir o CSS de sobreposição por componentes e tokens definitivos. `pdv-cart.css` corrige o carrinho carregando por último, mas ainda convive com regras legadas globais e muitos `!important`.
- Unificar todos os diálogos em `PdvAccessibleModal`. Caixa, fechamento, configuração e aprovação ainda possuem implementações próprias; parte delas não recebe integralmente trap de foco, retorno de foco e pilha modal.
- Remover `window.confirm` e `window.prompt` de ações administrativas, aprovação, inventário, promoções, QR e limpeza de venda. Usar confirmação padronizada com título, consequência, justificativa e ação destrutiva explícita.
- Criar uma única linguagem de botões: primário verde, secundário neutro, perigo vermelho somente para destruição confirmada, link para ação terciária e estados loading/disabled consistentes.
- Criar tokens únicos para alturas, raios, espaços, tipografia, bordas, cores, elevação e z-index; eliminar valores locais conflitantes.

### Tela principal

- Fechar a composição em 1366×768, 1440×900, 1920×1080, tablet e celular sem scroll horizontal e sem dois scrolls concorrentes.
- Tornar o cabeçalho compacto e colapsável, mantendo filial, caixa, operador e conectividade acessíveis.
- Consolidar busca de produto, categoria, estoque, pedido e cliente em uma barra operacional progressiva, com lupa/atalhos e expansão sob demanda.
- Reposicionar a identificação do cliente antes da venda sem ocupar uma linha inteira quando já selecionado.
- Virtualizar catálogo grande e padronizar cards, proporção da imagem, placeholder, erro de imagem, variação, preço e saldo.
- Exibir leitor/câmera somente quando configurados; permitir câmera móvel; mostrar estado do dispositivo sem texto técnico permanente.
- Criar feedback de leitura curto e inequívoco: sucesso, não encontrado, ambíguo, serial repetido, sem estoque e dispositivo desconectado.
- Manter vendas recentes, rascunhos, relatórios e recursos administrativos somente em modais/drawers acessados por “Mais opções”.

### Carrinho

- Validar a última refatoração em todos os breakpoints e com nomes, preços e variações longos.
- Evitar scroll interno horizontal e limitar a um único scroll vertical da lista; cabeçalho, ajustes, pagamentos, totais e CTA devem permanecer previsíveis.
- Permitir edição rápida de quantidade com botões `−/+`, entrada direta e teclado, sem perder leitura por scanner.
- Colapsar ajustes da venda, cupom, observação e provas de pagamento quando não utilizados.
- Tornar “Limpar venda” neutro na primeira ação e destrutivo apenas no diálogo de confirmação.
- Mostrar troco apenas para dinheiro e validar valor recebido maior ou igual ao tender em dinheiro.
- Simplificar textos técnicos de quote, intent, recovery e server-side para linguagem do operador; detalhes técnicos ficam em expansão ou suporte.
- Criar drawer móvel com botão flutuante, contador, total e retorno de foco; fechar por gesto/ESC não pode perder o carrinho.

### Acessibilidade e público de baixa instrução

- Alvos touch mínimos de 44×44, contraste AA, zoom 200%, ordem de foco e atalhos sem colisão.
- Roving focus no catálogo e comandos de teclado documentados dentro do produto.
- Passos guiados para abertura, fechamento, configuração inicial, aprovação e recuperação.
- Textos orientados a ação: o que aconteceu, por que bloqueou e o que fazer agora.
- Respeitar `prefers-reduced-motion`; GSAP deve reforçar mudança de estado, não animar todos os elementos indiscriminadamente.
- Executar validação real com teclado, leitor de tela, touch e usuários operadores/idosos.

## P0 operacional e financeiro

- Integrar totalmente o ledger de custódia novo a abertura, venda, suprimento, sangria, devolução e fechamento.
- Implementar malote/lacre, entrega, aceite independente, divergência e resolução maker-checker na jornada da tesouraria.
- Completar estados `closed → reconciled/reopened`, preservando revisões imutáveis.
- Aplicar a política de acesso operacional explícito em todas as rotas; cargo gerencial não deve conceder acesso ao caixa implicitamente.
- Fechar break-glass curto, exato, independente, single-use e auditável.
- Adicionar MFA/WebAuthn ao step-up de supervisor e validar a matriz real de papéis.
- Completar inventário dimensional em contagem e transferência: produto, variação, depósito, lote, série e bucket.
- Eliminar normalização destrutiva, fallback legado e ambiguidades entre SKU, EAN/GTIN, PLU, QR interno e outros domínios.
- Completar recuperação de carrinho, intent e referência manual após refresh, queda e efeito incerto.

## Pagamentos e conciliação

### Interno ainda pendente

- Concluir T2-02 e implementar T2-03 a T2-07 da reconciliação manual autoritativa.
- Entregar boundary HTTP com bytes crus, binder e vault/KMS reais, reprocessamento de órfãos, API e UI operacional.
- Completar worker, callback e finalizador comercial de compensações eletrônicas.
- Expandir idempotência para toda integração externa e provar retry após timeout pós-efeito.
- Transformar a conciliação em casos operacionais com owner, evidência, maker-checker, MDR, parcelas, agenda, antecipação e chargeback.
- Homologar layouts reais por NSU, txid, parcela, taxa e provider; alertar atraso e backlog fora do host.

### Dependência externa

- Escolher e homologar PSP para Pix dinâmico.
- Escolher integrador TEF/pinpad e matriz de equipamentos.
- Escolher SmartPOS/adquirente e modelo de integração.
- Manter captura, cancelamento e refund eletrônicos desabilitados até adapters e callbacks reais serem homologados.

## Fiscal

- Escolher estratégia/provedor e UFs do rollout.
- Implementar geração de XML, assinatura, transmissão, consulta, protocolo, DANFE e object storage reais.
- Fechar contingência, retransmissão, cancelamento e inutilização conforme política fiscal por UF.
- Ligar pós-venda a cancelamento/devolução fiscal sem fabricar autorização.
- Criar monitor fiscal com incidentes, owner, prazo, retry e trilha de evidências.
- Homologar certificado, CSC quando aplicável, schemas, ambientes e revisão contábil.

## Hardware e operação local

- Criar binário distribuível do agente local; o serviço server-side não substitui o bridge físico.
- Implementar mTLS/device key, atualização assinada, SBOM, rollback e inventário de versão.
- Homologar scanner em rajada, câmera e iluminação, impressora 58/80 mm, gaveta, balança, display, pinpad/TEF e SmartPOS.
- Implementar drivers/adapters por fabricante e firmware, com health e erros acionáveis.
- Validar ACK físico de impressão e abertura da gaveta; ACK lógico de fila não prova execução física.
- Fechar layouts de balança/PLU por fabricante, tara, estabilidade, precisão e idade da leitura.

## Catálogo, preço, promoção e estoque

- Provar busca e paginação com pelo menos 50 mil produtos, índices reais e virtualização.
- Corrigir definitivamente pipeline de imagens: URL canônica, proxy/storage, variantes, galeria, placeholder e observabilidade de falha.
- Dar tratamento claro a produto simples, variação, kit, serviço, embalagem, peso, lote, validade e série.
- Completar promoções BOGO, bundle, mix-and-match, segmentação, listas, stacking, budget e devolução parcial.
- Completar tiers/campanhas de fidelidade e observabilidade externa.
- Homologar contabilmente gift card/crédito-loja e implementar rotação segura do pepper.
- Implementar catálogo delta e merge assistido para continuidade offline.

## Cliente, privacidade e fraude

- Auditar leituras de dados pessoais no posto e reduzir ainda mais o payload por finalidade.
- Completar DSAR, retenção, anonimização/correção, legal hold e evidência em todos os domínios.
- Integrar IAM/step-up real, KMS e storage seguro às rotinas LGPD.
- Implementar antifraude, hoje `TODO`: regras versionadas, velocidade, fracionamento, horário incomum, operador/terminal/cliente, casos, evidências e decisão maker-checker.
- Definir consentimento e estado de entrega para recibo por e-mail/mensagem.

## Pós-venda

- Completar cancelamento e devolução com refund eletrônico real e efeitos fiscais.
- Expor jornada de busca por número, QR/recibo, cliente e item.
- Separar estados físico, comercial, financeiro e fiscal, evitando um único status enganoso.
- Coletar condição/evidência do item e orientar restock, quarentena ou descarte.
- Completar troca com nova cotação, novo pagamento e acerto da diferença.
- Garantir anti-over-refund, repetição segura e reconciliação de efeito incerto.

## Relatórios, contabilidade e observabilidade

- Criar fatos imutáveis de vendas/retornos e dimensões de filial, caixa, operador, produto, variação, cliente, canal, meio e provider.
- Incluir impostos, CMV, margem, desconto, promoção, tarifa e competência; manter reconciliação entre bruto e líquido.
- Homologar plano de contas e políticas com contador; ligar producers operacionais ao subledger de partidas dobradas.
- Criar métricas históricas, tracing, SLO, alertas deduplicados, owner, ACK/resolução e DLQ para pagamento, fiscal, impressão, sync e reconciliação.
- Criar dashboards próprios para operador, gerente, tesouraria, financeiro, fiscal e suporte.

## Offline e recuperação

- Manter venda/pagamento/fiscal offline bloqueados até existir política de risco aprovada.
- Completar E2E de instalação, cold start, credencial expirada, revogação, conflito e retomada de múltiplos rascunhos.
- Implementar catálogo incremental e resolução assistida de conflito.
- Ocultar detalhes criptográficos e de sincronização do operador; apresentar apenas estado, consequência e ação.
- Garantir que nenhum PIN, token, segredo, aprovação ou prova eletrônica seja persistido no armazenamento do navegador.

## Engenharia, segurança e rollout

- Decompor a rota de comandos do PDV por contexto sem perder transação e invariantes; padronizar envelope de erro e correlação.
- Remover compatibilidade legada após confirmar todos os consumidores externos e reconciliar duplicidades históricas.
- Executar RBAC HTTP negativo, E2E browser, carga, concorrência, chaos, restore e pentest antes do piloto.
- Validar Chromium/WebKit, kiosk/mobile, rede lenta, refresh, queda após captura e scanner em rajada.
- Exercitar backup, restore, WAL/PITR, cópia off-site e object storage.
- Fazer piloto em uma filial com feature flag, rollback operacional, treinamento por papel e suporte de plantão.
- Só declarar o PDV completo após ciclos reais de venda, refund, fiscal, impressão, fechamento e reconciliação sem divergência inexplicada.

## Ordem recomendada de execução

1. **Estabilização de produção:** corrigir os dois serviços falhando, logs/correlação e 401/409/500.
2. **UX operacional:** decompor workspace, unificar modais, fechar responsividade/carrinho/buscas e recuperação silenciosa.
3. **Caixa e tesouraria:** cutover do ledger, custódia, reconciliação/reabertura e acesso explícito.
4. **Catálogo/estoque:** imagens, códigos sem ambiguidade, dimensões completas e carga real.
5. **Pagamento:** finalizar segurança T2 e contratar/homologar Pix/TEF/SmartPOS.
6. **Fiscal e hardware:** adapters reais, laboratório e evidência física.
7. **Pós-venda/contabilidade:** refunds, fiscal, subledger, fatos e relatórios.
8. **Segurança/qualidade:** LGPD, fraude, E2E, carga, chaos, pentest e restore.
9. **Piloto e rollout:** treinamento, suporte, feature flag, observação e expansão gradual.

## Critério de conclusão

“Existe no schema”, “possui parser”, “tem simulador”, “abre um modal” e “passou build” não significam recurso concluído. Uma capacidade só muda para `DONE` quando banco, API, interface, autorização, auditoria, observabilidade, recuperação, acessibilidade, runbook e homologação aplicável fecham a mesma jornada.
