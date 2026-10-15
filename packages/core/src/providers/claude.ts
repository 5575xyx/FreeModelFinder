import type { CredentialRuntime } from '../credentials/runtime.js';
import { getCredentialRuntime } from '../credentials/runtime.js';
import { redact } from '../credentials/redact.js';
import {
  REFRESH_SKEW_MS,
  SUBSCRIPTION_ADAPTERS,
  SubscriptionRefreshError,
  createFlightCache,
  parseExpiryMs,
} from '../credentials/adapters/subscription/index.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CredentialAccountEntry,
  ModelInfo,
  ProviderId,
  StreamChunk,
  ToolCall,
  ToolCallDelta,
} from '../types.js';
import { BaseProvider } from './base.js';
import { CLAUDE_CATALOG_MODELS, DEFAULT_MAX_TOKENS } from './claude-catalog.js';
import { mergeToolCallDeltas } from './openai-like.js';

/** OAuth 订阅凭据走 Messages API（Bearer）；API key 模式不在本 provider 范围内。 */
const CHAT_URL = 'https://api.anthropic.com/v1/messages';

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
/**
 * CLI 指纹伪装 UA（参考 helps.ClaudeDeviceProfile 默认值 /
 * claude_executor_native_helper_test.go:33）：Anthropic 控制面对普通 Node fetch UA
 * 更严格，与 codex provider 伪装 UA 的动机一致。
 */
const CLAUDE_USER_AGENT = 'claude-cli/2.1.280 (external, cli)';

const EMPTY_COOLDOWN_MS = 30_000;
const DETAIL_LIMIT = 300;

type FinishReason = ChatResponse['finish_reason'];

export type ClaudeErrorKind = 'rate_limit' | 'invalid' | 'fatal' | 'network' | 'empty';

export class ClaudeError extends Error {
  readonly kind: ClaudeErrorKind;
  readonly status?: number;
  readonly resetAt?: number;
  readonly platform = 'claude' as const;
  readonly accountId?: string;
  readonly model?: string;
  readonly phase?: 'refresh';

  constructor(
    message: string,
    options: {
      kind: ClaudeErrorKind;
      status?: number;
      resetAt?: number;
      accountId?: string;
      model?: string;
      phase?: 'refresh';
    },
  ) {
    super(redact(message));
    this.name = 'ClaudeError';
    this.kind = options.kind;
    this.status = options.status;
    this.resetAt = options.resetAt;
    this.accountId = options.accountId ? options.accountId.slice(0, 8) : undefined;
    this.model = options.model;
    this.phase = options.phase;
  }
}

/** 一次 SSE 事件解析出的帧。usage 拆成字段，便于跨帧（start→delta）累加。 */
interface SseFrame {
  id?: string;
  delta: string;
  reasoning?: string;
  finish?: FinishReason;
  toolCalls?: ToolCallDelta[];
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** `error` 事件携带的上游错误描述。 */
  errorDetail?: string;
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

/** Anthropic prompt/completion → OpenAI Chat usage，total 由两者相加。 */
function computeUsage(
  promptTokens?: number,
  completionTokens?: number,
  cachedTokens?: number,
): ChatResponse['usage'] {
  const usage: NonNullable<ChatResponse['usage']> = {};
  if (promptTokens !== undefined) usage.prompt_tokens = promptTokens;
  if (completionTokens !== undefined) usage.completion_tokens = completionTokens;
  if (promptTokens !== undefined && completionTokens !== undefined) {
    usage.total_tokens = promptTokens + completionTokens;
  }
  if (cachedTokens !== undefined) {
    usage.prompt_tokens_details = { cached_tokens: cachedTokens };
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Anthropic stop_reason → OpenAI finish_reason（参考 mapAnthropicStopReasonToOpenAI）。 */
function mapStopReason(value: unknown): FinishReason {
  switch (str(value)) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
    case 'sensitive':
      return 'content_filter';
    default:
      return null;
  }
}

/** tool_use 的 input 在内部表示为 JSON 字符串，Anthropic 需要对象。 */
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

/** OpenAI image_url → Anthropic image block（data URL → base64，其余 → url）。 */
function imageBlock(url: string): Record<string, unknown> {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  const mediaType = dataUrl?.[1];
  const data = dataUrl?.[2];
  if (mediaType !== undefined && data !== undefined) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function contentOf(message: ChatMessage): string | Array<Record<string, unknown>> {
  const parts = message.contentParts ?? [];
  if (!parts.some((part) => part.type === 'image_url')) return message.content;
  return parts.map((part) =>
    part.type === 'text' ? { type: 'text', text: part.text } : imageBlock(part.image_url.url),
  );
}

/** 输入消息 → Anthropic `messages` 数组 + 顶层 `system` 字符串。 */
function toAnthropicMessages(messages: ChatMessage[]): {
  messages: Array<Record<string, unknown>>;
  system?: string;
} {
  const out: Array<Record<string, unknown>> = [];
  const systemParts: string[] = [];
  let toolResults: Array<Record<string, unknown>> = [];
  const flushToolResults = (): void => {
    if (toolResults.length === 0) return;
    out.push({ role: 'user', content: toolResults });
    toolResults = [];
  };
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: message.content,
      });
      continue;
    }
    flushToolResults();
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: call.id ?? `toolu_${blocks.length}`,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: message.role, content: contentOf(message) });
  }
  flushToolResults();
  return { messages: out, ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}) };
}

