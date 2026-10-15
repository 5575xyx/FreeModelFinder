import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CORE_AGENT_TOOLS, prepareAnonymousBody, shapeKeyBody } from '../protocol/agent.js';
import { OPENCODE_TOOLS } from '../protocol/opencode-tools.js';

describe('zen agent shaping', () => {
  it('forces stream and injects the core toolset for chat', () => {
    const body = prepareAnonymousBody(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      'chat',
    );
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    const tools = body.tools as Array<Record<string, unknown>>;
    const names = tools.map((t) => (t.function as Record<string, unknown>).name);
    assert.deepEqual(names, [...CORE_AGENT_TOOLS]);
  });

  it('does not duplicate tools the client already declared', () => {
    const body = prepareAnonymousBody(
      {
        model: 'm',
        messages: [],
        tools: [
          { type: 'function', function: { name: 'shell', description: 'x', parameters: {} } },
        ],
      },
      'chat',
    );
    const tools = body.tools as Array<Record<string, unknown>>;
    const shellCount = tools.filter(
      (t) => (t.function as Record<string, unknown>).name === 'shell',
    ).length;
    assert.equal(shellCount, 1);
    assert.equal(tools.length, CORE_AGENT_TOOLS.length);
  });

  it('replaces a client-declared known tool with the official definition', () => {
    const body = prepareAnonymousBody(
      {
        model: 'm',
        messages: [],
        tools: [
          {
            type: 'function',
            function: { name: 'shell', description: 'client description', parameters: {} },
          },
        ],
      },
      'chat',
    );
    const tools = body.tools as Array<Record<string, unknown>>;
    const shell = tools.find((tool) => (tool.function as Record<string, unknown>).name === 'shell');
    const functionDef = shell?.function as Record<string, unknown>;
    assert.equal(functionDef.description, OPENCODE_TOOLS.shell?.description);
    assert.deepEqual(functionDef.parameters, OPENCODE_TOOLS.shell?.parameters);
    assert.equal(tools.length, CORE_AGENT_TOOLS.length);
  });

  it('uses anthropic tool shape for the anthropic protocol', () => {
    const body = prepareAnonymousBody({ model: 'm', messages: [] }, 'anthropic');
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.ok(tools.every((t) => typeof t.name === 'string' && 'input_schema' in t));
  });

  it('uses the flat responses tool shape for the responses protocol', () => {
    const body = prepareAnonymousBody({ model: 'm', messages: [] }, 'responses');
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.ok(
      tools.every((t) => t.type === 'function' && typeof t.name === 'string' && !('function' in t)),
    );
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, [...CORE_AGENT_TOOLS]);
  });

  it('shapeKeyBody only shapes free models and reports whether it changed', () => {
    const free = { model: 'm', messages: [] };
    const shaped = shapeKeyBody(free, 'chat', true);
    assert.equal(shaped.changed, true);
    assert.equal((shaped.body as Record<string, unknown>).stream, true);

    const paid = { model: 'm', messages: [] };
    const untouched = shapeKeyBody(paid, 'chat', false);
    assert.equal(untouched.changed, false);
    assert.equal(untouched.body, paid);
  });
});
