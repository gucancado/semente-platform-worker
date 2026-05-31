import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3001/cb';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
process.env.GOOGLE_OAUTH_STATE_SECRET = 'state-secret-at-least-40-chars-long-aaaa';

const {
  scheduleMeeting,
  cancelMeeting,
  rescheduleMeeting,
} = await import('../../../src/goals/scheduling/schedule-service.js');
const { TokenRevokedError } = await import('../../../src/integrations/google/types.js');

type SD = Parameters<typeof scheduleMeeting>[1];

const FAKE_AGENDA = {
  id: 1, project_id: 1, person_name: 'Rodrigo', person_email: 'rod@x.com',
  display_label: 'o time comercial', description: null,
  working_hours: { mon: ['09:00-12:00'], timezone: 'America/Sao_Paulo' },
  meeting_duration_min: 30, min_advance_hours: 4, max_advance_business_days: 10,
  active: true, round_robin_last_assigned_at: null,
  created_at: new Date(), updated_at: new Date(),
} as Awaited<ReturnType<NonNullable<SD>['listAgendas']>>[number];

const FAKE_CONN = {
  id: 1, project_id: 1, google_email: 'agent@x.com',
  refresh_token_encrypted: Buffer.from('x'), scopes: [],
  connected_at: new Date(), last_refresh_at: null, last_error: null,
} as Parameters<NonNullable<SD>['ensureFreshAccessToken']>[0];

function baseDeps(overrides: Partial<SD> = {}): SD {
  const d: SD = {
    listAgendas: async () => [FAKE_AGENDA],
    getConnectionByProjectId: async () => FAKE_CONN,
    ensureFreshAccessToken: async () => 'fake-token',
    findActiveMeetingForLead: async () => null,
    findMeetingById: async () => null,
    findHold: async () => null,
    listOtherHoldsForLead: async () => [],
    markHoldConsumed: async () => {},
    deleteHoldRow: async () => {},
    insertMeeting: async () => ({ id: 999 }),
    updateMeetingStatus: async () => {},
    updateMeetingSlot: async () => {},
    confirmHold: async () => ({ meetLink: 'https://meet.google.com/aaa' }),
    createEventDirect: async () => ({ eventId: 'evt-new', meetLink: 'https://meet.google.com/bbb' }),
    patchEvent: async () => {},
    deleteEvent: async () => {},
    insertSimulatedMeeting: async () => ({ id: 555 }),
    findSimulatedActive: async () => null,
    now: () => new Date('2026-06-01T12:00:00Z'),
    ...overrides,
  };
  return d;
}

const BASE_REQ = {
  project_id: 1,
  agent: 'mercurio',
  channel: 'whatsapp',
  identifier: '+5531999',
  slot_iso: '2026-06-02T10:00:00-03:00',
  slot_human: 'segunda às 10h',
  lead_email: 'lead@x.com',
  lead_name: 'Lead Silva',
  company: 'ACME',
  contexto: 'cenário',
};

test('happy path com hold: confirma hold + insert meeting', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    findHold: async () => ({ id: 10, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999', slot_iso: new Date(), google_event_id: 'evt-hold', expires_at: new Date(), consumed: false, created_at: new Date() }),
  }));
  assert.equal(result.source, 'google');
  if (result.source === 'google') {
    assert.equal(result.google_event_id, 'evt-hold');
    assert.equal(result.google_meet_link, 'https://meet.google.com/aaa');
    assert.equal(result.meeting_id, 999);
  }
});

test('hold expirou: cria evento direto', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    findHold: async () => null,
  }));
  assert.equal(result.source, 'google');
  if (result.source === 'google') {
    assert.equal(result.google_event_id, 'evt-new');
    assert.equal(result.google_meet_link, 'https://meet.google.com/bbb');
  }
});

test('dedup: meeting já scheduled no MESMO slot retorna atalho', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    findActiveMeetingForLead: async () => ({
      id: 77, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999',
      slot_iso: new Date(BASE_REQ.slot_iso), slot_human: 'segunda às 10h', lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: 'evt-old', google_meet_link: 'https://meet.google.com/old',
      status: 'scheduled', cancelled_by: null, rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
  }));
  assert.equal(result.source, 'google');
  if (result.source === 'google') {
    assert.equal(result.already_scheduled, true);
    assert.equal(result.meeting_id, 77);
  }
});

