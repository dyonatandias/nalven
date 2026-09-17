# Central de suporte — auditoria e implementação

Escopo: `/portal?area=suporte`. Data: 08/09/2026.

## Implementação

- Central independente do agregador financeiro: falhas em faturas, catálogo ou licença não impedem a consulta aos chamados.
- Lista com protocolo, status, categoria, prioridade, busca, ordenação e paginação dos registros recebidos. Coleções parciais são identificadas; não há total remoto inventado.
- Histórico cronológico com descrição inicial, identificação do autor e anexos. Mensagens internas e campos administrativos não são expostos pela projeção pública.
- Formulário de abertura com validação, categoria e prioridade; diálogo acessível por teclado. Respostas com contagem de caracteres e rascunhos por chamado preservados em memória durante a navegação.
- Upload com escolha explícita de mensagem pública do cliente, progresso real de transferência, validação de tamanho, extensão, MIME e assinatura. Download verifica vínculo do anexo ao chamado e força resposta privada.
- Retentativas preservam dados e identificador da operação. JSON inesperado não confirma envio; `Retry-After` controla a espera. Uma consulta posterior com falha não transforma envio já confirmado em nova operação. Encerrar uma tentativa incerta exige revisão explícita e avisa que isso não cancela uma operação já recebida pelo serviço.
- Cache de lista no servidor por 15 segundos, limitado e separado por organização/cliente, com compartilhamento de consultas simultâneas, invalidação antes/depois das mutações e atualização manual explícita. Permissões são verificadas a cada requisição, fora do cache.
- Leituras antigas são canceladas; atualização periódica pausa fora da área, quando a aba não está visível ou durante envio. Dados privados não são gravados em armazenamento persistente do navegador.
- Área ativa acompanha a URL, inclusive voltar/avançar. Navegação móvel única, cabeçalho e rodapé compactos, link para pular ao conteúdo e tratamento recuperável de falha ao sair.

## Segurança e compatibilidade

Permissões existentes `billing.read` e `billing.write` preservadas. Nenhuma permissão real foi ampliada; o identificador financeiro sempre vem da organização autenticada. O cabeçalho de contexto do navegador detecta abas de organização antiga, sem substituir a autorização do servidor.

Mutações mantêm proteção de origem, limites persistentes de requisição, limites de corpo e auditoria. Rotas antigas de chamados reutilizam os validadores novos. Chaves idempotentes longas usam hash da identidade completa, mantendo compatibilidade com chaves curtas já emitidas. Transportes JSON e multipart exigem confirmação explícita do serviço.

O documento do portal usa `no-referrer` e `no-store`. Anexos privados também recebem `nosniff`, política de conteúdo restritiva e isolamento de origem.

## Limites comprovados da integração

O [contrato auditado](./support-contract-audit.md) oferece seis operações: listar, detalhar, abrir, responder, anexar e baixar. Fechar/reabrir, avaliar atendimento, atribuir atendente e alterar status não têm endpoint headless documentado. Não foram adicionados botões sem operação real correspondente.

SLA é exibido somente nos campos fornecidos pelo serviço, sem calcular prazo presumido de resolução. A amostra real não continha anexos, e não foi enviado arquivo para testar o antivírus remoto. Envelopes de escrita e variantes de anexos são cobertos com simulação do contrato, não por mutações reais em produção.

Rascunhos e tentativas pendentes ficam somente na memória da página. Recarregar/fechar a página não oferece recuperação persistente do texto ou arquivo; após uma falha incerta, conferir o histórico antes de iniciar novo envio continua importante.

## Validação

Comandos reproduzíveis:

- `npm run test:support`: DTOs, rotas reais com dependências simuladas, isolamento de organização, autorização, anexos, cache concorrente, idempotência e transportes reais com rede simulada.
- `npm run test:support:browser`: fluxos de interface isolados, inclusive shell real do portal e estilos globais.
- `npm test`: suíte completa, lint e build de produção.
- `scripts/probe-support-contract.ts`: leitura sanitizada do contrato real, sem texto/IDs/tokens na saída.
- `scripts/verify-support-published.ts`: validação autenticada publicada com identidades/perfis temporários, GETs reais e comandos locais inválidos. Não cria chamados, respostas, anexos ou e-mails; remove apenas os registros sintéticos ao terminar.

Resultados já verificados nesta revisão: 32 testes focados de suporte/transporte/idempotência, 60 de segurança, 14 cenários de navegador de suporte/portal e 9 de regressão de autenticação aprovados. Os cenários de escrita usam transporte simulado, inclusive erros 2xx malformados, 409/429, conexão perdida e upload `null`.

`npm test` integral aprovado no ambiente de build protegido: testes unitários, ESLint, TypeScript e build Next.js concluídos com código 0. Uma incompatibilidade de tipo entre Buffer e BodyInit no teste de upload foi corrigida; o cenário de upload e a validação integral foram repetidos com sucesso.

## Publicação e conferência real

Publicado em `/srv/nalven/releases/production-NMOjeQtR`, a partir do candidato selado `/var/lib/nalven-production-build.9YRSzQ`. O publicador conferiu integridade e checksums das migrations; nenhuma migration ou seed foi executado. O arquivo histórico de migration já divergente no checkout foi preservado no workspace; no empacotamento foi usado o SQL original aplicado, sem modificar o histórico do banco.

Verificações HTTP: `/` 200, `/api/erp` 401, `/api/saas` 403, endpoints privados de produção 401 e mutação de origem externa 403.

`verify-support-published.ts` concluiu com código 0 e `SUPPORT_PUBLISHED_OK`: lista/detalhe reais, navegador desktop e 320/390 px, modal, ausência de consultas financeiras na área de suporte, cabeçalhos privados, perfil somente leitura, contexto de organização incorreto, CSRF e revogação de perfil/permissão mesmo com cache ativo.

Foram removidos os dois usuários, perfis, sessões e dois papéis sintéticos usados na verificação. A consulta final confirmou ausência desses registros; apenas a auditoria de login foi preservada. Nenhum chamado, resposta, anexo, cobrança ou e-mail real foi criado. Mutações originadas pela interface foram bloqueadas no navegador de teste antes de alcançar o servidor.

Capturas: [desktop](../../outputs/support-published/support-desktop.png), [320 px](../../outputs/support-published/support-mobile-320.png) e [390 px](../../outputs/support-published/support-mobile-390.png). A cópia do relatório dentro do candidato imutável registra a fase pré-publicação; este documento registra o resultado posterior.
