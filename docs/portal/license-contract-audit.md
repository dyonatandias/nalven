# Licença do portal — auditoria do contrato

Data: 2026-09-08. Escopo: leitura do contrato primário, comparação das fontes de licença e avaliação de ações seguras para `/portal?area=licenca`. Nenhuma rotação, ativação, validação por POST, medição de uso, sincronização ou alteração de licença foi executada nesta auditoria.

## Fontes e nível de evidência

- Pacote primário local: `vendor/billing-integration/`; a documentação headless local ainda usa contrato 3.0.1.
- Pacote primário remoto 3.1.0, já baixado para `/tmp/nalven-support-contract.O6ufGK.zip`: manifesto `integracao/nalven/manifest.json` declara contrato/pacote 3.1.0, Billing 6.2.0 e geração em 2026-08-27T12:38:21Z. O pacote foi lido com `unzip -p`, sem instalar ou atualizar o vendor.
- O ZIP tem SHA-256 `823a5f228852fa23c5ac502d4b7ba27e79f9075d013c457dfeb1a5dd9a0c0912`, anteriormente conferido com o manifesto público.
- `docs/integracao-nalven/api-licenciamento.md` e `catalogo-e-entitlements.md` têm conteúdo idêntico entre vendor e pacote 3.1.0, comprovado por SHA-256. As referências abaixo a esses arquivos valem para ambos.
- Licença headless: `vendor/billing-integration/integracao/nalven/openapi-headless-v3.yaml:325`, guia headless local `:416`, guia headless no ZIP `:436`.
- Tipos do runtime: `vendor/billing-integration/integracao/nalven/types.ts:5`; exemplo de cliente `billing-license-client.example.ts:85`.
- Regras de cotas: `api-licenciamento.md:110`, `catalogo-e-entitlements.md:48`, SQL primário `database/migrations/126_nalven_saas_planos_contrato_integracao.sql:210`.

Distinções usadas nesta auditoria: **documentado** é garantia explícita da fonte; **observado** é uma amostra sanitizada de leitura real; **não comprovado** não deve virar dado, promessa ou ação na interface.

## Endpoints e fontes de verdade

| Fonte/ação | Contrato comprovado | Observações para o portal |
| --- | --- | --- |
| `GET /api/v1/saas/clientes/{external_id}/licenca` | Bearer headless no backend; escopo `licenses:read`; estado e entitlements sem revelar segredo; HTTP 200 com envelope `{success,data,...}`. | OpenAPI usa `data: {}` genérico, sem DTO específico. Não presumir que a forma é igual ao runtime. Usar projeção explícita, nunca espalhar o registro remoto no navegador. |
| `GET /api/v1/licencas/entitlements?produto_codigo=...&instalacao_id=...` | Autorização pela chave da licença somente em cabeçalho; resposta top-level `success`, `valida`, `recursos`, `limites` e dados da licença/plano/instalação. | É a fonte consultada pelo verificador atual do ERP. GET direto é leitura; `tenantLicense()` também grava cache/estado e não é um helper puramente de leitura. |
| `GET /api/v1/saas/clientes/{external_id}/portal` | Snapshot agregado inclui licença/entitlements. | A apresentação antiga lê `data.license`. Snapshot agregado e consulta dedicada não são, por isso, DTOs intercambiáveis. |
| `POST /api/v1/saas/clientes/{external_id}/licenca/rotacionar-chave` | Escopo `licenses:write`; corpo `{}` no exemplo; `Idempotency-Key` obrigatório; invalida a chave anterior e emite outra uma vez. | Ação operacional coordenada, não autosserviço exposto nesta revisão. Ver riscos abaixo. |
| `POST /api/v1/licencas/ativar` | Registra/ativa instalação com dados de produto/instalação/ambiente. | Mutação; não executar para “atualizar” uma tela. |
| `POST /api/v1/licencas/validar` | Validação do runtime por POST. | Não foi usado no probe: o GET de entitlements é suficiente para leitura e evita efeitos laterais não auditados. |
| `POST /api/v1/licencas/uso` | Registra quantidade, métrica e período; idempotência; mesma chave/corpo repete medição, corpo diferente causa 409. | Não há GET de consumo documentado nessa seção. Não inferir uso zero ou percentual a partir da cota contratada. |

Referências: guia headless local `:307`, `:420`; OpenAPI `:325`; exemplo headless `:297`; API de licenciamento `:17`, `:46`, `:48`, `:76`.

## DTO documentado do runtime

O tipo primário `LicenseResponse` (`integracao/nalven/types.ts:20`) define:

