import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeContextTable } from '../models-dev-context.js';

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
