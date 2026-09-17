# Cofre multi-produto e ativação segura

Data: 26/08/2026  
Contrato headless: 3.0.1  
Arquitetura operacional do Billing: cofre multi-produto v1

## Decisão de arquitetura

Os segredos específicos do NALVEN e de produtos futuros não ficam em variáveis de ambiente do Billing. O painel administrativo mantém dois tipos de credencial:

- chave da API headless: o Billing guarda somente SHA-256, prefixo, escopos, ambiente, limite, validade e auditoria; o valor completo aparece uma única vez;
- segredo HMAC de webhook/conector: o Billing guarda o valor cifrado por AES-256-GCM, com IV aleatório, autenticação e fingerprint SHA-256 de 16 caracteres; consultas retornam somente metadados.

Uma única chave-mestra do cofre, independente de produto, fica no arquivo protegido do sistema operacional:

```text
/etc/billing-expresso/integration-secrets.key
owner: deploy
mode: 0600
```

Esse arquivo não pertence ao ZIP, Git ou banco. Em instalações com KMS/HSM, ele pode ser substituído pelo adaptador de chaves sem mudar o contrato do NALVEN.

## Interface no Billing

Acesse `Dashboard → Produtos → NALVEN → Integração segura`. Nessa guia o operador pode:

1. emitir credencial por produto e ambiente com escopos e rate limit;
2. copiar a chave da API em sua única exibição;
3. listar, suspender e revogar credenciais sem visualizar o segredo;
4. gerar e rotacionar o segredo HMAC de cada webhook;
5. informar um segredo gerado pelo SaaS e cifrá-lo imediatamente;
6. conferir o fingerprint, a origem do armazenamento e o estado da assinatura;
7. testar a assinatura real e ativar o webhook somente após resposta `2xx`.

Toda rotação do segredo pausa o webhook. A ativação ocorre apenas pelo teste assinado. As respostas que contêm segredo usam `Cache-Control: no-store`.

## O que implementar no NALVEN

O NALVEN também deve trocar as variáveis específicas por um cofre interno, mantendo apenas uma chave-mestra global no cofre do host, KMS ou secret file protegido. A chave-mestra nunca deve ficar no banco junto com o ciphertext.

Requisitos obrigatórios:

- interface restrita a administrador, autorização no backend e proteção CSRF;
- campos mascarados sem `localStorage`, query string, analytics ou logs;
- gravação cifrada e resposta sem devolver o segredo;
- status com somente `configured`, fingerprint, datas e resultado do teste;
- auditoria sem corpo sensível;
- backup contendo somente ciphertext e chave-mestra separada;
- teste de catálogo executado pelo backend;
- HMAC validado sobre o corpo bruto e comparado em tempo constante.

## Cerimônia inicial sem SSH compartilhado

1. No NALVEN, abrir a tela administrativa de integração.
2. No Billing, emitir a credencial headless com os 14 escopos, produção e 300 req/min.
3. Copiar uma vez e colar diretamente no NALVEN; confirmar o fingerprint.
4. No Billing, gerar/rotacionar o segredo HMAC da assinatura.
5. Copiar uma vez e colar no NALVEN; confirmar o mesmo fingerprint.
6. No NALVEN, executar **Testar conexão**.
7. No Billing, executar **Testar e ativar**.
8. No NALVEN, executar **Reconciliar tenants**.

O clipboard deve ser limpo ao final. Se a página for fechada antes da gravação, rotacione novamente; não tente recuperar o segredo anterior.

## Rotação

Para a chave headless, emitir a segunda credencial, gravá-la no NALVEN, testar e somente então revogar a anterior. Para webhook, a rotação pausa entregas; grave o novo valor no NALVEN e execute o teste assinado para reativar. Nenhuma rotação exige migration, novo ZIP ou mudança do contrato 3.0.1.

## Estado atual

- migration 140 aplicada no Billing;
- chave-mestra global protegida instalada no host Billing;
- interface multi-produto implementada;
- referência legada `env:NALVEN_WEBHOOK_SECRET` preservada apenas até a primeira gravação pelo cofre;
- credencial NALVEN ainda não emitida;
- webhook NALVEN pausado até o mesmo segredo ser gravado no cofre remoto e o teste assinado passar;
- produto permanece `publicado=false` até toda a homologação.
