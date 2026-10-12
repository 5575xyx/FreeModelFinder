import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { resolveContentLengthLimit } from '../server.js';

const ENV_KEY = 'FREEMODELFINDER_MAX_BODY_MB';
const DEFAULT_BYTES = 16 * 1024 * 1024;

describe('resolveContentLengthLimit', () => {
  const saved = process.env[ENV_KEY];

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it('returns 16 MiB when the env var is unset', () => {
    delete process.env[ENV_KEY];
    assert.equal(resolveContentLengthLimit(), DEFAULT_BYTES);
  });

  it('honours a positive whole number of megabytes', () => {
    process.env[ENV_KEY] = '48';
    assert.equal(resolveContentLengthLimit(), 48 * 1024 * 1024);
  });

  it('honours a fractional number of megabytes', () => {
    process.env[ENV_KEY] = '1.5';
    assert.equal(resolveContentLengthLimit(), Math.floor(1.5 * 1024 * 1024));
  });

  it('falls back to the default for a zero or negative value', () => {
    for (const bad of ['0', '-4', 'nan', 'abc', '']) {
      process.env[ENV_KEY] = bad;
      assert.equal(
        resolveContentLengthLimit(),
        DEFAULT_BYTES,
        `expected default for ${JSON.stringify(bad)}`,
      );
    }
  });

  it('ignores Infinity', () => {
    process.env[ENV_KEY] = 'Infinity';
    assert.equal(resolveContentLengthLimit(), DEFAULT_BYTES);
  });
});
