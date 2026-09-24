# Design: Auto Vision Intent & Multimodal Image Input

**Date:** 2026-09-24  
**Status:** Approved (design)  
**Approach:** A — incremental extension of existing auto-route and protocol layers

## Problem

When `model` is `auto`/`default`, `detectRequestModality` treats any OpenAI content part with `type: image_url` or `image` as **text-to-image generation**. The gateway then:

1. Routes to the `imageModel` pool and calls `generateImage` (prompt text only).
2. Strips non-text parts in `openAIToChatRequest` → `normalizeContent` (`packages/core/src/protocols/openai.ts`), so even a correct vision model would never see the image.
3. Has no input-modality field on `ModelInfo` (`capabilities` means **output** generate text/image/video only).

Users who upload a photo and ask “这是什么” get a wrong image-generation call and a dropped image.

## Goals

- Split **generation** vs **understanding** intent when media is present.
- Pass uploaded images through to upstream vision-capable chat models.
- Configurable vision pool + automatic catalog discovery; clear error when none available.
- Do **not** change pure text-to-image / text-to-video behavior.

## Non-Goals (this iteration)

- Video **understanding** (video parts / `video_url`); video remains generation via keywords.
- Image-to-image / reference-image generation (img2img).
- Downloading, hosting, or re-encoding remote images on the gateway (except base64 decode for protocol encoding limits).
- Silent fallback that drops images.

## Decisions (user-confirmed)

| Topic               | Decision                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Intent split        | Two classes: no uploaded media → generation keywords; uploaded **image** → vision understanding only |
| Vision pool         | `autoRoute.visionModel` configurable pool + automatic catalog fallback                               |
| Video understanding | Out of scope this iteration                                                                          |
| Capability source   | Model metadata + id heuristics + config pool force-enable                                            |
| Media transport     | Extend `ChatMessage` with optional `contentParts`                                                    |
| No vision model     | Explicit error (no silent degrade)                                                                   |

## 1. Intent detection and routing

### `detectRequestModality`

Return type becomes:

```ts
type RequestModality = 'text' | 'image' | 'video' | 'vision';
```

Rules (scan from latest user message backward; stop at first non-empty decision):

1. Latest user `content` is an array containing `type === 'image_url'` or `type === 'image'` → **`vision`**.
   - Phase 1: any image part forces vision (generation keywords ignored when image parts exist).
   - No video part handling yet.
2. Else existing rules: video keyword regex → `video`; image generation keyword regex → `image`; else `text`.
3. Image parts in **history** (not the latest user message) do **not** trigger vision.

Export remains testable from `packages/server/src/routes/openai.ts`.

### Auto branch (`model === 'auto' | 'default'`)

| Detected | Behavior                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| `vision` | Select vision model → **normal chat path** with `contentParts` (must not enter image/video generation fast-path) |
| `image`  | Existing: `imageModel` pool / discovery → `forcedImageModality` → `generateImage`                                |
| `video`  | Existing: `videoModel` pool → `generateVideo`                                                                    |
| `text`   | Existing: `textTiers` / auto-router                                                                              |

### Explicit model (non-auto)

- Image parts still travel on the chat request when present.
- Do not rewrite intent to generation.
- If the selected provider cannot encode images, return an explicit error (no strip-and-send).

### Prompt extraction

- `extractGenerationPrompt` stays for image/video **generation** only.
- Vision uses full messages including `contentParts`.

## 2. Data model and config

### `ModelInfo` (`packages/core/src/types.ts`)

```ts
inputModalities?: ('text' | 'image')[];
```

- Meaning: **input** modalities for chat. Missing → treat as text-only.
- `capabilities` unchanged (output generation semantics).

**Population priority:**

1. Provider metadata: OpenRouter `architecture.input_modalities` / `input_modalities`, map only `text` and `image`.
2. Heuristics on model id (append `image` if match), e.g.  
   `/vision|4v|vl|qwen2?\.?vl|glm-4v|llava|moondream|pixtral|mistral-small-vision|internvl|falcon-vision/i`
3. Ids listed in `autoRoute.visionModel` are **forced** to include `image` when resolving eligibility.

### `AutoRouteSettings`

```ts
visionModel?: string | string[];
```

- Normalized with `asModelList` like `imageModel` / `videoModel`.
- Exposed on settings GET/PATCH APIs alongside other pools.
- Unset → automatic discovery only.

