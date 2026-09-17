# Construtor de planos — revisão de 9 de setembro de 2026

## Escopo implementado

`/admin/planos` separa catálogo, identificação, permissões e resumo. O catálogo oferece busca por nome/código/cliente, filtros de visibilidade e disponibilidade, seleção e duplicação para outro cliente. A cópia preserva preços, capacidade e permissões, mas não reutiliza código, versão ou vínculos do plano original.

Os 38 recursos reconhecidos pelo autorizador são agrupados em cinco áreas. Consulta, alteração e menu continuam sendo os limites reais de autorização; não foram inventadas permissões granulares de exclusão ou exportação. Ações em lote afetam somente o filtro atual. Desativar consulta remove alteração e menu. A prévia mostra os menus previstos pelo plano, não promete sobrepor perfil ou licença.

O editor mantém valores numéricos vazios como campos obrigatórios, alerta sobre alterações não salvas ao trocar/descartar plano ou recarregar a página, bloqueia ações durante gravação e confirma o impacto em organizações vinculadas. A proteção de saída não intercepta toda navegação programática do Next.js. Planos legados exibem aviso e preservam seus acessos efetivos na conversão.

A API continua exigindo superadministrador, origem válida, limite de requisições, validação de entrada, versão concorrente, exclusividade e no máximo três planos públicos. Gravação, propagação dos recursos e auditoria permanecem na mesma transação. A resposta agora inclui o plano salvo, permitindo reutilizar a versão correta na próxima edição. A proteção de capacidade permanece no banco.

## Limites intencionais

- Referências de preço não emitem cobranças nem modificam assinaturas externas.
- Duplicar não atribui automaticamente o novo plano ao cliente.
- Indisponibilidade bloqueia novas atribuições; não cancela contratos existentes.
- Nenhuma nova migration ou configuração SMTP é necessária.
- Esta entrega é da página de planos; não declara concluída a auditoria de todo o ERP.

## Verificação

- Testes de política cobrem agrupamento completo sem duplicatas, dependências, preservação de recursos fora do filtro e prévia.
- Testes de navegador cobrem criação/conflito, duplicação, confirmação de descarte, ações em lote e largura de 320 px; capturas desktop/mobile ficam em `test-results`.
- Build executado contra banco descartável com as 17 migrations de controle: `/tmp/nalven-admin-build.xzHAer` (cluster encerrado).
- 31 testes de política/API e 30 testes de navegador passaram. ESLint passou; um bundle gerado de diagnóstico antigo foi movido de `outputs` para `/tmp/nalven-generated-diagnostic.990ynE`, sem excluir código-fonte.
- Homologação nativa: login real, 25 destinos, criação/atribuição exclusiva, proteção entre clientes e permissões do proprietário; zero exceções JavaScript e zero falhas inesperadas de API. Evidência em `/tmp/nalven-native.8IQecF`; processos de teste encerrados.
- Publicação deve passar pelo publicador instalado, com testes, build, backup e verificação; não editar a release em execução.

## Publicação confirmada

Release ativa: `/srv/nalven/releases/production-bbe1Ee1T`, candidato selado `/var/lib/nalven-production-build.WSvAA1`. SHA-256 do editor e CSS conferidos entre checkout e candidato. O publicador concluiu com `PUBLICATION_OK`; verificação independente confirmou `/` 200, `/api/erp` 401 e `/api/saas` 403 sem autenticação, além das rotas protegidas de produção 401. `nalven.service` está ativo. Houve uma tentativa de conexão recusada durante a janela de reinício; as tentativas seguintes e a checagem independente passaram. A checagem autenticada da interface foi realizada em homologação isolada, não com uma conta real de produção.
