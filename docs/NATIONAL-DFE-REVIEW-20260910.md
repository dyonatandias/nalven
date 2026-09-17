# Captura nacional de documentos fiscais — 10/09/2026

## Fontes oficiais verificadas

- Manual dos Contribuintes ADN, versão 1.0 de 12/02/2026: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-apis-adn-sistema-nacional-nfse.pdf
- Catálogo atual de produção NFS-e: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual
- OpenAPI ADN consultado com autenticação mTLS: https://adn.producaorestrita.nfse.gov.br/contribuintes/swagger/v1/swagger.json
- NF-e, serviço nacional: https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx
- Catálogo NF-e anuncia NT 2014.002 v1.40 de 03/07/2026. O download direto dessa versão retornou loop de redirecionamento nesta investigação; não alegamos homologação completa do CNPJ alfanumérico.

## Distinção de escopo

NF-e de mercadorias (modelo 55) e NFS-e de serviços são integrações nacionais distintas. Consultar o ADN não depende de login do contador no portal de Goiás. O manual do ADN contempla emitente, tomador e intermediário, com certificado da mesma raiz de CNPJ. Não se deve transportar automaticamente para NFS-e a janela de histórico da distribuição NF-e, nem assumir que a centralização substituiu todos os autorizadores estaduais/municipais.

## Defeitos corrigidos

- ADN passa `cnpjConsulta` e `lote=true`, não `CNPJ`.
- Interpretação explícita de `StatusProcessamento`, `LoteDFe`, `NSU`, `TipoDocumento`, `ChaveAcesso`, `ArquivoXml` (GZip/base64).
- Cursor ADN deriva do maior NSU efetivamente recebido; o contrato oficial não contém `ultNSU/maxNSU`. Erros, contratos desconhecidos, chave divergente, lote inconsistente e XML ausente não equivalem a ausência de documentos.
- HTTP 404 com corpo passa pelo parser, sem ocultar rejeição como zero documentos.
- Preservação do destinatário real: a filial consultante pode ser emitente e não destinatária.
- Eventos são vinculados à NFS-e existente na mesma filial, sem sobrescrever seu XML; cancelamento `e101101` atualiza a situação da nota. Evento sem nota vinculada bloqueia o lote e preserva o cursor para revisão.
- NF-e aguarda uma hora após 137 ou esgotamento do NSU; consultas manuais e concorrentes respeitam o horário. Reconfigurar a fonte não apaga a espera.
- Interface distingue NFS-e emitida, recebida e com participação da empresa; serviços não criam produtos físicos automaticamente.

## Prova real, escopo Scalon Modas

Banco exclusivo `nalven_t_scalon_modas`, matriz 1. Executor revisado usa usuário de runtime e credenciais existentes; nenhuma credencial foi adicionada ao repositório.

Consulta ao ADN em produção e importação transacional: 14 registros, sendo 12 NFS-e (2 emitidas e 10 recebidas) e 2 eventos de cancelamento. Histórico observado de agosto/2025 a agosto/2026. Cursor persistido em 14, XMLs criptografados e eventos auditados. Duas NFS-e canceladas. Não se presume que esse lote represente todo o histórico fiscal fora do ADN.

Nova consulta NF-e de mercadorias retornou 137, NSU zero, nenhum documento disponibilizado. Nenhuma nota foi emitida ou manifestada; zero produtos, lançamentos de recebimento e movimentações de estoque gerados. Fontes configuradas em modo de conferência, sem recebimento automático.

## Limites explícitos

Captura/armazenamento não substituem parametrização de emissão, autorização de manifestação do destinatário ou regularização de licença Billing. Consulta de eventos por chave no ADN está documentada, mas não foi criada uma nova ação avulsa de consulta nesta entrega; os eventos do lote foram processados. CT-e exige sua própria integração e não foi homologado. Notas de mercadorias ainda não disponibilizadas na distribuição não podem ser inventadas a partir de NFS-e.

Arquivo operacional `scripts/check-scalon-national-dfe.ts`: restrito ao CNPJ/organização, respeita espera e não emite notas. O executor compilado de diagnóstico não substitui a publicação web.

## Publicação e validação

Publicação concluída e verificada em `/srv/nalven/releases/production-gSXIetm3`, candidato selado `/var/lib/nalven-production-build.2riwii`. Suite de testes, lint, TypeScript e build passaram no publicador instalado. Os 11 testes de NF-e/ADN também passaram isoladamente. O build local com URL fictícia falhou na geração de páginas por falta de banco; o publicador completou essa etapa com consultas somente de leitura à configuração real. Hash do sincronizador conferido entre checkout e candidato. Saúde após publicação: `/` 200, APIs protegidas 401/403; serviço web e timer DF-e ativos. Nenhuma migration nova foi criada nesta entrega.
