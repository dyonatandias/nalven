# Boundary P0 de identidade do terminal

## Estado operacional

As mutações financeiras do PDV estão em modo **fail-closed**. A chamada deve ser mediada pelo agente local já pareado e apresentar, sem expor a credencial em payload ou URL:

- `Authorization: Bearer posagt_v1_...`;
- `x-pos-terminal-id: <id do terminal>`.

O ID do header não é uma prova isolada. O servidor só o aceita quando o bearer confere, em tempo constante, com o HMAC contextual persistido para a combinação organização + terminal. `certificateFingerprint`, IDs no JSON e dados informados pelo navegador não autenticam o terminal.

O terminal também precisa estar pareado, não revogado, com token vigente, `status=online`, heartbeat com menos de cinco minutos, versão do agente declarada, caixa ativo e filial ativa. O vínculo ao caixa/filial é lido do banco, nunca do payload.

## Turno e operações cobertas

Na abertura, `openRequestHash` passa a vincular caixa, fundo de troco e terminal autenticado. Caixa, fechamento, carrinhos, venda, cancelamento e devolução reconstroem esse vínculo antes de operar. Os caminhos de intenção eletrônica, referência manual e ciclo de pausa/retomada/passagem também exigem o mesmo terminal. Intents capturados só podem ser consumidos por venda autenticada no terminal persistido no intent.

Turnos abertos antes desta contenção não têm um vínculo de terminal reconstruível e, portanto, são bloqueados. Não existe fallback por fingerprint, terminal da mesma filial ou `offlineAllowedUntil`.

## Bloqueio deliberado da interface atual

O `pdv-workspace` ainda envia as mutações diretamente do navegador e não possui um canal de mediação com o agente local. A credencial do agente é entregue uma única vez no pareamento/rotação e não deve ser copiada para JavaScript, `localStorage`, cookie ou bundle web. Por isso, a interface atual recebe `401` nas operações financeiras até existir um canal agente-mediado que acrescente os headers sem revelar o bearer ao navegador.

Este boundary não inventa desafio, certificado cliente ou assinatura por fingerprint. O desbloqueio de produção exige projetar e auditar esse canal local seguro; remover os headers obrigatórios ou repassar o token ao frontend não é uma solução compatível.
