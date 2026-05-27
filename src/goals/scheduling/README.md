# goals/scheduling/

Módulo do goal `scheduling` (Google Calendar). Implementado em entregas
sucessivas conforme `docs/superpowers/specs/2026-05-25-google-calendar-scheduling-design.md`.

## Status por arquivo

- ✅ `types.ts` — DTOs (entrega 1A).
- ⏳ `google-oauth.ts` — OAuth flow + token refresh (entrega 2).
- ⏳ `google-calendar.ts` — único arquivo que importa `googleapis` (entrega 2).
- ⏳ `service.ts` — findSlots, createHolds, confirmHold, cancel, reschedule (entregas 3-4).
- ⏳ `agenda-selector.ts` — single|round_robin|by_specialty (entrega 3, MVP só single).
- ⏳ `reconcile.ts` — cron 1h janela 48h (entrega 5).

## Regra

Nada fora deste diretório deve importar `googleapis`. Quem precisar consumir
Google Calendar consome via `service.ts` (DTOs definidos em `types.ts`).
