import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../redact';

describe('redactSecrets', () => {
  // 与 packages/core 的 redact 同一份契约（见那里的 @remarks）。UI 这份是第二道防线：
  // 上游把令牌拼进错误文案时，屏幕上绝不能出现它。
  it('masks token values inside a JSON error body', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      refresh_token: '1//0eXa-mpleTokenValue1234567890',
      access_token: 'ya29.a0AfH6SMBshortbutrealvalue',
      client_secret: 'GOCSPX-abcdefghijklmnop',
    });

    const out = redactSecrets(`google: token exchange failed 400: ${body}`);

    expect(out).not.toContain('1//0eXa-mpleTokenValue1234567890');
    expect(out).not.toContain('ya29.a0AfH6SMBshortbutrealvalue');
    expect(out).not.toContain('GOCSPX-abcdefghijklmnop');
    expect(out).toContain('invalid_grant');
  });

  it('masks prefixed keys and bearer tokens', () => {
    expect(redactSecrets('key sk-proj-abcdef1234567890')).not.toContain('sk-proj-abcdef1234567890');
    expect(redactSecrets('Authorization: Bearer abc.def-123_ghi')).toContain('Bearer [REDACTED]');
  });

  it('keeps ordinary messages untouched', () => {
    expect(redactSecrets('rate limited for 60 seconds')).toBe('rate limited for 60 seconds');
  });
});
