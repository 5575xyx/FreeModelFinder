// Redirect the config dir before any import so the server's CallLogger and the
// assertion below share one throwaway logs directory. The core/server imports
// are dynamic on purpose: CONFIG_DIR is resolved once at module load from
// FREEMODELFINDER_HOME, so it has to be set before those modules first load.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { strict as AssertStrict } from 'node:assert';

process.env.FREEMODELFINDER_HOME = mkdtempSync(join(tmpdir(), 'fmf-usage-stats-'));
const TMP_HOME = process.env.FREEMODELFINDER_HOME;

const assert: typeof AssertStrict = (await import('node:assert/strict'))
  .default as typeof AssertStrict;
const { after, describe, it } = await import('node:test');
const { CallLogger, ProviderRegistry } = await import('@freemodelfinder/core');
const { createServer } = await import('../../server.js');

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/**
 * A provider whose stream crosses a real async boundary before the usage shows
 * up, wired in without the registry's onUsage callback. That is the shape that
 * made the AsyncLocalStorage capture miss: the store was gone by the time usage
 * existed, so streamUsage stayed undefined. The usage is still on the final
 * chunk, and the route has to read it from there.
 */
function registryWithStreamingProvider(usage: {
  prompt_tokens: number;
  completion_tokens: number;
}) {
  const registry = new ProviderRegistry({
    version: 2,
    port: 0,
    providers: {},
    gateway: { requireAuth: false },
  });
  registry.listAllModels = async () => ({
    models: [
      {
        id: 'opencode:free-model',
        provider: 'opencode',
        displayName: 'free-model',
        free: true,
        capabilities: ['text'],
      },
    ],
    succeededProviders: ['opencode'],
    failedProviders: [],
  });
  registry.resolveModel = (() => ({
    provider: {
      id: 'opencode',
      async chat() {
        throw new Error('not used');
      },
      async *stream() {
        await new Promise((resolve) => setImmediate(resolve));
        yield { id: 'c', model: 'free-model', created: 1, delta: 'hi', finish_reason: 'stop' };
        // The usage-bearing frame, arriving after the async boundary.
        await new Promise((resolve) => setImmediate(resolve));
        yield { id: 'c', model: 'free-model', created: 1, delta: '', finish_reason: null, usage };
      },
    },
    modelId: 'free-model',
  })) as unknown as typeof registry.resolveModel;
  return registry;
}

describe('streamed usage reaches the call log', () => {
  it('records tokens from the final chunk when the async store is lost', async () => {
    const registry = registryWithStreamingProvider({ prompt_tokens: 4210, completion_tokens: 91 });
    const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'opencode:free-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    await app.close();

    await new CallLogger(TMP_HOME).flush();
    const stats = await new CallLogger(TMP_HOME).aggregate('today');
    const row = stats.byModel.find(
      (m) => m.provider === 'opencode' && m.model.includes('free-model'),
    );
    assert.ok(row, 'a row for the streamed model must exist');
    assert.equal(
      row!.promptTokens,
      4210,
      'prompt tokens must come from the chunk, not the lost store',
    );
    assert.equal(row!.completionTokens, 91);
  });
});
