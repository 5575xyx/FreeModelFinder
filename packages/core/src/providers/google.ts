import { createHash, randomUUID } from 'node:crypto';
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
import { GOOGLE_CATALOG_MODELS } from './google-catalog.js';
import { mergeToolCallDeltas } from './openai-like.js';

/**
 * cloudcode-pa（Antigravity / Cloud Code）端点，对照参考实现 CLIProxyAPI：
 *
 * - `loadCodeAssist` 走生产端点 `cloudcode-pa.googleapis.com`
 *   （sdk/auth/antigravity/constants.go:29 + auth.go:260，含
 *   antigravity_executor_buildrequest_test.go:271）。
 * - 生成请求走 daily 端点：`resolveAntigravityRequestBaseURL` 对消费级凭据默认返回
 *   `antigravityBaseURLDaily`（antigravity_executor_request.go:439-446；常量见
 *   antigravity_executor.go:35-40；断言见 `antigravity_executor_buildrequest_test.go:16-28`）。
 * - 流式路径固定 `?alt=sse`（antigravity_executor_request.go:43-49；
 *   antigravity_executor_interactions_test.go:22-26）。
 */
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const STREAM_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';

/**
 * Antigravity Hub 伪装 UA（antigravity_version.go:116-118）：
 * 上游按 UA 识别客户端版本，低于 2.23.0 会拒绝较新的模型。
 */
const GOOGLE_USER_AGENT = 'antigravity/hub/2.23.0 darwin/arm64';

const EMPTY_COOLDOWN_MS = 30_000;
const DETAIL_LIMIT = 300;

type FinishReason = ChatResponse['finish_reason'];

/**
 * 刷新结果：新 access token + 携带轮换后 payload 的账号条目。
 * 必须把账号一并回传，否则 401 重试拿到的是持有**已过期 access token** 的旧对象，
 * 会再次用被拒的 token 打上游。
 */
interface RefreshedAccount {
  token: string;
  account: CredentialAccountEntry;
}

export type GoogleErrorKind = 'rate_limit' | 'invalid' | 'fatal' | 'network' | 'empty';

export class GoogleError extends Error {
  readonly kind: GoogleErrorKind;
  readonly status?: number;
  readonly resetAt?: number;
  readonly platform = 'google' as const;
  readonly accountId?: string;
  readonly model?: string;
  readonly phase?: 'refresh';

  constructor(
    message: string,
    options: {
      kind: GoogleErrorKind;
      status?: number;
      resetAt?: number;
      accountId?: string;
      model?: string;
      phase?: 'refresh';
    },
  ) {
    super(redact(message));
    this.name = 'GoogleError';
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
  delta: string;
  reasoning?: string;
  finish?: FinishReason;
  toolCalls?: ToolCallDelta[];
  usage?: ChatResponse['usage'];
  /** 上游 `error` 帧携带的错误描述。 */
  errorDetail?: string;
}

/** 跨帧解析状态：为 Gemini 的 functionCall 片段分配稳定的 tool-call index。 */
interface ParseState {
  toolCount: number;
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

/** Gemini usageMetadata → OpenAI Chat usage。 */
function normalizeUsage(value: unknown): ChatResponse['usage'] {
  const record = asRecord(value);
  if (!record) return undefined;
  const usage: NonNullable<ChatResponse['usage']> = {};
  const prompt = num(record.promptTokenCount);
  if (prompt !== undefined) usage.prompt_tokens = prompt;
  const completion = num(record.candidatesTokenCount);
  if (completion !== undefined) usage.completion_tokens = completion;
  const total = num(record.totalTokenCount);
  if (total !== undefined) usage.total_tokens = total;
  const cached = num(record.cachedContentTokenCount);
  if (cached !== undefined) usage.prompt_tokens_details = { cached_tokens: cached };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Gemini finishReason → OpenAI finish_reason（tool_calls 由调用方另行覆盖）。 */
function mapFinishReason(value: unknown): FinishReason {
  switch (str(value)) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return null;
  }
}

/** functionCall.args 可为对象或 JSON 字符串，统一为对象。 */
function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(value) ?? {};
}

/** tool 消息的响应体（Gemini 要求 functionResponse.response 为对象）。 */
function parseResponse(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value)) ?? { result: value };
  } catch {
    return { result: value };
  }
}

/** data URL → Gemini inlineData 部件；非 data URL 返回 null（Gemini 无远程图片形态）。 */
function inlineDataFromUrl(url: string): Record<string, unknown> | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  const mimeType = match?.[1];
  const data = match?.[2];
  if (mimeType !== undefined && data !== undefined) {
    return { inlineData: { mimeType, data } };
  }
  return null;
}

