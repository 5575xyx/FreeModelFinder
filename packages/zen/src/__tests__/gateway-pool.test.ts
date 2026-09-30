import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNodeHttpClient } from '../http.js';
import { parseProxyList } from '../proxy/spec.js';
import { ZenKeyPool, ZenAnonymousPool } from '../gateway/pool.js';
import {
  cooldownDelayMs,
  maxCooldownMs,
  parseRetryAfter,
  proxyHealthy,
  setProxyHealthy,
} from '../gateway/health.js';

const proxies = parseProxyList(['direct', 'http://127.0.0.1:7890'], '');
const client = createNodeHttpClient();

describe('zen key pool', () => {
  it('balances keys across proxies and walks them by session cursor', () => {
    const pool = new ZenKeyPool(['k1', 'k2', 'k3'], proxies, client, {
      cooldownBaseMs: 15_000,
      maxAttempts: 3,
    });
    assert.equal(pool.len(), 3);
    const nodes = pool.all();
    assert.equal(nodes.length, 3);
    assert.equal(new Set(nodes.map((n) => n.proxy.name)).size, proxies.length);
    const cursor = pool.cursorFor('sess-a');
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const node = cursor.next();
      if (node) seen.add(node.keyId);
    }
    assert.equal(seen.size, 3);
  });

  it('keeps a key in cooldown out of the round-robin until it expires', () => {
    const pool = new ZenKeyPool(['k1', 'k2'], proxies, client, {
      cooldownBaseMs: 60_000,
      maxAttempts: 3,
    });
    const node = pool.all()[0]!;
    const now = Date.now();
    pool.markFailure(node, 429, undefined, 120_000);
    assert.equal(pool.inCooldown(node, now), true);
    const earliest = pool.earliestCooldown(now);
    assert.ok(earliest !== undefined);
    assert.ok(earliest <= now + 300_000 && earliest >= now + 120_000);
    const cursor = pool.cursorFor('s');
    const next = cursor.next();
    assert.notEqual(next?.keyId, node.keyId);
  });

  it('rejects an empty proxy list', () => {
    assert.throws(
      () => new ZenKeyPool(['k1'], [], client, { cooldownBaseMs: 1000, maxAttempts: 3 }),
    );
  });

  it('reports the earliest cooldown when every key is cooling', () => {
    const pool = new ZenKeyPool(['k1'], proxies, client, {
      cooldownBaseMs: 10_000,
      maxAttempts: 3,
    });
    const node = pool.all()[0]!;
    pool.markFailure(node, 500, undefined, undefined);
    const earliest = pool.earliestCooldown(Date.now());
    assert.ok(earliest === undefined || earliest > Date.now());
  });
});

describe('zen anonymous pool', () => {
  it('creates one node per proxy and walks them per session', () => {
    const pool = new ZenAnonymousPool(proxies, client);
    assert.equal(pool.len(), proxies.length);
    const cursor = pool.cursorFor('s');
    const first = cursor.next();
    assert.ok(first);
    const second = cursor.next();
    assert.ok(second);
  });

  it('marks a failing anonymous node and skips it while cooling', () => {
    const pool = new ZenAnonymousPool(proxies, client);
    const node = pool.nodes()[0]!;
    pool.markFailure(node, 403, undefined, undefined);
    assert.equal(pool.inCooldown(node, Date.now()), true);
  });

  it('bestEffortNode prefers a healthy node and otherwise the earliest cooldown', () => {
    const pool = new ZenAnonymousPool(proxies, client, { cooldownBaseMs: 60_000 });
    const first = pool.nodes()[0]!;
    const second = pool.nodes()[1]!;
    pool.markFailure(first, 429, undefined, 120_000);
    setProxyHealthy(second.proxy.health, false);
    assert.equal(pool.bestEffortNode()?.proxy.name, first.proxy.name);
    setProxyHealthy(first.proxy.health, false);
    pool.markFailure(second, 429, undefined, 10_000);
    assert.equal(pool.bestEffortNode()?.proxy.name, second.proxy.name);
  });

  it('bestEffortNode returns undefined for an empty pool', () => {
    const pool = new ZenAnonymousPool([], client);
    assert.equal(pool.bestEffortNode(), undefined);
  });

  it('remembers the last anonymous failure status and error', () => {
    const pool = new ZenAnonymousPool(proxies, client);
    const node = pool.nodes()[0]!;
    assert.equal(pool.lastAnonymousFailure(), undefined);
    pool.markFailure(node, 429, undefined, undefined);
    assert.equal(pool.lastAnonymousFailure()?.status, 429);
    const boom = new Error('boom');
    pool.markFailure(node, undefined, boom, undefined);
    assert.equal(pool.lastAnonymousFailure()?.status, 0);
    assert.equal(pool.lastAnonymousFailure()?.error, boom);
  });
});

describe('zen gateway health', () => {
  it('scales cooldown exponentially up to eight times the base', () => {
    assert.equal(cooldownDelayMs(1_000, 1), 1_000);
    assert.equal(cooldownDelayMs(1_000, 2), 2_000);
    assert.equal(cooldownDelayMs(1_000, 3), 4_000);
    assert.equal(cooldownDelayMs(1_000, 4), 8_000);
    assert.equal(cooldownDelayMs(1_000, 9), 8_000);
    assert.equal(maxCooldownMs(1_000), 8_000);
  });

  it('prefers a longer retry-after over the exponential delay', () => {
    assert.equal(cooldownDelayMs(1_000, 1, 30_000), 30_000);
    assert.equal(cooldownDelayMs(1_000, 4, 2_000), 8_000);
  });

  it('parses retry-after seconds and http dates', () => {
    assert.equal(parseRetryAfter(undefined), 0);
    assert.equal(parseRetryAfter('  '), 0);
    assert.equal(parseRetryAfter('0'), 0);
    assert.equal(parseRetryAfter('12'), 12_000);
    assert.equal(parseRetryAfter('not-a-date'), 0);
    const when = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfter(when, Date.now());
    assert.ok(parsed > 0 && parsed <= 5_000);
  });

  it('toggles proxy health and reports it', () => {
    const health = { healthy: true } as Parameters<typeof proxyHealthy>[0];
    assert.equal(proxyHealthy(health), true);
    assert.equal(setProxyHealthy(health, false), true);
    assert.equal(proxyHealthy(health), false);
    assert.equal(setProxyHealthy(health, true), false);
  });

  it('does not cool a key on ordinary client errors but cools on transport errors', () => {
    const pool = new ZenKeyPool(['k1'], proxies, client, {
      cooldownBaseMs: 10_000,
      maxAttempts: 3,
    });
    const node = pool.all()[0]!;
    pool.markFailure(node, 404, undefined, undefined);
    assert.equal(pool.inCooldown(node, Date.now()), false);
    pool.markFailure(node, undefined, new Error('boom'), undefined);
    assert.equal(pool.inCooldown(node, Date.now()), true);
  });

  it('walks empty-affinity cursors round-robin and falls back to the earliest cooldown', () => {
    const pool = new ZenKeyPool(['k1', 'k2'], proxies, client, {
      cooldownBaseMs: 10_000,
      maxAttempts: 3,
    });
    const cursor = pool.cursorFor('');
    const first = cursor.next();
    const second = cursor.next();
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.keyId, second.keyId);
    assert.equal(pool.earliestCooldown(Date.now()), undefined);
    for (const node of pool.all()) pool.markFailure(node, 429, undefined, undefined);
    const earliest = pool.earliestCooldown(Date.now());
    assert.ok(earliest !== undefined && earliest > Date.now());
  });
});
