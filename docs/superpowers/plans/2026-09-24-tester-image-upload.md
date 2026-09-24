# Tester Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach multiple images (file picker + clipboard paste) on the 对话测试 page and send them through the existing gateway vision path as standard OpenAI content arrays.

**Architecture:** Display state and wire format stay separate — draft attachments live in `page.tsx` as `inputImages: string[]` (data URLs), sent messages carry `Msg.uploadImages?: string[]`, and `send()` maps them via `toWireContent()` into OpenAI `content` arrays only at serialization time. Two tiny pure helpers live in `app/lib/` (`image.ts` for size validation + file reading, `chat.ts` for wire mapping); UI changes are confined to `TesterView.tsx`; zero server/core changes.

**Tech Stack:** React 19 + Next.js 16 UI, vitest + Testing Library + MSW (ui package), lucide-react icons, i18n via `app/i18n.tsx`.

**Spec:** `docs/superpowers/specs/2026-09-24-tester-image-upload-design.md`

---

## File Structure

| File                                                  | Role                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create: `packages/ui/app/lib/image.ts`                | `MAX_IMAGE_DATA_BYTES`, `isImageDataUrlWithinLimit`, `fileToDataURL`                                                                                                    |
| Create: `packages/ui/app/lib/chat.ts`                 | `WirePart`, `toWireContent`                                                                                                                                             |
| Create: `packages/ui/app/lib/__tests__/image.test.ts` | Unit tests for image helpers                                                                                                                                            |
| Create: `packages/ui/app/lib/__tests__/chat.test.ts`  | Unit tests for wire mapping                                                                                                                                             |
| Modify: `packages/ui/app/i18n.tsx`                    | 4 new `tester.attach.*` keys × zh/en                                                                                                                                    |
| Modify: `packages/ui/app/components/TesterView.tsx`   | `Msg.uploadImages`, new props, attach button, hidden file input, paste handler, draft strip, attach error, send-button disable condition, `MessageRow` upload rendering |
| Modify: `packages/ui/app/page.tsx`                    | `inputImages` state, `send()` guard + `toWireContent` mapping, enqueue into user `Msg`, `onClear` reset, pass new props                                                 |
| Modify: `packages/ui/app/__tests__/home.test.tsx`     | 6 integration tests (wire format, image-only, oversize, remove draft, text regression, history render)                                                                  |

**Environment notes (Windows PowerShell):**

- Chain commands with `; if ($?) { ... }`, never `&&`.
- UI tests: `pnpm --filter @freemodelfinder/ui exec vitest run <file>`
- Single-file eslint: `npx eslint <files> --max-warnings=0` (from repo root)
- Prettier before commit: `npx prettier --write <files>`
- Typecheck requires runtime build first if core/server dist stale: `pnpm build:runtime; if ($?) { pnpm typecheck }` — run build and typecheck **sequentially**, never in parallel.
- Do **not** push to GitHub.

---

### Task 1: Image helpers (`lib/image.ts`)

**Files:**

- Create: `packages/ui/app/lib/image.ts`
- Test: `packages/ui/app/lib/__tests__/image.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/app/lib/__tests__/image.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fileToDataURL, isImageDataUrlWithinLimit, MAX_IMAGE_DATA_BYTES } from '../image';

const SMALL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('isImageDataUrlWithinLimit', () => {
  it('accepts a small data URL', () => {
    expect(isImageDataUrlWithinLimit(SMALL_PNG)).toBe(true);
  });

  it('accepts non-data URLs', () => {
    expect(isImageDataUrlWithinLimit('https://example.com/a.png')).toBe(true);
  });

  it('accepts a data URL without base64 marker by payload length', () => {
    expect(isImageDataUrlWithinLimit('data:image/png,abc')).toBe(true);
  });

  it('rejects a base64 payload over the 10MB limit', () => {
    const big = `data:image/png;base64,${'A'.repeat(14 * 1024 * 1024)}`;
    expect(isImageDataUrlWithinLimit(big)).toBe(false);
    expect(MAX_IMAGE_DATA_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a payload exactly at the approximate limit', () => {
    // floor(len * 3 / 4) === MAX when len === ceil(MAX * 4 / 3) and divisible by 4.
    const payloadLen = Math.ceil((MAX_IMAGE_DATA_BYTES * 4) / 3);
    const adjusted = payloadLen % 4 === 0 ? payloadLen : payloadLen + (4 - (payloadLen % 4));
    expect(isImageDataUrlWithinLimit(`data:image/png;base64,${'A'.repeat(adjusted)}`)).toBe(true);
  });
});

describe('fileToDataURL', () => {
  it('reads a File into a data URL', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    const url = await fileToDataURL(file);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects when the input is not a readable File', async () => {
    await expect(fileToDataURL(undefined as unknown as File)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/lib/__tests__/image.test.ts`
