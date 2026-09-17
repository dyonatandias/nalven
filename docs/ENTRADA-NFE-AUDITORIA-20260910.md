# Entrada fiscal — auditoria Scalon Modas

## Evidência em produção

- 64 registros: 12 NFS-e (2 canceladas), 10 CT-e, 42 eventos (2 cancelados).
- Nenhuma NF-e de mercadorias capturada, nenhuma entrada de compra e nenhum produto. Não se deve apresentar os 64 registros como 64 entradas de estoque.
- As 12 NFS-e estavam sem nome de emitente: o parser priorizava `prest` da DPS, resumido, em vez de `emit` da NFS-e autorizada.
- XMLs dos 22 documentos principais decifrados somente em memória; identidade do emitente comparada com o documento persistido antes da atualização.
- 8 fornecedores externos distintos e 8 endereços criados a partir do XML; fornecedores mantidos pendentes de homologação. A própria empresa foi excluída. Correções registradas em `audit_events`.

## Alterações

- Captura futura de documentos completos de produção identifica fornecedores de NF-e, NFS-e e CT-e por CNPJ; eventos, resumos, homologação e a própria empresa não geram fornecedores.
- Importação manual e preparação de NF-e compartilham enriquecimento cadastral: nome fantasia, IE, IM, e-mail, telefone e endereço presentes no XML. Campos já preenchidos são preservados.
- Consulta de CNPJ autenticada, limitada por usuário, com destino fixo BrasilAPI, timeout e limite de resposta. O formulário completa campos vazios; persistência ocorre pelo fluxo existente de salvar e auditar fornecedor.
- Indicadores distinguem registros capturados de entrada operacional. Menu por documento reúne download do XML, consulta de eventos e cópia de chave.

## Limites explícitos

- XML pode não conter telefone, e-mail, município por extenso ou inscrições. Não foram inventados dados ausentes. Consulta BrasilAPI é complementar, não prova fiscal em tempo real nem substituto da homologação.
- Eventos não têm necessariamente razão social; a interface os identifica como eventos a consultar com a nota vinculada, não como fornecedores novos.
- Não houve teste de entrada de estoque com esses 64 registros: não existe NF-e de mercadorias no conjunto. Serviços e fretes não devem fabricar produtos.
- Consulta CNPJ não sobrescreve automaticamente cadastro revisado nem executa atualização periódica em lote. Integração direta Serpro depende de contratação/credenciais; não foi contratada.
- Não foi realizada conferência contábil humana, homologação de fornecedores, manifestação fiscal ou alteração de documentos autorizados.
