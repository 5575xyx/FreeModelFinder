import {
  createZenGateway,
  normalizeZenConfig,
  type ZenChatRequest,
  type ZenGateway,
  type ZenGatewayOptions,
  type ZenHttpClient,
  type ZenRoute,
} from '@freemodelfinder/zen';
import type { ChatRequest, ChatResponse, ModelInfo, ProviderId, StreamChunk } from '../types.js';
import { BaseProvider } from './base.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export class ZenProvider extends BaseProvider {
  readonly id: ProviderId = 'opencode';
  readonly displayName = 'OpenCode Zen';

  private gateway: ZenGateway | undefined;
  private refreshed = false;

  override hasCredentials(): boolean {
    const extra = asRecord(this.ctx.credentials?.extra);
    if (extra?.anonymous === true) return true;
    if (this.zenKeys().length > 0) return true;
    return stringKeys(extra?.goKeys).length > 0;
  }

  private zenKeys(): string[] {
    const cred = this.ctx.credentials;
    const keys = (cred?.apiKeys ?? []).filter((key) => !!key?.trim());
    if (keys.length === 0 && cred?.apiKey?.trim()) keys.push(cred.apiKey.trim());
    return keys;
  }

  private config() {
    const extra = asRecord(this.ctx.credentials?.extra) ?? {};
    return normalizeZenConfig({
      anonymous: extra.anonymous,
      zenKeys: this.zenKeys(),
      goKeys: extra.goKeys,
      prefer: extra.prefer,
      upstream: extra.upstream,
      proxies: extra.proxies,
      proxyfile: extra.proxyfile,
      retry: extra.retry,
      performance: extra.performance,
      models: extra.models,
      reasoning: extra.reasoning,
    });
  }

  private gatewayInstance(): ZenGateway {
    if (!this.gateway) {
      const extra = asRecord(this.ctx.credentials?.extra) ?? {};
      const options: ZenGatewayOptions = { config: this.config() };
      if (this.ctx.fetchImpl) options.fetchImpl = this.ctx.fetchImpl;
      const httpClient = extra.httpClient as ZenHttpClient | undefined;
      if (httpClient) options.httpClient = httpClient;
      this.gateway = createZenGateway(options);
    }
    return this.gateway;
  }

  private async ensureRefreshed(gateway: ZenGateway): Promise<void> {
    if (this.refreshed) return;
    await gateway.refresh().catch(() => undefined);
    this.refreshed = true;
  }

  private routeFlags(): { hasZen: boolean; hasGo: boolean; hasAnonymous: boolean } {
    const extra = asRecord(this.ctx.credentials?.extra) ?? {};
    return {
      hasZen: this.zenKeys().length > 0,
      hasGo: stringKeys(extra.goKeys).length > 0,
      hasAnonymous: extra.anonymous === true,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const gateway = this.gatewayInstance();
    await gateway.refresh().catch(() => undefined);
    this.refreshed = true;
    const { hasZen, hasGo, hasAnonymous } = this.routeFlags();
    let routes: ZenRoute[];
    try {
      routes = gateway.listRoutes(hasZen, hasGo, hasAnonymous);
    } catch {
      return [];
    }
    const free = this.freeRouteIds(gateway, hasZen, hasGo);
    return routes.map((route): ModelInfo => {
      const isFree = free === undefined ? /free/i.test(route.id) : free.has(route.id);
      return {
        id: `opencode:${route.id}`,
        provider: 'opencode',
        displayName: route.id,
        free: isFree,
        capabilities: ['text'],
      };
    });
  }

  /**
   * The gateway exposes anonymous-eligibility only through `listRoutes`, which
   * reports `anonymous: true` exactly when the catalog deems a model free
   * (name contains "free" or models.dev lists zero input/output cost). Listing
   * with the anonymous flag forced reveals that free set without a zen change.
   */
  private freeRouteIds(
    gateway: ZenGateway,
    hasZen: boolean,
    hasGo: boolean,
  ): Set<string> | undefined {
    try {
      const free = new Set<string>();
      for (const route of gateway.listRoutes(hasZen, hasGo, true)) {
        if (route.anonymous) free.add(route.id);
      }
      return free;
    } catch {
      return undefined;
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const gateway = this.gatewayInstance();
    await this.ensureRefreshed(gateway);
    const response = await gateway.chat(req as unknown as ZenChatRequest);
    this.observeUsage(req.model, response.usage);
    return response;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const gateway = this.gatewayInstance();
    await this.ensureRefreshed(gateway);
    for await (const chunk of gateway.stream(req as unknown as ZenChatRequest)) {
      yield chunk;
    }
  }
}
