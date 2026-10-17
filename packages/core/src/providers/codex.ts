import type { CredentialRuntime } from '../credentials/runtime.js';
import { getCredentialRuntime } from '../credentials/runtime.js';
import { redact } from '../credentials/redact.js';
import {
  REFRESH_SKEW_MS,
  SUBSCRIPTION_ADAPTERS,
  SubscriptionRefreshError,
  parseExpiryMs,
  runSharedFlight,
  subscriptionFlightKey,
} from '../credentials/adapters/subscription/index.js';
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
import { CODEX_CATALOG_MODELS } from './codex-catalog.js';
import { mergeToolCallDeltas } from './openai-like.js';

const CHAT_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** 参考实现 codex_executor_request.go 的伪装 UA/Originator（Codex CLI 风格）。 */
const CODEX_USER_AGENT =
  'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)';

const EMPTY_COOLDOWN_MS = 30_000;
const DETAIL_LIMIT = 300;

type FinishReason = ChatResponse['finish_reason'];

/**
 * 刷新结果：新 access token + 携带轮换后 payload 的账号条目。
 * 必须把账号一并回传，否则 401 重试拿到的是持有**已消费** refresh token 的旧对象，
 * 会再次发送旧 token（Codex 会回 refresh_token_reused → 永久废号）。
 */
interface RefreshedAccount {
  token: string;
  account: CredentialAccountEntry;
}

export type CodexErrorKind = 'rate_limit' | 'invalid' | 'fatal' | 'network' | 'empty';

export class CodexError extends Error {
  readonly kind: CodexErrorKind;
  readonly status?: number;
  readonly resetAt?: number;
  readonly platform = 'codex' as const;
  readonly accountId?: string;
  readonly model?: string;
  readonly phase?: 'refresh';

  constructor(
    message: string,
    options: {
      kind: CodexErrorKind;
      status?: number;
      resetAt?: number;
      accountId?: string;
      model?: string;
      phase?: 'refresh';
    },
  ) {
    super(redact(message));
    this.name = 'CodexError';
    this.kind = options.kind;
    this.status = options.status;
    this.resetAt = options.resetAt;
    this.accountId = options.accountId ? options.accountId.slice(0, 8) : undefined;
    this.model = options.model;
    this.phase = options.phase;
  }
}

/** 一次 SSE 事件解析出的帧。 */
interface SseFrame {
  id?: string;
  created?: number;
  delta: string;
  reasoning?: string;
  /** output_item.done 消息文本：无 delta 时的回退内容。 */
  itemText?: string;
  /** response.failed 携带的上游错误描述。 */
  errorDetail?: string;
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Responses usage → OpenAI Chat usage。 */
function normalizeUsage(value: unknown): ChatResponse['usage'] {
  const record = asRecord(value);
  if (!record) return undefined;
  const usage: NonNullable<ChatResponse['usage']> = {};
  const input = num(record.input_tokens);
  if (input !== undefined) usage.prompt_tokens = input;
  const output = num(record.output_tokens);
  if (output !== undefined) usage.completion_tokens = output;
  const total = num(record.total_tokens);
  if (total !== undefined) usage.total_tokens = total;
  const cached = num(asRecord(record.input_tokens_details)?.cached_tokens);
  if (cached !== undefined) usage.prompt_tokens_details = { cached_tokens: cached };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** 单条 output_item.done 消息里可提取的文本（无 delta 时的回退来源）。 */
function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  const content = item.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const raw of content) {
    const part = asRecord(raw);
    if (part && typeof part.text === 'string') out += part.text;
  }
  return out;
}

/**
 * 解析一帧 Responses SSE。事件名优先取 SSE `event:` 行，缺失时回退到
 * payload 的 `type` 字段（参考实现两种形式都接受）。
 */
