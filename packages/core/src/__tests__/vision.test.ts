import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  looksVisionModelId,
  isVisionCapable,
  withVisionInput,
  assertImageDataUrlWithinLimit,
} from '../vision.js';
import { GeminiProvider } from '../providers/gemini.js';
import type { ChatRequest, ModelInfo } from '../types.js';

describe('vision helpers', () => {
  it('looksVisionModelId matches common vision ids', () => {
    assert.equal(looksVisionModelId('qwen2.5-vl-7b-instruct'), true);
    assert.equal(looksVisionModelId('google/gemini-2.0-flash-exp:free'), false);
    assert.equal(looksVisionModelId('meta/llama-3.2-11b-vision-instruct:free'), true);
    assert.equal(looksVisionModelId('gpt-4o-mini'), false);
    assert.equal(looksVisionModelId('glm-4v-flash'), true);
  });

  it('withVisionInput appends image when missing', () => {
    const m = { id: 'x', provider: 'openrouter', displayName: 'X', free: true } as ModelInfo;
    const out = withVisionInput(m);
    assert.deepEqual(out.inputModalities, ['text', 'image']);
    const already = withVisionInput({ ...m, inputModalities: ['image'] });
    assert.deepEqual(already.inputModalities, ['image']);
  });

  it('isVisionCapable uses metadata, heuristic, or forced pool ids', () => {
    const meta = {
      id: 'a',
      provider: 'openrouter',
      displayName: 'a',
      free: true,
      inputModalities: ['image'],
    } as ModelInfo;
    assert.equal(isVisionCapable(meta, []), true);
    const heuristic = {
      id: 'llava-1.5',
      provider: 'custom',
      displayName: 'b',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(heuristic, []), true);
    const forced = {
      id: 'custom:special-vision',
      provider: 'custom',
      displayName: 'c',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(forced, ['custom:special-vision']), true);
    const textOnly = {
      id: 'gpt-4o-mini',
      provider: 'openrouter',
      displayName: 'd',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(textOnly, []), false);
    const declaredTextOnly = {
      id: 'llava-x',
      provider: 'openrouter',
      displayName: 'e',
      free: true,
      inputModalities: ['text'],
    } as ModelInfo;
    assert.equal(isVisionCapable(declaredTextOnly, []), false);
  });

  it('rejects oversized data URLs', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(14 * 1024 * 1024);
    assert.throws(() => assertImageDataUrlWithinLimit(big), /10MB/);
    assertImageDataUrlWithinLimit('data:image/png;base64,AAAA');
    assertImageDataUrlWithinLimit('https://example.com/a.png');
  });
});

describe('gemini outbound image parts', () => {
  function geminiProvider(capture: { body?: unknown }) {
    return new GeminiProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        capture.body = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
  }

  it('encodes contentParts into text then inlineData/fileData', async () => {
    const capture: { body?: unknown } = {};
    const provider = geminiProvider(capture);
    const req: ChatRequest = {
      model: 'gemini-3.5-flash',
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'describe',
          contentParts: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    };
    await provider.chat(req);
    const body = capture.body as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      systemInstruction?: unknown;
    };
    const parts = body.contents[0]!.parts;
    assert.deepEqual(parts[0], { text: 'describe' });
    assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    assert.deepEqual(parts[2], { fileData: { fileUri: 'https://example.com/a.png' } });
    assert.equal(body.systemInstruction, undefined);
  });

  it('keeps text-only messages and system instruction unchanged', async () => {
    const capture: { body?: unknown } = {};
    const provider = geminiProvider(capture);
    const req: ChatRequest = {
      model: 'gemini-3.5-flash',
      stream: false,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    await provider.chat(req);
    const body = capture.body as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      systemInstruction?: { parts: Array<Record<string, unknown>> };
    };
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
    assert.deepEqual(body.contents, [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
  });

  it('rejects oversized data URL image in contentParts', async () => {
    const capture: { body?: unknown } = {};
    const provider = geminiProvider(capture);
    const big = 'data:image/png;base64,' + 'A'.repeat(14 * 1024 * 1024);
    const req: ChatRequest = {
      model: 'gemini-3.5-flash',
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'see',
          contentParts: [{ type: 'image_url', image_url: { url: big } }],
        },
      ],
    };
    await assert.rejects(() => provider.chat(req), /10MB/);
  });
});
