import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import Home from '../page';
import { gateway, server } from '../../test/server';
import { I18nProvider } from '../i18n';

function renderInChinese(ui: ReactNode) {
  window.localStorage.setItem('fmf-language', 'zh');
  return render(<I18nProvider>{ui}</I18nProvider>);
}

type User = ReturnType<typeof userEvent.setup>;

async function openFinder(user: User) {
  await screen.findByRole('button', { name: '统计' });
  await user.click(screen.getAllByRole('button', { name: '模型' })[0]!);
}

async function openTester() {
  const user = userEvent.setup();
  await openFinder(user);
  await screen.findByText('Fixture Model');
  await user.click(screen.getAllByRole('button', { name: '测试' })[0]!);
  return user;
}

describe('Home', () => {
  it('shows onboarding instead of an empty catalog for a new configuration', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          version: 2,
          port: 11435,
          providers: {
            openrouter: { enabled: false, hasKey: false },
            gemini: { enabled: false, hasKey: false },
          },
        }),
      ),
    );
    renderInChinese(<Home />);
    expect(await screen.findByText('先连接一个免费模型来源')).toBeTruthy();
    expect(screen.queryByText('Fixture Model')).toBeNull();
  });

  it('keeps a persistent setup entry after onboarding is dismissed', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          version: 2,
          port: 11435,
          onboarding: { dismissedAt: 1_700_000_000_000 },
          providers: { openrouter: { enabled: false, hasKey: false } },
        }),
      ),
      http.get(`${gateway}/v1/models`, () =>
        HttpResponse.json({ object: 'list', data: [], fmf: { failed_providers: [] } }),
      ),
    );
    renderInChinese(<Home />);
    const user = userEvent.setup();
    await openFinder(user);
    expect(await screen.findByRole('button', { name: '连接第一个 Provider' })).toBeTruthy();
  });

  it('returns to onboarding when a newly saved key is still pending verification', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          version: 2,
          port: 11435,
          onboarding: {},
          providers: { openrouter: { enabled: true, hasKey: true } },
        }),
      ),
    );
    renderInChinese(<Home />);
    expect(await screen.findByText('先连接一个免费模型来源')).toBeTruthy();
  });

  it('lands on the stats page by default', async () => {
    renderInChinese(<Home />);
    expect(await screen.findByText('调用统计')).toBeTruthy();
    expect(screen.queryByText('Fixture Model')).toBeNull();
  });

  it('loads free models and surfaces provider failures', async () => {
    const user = userEvent.setup();
    renderInChinese(<Home />);
    await openFinder(user);
    expect(await screen.findByText('Fixture Model')).toBeTruthy();
    expect(screen.getByText(/1 个来源本次同步失败/)).toBeTruthy();
    expect(screen.getByText(/temporary provider error/)).toBeTruthy();
  });

  it('applies model changes made outside the dashboard', async () => {
    server.use(
      http.get(`${gateway}/api/desktop/state`, () =>
        HttpResponse.json({
          instanceId: 'fixture-instance',
          revision: 2,
          catalogRevision: 1,
          defaultModel: 'auto',
          selectionValid: true,
          onboardingRequired: false,
        }),
      ),
    );
    renderInChinese(<Home />);
    await openTester();
    await waitFor(() =>
      expect((screen.getByLabelText('当前模型') as HTMLSelectElement).value).toBe('auto'),
    );
  });

  it('keeps the confirmed selection when persistence fails', async () => {
    server.use(
      http.post(`${gateway}/api/default-model`, () =>
        HttpResponse.json({ error: 'cannot save selection' }, { status: 500 }),
      ),
    );
    renderInChinese(<Home />);
    const user = await openTester();
    const selector = screen.getByLabelText('当前模型');
    await user.selectOptions(selector, 'auto');
    expect(await screen.findByText('cannot save selection')).toBeTruthy();
    expect((selector as HTMLSelectElement).value).toBe('openrouter:fixture-model');
  });

  it('keeps the catalog usable when a provider refresh fails', async () => {
    server.use(
      http.post(`${gateway}/v1/models/refresh`, () =>
        HttpResponse.json({ error: 'refresh failed' }, { status: 503 }),
      ),
    );
    const user = userEvent.setup();
    renderInChinese(<Home />);
    await openFinder(user);
    await screen.findByText('Fixture Model');
    await user.click(screen.getByRole('button', { name: '同步' }));
    expect(await screen.findByText('本地网关没有响应')).toBeTruthy();
  });

  it('renders streamed OpenAI-compatible text', async () => {
    server.use(
      http.post(
        `${gateway}/v1/chat/completions`,
        () =>
          new HttpResponse(
            'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    renderInChinese(<Home />);
    const user = await openTester();
    const input = screen.getByPlaceholderText(/问点什么/);
    await user.type(input, 'hello');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    expect(await screen.findByText('Hello world')).toBeTruthy();
  });

  it('cancels an in-flight stream', async () => {
    server.use(
      http.post(`${gateway}/v1/chat/completions`, () => {
        const encoder = new TextEncoder();
        return new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }),
    );
    renderInChinese(<Home />);
    const user = await openTester();
    await user.type(screen.getByPlaceholderText(/问点什么/), 'cancel me');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    const stop = await screen.findByRole('button', { name: '停止生成' });
    await user.click(stop);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '发送消息' })).toBeTruthy();
    });
  });

  describe('tester image upload', () => {
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
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.every((p) => p.type === 'image_url')).toBe(true);
    });

    it('rejects images over the 10MB limit with an inline error', async () => {
      renderInChinese(<Home />);
      const user = await openTester();
      const huge = new File([new Uint8Array(14 * 1024 * 1024)], 'big.png', { type: 'image/png' });
      await user.upload(screen.getByTestId('tester-image-input'), huge);
      expect(await screen.findByText('图片超过 10MB，未添加')).toBeTruthy();
      expect(screen.queryByAltText(/^attachment-/)).toBeNull();
      expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    it('removes a single draft thumbnail via its remove button', async () => {
      renderInChinese(<Home />);
      const user = await openTester();
      await user.upload(screen.getByTestId('tester-image-input'), [
        pngFile('one.png', 8),
        pngFile('two.png', 16),
      ]);
      expect(await screen.findByAltText('attachment-0')).toBeTruthy();
      expect(screen.getByAltText('attachment-1')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: '移除图片 1' }));
      const thumbs = screen.getAllByAltText(/^attachment-/);
      expect(thumbs).toHaveLength(1);
      expect((thumbs[0] as HTMLImageElement).src).toBe(
        'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAA==',
      );
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

    it('renders sent uploads as thumbnails on the user message', async () => {
      captureChatBody();
      renderInChinese(<Home />);
      const user = await openTester();
      await user.upload(screen.getByTestId('tester-image-input'), pngFile('hist.png'));
      await user.click(screen.getByRole('button', { name: '发送消息' }));
      expect(await screen.findByAltText('uploaded-0')).toBeTruthy();
      expect(screen.queryByAltText('attachment-0')).toBeNull();
    });
  });
});