test('slot diferente do existing: reschedule transparente', async () => {
  const calls: { updatedStatus?: { id: number; status: string }; deletedEvent?: { calendarId: string; eventId: string } } = {};
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    findActiveMeetingForLead: async () => ({
      id: 77, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999',
      slot_iso: new Date('2026-06-01T14:00:00-03:00'), slot_human: 'segunda (01/06) às 14h',
      lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: 'evt-old', google_meet_link: 'https://meet.google.com/old',
      status: 'scheduled', cancelled_by: null, rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
    updateMeetingStatus: async (id, status) => { calls.updatedStatus = { id, status }; },
    deleteEvent: async (_c, calendarId, eventId) => { calls.deletedEvent = { calendarId, eventId }; },
  }));
  assert.equal(result.source, 'google');
  if (result.source === 'google') {
    // Nova meeting deve ser criada (id=999 do mock insertMeeting), não a 77 antiga
    assert.equal(result.meeting_id, 999);
    assert.notEqual(result.already_scheduled, true);
  }
  // Velha foi marcada como rescheduled
  assert.equal(calls.updatedStatus?.id, 77);
  assert.equal(calls.updatedStatus?.status, 'rescheduled');
  // Evento velho foi removido do Google
  assert.equal(calls.deletedEvent?.eventId, 'evt-old');
});

test('fallback no_oauth: simulated_meetings + simulated=true', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    getConnectionByProjectId: async () => null,
  }));
  assert.equal(result.source, 'mock');
  if (result.source === 'mock') {
    assert.equal(result.fallback_reason, 'no_oauth');
    assert.equal(result.simulated, true);
    assert.equal(result.meeting_id, 555);
  }
});

test('fallback no_active_agenda', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    listAgendas: async () => [],
  }));
  assert.equal(result.source, 'mock');
  if (result.source === 'mock') assert.equal(result.fallback_reason, 'no_active_agenda');
});

test('fallback token_revoked', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    ensureFreshAccessToken: async () => { throw new TokenRevokedError('revoked'); },
  }));
  assert.equal(result.source, 'mock');
  if (result.source === 'mock') assert.equal(result.fallback_reason, 'token_revoked');
});

test('confirmHold erro: fallback confirm_error', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    findHold: async () => ({ id: 10, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999', slot_iso: new Date(), google_event_id: 'evt-x', expires_at: new Date(), consumed: false, created_at: new Date() }),
    confirmHold: async () => { throw new Error('google 500'); },
  }));
  assert.equal(result.source, 'mock');
  if (result.source === 'mock') assert.match(result.fallback_reason, /^confirm_error/);
});

