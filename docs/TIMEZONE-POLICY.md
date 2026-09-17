# Política de fuso horário

O horário civil padrão do Nalven e do servidor é `America/Sao_Paulo` (horário de Brasília). Cada organização pode selecionar seu fuso brasileiro e cada filial pode sobrescrever esse padrão para a própria operação.

## Regras

- Instantes técnicos, fiscais e de auditoria são persistidos no banco em UTC.
- Administração da plataforma, infraestrutura e clientes ainda não configurados usam `America/Sao_Paulo`.
- ERP e portal convertem instantes para o fuso da filial ativa; sem filial, usam o fuso padrão da organização.
- Documentos públicos vinculados a pedido usam o fuso da filial emissora e recorrem ao padrão da organização.
- Mensagens e notificações usam o fuso configurado pela organização.
- Filiais, configurações da organização e agendas de relatórios usam o identificador IANA, nunca uma compensação fixa como `UTC-3`.
- Serviços Node e workers declaram `TZ=America/Sao_Paulo` para que qualquer biblioteca sem opção explícita tenha o mesmo comportamento.
- Datas civis sem horário, como vencimento ou nascimento, não sofrem conversão de fuso.
- Timers diários declaram `America/Sao_Paulo` diretamente no `OnCalendar`; timers por intervalo são independentes do relógio civil.

Essa separação mantém ordenação, idempotência e integração confiáveis em UTC, sem apresentar horários UTC ao usuário e sem misturar fusos entre organizações.