/**
 * 输入消息 → Gemini `contents` 数组 + 顶层 `systemInstruction` 文本。
 * system 提升为 systemInstruction；assistant → role `model`；tool → functionResponse。
 */
function toGeminiContents(messages: ChatMessage[]): {
  contents: Array<Record<string, unknown>>;
  system?: string;
} {
  const contents: Array<Record<string, unknown>> = [];
  const systemParts: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.name ?? message.tool_call_id ?? '',
              response: parseResponse(message.content),
            },
          },
        ],
      });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    if (message.content) parts.push({ text: message.content });
    for (const part of message.contentParts ?? []) {
      if (part.type === 'text') {
        parts.push({ text: part.text });
      } else {
        const inline = inlineDataFromUrl(part.image_url.url);
        if (inline) parts.push(inline);
      }
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        parts.push({
          functionCall: { name: call.function.name, args: parseArgs(call.function.arguments) },
        });
      }
    }
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return { contents, ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}) };
}

/** OpenAI tools → Gemini functionDeclarations。 */
function translateTools(tools: NonNullable<ChatRequest['tools']>): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    functionDeclarations: [
      {
        name: tool.function.name,
        ...(tool.function.description !== undefined
          ? { description: tool.function.description }
          : {}),
        parameters:
          tool.function.parameters !== undefined && Object.keys(tool.function.parameters).length > 0
            ? tool.function.parameters
            : { type: 'object', properties: {} },
      },
    ],
  }));
}

/** OpenAI tool_choice → Gemini functionCallingConfig（required → ANY）。 */
function translateToolChoice(choice: ChatRequest['tool_choice']): Record<string, unknown> | null {
  if (choice === undefined || choice === null) return null;
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (typeof choice === 'object' && 'function' in choice) {
    return {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] },
    };
  }
  return null;
}

/**
 * 稳定 sessionId：对首个用户文本取 sha256 前 8 字节（镜像参考
 * `generateStableSessionID`，antigravity_executor_request.go:570-594），无文本时回退随机。
 */
function stableSessionId(contents: Array<Record<string, unknown>>): string {
  for (const content of contents) {
    if (content.role !== 'user') continue;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const first = asRecord(parts[0]);
    const text = str(first?.text);
    if (text) {
      const hash = createHash('sha256').update(text).digest();
      const value = hash.readBigUInt64BE(0) & 0x7fffffffffffffffn;
      return `-${value.toString()}`;
    }
  }
  return `-${Math.floor(Math.random() * 9_000_000_000_000_000_000)}`;
}

/** 从 loadCodeAssist 响应提取项目 id（接受字符串或 `{ id }` 对象形态）。 */
function extractProject(data: Record<string, unknown> | null): string | undefined {
  if (!data) return undefined;
  for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    const record = asRecord(value);
    const id = str(record?.id);
    if (id && id.trim()) return id.trim();
  }
  return undefined;
}

/** 解析一帧 Gemini SSE（候选包在顶层 `response` 里，usage 兼容两种位置）。 */
function frameFromPayload(payload: Record<string, unknown>, state: ParseState): SseFrame | null {
  const error = asRecord(payload.error);
  if (error) {
    return {
      delta: '',
      finish: 'content_filter',
      errorDetail: str(error.message) ?? 'upstream reported an error',
    };
  }
  const response = asRecord(payload.response) ?? payload;
  const frame: SseFrame = { delta: '' };
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  for (const rawCandidate of candidates) {
    const candidate = asRecord(rawCandidate);
    if (!candidate) continue;
    const content = asRecord(candidate.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part) continue;
      const fn = asRecord(part.functionCall);
      if (fn) {
        const index = state.toolCount;
        state.toolCount += 1;
        frame.toolCalls = frame.toolCalls ?? [];
        frame.toolCalls.push({
          index,
          type: 'function',
          ...(str(fn.id) !== undefined ? { id: str(fn.id) } : {}),
          function: {
            name: str(fn.name) ?? '',
            arguments: JSON.stringify(parseArgs(fn.args)),
          },
        });
        continue;
      }
      const text = str(part.text);
      if (text === undefined || text === '') continue;
      if (part.thought === true) {
        frame.reasoning = (frame.reasoning ?? '') + text;
      } else {
        frame.delta += text;
      }
    }
    const finish = mapFinishReason(candidate.finishReason);
    if (finish) frame.finish = finish;
  }
  const usage = normalizeUsage(asRecord(response.usageMetadata) ?? asRecord(payload.usageMetadata));
  if (usage) frame.usage = usage;
  return frame;
}

