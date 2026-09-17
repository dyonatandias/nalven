# Runbook operacional — kits e composições do PDV

Este fluxo trata kits comerciais: o cliente compra um item financeiro, enquanto o servidor expande a BOM ativa e movimenta os componentes físicos. Ele não substitui ordem de produção nem homologa balança, scanner ou qualquer hardware.

## Invariantes

- Existe no máximo uma BOM `active` por filial e escopo de produto/variação.
- Uma versão ativada não pode ser editada ou apagada. Correções exigem novo rascunho e nova versão.
- Uma BOM com `effectiveFrom` futuro não pode ser ativada antes da vigência; isso preserva a versão ativa corrente.
- Cotação e commit resolvem a BOM no servidor. IDs, versões, quantidades e caminhos aninhados entram no `quoteHash` versão 3.
- O item do kit mantém preço, desconto, fiscal e reembolso. Componentes não viram itens financeiros.
- Cada componente vendido possui snapshot em `pos_kit_sale_components`; quantidades usam inteiro em milionésimos.
- `(bom_id, bom_version)` possui FK composta para impedir snapshot apontando outra versão.
- Débitos usam o depósito do caixa, FEFO/lote/série quando configurado e o CAS comum de estoque. Venda, pagamentos, snapshots e todos os componentes estão na mesma transação `SERIALIZABLE`.
- Cancelamento e devolução restauram o snapshot, não a BOM atual. `returned_micros` é monotônico, atualizado por CAS e deve fechar no commit com a soma do ledger imutável `pos_kit_component_return_movements`.

## Publicação segura

1. Cadastre uma nova versão como rascunho no diálogo administrativo do PDV.
2. Confira filial, produto/variação de saída, quantidades e componentes. A ativação valida produtos vendáveis, variações, ciclos, profundidade e precisão.
3. Se a vigência for futura, aguarde o instante configurado para ativar. Não desative a versão corrente antes disso.
4. Ative o rascunho. A versão ativa anterior passa a `retired` na mesma transação.
5. Faça uma cotação de teste e confirme no retorno o `bomId`, a versão e a quantidade de componentes.

## Incidentes

### “Kit sem composição ativa e vigente”

O produto está marcado como `kit`, mas não há BOM utilizável na filial. Crie/ative uma versão ou retire temporariamente o produto da venda. Não altere o tipo para contornar estoque.

### “Estoque insuficiente” ou conflito concorrente

Nenhuma venda/pagamento daquela tentativa é confirmado: a transação inteira é revertida. Confira `warehouse_balances`, reservas, depósito do caixa e os ledgers `kit_sale`. Repita com a mesma chave idempotente depois de atualizar a cotação.

### Lote/série indisponível ou vencido

Confira os lotes do produto componente, no mesmo depósito e escopo de variação. A alocação automática é FEFO e falha fechada quando não há identidade elegível. Não cadastre uma identidade fictícia.

### Cotação mudou antes do pagamento

Uma versão, preço ou promoção mudou. Refaça a cotação; o navegador não pode reaproveitar o total anterior. Não force o hash.

### Pós-venda não encontra snapshot

Interrompa a operação e preserve a venda. Verifique `pos_kit_sale_components` e os movimentos de lote/ledger ligados à venda. Ausência de snapshot indica venda histórica anterior à funcionalidade ou inconsistência que requer tratamento manual auditado; não reconstrua usando a BOM atual.

### Divergência após cancelamento/devolução

Compare, na mesma transação lógica, `returned_micros`, `pos_kit_component_return_movements`, movimentos `return`, ledgers `kit_return`/`kit_sale_cancel` e o destino (`restock`, `quarantine`, `discard`). Snapshot e movimentos não podem ser apagados nem ter quantidade reduzida. Uma alteração SQL de saldo sem movimento correspondente falha no commit pelo trigger diferido.

## Consultas de diagnóstico

Use sempre uma réplica ou sessão somente leitura quando possível e filtre por IDs já autorizados:

```sql
SELECT id, branch_id, scope_key, version, status, effective_from, activated_at, retired_at
FROM pos_kit_boms
WHERE branch_id = $1
ORDER BY scope_key, version DESC;

SELECT sale_item_id, bom_id, bom_version, component_scope_key,
       unit_quantity_micros, quantity_micros, returned_micros
FROM pos_kit_sale_components
WHERE sale_item_id = $1
ORDER BY component_scope_key;

SELECT sale_component_id, quantity_micros, disposition, reference_type, reference_id, actor, created_at
FROM pos_kit_component_return_movements
WHERE sale_component_id = $1
ORDER BY id;
```

## Limites e lacunas externas

- A composição suporta até 100 entradas por versão, 200 folhas após expansão, 8 níveis e 500 BOMs ativas por filial.
- A interface e o boundary aceitam variações e kits aninhados; a quantidade comercial do kit é inteira. Componentes aceitam até seis casas decimais.
- Não há agendador de ativação: `effectiveFrom` futuro exige ativação administrativa quando chegar a vigência.
- Leitura por scanner e seleção FEFO usam os boundaries existentes. Integração com balança física, montagem industrial, certificação fiscal e homologação de periféricos/SmartPOS permanecem externas e não devem ser inferidas deste módulo.
