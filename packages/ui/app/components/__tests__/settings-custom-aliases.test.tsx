import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { commitCustomAliasSave } from '../../lib/customAliasSave';
import { SettingsView } from '../SettingsView';
import { configPayload, gateway, server } from '../../../test/server';

const SOURCES_BODY = { provider: 'custom', enabled: true, sources: [] };

describe('commitCustomAliasSave', () => {
  it('posts aliases before sources', async () => {
    const order: string[] = [];
    const aliasBodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'novaway/glm': 'custom:novaway:glm-5.3' } }),
      ),
      http.post(`${gateway}/api/model-aliases`, async ({ request }) => {
        order.push('aliases');
        aliasBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${gateway}/api/providers`, () => {
        order.push('providers');
        return HttpResponse.json({ ok: true });
      }),
    );

    const result = await commitCustomAliasSave({
      changes: [
        {
          id: 'novaway',
          models: ['glm-5.3', 'qwen-8b'],
          aliases: [{ alias: 'glm', targetModel: 'glm-5.3' }],
        },
      ],
      sourcesBody: SOURCES_BODY,
    });

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['aliases', 'providers']);
    expect(aliasBodies).toHaveLength(1);
    expect(aliasBodies[0]).toEqual({
      modelAliases: { 'novaway/glm': 'custom:novaway:glm-5.3' },
    });
  });

  it('strips a still-valid alias row when its source reports an empty list (R1)', async () => {
    const aliasBodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'novaway/glm': 'custom:novaway:glm-5.3' } }),
      ),
      http.post(`${gateway}/api/model-aliases`, async ({ request }) => {
        aliasBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${gateway}/api/providers`, () => HttpResponse.json({ ok: true })),
    );

    const result = await commitCustomAliasSave({
      changes: [{ id: 'novaway', models: ['glm-5.3'], aliases: [] }],
      sourcesBody: SOURCES_BODY,
    });

    expect(result).toEqual({ ok: true });
    expect(aliasBodies[0]).toEqual({ modelAliases: {} });
  });

  it('leaves an unreported source untouched (R1)', async () => {
    const aliasBodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'cpa/gpt': 'custom:cpa:gpt-mini' } }),
      ),
      http.post(`${gateway}/api/model-aliases`, async ({ request }) => {
        aliasBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${gateway}/api/providers`, () => HttpResponse.json({ ok: true })),
    );

    const result = await commitCustomAliasSave({
      changes: [
        { id: 'novaway', models: ['glm-5.3'], aliases: [{ alias: 'g', targetModel: 'glm-5.3' }] },
      ],
      sourcesBody: SOURCES_BODY,
    });

    expect(result).toEqual({ ok: true });
    expect(aliasBodies[0]).toEqual({
      modelAliases: { 'cpa/gpt': 'custom:cpa:gpt-mini', 'novaway/g': 'custom:novaway:glm-5.3' },
    });
  });

  it('preserves unrelated prefixed and bare alias entries', async () => {
    const aliasBodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({
          modelAliases: { 'cpa/gpt': 'custom:cpa:gpt-mini', legacy1: 'custom:novaway:glm-5.3' },
        }),
      ),
      http.post(`${gateway}/api/model-aliases`, async ({ request }) => {
        aliasBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${gateway}/api/providers`, () => HttpResponse.json({ ok: true })),
    );

    await commitCustomAliasSave({
      changes: [
        { id: 'novaway', models: ['glm-5.3'], aliases: [{ alias: 'g', targetModel: 'glm-5.3' }] },
      ],
      sourcesBody: SOURCES_BODY,
    });

    const body = aliasBodies[0] as { modelAliases: Record<string, string> };
    expect(body.modelAliases['cpa/gpt']).toBe('custom:cpa:gpt-mini');
    expect(body.modelAliases['legacy1']).toBe('custom:novaway:glm-5.3');
  });

  it('aborts before providers when the aliases POST fails', async () => {
    let providersPosted = false;
    server.use(
      http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
      http.post(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ error: 'reserved alias' }, { status: 400 }),
      ),
      http.post(`${gateway}/api/providers`, () => {
        providersPosted = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    const result = await commitCustomAliasSave({
      changes: [{ id: 'novaway', models: ['glm-5.3'], aliases: [] }],
      sourcesBody: SOURCES_BODY,
    });

    expect(result).toEqual({ ok: false, stage: 'aliases', detail: 'reserved alias' });
    expect(providersPosted).toBe(false);
  });

  it('reports the sources stage when the providers POST fails after aliases succeeded', async () => {
    const order: string[] = [];
    server.use(
      http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
      http.post(`${gateway}/api/model-aliases`, () => {
        order.push('aliases');
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${gateway}/api/providers`, () => {
        order.push('providers');
        return HttpResponse.json({ error: 'boom' }, { status: 500 });
      }),
    );

    const result = await commitCustomAliasSave({
      changes: [],
      sourcesBody: SOURCES_BODY,
    });

    expect(result).toEqual({ ok: false, stage: 'sources', detail: 'boom' });
    expect(order).toEqual(['aliases', 'providers']);
  });
});

describe('SettingsView legacy alias hint', () => {
  it('shows the migration hint in the Custom tab when bare legacy aliases exist', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({ ...configPayload, custom: { ...configPayload.custom, sources: [] } }),
      ),
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { legacy1: 'custom:fixture-source:custom-model' } }),
      ),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(await screen.findByRole('tab', { name: '自定义' }));
    // No sources -> no per-source editors, so this pins the section-level hint.
    expect(await screen.findByText(/旧格式别名/)).toBeTruthy();
  });
});

describe('SettingsView saveCustomProvider alias ordering', () => {
  it('saves aliases first, then sources, and surfaces a failure toast when sources fail', async () => {
    const order: string[] = [];
    server.use(
      http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
      http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
      http.post(`${gateway}/api/model-aliases`, () => {
        order.push('aliases');
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${gateway}/api/providers`, () => {
        order.push('providers');
        return HttpResponse.json({ error: 'boom' }, { status: 500 });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);

    // The alias editors mount when the Custom tab is opened.
    await user.click(await screen.findByRole('tab', { name: '自定义' }));
    const save = await screen.findByRole('button', { name: '保存自定义模型' }, { timeout: 5000 });
    // Wait until the per-source alias editor has hydrated (it reports then).
    await screen.findByRole('button', { name: /添加别名/ }, { timeout: 5000 });
    await user.click(save);

    await waitFor(() => expect(screen.getByText(/别名已保存，但/)).toBeTruthy(), {
      timeout: 5000,
    });
    expect(order).toEqual(['aliases', 'providers']);
  }, 15000);
});
