// tests/whatsapp/authz.test.ts
// Node --test, mocked fetch, no DB required.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal fetch mock that returns the given role. */
function makeFetch(role: 'admin' | 'editor' | 'executor' | null) {
  return mock.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify({ role }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/** Fake clock that starts at `now` and can be advanced. */
function makeClock(startMs = Date.now()) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

const BLOQUIM_ORIGIN = 'https://bloquim.example.com';
const SECRET = 'test-internal-secret-xyz';

// ── import under test ─────────────────────────────────────────────────────────
// We import after defining helpers so TypeScript is satisfied.
import {
  resolveActorRole,
  resolveActorRoleFresh,
  assertActorMember,
  assertActorAdmin,
  AuthzError,
  __resetOriginMemoForTests,
} from '../../src/whatsapp/authz.js';

const USER = 'user-uuid-1';
const WS = 'workspace-uuid-1';

// ── resolveActorRole: caches within TTL ──────────────────────────────────────

test('resolveActorRole: 2 calls within TTL = 1 fetch; returns role', async () => {
  const fetchMock = makeFetch('editor');
  const clock = makeClock();

  const r1 = await resolveActorRole(USER, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });
  const r2 = await resolveActorRole(USER, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(r1, 'editor');
  assert.equal(r2, 'editor');
  assert.equal(fetchMock.mock.calls.length, 1, 'fetch must be called only once within TTL');
});

// ── resolveActorRole: re-fetches after TTL expiry ─────────────────────────────

test('resolveActorRole: re-fetches after TTL expires', async () => {
  const fetchMock = makeFetch('admin');
  const clock = makeClock();

  await resolveActorRole(`${USER}-ttl`, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  // Advance past the 45s TTL
  clock.advance(46_000);

  await resolveActorRole(`${USER}-ttl`, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(fetchMock.mock.calls.length, 2, 'fetch must be called again after TTL expiry');
});

// ── resolveActorRoleFresh: never caches ───────────────────────────────────────

test('resolveActorRoleFresh: 2 calls = 2 fetches (no cache)', async () => {
  const fetchMock = makeFetch('executor');
  const clock = makeClock();

  const r1 = await resolveActorRoleFresh(`${USER}-fresh`, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });
  const r2 = await resolveActorRoleFresh(`${USER}-fresh`, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(r1, 'executor');
  assert.equal(r2, 'executor');
  assert.equal(fetchMock.mock.calls.length, 2, 'fresh must never serve from cache');
});

test('resolveActorRoleFresh: result is NOT served to a later resolveActorRole call from cache', async () => {
  // Fresh call populates nothing; cached path must still fetch once.
  const freshFetch = makeFetch('admin');
  const cachedFetch = makeFetch('admin');
  const clock = makeClock();
  const key = `${USER}-fresh-nocache`;

  // Fresh call
  await resolveActorRoleFresh(key, WS, {
    fetch: freshFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  // Cached call with a DIFFERENT fetch mock — must see exactly 1 call here
  await resolveActorRole(key, WS, {
    fetch: cachedFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(cachedFetch.mock.calls.length, 1, 'resolveActorRole must fetch independently of fresh calls');
});

// ── assertActorAdmin ──────────────────────────────────────────────────────────

test('assertActorAdmin: passes only for admin', async () => {
  const clock = makeClock();
  const deps = (role: 'admin' | 'editor' | 'executor' | null) => ({
    fetch: makeFetch(role) as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  // Should resolve fine for admin
  await assert.doesNotReject(
    () => assertActorAdmin(`${USER}-admin-ok`, WS, deps('admin')),
    'admin must pass',
  );
});

test('assertActorAdmin: throws for editor', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorAdmin(`${USER}-admin-ed`, WS, {
      fetch: makeFetch('editor') as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    AuthzError,
    'editor must be rejected with AuthzError',
  );
});

test('assertActorAdmin: throws for executor', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorAdmin(`${USER}-admin-ex`, WS, {
      fetch: makeFetch('executor') as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    AuthzError,
  );
});

test('assertActorAdmin: throws for null', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorAdmin(`${USER}-admin-null`, WS, {
      fetch: makeFetch(null) as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    AuthzError,
  );
});

test('assertActorAdmin: uses fresh path (does not cache)', async () => {
  // Two assertActorAdmin calls → must each call fetch (no caching on admin path).
  const fetchMock = makeFetch('admin');
  const clock = makeClock();
  const deps = {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  };

  await assertActorAdmin(`${USER}-admin-fresh`, WS, deps);
  await assertActorAdmin(`${USER}-admin-fresh`, WS, deps);

  assert.equal(fetchMock.mock.calls.length, 2, 'assertActorAdmin must use fresh path (no cache)');
});

// ── assertActorMember ─────────────────────────────────────────────────────────

test('assertActorMember: throws for null', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorMember(`${USER}-mem-null`, WS, {
      fetch: makeFetch(null) as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    AuthzError,
  );
});

test('assertActorMember: passes for admin/editor/executor', async () => {
  const clock = makeClock();
  for (const role of ['admin', 'editor', 'executor'] as const) {
    await assert.doesNotReject(
      () => assertActorMember(`${USER}-mem-${role}`, WS, {
        fetch: makeFetch(role) as unknown as typeof fetch,
        now: clock.now,
        secret: SECRET,
        bloquimOrigin: BLOQUIM_ORIGIN,
      }),
      `${role} must be accepted as member`,
    );
  }
});

// ── fail-closed: no secret ────────────────────────────────────────────────────

test('fail-closed: resolve returns null, no fetch, when secret is empty', async () => {
  const fetchMock = makeFetch('admin');
  const clock = makeClock();

  const r = await resolveActorRole(`${USER}-nosec`, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: '',
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(r, null);
  assert.equal(fetchMock.mock.calls.length, 0, 'fetch must not be called when secret is absent');
});

test('fail-closed: assertActorMember throws when secret is empty (no fetch)', async () => {
  const fetchMock = makeFetch('admin');
  const clock = makeClock();

  await assert.rejects(
    () => assertActorMember(`${USER}-nosec-m`, WS, {
      fetch: fetchMock as unknown as typeof fetch,
      now: clock.now,
      secret: '',
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    AuthzError,
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('fail-closed: assertActorAdmin throws when secret is empty (no fetch)', async () => {
  const fetchMock = makeFetch('admin');
  const clock = makeClock();

  await assert.rejects(
    () => assertActorAdmin(`${USER}-nosec-a`, WS, {
      fetch: fetchMock as unknown as typeof fetch,
      now: clock.now,
      secret: '',
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    AuthzError,
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

// ── request shape ─────────────────────────────────────────────────────────────

test('request shape: correct URL, X-Internal-Secret header, body {userId, workspaceId}', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  const shapeFetch = mock.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ role: 'admin' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const clock = makeClock();
  await resolveActorRole(`${USER}-shape`, WS, {
    fetch: shapeFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.ok(capturedUrl, 'URL was captured');
  assert.match(capturedUrl!, /\/api\/internal\/authz\/workspace-role$/);
  assert.equal(
    (capturedInit?.headers as Record<string, string>)?.['X-Internal-Secret'],
    SECRET,
    'X-Internal-Secret header must be set',
  );

  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.userId, `${USER}-shape`);
  assert.equal(body.workspaceId, WS);
});

// ── fail-closed: non-OK HTTP response ─────────────────────────────────────────

test('fail-closed: non-OK HTTP response treated as denied (resolve→null)', async () => {
  const errFetch = mock.fn(async () => new Response('Internal Server Error', { status: 500 }));
  const clock = makeClock();

  const r = await resolveActorRole(`${USER}-5xx`, WS, {
    fetch: errFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(r, null);
});

test('fail-closed: non-OK HTTP on assertActorMember throws AuthzError', async () => {
  const errFetch = mock.fn(async () => new Response('', { status: 503 }));
  const clock = makeClock();

  await assert.rejects(
    () => assertActorMember(`${USER}-5xx-m`, WS, {
      fetch: errFetch as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    AuthzError,
  );
});

// ── #5: assertActorAdmin non-OK path (fail-closed) ────────────────────────────

test('fail-closed: non-OK HTTP on assertActorAdmin throws AuthzError', async () => {
  const errFetch = mock.fn(async () => new Response('', { status: 503 }));
  const clock = makeClock();

  await assert.rejects(
    () => assertActorAdmin(`${USER}-5xx-a`, WS, {
      fetch: errFetch as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthzError, 'must be AuthzError');
      assert.equal(err.code, 'FORBIDDEN', 'non-OK on admin path → FORBIDDEN (deny, fail-closed)');
      return true;
    },
  );
});

// ── #4: AuthzError.code assertions (MISCONFIGURED vs FORBIDDEN) ────────────────

test('code: unset/empty secret → MISCONFIGURED on assertActorMember', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorMember(`${USER}-code-mc-m`, WS, {
      fetch: makeFetch('admin') as unknown as typeof fetch,
      now: clock.now,
      secret: '',
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthzError);
      assert.equal(err.code, 'MISCONFIGURED');
      return true;
    },
  );
});

test('code: unset/empty secret → MISCONFIGURED on assertActorAdmin', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorAdmin(`${USER}-code-mc-a`, WS, {
      fetch: makeFetch('admin') as unknown as typeof fetch,
      now: clock.now,
      secret: '',
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthzError);
      assert.equal(err.code, 'MISCONFIGURED');
      return true;
    },
  );
});

test('code: denied non-member → FORBIDDEN on assertActorMember', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorMember(`${USER}-code-fb-m`, WS, {
      fetch: makeFetch(null) as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthzError);
      assert.equal(err.code, 'FORBIDDEN');
      return true;
    },
  );
});

test('code: denied non-admin role → FORBIDDEN on assertActorAdmin', async () => {
  const clock = makeClock();
  await assert.rejects(
    () => assertActorAdmin(`${USER}-code-fb-a`, WS, {
      fetch: makeFetch('editor') as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthzError);
      assert.equal(err.code, 'FORBIDDEN');
      return true;
    },
  );
});

// ── #3: error/throw path (network error / timeout) ────────────────────────────

test('error path: fetch that throws → resolveActorRole denies (returns null)', async () => {
  const throwFetch = mock.fn(async () => { throw new Error('network down'); });
  const clock = makeClock();

  const r = await resolveActorRole(`${USER}-throw`, WS, {
    fetch: throwFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(r, null, 'throw → fail-closed deny');
  assert.equal(throwFetch.mock.calls.length, 1);
});

test('error path: fetch that throws → assertActorMember throws AuthzError (FORBIDDEN)', async () => {
  const throwFetch = mock.fn(async () => { throw new Error('boom'); });
  const clock = makeClock();

  await assert.rejects(
    () => assertActorMember(`${USER}-throw-m`, WS, {
      fetch: throwFetch as unknown as typeof fetch,
      now: clock.now,
      secret: SECRET,
      bloquimOrigin: BLOQUIM_ORIGIN,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthzError);
      assert.equal(err.code, 'FORBIDDEN');
      return true;
    },
  );
});

// ── #2: transient-failure nulls are NOT cached ────────────────────────────────

test('no cache poisoning: a throw is not cached → next call retries (and can succeed)', async () => {
  const clock = makeClock();
  const key = `${USER}-no-poison-throw`;

  let calls = 0;
  // First call throws, second returns a real role.
  const flakyFetch = mock.fn(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient blip');
    return new Response(JSON.stringify({ role: 'editor' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const r1 = await resolveActorRole(key, WS, {
    fetch: flakyFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });
  assert.equal(r1, null, 'first (throw) → deny');

  // Immediately retry WITHIN TTL — must NOT be served the cached null.
  const r2 = await resolveActorRole(key, WS, {
    fetch: flakyFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });
  assert.equal(r2, 'editor', 'transient failure must not poison cache; retry succeeds within TTL');
  assert.equal(flakyFetch.mock.calls.length, 2, 'both calls must hit fetch (no cached deny)');
});

test('no cache poisoning: a non-OK response is not cached → next call retries', async () => {
  const clock = makeClock();
  const key = `${USER}-no-poison-503`;

  let calls = 0;
  const flakyFetch = mock.fn(async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ role: 'admin' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const r1 = await resolveActorRole(key, WS, {
    fetch: flakyFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });
  assert.equal(r1, null);

  const r2 = await resolveActorRole(key, WS, {
    fetch: flakyFetch as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });
  assert.equal(r2, 'admin', 'non-OK must not poison cache; retry succeeds within TTL');
  assert.equal(flakyFetch.mock.calls.length, 2);
});

test('definitive non-member (HTTP 200 role:null) IS cached', async () => {
  const clock = makeClock();
  const key = `${USER}-definitive-null`;
  const fetchMock = makeFetch(null); // 200 OK, role:null = confirmed non-member

  const r1 = await resolveActorRole(key, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });
  const r2 = await resolveActorRole(key, WS, {
    fetch: fetchMock as unknown as typeof fetch,
    now: clock.now,
    secret: SECRET,
    bloquimOrigin: BLOQUIM_ORIGIN,
  });

  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(fetchMock.mock.calls.length, 1, 'a confirmed non-member (200 role:null) must be cached');
});

// ── #1: production default path (no deps) — env + global fetch ────────────────

test('default path: no deps, uses process.env + global fetch (no require())', async () => {
  const prevSecret = process.env.INTERNAL_API_SECRET;
  const prevUrl = process.env.BLOQUIM_API_URL;
  const prevFetch = globalThis.fetch;

  try {
    process.env.INTERNAL_API_SECRET = 'env-secret-abc';
    process.env.BLOQUIM_API_URL = 'https://bloquim-default.example.com/api';
    __resetOriginMemoForTests(); // pick up the env we just set

    let capturedUrl: string | undefined;
    let capturedSecret: string | undefined;
    globalThis.fetch = mock.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedSecret = (init?.headers as Record<string, string>)?.['X-Internal-Secret'];
      return new Response(JSON.stringify({ role: 'admin' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // No deps → must read env directly and use global fetch, without require().
    const role = await resolveActorRoleFresh(`${USER}-default`, WS);

    assert.equal(role, 'admin');
    assert.equal(capturedSecret, 'env-secret-abc', 'must read INTERNAL_API_SECRET from process.env');
    assert.ok(
      capturedUrl?.startsWith('https://bloquim-default.example.com/api/internal/authz/workspace-role'),
      `must derive origin from BLOQUIM_API_URL; got ${capturedUrl}`,
    );
  } finally {
    if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = prevSecret;
    if (prevUrl === undefined) delete process.env.BLOQUIM_API_URL;
    else process.env.BLOQUIM_API_URL = prevUrl;
    globalThis.fetch = prevFetch;
    __resetOriginMemoForTests(); // don't leak the env-derived origin memo to later no-deps paths
  }
});

test('default path: malformed BLOQUIM_API_URL → fail-closed deny (no crash)', async () => {
  const prevSecret = process.env.INTERNAL_API_SECRET;
  const prevUrl = process.env.BLOQUIM_API_URL;
  const prevFetch = globalThis.fetch;

  try {
    process.env.INTERNAL_API_SECRET = 'env-secret-abc';
    process.env.BLOQUIM_API_URL = 'not-a-valid-url';
    __resetOriginMemoForTests(); // re-derive origin from the (bad) env

    const fetchSpy = mock.fn(async () => new Response(JSON.stringify({ role: 'admin' }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // No deps → derives origin from the malformed env. Must NOT crash, must deny.
    const role = await resolveActorRoleFresh(`${USER}-malformed`, WS);

    assert.equal(role, null, 'malformed BLOQUIM_API_URL → deny, no crash');
    assert.equal(fetchSpy.mock.calls.length, 0, 'must not fetch with a bad origin');
  } finally {
    if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = prevSecret;
    if (prevUrl === undefined) delete process.env.BLOQUIM_API_URL;
    else process.env.BLOQUIM_API_URL = prevUrl;
    __resetOriginMemoForTests(); // don't leak the test origin into other tests
    globalThis.fetch = prevFetch;
  }
});
