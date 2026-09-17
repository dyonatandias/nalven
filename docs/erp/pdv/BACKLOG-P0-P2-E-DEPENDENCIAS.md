# Backlog auditável do PDV — P0, P1, P2 e dependências

Versão 1.0 · 29/08/2026. Este documento converte a auditoria em unidades implementáveis. `P0` bloqueia piloto; `P1` bloqueia rollout amplo; `P2` é expansão. Uma linha só muda para concluída com banco/API/UI/testes/observabilidade/runbook e homologação aplicável.

## P0 — segurança operacional e integridade

| Ordem | Entrega | Invariante/aceite | Dependências |
|---:|---|---|---|
| 1 | Fila de scanner HID | 20 leituras sob 1 s de latência produzem 20 ACK/NACK em FIFO, sem perda/duplicação | teste browser e leitores físicos |
| 2 | Draft/intent recuperável | refresh, navegação ou “limpar” não órfã captura/`unknown`; retomada conserva índices e contexto | storage server-side, E2E de falha |
| 3 | Catálogo/cliente paginado | busca server-side cancelável, mascarada e por cursor já existe; falta provar item/cliente além de 50 mil com índices e virtualização sob carga | carga PostgreSQL, índices, E2E browser |
| 4 | Inventário dimensional | contagem/transferência por produto+variação+lote+série+bucket; ajuste é movimento compensatório | migration própria; o legado já falha fechado para rastreados |
| 5 | Claim de pedido | dois terminais não convertem o mesmo pedido; reserva, entrada, pagamento, pedido e `Sale.source` mudam atomicamente | `PosOrderClaim`, estados elegíveis |
| 6 | Compensação eletrônica | identidade, delta, aprovação, reserva, attempts/outbox/callback próprios, dois commits e anti-overrefund existem/testados; faltam worker, ingestão assinada, finalizador comercial e UI | provider homologado permanece desabilitado |
| 7 | Fiscal provider-agnostic | produtor/outbox/callback não fabricam autorização; XML/protocolo antes do estado final; contradição abre incidente | fundação implementada; faltam adapter/storage/SEFAZ |
| 8 | Caixa e tesouraria | ator/terminal/aprovação por FK; evento append-only; malote com dupla custódia; `closed → reconciled/reopened` preserva revisão | migration e serviço próprios |
| 9 | Subledger contábil | cada versão da origem gera uma postagem; débito=crédito; período fechado não muda; replay não duplica | plano de contas e política contábil |
| 10 | Relatório financeiro correto | bruto−cancelado−refund confirmado=líquido; quantidade líquida; competência e dimensões explícitas | correção líquida inicial implementada; fato imutável pendente |
| 11 | LGPD executável | PII tokenizada/cifrada; leitura mínima auditada; DSAR/retention/legal hold produzem evidência real | DPO/jurídico e chaves de dados |
| 12 | Runtime de hardware | agente autenticado, allowlist de comandos, atualização assinada e adapters físicos; ACK lógico não é prova de impressão | modelos/firmwares e laboratório |
| 13 | Observabilidade operacional | lease/outbox/DLQ/callback/recon/fiscal têm alerta deduplicado, owner, ack, resolve, SLO e runbook | stack de métricas/incidentes |
| 14 | Browser E2E/WCAG/performance | Chromium/WebKit, teclado/touch/axe, kiosk/mobile, rede lenta, falha pós-efeito, cold-start offline e catálogo grande | harness Playwright e ambiente determinístico |
| 15 | Acesso operacional explícito | papel gerencial não cria acesso de caixa; toda ação usa grant vigente ou break-glass exato, independente, curto e single-use; a política isolada existe, mas todas as rotas ainda precisam adotá-la | integração após congelar rotas financeiras, migration/ledger de break-glass e E2E de papéis |

## P1 — fechamento funcional antes de escala

- conciliação com casos, resolução, evidência, maker-checker, MDR, parcela, agenda, antecipação e chargeback;
- promoções BOGO, bundle/mix-and-match, segmentação, grupos de stacking, budget e devolução parcial;
- fidelidade/gift/crédito-loja multi-filial/omnichannel, tiers, campanhas, breakage e passivo contábil;
- antifraude operacional com regras versionadas, sinais de velocidade/fracionamento, casos e decisões;
- pós-venda por número/recibo/cliente/item, condição/evidência física e estados financeiro/físico/fiscal separados;
- recibo 58/80 mm, envio consentido, entrega persistida e reimpressão supervisionada;
- PWA com descoberta local de escopo, catálogo/carrinho, retomada de múltiplos drafts e resolução assistida de conflito;
- treinamento no runtime, ajuda de atalhos e runbooks por papel.

## P2 — expansão

- display de cliente avançado, preferência de recibo e campanhas contextuais sem PII;
- analytics preditivo, escalas e capacity planning;
- novos providers/UFs e adapters depois da primeira matriz homologada;
- verticais regulados somente com PRD complementar.

## Dependências externas que não podem ser simuladas

1. PSP/adquirente/TEF/SmartPOS com credenciais e ambiente de homologação.
2. Provedor fiscal, certificado, schemas vigentes, CSC quando aplicável, UF e SEFAZ.
3. Impressora, pinpad, gaveta, balança, scanner e display nos modelos/firmwares escolhidos.
4. Contador, tesouraria, DPO/jurídico, segurança e operadores reais para aceite.
5. Clone representativo, restore drill, WAL/PITR, cópia off-site, object storage e monitoramento. O scheduler local das manutenções persistentes e o backup lógico com manifesto/checksum já estão ligados, mas permanecem insuficientes para o gate de DR.
6. Fazer o cutover dos tenants legados para as roles migrator/runtime já entregues para tenants novos e implantar a raiz de attestation descrita em `SEGREGACAO-ROLE-BANCO-E-ATTESTATION.md`; legados permanecem fail-closed no deploy até a conversão, e attestation/KMS ainda não foi implementada.

## Sequência sem atalhos

`contenções P0 → invariantes de dados → serviços/estado → UI operacional → E2E/chaos → homologação externa → piloto de uma filial → rollout gradual`.

Nenhum adapter de produção, refund eletrônico, emissão fiscal ou venda offline financeira deve ser habilitado antes de seu gate específico.
