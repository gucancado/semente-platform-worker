# goals/email/

Módulo Gmail compartilhável entre goals que usam email (lembretes, lead detection, etc.).

## Status

- ✅ `gmail-client.ts` — sendEmail + listInbox + getOwnEmail (Entrega 2 base).
- ⏳ Goals que consomem este módulo virão em entregas futuras (lembrete pra leads, lead detection via inbox).

## Regra

`gmail-client.ts` é o ÚNICO arquivo que importa `googleapis.gmail`. Quem precisar consumir o Gmail consome via funções exportadas daqui.
