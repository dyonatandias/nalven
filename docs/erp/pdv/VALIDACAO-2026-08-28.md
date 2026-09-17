# Evidências de validação — 28/08/2026

Este registro separa a verificação automatizada concluída das homologações que ainda exigem infraestrutura, credenciais e equipamentos reais. Ele não é um aceite de produção.

## Resultado automatizado

Executado no workspace com Node.js 24.19.0:

| Verificação | Resultado |
|---|---|
| `prisma validate` — controle e tenant | aprovado |
| `prisma generate` — controle e tenant | aprovado |
| `npx tsc --noEmit` | aprovado |
| `npm run test:unit` | 91/91 testes aprovados |
| `npm run test:pos:postgres` | 7/7 testes aprovados em PostgreSQL 18.6 temporário |
| `npm run lint` | aprovado |
| `npm run build` | aprovado; build de produção e 88 rotas/páginas processadas |

O fluxo legado `action=create_sale` foi retirado do frontend e passou a responder `410 Gone` no endpoint genérico. A única escrita de venda pelo posto do operador é o serviço `/api/erp/pdv`.

## Cobertura obtida

- parser de EAN/GTIN, GS1 com FNC1, GS1 Digital Link e códigos ponderados;
- cálculo monetário em centavos, rateio, pagamento misto, troco, limites e transições;
- contratos tipados e validações de adapters de pagamento, fiscal e agente local;
- contratos unitários já existentes de relatórios, integrações, pedidos e analytics;
- validação estática do schema Prisma, tipos, lint e compilação Next.js;
- testes estruturais automatizados da migration/schema, checks, índices parciais, FKs, unicidades POS e bloqueio do `create_sale` legado.
- cadeia completa de 35 migrations e seed aplicada do zero em PostgreSQL 18;
- migration POS aplicada sobre base sintética pré-POS com venda/itens legados, backfill de centavos reconciliado e código ambíguo excluído;
- concorrência entre conexões para turno único, evento financeiro, mutação administrativa, aprovação/consumo único, código único e origem única de `Sale`, além dos `CHECKs` monetário e administrativo;
- rate limit persistente por ator/ação, Fetch Metadata, origem e limite de bytes com testes negativos;
- boundary mediado de adapters com timeout/AbortSignal, evidências PSP/fiscais, HMAC, digest, sequência, nonce, allowlist PCI e ACK.
- administração idempotente de caixas, terminais, dispositivos e conectores, com DTO sem segredos, auditoria e desativação segura;
- aprovação por filial com solicitante/aprovador distintos, expiração e consumo único atômico em sangria, cancelamento e devolução;
- motor determinístico de melhor promoção exclusiva, limites/cupom e rateio exato em centavos.

## Ainda não validado

- aplicação e rollback da migration em clone PostgreSQL representativo, com reconciliação dos dados históricos antes/depois;
- disputa real de saldo/CAS, retry serializável da API e falhas injetadas após efeitos externos;
- adquirente/TEF/SmartPOS, Pix PSP, estorno e conciliação com credenciais de homologação;
- NFC-e/SAT/MFE e contingência com certificado e ambiente fiscal aplicável à UF;
- agente local, pinpad, impressora, gaveta, balança, scanner serial e display nos modelos escolhidos;
- fila offline cifrada, sync pull e sincronização/conflito entre terminais; o push server-side limitado a heartbeat e rascunho possui testes próprios no runbook de sync;
- jornadas E2E de acessibilidade, pós-venda, aprovações, reconciliação e observabilidade;
- carga, segurança ofensiva, recuperação de desastre e piloto de loja.

## Gate

O rollout continua bloqueado. Antes do piloto, é obrigatório repetir a migration em clone representativo, corrigir qualquer divergência histórica, selecionar os provedores/equipamentos e completar os gates P0/P1 da matriz de rastreabilidade.