function frameFromPayload(eventName: string, payload: Record<string, unknown>): SseFrame | null {
  const type = eventName || str(payload.type) || '';
  if (type === 'response.created') {
    const response = asRecord(payload.response);
    const frame: SseFrame = { delta: '' };
    const id = str(response?.id);
    const created = num(response?.created_at);
    if (id !== undefined) frame.id = id;
    if (created !== undefined) frame.created = created;
    return frame;
  }
  if (
    type === 'response.output_text.delta' ||
    type === 'response.reasoning_text.delta' ||
    type === 'response.reasoning_summary_text.delta'
  ) {
    const delta = str(payload.delta) ?? '';
    if (type === 'response.output_text.delta') return { delta };
    return { delta: '', reasoning: delta };
  }
  if (type === 'response.output_item.done') {
    const item = asRecord(payload.item);
    if (!item) return null;
    if (str(item.type) === 'function_call') {
      const index = num(payload.output_index) ?? 0;
      const frame: SseFrame = {
        delta: '',
        finish: 'tool_calls',
        toolCalls: [
          {
            index,
            type: 'function',
            ...(str(item.call_id) !== undefined ? { id: str(item.call_id) } : {}),
            function: {
              name: str(item.name) ?? '',
              ...(str(item.arguments) !== undefined ? { arguments: str(item.arguments) } : {}),
            },
          },
        ],
      };
      return frame;
    }
    const text = itemText(item);
    return { delta: '', ...(text ? { itemText: text } : {}) };
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = asRecord(payload.response);
    const frame: SseFrame = { delta: '', finish: 'stop' };
    const usage = normalizeUsage(response?.usage);
    if (usage) frame.usage = usage;
    return frame;
  }
  if (type === 'response.failed') {
    const response = asRecord(payload.response);
    const err = asRecord(response?.error);
    const message = str(err?.message) ?? 'upstream reported a failed response';
    return { delta: '', finish: 'content_filter', errorDetail: message };
  }
  return null;
}

/** 输入消息 → Responses `input` 数组；system 提升为顶层 instructions。 */
function translateMessages(messages: ChatRequest['messages']): {
  input: Array<Record<string, unknown>>;
  instructions?: string;
} {
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: message.content,
      });
      continue;
    }
    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id ?? '',
          name: call.function.name,
          arguments: call.function.arguments ?? '{}',
        });
      }
    }
    const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: message.content }];
    for (const part of message.contentParts ?? []) {
      if (part.type === 'image_url') {
        content.push({ type: 'input_image', image_url: part.image_url.url });
      } else {
        content.push({ type: 'input_text', text: part.text });
      }
    }
    input.push({ type: 'message', role: message.role, content });
  }
  return { input, ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}) };
}

/** 工具定义 → Responses 扁平 function 格式（function 字段上提）。 */
function translateTools(tools: NonNullable<ChatRequest['tools']>): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
  }));
}

