# Ubuntu e publicação de segurança — 05/09/2026

As correções do SaaS foram publicadas em `/srv/nalven/releases/security-20260905T160945Z`. A publicação validou que as migrações do controle e dos bancos ativos já correspondiam ao checkout; não executou migrações nem seeds. O backup prévio dos bancos foi concluído e seus dois dumps passaram na conferência SHA-256.

## SSH e rede local preservados

- Nenhum arquivo em `/etc/ssh` foi alterado: os hashes anteriores e posteriores são idênticos.
- O processo SSH permaneceu com PID 5688, na porta 22; não houve restart do SSH nem mudança de senha, usuário de login ou autenticação.
- As regras do UFW foram preservadas: SSH e HTTP/HTTPS permitidos; demais entradas bloqueadas. Endereço, gateway e interface permaneceram inalterados.
- A máquina não foi reiniciada. O Ubuntu não sinalizou necessidade de reboot ao término.

## Ubuntu, usuários e serviços

- 54 pacotes atualizados via APT, sem remoções, sem upgrade de OpenSSH/PAM/systemd e com preservação de arquivos de configuração. `dpkg --audit` não apresentou pendências.
- Quatro pacotes continuam adiados pelo rollout gradual do Ubuntu: `libaudit-common`, `libaudit1`, `python3-software-properties`, `software-properties-common`. O faseamento não foi forçado.
- Atualizações automáticas já estavam habilitadas. Foi explicitamente desabilitado o reboot automático.
- AppArmor e UFW observados ativos. PostgreSQL usa SCRAM-SHA-256, autenticação local peer e sockets TCP apenas em localhost; os papéis de aplicação não são superusuários.
- Usuários de serviço usam `nologin`. O usuário de desenvolvimento foi removido do grupo `lxd`; o instalador LXD, que não tinha instalação/container em uso identificado, teve socket/serviço desabilitados e mascarados. A participação antiga no grupo pode permanecer em sessões já abertas, mas o socket está bloqueado.
- Proteções contra exposição de ponteiros do kernel, acesso ao log do kernel, BPF sem privilégio, abuso de links/FIFOs e redirecionamentos/source routing foram reforçadas. As opções de rede foram aplicadas também à interface existente `ens18`, preservando seus endereços e rotas.
- O bloqueio runtime de BPF usa valor 1: flexibilizá-lo pode exigir reboot. Não foi habilitado sandbox de JIT que impeça o Node de executar.
- Journald limitado a 512 MiB, retenção de 30 dias e reserva de 2 GiB. Armazenamento de core dumps desabilitado no systemd-coredump e `LimitCORE=0` nos serviços alterados.
- A atualização revelou um `grubenv` inválido. O arquivo foi copiado antes do reparo; o bloco vazio foi reconstruído com `grub-editenv`, sem alterar entradas de boot. O serviço do GRUB passou a concluir com sucesso.
- Nenhum serviço ficou em estado failed ao final. Não foram reiniciadas sessões do usuário ou o D-Bus para preservar a sessão remota; atualizações de bibliotecas dessas sessões entram em uso no próximo login/reboot normal.

## Isolamento da aplicação

- `/srv/nalven`, o diretório de releases e a release ativa/de rollback agora são controlados por root. O usuário de desenvolvimento não consegue trocar a release; o serviço web não consegue editar seu código.
- Serviço web reforçado com `ProtectKernelLogs`, `ProtectProc=invisible`, `RestrictRealtime`, `RemoveIPC`, `TasksMax=512` e bloqueio de core dumps.
- Analytics deixou de executar TypeScript do checkout gravável com todos os segredos do SaaS. Os agendadores billing, DF-e e analytics passaram a executar um runner imutável sob `nalven-jobs`, que acessa somente o token necessário aos jobs internos.
- O token deixou de aparecer em argumentos de `curl`. O novo runner o mantém em memória, recusa redirecionamentos, limita destino a três endpoints locais e mantém retries/timeout.
- A rota `/api/internal/analytics/jobs` exige Bearer com segredo forte e comparação em tempo constante. A agregação continua dentro da aplicação, usando seu contexto de banco.
- Os três agendadores concluíram com sucesso depois da publicação. Testes sob os usuários reais confirmaram que `nalven-jobs` não lê `/etc/nalven/app.env`, `nalven-app` não grava o código e `nalven` não substitui `/srv/nalven`.

## Nginx

- Adicionado limite por IP para leituras de API, além do limite de mutações e conexões já existente.
- Acesso a arquivos ocultos bloqueado, preservando `/.well-known/`.
- Versão do Nginx ocultada; timeouts de cabeçalhos, corpo e keepalive ajustados.
- Log do virtual host passou a omitir query strings e Referer, além de mascarar os caminhos de recuperação, convite e avaliação que contêm tokens. Logs antigos não foram apagados.
- Configuração validada com `nginx -t` antes do reload.
- HTTPS público respondeu 200 e é terminado por um proxy externo que identifica seu software como OpenResty. Foi solicitada a confirmação do IP desse proxy. A confiança no cabeçalho `X-Forwarded-Proto` foi preservada para não interromper esse fluxo; a restrição por origem deve ser concluída quando o IP for confirmado. Não foi habilitada confiança irrestrita em IP de cliente encaminhado.

## Validações e arquivos

- Suíte completa existente: 761 testes e lint aprovados. Teste adicional de autenticação dos jobs passou junto da suíte de segurança, agora com 14 casos. Build de produção concluído com URLs fictícias exclusivas para a compilação.
- `/` e `/api/health`: 200; `/api/erp`: 401; `/api/saas`: 403; job interno sem Bearer: 401; CSRF com prefetch: 403; acesso a `/.env`: 403; página de recuperação: `no-referrer`.
- Banco e Node continuaram em localhost. Aplicação, firewall, AppArmor e SSH ativos.
- Backups, checksums, plano e logs administrativos: `/root/nalven-security-20260905/`, restrito a root. Nenhuma senha fornecida na conversa foi gravada em script ou relatório.
- Fontes reproduzíveis em `deploy/90-nalven-host-hardening.conf`, `deploy/process-internal-job.mjs`, `deploy/install-internal-job-runner.sh`, unidades e scripts de publicação. O script `publish-security-release.sh` é específico desta manutenção e exige seu snapshot anterior.

A revisão não constitui certificação de ausência de vulnerabilidades. MFA e confirmação efetiva de e-mail no cadastro permanecem como evoluções da aplicação, conforme a [revisão anterior](review-2026-09-05.md). Não foram rotacionadas chaves de criptografia nem credenciais de usuários.

Referências: [atualizações automáticas no Ubuntu](https://ubuntu.com/server/docs/how-to/software/automatic-updates/), [firewall do Ubuntu](https://documentation.ubuntu.com/server/how-to/security/firewalls/index.html), [AppArmor](https://documentation.ubuntu.com/server/how-to/security/apparmor/index.html), [bloco de ambiente do GRUB](https://www.gnu.org/software/grub/manual/grub/html_node/Environment-block.html).
