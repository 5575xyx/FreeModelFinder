# Design: Vision Model Selector in Modality Routing Settings

**Date:** 2026-09-24  
**Status:** 待用户审阅  
**Approach:** A — backend tags `vision` on shared `model-options`; UI adds a third pool selector

## Problem

The gateway already supports a configurable vision pool (`autoRoute.visionModel`: GET/POST merge in `server.ts`, consumed by the auto vision branch in `openai.ts`), but the Settings → 模态路由（Auto 模式）card only exposes **图片生成模型** and **视频生成模型** selectors. Users have no UI place to configure which models may receive uploaded images; they silently depend on catalog discovery, which currently finds only one visionish model.

Root cause: `SettingsView.AutoRouteInfo` omits `visionModel`, and `ModelMultiSelect.filterCapability` only knows `image | video | text` (output capabilities — they do not answer “can this model **see** images”).

## Goals

- Expose `autoRoute.visionModel` as a multi-select in the 模态路由 card, round-robin hint included.
- Dropdown candidates restricted to models likely vision-capable, tagged by the backend with the same `isVisionCapable` logic used at request time.
- Save through the existing `POST /api/auto-route` merge path — no new endpoint.

## Non-Goals

- Changing vision routing, discovery, or `no_vision_model` error behavior (already shipped).
- Vision badges on the Models page or elsewhere.
- Video understanding.
- Editing `inputModalities` metadata from the UI.

## Decisions (user-confirmed)

| Topic              | Decision                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Candidate filtering| Backend tags each `model-options` entry with `vision: boolean` via core `isVisionCapable` (option A)          |
| Endpoint           | Extend shared `GET /api/auto-route/model-options`; no dedicated endpoint                                      |
| Placement          | Third `ModelMultiSelect` inside the existing 模态路由 card                                                      |
| Save path          | Existing `saveAutoRoute({ visionModel })` → `POST /api/auto-route` merge (already implemented server-side)     |

## 1. Backend: `vision` field on `model-options`

In `packages/server/src/server.ts` `GET /api/auto-route/model-options`:

- Read `forced = asModelList(cfg.autoRoute?.visionModel)` from the config already loaded in the handler.
- For each **local catalog** entry (full `ModelInfo` available): compute `vision = isVisionCapable({ ...m, id: composedId }, forced)` where `composedId` is the same `${m.provider}:${m.id}` string already used as the option `id`. Spreading keeps `inputModalities`; overriding `id` with the composed id makes both the heuristic (`VISION_ID_RE`) and the forced-pool membership check match the ids the UI stores.
- For each **custom source hand-added** model (id only, no metadata): `vision = isVisionCapable({ id: composed }, forced)` — heuristic + forced pool only.
- Attach optional `vision?: boolean` to the pushed entry type. Purely additive; existing consumers ignore it.

`isVisionCapable` order is unchanged: forced ids → `inputModalities` includes/excludes image → `VISION_ID_RE` on id. A forced-pool member is therefore always offered back in the dropdown even when the heuristic would miss it.

## 2. UI types

- `SettingsView.AutoRouteInfo`: add `visionModel?: string[]`.
- `ModelOption` (`ModelMultiSelect.tsx`): add `vision?: boolean`.

## 3. Selector UI

In the 模态路由 card (`SettingsView.tsx` ~line 1308):

- Change the pool grid from `grid gap-3 sm:grid-cols-2` to `grid gap-3 sm:grid-cols-3` (same density as the text-tiers row below).
- Add a third `ModelMultiSelect`:

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

- Empty pool = catalog auto-discovery (existing backend behavior). Selected chips render even when absent from the filtered dropdown (existing component behavior); the forced-pool tagging in §1 keeps them re-selectable in the common case.

## 4. `matchesCapability` vision branch

Extend `filterCapability` prop union with `'vision'` and handle it in `matchesCapability`:

1. If `option.vision` is a boolean → return it (backend tag wins, including explicit `false`).
2. Else (untagged: stale fixture, partial data) → fall back to `/vision|4v|vl|qwen2?\.?vl|glm-4v|llava|moondream|pixtral|mistral-small-vision|internvl|falcon-vision/i` against `` `${id} ${displayName}` `` — same pattern as core `VISION_ID_RE`, inlined because the UI package does not depend on `@freemodelfinder/core`.

Offline / fetch failure: `modelOptions` stays `[]`, dropdown shows the existing empty hint, already-saved chips still display — unchanged from image/video selectors.

## 5. i18n (`packages/ui/app/i18n.tsx`)

Add zh + en keys:

| Key                                    | zh                                | en                                       |
| -------------------------------------- | --------------------------------- | ---------------------------------------- |
| `...modality.visionModel`              | 视觉理解模型                       | Vision (image input) model               |
| `...modality.visionModelPh`            | 例如 custom:cpa:DeepSeek-V4-Flash-Vision-Exp | e.g. custom:cpa:qwen2-vl         |

Update `...modality.desc` — append one sentence (zh/en) to the existing text:

- zh 追加：`上传图片（多模态理解）走视觉模型，未配置时自动发现可看图模型。`
- en 追加: `Uploaded images (multimodal understanding) use the vision model; if none is configured, a vision-capable model is discovered automatically.`

## 6. Tests

**Server** — `packages/server/src/__tests__/model-options.test.ts`:

- Option whose id matches the heuristic → `vision: true`.
- Plain text id → `vision: false`.
- Plain id listed in configured `autoRoute.visionModel` → `vision: true` (forced pool).
- Custom source hand-added model with vision-like id → `vision: true`.

**UI** — `packages/ui/app/components/__tests__/settings.test.tsx`:

- Third control renders with accessible name `视觉理解模型`.
- Selecting an option POSTs `/api/auto-route` with `visionModel` in the body (mirror the existing `imageModel` assertion).

**UI unit** — extend the existing `describe('matchesCapability')` block in `settings.test.tsx`: tagged `vision: true` matches; tagged `vision: false` rejected; untagged id falls back to the vision regex (e.g. `custom:x:llava-7b` → true, `custom:x:plain-chat` → false).

## Error handling

- Save failures reuse the existing `autoRouteBusy` / pending-patch queue in `saveAutoRoute` — no new states.
- Invalid ids are not validated client-side today; unchanged.
- No vision model configured and none discoverable → existing `400 no_vision_model` at request time; the UI hint text points users at this selector.

## Verification

```bash
pnpm --filter @freemodelfinder/server test     # model-options + existing auto-route API
pnpm --filter @freemodelfinder/ui test         # settings.test.tsx (run singly if flaky)
pnpm lint && pnpm typecheck                    # after pnpm build:runtime
```
