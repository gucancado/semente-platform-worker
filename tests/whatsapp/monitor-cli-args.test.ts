import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupMonitorArgs, parseMonitorCopyArgs } from '../../src/whatsapp/monitor-cli-args.js';

test('group-monitor list/set', () => {
  assert.deepEqual(parseGroupMonitorArgs(['list']), { cmd: 'list' });
  assert.deepEqual(parseGroupMonitorArgs(['set', '--slot=B', '--instance=ws-x', '--dry-run']),
    { cmd: 'set', slot: 'B', instance: 'ws-x', phone: null, keepDms: false, dryRun: true });
  assert.deepEqual(parseGroupMonitorArgs(['set', '--slot=a', '--instance=ws-x', '--phone=+5531999999999']),
    { cmd: 'set', slot: 'A', instance: 'ws-x', phone: '+5531999999999', keepDms: false, dryRun: false });
  assert.ok('error' in parseGroupMonitorArgs(['set', '--slot=C', '--instance=x']));
  assert.ok('error' in parseGroupMonitorArgs(['set', '--slot=A']));
  assert.ok('error' in parseGroupMonitorArgs(['set', '--slot=A', '--instance=x', '--phone=5531']));
  assert.ok('error' in parseGroupMonitorArgs([]));
});
test('monitor-copy', () => {
  assert.deepEqual(parseMonitorCopyArgs(['--since=2026-10-13T00:00:00Z']), { since: '2026-10-13T00:00:00.000Z', until: null, dryRun: false });
  assert.deepEqual(parseMonitorCopyArgs(['--since=2026-10-13T00:00:00Z', '--until=2026-10-14T00:00:00Z', '--dry-run']),
    { since: '2026-10-13T00:00:00.000Z', until: '2026-10-14T00:00:00.000Z', dryRun: true });
  assert.ok('error' in parseMonitorCopyArgs([]));
  assert.ok('error' in parseMonitorCopyArgs(['--since=ontem']));
  assert.ok('error' in parseMonitorCopyArgs(['--since=2026-10-13T00:00:00Z', '--until=x']));
});

test('parseGroupMonitorArgs: --keep-dms liga keepDms; ausente = false', () => {
  const on = parseGroupMonitorArgs(['set', '--slot=A', '--instance=ws-x', '--keep-dms']);
  assert.ok('cmd' in on && on.cmd === 'set' && on.keepDms === true);
  const off = parseGroupMonitorArgs(['set', '--slot=A', '--instance=ws-x']);
  assert.ok('cmd' in off && off.cmd === 'set' && off.keepDms === false);
});
