# Vision Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing `autoRoute.visionModel` pool as a third multi-select in the Settings → 模态路由 card, with backend-tagged vision candidates.

**Architecture:** Server tags each `GET /api/auto-route/model-options` entry with `vision: boolean` via core `isVisionCapable` (heuristic + `inputModalities` + forced pool). UI adds `vision` to `matchesCapability`/`filterCapability`, a third `ModelMultiSelect` bound to `visionModel`, and zh/en i18n. Save reuses the existing `POST /api/auto-route` merge path — no new endpoint.

**Tech Stack:** Fastify + node:test (server), Next.js + Vitest + RTL + MSW (ui), pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-09-24-vision-model-selector-design.md`

---

## File Structure

| Action | File | Responsibility |
| ------ | ---- | -------------- |
| Modify | `packages/server/src/server.ts` | Tag `vision` on `model-options` entries (`~lines 7-15` import, `~lines 1005-1057` handler) |
| Test   | `packages/server/src/__tests__/model-options.test.ts` | Failing tests for `vision` tagging |
| Modify | `packages/ui/app/components/ModelMultiSelect.tsx` | `ModelOption.vision`, `filterCapability: 'vision'`, `matchesCapability` vision branch |
| Modify | `packages/ui/app/components/SettingsView.tsx` | `AutoRouteInfo.visionModel`, third selector, grid `sm:grid-cols-3` (`~line 1308`) |
| Modify | `packages/ui/app/i18n.tsx` | `visionModel` label/placeholder + desc sentences (zh `~line 244`, en `~line 712`) |
| Modify | `packages/ui/test/server.ts` | MSW fixtures: `visionModel: []` on auto-route GET; vision-tagged model option |
| Test   | `packages/ui/app/components/__tests__/settings.test.tsx` | Failing render/POST tests + `matchesCapability` vision cases |

**Conventions (from repo AGENTS.md):** TDD (RED → GREEN); per-file `npx prettier --write` before commit; `npx eslint ... --max-warnings=0`; never run `pnpm build` and `pnpm typecheck` in parallel; PowerShell — chain with `if ($?) { ... }`, never `&&`.

**Test commands:**

```bash
# server (single file)
pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/model-options.test.ts
# server (full)
pnpm --filter @freemodelfinder/server test
# ui (settings.test.tsx is flaky in parallel — always singly)
pnpm --filter @freemodelfinder/ui exec vitest run app/components/__tests__/settings.test.tsx
# ui (full)
pnpm --filter @freemodelfinder/ui test
```

---

### Task 1: Server — tag `vision` on model-options

**Files:**
- Modify: `packages/server/src/server.ts` (import block `:7-15`, handler `:1005-1057`)
- Test: `packages/server/src/__tests__/model-options.test.ts`

- [ ] **Step 1: Extend the test config fixture with a vision-like id**

In `model-options.test.ts`, add one model to the `fixture` source models array (after `{ id: 'sora-image', ... }`):

```ts
models: [
  { id: 'plain-chat', displayName: 'Plain' },
  { id: 'sora-image', displayName: 'Img' },
  { id: 'llava-mini', displayName: 'LLaVA Mini' },
  { id: '', displayName: 'Empty' },
  { id: '   ', displayName: 'Whitespace' },
],
```

- [ ] **Step 2: Parameterize `withApp` with an optional config factory**

Replace the existing `withApp` signature so a second config can be injected (forced-pool test). Keep the body identical except the first line:

```ts
async function withApp(
  fn: (app: FastifyInstance, registry: ProviderRegistry) => Promise<void>,
  makeConfig: () => AppConfig = configWithCustomModels,
): Promise<void> {
  const registry = new ProviderRegistry(makeConfig());
  // ...rest unchanged (listAllCalls guard, createServer, 50ms settle, finally close)
}
```

Add a second config factory next to `configWithCustomModels`:

```ts
function configWithForcedVision(): AppConfig {
  const cfg = configWithCustomModels();
  cfg.autoRoute = {
    enabled: false,
    strategy: 'capability',
    visionModel: ['custom:fixture:plain-chat'],
  };
  return cfg;
}
```

- [ ] **Step 3: Write the failing tests**

Append to `model-options.test.ts`:

```ts
describe('GET /api/auto-route/model-options vision tags', () => {
  it('tags heuristic vision ids true and plain ids false', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
        headers: localUiHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { models: Array<{ id: string; vision?: boolean }> };
      const vision = body.models.find((m) => m.id === 'custom:fixture:llava-mini');
      const plain = body.models.find((m) => m.id === 'custom:fixture:plain-chat');
      assert.equal(vision?.vision, true, 'llava-mini should be vision-tagged');
      assert.equal(plain?.vision, false, 'plain-chat should not be vision-tagged');
    });
  });

  it('forced visionModel pool marks listed ids vision even without heuristic match', async () => {
    await withApp(
      async (app) => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/auto-route/model-options',
          headers: localUiHeaders,
        });
        assert.equal(res.statusCode, 200);
        const body = res.json() as { models: Array<{ id: string; vision?: boolean }> };
        const plain = body.models.find((m) => m.id === 'custom:fixture:plain-chat');
        assert.equal(plain?.vision, true, 'forced-pool member must be vision-tagged');
      },
      configWithForcedVision,
    );
  });
});
```

- [ ] **Step 4: Run tests to verify RED**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/model-options.test.ts`
Expected: new suite FAIL (`vision` is `undefined`, not `true`/`false`); existing 3 tests still PASS.

