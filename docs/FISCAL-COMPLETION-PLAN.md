# Plano de conclusão da captura/importação fiscal

Escopo: documentos da organização autenticada e suas filiais autorizadas; NF-e, NFS-e e CT-e com fontes distintas. Captura não constitui confirmação de operação, recebimento físico, pagamento ou emissão. Não cadastrar mercadoria a partir de documento de serviço.

## Critérios de aceite por etapa

1. Integridade: cancelamento terminal; concorrência de classificação/restauração/recebimento segura; natureza, destinatário e filial conferidos; recuperação da preparação após falhas; nenhum saldo/título duplicado.
2. Operação: download autenticado/auditado de XML, separação de emitidas/recebidas/eventos, filtros, situação da captura e expiração A1; retries respeitam os limites oficiais.
3. Mercadorias: XML completo/resumo, conciliação com importação manual, produtos pendentes e vínculos seguros, catálogo em lote sem inventar preços; homologação integrada em banco descartável sem seed em produção.
4. Cobertura nacional: NF-e por NSU/chave conforme contrato, eventos NFS-e por chave, CT-e com seu contrato próprio, isolamento por ambiente e suporte a identidade fiscal vigente. Alterações de schema exigem migration aprovada e aplicada corretamente.
5. Manifestação: ação explícita, autorização por filial, assinatura e idempotência, estado de retorno ambíguo recuperável. Não executar manifestação conclusiva nem confirmar operação em nome do cliente durante testes.
6. Publicação: testes, lint, build, backup, migrations quando necessárias, publicação atômica e verificação de aplicação/agendador. Distinguir implementado, testado com fixture, testado em homologação e comprovado em produção.

Não declarar captura universal, histórico completo ou emissão homologada sem evidência. SMTP permanece fora do escopo conforme solicitado.

## Achados iniciais

- Reclassificação de cancelados e restauração não protegida contra corrida.
- Preparação não exige natureza de mercadoria/filial destinatária inequívoca em todos os caminhos.
- Auto-recebimento verifica fornecedor ativo, mas não sua homologação.
- Cursor é persistido antes da preparação e não havia recuperação independente de falhas posteriores.
- Armazenamento de documentos não distingue ambiente no índice único; não liberar captura misturada de produção/homologação antes da correção estrutural.
- CT-e depende de novas constraints/fontes e parser próprio; não reutilizar parser genérico como se fosse homologação.

## Implementação e evidências — 10/09/2026

Implementados nesta revisão: política de entrada por natureza/status/ambiente; proteção de reclassificação e restauração; escopo por filial nas ações e XML; download auditado; consulta de eventos NFS-e por chave; recuperação limitada de preparações após falha; fornecedor homologado obrigatório para auto-recebimento; isolamento estrutural e filtros por ambiente; adapter CT-e separado, somente conferência; prevenção de recriação de produto por replay ou identidade de fornecedor/GTIN já existente.

Validação: 18 testes fiscais unitários passaram. O teste PostgreSQL descartável aplicou as 121 migrations e a matriz completa de permissões, executando preparação repetida, criação de produto pendente, recebimento, prevenção de estoque/título duplicado e bloqueios por cancelamento/homologação. A configuração de locale do teste deve ser `pt_PT.UTF-8`, como em produção: os manifests existentes ordenam definições conforme a collation do banco. Nenhuma proteção de produção foi flexibilizada.

Ainda não concluídos/homologados: manifestação assinada e recuperação de retorno ambíguo; NF-e por chave; catálogo em lote; recuperação de evento sem documento pai; CNPJ alfanumérico; cobertura de notas emitidas fora do Nalven conforme disponibilidade de cada distribuidor. Não apresentar estas capacidades como prontas.

CT-e: GET autenticado por A1 ao WSDL de produção e homologação retornou HTTP 200, confirmando `cteDistDFeInteresse`, `cteDadosMsg` e SOAPAction do adapter. Após a publicação, a distribuição real retornou código 138, com 10 CT-e e 40 eventos, NSU final/máximo 118. Armazenados em produção com revisão manual; produtos, entradas e títulos permaneceram zerados. Isso não prova recuperação de histórico completo.

Publicação principal concluída em `production-vXhk5hff`, candidato `nalven-production-build.udQAQo`: suíte unitária, lint/build, backup, migration 121 nos bancos demo/Scalon, reconciliação integral de grants e verificação HTTP. Aplicação e timer DF-e ativos. Nunca executar seed em produção.

Correção complementar: o endpoint real ADN `/NFSe/{chave}/Eventos` também retorna a própria nota (`TipoDocumento=NFSE`), inclusive sem eventos. O parser valida a chave e ignora esse registro para contagem de eventos, mantendo a rejeição de documentos de outra nota. A consulta real com o parser corrigido retornou zero eventos/importações, sem erro; a repetição dentro de cinco minutos foi corretamente bloqueada.

Outra resposta real comprovada: GET `/DFe/14` retorna HTTP 404, `NENHUM_DOCUMENTO_LOCALIZADO`, lote vazio e erro informativo `E2220`. O parser reconhece somente essa combinação como ausência de novidades; outras rejeições continuam sendo erros. Consulta executada com código corrigido retornou 137/zero documentos e preservou NSU 14, zerando a falsa falha de certificado.

Publicação complementar concluída: `production-EqBsJWy2`, candidato `nalven-production-build.lmwtVM`. Suíte unitária, lint, build e verificações HTTP passaram. Os arquivos do parser e da rota foram comparados com o candidato publicado. As três fontes estão habilitadas em produção, modo `review`, estado `idle`; os 64 XML permanecem criptografados. Aplicação e timer ativos e habilitados no boot, runtime `nalven-app`. SMTP não foi ativado. Esta entrega não encerra os itens explicitamente pendentes acima.

Contratos oficiais consultados: [serviços CT-e de homologação](https://hom.cte.fazenda.gov.br/portal/webServices.aspx), [manual ADN NFS-e](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-apis-adn-sistema-nacional-nfse.pdf). Não confundir download/captura com emissão ou manifestação fiscal.