```ts
{
  success: boolean;
  valida: boolean;
  motivo?: string;
  produto?: { codigo: string; nome: string; versao_atual?: string | null };
  plano?: { codigo: "essencial" | "profissional" | "omnichannel"; nome: string };
  instalacao?: { external_id: string; ambiente: "local" | "sandbox" | "homologacao" | "producao"; status: string };
  recursos?: Array<{ codigo: string; nome?: string; habilitado: boolean; limite: number | null; origem: string }>;
  limites?: Array<{ codigo: string; nome?: string; valor: number | null; sufixo?: string | null }>;
  servidor_em?: string;
}
```

A documentação também menciona `licenca` e `cliente`, mas não fornece seus campos completos nesse tipo. Não expor identificadores, prefixos, chaves, dados do cliente ou objetos de configuração apenas por estarem presentes no payload.

`success` e `valida` têm papéis diferentes: uma consulta pode ser tecnicamente bem-sucedida e relatar licença inválida. Exigir booleanos literais; strings como `"false"` não comprovam validade ou habilitação.

## Semântica de autorização, capacidade e consumo

| Dado | Significado comprovado | Apresentação/consequência segura |
| --- | --- | --- |
| `valida === false` | Negar novas operações. | Mostrar a invalidade declarada sem tratar resposta 200 como autorização. |
| Recurso ausente | Não autorizado; nunca ilimitado. | Não inventar uma habilitação pela presença do módulo local. |
| `habilitado === false` | Recurso negado. | Pode aparecer como desabilitado; não contar como ativo. |
| `limite === 0` | Sem capacidade. | Mostrar zero explicitamente; não substituir por limite-base positivo com `||`. |
| `limite === null` em habilitação | Recurso sem cota numérica. | “Sem cota numérica”; não afirmar “Ilimitado”. |
| `limite === -1` ou outro negativo | Semântica não documentada. | Dado não interpretável; não criar uma sentinela de ilimitado. |
| Número positivo | Capacidade informada pelo provedor. | Mostrar valor e unidade comprovados, sem inferir consumo ou vigência. |
| Campo ausente ou inválido | Não há capacidade conhecida. | “Não informado”, distinto de zero e null. |

Precedência documentada (`catalogo-e-entitlements.md:62`): `recursos[codigo].limite` contempla adicional/exceção individual; `limites[codigo].valor` é base do plano; ausência não autoriza. Evitar fallback automático de null de uma habilitação para um valor numérico do catálogo. Null em uma cota não tem definição explícita de capacidade ilimitada no contrato revisado.

O SQL primário configura as cotas NALVEN com `permite_ilimitado=false` e `valor_minimo=0` (`126_...sql:221–245`). A existência de um rótulo genérico `valor_ilimitado_label='Ilimitado'` na mesma tabela não autoriza interpretar `-1` como ilimitado.

Uso real das cotas pertence ao NALVEN, que o reporta ao Billing (`arquitetura-e-fluxos.md:23–25`). Os documentos revisados definem métricas, mas não comprovam campos de consumo atual no GET de licença/entitlements. Barras, “0 usados”, saldo restante e percentual exigem uma fonte de medição própria e um período/unidade compatíveis.

O catálogo documenta códigos de recurso Billing; não fornece um mapa normativo entre esses códigos e os IDs de módulos ERP locais. No código atual, `planAllows` apenas consulta IDs locais ou `*` (`lib/erp/plan-features.ts:2`); a chamada de `assertTenantLicensed` em `lib/tenant-access.ts:9` não passa um recurso. Mostrar plano/módulos locais separadamente dos entitlements remotos é mais fiel do que inventar equivalência por nome.

## Status, datas e fuso horário

- `valida` do runtime é booleano explícito de validade; `status` é uma string sem enum completo no contrato. Rótulo `active`/`ativa` não substitui `valida`.
- `servidor_em` é string opcional no tipo; o contrato revisado não define norma completa de timezone nem tipo dos campos de validade de `licenca`.
- O exemplo de uso contém períodos com offset `-03:00` (`api-licenciamento.md:89–90`), mas isso não prova o fuso de datas de validade ou de timestamps sem offset.
- Não converter timestamp sem zona como se fosse UTC ou São Paulo sem uma regra de contrato confirmada. Datas civis `YYYY-MM-DD` e instantes com offset devem ser distinguidos.
- Campo de vencimento ausente não prova licença perpétua; a antiga UI convertia ausência de `valida_ate` em “Sem expiração” (`app/portal/portal-client.tsx:243`), afirmação não sustentada.
- `max_instalacoes` expressa capacidade máxima quando presente; não é prova de quantidade atualmente utilizada.

