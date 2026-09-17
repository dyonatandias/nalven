# Auditoria do contrato de suporte Billing

Data: 08/09/2026. Escopo: `/portal?area=suporte`, integração headless do Billing e regressões de segurança/UX. Esta auditoria não cria chamados, mensagens, anexos, cobranças ou e-mails.

## Fontes verificadas

- Contrato local: [guia normativo 3.0.1](/home/nalven/nalven/vendor/billing-integration/docs/integracao-nalven/INTEGRACAO-HEADLESS-PARIDADE-TOTAL.md:384), seção 5.8; [OpenAPI](/home/nalven/nalven/vendor/billing-integration/integracao/nalven/openapi-headless-v3.yaml:254), rotas de suporte; [schema TicketCreate](/home/nalven/nalven/vendor/billing-integration/integracao/nalven/openapi-headless-v3.yaml:445).
- Transporte/idempotência: [guia normativo](/home/nalven/nalven/vendor/billing-integration/docs/integracao-nalven/INTEGRACAO-HEADLESS-PARIDADE-TOTAL.md:133); [cliente de exemplo](/home/nalven/nalven/vendor/billing-integration/integracao/nalven/headless-billing-client.example.ts:244).
- Fonte remota pública consultada sem autenticação: [manifesto de versão](https://sistema.agenciaexpresso.com.br/integracao-billing-nalven-version.txt) e [pacote de integração](https://sistema.agenciaexpresso.com.br/integracao-billing-nalven.zip). Versão remota `3.1.0`, contrato `3.1.0`, Billing `6.2.0`, build `2026-08-27T12:38:21Z`. SHA-256 do ZIP conferido: `823a5f228852fa23c5ac502d4b7ba27e79f9075d013c457dfeb1a5dd9a0c0912`. A seção de suporte passou a 5.9, mas as seis operações, limites de criação/resposta e anexos permanecem equivalentes. Não foi feita atualização automática do vendor.
- Evidência anterior: [revisão de 06/09](/home/nalven/nalven/docs/portal/review-2026-09-06.md:14) registra envelope de detalhe `{ticket, messages}` e um chamado na leitura real. Os JSONs dessa revisão guardam contagens e resultados de testes, não o schema completo das mensagens/anexos.
- Implementação preexistente inspecionada: `lib/billing/client.ts`, `lib/billing/binary.ts`, `lib/billing/portal-data.ts`, `app/api/portal/billing/route.ts`, `app/api/portal/billing/files/route.ts` e antiga seção `Support` em `app/portal/portal-client.tsx`. Outros agentes estão implementando correções nesses arquivos; os riscos abaixo descrevem a base encontrada, não um atestado da versão final.

## Matriz de operações comprovadas

Todas as rotas são relativas a `/api/v1/saas`. O backend determina `external_id` a partir do vínculo da organização; o navegador não escolhe outro cliente financeiro.

| Recurso | Método e endpoint | Payload/parâmetro comprovado | Resposta comprovada | Limites/gaps |
| --- | --- | --- | --- | --- |
| Lista | `GET /clientes/{external_id}/tickets` | Guia/exemplo admitem `?status=aberto` | HTTP 200, envelope de sucesso | OpenAPI não declara query de status. Não há documentação de cursor, página, total, tamanho máximo da lista ou ordenação de tickets. |
| Criação | `POST /clientes/{external_id}/tickets` | `titulo`, `descricao`; opcionais `categoria`, `prioridade`; `Idempotency-Key` | HTTP 201, envelope de sucesso | Schema de `data` não especificado. Não está documentado qual campo identifica a mensagem inicial criada. |
| Detalhe | `GET /clientes/{external_id}/tickets/{token}` | Token do chamado | HTTP 200; guia promete chamado, mensagens e anexos; revisão anterior observou `{ticket, messages}` | Sem schema normativo das mensagens/anexos, flags de nota interna ou tipo do autor. |
| Resposta | `POST /clientes/{external_id}/tickets/{token}` | `{ "mensagem": "..." }`; `Idempotency-Key` | HTTP 200, envelope de sucesso | Sem enum de status elegível para responder; sem schema normativo do ID da mensagem resultante. Não equivale a uma operação documentada de reabertura. |
| Upload | `POST /clientes/{external_id}/tickets/{token}/anexos` | Multipart `file` + `mensagem_id` inteiro; `Idempotency-Key` | HTTP 201, envelope de sucesso | Arquivo até 5 MB. Documento não especifica autor elegível, limite de anexos por mensagem, schema do anexo ou status de chamado permitido. |
| Download | `GET /clientes/{external_id}/tickets/{token}/anexos?anexo_id=123` | `anexo_id` inteiro | HTTP 200, arquivo binário | Relação cliente/chamado/anexo deve permanecer no proxy e no Billing; download privado `no-store`. |
| Fechar/reabrir/avaliar | Nenhuma rota headless encontrada no guia/OpenAPI local ou no pacote remoto 3.1.0 | Não documentado | Não documentada | Não implementar endpoints imaginados ou enviar `acao`/`status` no payload de resposta. “Avaliar atendimento” existe na descrição do portal central, não no contrato headless verificado. |

### Campos de criação e resposta

| Campo | Tipo/limite documentado |
| --- | --- |
| `titulo` | Texto, 5–255 caracteres, obrigatório |
| `descricao` | Texto, 10–10.000 caracteres, obrigatório |
| `categoria` | `pagamento`, `tecnico`, `funcionalidade`, `integracao`, `duvida`, `reclamacao`, `sugestao`, `outro` |
| `prioridade` | `baixa`, `media`, `alta`, `urgente` |
| `mensagem` | Texto, 1–10.000 caracteres, obrigatório ao responder |

Os defaults `duvida`/`media` existem no validador NALVEN preexistente; o OpenAPI não declara esses defaults como comportamento do Billing. O contrato não autoriza acrescentar destinatário, autor, nota interna, organização, produto ou atribuição operacional ao payload recebido do navegador.

### Anexos

O [contrato](/home/nalven/nalven/vendor/billing-integration/docs/integracao-nalven/INTEGRACAO-HEADLESS-PARIDADE-TOTAL.md:414) permite PDF, TXT, CSV, JPEG, PNG e WebP, exige concordância de extensão/MIME/assinatura e análise antivírus antes de persistir. Antivírus indisponível produz `503 ANTIVIRUS_INDISPONIVEL`. A documentação não prova antivírus operacional hoje: isso não foi testado por upload real nesta auditoria.

O proxy NALVEN inicial limita arquivo a `5 * 1024 * 1024` bytes e multipart a `6 * 1024 * 1024` bytes, confere MIME e assinatura, mas a base inspecionada não confronta extensão/MIME. O ID da mensagem era texto livre, sem verificar localmente se a mensagem pertence ao chamado e ao cliente. A UI escolhia a última entrada recebida com `autor_tipo === "cliente"`; isso é uma convenção do cliente preexistente, não prova normativa de autoria nem de ordenação.

## Idempotência, erros e limites

O [contrato HTTP](/home/nalven/nalven/vendor/billing-integration/docs/integracao-nalven/INTEGRACAO-HEADLESS-PARIDADE-TOTAL.md:135) exige `Idempotency-Key` em POST/PUT/PATCH, inclusive multipart:

- Máximo de 200 caracteres; retenção padrão de 24 horas.
- Mesma chave e payload: repetir a resposta persistida.
- Mesma chave com payload diferente: 409.
- Comando concorrente com mesma chave: 409 e `Retry-After: 2`.
- Timeout/5xx: preservar a identidade do comando; não gerar nova chave para a mesma tentativa.
- Arquivo ou texto editado depois de uma falha é payload diferente; não reutilizar inadvertidamente a chave daquele payload.

| HTTP | Tratamento comprovado/recomendado pelo contrato |
| --- | --- |
| 200/201 | Operação confirmada; falha posterior de atualização não transforma o envio em não executado. |
| 400/422 | Corrigir dados/regra; não repetir indefinidamente sem alteração. |
| 401/403 | Interromper; erro de credencial/escopo/rede, não solicitar login do usuário no Billing. |
| 404 | Recurso ou vínculo indisponível no escopo do produto/cliente. |
| 409 | Distinguir conflito da espera idempotente quando houver `Retry-After`; não presumir que significa duplicação concluída. |
| 429 | Respeitar `Retry-After`. |
| 500/502/503 | Indisponibilidade; repetir somente com a mesma identidade e backoff. |

O contrato também menciona 202 para gateways financeiros; não há resposta 202 específica de tickets no OpenAPI. Não apresentar chamado “criado” a partir dessa convenção financeira sem resposta de suporte validada.

O exemplo normativo de produção informa limite de 300 requisições/minuto por credencial, compartilhada com outras operações do produto. Isso não comprova a configuração efetiva da credencial atual. O cliente JSON local usa timeout de 10 s; binários/multipart, 15 s e resposta máxima de 10 MB. Na implementação inicial, o `Retry-After` era lido pelo cliente JSON, mas não repassado por `failure()` do portal; o transporte binário também não o propagava.

## DTOs e pendências verificadas

O [OpenAPI Envelope](/home/nalven/nalven/vendor/billing-integration/integracao/nalven/openapi-headless-v3.yaml:467) usa `data: {}`. Não existem `Ticket`, `TicketMessage` ou `TicketAttachment` tipados nos dois arquivos `types.ts` examinados. O cliente retorna `Record<string, unknown>` para essas operações.

Uma consulta sanitizada foi preparada em [probe-support-contract.ts](/home/nalven/nalven/scripts/probe-support-contract.ts). Ela localiza somente a conta associada ao `configKey=demo`, usa GET da lista e de até três detalhes, imprime apenas schema, contagens e valores controlados de enum/flags, e desconecta o banco no final. Não chama o agregador do portal nem emite mutações. A execução exige o ambiente privado do serviço; não transportar segredos para o workspace ou terminal.

### Leitura real sanitizada executada em 08/09/2026

O responsável pela execução rodou o probe sob o `EnvironmentFile` privado do serviço. Foram lidos um chamado e seu detalhe, com uma mensagem; nenhum texto, identificador, token, nome, URL ou credencial foi incluído no resultado compartilhado.

O GET da lista retornou este schema observado:

```text
{
  tickets: [{
    token: string,
    numero_ticket: string,
    titulo: string,
    descricao: string,
    status: string,
    prioridade: string,
    categoria: string,
    sla_horas: number,
    sla_excedido: boolean,
    avaliacao: null,
    created_at: string,
    updated_at: string,
    total_mensagens: number,
    ultima_mensagem: string
  }]
}
```

O detalhe retornou `{ticket, messages}`. `ticket` contém os campos acima, exceto `total_mensagens` e `ultima_mensagem`; a mensagem observada tem:

```text
{
  id: number,
  autor_tipo: string,
  autor_nome: string,
  mensagem: string,
  created_at: string,
  anexos: []
}
```

Enums observados: `status=aberto`, `prioridade=media`, `categoria=duvida`, `autor_tipo=cliente`. A amostra não contém flags de visibilidade/interno, metadados de paginação ou anexos. Esses resultados comprovam a forma dessa resposta real, não um enum completo nem todas as variantes permitidas pelo serviço.

Persistem as seguintes lacunas verificadas:

1. Schema de anexo e envelopes das respostas de criação/resposta/upload — GET com anexos vazios não os comprova.
2. Enum completo de status, transições e tipo de `avaliacao` quando preenchida. Não há operação headless de avaliação documentada.
3. Campo/semântica de nota interna e público-alvo das mensagens. A ausência da flag na mensagem de cliente não prova que toda mensagem retornada em outras situações seja pública.
4. Outros tipos de autor e regras upstream para anexar; comportamento em chamado encerrado. A mensagem amostrada é `cliente`, sem provar identidade de um usuário NALVEN individual.
5. Paginação/limite remoto de suporte: uma resposta com um registro, sem metadados, não comprova histórico ilimitado/completo.
6. `sla_horas` e `sla_excedido` existem; não foi observado deadline de SLA. Não calcular contagem regressiva ou prometer prazo de resolução usando um marco temporal presumido.

Não converter ausência de campo em permissões inventadas, nem uma coleção malformada em “nenhum chamado”. Filtragem/paginação local deve ser apresentada como aplicada aos registros carregados.

## Riscos concretos encontrados na base e regressões essenciais

Os [testes anteriores](/home/nalven/nalven/tests/portal-data.test.ts:5) preservam `messages` e removem alguns segredos. Eles não comprovam o contrato upstream completo, autoria de anexos, isolamento de notas internas ou retentativa de suporte. A validação de 06/09 informa que mutações foram apenas interceptadas, sem envios reais.

Regressões de API/transporte a exigir nesta rodada:

- Sem sessão, perfil suspenso e permissão somente leitura; `external_id` sempre vem da organização autenticada, inclusive download/upload.
- Recurso/token/anexo de outro chamado ou mensagem de atendente não permite upload, mesmo com ID manipulado.
- Campos desconhecidos e dados internos de ticket/mensagem/anexo não atravessam uma DTO pública por mero spread/blacklist.
- JSON/form inválidos, arrays/objetos em campos de texto, IDs booleanos/fracionários, limites reais de corpo, arquivo vazio/excessivo, extensão/MIME/assinatura divergentes.
- 409/429 preservam `Retry-After`; erro não JSON/5xx não expõe resposta interna, stack, segredo ou URL autenticada.
- Mesma tentativa após resposta perdida preserva chave; alterações de texto/arquivo recebem identidade distinta; dupla submissão síncrona não gera dois comandos.
- Título/status desconhecidos são apresentados com fallback seguro, sem ocultar silenciosamente um chamado legítimo.

Regressões de interface:

- Abrir A, abrir B, receber A por último: B permanece selecionado; sair/alterar organização limpa dados e aborta leituras antigas.
- Busca/filtros não apagam a seleção ou o rascunho inadvertidamente; total local não é apresentado como total remoto.
- Criação/resposta confirmada com GET posterior falhando: informar “enviado, atualização pendente”, sem incentivar nova criação.
- Upload com erro conserva o arquivo/rascunho recuperável e informa o erro no mesmo contexto; anexo aponta para mensagem verificada, não apenas a última posição do array.
- Conteúdo extenso, nomes de arquivos e URLs não causam overflow a 320/390 px; detalhes têm foco/restauração/escape e rolagem acessíveis.
- Suporte permanece utilizável quando faturas, catálogo ou licença estão indisponíveis; somente leitura oculta/bloqueia escrita sem ocultar os próprios chamados.

Não foram executados testes de criação/resposta/anexo reais para preencher lacunas do contrato.
