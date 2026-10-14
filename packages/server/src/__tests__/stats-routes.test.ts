// The config dir is set before any import so the server's CallLogger and the
// assertions below share one throwaway logs directory. CONFIG_DIR is resolved
// once at module load from FREEMODELFINDER_HOME, so the core/server imports
// are dynamic on purpose.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { strict as AssertStrict } from 'node:assert';

process.env.FREEMODELFINDER_HOME = mkdtempSync(join(tmpdir(), 'fmf-stats-routes-'));
const TMP_HOME = process.env.FREEMODELFINDER_HOME;

const assert: typeof AssertStrict = (await import('node:assert/strict'))
  .default as typeof AssertStrict;
const { after, describe, it } = await import('node:test');
const { CallLogger, ProviderRegistry } = await import('@freemodelfinder/core');
const { createServer } = await import('../server.js');

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** The management API only answers the local UI: loopback + trusted origin. */
const UI_HEADERS = { origin: 'http://127.0.0.1:11435', 'x-fmf-client': 'ui' };

/** Minimal registry; the stats routes only read from the CallLogger. */
function stubRegistry() {
  const registry = new ProviderRegistry({
    version: 2,
    port: 0,
    providers: {},
    gateway: { requireAuth: false },
  });
  registry.listAllModels = async () =>
    ({
      models: [{ id: 'p:m', provider: 'p', displayName: 'm', free: true, capabilities: ['text'] }],
      succeededProviders: ['p'],
      failedProviders: [],
    }) as unknown as Awaited<ReturnType<typeof registry.listAllModels>>;
  return registry;
}

describe('stats and log routes', () => {
  it('returns a cursor page of logs and honors the status filter', async () => {
    const { app } = await createServer({
      registry: stubRegistry(),
      watchIntervalMs: 3_600_000,
    });
    const logger = new CallLogger(TMP_HOME);
    for (const status of ['success', 'error', 'success'] as const) {
      logger.record({
        ts: Date.now(),
        kind: 'chat',
        provider: 'p',
        model: 'm',
        status,
        latencyMs: 1,
      });
    }
    await logger.flush();

    const first = await app.inject({
      method: 'GET',
      url: '/api/logs?limit=2',
      headers: UI_HEADERS,
    });
    assert.equal(first.statusCode, 200);
    const page = first.json() as { data: unknown[]; nextCursor: string | null };
    assert.equal(page.data.length, 2);
    assert.ok(page.nextCursor, 'nextCursor must be present when more entries remain');

    const second = await app.inject({
      method: 'GET',
      url: `/api/logs?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`,
      headers: UI_HEADERS,
    });
    assert.equal((second.json() as { data: unknown[] }).data.length, 1);

    const errors = await app.inject({
      method: 'GET',
      url: '/api/logs?status=error',
      headers: UI_HEADERS,
    });
    assert.equal((errors.json() as { data: unknown[] }).data.length, 1);
    await app.close();
  });

  it('serves a bucketed series and falls back on bad params', async () => {
    // The server's CallLogger reads CONFIG_DIR's logs dir, which is fixed at
    // import time, so this case asserts the route contract (bucket echo,
    // zero-fill, fallback) rather than exact counts shared with other cases.
    const { app } = await createServer({
      registry: stubRegistry(),
      watchIntervalMs: 3_600_000,
    });

    const ok = await app.inject({
      method: 'GET',
      url: '/api/stats/series?range=7d&bucket=week',
      headers: UI_HEADERS,
    });
    assert.equal(ok.statusCode, 200);
    const series = ok.json() as { range: string; bucket: string; points: { calls: number }[] };
    assert.equal(series.bucket, 'week');
    assert.equal(series.range, '7d');
    assert.ok(series.points.length >= 1 && series.points.length <= 3, '7 天按周分桶');
    assert.ok(series.points.every((p) => Number.isFinite(p.calls)));

    const bad = await app.inject({
      method: 'GET',
      url: '/api/stats/series?range=nope&bucket=nope',
      headers: UI_HEADERS,
    });
    const badSeries = bad.json() as { range: string; bucket: string };
    assert.equal(badSeries.range, 'today');
    assert.equal(badSeries.bucket, 'day');
    await app.close();
  });
});