/** OpenAI tools → Anthropic tools（`function` 上提、parameters → input_schema）。 */
function translateTools(tools: NonNullable<ChatRequest['tools']>): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const schema = tool.function.parameters;
    return {
      name: tool.function.name,
      ...(tool.function.description !== undefined
        ? { description: tool.function.description }
        : {}),
      input_schema:
        schema !== undefined && Object.keys(schema).length > 0
          ? schema
          : { type: 'object', properties: {} },
    };
  });
}

/**
 * 解析一帧 Messages SSE。事件名取自 payload 的 `type`（参考实现以 body 为准）。
 * tool_use 的 content-block index 与 OpenAI 的 tool-call index 不是一回事，这里
 * 用 `toolIndex` 把连续出现的块映射为 0,1,2…。
 */
function frameFromPayload(
  payload: Record<string, unknown>,
  toolIndex: Map<number, number>,
): SseFrame | null {
  const type = str(payload.type) ?? '';
  if (type === 'message_start') {
    const message = asRecord(payload.message);
    const usage = asRecord(message?.usage);
    return {
      delta: '',
      id: str(message?.id),
      promptTokens: num(usage?.input_tokens),
      cachedTokens: num(usage?.cache_read_input_tokens),
    };
  }
  if (type === 'content_block_start') {
    const block = asRecord(payload.content_block);
    if (str(block?.type) === 'tool_use') {
      const blockIndex = num(payload.index) ?? 0;
      const index = toolIndex.size;
      toolIndex.set(blockIndex, index);
      const id = str(block?.id);
      return {
        delta: '',
        toolCalls: [
          {
            index,
            type: 'function',
            ...(id !== undefined ? { id } : {}),
            function: { name: str(block?.name) ?? '' },
          },
        ],
      };
    }
    return null;
  }
  if (type === 'content_block_delta') {
    const delta = asRecord(payload.delta);
    const deltaType = str(delta?.type);
    if (deltaType === 'text_delta') return { delta: str(delta?.text) ?? '' };
    if (deltaType === 'thinking_delta') {
      return { delta: '', reasoning: str(delta?.thinking) ?? '' };
    }
    if (deltaType === 'input_json_delta') {
      const blockIndex = num(payload.index) ?? 0;
      const index = toolIndex.get(blockIndex) ?? 0;
      return {
        delta: '',
        toolCalls: [
          {
            index,
            type: 'function',
            function: { arguments: str(delta?.partial_json) ?? '' },
          },
        ],
      };
    }
    return null;
  }
  if (type === 'message_delta') {
    const delta = asRecord(payload.delta);
    const usage = asRecord(payload.usage);
    return {
      delta: '',
      finish: mapStopReason(delta?.stop_reason),
      completionTokens: num(usage?.output_tokens),
    };
  }
  if (type === 'error') {
    const error = asRecord(payload.error);
    return {
      delta: '',
      finish: 'content_filter',
      errorDetail: str(error?.message) ?? 'upstream reported an error',
    };
  }
  return null;
}

/** 解析一个 SSE 块（`event:` + `data:` 行）。无 data 或坏 JSON → null。 */
function parseSseBlock(block: string, toolIndex: Map<number, number>): SseFrame | null {
  const dataLines: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    if (raw.startsWith('data:')) dataLines.push(raw.slice(5).trim());
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
  return frameFromPayload(record, toolIndex);
}

export class ClaudeProvider extends BaseProvider {
  readonly id: ProviderId = 'claude';
  readonly displayName = 'Claude';

  private readonly refreshFlights = createFlightCache<string>();

