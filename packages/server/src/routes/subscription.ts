import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  SUBSCRIPTION_ADAPTERS,
  SubscriptionRefreshError,
  getCredentialRuntime,
  redact,
  runSharedFlight,
  subscriptionFlightKey,
  updateConfig,
  type ParsedSubscription,
  type SubscriptionAccountProfile,
} from '@freemodelfinder/core';

export const SUBSCRIPTION_PROVIDERS = ['codex', 'claude', 'google'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

/** 瀵煎叆鏂囦欢鍙厑璁歌惤鍦ㄨ繖浜?`~/.<dir>` 鐧藉悕鍗曠洰褰曞唴锛岄槻姝换鎰忔枃浠惰銆?*/
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
 * 鎶?`~/...` 褰㈠紡瑙ｆ瀽涓虹粷瀵硅矾寰勶紝骞跺己鍒跺叾钀藉湪 `~/.codex`銆乣~/.claude`銆乣~/.gemini`
 * 涓夎€呬箣涓€鍐呫€備换浣曠┛瓒婏紙`../`锛夋垨钀藉湪鐧藉悕鍗曞鐨勮矾寰勯兘杩斿洖 null锛堣皟鐢ㄦ柟鍥?400锛夈€?
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
      // getProvider 的第一道闸门是 config.providers.<id>.enabled，而三家订阅 provider 在
      // store.ts 里默认关闭、设置页也不含它们的开关。不在这儿启用的话，"导入成功"之后
      // /v1/models 不列出订阅模型、auto 选不到、显式 codex:… 一律抛 "provider codex is not
      // enabled" —— 整个功能等于没接上。
      // 先启用再落账号：listEnabledProviders 会用 hasCredentials() 过滤，尚无账号的 provider
      // 不会往 /v1/models 里塞用不了的模型，所以这个顺序没有副作用窗口。
      await updateConfig((cfg) => {
        const current = cfg.providers[provider] ?? { enabled: false };
        cfg.providers[provider] = { ...current, enabled: true };
        return cfg;
      });
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
      if (!pool.accounts.some((entry) => entry.id === id)) {
        return reply.code(404).send({ error: 'account not found' });
      }
      const adapter = SUBSCRIPTION_ADAPTERS[provider];
      try {
        // 手动刷新必须与 provider 内部的自动刷新共用同一把单飞锁：Codex 等轮换型 OAuth 下，
        // 用户点"刷新"的瞬间若恰有一次请求触发了后台刷新，同一个 refresh_token 会被发两次，
        // 上游判为 refresh_token_reused / invalid_grant，账号直接报废。
        const fields = await runSharedFlight(subscriptionFlightKey(provider, id), async () => {
          // 单飞只对**在途**刷新去重，settled 后立即剔除；因此锁内必须重读运行时池，
          // 否则用的是进入路由时读到的、可能已被另一次刷新消费掉的 refresh token。
          const fresh = (await runtime.getPool(provider)).accounts.find((e) => e.id === id);
          if (!fresh) return null;
          const result = await adapter.refresh({
            refreshToken: fresh.payload.refreshToken ?? '',
            payload: fresh.payload,
          });
          const next = profileFields(result.profile, result.payload);
          await runtime.upsertAccount(provider, {
            ...fresh,
            status: 'active',
            payload: result.payload,
            ...(next.email ? { label: next.email } : {}),
          });
          return next;
        });
        if (!fields) {
          return reply.code(404).send({ error: 'account not found' });
        }
        return reply.send({ ok: true, account: { provider, id, ...fields } });
      } catch (error) {
        if (error instanceof SubscriptionRefreshError && error.kind === 'fatal') {
          // 同样要重读后写回：拿陈旧对象 spread 会把已轮换掉的 payload 一并写回去。
          const fresh = (await runtime.getPool(provider)).accounts.find((e) => e.id === id);
          if (fresh) {
            await runtime.upsertAccount(provider, { ...fresh, status: 'invalid' });
          }
          return reply.code(400).send({ error: redactMessage(error) });
        }
        return reply.code(502).send({ error: redactMessage(error) });
      }
    },
  );
}