- [ ] **Step 5: Implement the `vision` tag**

In `server.ts` import block (`:7-15`), add `isVisionCapable` (alphabetical neighbors: after `asModelList`):

```ts
import {
  CallLogger,
  ProviderIdSchema,
  ProviderRegistry,
  asModelList,
  isVisionCapable,
  loadConfig,
  updateConfig,
  type GatewayKeyEntry,
} from '@freemodelfinder/core';
```

Inside `GET /api/auto-route/model-options`, right after `const cfg = reg.getConfig();` (`:1008`), add:

```ts
const forcedVision = asModelList(cfg.autoRoute?.visionModel);
```

Extend the entry types (`push` parameter type at `:1023-1028` and the `byId` Map value type at `:1019-1022`) with `vision?: boolean`:

```ts
const byId = new Map<
  string,
  { id: string; provider: string; displayName?: string; capabilities?: string[]; vision?: boolean }
>();
const push = (entry: {
  id: string;
  provider: string;
  displayName?: string;
  capabilities?: string[];
  vision?: boolean;
}) => {
  if (!entry.id) return;
  if (!byId.has(entry.id)) byId.set(entry.id, entry);
};
```

Local catalog loop (`:1033-1040`) becomes:

```ts
for (const m of local) {
  const composedId = `${m.provider}:${m.id}`;
  push({
    id: composedId,
    provider: m.provider,
    displayName: m.displayName,
    capabilities: m.capabilities,
    vision: isVisionCapable({ ...m, id: composedId }, forcedVision),
  });
}
```

Custom source loop — replace the `push({...})` call inside (`:1048-1052`) with:

```ts
push({
  id: composed,
  provider: 'custom',
  displayName: m.displayName?.trim() || bare,
  vision: isVisionCapable(
    { id: composed, provider: 'custom', displayName: composed, free: true },
    forcedVision,
  ),
});
```

(`isVisionCapable` only reads `id`/`inputModalities` at runtime; the extra required `ModelInfo` fields satisfy the type. `ProviderId` includes `'custom'`.)

- [ ] **Step 6: Run tests to verify GREEN**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/model-options.test.ts`
Expected: all tests PASS (5 in file: 3 existing + 2 new).

- [ ] **Step 7: Format, lint, commit**

```bash
npx prettier --write packages/server/src/server.ts packages/server/src/__tests__/model-options.test.ts
npx eslint packages/server/src/server.ts packages/server/src/__tests__/model-options.test.ts --max-warnings=0
git add packages/server/src/server.ts packages/server/src/__tests__/model-options.test.ts
git commit -m "feat(server): tag vision capability on model-options"
```

---

### Task 2: UI — `matchesCapability` vision branch

**Files:**
- Modify: `packages/ui/app/components/ModelMultiSelect.tsx` (`:10-46`)
- Test: `packages/ui/app/components/__tests__/settings.test.tsx` (`describe('matchesCapability')` `:331-410`)

- [ ] **Step 1: Write the failing tests**

Inside the existing `describe('matchesCapability')` block (before its closing `});` at `:410`), append:

```ts
it('vision filter trusts the backend vision tag', () => {
  expect(
    matchesCapability({ id: 'custom:x:sora-image', provider: 'custom', vision: true }, 'vision'),
  ).toBe(true);
  expect(
    matchesCapability({ id: 'custom:x:plain-chat', provider: 'custom', vision: false }, 'vision'),
  ).toBe(false);
});

