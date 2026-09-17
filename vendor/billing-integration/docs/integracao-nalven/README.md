# Integração NALVEN ↔ Billing Expresso

Este diretório é o pacote de handoff para a equipe que desenvolverá e hospedará o NALVEN. O Billing Expresso é a fonte de verdade comercial; o NALVEN é a fonte de verdade operacional do ERP.

## Estado em 26/08/2026

| Componente | Situação |
|---|---|
| Produto `nalven` | ativo no catálogo interno e **não publicado** |
| Planos | Essencial, Profissional e Omnichannel cadastrados |
| Catálogo modular | 12 módulos, composição 4/10/12 e preços separados por método |
| Recursos e cotas | cadastrados por plano e expostos na API de licenças |
| Minuta | `nalven_assinatura_saas_mensal`, versionada e gerável pelo painel |
| Cadastro e portal | contrato 3.0.1 implementado nos dois lados; NALVEN publicou proxies privados para boleto, NFS-e, contrato e anexos |
| Licença | API v1 pronta para validar, ativar instalação, consultar entitlements e registrar uso |
| Cobrança | Banco Inter validado em produção; cartão permanece oculto enquanto o Mercado Pago estiver inativo |
| NFS-e | configuração de produção ativa, certificado válido até 15/04/2027; emissão automática ainda desabilitada |
| Contratos e suporte | headless: listagem, OTP, assinatura, PDF, tickets e anexos privados com validação de conteúdo e antivírus fail-closed |
| Webhook NALVEN | health `200` e assinatura adulterada recusada com `401`; 16 eventos cadastrados e pausados até o mesmo segredo ser instalado nos dois cofres |
| Assinatura Scalon | não criada; depende do aceite/homologação e dos dados comerciais pendentes |
| API do produto | 14 escopos, ambientes separados, 300 req/min e resposta idempotente cifrada; emissão permanente disponível na interface segura |
| Cofre de integrações | AES-256-GCM por conexão e webhook; chave-mestra global fora do banco e transferência com exibição única |
| Runtime NALVEN | release `20260826195946` ativa; documentação oficial incorporada em `nalven/vendor/billing-integration` |
| Pacote de handoff | `integracao-billing-nalven.zip`, versão 3.0.3; contrato headless permanece 3.0.1 |

Não altere `publicado` para `true` antes de concluir o checklist de homologação. Enquanto estiver `false`, `/cadastro?produto=nalven` não aceitará o plano, protegendo a operação contra tenants sem provisionamento.

## Documentos

- [Cofre multiproduto e ativação](./COFRE-MULTIPRODUTO-E-ATIVACAO.md) — cerimônia segura entre os dois painéis
- [Integração headless e paridade total](./INTEGRACAO-HEADLESS-PARIDADE-TOTAL.md) — documento principal para o SaaS NALVEN
- [Arquitetura e fluxos](./arquitetura-e-fluxos.md)
- [Catálogo, planos e entitlements](./catalogo-e-entitlements.md)
- [Catálogo modular e preços por método](./catalogo-modular-e-precificacao.md)
- [Cadastro, módulos e mudança de assinatura](./cadastro-modulos-e-upgrade.md)
- [API de licenciamento](./api-licenciamento.md)
- [Cobrança, suporte e webhooks](./billing-suporte-webhooks.md)
- [Operação da minuta e ciclo comercial](./contrato-e-operacao.md)
- [Checklist de handoff e go-live](./checklist-handoff.md)
- [Pendências de ativação e evidências](./PENDENCIAS-ATIVACAO-2026-08-26.md)

## Identificadores estáveis

```text
produto_codigo: nalven
produto_slug:   nalven
planos:         essencial | profissional | omnichannel
modelo:         nalven_assinatura_saas_mensal
métodos:        pix | boleto | cartao
```

O NALVEN deve decidir acesso por `recursos[].codigo` e `recursos[].habilitado`, nunca pelo nome visual do plano. As cotas efetivas são lidas em `recursos[].limite`; `limites[]` mantém o valor-base do plano para exibição e auditoria.

## Download do handoff

```text
https://sistema.agenciaexpresso.com.br/integracao-billing-nalven.zip
https://sistema.agenciaexpresso.com.br/integracao-billing-nalven-version.txt
```

O ZIP contém esta documentação, catálogo legível por máquina, variáveis de ambiente sem segredos, tipos TypeScript e exemplos de cliente headless, cliente de licença e receptor de webhook.

Destino de produção informado pelo NALVEN:

```text
SaaS:     https://nalven.com.br
Webhook: https://nalven.com.br/api/webhooks/billing
Tenant:  organization.slug
Versão:  0.9.0
Release: 20260826195946
Contrato: 3.0.1
```

## Divisão de responsabilidade

Billing Expresso:

- cadastro da empresa e do responsável;
- identidade financeira e portal headless;
- plano, assinatura, promoções e adicionais;
- minuta, assinatura eletrônica e PDF;
- faturas, NFS-e, Pix, boleto, cartão e conciliação;
- tickets, comunicação, inadimplência e ciclo de cancelamento expostos ao NALVEN por escopo;
- emissão e estado da licença.

NALVEN:

- tenant e usuários do ERP;
- módulos, dados operacionais, PDV, estoque, financeiro e canais;
- aplicação local das permissões e cotas recebidas;
- medição de uso;
- recepção idempotente dos webhooks;
- bloqueio funcional quando a licença estiver inválida ou suspensa fora da carência.
