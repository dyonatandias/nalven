# Auditoria E2E, WCAG e operação do PDV — 2026-08-29

## Veredito

O PDV **não está pronto para produção** sob a ótica E2E, acessibilidade e periféricos. Há bons núcleos unitários e contratos estáticos, mas não existe hoje uma suíte de navegador que prove jornadas completas, nem execução com hardware real ou agente local distribuído.

Esta auditoria não altera o aggregate autoritativo de pagamentos em desenvolvimento.

## Evidência disponível

- Scanner HID: núcleo determinístico com captura identificada, FIFO limitada, deduplicação física e proteção de campos sensíveis; o workspace usa prefixo `F9` e só cancela a tecla quando `consumed=true`.
- QR/código de barras: entrada manual e câmera convergem no adaptador de captura; QR internos possuem assinatura, escopo e testes HTTP/de domínio.
- Modal: componente reutilizável com `role=dialog`, nome/descrição acessíveis, `inert`, pilha, trap e retorno de foco, Escape/backdrop bloqueados durante `busy`.
- Offline/recovery: cofre e fila cifrados existem; venda, pagamento, caixa e fiscal são explicitamente bloqueados offline. O service worker está limitado ao escopo `/erp/`.
- Periféricos: existem contratos de impressão ESC/POS, gaveta, balança e display, mas não uma implementação distribuída do agente local nem testes com dispositivos.
- Canal do agente: pareamento, token aleatório, HMAC contextual, expiração, rate limit, escopo por terminal e ACK de impressão têm testes. O fingerprint coletado no pareamento não é exigido na autenticação/prova posterior; o proxy não configura mTLS. Portanto, HTTPS + bearer é uma premissa, não evidência de vínculo criptográfico do processo local.

## Gaps P0

1. Não há Playwright/Cypress configurado, browser instalado, fixture de tenant/terminal nem execução Axe. Dependências transitivas não constituem infraestrutura E2E.
2. Não há agente local empacotado e homologado que execute impressão, gaveta, balança, display e integração TEF/POS; contratos de domínio não provam I/O real.
3. O canal local não valida o fingerprint registrado nem mTLS. Antes de produção deve haver certificado cliente atestado, binding de credencial ao dispositivo ou canal local equivalente, com rotação/revogação e teste de replay.
4. Scanner HID sem prefixo ou identidade de origem é indistinguível de digitação humana. A homologação deve exigir prefixo configurado, campo dedicado `readOnly` ou agente local; não aceitar wedge genérico em campos financeiros/credenciais.
5. Jornadas de pagamento, split, recovery, claim e step-up precisam de testes reais em navegador e simuladores certificados, inclusive reload/crash entre intent, prova e commit.

## Gaps P1 / WCAG

- Há textos secundários no workspace principal abaixo de 4,5:1 e controles de 32–40 px; requer inventário visual e correção sistemática.
- Ausência de prova por leitor de tela para anúncios, nomes, estados de fila, erros e mudanças assíncronas.
- Ausência de matriz touch (zoom 200/400%, orientação, teclado virtual, 44 px) e alto contraste/forced colors.
- Permissão de câmera, negação, dispositivo ausente, troca de lente e interrupção não têm jornada automatizada.
- A fila offline passou a projetar conflitos e rejeições por `reasonCode` allowlisted e mensagem fixa; objetos estruturados recebidos do servidor não são mais serializados na tela.

Correções isoladas aplicadas nesta auditoria: a confirmação destrutiva offline deixou de usar `window.confirm`, passou ao modal acessível com retorno de foco e bloqueio durante operação; controles offline ganharam foco visível, alvo mínimo de 44 px e texto secundário com contraste maior; conflitos/rejeições da fila agora usam projeção segura e não expõem o objeto bruto recebido do servidor.

## Gates obrigatórios

1. Playwright versionado, browsers fixados e execução em CI com Chromium e ao menos um segundo engine.
2. Axe sem violações críticas/sérias nas jornadas; auditoria manual WCAG 2.2 AA com teclado e leitores NVDA/Firefox e VoiceOver/Safari.
3. Homologação de scanner prefixado, câmera e códigos EAN/UPC/Code128/QR válidos, inválidos, longos, repetidos e concorrentes.
4. Homologação do agente local em canal autenticado e vinculado ao dispositivo, incluindo rotação, revogação, replay, perda de rede e fila/ACK de impressão.
5. Matriz de hardware: impressora offline/sem papel, gaveta, balança instável, display desconectado e TEF aprovado/negado/timeout/reversal.
6. Testes de recuperação: refresh, crash, aba duplicada, claim expirado/roubado, sessão fechada, supervisor expirado e retomada idempotente.

## Cenários E2E mínimos

- Teclado completo: abrir sessão, localizar produto, scanner prefixado sobre campo financeiro, editar carrinho, cliente, suspender/retomar, finalizar e imprimir; foco nunca se perde atrás de modal.
- Scanner/câmera: permissão concedida/negada, leitura única e rajada, duplicata física, duas leituras legítimas iguais, QR interno assinado e código desconhecido; UI nunca exibe payload cru em erro/telemetria.
- Modal: Tab/Shift+Tab partindo de dentro e fora, Escape e backdrop em idle/busy, modal aninhado e retorno a gatilho removido/desabilitado.
- Touch: viewport de caixa e tablet, alvos de 44 px, zoom/reflow, teclado virtual e orientação.
- Offline: provisionar/desbloquear, cair rede, criar/revisar/descartar rascunho, recarregar aba, conflito, reconectar e ACK; confirmar que pagamento/caixa/fiscal permanecem bloqueados.
- Operação: claim concorrente, expiração, step-up de supervisor, troca de operador/caixa, impressão com ACK/replay e fechamento com pendências.

## Limite da validação atual

Testes Node e contratos estáticos validam regras puras e presença de integração. Eles não validam layout calculado, árvore de acessibilidade, foco real, permissões, IndexedDB/service worker em navegador, concorrência entre abas, drivers ou dispositivos físicos.

## Execução desta rodada

- Modal + offline acessível e projeção segura da fila: 11/11 testes passaram.
- Lint dos arquivos alterados e dos núcleos scanner/modal: passou sem erros ou avisos.
- TypeScript global (`tsc --noEmit`): passou.
- Lote operacional ampliado: 89/90 passaram. A falha é um matcher textual antigo de `pos-terminal-boundary-contract.test.ts` contra a rota de payment intent alterada concorrentemente; exige alinhamento pelo responsável do aggregate antes de usar o lote como gate.