## Rotação e risco de indisponibilidade

O guia é explícito: a rotação invalida a chave anterior; a nova deve ser gravada no cofre do tenant e a instalação reiniciada/reativada (`headless local:420–425`; no ZIP `:440–445`). O GET não retorna o segredo. Não há mecanismo documentado de duas chaves de licença válidas simultaneamente, janela de transição ou rollback de chave antiga.

A seção geral de idempotência garante replay da resposta persistida para mesma chave/corpo, retenção padrão de 24 horas e criptografia de respostas que contenham `license.key` (`headless local:135–150`; ZIP `:137–152`). Porém a seção de rotação também diz que a resposta não poderá ser recuperada depois. Interpretação operacional conservadora: apenas o replay do mesmo comando dentro da retenção é documentado genericamente; isso não equivale a consultar ou recuperar uma chave a qualquer momento. O comportamento específico de rotação após perda de resposta não foi exercitado.

Não há prova no pacote de atomicidade entre a invalidação remota e a gravação no cofre NALVEN. O fluxo local de provisionamento chama rotação remotamente antes de `completeJob()` persistir a chave em uma transação local (`lib/billing/provision.ts:43–61`). Essa transação não inclui o commit do provedor. Chave perdida, falha de persistência ou comandos concorrentes distintos podem deixar o runtime com uma credencial revogada; o cache curto apenas adia o efeito.

Conclusão desta revisão: rotação deve continuar uma operação administrativa coordenada, sem botão de autosserviço ou promessa de “atualização sem interrupção”. Para futura implementação: autoridade específica, confirmação explícita, comando persistente por organização, exclusão mútua, replay comprovado em homologação, gravação cifrada durável antes de confirmar sucesso, verificação GET com a nova chave e plano de recuperação. Esses requisitos não foram implementados nem exercitados nesta auditoria.

## Riscos de acoplar a nova tela ao runtime existente

1. `lib/billing/license.ts:14` usa `entitlementCache` e `lastSyncedAt` como validade de cache; `:17–21` faz GET runtime e grava cache/status. Não chamar esse helper apenas para consultar a tela.
2. No código auditado, `lib/billing/sync.ts:51–53` grava a resposta headless de licença diretamente em `entitlementCache`; o verificador exige a forma runtime com `valida` top-level. O probe confirmou formas diferentes: headless `{license:{...}}`, runtime `{success,valida,recursos,...}`. A mistura pode bloquear a escrita até o cache vencer, e compartilhar `lastSyncedAt` com sincronizações administrativas pode prolongar artificialmente a idade aparente do cache. Correção coordenada pelo responsável do runtime; a nova tela não deve escrever nesse cache.
3. `lib/tenant-access.ts:7–12` bloqueia escrita por organização suspensa/inadimplente e delega licença vinculada ao verificador; consulta do portal não deve alterar esses critérios, prolongar cache ou desativar restrições para “desbloquear”.
4. `publicPortalData` usa uma lista de exclusão de nomes (`lib/billing/portal-data.ts:29–31`), que não bloqueia genericamente `key`; novas rotas de licença devem projetar campos públicos em lista explícita. Não inserir retorno de rotação em snapshot/cache público.

## Probe preparado e observações reais

`scripts/probe-license-contract.ts` foi criado para execução privada pelo responsável do ambiente. Seleciona exclusivamente a conta vinculada ao `configKey=demo` e faz:

1. Leitura local de `entitlementCache`, sem atualizar nenhum timestamp/estado.
2. GET headless dedicado de licença.
3. GET direto de entitlements se a chave estiver configurada, descriptografada somente em memória e enviada no cabeçalho.

Saída: schema, enums com allowlist, flags, contagens de arrays e classificação agregada de limites/datas. Não imprime valores de chaves, prefixos, identificadores, nomes, URLs, motivos/textos do provedor ou datas individuais. Sempre desconecta do banco. ESLint do script passou.

O responsável executou o probe com configuração privada da aplicação; resultado: código 0, GET runtime HTTP 200. Amostra real sanitizada:

```ts
// data do envelope headless, já removido pelo BillingClient
{
  license: {
    id: string;             // somente tipo observado; não expor na UI
    chave_prefix: string;   // somente tipo observado; não expor na UI
    status: "ativa";
    valida_de: string;      // timestamp com zona explícita
    valida_ate: null;
    grace_ate: null;
    max_instalacoes: number; // positivo; não é uso medido
    plano_codigo: string;
    plano_nome: string;
    recursos: Array<{
      codigo: string;
      nome: string;
      habilitado: true;
      limite: null | number;
      origem: "plano";
    }>;
  };
}
```

