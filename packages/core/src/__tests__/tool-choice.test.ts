import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropicToChatRequest, type AnthropicMessagesRequest } from '../protocols/anthropic.js';
import { geminiToChatRequest, type GeminiHttpRequest } from '../protocols/gemini.js';
import { openAIToChatRequest, type OpenAIChatCompletionRequest } from '../protocols/openai.js';
import {
  fromAnthropicToolChoice,
  fromGeminiToolConfig,
  toAnthropicToolChoice,
  toGeminiToolConfig,
} from '../protocols/tool-choice.js';
import { ChatRequestSchema, type ToolChoice } from '../types.js';

const FN: ToolChoice = { type: 'function', function: { name: 'get_weather' } };
const MESSAGES: OpenAIChatCompletionRequest['messages'] = [{ role: 'user', content: 'hi' }];

function anthropicBody(extra: Partial<AnthropicMessagesRequest>): AnthropicMessagesRequest {
  return { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra };
}

function geminiBody(extra: Partial<GeminiHttpRequest>): GeminiHttpRequest {
  return { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], ...extra };
}

describe('ChatRequest carries tool-calling preferences', () => {
  it('accepts every tool_choice shape together with parallel_tool_calls', () => {
    for (const tool_choice of ['auto', 'required', 'none', null, FN] as const) {
      const parsed = ChatRequestSchema.parse({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice,
        parallel_tool_calls: false,
      });
      assert.deepEqual(parsed.tool_choice, tool_choice);
      assert.equal(parsed.parallel_tool_calls, false);
    }
  });

  it('leaves them undefined when the client does not send them', () => {
    const parsed = ChatRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(parsed.tool_choice, undefined);
    assert.equal(parsed.parallel_tool_calls, undefined);
  });

  it('keeps them through the OpenAI ingress unchanged', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: MESSAGES,
      tool_choice: 'required',
      parallel_tool_calls: false,
    });
    assert.equal(out.tool_choice, 'required');
    assert.equal(out.parallel_tool_calls, false);
  });
});

describe('Anthropic boundary', () => {
  it('maps every Anthropic form into the internal OpenAI shape', () => {
    assert.equal(
      anthropicToChatRequest(anthropicBody({ tool_choice: { type: 'auto' } })).tool_choice,
      'auto',
    );
    assert.equal(
      anthropicToChatRequest(anthropicBody({ tool_choice: { type: 'any' } })).tool_choice,
      'required',
    );
    assert.deepEqual(
      anthropicToChatRequest(anthropicBody({ tool_choice: { type: 'tool', name: 'get_weather' } }))
        .tool_choice,
      FN,
    );
    assert.equal(
      anthropicToChatRequest(anthropicBody({ disable_parallel_tool_use: true }))
        .parallel_tool_calls,
      false,
    );
    assert.equal(
      anthropicToChatRequest(anthropicBody({ disable_parallel_tool_use: false }))
        .parallel_tool_calls,
      true,
    );
  });

  it('maps the internal shape back to Anthropic fields, inverted for parallel use', () => {
    assert.deepEqual(toAnthropicToolChoice('auto', undefined), {
      tool_choice: { type: 'auto' },
    });
    assert.deepEqual(toAnthropicToolChoice('required', undefined), {
      tool_choice: { type: 'any' },
    });
    assert.deepEqual(toAnthropicToolChoice(FN, undefined), {
      tool_choice: { type: 'tool', name: 'get_weather' },
    });
    assert.deepEqual(toAnthropicToolChoice('auto', false), {
      tool_choice: { type: 'auto' },
      disable_parallel_tool_use: true,
    });
    assert.deepEqual(toAnthropicToolChoice('auto', true), {
      tool_choice: { type: 'auto' },
      disable_parallel_tool_use: false,
    });
  });

  it('drops "none" because Anthropic cannot forbid tool use', () => {
    assert.deepEqual(toAnthropicToolChoice('none', undefined), {});
    // And so the round trip loses it by design, not by accident.
    assert.deepEqual(fromAnthropicToolChoice(toAnthropicToolChoice('none', undefined)), {});
  });

  it('round-trips the lossless cases back to the OpenAI shape', () => {
    assert.deepEqual(fromAnthropicToolChoice(toAnthropicToolChoice('auto', undefined)), {
      tool_choice: 'auto',
    });
    assert.deepEqual(fromAnthropicToolChoice(toAnthropicToolChoice('required', undefined)), {
      tool_choice: 'required',
    });
    assert.deepEqual(fromAnthropicToolChoice(toAnthropicToolChoice(FN, false)), {
      tool_choice: FN,
      parallel_tool_calls: false,
    });
  });
});

describe('Gemini boundary', () => {
  it('maps every functionCallingConfig into the internal OpenAI shape', () => {
    const cfg = (c: NonNullable<GeminiHttpRequest['toolConfig']>['functionCallingConfig']) =>
      geminiToChatRequest('m', geminiBody({ toolConfig: { functionCallingConfig: c } }));
    assert.equal(cfg({ mode: 'AUTO' }).tool_choice, 'auto');
    assert.equal(cfg({ mode: 'ANY' }).tool_choice, 'required');
    assert.equal(cfg({ mode: 'NONE' }).tool_choice, 'none');
    assert.deepEqual(cfg({ allowedFunctionNames: ['get_weather'] }).tool_choice, FN);
    assert.equal(cfg({ allowedFunctionNames: ['a', 'b'] }).tool_choice, 'required');
    assert.equal(cfg({ parallelFunctionCalling: false }).parallel_tool_calls, false);
    assert.equal(cfg({ mode: 'ANY', parallelFunctionCalling: false }).parallel_tool_calls, false);
  });

  it('maps the internal shape back to Gemini toolConfig', () => {
    assert.deepEqual(toGeminiToolConfig('auto', undefined), {
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
    assert.deepEqual(toGeminiToolConfig('required', undefined), {
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    });
    assert.deepEqual(toGeminiToolConfig('none', undefined), {
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
    assert.deepEqual(toGeminiToolConfig(FN, undefined), {
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
    });
    assert.deepEqual(toGeminiToolConfig('auto', false), {
      toolConfig: { functionCallingConfig: { mode: 'AUTO', parallelFunctionCalling: false } },
    });
  });

  it('emits nothing at all when the client set no preference', () => {
    assert.equal(toGeminiToolConfig(undefined, undefined), undefined);
    assert.equal(toGeminiToolConfig(null, undefined), undefined);
  });

  it('round-trips the lossless cases back to the OpenAI shape', () => {
    assert.deepEqual(fromGeminiToolConfig(toGeminiToolConfig('auto', undefined)!), {
      tool_choice: 'auto',
    });
    assert.deepEqual(fromGeminiToolConfig(toGeminiToolConfig('required', undefined)!), {
      tool_choice: 'required',
    });
    assert.deepEqual(fromGeminiToolConfig(toGeminiToolConfig('none', undefined)!), {
      tool_choice: 'none',
    });
    assert.deepEqual(fromGeminiToolConfig(toGeminiToolConfig(FN, false)!), {
      tool_choice: FN,
      parallel_tool_calls: false,
    });
  });
});
