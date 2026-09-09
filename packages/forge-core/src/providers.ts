/**
 * Provider-neutral model abstraction. Every provider — cloud, local or
 * test double — speaks this interface; Core never depends on a vendor SDK.
 * Uses global fetch only (no vendor dependencies).
 */
import { ForgeError } from './errors.js';
import type { ProviderConfig } from './config.js';
import { resolveApiKey } from './config.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant tool calls (when role === 'assistant'). */
  toolCalls?: ToolCallRequest[];
  /** Tool result correlation (when role === 'tool'). */
  toolCallId?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  usage: { inputTokens: number; outputTokens: number; reported: boolean };
  provider: string;
  model: string;
  latencyMs: number;
  stopReason?: string;
  /** True only for test/demo doubles. Never true for real providers. */
  simulated?: boolean;
}

export type ProviderCapability =
  | 'text' | 'streaming' | 'tool_calling' | 'vision' | 'structured_output' | 'reasoning';

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  capabilities: ProviderCapability[];
}

export interface HealthCheck {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** True for local runtimes (ollama/lmstudio/custom-local). */
  readonly local: boolean;
  readonly capabilities: ProviderCapability[];
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  checkHealth(): Promise<HealthCheck>;
}

/** Heuristic token estimate used when a provider does not report usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateUsage(messages: ChatMessage[], completion: string): { inputTokens: number; outputTokens: number } {
  let input = 0;
  for (const m of messages) {
    input += estimateTokens(m.content) + 4;
    for (const t of m.toolCalls ?? []) input += estimateTokens(t.name) + estimateTokens(JSON.stringify(t.input)) + 4;
  }
  return { inputTokens: input, outputTokens: estimateTokens(completion) + 4 };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 2000) }; }
    return { status: res.status, json };
  } catch (e) {
    if (controller.signal.aborted && !signal?.aborted) throw new ForgeError('TIMEOUT', `Provider request timed out after ${timeoutMs}ms (${url})`);
    if (signal?.aborted) throw new ForgeError('CANCELLED', 'Provider request cancelled');
    throw new ForgeError('PROVIDER_ERROR', `Provider request failed: ${(e as Error).message}`, { cause: e });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function providerHttpError(provider: string, status: number, json: unknown): ForgeError {
  const body = json as { error?: { message?: string; code?: string; type?: string }; message?: string };
  const message = body?.error?.message || body?.message || `HTTP ${status}`;
  if (status === 429) return new ForgeError('RATE_LIMITED', `${provider} rate limited: ${message}`, { details: { status } });
  if (status === 401 || status === 403) return new ForgeError('PROVIDER_ERROR', `${provider} auth failed (${status}): ${message}. Check the API key.`, { details: { status }, recoverable: false });
  if (status === 404) return new ForgeError('MODEL_UNAVAILABLE', `${provider}: model not found (${message})`, { details: { status }, recoverable: false });
  if (status >= 500) return new ForgeError('PROVIDER_ERROR', `${provider} server error (${status}): ${message}`, { details: { status } });
  return new ForgeError('PROVIDER_ERROR', `${provider} request failed (${status}): ${message}`, { details: { status } });
}

// ------------------------------------------------- OpenAI-compatible ---

export interface OpenAICompatibleOptions {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  local?: boolean;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly kind = 'openai-compatible';
  readonly local: boolean;
  readonly capabilities: ProviderCapability[] = ['text', 'streaming', 'tool_calling', 'structured_output'];
  private baseUrl: string;
  private apiKey?: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.name = opts.name ?? opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.headers = opts.headers ?? {};
    this.local = opts.local ?? false;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { status, json } = await fetchJson(`${this.baseUrl}/models`, { headers: this.authHeaders() }, 15_000, signal);
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const data = (json as { data?: { id: string }[] }).data ?? [];
    return data.map((m) => ({ id: m.id, capabilities: this.capabilities }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const messages = req.messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: m.toolCallId ?? '', content: m.content };
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant' as const, content: m.content || null,
          tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })),
        };
      }
      return { role: m.role, content: m.content };
    });
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      body.tool_choice = 'auto';
    }
    const { status, json } = await fetchJson(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...this.authHeaders() }, body: JSON.stringify(body) },
      req.timeoutMs ?? this.timeoutMs,
      req.signal,
    );
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const choice = (json as { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }).choices?.[0];
    if (!choice) throw new ForgeError('PROVIDER_ERROR', `${this.id} returned no choices`);
    const toolCalls: ToolCallRequest[] = (choice.message?.tool_calls ?? []).map((t) => {
      let input: unknown = {};
      try { input = t.function.arguments ? JSON.parse(t.function.arguments) : {}; } catch { input = { _raw: t.function.arguments }; }
      return { id: t.id, name: t.function.name, input };
    });
    const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    const fallback = estimateUsage(req.messages, choice.message?.content ?? '');
    return {
      content: choice.message?.content ?? '',
      toolCalls,
      usage: usage
        ? { inputTokens: usage.prompt_tokens ?? fallback.inputTokens, outputTokens: usage.completion_tokens ?? fallback.outputTokens, reported: true }
        : { ...fallback, reported: false },
      provider: this.id,
      model: req.model,
      latencyMs: Date.now() - startedAt,
      stopReason: choice.finish_reason,
    };
  }

  async checkHealth(): Promise<HealthCheck> {
    const startedAt = Date.now();
    try {
      await this.listModels();
      return { healthy: true, latencyMs: Date.now() - startedAt };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - startedAt, error: (e as Error).message };
    }
  }

  private authHeaders(): Record<string, string> {
    return { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.headers };
  }
}

// ------------------------------------------------------------ Anthropic ---

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly kind = 'anthropic';
  readonly local = false;
  readonly capabilities: ProviderCapability[] = ['text', 'streaming', 'tool_calling', 'vision', 'structured_output', 'reasoning'];
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(opts: { id: string; name?: string; baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    this.id = opts.id;
    this.name = opts.name ?? opts.id;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { status, json } = await fetchJson(`${this.baseUrl}/v1/models`, { headers: this.authHeaders() }, 15_000, signal);
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const data = (json as { data?: { id: string }[] }).data ?? [];
    return data.map((m) => ({ id: m.id, capabilities: this.capabilities }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages: unknown[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: unknown[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const t of m.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} });
        messages.push({ role: 'assistant', content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      system: system || undefined,
      messages,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }
    const { status, json } = await fetchJson(
      `${this.baseUrl}/v1/messages`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...this.authHeaders() }, body: JSON.stringify(body) },
      req.timeoutMs ?? this.timeoutMs,
      req.signal,
    );
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const parsed = json as { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    let content = '';
    const toolCalls: ToolCallRequest[] = [];
    for (const block of parsed.content ?? []) {
      if (block.type === 'text' && block.text) content += block.text;
      if (block.type === 'tool_use' && block.id && block.name) toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
    const fallback = estimateUsage(req.messages, content);
    return {
      content, toolCalls,
      usage: parsed.usage
        ? { inputTokens: parsed.usage.input_tokens ?? fallback.inputTokens, outputTokens: parsed.usage.output_tokens ?? fallback.outputTokens, reported: true }
        : { ...fallback, reported: false },
      provider: this.id, model: req.model, latencyMs: Date.now() - startedAt, stopReason: parsed.stop_reason,
    };
  }

  async checkHealth(): Promise<HealthCheck> {
    const startedAt = Date.now();
    try {
      await this.listModels();
      return { healthy: true, latencyMs: Date.now() - startedAt };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - startedAt, error: (e as Error).message };
    }
  }

  private authHeaders(): Record<string, string> {
    return { 'x-api-key': this.apiKey ?? '', 'anthropic-version': '2023-06-01' };
  }
}

// --------------------------------------------------------------- Google ---

export class GoogleProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly kind = 'google';
  readonly local = false;
  readonly capabilities: ProviderCapability[] = ['text', 'tool_calling', 'vision', 'structured_output'];
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(opts: { id: string; name?: string; baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    this.id = opts.id;
    this.name = opts.name ?? opts.id;
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { status, json } = await fetchJson(`${this.baseUrl}/v1beta/models?key=${this.apiKey ?? ''}`, {}, 15_000, signal);
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const data = (json as { models?: { name?: string }[] }).models ?? [];
    return data.map((m) => ({ id: (m.name ?? '').replace(/^models\//, ''), capabilities: this.capabilities }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents: unknown[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name ?? 'tool', response: { output: m.content } } }] });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts: unknown[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const t of m.toolCalls) parts.push({ functionCall: { name: t.name, args: t.input ?? {} } });
        contents.push({ role: 'model', parts });
      } else {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      }
    }
    const body: Record<string, unknown> = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: req.maxTokens ?? 4096, temperature: req.temperature ?? 0.2 },
    };
    if (req.tools?.length) {
      body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }];
    }
    const { status, json } = await fetchJson(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${this.apiKey ?? ''}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      req.timeoutMs ?? this.timeoutMs,
      req.signal,
    );
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const parsed = json as { candidates?: { content?: { parts?: { text?: string; functionCall?: { name: string; args: unknown } }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    let content = '';
    const toolCalls: ToolCallRequest[] = [];
    parts.forEach((p, i) => {
      if (p.text) content += p.text;
      if (p.functionCall) toolCalls.push({ id: `google_${Date.now()}_${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
    });
    const fallback = estimateUsage(req.messages, content);
    const usage = parsed.usageMetadata;
    return {
      content, toolCalls,
      usage: usage
        ? { inputTokens: usage.promptTokenCount ?? fallback.inputTokens, outputTokens: usage.candidatesTokenCount ?? fallback.outputTokens, reported: true }
        : { ...fallback, reported: false },
      provider: this.id, model: req.model, latencyMs: Date.now() - startedAt, stopReason: parsed.candidates?.[0]?.finishReason,
    };
  }

  async checkHealth(): Promise<HealthCheck> {
    const startedAt = Date.now();
    try {
      await this.listModels();
      return { healthy: true, latencyMs: Date.now() - startedAt };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - startedAt, error: (e as Error).message };
    }
  }
}

// --------------------------------------------------------------- Ollama ---

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly kind = 'ollama';
  readonly local = true;
  readonly capabilities: ProviderCapability[] = ['text', 'streaming', 'tool_calling'];
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { id: string; name?: string; baseUrl?: string; timeoutMs?: number }) {
    this.id = opts.id;
    this.name = opts.name ?? opts.id;
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { status, json } = await fetchJson(`${this.baseUrl}/api/tags`, {}, 10_000, signal);
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const data = (json as { models?: { name?: string }[] }).models ?? [];
    return data.map((m) => ({ id: m.name ?? 'unknown', capabilities: this.capabilities }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const messages: unknown[] = [];
    for (const m of req.messages) {
      if (m.role === 'tool') {
        messages.push({ role: 'tool', content: m.content, tool_name: m.name ?? 'tool' });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant', content: m.content,
          tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.input ?? {} } })),
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    const body: Record<string, unknown> = {
      model: req.model, messages, stream: false,
      options: { temperature: req.temperature ?? 0.2, num_predict: req.maxTokens ?? 4096 },
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }
    const { status, json } = await fetchJson(
      `${this.baseUrl}/api/chat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      req.timeoutMs ?? this.timeoutMs,
      req.signal,
    );
    if (status !== 200) throw providerHttpError(this.id, status, json);
    const parsed = json as { message?: { content?: string; tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[] }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
    const toolCalls: ToolCallRequest[] = (parsed.message?.tool_calls ?? []).map((t, i) => ({
      id: t.id ?? `ollama_${Date.now()}_${i}`, name: t.function.name, input: t.function.arguments ?? {},
    }));
    const content = parsed.message?.content ?? '';
    const fallback = estimateUsage(req.messages, content);
    const reported = parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined;
    return {
      content, toolCalls,
      usage: {
        inputTokens: parsed.prompt_eval_count ?? fallback.inputTokens,
        outputTokens: parsed.eval_count ?? fallback.outputTokens,
        reported,
      },
      provider: this.id, model: req.model, latencyMs: Date.now() - startedAt, stopReason: parsed.done_reason,
    };
  }

  async checkHealth(): Promise<HealthCheck> {
    const startedAt = Date.now();
    try {
      const { status } = await fetchJson(`${this.baseUrl}/api/tags`, {}, 10_000);
      if (status !== 200) return { healthy: false, latencyMs: Date.now() - startedAt, error: `HTTP ${status}` };
      return { healthy: true, latencyMs: Date.now() - startedAt };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - startedAt, error: (e as Error).message };
    }
  }
}

// ------------------------------------------- test doubles (simulated) ---

/** Scripted provider for tests and demo mode. Always marks output simulated. */
export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly kind = 'scripted';
  readonly local = true;
  readonly capabilities: ProviderCapability[] = ['text', 'tool_calling', 'structured_output'];
  private queue: { content?: string; toolCalls?: ToolCallRequest[]; error?: ForgeError }[];
  readonly calls: ChatRequest[] = [];

  constructor(opts: { id?: string; script: { content?: string; toolCalls?: { name: string; input?: unknown }[]; error?: ForgeError }[] }) {
    this.id = opts.id ?? 'scripted';
    this.name = this.id;
    this.queue = opts.script.map((s) => ({
      content: s.content,
      toolCalls: (s.toolCalls ?? []).map((t, i) => ({ id: `scripted_${this.calls.length}_${i}`, name: t.name, input: t.input ?? {} })),
      error: s.error,
    }));
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'scripted-model', capabilities: this.capabilities }];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (!next) {
      return {
        content: 'Script exhausted — no further scripted responses.',
        toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, reported: true },
        provider: this.id, model: req.model, latencyMs: 0, simulated: true, stopReason: 'script_exhausted',
      };
    }
    if (next.error) throw next.error;
    const fallback = estimateUsage(req.messages, next.content ?? '');
    return {
      content: next.content ?? '', toolCalls: next.toolCalls ?? [],
      usage: { ...fallback, reported: false },
      provider: this.id, model: req.model, latencyMs: 1, simulated: true, stopReason: 'stop',
    };
  }

  async checkHealth(): Promise<HealthCheck> {
    return { healthy: true, latencyMs: 0 };
  }
}