- Headless: 35 recursos; 26 limites null, 8 positivos e 1 zero. Todas as flags `habilitado` observadas foram true; o recurso com zero continua sem capacidade, não vira ativo utilizável só pela flag.
- Runtime: objeto top-level com `success:true`, `valida:true`, `produto{codigo,nome,versao_atual}`, `plano{codigo,nome}`, 35 `recursos` (incluem também `categoria`), 9 `limites` (campos `codigo,nome,valor,sufixo`) e `servidor_em` em timestamp com zona explícita.
- Cache local, naquele instante: mesma forma do runtime. Isso não corrige o escritor de sincronização que usa a outra forma.
- Nenhum valor de chave, prefixo, ID, código de conta, nome comercial, URL ou data individual foi retornado pelo probe ou incluído aqui.
- Não foram observados status inválidos/expirados, limites negativos, rotação, quantidade usada de instalações ou replay de rotação. A amostra válida não demonstra esses outros comportamentos.

## Regressões essenciais para a implementação

- Campo booleano false vs `"false"`, null, ausente ou array: nunca tornar licença/recurso válido por coerção.
- Limites 0, null, positivo, negativo, string, ausente; override individual 0 vencendo base positiva; capacidade desconhecida sem “Ilimitado” ou uso inventado.
- DTO headless vs runtime: invalidez remota distinta de falha de consulta; falha não apresenta dados antigos como recém-validados.
- Datas civis, timestamps com offset, sem offset, inválidos e ausência; não prometer ausência de expiração.
- Nenhuma chave/prefixo/metadata/PII aparece em resposta, DOM, logs, exportação ou cache do browser.
- Organização trocada, permissões revogadas, resposta atrasada e 401/403 limpam estado sensível; isolamento validado antes de GET externo.
- Abertura/atualização da tela não chama POST de licença, rotação, jobs, sync nem altera entitlementCache/lastSyncedAt.
- Sem ações não contratadas, mapa módulo/recurso inventado, consumo zero fabricado ou rotação autônoma.

## Correção do runtime implementada após a auditoria

`lib/billing/license.ts` passou a aceitar somente um wrapper `nalven-runtime-v1` com `checkedAt` próprio, hash do contexto (organização, vínculo, endpoint normalizado, produto e segredo cifrado) e payload runtime validado/projetado. Cache legado/headless, futuro, malformado ou de outro contexto exige GET novo. TTL configurável limitado a 30–3600 segundos, com fallback de 300, sem usar ou renovar o carimbo financeiro.

Booleans são literais; códigos são únicos e preservam case; limites são null ou números finitos não negativos até MAX_SAFE_INTEGER. O retorno preserva `valida`, `recursos` e `limites` utilizados pelo verificador, sem motivo, dados de cliente ou segredos remotos. Consultas pendentes compartilham a mesma versão de conta, com máximo de 60; persistência usa CAS de ID/vínculo/chave/updatedAt e uma consulta obsoleta não autoriza.

`lib/billing/sync.ts` extrai o status de `license` no envelope headless real, mantém o timestamp financeiro e invalida o cache runtime com `Prisma.DbNull`. O responsável pela integração também incluiu essa invalidação no webhook, preservando o efeito anteriormente obtido por `lastSyncedAt=null`.

HTTP 401/403 invalida por CAS; `valida:false` persiste invalidade e sempre nega novas operações. Se a persistência falhar ou perder a corrida, um tombstone por contexto impede reuso da autorização antiga naquele processo. Há limite de 256 tombstones/uma hora; saturação troca a entrada antiga por uma regra temporal conservadora que exige GET novo, sem impedir que uma validação nova autorize. Chave/contexto diferente não herda uma negativa individual e cache checado depois pode ser utilizado.

Limitação explícita: tombstones são locais ao processo. Não garantem revogação entre múltiplos processos quando o banco não consegue persistir a invalidação. Nesse cenário, outro processo pode conservar um cache antes válido até seu TTL; eliminar esse risco exige coordenação durável compartilhada. A implementação não promete atomicidade de rotação nem disponibilidade contínua após revogação.

Verificação local em `tests/runtime-license.test.ts`: serviço real com DB/settings/segredo/transporte simulados; nenhum GET real ao provedor nem escrita de negócio. Casos abrangem formatos misturados, TTL, contexto, booleans/cotas, coalescência, CAS, negativos com falha de banco, tombstones/saturação e invalidação por sync.
