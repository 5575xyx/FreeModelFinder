import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isStaleReasoningReference, stripStaleReasoningInputs } from '../protocol/stale.js';

describe('zen stale reasoning', () => {
  it('detects a stale reasoning reference error', () => {
    assert.equal(
      isStaleReasoningReference(
        JSON.stringify({ error: { message: "Referenced reasoning item 'rs_1' was not found or has expired" } }),
      ),
      true,
    );
  });

  it('does not treat an unrelated reasoning validation error as stale', () => {
    assert.equal(isStaleReasoningReference(JSON.stringify({ error: { message: 'unknown reasoning field' } })), false);
    assert.equal(isStaleReasoningReference('plain text'), false);
  });

  it('strips previous_response_id and reasoning input items', () => {
    const { body, changed } = stripStaleReasoningInputs({
      model: 'm',
      previous_response_id: 'resp_1',
      input: [
        { type: 'reasoning', id: 'rs_1' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    assert.equal(changed, true);
    assert.equal('previous_response_id' in body, false);
    assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: 'hi' }]);
  });

  it('reports no change when there is nothing to strip', () => {
    const { changed } = stripStaleReasoningInputs({ model: 'm', input: [{ type: 'message' }] });
    assert.equal(changed, false);
  });
});
