import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const gateway = 'http://127.0.0.1:11435';

export const modelPayload = {
  object: 'list',
  data: [
    {
      id: 'fixture-model',
      provider: 'openrouter',
      display_name: 'Fixture Model',
      context_window: 32_000,
      capability_score: 80,
      free: true,
    },
  ],
  fmf: {
    failed_providers: [{ id: 'github', error: 'temporary provider error' }],
  },
};

export const configPayload = {
  version: 2,
  port: 11435,
  defaultModel: 'openrouter:fixture-model',
  providers: {
    openrouter: { enabled: false, hasKey: false, keyCount: 0, keyMeta: [] },
    gemini: { enabled: false, hasKey: false, keyCount: 0, keyMeta: [] },
  },
  onboarding: {
    completedAt: 1_700_000_000_000,
    primaryProvider: 'openrouter',
  },
  custom: {
    enabled: true,
    hasKey: false,
    baseUrl: '',
    models: [],
    sources: [
      {
        id: 'fixture-source',
        label: 'Fixture Source',
        baseUrl: 'https://fixture.invalid/v1',
        hasKey: true,
        keyMeta: [{ id: 'k0', hint: '…a1b2' }],
        keepAlive: true,
        keepAliveMinutes: 14,
        models: [{ id: 'custom-model', displayName: 'Custom Model' }],
      },
    ],
  },
};

export const defaultHandlers = [
  http.get(`${gateway}/v1/models`, () => HttpResponse.json(modelPayload)),
  http.post(`${gateway}/v1/models/refresh`, () => HttpResponse.json({ ok: true })),
  http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
  http.post(`${gateway}/api/default-model`, () => HttpResponse.json({ ok: true })),
  http.get(`${gateway}/api/desktop/state`, () =>
    HttpResponse.json({
      instanceId: 'fixture-instance',
      revision: 1,
      catalogRevision: 1,
      defaultModel: 'openrouter:fixture-model',
      selectionValid: true,
      onboardingRequired: false,
    }),
  ),
  http.get(`${gateway}/api/stats`, () =>
    HttpResponse.json({
      range: 'today',
      since: 0,
      totals: {
        calls: 0,
        errors: 0,
        rateLimited: 0,
        success: 0,
        successRate: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheHitRate: 0,
      },
      byModel: [
        {
          provider: 'openrouter',
          model: 'fixture-model',
          calls: 5,
          errors: 0,
          rateLimited: 0,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cachedTokens: 0,
          cacheHitRate: 0,
        },
        {
          provider: 'custom',
          model: 'other-model',
          calls: 3,
          errors: 0,
          rateLimited: 0,
          promptTokens: 60,
          completionTokens: 20,
          totalTokens: 80,
          cachedTokens: 0,
          cacheHitRate: 0,
        },
      ],
    }),
  ),
  http.get(`${gateway}/api/stats/series`, () =>
    HttpResponse.json({
      range: '7d',
      bucket: 'day',
      since: 0,
      until: 1_700_000_000_000,
      points: [
        {
          start: 1_699_900_000_000,
          calls: 3,
          errors: 1,
          rateLimited: 0,
          promptTokens: 100,
          completionTokens: 50,
          cachedTokens: 0,
        },
        {
          start: 1_700_000_000_000,
          calls: 2,
          errors: 0,
          rateLimited: 1,
          promptTokens: 80,
          completionTokens: 30,
          cachedTokens: 0,
        },
      ],
    }),
  ),
  http.get(`${gateway}/api/logs`, () =>
    HttpResponse.json({
      data: [
        {
          ts: 1_700_000_000_000,
          kind: 'chat',
          provider: 'openrouter',
          model: 'fixture-model',
          status: 'success',
          latencyMs: 120,
          promptTokens: 10,
          completionTokens: 5,
        },
        {
          ts: 1_699_999_000_000,
          kind: 'chat',
          provider: 'openrouter',
          model: 'fixture-model',
          status: 'error',
          latencyMs: 90,
        },
      ],
      nextCursor: '1699999000000:1',
    }),
  ),
  http.get(`${gateway}/api/model-quotas`, () => HttpResponse.json({ data: [] })),
  http.post(`${gateway}/api/model-quotas/probe`, () => HttpResponse.json({ data: [] })),
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
  http.get(`${gateway}/api/auto-route/model-options`, () =>
    HttpResponse.json({
      models: [
        {
          id: 'custom:fixture:img-a',
          provider: 'custom',
          displayName: 'Img A',
          capabilities: ['image'],
        },
        {
          id: 'custom:fixture:vid-a',
          provider: 'custom',
          displayName: 'Vid A',
          capabilities: ['video'],
        },
        {
          id: 'custom:fixture:chat-1',
          provider: 'custom',
          displayName: 'Chat 1',
          capabilities: ['text'],
        },
        { id: 'custom:fixture:legacy', provider: 'custom', displayName: 'Legacy' },
        {
          id: 'custom:fixture:mm-chat',
          provider: 'custom',
          displayName: 'MM Chat',
          vision: true,
        },
        { id: 'custom:fx:fast', provider: 'custom', displayName: 'Fast' },
        { id: 'custom:fx:plain', provider: 'custom', displayName: 'Plain' },
      ],
    }),
  ),
  http.post(`${gateway}/api/auto-route`, () => HttpResponse.json({ ok: true })),
  http.post(`${gateway}/api/auto-route/clear-cooldown`, () => HttpResponse.json({ ok: true })),
  http.get(`${gateway}/api/gateway`, () =>
    HttpResponse.json({ hasKey: false, apiKey: null, requireAuth: false, port: 11435 }),
  ),
  http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
  http.get(`${gateway}/api/model-cleanup-log`, () => HttpResponse.json({ entries: [] })),
  http.post(`${gateway}/api/model-aliases`, () =>
    HttpResponse.json({ ok: true, modelAliases: {} }),
  ),
  http.get(`${gateway}/api/cline/accounts`, () => HttpResponse.json({ accounts: [] })),
  http.get(`${gateway}/api/subscription/credentials`, () => HttpResponse.json({ accounts: [] })),
  http.get(`${gateway}/api/subscription/quota-exceeded/switch-project`, () =>
    HttpResponse.json({ 'switch-project': false }),
  ),
  http.post(`${gateway}/api/providers`, () => HttpResponse.json({ ok: true })),
  http.post(`${gateway}/api/gateway`, () =>
    HttpResponse.json({
      ok: true,
      hasKey: true,
      apiKey: 'fmf-generated-key',
      keys: [
        {
          id: 'key-1',
          label: null,
          key: 'fmf-generated-key',
          createdAt: 1_700_000_000_000,
          expiresAt: null,
          dailyRequestLimit: null,
          dailyTokenLimit: null,
          modelAllowlist: [],
        },
      ],
      requireAuth: true,
    }),
  ),
  http.get(`${gateway}/api/onboarding/environment`, () => HttpResponse.json({ data: [] })),
  http.post(`${gateway}/api/onboarding/dismiss`, () => HttpResponse.json({ ok: true })),
  http.get(`${gateway}/api/admin/status`, () =>
    HttpResponse.json({ authRequired: false, authenticated: true, remote: false }),
  ),
  http.post(`${gateway}/api/admin/logout`, () => HttpResponse.json({ ok: true })),
  http.post(`${gateway}/api/admin/password`, () =>
    HttpResponse.json({ ok: true, authRequired: true }),
  ),
];

export const server = setupServer(...defaultHandlers);