### `ChatMessage` (zod)

```ts
content: z.string(); // retained; may be concatenation of text parts
contentParts?: Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>;
```

- Pure string messages: field omitted; all existing callers, logs, rate-limit classifiers unchanged.
- `openAIToChatRequest`: if image parts exist, set both `content` (joined text) and `contentParts`; otherwise identical to current behavior.

## 3. Protocol passthrough

When `contentParts` includes `image_url`, encode images on the upstream request. When absent, **no behavioral change**.

| Protocol / provider                                          | Image behavior                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible (openai-compatible, custom, openrouter, …) | Send content as part array with `text` + `image_url`; do not run text-only `normalizeContent` on that path                       |
| Anthropic                                                    | Content blocks: text + `{ type: 'image', source: { type: 'url' \| 'base64', media_type, data } }`; decode `data:` URLs to base64 |
| Gemini                                                       | `parts` with `inlineData` (base64) or `fileData` for http(s) URLs when appropriate                                               |
| Providers without vision API                                 | Throw `Provider X does not support image input`; router skips or surfaces error (never silent strip)                             |

### Logging and safety

- `call-logger`: keep text summary from `content`; record truncated image URL metadata, not full base64 blobs.
- Gateway does not download/forward-host remote URLs; only passes them through.
- `data:` base64 decoded only at protocol encode time; enforce max size (10MB per image) to avoid OOM.

## 4. Vision model selection and errors

### Selection order (auto + vision)

1. If `autoRoute.visionModel` non-empty → `nextFromPool('vision', pool)` (cursor slot `'vision'`, isolated from `'image'`/`'video'`/`'text:*'`).
2. Else scan `listAllModels()` for `inputModalities?.includes('image')` (config pool ids treated as eligible) → existing scored/round-robin pick.
3. Else **error** (no degrade).

### Error when none available

HTTP **400**:

```json
{
  "error": {
    "message": "No vision-capable model available. Configure autoRoute.visionModel or enable a model with image input.",
    "type": "no_vision_model",
    "code": 400
  }
}
```

- Client-fixable configuration issue, not upstream failure.
- If upstream later rejects image input: pass upstream error through with type `vision_input_error`; do **not** fall back to image generation.

### Isolation from generation fast-path

- `forcedImageModality` only when `detectedModality === 'image'`.
- Vision branch runs ordinary `chat()` with parts **before** generation fast-path.
- Tests: vision → `generateImage` call count `0`; request body still contains image parts.

## 5. Testing and acceptance

### Unit / pure functions

| Case                                 | Expectation                                  |
| ------------------------------------ | -------------------------------------------- |
| Latest user has `image_url`          | `'vision'`                                   |
| Image part + text “生成图片”         | still `'vision'`                             |
| History has image, latest plain text | `'text'`                                     |
| No image + generation keywords       | `'image'` / `'video'` (existing green)       |
| Heuristic / OpenRouter mapping       | vision-capable ids marked                    |
| `openAIToChatRequest` with image     | `contentParts` kept; `content` = joined text |
| Pure text openai convert             | identical to today                           |

### HTTP / auto route (extend `auto-modality.test.ts` style)

1. `auto` + image part → hits `visionModel[0]`; `generateImage` count `0`; body has image.
2. No configured pool, catalog has vision model → auto-select.
3. No vision model anywhere → **400** `no_vision_model`; no `generate*` calls.
4. `visionModel` cursor independent of image/video.
5. Explicit model + image part → chat path; parts reach upstream mock.

### Protocol encoding

- OpenAI-compatible: upstream sees content array with `image_url`.
- Anthropic: image block shape (url / base64).
- Gemini: `inlineData` / `fileData`.
- Non-vision provider + image → explicit error.

### Regression

- Generation fast-paths, `extractGenerationPrompt`, existing core/server suites green.
- Pure-text protocol normalize unchanged.

### Manual acceptance

1. Upload image + “这是什么” → vision answers; logs show image; no image-gen call.
2. “画一只猫” → still text-to-image.
3. “生成一段视频” → still text-to-video.
4. Disable all vision capability → clear error; image not silently dropped.

## Out-of-scope follow-ups

- Video understanding parts and `inputModalities: 'video'`.
- img2img / reference image generation.
- Optional UI badge for vision models (nice-to-have; not required for gateway correctness).
