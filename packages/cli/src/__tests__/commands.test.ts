import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type { AppConfig, ChatRequest, StreamChunk } from '@freemodelfinder/core';

// CONFIG_DIR 在模块加载期解析，必须在 import core 之前设置 HOME，
// 否则真实 ProviderRegistry 触发的 models.dev 上下文兜底会把缓存写进开发机。
const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-cli-commands-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { ProviderRegistry } = await import('@freemodelfinder/core');
const { chatCommand } = await import('../commands/chat.js');
const { adminCommand } = await import('../commands/admin.js');
const { keyCommand } = await import('../commands/key.js');
const { modelCommand } = await import('../commands/model.js');

after(async () => {
  await rm(testHome, { recursive: true, force: true });
  delete process.env.FREEMODELFINDER_HOME;
});

function config(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: { openrouter: { enabled: false } },
  };
}

const originalLog = console.log;
const originalWrite = process.stdout.write;

afterEach(() => {
  console.log = originalLog;
  process.stdout.write = originalWrite;
});

function captureOutput(): string[] {
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return lines;
}

function configStore(initial = config()) {
  let current = initial;
  return {
    loadConfig: async () => current,
    updateConfig: async (mutator: (value: AppConfig) => AppConfig) => {
      current = mutator(current);
      return current;
    },
    current: () => current,
  };
}

function registryWithModels(): ProviderRegistry {
  const registry = new ProviderRegistry(config());
  registry.listAllModels = async () => ({
    models: [{ id: 'fixture', provider: 'custom', displayName: 'Fixture', free: true }],
    succeededProviders: ['custom'],
    failedProviders: [{ id: 'github', error: 'temporarily offline' }],
  });
  return registry;
}

describe('interactive CLI command branches', () => {
  it('adds provider keys through provider and password prompts', async () => {
    const store = configStore();
    const answers = [{ pid: 'openrouter' }, { apiKey: 'fixture-key' }];
    const output = captureOutput();
    const command = keyCommand({
      ...store,
      prompt: async () => answers.shift() as never,
    });
    await command.parseAsync(['node', 'fmf', 'add']);
    assert.equal(store.current().providers.openrouter?.enabled, true);
    assert.equal(store.current().providers.openrouter?.credentials?.apiKey, 'fixture-key');
    assert.match(output.join('\n'), /openrouter enabled/);
  });

  it('aborts empty provider keys without changing configuration', async () => {
    const store = configStore();
    const output = captureOutput();
    const command = keyCommand({
      ...store,
      prompt: async () => ({ apiKey: '' }) as never,
    });
    await command.parseAsync(['node', 'fmf', 'add', 'gemini']);
    assert.equal(store.current().providers.gemini, undefined);
    assert.match(output.join('\n'), /empty key, aborted/);
  });

  it('lists failures and models, and selects a model interactively', async () => {
    const store = configStore();
    const registry = registryWithModels();
    const output = captureOutput();
    let stopped = 0;
    const dependencies = {
      ...store,
      loadRegistry: async () => registry,
      startSpinner: () => ({
        stop: () => {
          stopped += 1;
        },
      }),
      prompt: async () => ({ model: 'custom:fixture' }) as never,
    };
    await modelCommand(dependencies).parseAsync(['node', 'fmf', 'list']);
    await modelCommand(dependencies).parseAsync(['node', 'fmf', 'use']);
    assert.equal(stopped, 2);
    assert.equal(store.current().defaultModel, 'custom:fixture');
    assert.match(output.join('\n'), /temporarily offline/);
    assert.match(output.join('\n'), /Fixture/);
  });

  it('returns cleanly when interactive model selection has no candidates', async () => {
    const store = configStore();
    const registry = new ProviderRegistry(config());
    const output = captureOutput();
    const command = modelCommand({
      ...store,
      loadRegistry: async () => registry,
      startSpinner: () => ({ stop: () => undefined }),
    });
    await command.parseAsync(['node', 'fmf', 'use']);
    assert.match(output.join('\n'), /No models available/);
  });

  it('switches models and streams an interactive chat response', async () => {
    const store = configStore({ ...config(), defaultModel: 'custom:old' });
    const registry = registryWithModels();
    const provider = {
      id: 'custom',
      async *stream(_request: ChatRequest): AsyncGenerator<StreamChunk> {
        yield {
          id: 'fixture',
          model: 'fixture',
          created: 1,
          delta: 'hello from model',
          finish_reason: 'stop',
        };
      },
    };
    registry.resolveModel = () => ({ provider: provider as never, modelId: 'fixture' });
    const answers = ['/model', 'hello', '/exit'];
    let closed = false;
    const output = captureOutput();
    const command = chatCommand({
      ...store,
      loadRegistry: async () => registry,
      prompt: async () => ({ model: 'custom:fixture' }) as never,
      createInterface: () => ({
        question: (_query, callback) => callback(answers.shift() ?? '/exit'),
        close: () => {
          closed = true;
        },
      }),
    });
    await command.parseAsync(['node', 'fmf']);
    assert.equal(closed, true);
    assert.equal(store.current().defaultModel, 'custom:fixture');
    assert.match(output.join('\n'), /hello from model/);
  });

  it('skips blank chat input and reports provider errors', async () => {
    const store = configStore({ ...config(), defaultModel: 'custom:broken' });
    const registry = registryWithModels();
    registry.resolveModel = () => {
      throw new Error('model unavailable');
    };
    const answers = ['', 'hello', '/quit'];
    const output = captureOutput();
    const command = chatCommand({
      ...store,
      loadRegistry: async () => registry,
      createInterface: () => ({
        question: (_query, callback) => callback(answers.shift() ?? '/quit'),
        close: () => undefined,
      }),
    });
    await command.parseAsync(['node', 'fmf']);
    assert.match(output.join('\n'), /model unavailable/);
  });
});

