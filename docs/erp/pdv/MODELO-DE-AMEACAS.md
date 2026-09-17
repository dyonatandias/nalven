# Modelo de ameaças do PDV

## Escopo, premissas e regra principal

Este modelo cobre navegador do operador, PWA de rascunhos, APIs tenant, PostgreSQL, administração, agente local, periféricos e boundaries de pagamento/fiscal. O ambiente do adquirente, SEFAZ e firmware físico só passa a integrar o escopo verificado depois da escolha dos fornecedores.

Regra principal: seleção humana nunca prova pagamento, autorização fiscal, impressão ou efeito físico. Estado externo só avança com evidência autenticada do adapter; timeout com efeito possível vira `unknown` e exige consulta antes de retry.

Dados proibidos no NALVEN: PAN completo, CVV, trilha magnética, PIN de cartão, chave privada fiscal aberta ou credencial de adquirente em payload, banco, log, QR, rascunho offline ou configuração genérica. Gift card usa código HMAC e PIN scrypt; isso não o transforma em dado de cartão.

## Ativos e classificações

| Ativo | Impacto | Proteção mínima |
|---|---|---|
| sessão, caixa e movimentos | financeiro/antifraude | vínculo operador-caixa, centavos, idempotência, auditoria, segregação |
| venda, pagamento e refund | financeiro/estoque | transação serializável, referência única, máquina de estados, evidência |
| estoque, lote, série e validade | operacional/regulatório | lock/CAS, ledger, identidade única, FEFO, destino físico |
| cliente e documento | LGPD | minimização, mascaramento, escopo tenant/filial, `no-store` |
| cupom e conta de valor | financeiro/fraude | segredo não reexibido, HMAC/scrypt, reserva/captura e ledger imutável |
| QR interno | autorização indireta | HMAC, nonce, TTL, organização/filial, registro e revogação |
| terminal/agente/dispositivo | execução física | pareamento de uso único, token rotativo, comando/ACK assinado, sequência |
| rascunho offline | comercial/LGPD | AES-256-GCM, PBKDF2, credencial curta, allowlist e purge |
| XML/certificado/provider | fiscal/credencial | cofre externo, adapter dedicado, redaction, auditoria e rotação |

## Atores e fronteiras de confiança

- operador autenticado: pode vender somente na filial e caixas vigentes;
- supervisor/aprovador: pessoa distinta do solicitante para exceções configuradas;
- owner/admin: administra configuração, mas não pode fabricar evidência de provider;
- cliente: apresenta códigos, QR, documento e meios de pagamento potencialmente adulterados;
- agente local: processo não confiável até autenticar terminal, sequência, assinatura e claim;
- provider externo: resposta não confiável até validar assinatura, contexto, referência, valor e transição;
- invasor de rede/browser/extensão: pode repetir, alterar ou observar requisições;
- insider com banco/log: não deve recuperar segredo aberto nem apagar ledger para ocultar efeito.

Fronteiras:

1. navegador → API web: cookie, same-origin, Fetch Metadata, JSON e limite de bytes;
2. API → banco tenant: organização deriva a conexão; IDs do cliente nunca escolhem outro tenant;
3. PWA → endpoint do agente: token curto vinculado a usuário/terminal, sequência e tipos limitados;
4. agente → API: bearer rotativo, terminal/organização no path e lifecycle vigente;
5. servidor → provider: adapter allowlisted, credencial fora do payload e timeout explícito;
6. provider → webhook: HMAC sobre bytes crus, timestamp/event ID, keyring de rotação, contexto financeiro, idempotência e incidente bloqueante; credencial/evento de provider real ainda é gate externo;
7. agente → periférico: driver/hardware e firmware — gate de laboratório ainda externo.

## Ameaças, controles e evidência