/**
 * Echo fallback for provider-unavailable development. Only used when the
 * runtime is explicitly configured to allow simulated fallback — Core never
 * silently substitutes it for a real provider.
 */
export class EchoProvider implements ModelProvider {
  readonly id = 'echo-fallback';
  readonly name = 'Echo (simulated dev fallback)';
  readonly kind = 'echo';
  readonly local = true;
  readonly capabilities: ProviderCapability[] = ['text'];

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'echo', capabilities: this.capabilities }];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    return {
      content: `[SIMULATED — no model provider configured] Echo of last user message:\n${(last?.content ?? '').slice(0, 2000)}`,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, reported: true },
      provider: this.id, model: req.model, latencyMs: 0, simulated: true, stopReason: 'stop',
    };
  }

  async checkHealth(): Promise<HealthCheck> {
    return { healthy: true, latencyMs: 0 };
  }
}

// -------------------------------------------------------------- factory ---

/**
 * Build a provider from config. Returns undefined when the provider is
 * disabled or its credentials are absent (caller reports honestly).
 */
export function createProvider(id: string, cfg: ProviderConfig): ModelProvider | undefined {
  if (cfg.enabled === false) return undefined;
  const kind = cfg.kind;
  const needsKey = kind === 'openai-compatible' || kind === 'anthropic' || kind === 'google' || kind === 'custom';
  const apiKey = resolveApiKey(cfg.apiKeyEnv);
  const baseUrl = cfg.baseUrl ?? '';
  const isLocalhost = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?/.test(baseUrl);
  if (needsKey && !apiKey && !isLocalhost && kind !== 'openai-compatible') return undefined;
  if (needsKey && !apiKey && !isLocalhost && id !== 'lmstudio') {
    // OpenAI-compatible endpoints on localhost (LM Studio etc.) need no key.
    if (kind === 'openai-compatible' && !isLocalhost) return undefined;
  }
  switch (kind) {
    case 'openai-compatible':
    case 'custom':
      return new OpenAICompatibleProvider({
        id, baseUrl: cfg.baseUrl ?? 'http://127.0.0.1:1234/v1', apiKey,
        headers: cfg.headers, local: isLocalhost, timeoutMs: cfg.timeoutMs,
      });
    case 'anthropic':
      if (!apiKey) return undefined;
      return new AnthropicProvider({ id, baseUrl: cfg.baseUrl, apiKey, timeoutMs: cfg.timeoutMs });
    case 'google':
      if (!apiKey) return undefined;
      return new GoogleProvider({ id, baseUrl: cfg.baseUrl, apiKey, timeoutMs: cfg.timeoutMs });
    case 'ollama':
      return new OllamaProvider({ id, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
    case 'lmstudio':
      return new OpenAICompatibleProvider({ id, baseUrl: cfg.baseUrl ?? 'http://127.0.0.1:1234/v1', apiKey, headers: cfg.headers, local: true, timeoutMs: cfg.timeoutMs });
    default:
      throw new ForgeError('CONFIG_ERROR', `Unknown provider kind '${kind}' for provider '${id}'`);
  }
}
