import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CallbackParseError, parseCallbackUrl } from '../oauth/parse-callback.js';

describe('parseCallbackUrl', () => {
  it('returns null for empty and whitespace-only input', () => {
    assert.equal(parseCallbackUrl(''), null);
    assert.equal(parseCallbackUrl('   \t '), null);
  });

  it('parses a full callback URL', () => {
    assert.deepEqual(
      parseCallbackUrl('http://localhost:1455/auth/callback?code=CODE_A&state=STATE_A'),
      { code: 'CODE_A', state: 'STATE_A' },
    );
  });

  it('parses a bare query string by prefixing http://localhost', () => {
    assert.deepEqual(parseCallbackUrl('?code=CODE_B&state=STATE_B'), {
      code: 'CODE_B',
      state: 'STATE_B',
    });
  });

  it('parses a bare path by prefixing http://', () => {
    assert.deepEqual(parseCallbackUrl('auth/callback?code=CODE_C&state=STATE_C'), {
      code: 'CODE_C',
      state: 'STATE_C',
    });
  });

  it('parses bare k=v by prefixing http://localhost/?', () => {
    assert.deepEqual(parseCallbackUrl('code=CODE_D&state=STATE_D'), {
      code: 'CODE_D',
      state: 'STATE_D',
    });
  });

  it('splits a bare code#state pair (Claude form)', () => {
    assert.deepEqual(parseCallbackUrl('CODE_E#STATE_E'), {
      code: 'CODE_E',
      state: 'STATE_E',
    });
  });

  it('splits a percent-encoded # inside the code value', () => {
    assert.deepEqual(parseCallbackUrl('http://localhost:54545/callback?code=CODE_F%23STATE_F'), {
      code: 'CODE_F',
      state: 'STATE_F',
    });
  });

  it('reads code and state from the URL fragment when the query is empty', () => {
    assert.deepEqual(
      parseCallbackUrl('http://localhost:1455/auth/callback#code=CODE_G&state=STATE_G'),
      { code: 'CODE_G', state: 'STATE_G' },
    );
  });

  it('prefers the query values over fragment values', () => {
    assert.deepEqual(
      parseCallbackUrl(
        'http://x/cb?code=FROM_QUERY&state=FROM_QUERY#code=FROM_FRAG&state=FROM_FRAG',
      ),
      { code: 'FROM_QUERY', state: 'FROM_QUERY' },
    );
  });

  it('surfaces an error-only callback as a failure with no code', () => {
    assert.deepEqual(parseCallbackUrl('http://x/cb?error=access_denied&state=STATE_H'), {
      code: '',
      state: 'STATE_H',
      error: 'access_denied',
    });
  });

  it('promotes error_description to error when error is absent', () => {
    assert.deepEqual(parseCallbackUrl('http://x/cb?error_description=forbidden&state=S'), {
      code: '',
      state: 'S',
      error: 'forbidden',
    });
  });

  it('keeps error when both error and error_description are present', () => {
    assert.deepEqual(
      parseCallbackUrl('http://x/cb?error=access_denied&error_description=forbidden&state=S'),
      { code: '', state: 'S', error: 'access_denied' },
    );
  });

  it('omits the error key when there is no error', () => {
    const parsed = parseCallbackUrl('http://x/cb?code=C&state=S')!;
    assert.equal('error' in parsed, false);
  });

  it('trims whitespace around the input and around each value', () => {
    assert.deepEqual(parseCallbackUrl('  http://x/cb?code=%20C%20&state=%20S%20  '), {
      code: 'C',
      state: 'S',
    });
  });

  it('throws CallbackParseError for input with no URL shape at all', () => {
    assert.throws(() => parseCallbackUrl('not a url'), CallbackParseError);
  });

  it('throws CallbackParseError when the input is a URL but carries neither code nor error', () => {
    assert.throws(
      () => parseCallbackUrl('http://localhost:1455/auth/callback'),
      CallbackParseError,
    );
    assert.match(
      (() => {
        try {
          parseCallbackUrl('http://localhost:1455/auth/callback');
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
      })(),
      /missing code/,
    );
  });

  it('throws CallbackParseError for a syntactically invalid URL', () => {
    assert.throws(() => parseCallbackUrl('://nope'), CallbackParseError);
  });
});
