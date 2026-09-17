# Auditoria e implementação — Biblioteca

Data: 03/09/2026  
Rota: `/erp/biblioteca`

## Diagnóstico inicial

A página possuía upload seguro, pastas, filtros básicos, edição de nome/texto alternativo, lixeira e reutilização pelo catálogo. A auditoria identificou ausência de paginação, busca reativa, visão de capacidade e qualidade, favoritos por usuário, etiquetas, metadados descritivos, seleção em lote, histórico de versões, detalhamento de vínculos, detecção de duplicidade, preview de documentos/vídeos, expiração, exclusão definitiva controlada e resposta HTTP parcial para mídia.

Também foram encontrados quatro riscos operacionais: listagem limitada silenciosamente a 200 itens, falhas inesperadas expondo mensagens internas, downloads locais carregados integralmente mesmo quando o navegador solicitava um intervalo e arquivos da lixeira sem preview para usuários autorizados da biblioteca.

## Resultado implementado

- Central visual responsiva com hero operacional, KPIs de volume, capacidade, limpeza, favoritos e acessibilidade/SEO.
- Busca reativa com debounce, paginação, ordenação, filtros por tipo, pasta, etiqueta, favorito, sem uso, texto alternativo ausente e lixeira.
- Visualização em grade ou lista, estados de carregamento, vazio, erro e confirmação acessíveis.
- Favoritos pessoais, descrições, etiquetas normalizadas, origem, expiração e versão corrente persistidos.
- Seleção de página e ações em lote para mover, restaurar ou enviar à lixeira, com bloqueio de mídias em uso.
- Detecção de conteúdo duplicado por SHA-256 no upload e indicação de cópias já existentes.
- Painel detalhado com preview, metadados, vínculos por contexto, versões anteriores, auditoria e link interno protegido.
- Nova versão com preservação do arquivo anterior, nota da alteração, validação de tipo e cota de armazenamento.
- Lixeira restaurável e exclusão definitiva apenas após confirmação e somente sem vínculos.
- PDFs abertos em preview, vídeos com controles e suporte a `Range`, `206`, `Content-Range` e `416` para reprodução eficiente.
- Respostas privadas sem cache para dados de catálogo, autorização por tenant/permissão, proteção de origem nas mutações, isolamento físico e mensagens 500 sanitizadas.
- Seletor de mídia preservado para os fluxos existentes de produto, galeria, vídeo e download.
- Tipografia sem microtexto no novo módulo, alvos de toque adequados, foco visível, navegação por teclado, redução de movimento e layouts específicos até 420 px.

## Persistência e cenários de demonstração

A migration `20260903195000_media_library_control_center` adiciona favoritos, versões, metadados e restrições de integridade. O seed protegido e idempotente cria pastas e simulações de imagens, PDFs, CSV, TXT, vídeos, favoritos, duplicidade, expiração, lixeira e versionamento, além de enriquecer as imagens do catálogo.

## Gates de aceite

- Testes de domínio e contrato da biblioteca.
- TypeScript sem erros.
- ESLint global sem erros ou warnings.
- Suite unitária global.
- Build de produção.
- Migration aplicada primeiro em clone descartável da base produtiva.
- Backup anterior ao deploy, migration/seed em produção e smokes autenticados de página e APIs.