| Ameaça/abuso | Controle implementado | Evidência/gate restante |
|---|---|---|
| CSRF ou POST cross-site | `assertSameOrigin`, Fetch Metadata e content-type JSON | contratos negativos; pentest |
| enumeração/brute force de gift card | código forte, HMAC, PIN scrypt, resposta uniforme e 10 tentativas/5 min | alertas históricos e teste ofensivo |
| PIN de gift card recuperável por hash da venda | segredo entra no hash idempotente por HMAC com pepper | rotação versionada de pepper |
| QR adulterado, copiado ou de outro tenant | HMAC, canonicidade, nonce, TTL, organização/filial, hash registrado e revogação | qualidade óptica/hardware |
| QR usado como URL maliciosa | scanner só reconhece prefixo interno e resolve ação allowlisted; não navega | E2E browser |
| operador em caixa alheio | sessão própria, branch access e register access revalidados sob lock | matriz real de papéis |
| supervisor aprova a si mesmo | requester/approver distintos, contexto exato, expiração, consumo único e senha fresca obrigatória na confirmação manual | MFA/WebAuthn corporativo |
| duplo clique/retry duplica venda | chave idempotente + request hash + unicidade + transação | falha injetada em jornada completa |
| estoque negativo por corrida | saldo autoritativo por variação/depósito, CAS e `SERIALIZABLE`; lote/série sob lock | corrida completa da venda aprovada em PostgreSQL; carga/piloto ainda faltam |
| referência manual fabrica cartão/Pix pago | conector/allowlist, referência tenant-wide única, contexto exato, step-up e rótulo `manual_confirmed`; não é captura | remover/limitar após adapter real |
| timeout externo causa cobrança dupla | intent/attempt/outbox persistentes preservam `unknown`, entrega é idempotente e manutenção agenda query | adapter/provider real e chaos E2E |
| callback duplicado/fora de ordem ou contraditório | webhook HMAC/anti-replay, state ledger monotônico, suplemento pós-consumo e incidente que bloqueia turno | credencial/eventos reais e workflow compensatório |
| rotação muda conta de intent em voo | `credentialRef` imutável no intent e graça explícita por credencial; todas as chaves candidatas do keyId são testadas | procedimento real de rotação/revogação |
| SQL reescreve pagamento/retorno de kit | FK `RESTRICT`, triggers imutáveis, vínculo manual/eletrônico reverso e saldo de kit validado contra ledger diferido | privilégios mínimos e WORM externo |
| fechamento trata saldo local como dinheiro | contas de valor são excluídas da contagem física e conciliadas no ledger | relatório contábil de passivo |
| refund arredonda pontos ou duplica saldo | rateio inteiro, acumulado, chave própria e crédito compensatório | jornada E2E/repetição |
| PWA conclui venda/pagamento/fiscal offline | allowlist aceita apenas heartbeat e rascunho/tombstone | qualquer expansão exige nova análise de risco |
| roubo do IndexedDB | conteúdo AES-GCM; frase não persistida; AAD contextual e purge | CSP/extensões e teste browser |
| terminal revogado continua sincronizando | credencial curta/lifecycle revalidado sob lock, cursor monotônico | mTLS/fingerprint e agente real |
| agente repete comando físico | HMAC, expiração, nonce, sequência, claim/lease e ACK ledger | binário e driver físicos |
| reimpressão encobre fraude | via original única; reimpressão exige motivo/ator | procedimento de loja |
| insider altera histórico | ledgers compensatórios, triggers contra update/delete e auditoria | retenção/WORM externo |
| PII/segredo em DTO ou cache | projeções mínimas, máscara, redaction e `cache-control: no-store` | DLP/log review |
| SSRF por URL de integração | validação de rede, bloqueio de IP interno/metadata e redirect sem credencial | egress allowlist de produção |
| dependência vulnerável compromete build | lockfile, build imutável e audit periódico | advisory Prisma/deepmerge deve ser acompanhado sem downgrade automático |

## Invariantes verificáveis

1. Cada venda definitiva tem um único `idempotencyKey`, sessão, operador, filial e snapshot monetário inteiro.
2. Soma de pagamentos equivale ao total; troco só pertence a dinheiro.
3. Pagamento externo nunca nasce `captured` por mera seleção quando houver adapter real.
4. Ledger de estoque e valor não é editado/apagado; correção é lançamento compensatório.
5. Reserva de valor nunca excede saldo, captura usa reserva ativa e refund volta à conta original.
6. Uma série não é vendida duas vezes; lote bloqueado/vencido não entra no saldo vendável.
7. Aprovação é contextual, expira, tem pessoa distinta e só pode ser consumida uma vez.
8. QR interno válido precisa simultaneamente de assinatura, registro ativo, escopo e entidade atual.
9. Token, PIN, código aberto, payload PCI e erro sensível não entram em DTO, log ou replay persistido.
10. Operação offline não pode mudar caixa, pagamento, venda definitiva ou fiscal.

## Casos de teste ofensivo obrigatórios

- replay igual e replay com payload alterado para toda mutação financeira;
- duas conexões disputando turno, saldo, cupom, série, claim, aprovação e cursor;
- QR com bit alterado, chave removida, nonce trocado, filial/tenant divergente e registro revogado;
- gift card inexistente, PIN errado, vínculo a outro cliente, brute force e pepper ausente;
- JSON profundo/grande, chave `__proto__`, getter/ciclo em boundary local e campos PCI aninhados;
- callback repetido, atrasado, fora de ordem, valor/referência divergente e assinatura inválida;
- queda antes/depois de captura, emissão fiscal, baixa de estoque e commit;
- usuário perde acesso durante tela aberta, aprovação ou sincronização;
- PWA com credencial expirada/revogada, sequência faltante, ACK regressivo e rascunho conflitante;
- XSS/CSP, foco preso no diálogo, teclado, zoom, leitor de tela e extensão hostil em piloto.

## Risco residual e aceite

Não há aceite de produção enquanto permanecer aberto qualquer gate aplicável: clone/reconciliação histórica, provider de pagamento/refund, fiscal por UF, eventos reais do webhook, agente/binário, matriz de hardware, MFA corporativo, observabilidade externa, teste de carga/restore, pentest e piloto. Exceções precisam de proprietário, prazo, compensação e evidência registrada; “funciona no simulador” não é compensação para homologação externa.
