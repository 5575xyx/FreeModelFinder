import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact } from '../redact.js';

describe('redact', () => {
  it('masks bearer tokens', () => {
    assert.equal(
      redact('upstream rejected Authorization: Bearer abc.def-123_ghi'),
      'upstream rejected Authorization: Bearer [REDACTED]',
    );
  });

  it('masks refresh_token query values', () => {
    assert.equal(
      redact('POST /auth/refresh?refresh_token=s3cr3t-value&grant_type=refresh_token'),
      'POST /auth/refresh?refresh_token=[REDACTED]&grant_type=refresh_token',
    );
  });

  it('masks long base64-looking blobs', () => {
    const blob = 'A'.repeat(48);
    assert.equal(redact(`cipher ${blob} tail`), 'cipher [REDACTED] tail');
  });

  it('keeps ordinary messages untouched', () => {
    assert.equal(redact('rate limited for 60 seconds'), 'rate limited for 60 seconds');
  });
});