it('vision filter falls back to id regex when untagged', () => {
  expect(matchesCapability({ id: 'custom:x:llava-7b', provider: 'custom' }, 'vision')).toBe(true);
  expect(matchesCapability({ id: 'custom:x:plain-chat', provider: 'custom' }, 'vision')).toBe(
    false,
  );
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/components/__tests__/settings.test.tsx`
Expected: the two new vision tests FAIL (and/or TS-visible prop errors are ignored by esbuild; runtime behavior is wrong because `'vision'` currently falls through to the text branch). Other tests unchanged.

- [ ] **Step 3: Implement the vision branch**

In `ModelMultiSelect.tsx`:

Add `vision?: boolean` to `ModelOption` (`:10-15`):

```ts
export interface ModelOption {
  id: string;
  provider: string;
  displayName?: string;
  capabilities?: string[];
  vision?: boolean;
}
```

Widen `filterCapability` on the props interface (`:22`) and `matchesCapability` signature (`:29-32`):

```ts
filterCapability?: 'image' | 'video' | 'text' | 'vision';
```

```ts
const VISION_FALLBACK_RE =
  /vision|4v|vl|qwen2?\.?vl|glm-4v|llava|moondream|pixtral|mistral-small-vision|internvl|falcon-vision/i;

export function matchesCapability(
  option: ModelOption,
  filter?: 'image' | 'video' | 'text' | 'vision',
): boolean {
  if (!filter) return true;
  if (filter === 'vision') {
    if (typeof option.vision === 'boolean') return option.vision;
    return VISION_FALLBACK_RE.test(`${option.id} ${option.displayName ?? ''}`);
  }
  const caps = option.capabilities;
  // ...existing image/video/text branches unchanged
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/components/__tests__/settings.test.tsx`
Expected: PASS (previously passing tests must stay green — the early-return only triggers for `filter === 'vision'`).

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write packages/ui/app/components/ModelMultiSelect.tsx packages/ui/app/components/__tests__/settings.test.tsx
npx eslint packages/ui/app/components/ModelMultiSelect.tsx packages/ui/app/components/__tests__/settings.test.tsx --max-warnings=0
git add packages/ui/app/components/ModelMultiSelect.tsx packages/ui/app/components/__tests__/settings.test.tsx
git commit -m "feat(ui): vision filter branch in matchesCapability"
```

---

### Task 3: UI — selector, types, i18n, fixtures

**Files:**
- Modify: `packages/ui/app/components/SettingsView.tsx` (`AutoRouteInfo` `:175-191`, modality card `:1298-1332`)
- Modify: `packages/ui/app/i18n.tsx` (zh `:244-250`, en `:712-718`)
- Modify: `packages/ui/test/server.ts` (auto-route GET `:70-81`, model-options `:82-106`)
- Test: `packages/ui/app/components/__tests__/settings.test.tsx`

- [ ] **Step 1: Extend MSW fixtures (setup, not assertions)**

In `test/server.ts` GET `/api/auto-route` handler, add `visionModel: []` after `videoModel`:

```ts
http.get(`${gateway}/api/auto-route`, () =>
  HttpResponse.json({
    enabled: false,
    strategy: 'capability',
    fallbackChain: [],
    imageModel: ['custom:img'],
    videoModel: [],
    visionModel: [],
    textTiers: { simple: [], medium: [], complex: [] },
    cooldowns: [],
    recentNotices: [],
  }),
),
```

In the GET `/api/auto-route/model-options` handler models array, append:

```ts
{
  id: 'custom:fixture:mm-chat',
  provider: 'custom',
  displayName: 'MM Chat',
  vision: true,
},
```

(Impact check already reasoned: image filter ignores `vision` and regex-`image` rejects `mm-chat`; text filter keeps it but no existing test asserts its absence.)

- [ ] **Step 2: Write the failing tests**

In `settings.test.tsx`, inside the settings describe (before its closing `});` at `:329`), append:

```tsx
it('renders the vision model multi-select in the modality card', async () => {
  render(<SettingsView />);
  expect(await screen.findByRole('button', { name: '视觉理解模型' })).toBeTruthy();
});

it('selecting a vision option POSTs visionModel to /api/auto-route', async () => {
  const writes: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
    http.post(`${gateway}/api/auto-route`, async ({ request }) => {
      writes.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true });
    }),
  );
  const user = userEvent.setup();
  render(<SettingsView />);
  const trigger = await screen.findByRole('button', { name: '视觉理解模型' });
  await user.click(trigger);
  const option = await screen.findByRole('option', { name: /custom:fixture:mm-chat/ });
  await user.click(within(option).getByRole('button'));
  await waitFor(() => expect(writes.length).toBeGreaterThan(0));
  expect(writes.at(-1)!.visionModel).toContain('custom:fixture:mm-chat');
});
```

- [ ] **Step 3: Run tests to verify RED**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/components/__tests__/settings.test.tsx`
Expected: both new tests FAIL (`视觉理解模型` button not found).

- [ ] **Step 4: Add i18n keys (zh)**

In `i18n.tsx` after `settings.autoRoute.modality.videoModelPh` (`:250`):

```ts
'settings.autoRoute.modality.visionModel': '视觉理解模型',
'settings.autoRoute.modality.visionModelPh': '例如 custom:cpa:DeepSeek-V4-Flash-Vision-Exp',
```

Replace the zh `settings.autoRoute.modality.desc` value (`:245-246`) with:

```ts
'settings.autoRoute.modality.desc':
  '当 model 为 auto 时，根据请求内容自动选择合适的模型。检测到图片（含「生成xx图片」等文本意图）走图片模型；检测到视频关键词走视频模型；其余走默认文本模型。未配置图片模型时会自动发现可用生图模型。上传图片（多模态理解）走视觉模型，未配置时自动发现可看图模型。',
```

- [ ] **Step 5: Add i18n keys (en)**

In `i18n.tsx` after `settings.autoRoute.modality.videoModelPh` (`:718`):

```ts
'settings.autoRoute.modality.visionModel': 'Vision (image input) model',
'settings.autoRoute.modality.visionModelPh': 'e.g. custom:cpa:qwen2-vl',
```

Replace the en `settings.autoRoute.modality.desc` value (`:713-714`) with:

```ts
'settings.autoRoute.modality.desc':
  'When model is auto, selects a suitable model from the request. Detected images (including text intent like "generate a cat image") use the image model; video keywords use the video model; otherwise the default text model. If no image model is configured, an available image-generation model is discovered automatically. Uploaded images (multimodal understanding) use the vision model; if none is configured, a vision-capable model is discovered automatically.',
```

- [ ] **Step 6: Add `visionModel` to `AutoRouteInfo`**

In `SettingsView.tsx`, after `videoModel?: string[];` (`:180`):

```ts
visionModel?: string[];
```

- [ ] **Step 7: Add the third selector and widen the grid**

Change the pool grid opening tag (`:1308`) from `grid gap-3 sm:grid-cols-2` to:

```tsx
<div className="grid gap-3 sm:grid-cols-3">
```

After the `videoModel` `ModelMultiSelect` (after `:1330`'s closing `/>`), insert:

```tsx
<ModelMultiSelect
  label={t('settings.autoRoute.modality.visionModel')}
  placeholder={t('settings.autoRoute.modality.visionModelPh')}
  value={autoRoute?.visionModel ?? []}
  onChange={(next) => {
    setAutoRoute((prev) => (prev ? { ...prev, visionModel: next } : prev));
    void saveAutoRoute({ visionModel: next });
  }}
  filterCapability="vision"
  options={modelOptions}
/>
```

- [ ] **Step 8: Run tests to verify GREEN**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/components/__tests__/settings.test.tsx`
Expected: all tests in file PASS (including pre-existing image/text-tier filter tests).

- [ ] **Step 9: Format, lint, commit**

```bash
npx prettier --write packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx packages/ui/test/server.ts packages/ui/app/components/__tests__/settings.test.tsx
npx eslint packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx packages/ui/test/server.ts packages/ui/app/components/__tests__/settings.test.tsx --max-warnings=0
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx packages/ui/test/server.ts packages/ui/app/components/__tests__/settings.test.tsx
git commit -m "feat(ui): vision model selector in modality routing settings"
```

(Note: eslint scope for this repo is `packages/**/*.{ts,tsx}` — `test/server.ts` is included.)

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full server + ui test suites**

```bash
pnpm --filter @freemodelfinder/server test
pnpm --filter @freemodelfinder/ui test
```

Expected: server 106+ tests PASS (2 new); ui PASS (`settings.test.tsx` flake → re-run singly; other pre-existing failures out of scope must not increase).

- [ ] **Step 2: Lint everything changed**

```bash
npx eslint packages/server/src/server.ts packages/server/src/__tests__/model-options.test.ts packages/ui/app/components/ModelMultiSelect.tsx packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx packages/ui/test/server.ts packages/ui/app/components/__tests__/settings.test.tsx --max-warnings=0
```

Expected: no output, exit 0.

- [ ] **Step 3: Sequential build + typecheck (never parallel)**

```powershell
pnpm build:runtime; if ($?) { pnpm typecheck }
```

Expected: core/server build OK; all 4 packages `typecheck: Done`.

- [ ] **Step 4: Report**

Remind the user in Chinese: gateway on `:11435` must be restarted to pick up the server change; local commits only — push only on explicit request.

---

## Self-Review (completed at write time)

1. **Spec coverage:** §1 vision field → Task 1; §2 types → Tasks 2-3; §3 selector/grid → Task 3; §4 matchesCapability → Task 2; §5 i18n → Task 3; §6 tests → Tasks 1-3; error handling = existing `saveAutoRoute` path (no task needed); §Verification → Task 4. No gaps.
2. **Placeholders:** none — every code step carries complete diffs/snippets; no "similar to Task N".
3. **Type consistency:** `vision?: boolean` on server push entries, `ModelOption.vision`, `AutoRouteInfo.visionModel`, `filterCapability: 'vision'`, i18n keys `settings.autoRoute.modality.visionModel[Ph]` used identically in Tasks 1-3; fixture id `custom:fixture:mm-chat` consistent between Step 1 and Step 2 of Task 3.