Expected: FAIL — module `../image` not found.

- [ ] **Step 3: Write the implementation**

Create `packages/ui/app/lib/image.ts`:

```ts
// Mirrors packages/core/src/vision.ts assertImageDataUrlWithinLimit.
// The UI must not import @freemodelfinder/core, so this is a deliberate copy —
// keep in sync if the server-side limit ever changes.
export const MAX_IMAGE_DATA_BYTES = 10 * 1024 * 1024;

export function isImageDataUrlWithinLimit(url: string): boolean {
  if (!url.startsWith('data:')) return true;
  const comma = url.indexOf(',');
  if (comma < 0) return true;
  const meta = url.slice(5, comma);
  const isBase64 = meta.endsWith(';base64');
  const payload = url.slice(comma + 1);
  const approxBytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  return approxBytes <= MAX_IMAGE_DATA_BYTES;
}

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/lib/__tests__/image.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Format, lint, commit**

```powershell
npx prettier --write packages/ui/app/lib/image.ts packages/ui/app/lib/__tests__/image.test.ts
npx eslint packages/ui/app/lib/image.ts packages/ui/app/lib/__tests__/image.test.ts --max-warnings=0
git add packages/ui/app/lib/image.ts packages/ui/app/lib/__tests__/image.test.ts
git commit -m "feat(ui): image data URL limit check and file reader helper"
```

---

### Task 2: Wire mapping (`lib/chat.ts`)

**Files:**

- Create: `packages/ui/app/lib/chat.ts`
- Test: `packages/ui/app/lib/__tests__/chat.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/app/lib/__tests__/chat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toWireContent, type WirePart } from '../chat';

