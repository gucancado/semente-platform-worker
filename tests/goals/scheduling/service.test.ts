import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestSlotsCore,
  type SuggestSlotsDeps,
  type SuggestSlotsRequest,
} from '../../../src/goals/scheduling/service.js';
import { TokenRevokedError } from '../../../src/integrations/google/types.js';
import type { SchedulingAgenda } from '../../../src/admin/db.js';
import type { GoogleOAuthConnection } from '../../../src/integrations/google/types.js';

const NOW = new Date('2026-06-01T12:00:00Z'); // segunda 09:00 BRT

const FAKE_AGENDA: SchedulingAgenda = {
  id: 42,
  project_id: 1,
  person_name: 'Rodrigo',
  person_email: 'rodrigo@beeads.com.br',
  display_label: 'o time comercial',
  description: null,
  working_hours: {
    mon: ['09:00-12:00', '14:00-18:00'],
    tue: ['09:00-12:00', '14:00-18:00'],
    wed: ['09:00-12:00', '14:00-18:00'],
    thu: ['09:00-12:00', '14:00-18:00'],
    fri: ['09:00-12:00', '14:00-17:00'],
    timezone: 'America/Sao_Paulo',
  },
  meeting_duration_min: 30,
  min_advance_hours: 4,
  max_advance_business_days: 10,
  active: true,
  round_robin_last_assigned_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const FAKE_CONN: GoogleOAuthConnection = {
  id: 1,
  project_id: 1,
  google_email: 'comercial@beeads.com.br',
  refresh_token_encrypted: Buffer.from('fake'),
  scopes: ['https://www.googleapis.com/auth/calendar.events'],
  connected_at: new Date(),
  last_refresh_at: null,
  last_error: null,
};

function baseDeps(overrides: Partial<SuggestSlotsDeps> = {}): SuggestSlotsDeps {
  return {
    listAgendas: async () => [FAKE_AGENDA],
    getConnectionByProjectId: async () => FAKE_CONN,
    ensureFreshAccessToken: async () => 'fake-access-token',
    freebusy: async () => [],
    now: () => NOW,
    ...overrides,
  };
}

const BASE_REQ: SuggestSlotsRequest = {
  project_id: 1,
  channel: 'whatsapp',
  identifier: '+5531999999999',
  dayFilter: 'qualquer',
  periodFilter: 'qualquer',
};

test('happy path: agenda + conn + freebusy vazio → source=google, 3 slots', async () => {
  const result = await suggestSlotsCore(BASE_REQ, baseDeps());
  assert.equal(result.source, 'google');
  assert.equal(result.agenda?.id, 42);
  assert.equal(result.agenda?.display_label, 'o time comercial');
  assert.equal(result.slots.length, 3);
});

test('sem agenda ativa → source=mock, fallback_reason=no_active_agenda', async () => {
  const result = await suggestSlotsCore(BASE_REQ, baseDeps({
    listAgendas: async () => [],
  }));
  assert.equal(result.source, 'mock');
  assert.equal(result.fallback_reason, 'no_active_agenda');
  assert.ok(result.slots.length > 0);
});

test('sem conn OAuth → fallback_reason=no_oauth', async () => {
  const result = await suggestSlotsCore(BASE_REQ, baseDeps({
    getConnectionByProjectId: async () => null,
  }));
  assert.equal(result.source, 'mock');
  assert.equal(result.fallback_reason, 'no_oauth');
});

test('token revogado → fallback_reason=token_revoked', async () => {
  const result = await suggestSlotsCore(BASE_REQ, baseDeps({
    ensureFreshAccessToken: async () => {
      throw new TokenRevokedError('invalid_grant');
    },
  }));
  assert.equal(result.source, 'mock');
  assert.equal(result.fallback_reason, 'token_revoked');
});

test('freebusy erro → fallback_reason=freebusy_error:<msg>', async () => {
  const result = await suggestSlotsCore(BASE_REQ, baseDeps({
    freebusy: async () => {
      throw new Error('rate limit exceeded');
    },
  }));
  assert.equal(result.source, 'mock');
  assert.match(result.fallback_reason ?? '', /^freebusy_error:rate limit/);
});

test('freebusy retorna bloqueio: slot dentro do bloqueio é pulado', async () => {
  const result = await suggestSlotsCore(BASE_REQ, baseDeps({
    freebusy: async () => [
      { start: '2026-06-01T12:00:00.000-00:00', end: '2026-06-01T14:00:00.000-00:00' },
    ],
  }));
  assert.equal(result.source, 'google');
  const segSlot = result.slots.find((s) => s.day_label.startsWith('segunda'));
  if (segSlot) {
    assert.ok(segSlot.hour >= 11, `segunda deveria ser 11h+, recebi ${segSlot.hour}`);
  }
});

test('working_hours vazio: source=google, slots=[]', async () => {
  const result = await suggestSlotsCore(BASE_REQ, baseDeps({
    listAgendas: async () => [{
      ...FAKE_AGENDA,
      working_hours: { timezone: 'America/Sao_Paulo' },
    }],
  }));
  assert.equal(result.source, 'google');
  assert.deepEqual(result.slots, []);
});

test('agenda fallback mock também respeita dayFilter/periodFilter', async () => {
  const result = await suggestSlotsCore(
    { ...BASE_REQ, dayFilter: 'qui', periodFilter: 'tarde' },
    baseDeps({ getConnectionByProjectId: async () => null })
  );
  assert.equal(result.source, 'mock');
  for (const s of result.slots) {
    assert.ok(s.hour >= 14, `legacy mock tarde: ${s.iso}`);
  }
});
