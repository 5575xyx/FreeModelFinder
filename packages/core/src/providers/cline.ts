// Ported from cline-free (MIT), https://github.com/Patrick-mufeng/cline-free
import type { CredentialRuntime } from '../credentials/runtime.js';
import { getCredentialRuntime } from '../credentials/runtime.js';
import { redact } from '../credentials/redact.js';
import type {
  ChatRequest,
  ChatResponse,
  CredentialAccountEntry,
  ModelInfo,
  ProviderId,
  StreamChunk,
  ToolCallDelta,
} from '../types.js';
import { BaseProvider } from './base.js';
import type { ClineCatalogModel } from './cline-catalog.js';
import { listClineCatalogModels } from './cline-catalog.js';
import {
  mapFinishReason,
  mergeToolCallDeltas,
  parseToolCallDeltas,
  parseToolCalls,
} from './openai-like.js';
import { toOpenAIMessages } from './openai-messages.js';

const REFRESH_URL = 'https://api.cline.bot/api/v1/auth/refresh';
const CHAT_URL = 'https://api.cline.bot/api/v1/chat/completions';

const BUILTIN_MODELS = [
  'cline-free/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash',
  'z-ai/glm-5.3-flash',
  'poolside/laguna-s-2.1:free',
] as const;

const FORCE_STREAM_PREFIXES = ['deepseek/', 'cline-free/', 'cline-pass/'];

const REFRESH_SKEW_MS = 60_000;
const MAX_PARSED_COOLDOWN_MS = 24 * 3_600_000;
const EMPTY_COOLDOWN_MS = 30_000;

const CLINE_FINGERPRINT_HEADERS: Record<string, string> = {
  'User-Agent': 'Cline/3.0.47',
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
  'X-CLIENT-VERSION': '3.0.47',
  'X-PLATFORM': 'terminal',
  'X-PLATFORM-VERSION': '3.0.47',
  'X-CORE-VERSION': '0.0.66',
};

const DURATION_RE = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
const RESETS_AT_RE = /"resets_at"\s*:\s*"([^"]+)"/;
const FREE_LIMIT_MARKER = 'free limit reached on model';
const RETRY_IN_MARKER = 'try again in ';

type FinishReason = ChatResponse['finish_reason'];

export type ClineErrorKind = 'rate_limit' | 'invalid' | 'fatal' | 'network' | 'empty';

export class ClineError extends Error {
  readonly kind: ClineErrorKind;
  readonly status?: number;
  readonly resetAt?: number;
  readonly platform = 'cline' as const;
  readonly accountId?: string;
  readonly model?: string;
  readonly phase?: 'refresh';

  constructor(
    message: string,
    options: {
      kind: ClineErrorKind;
      status?: number;
      resetAt?: number;
      accountId?: string;
      model?: string;
      phase?: 'refresh';
    },
  ) {
    super(redact(message));
    this.name = 'ClineError';
    this.kind = options.kind;
    this.status = options.status;
    this.resetAt = options.resetAt;
    this.accountId = options.accountId ? options.accountId.slice(0, 8) : undefined;
    this.model = options.model;
    this.phase = options.phase;
  }
}

interface SseFrame {
  id?: string;
  created?: number;
  delta: string;
  finish?: FinishReason;
  toolCalls?: ToolCallDelta[];
  usage?: ChatResponse['usage'];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapUpstream(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const nested = asRecord(record.data);
  if (nested && Array.isArray(nested.choices)) return nested;
  return record;
}

function normalizeToolArguments(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!call || !fn) return raw;
    const args = fn.arguments;
    if (args !== null && typeof args === 'object') {
      return { ...call, function: { ...fn, arguments: JSON.stringify(args) } };
    }
    return raw;
  });
}

function messageToolCallDeltas(
  message: Record<string, unknown> | null,
): ToolCallDelta[] | undefined {
  if (!message) return undefined;
  const calls = parseToolCalls(normalizeToolArguments(message.tool_calls));
  if (!calls) return undefined;
  return calls.map((call, index) => ({
    index,
    type: 'function',
    ...(call.id === undefined ? {} : { id: call.id }),
    function: {
      name: call.function.name,
      ...(call.function.arguments === undefined ? {} : { arguments: call.function.arguments }),
    },
  }));
}

