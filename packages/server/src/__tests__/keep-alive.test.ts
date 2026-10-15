// The config dir is set before any import so nothing here touches the real
// ~/.freemodelfinder. The server import is dynamic on purpose.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { strict as AssertStrict } from 'node:assert';

process.env.FREEMODELFINDER_HOME = mkdtempSync(join(tmpdir(), 'fmf-keepalive-'));

const assert: typeof AssertStrict = (await import('node:assert/strict'))
  .default as typeof AssertStrict;
const { describe, it } = await import('node:test');
const { KeepAliveService } = await import('../keep-alive.js');
type KeepAliveSource = import('../keep-alive.js').KeepAliveSource;
const { updateConfig, loadConfig } = await import('@freemodelfinder/core');
const { createServer } = await import('../server.js');
const { ProviderRegistry } = await import('@freemodelfinder/core');

const localUiHeaders = { origin: 'http://127.0.0.1:11435', 'x-fmf-client': 'ui' };

function stubFetch(log: Array<{ url: string; auth: string | null }>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    log.push({
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null,
    });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

describe('KeepAliveService', () => {
  it('pings only enabled sources that have a baseUrl', async () => {
    const log: Array<{ url: string; auth: string | null }> = [];
    const restore = stubFetch(log);
    try {
      const svc = new KeepAliveService(
        (): KeepAliveSource[] => [
          { id: 'a', baseUrl: 'https://a.example.com/v1', keepAliveMinutes: 14 },
          { id: 'b', baseUrl: 'https://b.example.com/v1', keepAlive: false },
          { id: 'c', baseUrl: '' },
        ],
        60_000,
        () => 1_000_000,
      );
      await svc.tick();
    } finally {
      restore();
    }
    assert.deepEqual(
      log.map((e) => e.url),
      ['https://a.example.com/v1/models'],
    );
  });

  it('sends the source key as a bearer token', async () => {
    const log: Array<{ url: string; auth: string | null }> = [];
    const restore = stubFetch(log);
    try {
      const svc = new KeepAliveService(
        (): KeepAliveSource[] => [
          { id: 'a', baseUrl: 'https://a.example.com/v1', apiKey: 'secret-key' },
        ],
        60_000,
        () => 1_000_000,
      );
      await svc.tick();
    } finally {
      restore();
    }
    assert.equal(log[0]!.auth, 'Bearer secret-key');
  });

  it('ignores ping failures without throwing', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('CPA is asleep');
    }) as typeof fetch;
    try {
      const svc = new KeepAliveService(
        (): KeepAliveSource[] => [{ id: 'a', baseUrl: 'https://a.example.com/v1' }],
        60_000,
        () => 1_000_000,
      );
      await svc.tick(); // must not throw
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('pings on the first tick then waits out the interval', async () => {
    const log: Array<{ url: string; auth: string | null }> = [];
    const restore = stubFetch(log);
    const now = 1_000_000;
    try {
      const svc = new KeepAliveService(
        (): KeepAliveSource[] => [
          { id: 'a', baseUrl: 'https://a.example.com/v1', keepAliveMinutes: 14 },
        ],
        60_000,
        () => now,
      );
      await svc.tick(); // first tick → ping
      await svc.tick(); // same instant → not due
    } finally {
      restore();
    }
    assert.deepEqual(
      log.map((e) => e.url),
      ['https://a.example.com/v1/models'],
      'only the first tick pings',
    );
  });

  it('honors per-source intervals independently', async () => {
    const log: Array<{ url: string; auth: string | null }> = [];
    const restore = stubFetch(log);
    let now = 1_000_000;
    try {
      const svc = new KeepAliveService(
        (): KeepAliveSource[] => [
          { id: 'short', baseUrl: 'https://s.example.com/v1', keepAliveMinutes: 1 },
          { id: 'long', baseUrl: 'https://l.example.com/v1', keepAliveMinutes: 14 },
        ],
        60_000,
        () => now,
      );
      await svc.tick(); // both ping (fresh start)
      log.length = 0;
      now += 2 * 60_000; // advance 2 minutes
      await svc.tick(); // short (1m) due; long (14m) not
    } finally {
      restore();
    }
    assert.deepEqual(
      log.map((e) => e.url),
      ['https://s.example.com/v1/models'],
      'only the 1-minute source is due after 2 minutes',
    );
  });
});

describe('keep-alive config API', () => {
  it('persists and reads back per-source keep-alive fields', async () => {
    await updateConfig(() => ({
      version: 2,
      port: 11435,
      providers: {
        custom: {
          enabled: true,
          credentials: {
            apiKey: '',
            extra: {
              sources: [
                {
                  id: 'ka-fixture',
                  label: 'KA',
                  baseUrl: 'https://ka.example.com/v1',
                  apiKey: 'k',
                  models: [{ id: 'ka-model' }],
                  keepAlive: true,
                  keepAliveMinutes: 14,
                },
              ],
            },
          },
        },
      },
      gateway: { requireAuth: false },
      autoRoute: { enabled: false, strategy: 'capability' },
    }));

    const registry = new ProviderRegistry(await loadConfig());
    registry.listAllModels = async () => ({
      models: [],
      succeededProviders: [],
      failedProviders: [],
    });
    const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });

    // Update the source's keep-alive fields via the management API.
    const saved = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'custom',
        sources: [
          {
            id: 'ka-fixture',
            label: 'KA',
            baseUrl: 'https://ka.example.com/v1',
            apiKey: 'k',
            models: [{ id: 'ka-model' }],
            keepAlive: false,
            keepAliveMinutes: 5,
          },
        ],
      },
    });
    assert.equal(saved.statusCode, 200);

    const read = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(read.statusCode, 200);
    const cfg = read.json() as {
      custom?: { sources?: Array<{ id: string; keepAlive?: boolean; keepAliveMinutes?: number }> };
    };
    const src = cfg.custom?.sources?.find((s) => s.id === 'ka-fixture');
    assert.ok(src, 'the fixture source must be present');
    assert.equal(src!.keepAlive, false, 'keepAlive must round-trip');
    assert.equal(src!.keepAliveMinutes, 5, 'keepAliveMinutes must round-trip');

    await app.close();
  });
});
