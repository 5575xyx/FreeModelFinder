import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readJsonCache, writeJsonCache } from '../models/cache.js';

describe('zen json cache', () => {
  it('round-trips a payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-cache-'));
    try {
      const path = join(dir, 'catalog.json');
      await writeJsonCache(path, { updatedAt: 1, models: { a: true } });
      const loaded = await readJsonCache<{ updatedAt: number; models: Record<string, boolean> }>(path);
      assert.deepEqual(loaded, { updatedAt: 1, models: { a: true } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a missing file', async () => {
    const loaded = await readJsonCache('/definitely/not/here/nope.json');
    assert.equal(loaded, undefined);
  });

  it('returns undefined for malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-cache-'));
    try {
      const path = join(dir, 'bad.json');
      await writeFile(path, '{ not json');
      assert.equal(await readJsonCache(path), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing cache file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-cache-'));
    try {
      const path = join(dir, 'over.json');
      await writeJsonCache(path, { v: 1 });
      await writeJsonCache(path, { v: 2 });
      assert.deepEqual(await readJsonCache(path), { v: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
