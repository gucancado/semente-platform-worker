import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriggerBody } from '../../src/triggers/poller.js';

test('buildTriggerBody monta body inbox (backward compat)', () => {
  const row = {
    id: 1,
    agent: 'mercurio',
    project: 'metido-a-gente',
    identifier: '5531999998888',
    last_inbox_id: 42,
    msg_count: 3,
    attempt_count: 0,
    trigger_type: 'inbox' as const,
    payload: null,
  };
  const body = buildTriggerBody(row);
  assert.deepEqual(body, {
    inbox_id: 42,
    agent: 'mercurio',
    trigger_type: 'inbox',
    payload: null,
  });
});

test('buildTriggerBody monta body meeting_reconcile com payload', () => {
  const row = {
    id: 2,
    agent: 'mercurio',
    project: 'metido-a-gente',
    identifier: '5531999998888',
    last_inbox_id: null,
    msg_count: 0,
    attempt_count: 0,
    trigger_type: 'meeting_reconcile' as const,
    payload: {
      event: 'moved_by_organizer' as const,
      meeting_id: 17,
      old_slot_iso: '2026-06-01T10:00:00-03:00',
      new_slot_iso: '2026-06-02T14:00:00-03:00',
    },
  };
  const body = buildTriggerBody(row);
  assert.deepEqual(body, {
    inbox_id: null,
    agent: 'mercurio',
    trigger_type: 'meeting_reconcile',
    payload: {
      event: 'moved_by_organizer',
      meeting_id: 17,
      old_slot_iso: '2026-06-01T10:00:00-03:00',
      new_slot_iso: '2026-06-02T14:00:00-03:00',
    },
  });
});
