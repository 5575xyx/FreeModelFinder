import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProxy, parseProxyList, redactProxy } from '../proxy/spec.js';

describe('zen proxy spec', () => {
  it('parses direct', () => {
    assert.deepEqual(parseProxy('direct'), { kind: 'direct', label: 'direct' });
  });

  it('parses http/https/socks5/socks5h with credentials', () => {
    assert.equal(parseProxy('http://user:pass@127.0.0.1:7890')?.kind, 'http');
    assert.equal(parseProxy('https://127.0.0.1:7890')?.kind, 'https');
    assert.equal(parseProxy('socks5://127.0.0.1:1080')?.kind, 'socks5');
    assert.equal(parseProxy('socks5h://127.0.0.1:1080')?.kind, 'socks5h');
  });

  it('rejects garbage and unsupported schemes', () => {
    assert.equal(parseProxy(''), null);
    assert.equal(parseProxy('not a url'), null);
    assert.equal(parseProxy('ftp://x:1'), null);
  });

  it('redacts credentials in the label', () => {
    const spec = parseProxy('http://user:secret@127.0.0.1:7890');
    assert.ok(spec);
    assert.equal(spec.label.includes('secret'), false);
  });

  it('loads config proxies then proxyfile, dedupes by order, and defaults to direct', () => {
    const list = parseProxyList(
      ['http://a:1', 'direct'],
      '# comment\nsocks5://b:2   # inline\nhttp://a:1\n\n; another\n',
    );
    assert.deepEqual(
      list.map((p) => p.label),
      ['http://a:1/', 'direct', 'socks5://b:2/'],
    );
    assert.deepEqual(parseProxyList([], ''), [{ kind: 'direct', label: 'direct' }]);
  });

  it('redactProxy hides userinfo', () => {
    assert.equal(redactProxy('http://u:p@h:1').includes('u:p@'), false);
  });

  it('keeps proxies that differ only by credentials', () => {
    const list = parseProxyList(
      ['http://u1:p1@10.0.0.1:8080', 'http://u2:p2@10.0.0.1:8080'],
      undefined,
    );
    assert.equal(list.length, 2);
    assert.equal(list[0]?.label, list[1]?.label);
  });

  it('still dedupes identical proxy strings', () => {
    const list = parseProxyList(['http://a:1', 'http://a:1'], undefined);
    assert.equal(list.length, 1);
  });
});
