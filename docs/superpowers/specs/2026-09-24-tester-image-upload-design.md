# Design: Image Upload in Tester (Quick Test) Page

**Date:** 2026-09-24  
**Status:** 待用户审阅  
**Approach:** A — `Msg.uploadImages` display state + wire-time OpenAI content-array mapping in `send()`

## Problem

The 对话测试 page only accepts text (`page.tsx` `send()` posts `{role, content: string}` messages). The gateway already understands OpenAI content arrays (`extractContentParts` → `contentParts` → auto vision routing, shipped earlier), but the UI offers no way to attach an image — so users cannot visually verify vision models or the new `autoRoute.visionModel` pool from the dashboard.

## Goals

- Attach multiple images via **file picker** and **clipboard paste**.
- Allow **image-only sends** (empty text).
- Send standard OpenAI wire format so the existing gateway vision path works unchanged.
- Show attached/sent images as thumbnails in the conversation; multi-turn history keeps images.

## Non-Goals

- Drag-and-drop upload.
- Client-side image compression / downscaling.
- Video attachments.
- Any server or core changes.
- Persisting attachments beyond the in-memory conversation (clear button already resets messages).

## Decisions (user-confirmed)

| Topic          | Decision                                                    |
| -------------- | ----------------------------------------------------------- |
| Count          | Multiple images per message                                 |
| Empty text     | Allowed when ≥1 image attached                              |
| Oversize       | Reject client-side when a single image > 10MB (matches server `MAX_IMAGE_DATA_BYTES`) |
| Architecture   | Approach A: separate display state (`uploadImages`) + wire mapping in `send()` |

## 1. State and types (`packages/ui/app/page.tsx`, `TesterView.tsx`)

- `Msg` gains `uploadImages?: string[]` (data URLs, user messages only). Existing `imageUrls` stays assistant-generation-only.
- New page state: `const [inputImages, setInputImages] = useState<string[]>([])` (draft attachments, data URLs), sibling of `input`.
- Drafts are cleared on successful enqueue in `send()` and by `onClear` (clear already replaces `messages`; also reset `inputImages`).

## 2. Wire mapping

In `send()`, after building `next: Msg[]`:

```ts
type WirePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

function toWireContent(text: string, images: string[] = []): string | WirePart[] {
  if (images.length === 0) return text;
  const parts: WirePart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

const wireMessages = next.map((m) => ({
  role: m.role,
  content: toWireContent(m.content, m.uploadImages),
}));
```

- POST body: `{ model, messages: wireMessages, stream: true }`.
- Image-only message → content is image parts only (no empty text part). Server `normalizeContent` joins `''`; `extractContentParts` returns parts because `sawImage` — verified against `packages/core/src/protocols/openai.ts:32-51`.
- History: every prior user message with `uploadImages` is re-mapped automatically because `next` derives from `messages`.
- Messages without images keep `content: string` byte-identical to today (regression-safe).

Guard change:

```ts
// before: if (!input.trim() || streaming || !model) return;
if ((!input.trim() && inputImages.length === 0) || streaming || !model) return;
```

User message enqueue:

```ts
const next: Msg[] = [
  ...messages,
  {
    role: 'user',
    content: input.trim(),
    ...(inputImages.length > 0 ? { uploadImages: inputImages } : {}),
  },
];
setInputImages([]);
```

## 3. Attachment UI (`TesterView`)

- New props: `inputImages: string[]`, `onImagesChange: (next: string[]) => void` (page owns state; TesterView stays mostly presentational, matching existing `input`/`setInput` pattern).
- **Picker button**: 📎 (`lucide` `Paperclip`) placed left of the textarea inside the input shell; opens a hidden `<input type="file" accept="image/*" multiple>` via ref. Disabled while `streaming || models.length === 0`.
- **Paste**: textarea `onPaste` handler — for each `clipboardData.items` entry with `type.startsWith('image/')` and `kind === 'file'`, `preventDefault()` and enqueue; non-image clipboard content falls through to default paste.
- **Read pipeline** (shared helper `fileToDataURL(file: File): Promise<string>` via `FileReader`):
  - Reject `!file.type.startsWith('image/')` silently (skip).
  - After read: if `dataUrl.length` heuristic exceeds raw 10MB → use encoded-length check consistent with spec §4; reject with i18n error, do not append.
