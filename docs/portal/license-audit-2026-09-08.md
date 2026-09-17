# Auditoria da licença do portal — 08/09/2026

Escopo: `/portal?area=licenca`, sua API dedicada e os caminhos de cache que autorizam operações licenciadas. A assinatura, a chave e as permissões de usuários existentes não foram alteradas. Nenhuma cobrança, ativação, rotação ou medição de uso foi enviada ao provedor.

## Achados e correções

- A tela anterior dependia do snapshot financeiro e escondia recursos bloqueados/cota zero. Agora consulta somente `GET /api/portal/license`, independente das finanças e do suporte.
- Campos ausentes eram apresentados como ausência de expiração; zero e null não tinham explicação suficiente. Agora datas civis, instantes com zona, datas sem zona, campo ausente, null e zero são distintos. A tela não inventa consumo, validade ou autorização.
- A consulta real confirmou formatos diferentes entre a licença headless (`license.status/recursos`) e a autorização runtime (`success/valida/recursos/limites`). A sincronização misturava esses formatos em `entitlementCache`, podendo bloquear indevidamente o ERP.
- O runtime agora usa um envelope versionado com origem, instante próprio e hash do contexto (empresa, vínculo externo, servidor, produto e segredo cifrado). `lastSyncedAt` financeiro não renova esse TTL. Cache legado, formato headless e respostas malformadas exigem nova consulta autenticada.
- A gravação runtime compara a versão da conta para não aceitar uma resposta anterior a alterações de chave ou sincronização. Booleanos e cotas são estritos; uma validação negativa não libera operações. A sincronização invalida o cache em vez de gravar a resposta headless como autorização.
- Webhooks assinados invalidam o mesmo cache na transação do evento, inclusive para alterações só de licença/recursos. Uma negativa conhecida também impede reutilizar a autorização anterior no processo se a invalidação não puder ser persistida.
- A nova API revalida sessão, perfil, permissão `billing.read` e organização antes do cache. Não depende de `billing.write` nem exige licença válida para consultar a situação.
- Dados públicos são projetados por campos permitidos. Chaves, prefixos, identificadores de instalação e dados pessoais não são enviados pela nova rota nem pelo diagnóstico. A redação do snapshot financeiro legado também foi reforçada para variantes de chave/prefixo.

## Interface implementada

- Estado, início/fim de validade e cota de instalações, sem confundir cota contratada com instalações em uso.
- Plano local e plano remoto em quadros separados; comparação pelo vínculo de código configurado, sem adivinhar equivalência entre módulos ERP e recursos Billing.
- Todos os recursos recebidos, com habilitação, disponibilidade, origem e cota; busca por nome/código, filtros, contagens, ordenação e paginação.
- Exportação JSON sanitizada para atendimento, gerada localmente.
- Cache curto em memória, atualização explícita, revalidação ao voltar ao foco/à área, cancelamento de respostas obsoletas e preservação dos filtros na navegação.
- Tratamento de falha de rede, timeout, resposta inválida, perda de permissão, organização trocada e `Retry-After`. Dados anteriores, quando preservados, são explicitamente indicados como desatualizados.
- Navegação lateral acompanha a URL; não há outro menu de páginas dentro da licença. Layout móvel com campos de 16px e navegação única.

## Validação

- Probe privado e somente de leitura: headless e runtime HTTP 200. Amostra: 35 recursos, 26 cotas null, 8 positivas e 1 zero. Saída restrita a formas, enums e contagens, sem segredos ou identificadores.
- 13 testes do backend da licença passaram.
- 18 testes runtime e 8 do webhook passaram; assinatura real sobre fixtures, persistência mockada, concorrência e invalidação cobertas, sem enviar eventos ao ambiente publicado.
- 13 testes de navegador da licença e do shell passaram, incluindo 320/390px, foco, histórico, zero/null, payload malformado, exportação, cache e abort.
- Regressão: 14 testes de suporte/portal e 9 de autenticação passaram.
- `npm test` completo passou em build protegido: suítes do projeto, ESLint e build Next/TypeScript (4min33s). Suíte focada final: 39 testes de licença/runtime/webhook passaram.
- Publicado em `/srv/nalven/releases/production-P8pGZdsH`; checagens de saúde e bloqueio de acesso anônimo passaram. Nenhuma migração ou seed executado nesta entrega.
- `scripts/verify-license-published.ts` passou contra o site real: GET headless, cache público projetado, timestamp de origem preservado, contexto de empresa, resposta privada/no-store, exportação por campos permitidos, 320/390px sem overflow, navegação ativa e nenhuma consulta financeira.
- A conta vinculada foi confirmada antes de testar o runtime: um comando ERP deliberadamente inválido alcançou a validação local (400), sem registro de produção, após a consulta de autorização e persistência do envelope `nalven-runtime-v1`. Nenhuma mutação foi enviada ao provedor.
- Permissão revogada e perfil suspenso retornaram 403, mesmo com dados em cache; origem externa foi recusada e a API de licença não aceita POST. Os dois usuários, duas roles, perfis e sessões sintéticos foram removidos, com contagens finais zero. Auditoria de login foi preservada.
- Capturas privadas em `outputs/license-published/license-desktop.png`, `license-mobile-320.png` e `license-mobile-390.png`. A pasta de origem é 0700 e as cópias são 0600. Esta seção registra a verificação posterior à selagem do pacote; a cópia imutável do relatório no candidato permanece anterior à publicação.

## Limites e próximos recursos que dependem de integração

- Não há fonte de consumo atual comprovada no GET de licença. Consumo, saldo restante e percentuais exigem métricas locais confiáveis, unidade e período compatíveis; não foram fabricados.
- Rotação de chave é operacional: invalida a anterior, entrega a nova uma vez e exige persistência cifrada e recuperação coordenada. Não foi exposta como autosserviço. O diagnóstico e o suporte permanecem o caminho seguro.
- O cache de autorização continua respeitando o TTL configurado (30–3600 segundos, padrão 300); não equivale a uma garantia de revogação instantânea sem entrega do evento do provedor.
- A proteção em memória após negativa conhecida é local ao processo. Se a invalidação falhar no banco, outro processo pode manter a autorização anterior até o TTL; não há promessa de revogação distribuída instantânea nesse cenário.
- A correspondência de planos é informativa. A tela não altera contrato, não amplia permissões e não reconcilia automaticamente diferenças de configuração.

Detalhes do contrato e evidências: [license-contract-audit.md](license-contract-audit.md). Script de validação publicada: `scripts/verify-license-published.ts`, com identidades sintéticas temporárias, bloqueio de mutações no navegador e limpeza independente.
