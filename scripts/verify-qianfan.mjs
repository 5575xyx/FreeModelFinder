import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CORE_DIST = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');

if (!existsSync(CORE_DIST)) {
  console.error(
    '[verify-qianfan] packages/core/dist/index.js is missing. Run `pnpm --filter @freemodelfinder/core build` first.',
  );
  process.exit(1);
}

const apiKey = process.env.QIANFAN_API_KEY;
if (!apiKey) {
  console.error('[verify-qianfan] QIANFAN_API_KEY is not set.');
  process.exit(1);
}

const { ProviderRegistry } = await import(CORE_DIST);

const registry = new ProviderRegistry({
  version: 1,
  port: 11435,
  providers: {
    qianfan: {
      enabled: true,
      credentials: { apiKey },
    },
  },
});

const provider = registry.getProvider('qianfan');
const models = await provider.listModels();
console.log(
  'free models:',
  models.map((m) => m.id),
);

// upstream QPS limit is ~1 req/s, so pace the probes to avoid false failures
for (const model of models) {
  console.log(`\n=== ${model.id} ===`);
  try {
    const res = await Promise.race([
      provider.chat({
        model: model.id,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('chat timeout after 30s')), 30_000),
      ),
    ]);
    console.log('OK content:', JSON.stringify(res.content));
  } catch (err) {
    console.log('FAIL:', err.message);
    process.exitCode = 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 1100));
}