- **Draft strip**: above the textarea (inside the input shell, wrapping row), thumbnail per draft: `<img src={dataUrl}>` with an × button (`aria-label` per image index) calling `onImagesChange(drafts.filter(...))`.
- **Send button enablement**: `disabled={!streaming && (!model || (!input.trim() && inputImages.length === 0))}` (mirror guard).
- **Rendered history**: `MessageRow` renders `message.uploadImages` in the same thumbnail block used for `imageUrls` (reuse styles; user messages already right-align). Implementation detail: either merge arrays for render or map `uploadImages` through the existing `hasImages` block — pick the smaller diff: render a second block keyed on `uploadImages` with identical markup.

## 4. Size / type validation

- Max bytes: `MAX_IMAGE_DATA_BYTES = 10 * 1024 * 1024`. Copy server algorithm exactly (`packages/core/src/vision.ts:26-35`): split data URL on first `,` → `meta`/`payload`; `isBase64 = meta.endsWith(';base64')`; `approxBytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length`; reject if `approxBytes > MAX` (server error text contains `10MB`). UI keeps a local copy of the constant + function with a comment pointing at core (UI does not depend on core).
- Exceeding → show inline error (see §6), keep other accepted drafts, do not clear input.
- Only `image/*` accepted; HEIC etc. accepted if browser can decode to data URL — failure to read → same inline error path.

## 5. Error handling

- Oversize / read failure: inline error under the draft strip (auto-clear on next successful attach or after 4s timer — pick: clear on next attach action, simpler; no timer).
- Gateway rejects vision (explicit non-vision model): existing `send()` catch → `[error]` message bubble; no new path.
- `model === 'auto'` with images: server vision detect already routes (no UI change).

## 6. i18n (`packages/ui/app/i18n.tsx`, zh + en)

| Key | zh | en |
| --- | -- | -- |
| `tester.attach.aria` | 附加图片 | Attach images |
| `tester.attach.tooLarge` | 图片超过 10MB，未添加 | Image exceeds 10MB and was not added |
| `tester.attach.readError` | 图片读取失败 | Failed to read image |
| `tester.attach.removeAria` | 移除图片 {index} | Remove image {index} |

Optional placeholder suffix unchanged (keep existing `tester.input.placeholder`).

## 7. Tests (`packages/ui/app/__tests__/home.test.tsx`)

1. **Attach + send wire format**: mock `/v1/chat/completions` capturing body; attach a tiny fixture PNG (1×1 data URL) via the file input (`user.upload`); type text; send; assert `messages[0].content` is an array containing `{type:'text'}` and `{type:'image_url', image_url:{url: startsWith('data:image')}}`.
2. **Image-only send**: no text, one image → send button enabled; body content is image parts only (no text part); request issued.
3. **Oversize rejected**: stub a >10MB data URL through the same entry point used by paste/picker (export the validation helper for unit test if DOM injection is awkward) → not in request body; error text visible.
4. **Remove draft**: add two images, click first × → only second remains (assert thumbnail count).
5. **Regression**: existing text-only tests unchanged — body `content` remains a plain string.

Server/core tests: none (no changes).

## Verification

```bash
pnpm --filter @freemodelfinder/ui exec vitest run app/__tests__/home.test.tsx
pnpm --filter @freemodelfinder/ui test
npx eslint packages/ui/app/page.tsx packages/ui/app/components/TesterView.tsx packages/ui/app/i18n.tsx packages/ui/app/__tests__/home.test.tsx --max-warnings=0
pnpm typecheck   # after pnpm build:runtime if core/server dist is stale
```
