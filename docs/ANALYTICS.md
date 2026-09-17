# Analytics do site

O módulo mede o site público da NALVEN e a jornada de aquisição do SaaS. Ele não depende de e-commerce, catálogo ou produtos.

## O que é medido

- visualizações, visitantes anônimos, sessões e duração média;
- acessos em tempo real, dispositivos e páginas mais vistas;
- domínio de origem do tráfego (a URL completa nunca é armazenada);
- funil agregado `landing → clique em cadastro → cadastro iniciado → conta criada`;
- cobertura real do período, para diferenciar ausência de tráfego de coleta ainda recente.

Rotas administrativas, ERP, portal e convites não são coletadas. Query strings são descartadas e tokens de recuperação são normalizados. O IP nunca é salvo em claro.

## Persistência e operação

Eventos brutos têm retenção curta e são consolidados em agregados diários permanentes. O job é idempotente, nunca consolida o dia corrente e só remove eventos depois que existe o marcador diário correspondente.

Comandos úteis:

```bash
npm run jobs:analytics
npm run test:analytics
```

O deploy instala `nalven-analytics.timer`, executado a cada hora. O segredo `ANALYTICS_IP_SALT` é criado automaticamente pelo bootstrap e deve permanecer fora do banco e do repositório.

O painel fica em `/admin/analytics` e as configurações permitem ativar a coleta, incluir ou excluir superadministradores, ajustar retenções, heartbeat e fuso horário.
