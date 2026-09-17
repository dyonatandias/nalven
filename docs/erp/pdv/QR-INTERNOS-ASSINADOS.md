# QR internos assinados do PDV

## Escopo entregue

O formato `NALVEN-POS.v1.<keyId>.<payload>.<assinatura>` transporta somente uma referência opaca. O payload canônico inclui propósito e audiência fixos, organização, filial opcional, tipo, referência, emissão, expiração e nonce UUID. A assinatura HMAC-SHA-256 é verificada com comparação em tempo constante; URL externa, campo adicional, payload não canônico, chave ambígua, relógio inválido ou escopo divergente falham fechados.

Tipos operacionais:

| Tipo | Ação no posto |
|---|---|
| `customer` | selecionar cliente e consultar somente seus saldos locais |
| `held_cart` | retomar carrinho do próprio turno/operador |
| `coupon` | aplicar identidade do cupom na cotação e revalidar no commit |
| `gift_card` | selecionar conta; o PIN continua obrigatório |
| `order` | **bloqueado**: não emitir/resolver operacionalmente até existir claim e conversão transacional do pedido |
| `receipt` | abrir comprovante comercial existente |

O leitor nunca navega para o conteúdo do QR. A API resolve a entidade no tenant autenticado e exige turno aberto do próprio operador, filial ativa e acesso vigente ao caixa. Emissão e revogação exigem `owner|admin`. Cada emissão é registrada com hash do token, nonce, chave, referência, ator, expiração e idempotência; o token aberto aparece somente na primeira resposta. Revogação e todas as respostas usam auditoria e `cache-control: no-store`.

## Configuração de chaves

As duas variáveis são obrigatórias para emitir ou ler QR interno:

```dotenv
POS_INTERNAL_QR_ACTIVE_KEY_ID=qr-2026-08
POS_INTERNAL_QR_KEYS_JSON=[{"id":"qr-2026-08","secretBase64url":"<32-ou-mais-bytes-em-base64url>","notBefore":"2026-08-29T00:00:00Z","notAfter":"2027-08-29T00:00:00Z"}]
```

Regras:

- guardar o JSON somente no cofre de segredos de produção; nunca em Git, log, ticket ou QR;
- uma a oito chaves, IDs únicos e exatamente uma correspondente a `POS_INTERNAL_QR_ACTIVE_KEY_ID`;
- segredo base64url canônico com pelo menos 32 bytes decodificados;
- a chave ativa precisa estar vigente e o QR não pode expirar depois de `notAfter`;
- manter chaves antigas no keyring enquanto qualquer QR emitido por elas ainda puder ser lido;
- rotação: adicionar a nova chave, publicar o keyring, trocar o ID ativo, confirmar emissão/leitura e somente remover a antiga depois da última expiração ou revogação;
- perda/comprometimento: revogar emissões afetadas, retirar a chave após avaliar os tokens ainda válidos e registrar incidente. Trocar só o ID ativo não revoga tokens antigos.

O formato mantém compatibilidade criptográfica com `order` para revogar tokens antigos, mas a UI não oferece novos destinos e a API falha fechado. Demais limites: carrinho 24 horas; cupom 30 dias; cliente, gift card e recibo 366 dias. A UI administrativa pode escolher prazo menor e exige ao menos 60 segundos.

## Endpoints e operação

- `GET /api/erp/pdv/internal-qrs?branchId=<id>` lista emissões e alvos permitidos sem devolver token ou hashes;
- `POST /api/erp/pdv/internal-qrs` com `qr.issue` emite uma vez; replay devolve `secretAvailable: false`;
- o mesmo endpoint com `qr.revoke` revoga sob lock e chave idempotente;
- `qr.resolve` aceita token e `sessionId`, revalida assinatura, registro ativo, organização, filial, turno, operador e entidade atual.

O diálogo **Configurar PDV → QR internos** centraliza emissão, cópia única e revogação. Cupom e gift card são resolvidos novamente dentro da transação da venda; a leitura da interface não autoriza desconto nem movimenta saldo.

## Validação e limites

Há testes de assinatura, rotação, janela, canonicidade, tamper, escopo, TTL por tipo, idempotência, segredo único, RBAC, turno próprio, `no-store` e constraints PostgreSQL. Isso valida o protocolo local, não a qualidade de impressão/câmera. Contraste, tamanho, correção de erro, distância e modelos físicos continuam no gate de laboratório.