test('cancel: meeting com google_event_id chama deleteEvent', async () => {
  let deleted = false;
  const result = await cancelMeeting(42, 'lead', baseDeps({
    findMeetingById: async () => ({
      id: 42, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+x',
      slot_iso: new Date(), slot_human: 's', lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: 'evt-1', google_meet_link: null,
      status: 'scheduled', cancelled_by: null, rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
    deleteEvent: async () => { deleted = true; },
  }));
  assert.equal(result.cancelled, true);
  assert.equal(deleted, true);
});

test('cancel: meeting já cancelled retorna {cancelled:false, already}', async () => {
  const result = await cancelMeeting(42, 'lead', baseDeps({
    findMeetingById: async () => ({
      id: 42, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+x',
      slot_iso: new Date(), slot_human: 's', lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: 'evt-1', google_meet_link: null,
      status: 'cancelled', cancelled_by: 'lead', rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
  }));
  assert.equal(result.cancelled, false);
  assert.equal(result.already, 'cancelled');
});

test('cancel: meeting sem google_event_id (simulated path) só UPDATE', async () => {
  let deleted = false;
  let updated = false;
  const result = await cancelMeeting(42, 'lead', baseDeps({
    findMeetingById: async () => ({
      id: 42, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+x',
      slot_iso: new Date(), slot_human: 's', lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: null, google_meet_link: null,
      status: 'scheduled', cancelled_by: null, rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
    deleteEvent: async () => { deleted = true; },
    updateMeetingStatus: async () => { updated = true; },
  }));
  assert.equal(result.cancelled, true);
  assert.equal(deleted, false);
  assert.equal(updated, true);
});

test('reschedule: cria hold + patch + UPDATE meeting', async () => {
  let patched = false;
  let updatedSlot = false;
  const result = await rescheduleMeeting(42, '2026-06-03T11:00:00-03:00', 'terça às 11h', baseDeps({
    findMeetingById: async () => ({
      id: 42, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+x',
      slot_iso: new Date(), slot_human: 'old', lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: 'evt-1', google_meet_link: null,
      status: 'scheduled', cancelled_by: null, rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
    patchEvent: async () => { patched = true; },
    updateMeetingSlot: async () => { updatedSlot = true; },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.new_meeting_id, 42);
  assert.equal(patched, true);
  assert.equal(updatedSlot, true);
});

test('reschedule: patchEvent erro → ok:false', async () => {
  const result = await rescheduleMeeting(42, '2026-06-03T11:00:00-03:00', 'terça às 11h', baseDeps({
    findMeetingById: async () => ({
      id: 42, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+x',
      slot_iso: new Date(), slot_human: 'old', lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: 'evt-1', google_meet_link: null,
      status: 'scheduled', cancelled_by: null, rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
    patchEvent: async () => { throw new Error('google 500'); },
  }));
  assert.equal(result.ok, false);
});

test('schedule limpa outros holds da mesma conversa', async () => {
  let deletedHoldsCount = 0;
  await scheduleMeeting(BASE_REQ, baseDeps({
    findHold: async () => ({ id: 10, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999', slot_iso: new Date(), google_event_id: 'evt-hold', expires_at: new Date(), consumed: false, created_at: new Date() }),
    listOtherHoldsForLead: async () => [
      { id: 11, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999', slot_iso: new Date(), google_event_id: 'evt-o1', expires_at: new Date(), consumed: false, created_at: new Date() },
      { id: 12, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999', slot_iso: new Date(), google_event_id: 'evt-o2', expires_at: new Date(), consumed: false, created_at: new Date() },
    ],
    deleteHoldRow: async () => { deletedHoldsCount++; },
  }));
  assert.equal(deletedHoldsCount, 2);
});

test('conferenceRequestId é único por chamada (timestamp Date.now)', async () => {
  let captured1 = '';
  let captured2 = '';
  const deps1 = baseDeps({
    findHold: async () => ({ id: 10, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999', slot_iso: new Date(), google_event_id: 'evt-hold', expires_at: new Date(), consumed: false, created_at: new Date() }),
    confirmHold: (async (_c, _cal, _evt, fields) => { captured1 = fields.conferenceRequestId; return { meetLink: null }; }) as SD['confirmHold'],
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  });
  await scheduleMeeting(BASE_REQ, deps1);
  const deps2 = baseDeps({
    findHold: async () => ({ id: 11, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531998', slot_iso: new Date(), google_event_id: 'evt-hold', expires_at: new Date(), consumed: false, created_at: new Date() }),
    confirmHold: (async (_c, _cal, _evt, fields) => { captured2 = fields.conferenceRequestId; return { meetLink: null }; }) as SD['confirmHold'],
    now: () => new Date('2026-06-01T12:00:01.000Z'),
  });
  await scheduleMeeting({ ...BASE_REQ, identifier: '+5531998' }, deps2);
  assert.notEqual(captured1, captured2);
});

test('dedup: meeting com status rescheduled também é detectada', async () => {
  const result = await scheduleMeeting(BASE_REQ, baseDeps({
    findActiveMeetingForLead: async () => ({
      id: 88, project_id: 1, agenda_id: 1, channel: 'whatsapp', identifier: '+5531999',
      slot_iso: new Date(), slot_human: 'moved', lead_email: null, lead_name: null,
      company: null, contexto: null, google_event_id: 'evt-moved', google_meet_link: null,
      status: 'rescheduled', cancelled_by: null, rescheduled_to: null, last_reconciled_at: null,
      created_at: new Date(), updated_at: new Date(),
    }),
  }));
  assert.equal(result.source, 'google');
  if (result.source === 'google') {
    assert.equal(result.already_scheduled, true);
    assert.equal(result.meeting_id, 88);
  }
});