/** 解析一个 SSE 块（若干 `data:` 行）。无 data 或坏 JSON → null。 */
function parseSseBlock(block: string, state: ParseState): SseFrame | null {
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
  return frameFromPayload(record, state);
}

export class GoogleProvider extends BaseProvider {
  readonly id: ProviderId = 'google';
  readonly displayName = 'Google';

  /** 每个账号的项目 id 缓存（对应参考实现写回 auth metadata 的 project_id）。 */
  private readonly projectCache = new Map<string, string>();

  override hasCredentials(): boolean {
    return this.runtime().hasActiveAccounts('google');
  }

  async listModels(): Promise<ModelInfo[]> {
    return GOOGLE_CATALOG_MODELS.map((model) => ({
      id: `google:${model.id}`,
      provider: 'google' as const,
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
    try {
      for await (const frame of this.parseSSE(response, accountId, req.model)) {
        if (frame.usage) usage = frame.usage;
        const finish = frame.toolCalls?.length ? 'tool_calls' : (frame.finish ?? null);
        const chunk: StreamChunk = {
          id: frame.id ?? `google-${Date.now()}`,
          model: req.model,
          created: Math.floor(Date.now() / 1000),
          delta: frame.delta,
          rawProtocol: 'gemini',
          finish_reason: finish,
          ...(frame.reasoning !== undefined ? { reasoning: frame.reasoning } : {}),
          ...(frame.toolCalls ? { tool_calls: frame.toolCalls } : {}),
        };
        if (finish != null && usage) chunk.usage = usage;
        yield chunk;
      }
    } catch (error) {
      runtime.recordUsage('google', accountId, req.model, {
        requests: 1,
        error: redact(errorText(error)),
      });
      throw error instanceof GoogleError
        ? error
        : new GoogleError(errorText(error), {
            kind: 'network',
            accountId,
            model: req.model,
          });
    }
    runtime.reportSuccess('google', accountId);
    this.observeUsage(req.model, usage);
    runtime.recordUsage('google', accountId, req.model, {
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
    const pool = await runtime.getPool('google');
    const maxSwitches = Math.min(pool.accounts.length, 3);
    const tried = new Set<string>();
    let lastError: unknown = null;
    let invalidCount = 0;
    for (let step = 0; step <= maxSwitches; step += 1) {
      const account = runtime.nextAccount('google', model);
      if (!account || tried.has(account.id)) break;
      tried.add(account.id);
      try {
        return await attempt(account, false);
      } catch (error) {
        const refreshPhase = error instanceof GoogleError && error.phase === 'refresh';
        runtime.recordUsage('google', account.id, model, {
          requests: refreshPhase ? 0 : 1,
          error: redact(errorText(error)),
        });
        lastError = error;
        if (error instanceof GoogleError) {
          if (error.kind === 'fatal') throw error;
          if (error.kind === 'rate_limit') {
            runtime.reportRateLimit('google', account.id, model, error.resetAt);
          } else if (error.kind === 'empty') {
            runtime.reportRateLimit('google', account.id, model, Date.now() + EMPTY_COOLDOWN_MS);
          } else if (error.kind === 'invalid') {
            runtime.reportInvalid('google', account.id);
            invalidCount += 1;
          }
          // kind === 'network'：本次账号失败但不失效——不冷却、不标记 invalid。
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
      lastError instanceof GoogleError &&
      lastError.kind === 'invalid' &&
      invalidCount > 0 &&
      invalidCount === triedCount
    ) {
      return new GoogleError(
        `google failed ${lastError.status ?? 401}: ${triedCount} 个账号凭据失效，请重新登录`,
        {
          kind: 'invalid',
          status: lastError.status ?? 401,
          accountId: lastError.accountId,
          model,
        },
      );
    }
    if (lastError instanceof GoogleError) return lastError;
    if (lastError instanceof Error)
      return new GoogleError(lastError.message, { kind: 'network', model });
    if (pool.accounts.length === 0) {
      return new GoogleError('google has no available credentials', { kind: 'fatal', model });
    }
    let earliest: number | undefined;
    let coolingAccountId: string | undefined;
    for (const account of pool.accounts) {
      const cooling = runtime
        .listAccountCooldowns('google', account.id)
        .find((entry) => entry.model === model);
      if (cooling && (earliest === undefined || cooling.resetAt < earliest)) {
        earliest = cooling.resetAt;
        coolingAccountId = account.id;
      }
    }
    const iso = earliest ? `, reset at ${new Date(earliest).toISOString()}` : '';
    return new GoogleError(
      `google failed 429 rate limit: all ${pool.accounts.length} accounts are cooling for ${model}${iso}`,
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
    return runSharedFlight(subscriptionFlightKey('google', account.id), () =>
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
    const pooled = (await runtime.getPool('google')).accounts.find((e) => e.id === account.id);
    account = pooled ?? account;
    let payload: Record<string, string>;
    try {
      const result = await SUBSCRIPTION_ADAPTERS.google.refresh({
        fetchImpl: this.fetch,
        refreshToken: account.payload.refreshToken ?? '',
        payload: account.payload,
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof SubscriptionRefreshError) {
        if (error.kind === 'fatal') {
          runtime.reportInvalid('google', account.id);
          throw new GoogleError('google refresh failed: 账号凭据失效，请重新登录', {
            kind: 'invalid',
            status: error.status ?? 400,
            accountId: account.id,
            model,
            phase: 'refresh',
          });
        }
        if (error.kind === 'rate_limit') {
          throw new GoogleError('google refresh failed 429: token refresh rate limited', {
            kind: 'rate_limit',
            status: 429,
            resetAt: error.resetAt,
            accountId: account.id,
            model,
            phase: 'refresh',
          });
        }
      }
      throw new GoogleError(`google refresh failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const accessToken = payload.accessToken;
    if (!accessToken) {
      throw new GoogleError('google refresh failed: upstream returned no access token', {
        kind: 'network',
        accountId: account.id,
        model,
        phase: 'refresh',
      });
    }
    const refreshed: CredentialAccountEntry = { ...account, payload };
    await runtime.upsertAccount('google', refreshed);
    return { token: accessToken, account: refreshed };
  }

  /**
   * 项目 id 发现与缓存：优先取内存缓存，其次 payload.projectId（跨进程持久化），
   * 最后才调 loadCodeAssist。发现成功后写回账号 payload，后续请求复用。
   * loadCodeAssist 是尽力而为：网络/解析失败不阻断生成（记录后返回 undefined）。
   */
  private async ensureProject(
    account: CredentialAccountEntry,
    token: string,
  ): Promise<string | undefined> {
    const memory = this.projectCache.get(account.id);
    if (memory) return memory;
    const fromPayload = account.payload.projectId;
    if (fromPayload) {
      this.projectCache.set(account.id, fromPayload);
      return fromPayload;
    }
    let response: Response;
    try {
      response = await this.fetch(LOAD_CODE_ASSIST_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: '*/*',
          'User-Agent': GOOGLE_USER_AGENT,
        },
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      });
    } catch {
      return undefined;
    }
    if (!response.ok) {
      await response.text().catch(() => '');
      return undefined;
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = asRecord(await response.json());
    } catch {
      data = null;
    }
    const project = extractProject(data);
    if (!project) return undefined;
    this.projectCache.set(account.id, project);
    await this.runtime().upsertAccount('google', {
      ...account,
      payload: { ...account.payload, projectId: project },
    });
    return project;
  }

  private buildBody(
    req: ChatRequest,
    contents: Array<Record<string, unknown>>,
    system: string | undefined,
    project: string | undefined,
  ): Record<string, unknown> {
    const inner: Record<string, unknown> = {
      contents,
      sessionId: stableSessionId(contents),
    };
    if (system !== undefined) inner.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length) inner.tools = translateTools(req.tools);
    const toolConfig = translateToolChoice(req.tool_choice);
    if (toolConfig) inner.toolConfig = toolConfig;
    const generationConfig: Record<string, unknown> = {};
    if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.top_p !== undefined) generationConfig.topP = req.top_p;
    if (req.stop !== undefined) {
      generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    }
    if (Object.keys(generationConfig).length > 0) inner.generationConfig = generationConfig;
    return {
      model: req.model,
      userAgent: 'antigravity',
      requestType: 'agent',
      requestId: `agent-${randomUUID()}`,
      ...(project !== undefined ? { project } : {}),
      request: inner,
    };
  }

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': GOOGLE_USER_AGENT,
    };
  }

  private async chatAttempt(
    account: CredentialAccountEntry,
    req: ChatRequest,
    forceRefresh: boolean,
  ): Promise<ChatResponse> {
    const runtime = this.runtime();
    const refreshed = await this.getAccessToken(account, forceRefresh, req.model);
    const token = refreshed.token;
    const { contents, system } = toGeminiContents(req.messages);
    const project = await this.ensureProject(refreshed.account, token);
    const body = this.buildBody(req, contents, system, project);
    let response: Response;
    try {
      response = await this.fetch(STREAM_URL, {
        method: 'POST',
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new GoogleError(`google chat failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('chat', response, req.model, account.id);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 401 && !forceRefresh) {
        runtime.recordUsage('google', account.id, req.model, {
          requests: 1,
          error: redact(errorText(error)),
        });
        return this.chatAttempt(refreshed.account, req, true);
      }
      throw error;
    }
    const chatResponse = await this.aggregateSSE(response, req.model, account.id);
    if (!chatResponse.content?.trim() && !chatResponse.tool_calls?.length) {
      throw new GoogleError(
        `google chat failed: upstream returned empty content for ${req.model}`,
        {
          kind: 'empty',
          accountId: account.id,
          model: req.model,
        },
      );
    }
    runtime.reportSuccess('google', account.id);
    this.observeUsage(req.model, chatResponse.usage);
    runtime.recordUsage('google', account.id, req.model, {
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
    const { contents, system } = toGeminiContents(req.messages);
    const project = await this.ensureProject(refreshed.account, token);
    let response: Response;
    try {
      response = await this.fetch(STREAM_URL, {
        method: 'POST',
        headers: this.buildHeaders(token),
        body: JSON.stringify(this.buildBody(req, contents, system, project)),
      });
    } catch (error) {
      throw new GoogleError(`google stream failed: ${errorText(error)}`, {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    this.observeResponse(req.model, response);
    try {
      await this.ensureHttpOk('stream', response, req.model, account.id);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 401 && !forceRefresh) {
        this.runtime().recordUsage('google', account.id, req.model, {
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
      throw new GoogleError('google stream failed: upstream did not return an event stream', {
        kind: 'network',
        accountId: account.id,
        model: req.model,
      });
    }
    return response;
  }

  /** 401 分支绝不读取/回显响应体：上游错误 JSON 可能回显 token 片段（防泄漏）。 */
  private async ensureHttpOk(
    op: 'chat' | 'stream',
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<void> {
    if (response.ok) return;
    const status = response.status;
    if (status === 401) {
      throw new GoogleError(`google ${op} failed 401: access token rejected`, {
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
      throw new GoogleError(`google ${op} failed 403: ${detail}`, {
        kind: 'invalid',
        status,
        accountId,
        model,
      });
    }
    if (status >= 500) {
      throw new GoogleError(`google ${op} failed ${status}: ${detail}`, {
        kind: 'network',
        status,
        accountId,
        model,
      });
    }
    throw new GoogleError(`google ${op} failed ${status}: ${detail}`, {
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
    throw new GoogleError(`google ${op} failed 429 rate limit on ${model}${detail}${iso}`, {
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
    return undefined;
  }

  private async aggregateSSE(
    response: Response,
    model: string,
    accountId?: string,
  ): Promise<ChatResponse> {
    let content = '';
    let reasoning = '';
    let finish: FinishReason = null;
    let usage: ChatResponse['usage'];
    let failure: string | undefined;
    const toolDeltas: ToolCallDelta[] = [];
    for await (const frame of this.parseSSE(response, accountId, model)) {
      content += frame.delta;
      if (frame.reasoning) reasoning += frame.reasoning;
      if (frame.errorDetail) failure = frame.errorDetail;
      if (frame.toolCalls) toolDeltas.push(...frame.toolCalls);
      if (frame.finish) finish = frame.finish;
      if (frame.usage) usage = frame.usage;
    }
    if (failure) {
      throw new GoogleError(`google chat failed: upstream reported: ${failure}`, {
        kind: 'fatal',
        accountId,
        model,
      });
    }
    const toolCalls: ToolCall[] = mergeToolCallDeltas(toolDeltas);
    return {
      id: `google-${Date.now()}`,
      model,
      created: Math.floor(Date.now() / 1000),
      content,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : finish,
      rawProtocol: 'gemini',
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
      throw new GoogleError('google stream failed: upstream returned an empty body', {
        kind: 'network',
        accountId,
        model,
      });
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state: ParseState = { toolCount: 0 };
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const frame = parseSseBlock(part, state);
        if (frame) yield frame;
      }
    }
    if (buffer.trim()) {
      const frame = parseSseBlock(buffer, state);
      if (frame) yield frame;
    }
  }
}
