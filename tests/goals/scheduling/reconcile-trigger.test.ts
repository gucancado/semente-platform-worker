import { test } from 'node:test';
import assert from 'node:assert/strict';

test('startReconcileCron chama reconcileMeetings imediatamente no startup', async () => {
  let immediateCalled = false;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: any, ms: number) => ({ unref: () => ({}) }) as any) as any;
  try {
    const mod = await import('../../../src/goals/scheduling/reconcile-trigger.js');
    mod._setReconcileForTest(async () => {
      immediateCalled = true;
      return { scanned: 0, cancelled: 0, moved: 0, skipped: 0 };
    });
    mod.startReconcileCron({ info: () => {}, warn: () => {}, error: () => {} } as any);
    await new Promise((r) => setImmediate(r));
    assert.equal(immediateCalled, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test('startReconcileCron usa default 3_600_000ms', async () => {
  let capturedMs: number | undefined;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: any, ms: number) => {
    capturedMs = ms;
    return { unref: () => ({}) } as any;
  }) as any;
  try {
    const mod = await import('../../../src/goals/scheduling/reconcile-trigger.js');
    mod._setReconcileForTest(async () => ({ scanned: 0, cancelled: 0, moved: 0, skipped: 0 }));
    mod.startReconcileCron({ info: () => {}, warn: () => {}, error: () => {} } as any);
    assert.equal(capturedMs, 3_600_000);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});