  override hasCredentials(): boolean {
    return this.runtime().hasActiveAccounts('claude');
  }

  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_CATALOG_MODELS.map((model) => ({
      id: `claude:${model.id}`,
      provider: 'claude' as const,
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
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let cachedTokens: number | undefined;
    let responseId: string | undefined;
    try {
      for await (const frame of this.parseSSE(response, accountId, req.model)) {
        if (!responseId && frame.id) responseId = frame.id;
        if (frame.promptTokens !== undefined) promptTokens = frame.promptTokens;
        if (frame.completionTokens !== undefined) completionTokens = frame.completionTokens;
        if (frame.cachedTokens !== undefined) cachedTokens = frame.cachedTokens;
        const finish = frame.finish ?? null;
        const chunk: StreamChunk = {
          id: frame.id ?? responseId ?? `claude-${Date.now()}`,
          model: req.model,
          created: Math.floor(Date.now() / 1000),
          delta: frame.delta,
          rawProtocol: 'anthropic',
          finish_reason: finish,
          ...(frame.reasoning !== undefined ? { reasoning: frame.reasoning } : {}),
          ...(frame.toolCalls ? { tool_calls: frame.toolCalls } : {}),
        };
        if (finish != null) {
          const usage = computeUsage(promptTokens, completionTokens, cachedTokens);
          if (usage) chunk.usage = usage;
        }
        yield chunk;
      }
    } catch (error) {
      runtime.recordUsage('claude', accountId, req.model, {
        requests: 1,
        error: redact(errorText(error)),
      });
      throw error instanceof ClaudeError
        ? error
        : new ClaudeError(errorText(error), { kind: 'network', accountId, model: req.model });
    }
    const usage = computeUsage(promptTokens, completionTokens, cachedTokens);
    runtime.reportSuccess('claude', accountId);
    this.observeUsage(req.model, usage);
    runtime.recordUsage('claude', accountId, req.model, {
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
    const pool = await runtime.getPool('claude');
    const maxSwitches = Math.min(pool.accounts.length, 3);
    const tried = new Set<string>();
    let lastError: unknown = null;
    let invalidCount = 0;
    for (let step = 0; step <= maxSwitches; step += 1) {
      const account = runtime.nextAccount('claude', model);
      if (!account || tried.has(account.id)) break;
      tried.add(account.id);
      try {
        return await attempt(account, false);
      } catch (error) {
        const refreshPhase = error instanceof ClaudeError && error.phase === 'refresh';
        runtime.recordUsage('claude', account.id, model, {
          requests: refreshPhase ? 0 : 1,
          error: redact(errorText(error)),
        });
        lastError = error;
        if (error instanceof ClaudeError) {
          if (error.kind === 'fatal') throw error;
          if (error.kind === 'rate_limit') {
            runtime.reportRateLimit('claude', account.id, model, error.resetAt);
          } else if (error.kind === 'empty') {
            runtime.reportRateLimit('claude', account.id, model, Date.now() + EMPTY_COOLDOWN_MS);
          } else if (error.kind === 'invalid') {
            runtime.reportInvalid('claude', account.id);
            invalidCount += 1;
          }
          // kind === 'network'：本次账号失败但不失效——不冷却、不标记 invalid，
          // 由上面的 tried 集合保证本轮不再选中它，直接切换下一个账号。
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
      lastError instanceof ClaudeError &&
      lastError.kind === 'invalid' &&
      invalidCount > 0 &&
      invalidCount === triedCount
    ) {
      return new ClaudeError(
        `claude failed ${lastError.status ?? 401}: ${triedCount} 个账号凭据失效，请重新登录`,
        {
          kind: 'invalid',
          status: lastError.status ?? 401,
          accountId: lastError.accountId,
          model,
        },
      );
    }
    if (lastError instanceof ClaudeError) return lastError;
    if (lastError instanceof Error)
      return new ClaudeError(lastError.message, { kind: 'network', model });
    if (pool.accounts.length === 0) {
      return new ClaudeError('claude has no available credentials', { kind: 'fatal', model });
    }
    let earliest: number | undefined;
    let coolingAccountId: string | undefined;
    for (const account of pool.accounts) {
      const cooling = runtime
        .listAccountCooldowns('claude', account.id)
        .find((entry) => entry.model === model);
      if (cooling && (earliest === undefined || cooling.resetAt < earliest)) {
        earliest = cooling.resetAt;
        coolingAccountId = account.id;
      }
    }
    const iso = earliest ? `, reset at ${new Date(earliest).toISOString()}` : '';
    return new ClaudeError(
      `claude failed 429 rate limit: all ${pool.accounts.length} accounts are cooling for ${model}${iso}`,
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
    return this.refreshFlights.run(account.id, () => this.refreshChain(account, model));
  }

  /**
   * 刷新一次，绝不原地重试。
   *
   * Claude 的 refresh token 是**单次性**的：一次网络失败后，Anthropic 可能已经消费掉
   * 那个 token，只是响应在回程丢失。此时再用同一个 token 重试，会把一次瞬时网络故障
   * 放大成永久的 invalid_grant（参考 `isClaudeRefreshRetryable` 的注释：只有明确的
   * 可重试 HTTP 响应才能安全重放，transport/解码错误一律不重放）。因此 network 刷新
   * 失败只作为「该账号本次失败」向上抛出，由 `withSwitches` 切换账号或直接失败。
   */
  private async refreshChain(account: CredentialAccountEntry, model?: string): Promise<string> {
    const runtime = this.runtime();
    let payload: Record<string, string>;
    try {
      const result = await SUBSCRIPTION_ADAPTERS.claude.refresh({
        fetchImpl: this.fetch,
        refreshToken: account.payload.refreshToken ?? '',
        payload: account.payload,
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof SubscriptionRefreshError) {
        if (error.kind === 'fatal') {
          runtime.reportInvalid('claude', account.id);
          throw new ClaudeError('claude refresh failed: 账号凭据失效，请重新登录', {
            kind: 'invalid',
            status: error.status ?? 400,
            accountId: account.id,
            model,
            phase: 'refresh',
          });
        }
        if (error.kind === 'rate_limit') {
          throw new ClaudeError('claude refresh failed 429: token refresh rate limited', {
            kind: 'rate_limit',
            status: 429,
            resetAt: error.resetAt,
            accountId: account.id,
            model,
            phase: 'refresh',
          });
        }
      }
      throw new ClaudeError(`claude refresh failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const accessToken = payload.accessToken;
    if (!accessToken) {
      throw new ClaudeError('claude refresh failed: upstream returned no access token', {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    await runtime.upsertAccount('claude', { ...account, payload });
    return accessToken;
  }

  private buildHeaders(token: string, stream: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_OAUTH_BETA,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'User-Agent': CLAUDE_USER_AGENT,
    };
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const { messages, system } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      // Messages 协议要求 max_tokens 必填；请求未给出时用目录默认值。
      max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream,
    };
    if (system !== undefined) body.system = system;
    if (req.tools?.length) body.tools = translateTools(req.tools);
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop !== undefined) {
      body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    }
    return body;
  }

  private async chatAttempt(
    account: CredentialAccountEntry,
    req: ChatRequest,
    forceRefresh: boolean,
  ): Promise<ChatResponse> {
    const runtime = this.runtime();
    const streaming = req.stream === true;
    const token = await this.getAccessToken(account, forceRefresh, req.model);
    let response: Response;
    try {
      response = await this.fetch(CHAT_URL, {
        method: 'POST',
        headers: this.buildHeaders(token, streaming),
        body: JSON.stringify(this.buildBody(req, streaming)),
      });
    } catch (error) {
      throw new ClaudeError(`claude chat failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('chat', response, req.model, account.id);
    } catch (error) {
      if (error instanceof ClaudeError && error.status === 401 && !forceRefresh) {
        runtime.recordUsage('claude', account.id, req.model, {
          requests: 1,
          error: redact(errorText(error)),
        });
        return this.chatAttempt(account, req, true);
      }
      throw error;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const chatResponse =
      streaming || contentType.includes('text/event-stream')
        ? await this.aggregateSSE(response, req.model, account.id)
        : await this.parseJsonResponse(response, req.model, account.id);
    if (!chatResponse.content?.trim() && !chatResponse.tool_calls?.length) {
      throw new ClaudeError(
        `claude chat failed: upstream returned empty content for ${req.model}`,
        {
          kind: 'empty',
          accountId: account.id,
          model: req.model,
        },
      );
    }
    runtime.reportSuccess('claude', account.id);
    this.observeUsage(req.model, chatResponse.usage);
    runtime.recordUsage('claude', account.id, req.model, {
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
    let response: Response;
    try {
      response = await this.fetch(CHAT_URL, {
        method: 'POST',
        headers: this.buildHeaders(token, true),
        body: JSON.stringify(this.buildBody(req, true)),
      });
    } catch (error) {
      throw new ClaudeError(`claude stream failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('stream', response, req.model, account.id);
    } catch (error) {
      if (error instanceof ClaudeError && error.status === 401 && !forceRefresh) {
        this.runtime().recordUsage('claude', account.id, req.model, {
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
      throw new ClaudeError('claude stream failed: upstream did not return an event stream', {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    return response;
  }

  /** 401/403 分支绝不读取/回显响应体：上游错误 JSON 可能回显 token 片段（防泄漏）。 */
  private async ensureHttpOk(
    op: 'chat' | 'stream',
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<void> {
    if (response.ok) return;
    const status = response.status;
    if (status === 401) {
      throw new ClaudeError(`claude ${op} failed 401: access token rejected`, {
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
      throw new ClaudeError(`claude ${op} failed 403: ${detail}`, {
        kind: 'invalid',
        status,
        accountId,
        model,
      });
    }
    if (status >= 500) {
      throw new ClaudeError(`claude ${op} failed ${status}: ${detail}`, {
        kind: 'network',
        status,
        accountId,
        model,
      });
    }
    throw new ClaudeError(`claude ${op} failed ${status}: ${detail}`, {
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
    throw new ClaudeError(`claude ${op} failed 429 rate limit on ${model}${detail}${iso}`, {
      kind: 'rate_limit',
      status: 429,
      resetAt,
      accountId,
      model,
    });
  }

  private parseRetryAfter(response: Response): number | undefined {
    const now = Date.now();
    const header = response.headers.get('retry-after');
    if (header) {
      const trimmed = header.trim();
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1_000;
      const date = Date.parse(trimmed);
      if (Number.isFinite(date) && date > now) return date;
    }
    const ms = response.headers.get('retry-after-ms');
    if (ms) {
      const value = Number(ms.trim());
      if (Number.isFinite(value) && value > 0) return now + value;
    }
    return undefined;
  }

  private async parseJsonResponse(
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<ChatResponse> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ClaudeError('claude chat failed: upstream returned a non-JSON body', {
        kind: 'network',
        accountId,
        model,
      });
    }
    const data = asRecord(parsed);
    if (!data) {
      throw new ClaudeError('claude chat failed: upstream returned an unexpected body', {
        kind: 'network',
        accountId,
        model,
      });
    }
    let content = '';
    const toolCalls: ToolCall[] = [];
    const blocks = Array.isArray(data.content) ? data.content : [];
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (!block) continue;
      if (str(block.type) === 'text') {
        content += str(block.text) ?? '';
      } else if (str(block.type) === 'tool_use') {
        toolCalls.push({
          id: str(block.id) ?? `call_${toolCalls.length}`,
          type: 'function',
          function: {
            name: str(block.name) ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }
    const usage = asRecord(data.usage);
    const normalized = computeUsage(
      num(usage?.input_tokens),
      num(usage?.output_tokens),
      num(usage?.cache_read_input_tokens),
    );
    return {
      id: str(data.id) ?? `claude-${Date.now()}`,
      model,
      created: num(data.created) ?? Math.floor(Date.now() / 1000),
      content,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : mapStopReason(data.stop_reason),
      rawProtocol: 'anthropic',
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(normalized ? { usage: normalized } : {}),
    };
  }

  private async aggregateSSE(
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<ChatResponse> {
    let content = '';
    let reasoning = '';
    let finish: FinishReason = null;
    let id: string | undefined;
    let failure: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let cachedTokens: number | undefined;
    const toolDeltas: ToolCallDelta[] = [];
    for await (const frame of this.parseSSE(response, accountId, model)) {
      if (!id && frame.id) id = frame.id;
      content += frame.delta;
      if (frame.reasoning) reasoning += frame.reasoning;
      if (frame.errorDetail) failure = frame.errorDetail;
      if (frame.toolCalls) toolDeltas.push(...frame.toolCalls);
      if (frame.finish) finish = frame.finish;
      if (frame.promptTokens !== undefined) promptTokens = frame.promptTokens;
      if (frame.completionTokens !== undefined) completionTokens = frame.completionTokens;
      if (frame.cachedTokens !== undefined) cachedTokens = frame.cachedTokens;
    }
    if (failure) {
      throw new ClaudeError(`claude chat failed: upstream reported: ${failure}`, {
        kind: 'fatal',
        accountId,
        model,
      });
    }
    const toolCalls = mergeToolCallDeltas(toolDeltas);
    const usage = computeUsage(promptTokens, completionTokens, cachedTokens);
    return {
      id: id ?? `claude-${Date.now()}`,
      model,
      created: Math.floor(Date.now() / 1000),
      content,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : finish,
      rawProtocol: 'anthropic',
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
      throw new ClaudeError('claude stream failed: upstream returned an empty body', {
        kind: 'network',
        accountId,
        model,
      });
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const toolIndex = new Map<number, number>();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const frame = parseSseBlock(part, toolIndex);
        if (frame) yield frame;
      }
    }
    if (buffer.trim()) {
      const frame = parseSseBlock(buffer, toolIndex);
      if (frame) yield frame;
    }
  }
}
