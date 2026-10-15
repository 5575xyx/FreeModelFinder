import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REFRESH_SKEW_MS,
  SUBSCRIPTION_ADAPTERS,
  SubscriptionImportError,
  SubscriptionRefreshError,
  createFlightCache,
  decodeJwtPayload,
  parseExpiryMs,
} from '../adapters/subscription/index.js';

describe('createFlightCache', () => {
  it('deduplicates concurrent runs with the same key (fn executes once)', async () => {
    const cache = createFlightCache<string>();
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'done';
    };
    const first = cache.run('same-key', fn);
    const second = cache.run('same-key', fn);
    assert.equal(first, second, 'same key should share the in-flight promise');
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1, 'fn must execute exactly once for concurrent same-key calls');
    assert.equal(a, 'done');
    assert.equal(b, 'done');
  });

  it('executes fn once per distinct key, even concurrently', async () => {
    const cache = createFlightCache<number>();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = async (value: number): Promise<number> => {
      calls += 1;
      await gate;
      return value;
    };
    const p1 = cache.run('key-a', () => fn(1));
    const p2 = cache.run('key-b', () => fn(2));
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(calls, 2, 'different keys must each execute fn');
    assert.equal(a, 1);
    assert.equal(b, 2);
  });

  it('propagates rejections to all callers and evicts the key afterwards', async () => {
    const cache = createFlightCache<number>();
    let calls = 0;
    const failing = async (): Promise<number> => {
      calls += 1;
      throw new Error('boom');
    };
    const p1 = cache.run('flaky', failing);
    const p2 = cache.run('flaky', failing);
    await assert.rejects(p1, /boom/);
    await assert.rejects(p2, /boom/);
    assert.equal(calls, 1, 'both concurrent callers share one execution');
    const retried = await cache.run('flaky', async () => {
      calls += 1;
      return 7;
    });
    assert.equal(retried, 7, 'settled keys must be evicted so later runs retry');
    assert.equal(calls, 2);
  });
});

describe('parseExpiryMs', () => {
  const now = 1_700_000_000_000;

  it('returns now for empty or invalid values (treated as expired)', () => {
    assert.equal(parseExpiryMs(undefined, now), now);
    assert.equal(parseExpiryMs('', now), now);
    assert.equal(parseExpiryMs('abc', now), now);
  });

  it('keeps millisecond timestamps (>1e12) as-is', () => {
    assert.equal(parseExpiryMs('1755000000000', now), 1755000000000);
  });

  it('converts second timestamps (<1e12) to milliseconds', () => {
    assert.equal(parseExpiryMs('1755000000', now), 1755000000000);
  });

  it('parses ISO strings with Date.parse', () => {
    const iso = '2025-08-12T12:00:00.000Z';
    assert.equal(parseExpiryMs(iso, now), Date.parse(iso));
  });

  it('defaults now to Date.now()', () => {
    const before = Date.now();
    const got = parseExpiryMs(undefined);
    const after = Date.now();
    assert.ok(
      got >= before && got <= after,
      `expected Date.now() within [${before}, ${after}], got ${got}`,
    );
  });
});

describe('decodeJwtPayload', () => {
  it('base64url-decodes the payload segment without verifying the signature', () => {
    assert.deepEqual(decodeJwtPayload('x.eyJhIjoxfQ.y'), { a: 1 });
  });

  it('returns null for malformed tokens', () => {
    assert.equal(decodeJwtPayload(''), null);
    assert.equal(decodeJwtPayload('not-a-jwt'), null);
    assert.equal(decodeJwtPayload('x..y'), null);
    assert.equal(decodeJwtPayload('x.eyJhIjoxfQ'), null);
    assert.equal(decodeJwtPayload('a.b.c'), null);
    assert.equal(decodeJwtPayload('x.!!!!.y'), null);
    assert.equal(decodeJwtPayload('x.123.y'), null);
  });
});

describe('SubscriptionRefreshError', () => {
  it('preserves kind/status/resetAt', () => {
    const err = new SubscriptionRefreshError('rate limited', {
      kind: 'rate_limit',
      status: 429,
      resetAt: 1_755_000_000_000,
    });
    assert.ok(err instanceof Error);
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.status, 429);
    assert.equal(err.resetAt, 1_755_000_000_000);

    const fatal = new SubscriptionRefreshError('invalid_grant', { kind: 'fatal' });
    assert.equal(fatal.kind, 'fatal');
    assert.equal(fatal.status, undefined);
    assert.equal(fatal.resetAt, undefined);
  });

  it('redacts secrets out of the message', () => {
    const err = new SubscriptionRefreshError('refresh failed refresh_token=SECRETVAL', {
      kind: 'network',
    });
    assert.ok(
      !err.message.includes('SECRETVAL'),
      `message must not contain raw token: ${err.message}`,
    );
    assert.match(err.message, /refresh_token=\[REDACTED\]/);
  });
});

describe('SubscriptionImportError', () => {
  it('redacts secrets out of the message', () => {
    const err = new SubscriptionImportError('import rejected refresh_token=SECRETVAL');
    assert.ok(err instanceof Error);
    assert.ok(
      !err.message.includes('SECRETVAL'),
      `message must not contain raw token: ${err.message}`,
    );
    assert.match(err.message, /refresh_token=\[REDACTED\]/);
  });
});

describe('REFRESH_SKEW_MS', () => {
  it('is one minute', () => {
    assert.equal(REFRESH_SKEW_MS, 60_000);
  });
});

describe('SUBSCRIPTION_ADAPTERS placeholders', () => {
  const platforms = ['codex', 'claude', 'google'] as const;

  it('exposes exactly the three subscription platforms', () => {
    assert.deepEqual(Object.keys(SUBSCRIPTION_ADAPTERS).sort(), ['claude', 'codex', 'google']);
  });

  it('placeholder adapters throw "not implemented" and return safe defaults', async () => {
    for (const platform of platforms) {
      const adapter = SUBSCRIPTION_ADAPTERS[platform];
      assert.equal(adapter.platform, platform);
      assert.throws(() => adapter.parseImport('raw-import-string'), SubscriptionImportError);
      await assert.rejects(
        () => adapter.refresh({ refreshToken: 'rt', payload: {} }),
        SubscriptionImportError,
      );
      assert.equal(adapter.isFatalRefreshError(new Error('anything')), false);
      assert.equal(typeof adapter.accountIdOf({ id: 'acct-1' }, {}), 'string');
    }
  });
});
