import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { decodeContextTable, ModelsDevContextStore } from '../models-dev-context.js';

const model = (ctx?: number, canonical?: string) => ({
  ...(ctx !== undefined ? { limit: { context: ctx } } : {}),
  ...(canonical !== undefined ? { canonical_model_id: canonical } : {}),
});

test('indexes both the model id and its canonical id', () => {
  const table = decodeContextTable({
    deepseek: {
      models: {
        'deepseek-v4-flash': {
          id: 'deepseek-v4-flash',
          ...model(1_000_000, 'deepseek/deepseek-v4-flash'),
        },
      },
    },
  });
  assert.equal(table.get('deepseek-v4-flash'), 1_000_000);
  assert.equal(table.get('deepseek/deepseek-v4-flash'), 1_000_000);
});

test('picks the most frequent context value', () => {
  const table = decodeContextTable({
    a: { models: { x: { id: 'x', ...model(1_000_000) } } },
    b: { models: { x: { id: 'x', ...model(1_000_000) } } },
    c: { models: { x: { id: 'x', ...model(327_680) } } },
  });
  assert.equal(table.get('x'), 1_000_000);
});

test('breaks ties toward the smaller value', () => {
  const table = decodeContextTable({
    a: { models: { x: { id: 'x', ...model(1_048_576) } } },
    b: { models: { x: { id: 'x', ...model(1_000_000) } } },
  });
  assert.equal(table.get('x'), 1_000_000);
});

test('skips models without a positive context limit', () => {
  const table = decodeContextTable({
    a: {
      models: {
        noLimit: { id: 'noLimit' },
        zero: { id: 'zero', ...model(0) },
        text: { id: 'text', limit: { context: '128k' } },
        ok: { id: 'ok', ...model(65_536) },
      },
    },
  });
  assert.equal(table.size, 1);
  assert.equal(table.get('ok'), 65_536);
  assert.equal(table.has('zero'), false);
  assert.equal(table.has('text'), false);
});

test('rejects a payload that is not an object', () => {
  assert.throws(() => decodeContextTable('nope'));
});

test('rejects a payload that yields no context metadata', () => {
  assert.throws(() => decodeContextTable({ a: { models: { x: { id: 'x' } } } }));
});

describe('ModelsDevContextStore', () => {
  let home: string;
  let previousHome: string | undefined;

  const cachePath = () => join(home, 'models.dev.context.json');
  const writeTable = (table: Record<string, number>) => {
    writeFileSync(cachePath(), JSON.stringify({ updated_at: Date.now(), table }));
  };
  const storeOf = (
    fetchImpl: typeof fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch,
  ) => new ModelsDevContextStore({ dir: home, fetchImpl });

  beforeEach(() => {
    previousHome = process.env.FREEMODELFINDER_HOME;
    home = mkdtempSync(join(tmpdir(), 'fmf-ctx-'));
    process.env.FREEMODELFINDER_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.FREEMODELFINDER_HOME;
    else process.env.FREEMODELFINDER_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('matches a prefixed cline id by its last segment', async () => {
    writeTable({ 'deepseek-v4.1-flash': 1_000_000 });
    const store = storeOf();
    await store.loadFromDisk();
    assert.equal(
      store.lookup({ provider: 'cline', id: 'cline-free/deepseek-v4.1-flash' }),
      1_000_000,
    );
    assert.equal(store.lookup({ provider: 'cline', id: 'deepseek/deepseek-v4-flash' }), undefined);
  });

  test('returns the raw id hit before trying the last segment', async () => {
    writeTable({ 'a/b': 8_192, b: 65_536 });
    const store = storeOf();
    await store.loadFromDisk();
    assert.equal(store.lookup({ provider: 'custom', id: 'a/b' }), 8_192);
  });

  test('returns undefined for unknown ids instead of guessing', async () => {
    writeTable({ 'deepseek-v4.1-flash': 1_000_000 });
    const store = storeOf();
    await store.loadFromDisk();
    assert.equal(store.lookup({ provider: 'custom', id: 'some/ghost-model' }), undefined);
  });

  test('ignores a corrupt cache file without throwing', async () => {
    writeFileSync(cachePath(), '{ not json');
    const store = storeOf();
    await store.loadFromDisk();
    assert.equal(store.lookup({ provider: 'custom', id: 'anything' }), undefined);
  });

  test('refresh survives a network failure', async () => {
    const store = storeOf();
    await store.refresh();
    assert.equal(store.lookup({ provider: 'custom', id: 'anything' }), undefined);
  });
});
