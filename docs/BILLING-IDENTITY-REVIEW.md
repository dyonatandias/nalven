# Identidade Billing — 9 de setembro de 2026

## Correções

- Cadastro, criação de conta e fallbacks do portal usam `organization.id`, não slug. Atualização de cliente rejeita mudança de `external_id`/`instance_id`. Conclusão de provisionamento não altera o identificador de contas existentes.
- Antes de chamar o Billing, o worker exige documento válido e correspondente à organização, e-mail válido igual ao cadastro e ID interno consistente entre job/conta/organização. Divergências param antes de chamadas remotas. Igualdade entre produtos é validada pelo Billing, não pode ser inferida localmente.
- HTTP 409 é terminal independentemente de `Retry-After` e de corpo JSON inválido. Não existe mais reconciliação/rotação de licença no tratamento de 409. Reprocessamento manual e reconciliação não reabrem job com `HTTP_409`; jobs antigos nessa condição são encerrados sem outra chamada. Corrigir o vínculo no painel Billing antes de qualquer liberação administrativa revisada da fila.
- Configuração e transporte exigem caminho HTTPS `/api/v1/saas`; `/api/external/*` não é aceito. Proteção de destino público e confirmação administrativa continuam ativas.
- Webhooks procuram a conta pelo identificador congelado ou a organização pelo ID interno. Mudança de slug não muda roteamento; uma segunda identidade não sobrepõe o vínculo existente.
- `/admin/integracoes` explica as regras, sinaliza contas legadas e conflitos e não apresenta jobs terminados como agendados.

## Situação encontrada e limites

A consulta somente leitura encontrou apenas `org-demo` (Vitrine Moda — Demo), vinculada ao plano privado inativo `fashion-demo`. O Billing desta organização usa identificador legado diferente do ID interno. Não foi renomeado, reprovisionado, nem criada segunda instância. Licença, assinatura e cobranças remotas não foram alteradas. Regularização do legado exige coordenação administrativa com o Billing; não basta substituir o ID no banco local.

Não existe organização DENIZE BATISTA FRANCO. O plano solicitado depende da confirmação do cliente proprietário (organização existente ou nova). Para organização nova, falta CPF/CNPJ completo e e-mail canônico do responsável. `62.119.226` não é CPF/CNPJ completo. Exclusões solicitadas: serviços (confirmar Ordens de serviço), compras/cotações, produção/kits, contas/caixas e conciliação bancária. Não remover Fechamento de caixa nem outros recursos por associação de nome; manter os demais acessos do plano-base escolhido.

Não foi criado cliente fictício, alterado cadastro da demonstração ou criado plano público no lugar de exclusivo para contornar a propriedade obrigatória.

## Validação e publicação

31 testes de navegador e 31 testes administrativos passaram, além das suítes de segurança, suporte/provisionamento e licença/webhooks. O publicador repetiu a suíte completa, lint e build antes de publicar a release `/srv/nalven/releases/production-6nXPy5E5`, a partir do candidato `/var/lib/nalven-production-build.9tQETE`. Hashes do cadastro e worker conferidos entre checkout e candidato. Backup e verificação HTTP concluídos pelo publicador; nenhuma migration nova. As validações de conflito usaram provedores simulados, sem criar instâncias ou cobranças reais.
