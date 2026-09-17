# Ciência da Operação automática — NF-e recebidas

## Escopo em produção

Em 15/09/2026, a política de Ciência da Operação automática foi autorizada e ativada para a organização Scalon Modas, CNPJ `62.119.228/0001-52`.

A automação é restrita a:

- fonte `sefaz_nfe`;
- ambiente `production`;
- NF-e de entrada classificadas como mercadoria;
- documentos ainda sem XML completo e sem manifestação anterior;
- filial vinculada ao cursor fiscal configurado.

Não são automáticos:

- Confirmação da Operação, Desconhecimento da Operação ou Operação não Realizada;
- entrada física no estoque;
- criação definitiva de contas a pagar ou lançamentos contábeis;
- documentos de serviço, CT-e ou eventos fiscais.

Essas decisões permanecem sob revisão humana porque produzem efeitos fiscais, financeiros ou operacionais conclusivos.

## Funcionamento

O worker periódico primeiro captura os documentos da Distribuição DF-e. Para cada resumo de NF-e de mercadoria elegível, registra a Ciência da Operação com o certificado A1 da filial. Em seguida, agenda uma nova consulta para obter o XML completo disponibilizado pela SEFAZ.

Depois que o XML completo chega, o fluxo existente prepara a entrada para revisão: identifica o emitente, mantém os itens fiscais e permite ao usuário conferir fornecedor, produtos, custos, estoque e financeiro antes da confirmação.

Falhas ficam registradas no histórico do documento. A política usa retentativa com intervalo mínimo de uma hora e processa no máximo dez manifestações por organização em cada execução, evitando tempestade de chamadas à SEFAZ.

## Controles e auditoria

- A ativação e desativação pela interface exigem perfil `owner` ou `admin` e confirmação explícita do aviso fiscal.
- A autorização permanente registra data, autor e evento imutável de auditoria.
- O banco restringe a política a `sefaz_nfe` em produção por constraint.
- O cursor preserva uma consulta já agendada para horário posterior, evitando antecipação indevida após a manifestação.
- A migration foi aplicada pelo migrator dedicado e os grants de runtime foram reconciliados; nenhum seed foi executado.

## Implantação

- Migration: `20260915140000_dfe_automatic_science_policy`
- Release: `/srv/nalven/releases/production-COaVjKEA`
- Autorização Scalon Modas: `2026-09-15T14:19:04.503Z`
- Autor técnico auditado: `maintenance:user-authorized-20260915`
- Processamento: `auto_prepare`

## Referências oficiais

- Portal Nacional da NF-e, Nota Técnica 2014.002 v1.11: o resumo não contém o XML integral; a liberação do documento completo ocorre após manifestação admitida para esse fim.
- Portal Nacional da NF-e, informe de prazos de manifestação: a partir de 01/06/2026, os eventos conclusivos do destinatário têm prazo de 90 dias.