describe('toWireContent', () => {
  it('returns the plain string when there are no images', () => {
    expect(toWireContent('hello')).toBe('hello');
    expect(toWireContent('hello', [])).toBe('hello');
  });

  it('returns text then image parts when both are present', () => {
    const result = toWireContent('what is this', ['data:image/png;base64,AAAA']);
    expect(result).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('omits the text part when text is empty (image-only send)', () => {
    const result = toWireContent('', ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']);
    expect(result).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
    ]);
  });

  it('keeps image order stable', () => {
    const parts = toWireContent('t', ['u1', 'u2']) as WirePart[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/lib/__tests__/chat.test.ts`
Expected: FAIL — module `../chat` not found.

- [ ] **Step 3: Write the implementation**

Create `packages/ui/app/lib/chat.ts`:

```ts
export type WirePart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export function toWireContent(text: string, images: readonly string[] = []): string | WirePart[] {
  if (images.length === 0) return text;
  const parts: WirePart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/lib/__tests__/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```powershell
npx prettier --write packages/ui/app/lib/chat.ts packages/ui/app/lib/__tests__/chat.test.ts
npx eslint packages/ui/app/lib/chat.ts packages/ui/app/lib/__tests__/chat.test.ts --max-warnings=0
git add packages/ui/app/lib/chat.ts packages/ui/app/lib/__tests__/chat.test.ts
git commit -m "feat(ui): OpenAI content-array mapping for tester messages"
```

---

### Task 3: i18n keys

**Files:**

- Modify: `packages/ui/app/i18n.tsx` (zh block after line ~194 `'tester.msg.waiting'`, en block after line ~659 `'tester.msg.waiting'`)

- [ ] **Step 1: Add zh keys**

In the zh dictionary, after `'tester.msg.waiting': '等待模型响应',` insert:

```ts
  'tester.attach.aria': '附加图片',
  'tester.attach.tooLarge': '图片超过 10MB，未添加',
  'tester.attach.readError': '图片读取失败',
  'tester.attach.removeAria': '移除图片 {index}',
```

- [ ] **Step 2: Add en keys**

In the en dictionary, after `'tester.msg.waiting': 'Waiting for model response',` insert:

```ts
  'tester.attach.aria': 'Attach images',
  'tester.attach.tooLarge': 'Image exceeds 10MB and was not added',
  'tester.attach.readError': 'Failed to read image',
  'tester.attach.removeAria': 'Remove image {index}',
```

- [ ] **Step 3: Verify i18n compiles**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/lib/__tests__/chat.test.ts`
Expected: PASS (sanity — vitest loads the app graph; i18n type errors surface in typecheck later).

- [ ] **Step 4: Format, lint, commit**

```powershell
npx prettier --write packages/ui/app/i18n.tsx
npx eslint packages/ui/app/i18n.tsx --max-warnings=0
git add packages/ui/app/i18n.tsx
git commit -m "feat(ui): i18n keys for tester image attachments"
```

---

### Task 4: TesterView attach UI + page.tsx wiring (TDD integration)

**Files:**

- Modify: `packages/ui/app/components/TesterView.tsx`
- Modify: `packages/ui/app/page.tsx`
- Test: `packages/ui/app/__tests__/home.test.tsx`

- [ ] **Step 1: Write the failing integration tests**

Append a new `describe('tester image upload', ...)` block inside the existing top-level `describe('Home', ...)` in `packages/ui/app/__tests__/home.test.tsx` (so `renderInChinese`/`openTester` helpers are reused). Add helper + 5 tests:

```tsx
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngFile(name: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

function captureChatBody() {
  let body: {
    messages?: Array<{ role: string; content: unknown }>;
  } | null = null;
  server.use(
    http.post(`${gateway}/v1/chat/completions`, async ({ request }) => {
      body = (await request.json()) as typeof body;
      return new HttpResponse(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  return {
    get body() {
      return body;
    },
  };
}

describe('tester image upload', () => {
  it('sends attached images as OpenAI image_url content parts', async () => {
    const capture = captureChatBody();
    renderInChinese(<Home />);
    const user = await openTester();
    const input = screen.getByPlaceholderText(/问点什么/);
    await user.type(input, '这是什么');
    await user.upload(screen.getByTestId('tester-image-input'), pngFile('a.png'));
    expect(await screen.findByAltText('attachment-0')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await screen.findByText('ok');
    await waitFor(() => expect(capture.body).not.toBeNull());
    const messages = capture.body!.messages!;
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(parts[0]).toEqual({ type: 'text', text: '这是什么' });
    expect(parts[1]?.type).toBe('image_url');
    expect(parts[1]?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('allows an image-only send with empty text', async () => {
    const capture = captureChatBody();
    renderInChinese(<Home />);
    const user = await openTester();
    await user.upload(screen.getByTestId('tester-image-input'), pngFile('solo.png'));
    const send = screen.getByRole('button', { name: '发送消息' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    await user.click(send);
    await screen.findByText('ok');
    await waitFor(() => expect(capture.body).not.toBeNull());
    const last = capture.body!.messages![capture.body!.messages!.length - 1]!;
    const parts = last.content as Array<{ type: string }>;
    expect(parts.every((p) => p.type === 'image_url')).toBe(true);
  });

  it('rejects images over the 10MB limit with an inline error', async () => {
    const capture = captureChatBody();
    renderInChinese(<Home />);
    const user = await openTester();
    const huge = new File([new Uint8Array(14 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    await user.upload(screen.getByTestId('tester-image-input'), huge);
    expect(await screen.findByText('图片超过 10MB，未添加')).toBeTruthy();
    expect(screen.queryByAltText(/^attachment-/)).toBeNull();
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    void capture;
  });

  it('removes a single draft thumbnail via its remove button', async () => {
    renderInChinese(<Home />);
    const user = await openTester();
    await user.upload(screen.getByTestId('tester-image-input'), [
      pngFile('one.png'),
      pngFile('two.png'),
    ]);
    expect(await screen.findByAltText('attachment-0')).toBeTruthy();
    expect(screen.getByAltText('attachment-1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '移除图片 1' }));
    expect(screen.queryByAltText('attachment-0')).toBeNull();
    expect(screen.getByAltText('attachment-1')).toBeTruthy();
  });

  it('keeps a text-only send on the plain string wire format', async () => {
    const capture = captureChatBody();
    renderInChinese(<Home />);
    const user = await openTester();
    await user.type(screen.getByPlaceholderText(/问点什么/), 'plain');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await screen.findByText('ok');
    await waitFor(() => expect(capture.body).not.toBeNull());
    const last = capture.body!.messages![capture.body!.messages!.length - 1]!;
    expect(last.content).toBe('plain');
  });
});
```

**Test author notes:**

- `user.upload` with an array uploads multiple files through the same input (RTL supports `File[]`).
- `TINY_PNG` constant is declared above `pngFile` for potential `expect(url).toBe(TINY_PNG)`-style checks; the body assertions use `startsWith('data:image/png;base64,')` because `FileReader` may normalize the base64 payload.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/__tests__/home.test.tsx`
Expected: new tests FAIL (`tester-image-input` not found / disabled send), existing tests still PASS.

- [ ] **Step 3: Update `TesterView.tsx`**

1. Extend `Msg`:

```ts
export type Msg = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  imageUrls?: string[];
  uploadImages?: string[];
  videoId?: string;
  videoProvider?: string;
};
```

2. Import `Paperclip` from `lucide-react` and helpers:

```ts
import { Paperclip /* existing icons */ } from 'lucide-react';
import { fileToDataURL, isImageDataUrlWithinLimit } from '../lib/image';
```

3. Extend props (destructure the two new ones):

```ts
export function TesterView({
  messages,
  streaming,
  input,
  model,
  models,
  inputImages,
  setInput,
  setImages,
  send,
  onCancel,
  onModelChange,
  onClear,
}: {
  messages: Msg[];
  streaming: boolean;
  input: string;
  model: string;
  models: ModelItem[];
  inputImages: string[];
  setInput: (value: string) => void;
  setImages: (value: string[]) => void;
  send: () => void;
  onCancel: () => void;
  onModelChange: (value: string) => void;
  onClear: () => void;
}) {
```

(Note: prop names are `inputImages` / `setImages` — page.tsx passes `setImages={setInputImages}`. Keep these exact names everywhere.)

4. Add refs/state inside the component:

```ts
const fileInputRef = useRef<HTMLInputElement>(null);
const [attachError, setAttachError] = useState('');
```

5. Add the enqueue callback (uses local accumulator to avoid stale-closure bugs):

```ts
const enqueueImages = useCallback(
  async (files: File[]) => {
    setAttachError('');
    const next = [...inputImages];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const url = await fileToDataURL(file);
        if (!isImageDataUrlWithinLimit(url)) {
          setAttachError(t('tester.attach.tooLarge'));
          continue;
        }
        next.push(url);
      } catch {
        setAttachError(t('tester.attach.readError'));
      }
    }
    setImages(next);
  },
  [inputImages, setImages, t],
);
```

6. Replace the input shell (currently a single `flex items-end` row at ~line 246) with a column that hosts the draft strip above the textarea row:

```tsx
<div className="flex flex-col rounded-2xl border border-input bg-surface p-2 shadow-sm transition focus-within:border-ring focus-within:shadow-[0_0_0_4px_hsl(var(--ring)/0.08)]">
  {inputImages.length > 0 && (
    <div data-testid="tester-drafts" className="flex flex-wrap gap-2 px-1 pb-2">
      {inputImages.map((url, i) => (
        <div key={`${i}-${url.slice(0, 24)}`} className="relative">
          <img
            src={url}
            alt={`attachment-${i}`}
            className="h-14 w-14 rounded-lg border border-border object-cover"
          />
          <button
            type="button"
            aria-label={t('tester.attach.removeAria', { index: String(i + 1) })}
            onClick={() => setImages(inputImages.filter((_, j) => j !== i))}
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[11px] leading-none text-background shadow transition hover:opacity-80"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )}
  {attachError && (
    <p role="alert" className="px-1 pb-2 text-xs text-destructive">
      {attachError}
    </p>
  )}
  <div className="flex items-end gap-2">
    <button
      type="button"
      aria-label={t('tester.attach.aria')}
      disabled={streaming || models.length === 0}
      onClick={() => fileInputRef.current?.click()}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Paperclip size={16} />
    </button>
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      multiple
      data-testid="tester-image-input"
      className="hidden"
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (files.length > 0) void enqueueImages(files);
      }}
    />
    <textarea
      /* ...existing textarea props unchanged, plus: */
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.items)
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter((file): file is File => !!file);
        if (files.length > 0) {
          event.preventDefault();
          void enqueueImages(files);
        }
      }}
    />
    <button
      type={streaming ? 'button' : 'submit'}
      aria-label={streaming ? t('tester.send.stopAria') : t('tester.send.sendAria')}
      onClick={streaming ? onCancel : undefined}
      disabled={!streaming && (!model || (!input.trim() && inputImages.length === 0))}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {streaming ? (
        <Square size={15} fill="currentColor" />
      ) : (
        <ArrowUp size={17} strokeWidth={2.2} />
      )}
    </button>
  </div>
</div>
```

Keep the existing textarea body (`ref`, `rows`, `value`, `disabled`, `onChange`, `onKeyDown`, `placeholder`, `className`) exactly as-is; only add `onPaste`. The existing hint row below the shell stays outside/after this container.

- [ ] **Step 4: Update `page.tsx`**

1. Next to `const [input, setInput] = useState('');` (line ~86) add:

```ts
const [inputImages, setInputImages] = useState<string[]>([]);
```

2. Import the mapper:

```ts
import { toWireContent } from './lib/chat';
```

3. Rewrite the head of `send()` (currently lines 353–370):

```ts
async function send() {
  if ((!input.trim() && inputImages.length === 0) || streaming || !model) return;

  const userMsg: Msg = {
    role: 'user',
    content: input.trim(),
    ...(inputImages.length > 0 ? { uploadImages: inputImages } : {}),
  };
  const next: Msg[] = [...messages, userMsg];
  const assistantIndex = next.length;
  setMessages([...next, { role: 'assistant', content: '' }]);
  setInput('');
  setInputImages([]);
  setStreaming(true);
  const controller = new AbortController();
  streamAbortRef.current = controller;

  const wireMessages = next.map((m) => ({
    role: m.role,
    content: toWireContent(m.content, m.uploadImages),
  }));

  try {
    const response = await fetch(
      `${GATEWAY}/v1/chat/completions`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: wireMessages, stream: true }),
        signal: controller.signal,
      }),
    );
    // ...rest of the function unchanged from the original body (response checks, reader loop, catch, finally)
```

Do not change anything after the `fetch` — the stream loop, image/video response handling, catch, and finally stay byte-identical.

4. Clear drafts together with messages:

```ts
onClear={() => {
  setMessages([]);
  setInputImages([]);
}}
```

5. Pass new props into `<TesterView ... />` (line ~656):

```tsx
<TesterView
  messages={messages}
  streaming={streaming}
  input={input}
  model={model}
  models={models}
  inputImages={inputImages}
  setInput={setInput}
  setImages={setInputImages}
  send={send}
  onCancel={cancelStream}
  onModelChange={selectModel}
  onClear={onClearTester}
/>
```

where above the return you define:

```ts
const onClearTester = useCallback(() => {
  setMessages([]);
  setInputImages([]);
}, []);
```

(and use `onClear={onClearTester}` — remove the inline arrow from step 4 in favor of this callback.)

- [ ] **Step 5: Run the new tests**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/__tests__/home.test.tsx`
Expected: all tests PASS, including the 5 new ones and every pre-existing test.

- [ ] **Step 6: Format, lint, commit**

```powershell
npx prettier --write packages/ui/app/components/TesterView.tsx packages/ui/app/page.tsx packages/ui/app/__tests__/home.test.tsx
npx eslint packages/ui/app/components/TesterView.tsx packages/ui/app/page.tsx packages/ui/app/__tests__/home.test.tsx --max-warnings=0
git add packages/ui/app/components/TesterView.tsx packages/ui/app/page.tsx packages/ui/app/__tests__/home.test.tsx
git commit -m "feat(ui): attach images in tester via picker and paste"
```

---

### Task 5: Render sent uploads in MessageRow

**Files:**

- Modify: `packages/ui/app/components/TesterView.tsx` (`MessageRow`, ~lines 297–435)
- Test: `packages/ui/app/__tests__/home.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to the `tester image upload` describe:

```tsx
it('renders sent uploads as thumbnails on the user message', async () => {
  captureChatBody();
  renderInChinese(<Home />);
  const user = await openTester();
  await user.upload(screen.getByTestId('tester-image-input'), pngFile('hist.png'));
  await user.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByAltText('uploaded-0')).toBeTruthy();
  expect(screen.queryByAltText('attachment-0')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/__tests__/home.test.tsx`
Expected: new test FAIL (`uploaded-0` not found); others PASS.

- [ ] **Step 3: Update `MessageRow`**

1. Next to `hasImages`:

```ts
const hasUploads = (message.uploadImages?.length ?? 0) > 0;
```

2. Only render the text bubble when there is text or it is the streaming placeholder (image-only user messages skip the empty box; assistant image-generation messages with `content: ''` also lose the empty box — visual improvement, copy button gate already handles `hasImages`):

Replace:

```tsx
<div
  className={classNames(
    'inline-block whitespace-pre-wrap rounded-2xl px-4 py-3 text-left text-sm leading-7',
    /* ...existing ternary... */
  )}
>
```

with a conditional wrapper:

```tsx
{
  (message.content || isStreamingLast) && (
    <div
      className={classNames(
        'inline-block whitespace-pre-wrap rounded-2xl px-4 py-3 text-left text-sm leading-7',
        isUser
          ? 'rounded-tr-sm bg-foreground text-background'
          : isError
            ? 'rounded-tl-sm border border-destructive/25 bg-destructive/5 text-destructive'
            : 'rounded-tl-sm border border-border bg-surface text-foreground',
      )}
    >
      {message.content ? (
        isError ? (
          message.content.replace(/^\[error\]\s*/, '')
        ) : (
          message.content
        )
      ) : (
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <Loader2 className="animate-spin" size={14} />
          {t('tester.msg.waiting')}
        </span>
      )}
    </div>
  );
}
```

(The old `: isStreamingLast ? spinner : null` branch collapses — spinner only renders when the bubble renders.)

3. After the `hasImages` block, add the uploads block (same markup, different alt prefix, no link wrapper needed — keep the anchor for parity):

```tsx
{
  hasUploads && (
    <div className="mt-2 flex flex-wrap gap-2 justify-start">
      {message.uploadImages!.map((url, i) => (
        <a key={i} href={url} target="_blank" rel="noopener noreferrer">
          <img
            src={url}
            alt={`uploaded-${i}`}
            className="max-h-[300px] rounded-xl border border-border object-contain"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  );
}
```

Note: parent content div has `text-right` for user — thumbnails wrap fine either way; drop `justify-start` if it fights the alignment (visual judgment call, keep markup minimal).

4. Copy-button gate stays `!isUser && (message.content || hasImages || hasVideo)` — no change required (uploads are user-side).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/__tests__/home.test.tsx`
Expected: PASS — all tests including `uploaded-0`.

- [ ] **Step 5: Format, lint, commit**

```powershell
npx prettier --write packages/ui/app/components/TesterView.tsx packages/ui/app/__tests__/home.test.tsx
npx eslint packages/ui/app/components/TesterView.tsx packages/ui/app/__tests__/home.test.tsx --max-warnings=0
git add packages/ui/app/components/TesterView.tsx packages/ui/app/__tests__/home.test.tsx
git commit -m "feat(ui): render sent image uploads on tester user messages"
```

---

### Task 6: Full verification

**Files:** none new — verification only.

- [ ] **Step 1: Full UI test suite**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: all suites PASS (known flake: `settings.test.tsx` may pass singly and in full run — if it fails only in the full run, re-run it alone to confirm non-regression).

- [ ] **Step 2: Lint all touched files**

```powershell
npx eslint packages/ui/app/lib/image.ts packages/ui/app/lib/chat.ts packages/ui/app/lib/__tests__/image.test.ts packages/ui/app/lib/__tests__/chat.test.ts packages/ui/app/i18n.tsx packages/ui/app/components/TesterView.tsx packages/ui/app/page.tsx packages/ui/app/__tests__/home.test.tsx --max-warnings=0
```

Expected: no output, exit 0.

- [ ] **Step 3: Typecheck (sequential, never parallel with build)**

```powershell
pnpm build:runtime; if ($?) { pnpm typecheck }
```

Expected: all 4 packages Done. (If dist is already fresh, `pnpm typecheck` alone is enough; if TS7016 on `@freemodelfinder/core` appears, re-run sequentially — parallel build/typecheck is a known false-failure.)

- [ ] **Step 4: Confirm clean tree**

```powershell
git status --short
```

Expected: empty (all tasks committed).

- [ ] **Step 5: Final report**

Summarize: commits added, tests added/passing, remind user to restart the gateway (`:11435`) to pick up earlier server/core fixes (this feature itself is UI-only), and remind that 33+ commits remain unpushed — ask before pushing.

---

## Self-Review

1. **Spec coverage:**
   - Multi-image ✓ (Task 4, `multiple` + array state)
   - Image-only send ✓ (guard change + test)
   - 10MB reject ✓ (Task 1 algorithm mirrors `vision.ts:26-35` exactly, integration test 14MB)
   - Wire format ✓ (Task 2 unit + Task 4 body capture; plain-string regression pinned)
   - History multi-turn ✓ (Task 4 maps `next` which includes prior `uploadImages`)
   - Paste + picker ✓ (Task 4)
   - Draft strip remove ✓ (test)
   - History thumbnail ✓ (Task 5)
   - i18n 4 keys ✓ (Task 3)
   - Error path reuse ✓ (no new error handling; gateway errors go through existing catch)
   - Non-goals respected ✓ (no server/core/drag/compress changes)
2. **Placeholder scan:** No TBDs, no "similar to task" references, all code blocks complete.
3. **Type consistency:** Props are `inputImages` + `setImages` in TesterView and `setImages={setInputImages}` at the call site — used identically in Tasks 4–5. `Msg.uploadImages` name consistent across Tasks 4–5. `toWireContent(text, images)` signature consistent Tasks 2/4.
