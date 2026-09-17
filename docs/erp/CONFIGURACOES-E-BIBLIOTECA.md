# Configurações e biblioteca do ERP

## Configurações persistidas

As preferências são isoladas por organização em `TenantSettings`; não há fallback de interface em JSON ou `localStorage`, exceto o estado pessoal do menu lateral. A API `/api/erp/settings` aplica validação, controle otimista de versão, autorização e auditoria.

- **Empresa e aparência:** nome comercial, fuso horário, telefone, logotipo da biblioteca, cor de destaque, densidade e modo inicial do menu.
- **Vendas e estoque:** cliente e pagamento padrão, cliente obrigatório, SKU automático, estoque negativo, alertas, validade de orçamento e desconto máximo.
- **Notificações:** destinatário operacional, resumo diário, horário e eventos financeiros/comerciais.
- **Documentos:** rodapés de orçamento e recibo, além de termos e condições.
- **Segurança e dados:** retenção de auditoria e contato de privacidade/LGPD.

As configurações operacionais são consumidas pelo PDV, catálogo, estoque e pedidos. Alterações de aparência são aplicadas ao shell do ERP após salvar.

## Biblioteca de mídias

Os arquivos permanecem em armazenamento privado por tenant e são entregues somente pela rota autenticada. Metadados, pastas e vínculos ficam no PostgreSQL.

Pastas de sistema criadas automaticamente: `Geral`, `Identidade visual`, `Produtos`, `Clientes`, `Fornecedores`, `Documentos fiscais`, `Contratos`, `Marketing` e `Temporários`. Elas podem receber uma cor, mas não ser renomeadas nem excluídas. Pastas personalizadas possuem CRUD completo; sua exclusão transfere os arquivos para `Geral`.

O seletor reutilizável abre como modal sobre a página, com busca, filtros, upload múltiplo, arrastar e soltar, progresso, pré-visualização e edição de metadados. Produtos e logotipo usam o mesmo componente. Uma mídia vinculada não pode ir para a lixeira até que seus usos sejam removidos.

## Controles de navegação

O menu salva sua rolagem e modo (`expandido`, `compacto` ou `fechado`) por usuário no navegador. Ao trocar de página, o item ativo permanece destacado e visível. Em telas móveis o menu abre como painel sobreposto e fecha após a navegação.

## Verificação

Execute `npm run lint`, `npx tsc --noEmit` e `npm test`. Para conferir as migrações de um banco tenant, carregue a URL daquele tenant e execute `npx prisma migrate status --config prisma.tenant.config.ts`.