/** 解析一个 SSE 块（`event:` + 若干 `data:` 行）。无 data 或坏 JSON → null。 */
function parseSseBlock(block: string): SseFrame | null {
  let eventName = '';
  const dataLines: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    if (raw.startsWith('event:')) eventName = raw.slice(6).trim();
    else if (raw.startsWith('data:')) dataLines.push(raw.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  return frameFromPayload(eventName, record);
}

export class CodexProvider extends BaseProvider {
  readonly id: ProviderId = 'codex';
  readonly displayName = 'Codex';

  override hasCredentials(): boolean {
    return this.runtime().hasActiveAccounts('codex');
  }

  async listModels(): Promise<ModelInfo[]> {
    return CODEX_CATALOG_MODELS.map((model) => ({
      id: `codex:${model.id}`,
      provider: 'codex' as const,
      displayName: model.displayName ?? model.id,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      free: true,
      subscription: true,
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
    let sawText = false;
    try {
      for await (const frame of this.parseSSE(response, accountId, req.model)) {
        if (frame.usage) usage = frame.usage;
        const finish = frame.finish ?? null;
        let delta = frame.delta;
        if (!delta && frame.itemText && !sawText) delta = frame.itemText;
        if (delta) sawText = true;
        const chunk: StreamChunk = {
          id: frame.id ?? `codex-${Date.now()}`,
          model: req.model,
          created: frame.created ?? Math.floor(Date.now() / 1000),
          delta,
          rawProtocol: 'openai',
          finish_reason: finish,
          ...(frame.reasoning !== undefined ? { reasoning: frame.reasoning } : {}),
          ...(frame.toolCalls ? { tool_calls: frame.toolCalls } : {}),
        };
        if (finish != null && usage) chunk.usage = usage;
        yield chunk;
      }
    } catch (error) {
      runtime.recordUsage('codex', accountId, req.model, {
        requests: 1,
        error: redact(errorText(error)),
      });
      throw error instanceof CodexError
        ? error
        : new CodexError(errorText(error), {
            kind: 'network',
            accountId,
            model: req.model,
          });
    }
    runtime.reportSuccess('codex', accountId);
    this.observeUsage(req.model, usage);
    runtime.recordUsage('codex', accountId, req.model, {
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
    const pool = await runtime.getPool('codex');
    const maxSwitches = Math.min(pool.accounts.length, 3);
    const tried = new Set<string>();
    let lastError: unknown = null;
    let invalidCount = 0;
    for (let step = 0; step <= maxSwitches; step += 1) {
      const account = runtime.nextAccount('codex', model);
      if (!account || tried.has(account.id)) break;
      tried.add(account.id);
      try {
        return await attempt(account, false);
      } catch (error) {
        const refreshPhase = error instanceof CodexError && error.phase === 'refresh';
        runtime.recordUsage('codex', account.id, model, {
          requests: refreshPhase ? 0 : 1,
          error: redact(errorText(error)),
        });
        lastError = error;
        if (error instanceof CodexError) {
          if (error.kind === 'fatal') throw error;
          if (error.kind === 'rate_limit') {
            runtime.reportRateLimit('codex', account.id, model, error.resetAt);
          } else if (error.kind === 'empty') {
            runtime.reportRateLimit('codex', account.id, model, Date.now() + EMPTY_COOLDOWN_MS);
          } else if (error.kind === 'invalid') {
            runtime.reportInvalid('codex', account.id);
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
      lastError instanceof CodexError &&
      lastError.kind === 'invalid' &&
      invalidCount > 0 &&
      invalidCount === triedCount
    ) {
      return new CodexError(
        `codex failed ${lastError.status ?? 401}: ${triedCount} 个账号凭据失效，请重新登录`,
        {
          kind: 'invalid',
          status: lastError.status ?? 401,
          accountId: lastError.accountId,
          model,
        },
      );
    }
    if (lastError instanceof CodexError) return lastError;
    if (lastError instanceof Error)
      return new CodexError(lastError.message, { kind: 'network', model });
    if (pool.accounts.length === 0) {
      return new CodexError('codex has no available credentials', { kind: 'fatal', model });
    }
    let earliest: number | undefined;
    let coolingAccountId: string | undefined;
    for (const account of pool.accounts) {
      const cooling = runtime
        .listAccountCooldowns('codex', account.id)
        .find((entry) => entry.model === model);
      if (cooling && (earliest === undefined || cooling.resetAt < earliest)) {
        earliest = cooling.resetAt;
        coolingAccountId = account.id;
      }
    }
    const iso = earliest ? `, reset at ${new Date(earliest).toISOString()}` : '';
    return new CodexError(
      `codex failed 429 rate limit: all ${pool.accounts.length} accounts are cooling for ${model}${iso}`,
      { kind: 'rate_limit', status: 429, resetAt: earliest, accountId: coolingAccountId, model },
    );
  }

  private async getAccessToken(
    account: CredentialAccountEntry,
    forceRefresh: boolean,
    model?: string,
  ): Promise<RefreshedAccount> {
    const cached = account.payload.accessToken;
    if (!forceRefresh && cached) {
      const expiry = parseExpiryMs(account.payload.expiresAt);
      if (Date.now() < expiry - REFRESH_SKEW_MS) return { token: cached, account };
    }
    return runSharedFlight(subscriptionFlightKey('codex', account.id), () =>
      this.refreshChain(account, model),
    );
  }

  private async refreshChain(
    account: CredentialAccountEntry,
    model?: string,
  ): Promise<RefreshedAccount> {
    const runtime = this.runtime();
    // 调用方可能拿着一个已陈旧的账号对象（401 重试路径传的是本次请求最初读到的副本），
    // 而另一个并发刷新可能已经把轮换后的 refresh token 落盘。用作废的 RT 再发一次会被上游
    // 判为 refresh_token_reused / invalid_grant，账号直接报废 —— 一律以运行时池的最新副本为准。
    const pooled = (await runtime.getPool('codex')).accounts.find((e) => e.id === account.id);
    account = pooled ?? account;
    let payload: Record<string, string>;
    try {
      const result = await SUBSCRIPTION_ADAPTERS.codex.refresh({
        fetchImpl: this.fetch,
        refreshToken: account.payload.refreshToken ?? '',
        payload: account.payload,
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof SubscriptionRefreshError) {
        if (error.kind === 'fatal') {
          runtime.reportInvalid('codex', account.id);
          throw new CodexError('codex refresh failed: 账号凭据失效，请重新登录', {
            kind: 'invalid',
            status: error.status ?? 400,
            accountId: account.id,
            model,
            phase: 'refresh',
          });
        }
        if (error.kind === 'rate_limit') {
          throw new CodexError('codex refresh failed 429: token refresh rate limited', {
            kind: 'rate_limit',
            status: 429,
            resetAt: error.resetAt,
            accountId: account.id,
            model,
            phase: 'refresh',
          });
        }
      }
      throw new CodexError(`codex refresh failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const accessToken = payload.accessToken;
    if (!accessToken) {
      throw new CodexError('codex refresh failed: upstream returned no access token', {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const refreshed: CredentialAccountEntry = { ...account, payload };
    await runtime.upsertAccount('codex', refreshed);
    return { token: accessToken, account: refreshed };
  }

  private buildHeaders(token: string, accountId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'chatgpt-account-id': accountId,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': CODEX_USER_AGENT,
      Originator: 'codex-tui',
    };
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const { input, instructions } = translateMessages(req.messages);
    const body: Record<string, unknown> = { model: req.model, input, stream: true };
    if (instructions !== undefined) body.instructions = instructions;
    if (req.tools?.length) body.tools = translateTools(req.tools);
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.max_tokens !== undefined) body.max_output_tokens = req.max_tokens;
    return body;
  }

  private async chatAttempt(
    account: CredentialAccountEntry,
    req: ChatRequest,
    forceRefresh: boolean,
  ): Promise<ChatResponse> {
    const runtime = this.runtime();
    const refreshed = await this.getAccessToken(account, forceRefresh, req.model);
    const token = refreshed.token;
    let response: Response;
    try {
      response = await this.fetch(CHAT_URL, {
        method: 'POST',
        headers: this.buildHeaders(token, account.payload.accountId ?? ''),
        body: JSON.stringify(this.buildBody(req)),
      });
    } catch (error) {
      throw new CodexError(`codex chat failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('chat', response, req.model, account.id);
    } catch (error) {
      if (error instanceof CodexError && error.status === 401 && !forceRefresh) {
        runtime.recordUsage('codex', account.id, req.model, {
          requests: 1,
          error: redact(errorText(error)),
        });
        return this.chatAttempt(refreshed.account, req, true);
      }
      throw error;
    }
    const chatResponse = await this.aggregateSSE(response, req.model, account.id);
    if (!chatResponse.content?.trim() && !chatResponse.tool_calls?.length) {
      throw new CodexError(`codex chat failed: upstream returned empty content for ${req.model}`, {
        kind: 'empty',
        accountId: account.id,
        model: req.model,
      });
    }
    runtime.reportSuccess('codex', account.id);
    this.observeUsage(req.model, chatResponse.usage);
    runtime.recordUsage('codex', account.id, req.model, {
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
    const refreshed = await this.getAccessToken(account, forceRefresh, req.model);
    const token = refreshed.token;
    let response: Response;
    try {
      response = await this.fetch(CHAT_URL, {
        method: 'POST',
        headers: this.buildHeaders(token, account.payload.accountId ?? ''),
        body: JSON.stringify(this.buildBody(req)),
      });
    } catch (error) {
      throw new CodexError(`codex stream failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('stream', response, req.model, account.id);
    } catch (error) {
      if (error instanceof CodexError && error.status === 401 && !forceRefresh) {
        this.runtime().recordUsage('codex', account.id, req.model, {
          requests: 1,
          error: redact(errorText(error)),
        });
        return this.openStream(refreshed.account, req, true);
      }
      throw error;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      await response.text().catch(() => '');
      throw new CodexError('codex stream failed: upstream did not return an event stream', {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    return response;
  }

  /**
   * 401 分支绝不读取/回显响应体：上游错误 JSON 可能回显 token 片段
   * （token-leak protection），detail 只在其余状态码下截取。
   */
  private async ensureHttpOk(
    op: 'chat' | 'stream',
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<void> {
    if (response.ok) return;
    const status = response.status;
    if (status === 401) {
      throw new CodexError(`codex ${op} failed 401: access token rejected`, {
        kind: 'invalid',
        status,
        accountId,
        model,
      });
    }
    if (status === 429) {
      const text = await response.text().catch(() => '');
      return this.throwRateLimit(op, response, text, model, accountId);
    }
    const detail = (await response.text().catch(() => '')).slice(0, DETAIL_LIMIT);
    if (status === 403) {
      throw new CodexError(`codex ${op} failed 403: ${detail}`, {
        kind: 'invalid',
        status,
        accountId,
        model,
      });
    }
    if (status >= 500) {
      throw new CodexError(`codex ${op} failed ${status}: ${detail}`, {
        kind: 'network',
        status,
        accountId,
        model,
      });
    }
    throw new CodexError(`codex ${op} failed ${status}: ${detail}`, {
      kind: 'fatal',
      status,
      accountId,
      model,
    });
  }

  private throwRateLimit(
    op: 'chat' | 'stream',
    response: Response,
    text: string,
    model: string,
    accountId?: string,
  ): never {
    const resetAt = this.parseRetryAfter(response);
    const iso = resetAt ? `; reset at ${new Date(resetAt).toISOString()}` : '';
    const detail = text ? `; detail ${text.slice(0, DETAIL_LIMIT)}` : '';
    throw new CodexError(`codex ${op} failed 429 rate limit on ${model}${detail}${iso}`, {
      kind: 'rate_limit',
      status: 429,
      resetAt,
      accountId,
      model,
    });
  }

  private parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) return undefined;
    const now = Date.now();
    const trimmed = header.trim();
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1_000;
    const date = Date.parse(trimmed);
    return Number.isFinite(date) && date > now ? date : undefined;
  }

  private async aggregateSSE(
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<ChatResponse> {
    let deltaText = '';
    let itemFallback = '';
    let reasoning = '';
    let finish: FinishReason = null;
    let usage: ChatResponse['usage'];
    let id: string | undefined;
    let created: number | undefined;
    let failure: string | undefined;
    const toolDeltas: ToolCallDelta[] = [];
    for await (const frame of this.parseSSE(response, accountId, model)) {
      if (!id && frame.id) id = frame.id;
      if (created === undefined && frame.created !== undefined) created = frame.created;
      deltaText += frame.delta;
      if (frame.reasoning) reasoning += frame.reasoning;
      if (frame.itemText) itemFallback = frame.itemText;
      if (frame.errorDetail) failure = frame.errorDetail;
      if (frame.toolCalls) toolDeltas.push(...frame.toolCalls);
      if (frame.finish) finish = frame.finish;
      if (frame.usage) usage = frame.usage;
    }
    if (failure) {
      throw new CodexError(`codex chat failed: upstream reported: ${failure}`, {
        kind: 'fatal',
        accountId,
        model,
      });
    }
    const toolCalls = mergeToolCallDeltas(toolDeltas);
    return {
      id: id ?? `codex-${Date.now()}`,
      model,
      created: created ?? Math.floor(Date.now() / 1000),
      content: deltaText || itemFallback,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : finish,
      rawProtocol: 'openai',
      ...(reasoning ? { reasoning } : {}),
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
      throw new CodexError('codex stream failed: upstream returned an empty body', {
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
        const frame = parseSseBlock(part);
        if (frame) yield frame;
      }
    }
    if (buffer.trim()) {
      const frame = parseSseBlock(buffer);
      if (frame) yield frame;
    }
  }
}
