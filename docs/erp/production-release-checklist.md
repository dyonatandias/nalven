# Publicação e aceite de produção/kits

## Limites da validação local

Os testes transacionais locais usam `production_test` e `production_control_test`, em PostgreSQL descartável. Não há usuários, credenciais, saldos ou configurações comerciais de empresas reais nesses fixtures. Depois desses testes, o gate completo também passou com configuração real e a versão foi publicada em 2026-09-07: `/srv/nalven/releases/production-80N23w4f`.

A revisão complementar de interface substituiu esse release por `production-vyUnWIBT`, sem novas migrations. Aceite atualizado em [ux-followup.md](ux-followup.md).

O harness testa produção/recebimento com serviços reais e o menu com componentes reais, adaptando a navegação do Next. O aceite adicional `scripts/verify-production-published.ts` passou com login real, leituras integradas de inventário/expedição/compras, navegação Next, desktop/celular e perfis operador/leitor/suspenso. Identidades temporárias removidas; nenhuma movimentação comercial foi feita no tenant real para testar. Evidências em [production-completion.md](production-completion.md).

## Preparação administrativa

1. Identificar o release atualmente publicado, os tenants ativos e as migrations pendentes de cada banco. Conferir separadamente migrations de outras frentes existentes no checkout; esta revisão não autoriza executá-las sem revisão.
2. Confirmar backup recente e recuperável antes das alterações de banco; registrar o release anterior e o procedimento de reversão.
3. Preparar um build com as configurações apropriadas do ambiente de destino. Não publicar cegamente o artefato gerado com o banco de controle descartável.
4. Usar a autoridade migrator e o executor instalado/validado do servidor. Não disponibilizar credenciais no chat, copiar segredos para o checkout ou contornar a separação entre usuário runtime e migrator.
5. Revisar o fluxo de deploy escolhido: `deploy/deploy-release.sh` executa seeds de controle/tenant e reconciliação de outras autoridades; não é um publicador exclusivo deste módulo. `deploy/publish-security-release.sh` é específico de outro snapshot e recusa migrations pendentes. Nenhum dos dois foi executado nesta revisão.

## Migrations desta ampliação

Aplicar na ordem, pelo mecanismo de migration do ambiente, preservando o histórico Prisma:

1. `20260908090000_production_operations`
2. `20260908100000_production_evidence_guards`
3. `20260908110000_production_purchase_dimensions`
4. `20260908120000_purchase_receipt_evidence`
5. `20260908130000_supply_operations_permissions`

As cinco foram aplicadas no único tenant ativo, `nalven_t_demo`, após backup bem-sucedido e conferência dos checksums. Runtime e migrator continuam separados. Manutenção restrita documentada em [production-maintenance.md](production-maintenance.md).

As composições antigas são importadas como uma revisão explícita; isso não reconstrói revisões históricas inexistentes nem inventa apontamentos antigos. As migrations adicionais não recalculam saldos históricos. Conferir ordens antigas em andamento e necessidade de reserva antes do primeiro apontamento no novo fluxo.

## Aceite após publicação

- `/` responde 200; `/api/erp` responde 401 sem sessão; `/api/saas` responde 403 sem autoridade de superadmin.
- Rotas de produção recusam ausência de sessão e POST de origem externa; respostas privadas não são armazenadas por cache público.
- Com usuários de homologação: leitor consulta sem alterar; operador não compra/transfere sem os escopos adicionais; perfil suspenso/vencido e vínculo de outra empresa são recusados; licença bloqueada impede escrita.
- Menu: página ativa única, visível após navegar; rodapé compacto; modos completo/ícones/oculto; abertura/fechamento no celular, Escape, foco e acesso por teclado. Navegação real do Next, voltar/avançar e troca de empresa não exibem dados do contexto anterior.
- Fluxo controlado: ficha aprovada → ordem → reserva → apontamento parcial → quarentena → inspeção/certificado → fechamento/liberação de reservas.
- Compra MRP com variação: recebimento parcial no depósito da ordem → saldo por variação/lote → reserva/consumo; repetir a confirmação após resposta perdida não duplica entrada nem conta a pagar.
- Conferir inventário/expedição integrados com o novo saldo, listas extensas, filtros e visualização em celular. Não usar apenas o teste de menu com serviços indisponíveis como prova desses fluxos.
- Registrar release, migrations aplicadas e evidências do aceite; somente então marcar a ampliação como concluída.
