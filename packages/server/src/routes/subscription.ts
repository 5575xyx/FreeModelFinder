import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  SUBSCRIPTION_ADAPTERS,
  SubscriptionRefreshError,
  getCredentialRuntime,
  redact,
  type ParsedSubscription,
  type SubscriptionAccountProfile,
} from '@freemodelfinder/core';

export const SUBSCRIPTION_PROVIDERS = ['codex', 'claude', 'google'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

/** 导入文件只允许落在这些 `~/.<dir>` 白名单目录内，防止任意文件读。 */
const IMPORT_ROOT_DIRS = ['.codex', '.claude', '.gemini'] as const;

export const IMPORT_HINTS: ReadonlyArray<{ provider: SubscriptionProvider; path: string }> = [
  { provider: 'codex', path: '~/.codex/auth.json' },
  { provider: 'claude', path: '~/.claude/.credentials.json' },
  { provider: 'google', path: '~/.gemini/oauth_creds.json' },
];

function redactMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return typeof value === 'string' && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * 把 `~/...` 形式解析为绝对路径，并强制其落在 `~/.codex`、`~/.claude`、`~/.gemini`
 * 三者之一内。任何穿越（`../`）或落在白名单外的路径都返回 null（调用方回 400）。
 */
export function resolveImportPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('~/')) return null;
  const home = resolve(homedir());
  const resolved = resolve(home, trimmed.slice(2));
  for (const dir of IMPORT_ROOT_DIRS) {
    const root = resolve(home, dir);
    if (resolved.startsWith(root + sep)) return resolved;
  }
  return null;
}

function profileFields(
  profile: SubscriptionAccountProfile | undefined,
  payload: Record<string, string>,
): { email?: string; plan?: string } {
  const email = profile?.email || payload.email || undefined;
  const plan = profile?.plan || payload.plan || undefined;
  return {
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function registerSubscriptionRoutes(app: FastifyInstance): void {
  app.get('/api/subscription/import-hints', async () => IMPORT_HINTS);

  app.get('/api/subscription/accounts', async () => {
    const runtime = getCredentialRuntime();
    const accounts: Array<Record<string, unknown>> = [];
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      const pool = await runtime.getPool(provider);
      const usage = new Map(
        runtime.snapshotUsage(provider).map((entry) => [entry.accountId, entry]),
      );
      for (const account of pool.accounts) {
        const stats = usage.get(account.id);
        const extra = profileFields(undefined, account.payload);
        accounts.push({
          provider,
          id: account.id,
          label: account.label ?? account.id,
          ...extra,
          status: account.status,
          addedAt: account.addedAt,
          ...(account.payload.expiresAt ? { expiresAt: account.payload.expiresAt } : {}),
          cooldowns: runtime.listAccountCooldowns(provider, account.id),
          usage: {
            requests: stats?.requests ?? 0,
            promptTokens: stats?.promptTokens ?? 0,
            completionTokens: stats?.completionTokens ?? 0,
            ...(stats?.lastError !== undefined ? { lastError: stats.lastError } : {}),
          },
        });
      }
    }
    return { accounts };
  });

  app.post<{ Body: { provider?: string; raw?: string; path?: string } }>(
    '/api/subscription/import',
    async (req, reply) => {
      const body = req.body ?? {};
      if (!isSubscriptionProvider(body.provider)) {
        return reply.code(400).send({ error: `unknown provider: ${body.provider ?? ''}` });
      }
      const provider = body.provider;
      const rawPresent = typeof body.raw === 'string' && body.raw.length > 0;
      const pathPresent = typeof body.path === 'string' && body.path.trim().length > 0;
      if (rawPresent === pathPresent) {
        return reply.code(400).send({ error: 'exactly one of raw or path is required' });
      }

      let content: string;
      if (rawPresent) {
        content = body.raw as string;
      } else {
        const resolved = resolveImportPath(body.path as string);
        if (!resolved) {
          return reply
            .code(400)
            .send({ error: 'path must point inside ~/.codex, ~/.claude or ~/.gemini' });
        }
        try {
          content = await readFile(resolved, 'utf8');
        } catch (error) {
          return reply.code(400).send({ error: redactMessage(error) });
        }
      }

      const adapter = SUBSCRIPTION_ADAPTERS[provider];
      let parsed: ParsedSubscription;
      try {
        parsed = adapter.parseImport(content);
      } catch (error) {
        const message = redactMessage(error);
        if (message.includes('not implemented')) {
          return reply.code(501).send({ error: message });
        }
        return reply.code(400).send({ error: message });
      }

      const fields = profileFields(parsed.profile, parsed.payload);
      const id = adapter.accountIdOf(parsed.profile, parsed.payload);
      const label = fields.email ?? id;
      await getCredentialRuntime().upsertAccount(provider, {
        id,
        status: 'active',
        addedAt: Date.now(),
        label,
        payload: parsed.payload,
      });
      return reply.send({ ok: true, account: { provider, id, ...fields } });
    },
  );

  app.delete<{ Params: { provider: string; id: string } }>(
    '/api/subscription/accounts/:provider/:id',
    async (req, reply) => {
      const providerParam = req.params.provider;
      const id = req.params.id;
      if (!isSubscriptionProvider(providerParam)) {
        return reply.code(400).send({ error: `unknown provider: ${providerParam}` });
      }
      const provider = providerParam;
      const runtime = getCredentialRuntime();
      const pool = await runtime.getPool(provider);
      if (!pool.accounts.some((entry) => entry.id === id)) {
        return reply.code(404).send({ error: 'account not found' });
      }
      await runtime.removeAccount(provider, id);
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { provider: string; id: string } }>(
    '/api/subscription/accounts/:provider/:id/refresh',
    async (req, reply) => {
      const providerParam = req.params.provider;
      const id = req.params.id;
      if (!isSubscriptionProvider(providerParam)) {
        return reply.code(400).send({ error: `unknown provider: ${providerParam}` });
      }
      const provider = providerParam;
      const runtime = getCredentialRuntime();
      const pool = await runtime.getPool(provider);
      const account = pool.accounts.find((entry) => entry.id === id);
      if (!account) {
        return reply.code(404).send({ error: 'account not found' });
      }
      const adapter = SUBSCRIPTION_ADAPTERS[provider];
      try {
        const result = await adapter.refresh({
          refreshToken: account.payload.refreshToken ?? '',
          payload: account.payload,
        });
        const payload = result.payload;
        const fields = profileFields(result.profile, payload);
        await runtime.upsertAccount(provider, {
          ...account,
          status: 'active',
          payload,
          ...(fields.email ? { label: fields.email } : {}),
        });
        return reply.send({ ok: true, account: { provider, id, ...fields } });
      } catch (error) {
        if (error instanceof SubscriptionRefreshError && error.kind === 'fatal') {
          await runtime.upsertAccount(provider, { ...account, status: 'invalid' });
          return reply.code(400).send({ error: redactMessage(error) });
        }
        return reply.code(502).send({ error: redactMessage(error) });
      }
    },
  );
}