function normalizeUsage(value: unknown): ChatResponse['usage'] {
  const record = asRecord(value);
  if (!record) return undefined;
  const usage: NonNullable<ChatResponse['usage']> = {};
  if (typeof record.prompt_tokens === 'number') usage.prompt_tokens = record.prompt_tokens;
  if (typeof record.completion_tokens === 'number') {
    usage.completion_tokens = record.completion_tokens;
  }
  if (typeof record.total_tokens === 'number') usage.total_tokens = record.total_tokens;
  const details = asRecord(record.prompt_tokens_details);
  if (details && typeof details.cached_tokens === 'number') {
    usage.prompt_tokens_details = { cached_tokens: details.cached_tokens };
  }
  return usage;
}

function parseExpiryMs(raw: string | undefined, now = Date.now()): number {
  if (raw && raw.trim()) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now + 10 * 60 * 1000;
}

function parseDurationMs(tail: string): number {
  let total = 0;
  DURATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DURATION_RE.exec(tail)) !== null) {
    const count = Number(match[1]);
    if (!Number.isFinite(count) || count <= 0) continue;
    const unit = match[2] ?? '';
    if (unit.startsWith('h')) total += count * 3_600_000;
    else if (unit.startsWith('m')) total += count * 60_000;
    else total += count * 1_000;
  }
  return total;
}

function nextLocalMidnight(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0).getTime();
}

function framesFromText(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const data = unwrapUpstream(parsed);
    if (!data) continue;
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice = asRecord(choices[0]);
    if (!choice) continue;
    const delta = asRecord(choice.delta);
    const message = asRecord(choice.message);
    const source = delta ?? message ?? {};
    const content =
      typeof source.content === 'string' && source.content
        ? source.content
        : typeof source.reasoning === 'string'
          ? source.reasoning
          : '';
    const frame: SseFrame = { delta: content };
    const toolCalls = parseToolCallDeltas(delta?.tool_calls) ?? messageToolCallDeltas(message);
    if (toolCalls) frame.toolCalls = toolCalls;
    if (typeof parsed === 'object' && parsed !== null) {
      const envelope = parsed as Record<string, unknown>;
      if (typeof envelope.id === 'string') frame.id = envelope.id;
      if (typeof envelope.created === 'number') frame.created = envelope.created;
    }
    const finish = mapFinishReason(choice.finish_reason);
    if (finish) frame.finish = finish;
    const usage = normalizeUsage(data.usage);
    if (usage) frame.usage = usage;
    frames.push(frame);
  }
  return frames;
}

