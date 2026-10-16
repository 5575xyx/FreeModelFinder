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

  // 上游 OAuth 端点出错时回的是 JSON body。`"refresh_token":"1//0eXa…"` 这种形状
  // 既不匹配 `k=v`（没有等号），Google 的 `1//…` 又短于 40 字符，所以单独一条规则守着。
  it('masks token values inside a JSON error body', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      refresh_token: '1//0eXa-mpleTokenValue1234567890',
      access_token: 'ya29.a0AfH6SMBshortbutrealvalue',
      client_secret: 'GOCSPX-abcdefghijklmnop',
    });
    const out = redact(`google: token exchange failed 400: ${body}`);

    assert.ok(!out.includes('1//0eXa-mpleTokenValue1234567890'), `refresh_token leaked: ${out}`);
    assert.ok(!out.includes('ya29.a0AfH6SMBshortbutrealvalue'), `access_token leaked: ${out}`);
    assert.ok(!out.includes('GOCSPX-abcdefghijklmnop'), `client_secret leaked: ${out}`);
    assert.match(out, /"refresh_token":"\[REDACTED\]"/);
    // 错误码本身要保留：它是用户唯一能拿去搜索/判断的信息。
    assert.match(out, /invalid_grant/);
  });

  it('keeps non-secret JSON keys untouched', () => {
    assert.equal(
      redact('{"error":"invalid_grant","error_description":"expired"}'),
      '{"error":"invalid_grant","error_description":"expired"}',
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