describe('fmf admin', () => {
  it('status reports when no management password is set', async () => {
    const store = configStore();
    const output = captureOutput();
    await adminCommand({ ...store }).parseAsync(['node', 'fmf', 'status']);
    assert.match(output.join('\n'), /no management password is set/);
    assert.equal(store.current().adminAuth, undefined);
  });

  it('set-password stores a verifier, never the plaintext', async () => {
    const store = configStore();
    const answers = [{ password: 'correct-horse-battery' }, { confirm: 'correct-horse-battery' }];
    const output = captureOutput();
    await adminCommand({ ...store, prompt: async () => answers.shift() as never }).parseAsync([
      'node',
      'fmf',
      'set-password',
    ]);
    const written = store.current().adminAuth;
    assert.ok(written, 'a verifier must be written');
    assert.ok(written.passwordHash.length > 0);
    assert.ok(written.passwordSalt.length > 0);
    assert.ok(written.createdAt > 0);
    assert.doesNotMatch(
      JSON.stringify(store.current()),
      /correct-horse-battery/,
      'the plaintext password must not reach the config',
    );

    assert.match(output.join('\n'), /management password saved/);
    assert.match(output.join('\n'), /TRUST_UI/);

    const statusOutput = captureOutput();
    await adminCommand({ ...store }).parseAsync(['node', 'fmf', 'status']);
    assert.match(statusOutput.join('\n'), /management password is set/);
  });

  it('aborts when the two password entries do not match', async () => {
    const store = configStore();
    const answers = [{ password: 'correct-horse-battery' }, { confirm: 'something-else' }];
    const output = captureOutput();
    await adminCommand({ ...store, prompt: async () => answers.shift() as never }).parseAsync([
      'node',
      'fmf',
      'set-password',
    ]);
    assert.equal(store.current().adminAuth, undefined);
    assert.match(output.join('\n'), /do not match/);
  });

  it('rejects a password below the minimum length', async () => {
    const store = configStore();
    const answers = [{ password: 'short' }, { confirm: 'short' }];
    const output = captureOutput();
    await adminCommand({ ...store, prompt: async () => answers.shift() as never }).parseAsync([
      'node',
      'fmf',
      'reset-password',
    ]);
    assert.equal(store.current().adminAuth, undefined);
    assert.match(output.join('\n'), /at least 8 characters/);
  });

  it('clear-password needs confirmation and removes the verifier', async () => {
    const existing = { passwordHash: 'h', passwordSalt: 's', createdAt: 1 };
    const store = configStore({ ...config(), adminAuth: existing });

    const declined = captureOutput();
    await adminCommand({ ...store, prompt: async () => ({ ok: false }) as never }).parseAsync([
      'node',
      'fmf',
      'clear-password',
    ]);
    assert.equal(store.current().adminAuth, existing);
    assert.match(declined.join('\n'), /aborted/);

    await adminCommand({ ...store, prompt: async () => ({ ok: true }) as never }).parseAsync([
      'node',
      'fmf',
      'clear-password',
    ]);
    assert.equal(store.current().adminAuth, undefined);
  });

  it('clear-password on an unset config is a no-op', async () => {
    const store = configStore();
    const output = captureOutput();
    await adminCommand({ ...store }).parseAsync(['node', 'fmf', 'clear-password']);
    assert.equal(store.current().adminAuth, undefined);
    assert.match(output.join('\n'), /no management password is set/);
  });

  it('reset-password replaces an existing verifier', async () => {
    const existing = { passwordHash: 'old-hash', passwordSalt: 'old-salt', createdAt: 1 };
    const store = configStore({ ...config(), adminAuth: existing });
    const answers = [{ password: 'brand-new-password' }, { confirm: 'brand-new-password' }];
    await adminCommand({ ...store, prompt: async () => answers.shift() as never }).parseAsync([
      'node',
      'fmf',
      'reset-password',
    ]);
    const replaced = store.current().adminAuth;
    assert.ok(replaced);
    assert.notEqual(replaced.passwordHash, 'old-hash');
    assert.notEqual(replaced.passwordSalt, 'old-salt');
    assert.notEqual(replaced.createdAt, 1);
  });
});