function dedupeById(models: ClineCatalogModel[]): ClineCatalogModel[] {
  const seen = new Set<string>();
  const merged: ClineCatalogModel[] = [];
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

export class ClineProvider extends BaseProvider {
  readonly id: ProviderId = 'cline';
  readonly displayName = 'Cline';

  private readonly refreshChains = new Map<string, Promise<string>>();
  private sessionSeq = 0;

  override hasCredentials(): boolean {
    return this.runtime().hasActiveAccounts('cline');
  }

  async listModels(): Promise<ModelInfo[]> {
    const dynamic = await listClineCatalogModels({
      dynamicModels: this.ctx.dynamicModels,
      fetchImpl: this.ctx.fetchImpl,
    });
    const merged = dedupeById([...(dynamic ?? []), ...BUILTIN_MODELS.map((id) => ({ id }))]);
    return merged.map((model): ModelInfo => ({
      id: `cline:${model.id}`,
      provider: 'cline',
      displayName: model.name ?? model.id,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      free: true,
      capabilities: ['text'],
    }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.withSwitches(req.model, (account, forceRefresh) =>
      this.chatAttempt(account, req, forceRefresh),
    );
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const runtime = this.runtime();
    const opened = await this.withSwitches(req.model, async (account, forceRefresh) => ({
      accountId: account.id,
      response: await this.openStream(account, req, forceRefresh),
    }));
    const { accountId, response } = opened;
    let usage: ChatResponse['usage'];
    try {
      for await (const frame of this.parseSSE(response, accountId, req.model)) {
        if (frame.usage) usage = frame.usage;
        yield {
          id: frame.id ?? `cline-${Date.now()}`,
          model: req.model,
          created: frame.created ?? Math.floor(Date.now() / 1000),
          delta: frame.delta,
          finish_reason: frame.finish ?? null,
          ...(frame.toolCalls ? { tool_calls: frame.toolCalls } : {}),
        };
      }
    } catch (error) {
      runtime.recordUsage('cline', accountId, req.model, {
        requests: 1,
        error: redact(errorText(error)),
      });
      throw error instanceof ClineError ? error : new Error(redact(errorText(error)));
    }
    runtime.reportSuccess('cline', accountId);
    this.observeUsage(req.model, usage);
    runtime.recordUsage('cline', accountId, req.model, {
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      requests: 1,
    });
  }

  private runtime(): CredentialRuntime {
    return this.ctx.credentialRuntime ?? getCredentialRuntime();
  }

  private async withSwitches<T>(
    model: string,
    attempt: (account: CredentialAccountEntry, forceRefresh: boolean) => Promise<T>,
  ): Promise<T> {
    const runtime = this.runtime();
    const pool = await runtime.getPool('cline');
    const maxSwitches = Math.min(pool.accounts.length, 3);
    const tried = new Set<string>();
    let lastError: unknown = null;
    let invalidCount = 0;
    for (let step = 0; step <= maxSwitches; step += 1) {
      const account = runtime.nextAccount('cline', model);
      if (!account || tried.has(account.id)) break;
      tried.add(account.id);
      try {
        return await attempt(account, false);
      } catch (error) {
        const refreshPhase = error instanceof ClineError && error.phase === 'refresh';
        runtime.recordUsage('cline', account.id, model, {
          requests: refreshPhase ? 0 : 1,
          error: redact(errorText(error)),
        });
        lastError = error;
        if (error instanceof ClineError) {
          if (error.kind === 'fatal') throw error;
          if (error.kind === 'rate_limit') {
            runtime.reportRateLimit('cline', account.id, model, error.resetAt);
          } else if (error.kind === 'empty') {
            runtime.reportRateLimit('cline', account.id, model, Date.now() + EMPTY_COOLDOWN_MS);
          } else if (error.kind === 'invalid') {
            runtime.reportInvalid('cline', account.id);
            invalidCount += 1;
          }
        }
      }
    }
    throw this.poolExhaustedError(model, lastError, tried.size, invalidCount, pool, runtime);
  }

  private poolExhaustedError(
    model: string,
    lastError: unknown,
    triedCount: number,
    invalidCount: number,
    pool: { accounts: CredentialAccountEntry[] },
    runtime: CredentialRuntime,
  ): Error {
    if (
      lastError instanceof ClineError &&
      lastError.kind === 'invalid' &&
      invalidCount > 0 &&
      invalidCount === triedCount
    ) {
      return new ClineError(
        `cline failed ${lastError.status ?? 401}: ${triedCount} 个账号凭据失效，请重新登录`,
        {
          kind: 'invalid',
          status: lastError.status ?? 401,
          accountId: lastError.accountId,
          model,
        },
      );
    }
    if (lastError instanceof ClineError) return lastError;
    if (lastError instanceof Error) return new Error(redact(lastError.message));
    if (pool.accounts.length === 0) {
      return new ClineError('cline has no available credentials', { kind: 'fatal', model });
    }
    let earliest: number | undefined;
    let coolingAccountId: string | undefined;
    for (const account of pool.accounts) {
      const cooling = runtime
        .listAccountCooldowns('cline', account.id)
        .find((entry) => entry.model === model);
      if (cooling && (earliest === undefined || cooling.resetAt < earliest)) {
        earliest = cooling.resetAt;
        coolingAccountId = account.id;
      }
    }
    const iso = earliest ? `, reset at ${new Date(earliest).toISOString()}` : '';
    return new ClineError(
      `cline failed 429 rate limit: all ${pool.accounts.length} accounts are cooling for ${model}${iso}`,
      { kind: 'rate_limit', status: 429, resetAt: earliest, accountId: coolingAccountId, model },
    );
  }

  private async getAccessToken(
    account: CredentialAccountEntry,
    forceRefresh: boolean,
    model?: string,
  ): Promise<string> {
    const cached = account.payload.accessToken;
    if (!forceRefresh && cached) {
      const expiry = parseExpiryMs(account.payload.expiresAt);
      if (Date.now() < expiry - REFRESH_SKEW_MS) return cached;
    }
    const inFlight = this.refreshChains.get(account.id);
    if (inFlight) return inFlight;
    const chain = this.refreshChain(account, model);
    this.refreshChains.set(account.id, chain);
    try {
      return await chain;
    } finally {
      if (this.refreshChains.get(account.id) === chain) this.refreshChains.delete(account.id);
    }
  }

  private async refreshChain(account: CredentialAccountEntry, model?: string): Promise<string> {
    const runtime = this.runtime();
    let response: Response;
    try {
      response = await this.fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: account.payload.refreshToken,
          grantType: 'refresh_token',
        }),
      });
    } catch (error) {
      throw new ClineError(`cline refresh failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    if (!response.ok) {
      const permanent = response.status === 401 || response.status === 403;
      if (permanent) {
        runtime.reportInvalid('cline', account.id);
        throw new ClineError(`cline refresh failed ${response.status}: 账号凭据失效，请重新登录`, {
          kind: 'invalid',
          status: response.status,
          accountId: account.id,
          model,
          phase: 'refresh',
        });
      }
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new ClineError(`cline refresh failed ${response.status}: ${detail}`, {
        kind: 'network',
        status: response.status,
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const parsed = await response.json().catch(() => null);
    const envelope = asRecord(parsed);
    const data = (envelope && (asRecord(envelope.data) ?? envelope)) ?? null;
    if (!data) {
      throw new ClineError('cline refresh failed: upstream returned an unexpected body', {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const accessToken = data.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new ClineError('cline refresh failed: upstream returned no access token', {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const payload: Record<string, string> = { ...account.payload, accessToken };
    const rotated = typeof data.refreshToken === 'string' ? data.refreshToken.trim() : '';
    if (rotated && rotated !== account.payload.refreshToken) payload.refreshToken = rotated;
    if (typeof data.expiresAt === 'string' || typeof data.expiresAt === 'number') {
      payload.expiresAt = String(data.expiresAt);
    }
    const userInfo = asRecord(data.userInfo);
    const email = userInfo && typeof userInfo.email === 'string' ? userInfo.email.trim() : '';
    if (email && !payload.email) payload.email = email;
    await runtime.upsertAccount('cline', { ...account, payload });
    return accessToken;
  }

  private nextSessionId(): string {
    this.sessionSeq += 1;
    return `sess_${Date.now()}_${this.sessionSeq}`;
  }

  private buildHeaders(sessionId: string, token: string): Record<string, string> {
    return {
      Authorization: `Bearer workos:${token}`,
      'Content-Type': 'application/json',
      ...CLINE_FINGERPRINT_HEADERS,
      'X-Task-ID': sessionId,
    };
  }

  private buildBody(
    req: ChatRequest,
    sessionId: string,
    sendStream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      session_id: sessionId,
      reasoning_effort: 'high',
      messages: toOpenAIMessages(req.messages),
    };
    if (sendStream) body.stream = true;
    if (req.tools?.length) body.tools = req.tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop !== undefined) body.stop = req.stop;
    return body;
  }

  private async chatAttempt(
    account: CredentialAccountEntry,
    req: ChatRequest,
    forceRefresh: boolean,
  ): Promise<ChatResponse> {
    const runtime = this.runtime();
    const token = await this.getAccessToken(account, forceRefresh, req.model);
    const sessionId = this.nextSessionId();
    const sendStream =
      req.stream === true || FORCE_STREAM_PREFIXES.some((prefix) => req.model.startsWith(prefix));
    const body = this.buildBody(req, sessionId, sendStream);
    let response: Response;
    try {
      response = await this.fetch(CHAT_URL, {
        method: 'POST',
        headers: this.buildHeaders(sessionId, token),
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ClineError(`cline chat failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('chat', response, req.model, account.id);
    } catch (error) {
      if (error instanceof ClineError && error.status === 401 && !forceRefresh) {
        runtime.recordUsage('cline', account.id, req.model, {
          requests: 1,
          error: redact(errorText(error)),
        });
        return this.chatAttempt(account, req, true);
      }
      throw error;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const chatResponse =
      sendStream || contentType.includes('text/event-stream')
        ? await this.aggregateSSE(response, req.model, account.id)
        : await this.parseJSONResponse(response, req.model, account.id);
    if (!chatResponse.content?.trim() && !chatResponse.tool_calls?.length) {
      throw new ClineError(`cline chat failed: upstream returned empty content for ${req.model}`, {
        kind: 'empty',
        accountId: account.id,
        model: req.model,
      });
    }
    runtime.reportSuccess('cline', account.id);
    this.observeUsage(req.model, chatResponse.usage);
    runtime.recordUsage('cline', account.id, req.model, {
      promptTokens: chatResponse.usage?.prompt_tokens,
      completionTokens: chatResponse.usage?.completion_tokens,
      requests: 1,
    });
    return chatResponse;
  }

  private async openStream(
    account: CredentialAccountEntry,
    req: ChatRequest,
    forceRefresh: boolean,
  ): Promise<Response> {
    const token = await this.getAccessToken(account, forceRefresh, req.model);
    const sessionId = this.nextSessionId();
    const body = this.buildBody(req, sessionId, true);
    let response: Response;
    try {
      response = await this.fetch(CHAT_URL, {
        method: 'POST',
        headers: this.buildHeaders(sessionId, token),
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ClineError(`cline stream failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('stream', response, req.model, account.id);
    } catch (error) {
      if (error instanceof ClineError && error.status === 401 && !forceRefresh) {
        this.runtime().recordUsage('cline', account.id, req.model, {
          requests: 1,
          error: redact(errorText(error)),
        });
        return this.openStream(account, req, true);
      }
      throw error;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      await response.text().catch(() => '');
      throw new ClineError('cline stream failed: upstream did not return an event stream', {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    return response;
  }

  private async ensureHttpOk(
    op: 'chat' | 'stream',
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<void> {
    if (response.ok) return;
    const status = response.status;
    if (status === 401) {
      throw new ClineError(`cline ${op} failed 401: access token rejected`, {
        kind: 'invalid',
        status,
        accountId,
        model,
      });
    }
    if (status === 429) {
      const text = await response.text().catch(() => '');
      throw this.rateLimitError(op, response, text, model, accountId);
    }
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    if (status === 403) {
      throw new ClineError(`cline ${op} failed 403: ${detail}`, {
        kind: 'invalid',
        status,
        accountId,
        model,
      });
    }
    if (status >= 500) {
      throw new ClineError(`cline ${op} failed ${status}: ${detail}`, {
        kind: 'network',
        status,
        accountId,
        model,
      });
    }
    throw new ClineError(`cline ${op} failed ${status}: ${detail}`, {
      kind: 'fatal',
      status,
      accountId,
      model,
    });
  }

  private rateLimitError(
    op: 'chat' | 'stream',
    response: Response,
    text: string,
    model: string,
    accountId?: string,
  ): ClineError {
    const resetAt = this.parseResetAt(response, text);
    const iso = resetAt ? `; reset at ${new Date(resetAt).toISOString()}` : '';
    const detail = text ? `; detail ${text.slice(0, 300)}` : '';
    return new ClineError(`cline ${op} failed 429 rate limit on ${model}${detail}${iso}`, {
      kind: 'rate_limit',
      status: 429,
      resetAt,
      accountId,
      model,
    });
  }

  private parseResetAt(response: Response, text: string): number | undefined {
    const now = Date.now();
    const header = response.headers.get('retry-after');
    if (header) {
      const trimmed = header.trim();
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds) && seconds > 0) {
        return this.clampReset(now + seconds * 1_000, now);
      }
      const date = Date.parse(trimmed);
      if (Number.isFinite(date) && date > now) return this.clampReset(date, now);
    }
    const field = text.match(RESETS_AT_RE);
    if (field?.[1]) {
      const ts = Date.parse(field[1]);
      if (Number.isFinite(ts) && ts > now) return this.clampReset(ts, now);
    }
    const lower = text.toLowerCase();
    const marker = lower.indexOf(RETRY_IN_MARKER);
    if (marker >= 0) {
      const duration = parseDurationMs(
        text.slice(marker + RETRY_IN_MARKER.length, marker + RETRY_IN_MARKER.length + 80),
      );
      if (duration > 0) return now + Math.min(duration, MAX_PARSED_COOLDOWN_MS);
    }
    if (lower.includes(FREE_LIMIT_MARKER)) return nextLocalMidnight(now);
    return undefined;
  }

  private clampReset(ts: number, now: number): number | undefined {
    if (ts <= now) return undefined;
    if (ts - now > MAX_PARSED_COOLDOWN_MS) return now + MAX_PARSED_COOLDOWN_MS;
    return ts;
  }

  private async parseJSONResponse(
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<ChatResponse> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ClineError('cline chat failed: upstream returned a non-JSON body', {
        kind: 'network',
        accountId,
        model,
      });
    }
    const data = unwrapUpstream(parsed);
    if (!data) {
      throw new ClineError('cline chat failed: upstream returned an unexpected body', {
        kind: 'network',
        accountId,
        model,
      });
    }
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = asRecord(choices[0]) ?? {};
    const message = asRecord(choice.message) ?? {};
    const rawContent = typeof message.content === 'string' ? message.content.trim() : '';
    const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
    const toolCalls = parseToolCalls(normalizeToolArguments(message.tool_calls));
    return {
      id: typeof data.id === 'string' ? data.id : `cline-${Date.now()}`,
      model,
      created: typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
      content: rawContent ? String(message.content) : reasoning,
      finish_reason: mapFinishReason(choice.finish_reason),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      usage: normalizeUsage(data.usage),
    };
  }

  private async aggregateSSE(
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<ChatResponse> {
    let content = '';
    let finish: FinishReason = null;
    let usage: ChatResponse['usage'];
    let id: string | undefined;
    let created: number | undefined;
    const toolDeltas: ToolCallDelta[] = [];
    for await (const frame of this.parseSSE(response, accountId, model)) {
      if (!id && frame.id) id = frame.id;
      if (created === undefined && frame.created !== undefined) created = frame.created;
      content += frame.delta;
      if (frame.toolCalls) toolDeltas.push(...frame.toolCalls);
      if (frame.finish) finish = frame.finish;
      if (frame.usage) usage = frame.usage;
    }
    const toolCalls = mergeToolCallDeltas(toolDeltas);
    return {
      id: id ?? `cline-${Date.now()}`,
      model,
      created: created ?? Math.floor(Date.now() / 1000),
      content,
      finish_reason: finish,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private async *parseSSE(
    response: Response,
    accountId?: string,
    model?: string,
  ): AsyncGenerator<SseFrame> {
    const body = response.body;
    if (!body) {
      throw new ClineError('cline stream failed: upstream returned an empty body', {
        kind: 'network',
        accountId,
        model,
      });
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const frame of framesFromText(part)) yield frame;
      }
    }
    if (buffer.trim()) {
      for (const frame of framesFromText(buffer)) yield frame;
    }
  }
}
