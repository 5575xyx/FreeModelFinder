import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildUpstreamRequest, clientProjectID } from '../gateway/upstream.js';
import type { ZenRequestIds } from '../gateway/upstream.js';
import type { ProxySpec } from '../proxy/spec.js';

function ids(overrides: Partial<ZenRequestIds> = {}): ZenRequestIds {
  return { request: 'req-1', session: 'ses_abc123', project: 'global', ...overrides };
}

describe('buildUpstreamRequest fingerprint', () => {
  it('sends the session id header and drops the legacy request header', () => {
    const req = buildUpstreamRequest(
      'https://opencode.ai/inference',
      'chat',
      { model: 'm' },
      ids(),
      'public',
      {} as ProxySpec,
    );
    assert.equal(req.headers['x-opencode-session'], 'ses_abc123');
    assert.equal(req.headers['x-opencode-session-id'], 'ses_abc123');
    assert.equal(req.headers['x-opencode-request'], undefined, 'x-opencode-request must be gone');
  });

  it('hashes the project id to 40 lowercase hex chars', () => {
    const req = buildUpstreamRequest(
      'https://opencode.ai/inference',
      'chat',
      {},
      ids({ project: 'global' }),
      'public',
      {} as ProxySpec,
    );
    assert.match(req.headers['x-opencode-project'] as string, /^[0-9a-f]{40}$/);
  });

  it('uses the new user agent', () => {
    const req = buildUpstreamRequest(
      'https://opencode.ai/inference',
      'chat',
      {},
      ids(),
      'public',
      {} as ProxySpec,
    );
    assert.equal(req.headers['user-agent'], 'opencode/latest/2.0.29/cli');
  });
});

describe('clientProjectID', () => {
  it('is a stable 40-char hex digest', () => {
    assert.match(clientProjectID('global'), /^[0-9a-f]{40}$/);
    assert.equal(clientProjectID('global'), clientProjectID('global'));
    assert.notEqual(clientProjectID('global'), clientProjectID('other'));
  });
});
