import { ForgeError, createModelId, createProviderId } from "@forge/protocol";
import type { ForgeConfig } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface FunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; tool: string; input: unknown }[];
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: FunctionSpec[];
  maxTokens?: number;
  signal: AbortSignal;
}

export interface ModelToolCall {
  id: string;
  tool: string;
  input: unknown;
}

export type StreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "toolcall"; toolCall: ModelToolCall }
  | { kind: "usage"; inputTokens: number; outputTokens: number };

export interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  vision: boolean;
  maxContextTokens: number;
}

/** Provider abstraction — Core domain logic never touches HTTP directly. */
export interface ModelProvider {
  readonly name: string;
  readonly providerId: string;
  capabilities(model: string): ModelCapabilities;
  complete(req: ModelRequest, onEvent: (e: StreamEvent) => void): Promise<ModelResponse>;
}

function toOpenAIMessages(system: string, messages: ModelMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId ?? "unknown", content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.tool, arguments: JSON.stringify(t.input) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/**
 * Real OpenAI-compatible provider (OpenAI, Azure, OpenRouter, Ollama, vLLM —
 * anything serving the chat-completions API). Streams via SSE, accumulates
 * tool-call deltas, honors AbortSignal end-to-end.
 */
export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  readonly providerId: string = createProviderId();
  readonly modelId = createModelId();

  private config: ForgeConfig;
  private log: Logger;
  constructor(config: ForgeConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  capabilities(_model: string): ModelCapabilities {
    return { toolCalling: true, streaming: true, vision: false, maxContextTokens: 128_000 };
  }

  private headers(): Record<string, string> {
    const key = this.config.openaiApiKey;
    if (!key) {
      throw new ForgeError("ProviderUnavailable", "OPENAI_API_KEY is not set (provider 'openai' unavailable)", { retryable: false });
    }
    return { "content-type": "application/json", authorization: `Bearer ${key}` };
  }

  async complete(req: ModelRequest, onEvent: (e: StreamEvent) => void): Promise<ModelResponse> {
    const body = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    };
    const bodyBytes = JSON.stringify(body).length;
    if (bodyBytes > this.config.limits.maxModelRequestBytes) {
      throw new ForgeError("InvalidRequest", `model request too large (${bodyBytes} bytes)`);
    }
    let res: Response;
    try {
      res = await fetch(`${this.config.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal.aborted) throw new ForgeError("Cancelled", "model request cancelled");
      throw new ForgeError("ProviderUnavailable", `provider request failed: ${(e as Error).message}`, { cause: e });
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      const code = res.status === 429 ? "RateLimited" : res.status >= 500 ? "ProviderUnavailable" : "ModelFailure";
      throw new ForgeError(code, `provider error ${res.status}: ${text.slice(0, 1000)}`, { retryable: res.status === 429 || res.status >= 500 });
    }

    // SSE stream parse.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = "stop";
    const usage = { inputTokens: 0, outputTokens: 0 };
    const flush = (chunk: string): void => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const u = ev.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (u) {
          usage.inputTokens = u.prompt_tokens ?? 0;
          usage.outputTokens = u.completion_tokens ?? 0;
          onEvent({ kind: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
        }
        const choices = ev.choices as { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[] | undefined;
        const delta = choices?.[0]?.delta;
        if (!delta) {
          if (choices?.[0]?.finish_reason) finishReason = choices[0].finish_reason;
          continue;
        }
        if (delta.content) {
          text += delta.content;
          onEvent({ kind: "text", delta: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const cur = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(tc.index, cur);
        }
        if (choices?.[0]?.finish_reason) finishReason = choices[0].finish_reason;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        flush(decoder.decode(value, { stream: true }));
      }
      flush(decoder.decode());
    } catch (e) {
      if (req.signal.aborted) throw new ForgeError("Cancelled", "model stream cancelled");
      throw new ForgeError("ModelFailure", `model stream failed: ${(e as Error).message}`, { cause: e });
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ModelToolCall[] = [];
    for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.name) continue;
      let input: unknown = {};
      try {
        input = acc.args ? (JSON.parse(acc.args) as unknown) : {};
      } catch {
        input = { _rawArguments: acc.args };
      }
      const call = { id: acc.id || `call_${toolCalls.length}`, tool: acc.name, input };
      toolCalls.push(call);
      onEvent({ kind: "toolcall", toolCall: call });
    }
    this.log.debug(`model done: ${text.length} chars, ${toolCalls.length} tool calls`, { provider: this.name, model: req.model });
    return { text, toolCalls, finishReason, usage };
  }
}

export interface MockStep {
  text?: string;
  toolCalls?: { tool: string; input: unknown }[];
  finishReason?: string;
}

/**
 * Deterministic test double. Steps are consumed in order; when exhausted it
 * returns a terminal text response. Every other layer (tools, events,
 * persistence, loop) stays real.
 */
export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly providerId: string = createProviderId();
  calls = 0;
  private steps: MockStep[];
  private log?: Logger;
  constructor(steps: MockStep[] = [], log?: Logger) {
    this.steps = steps;
    this.log = log;
  }
  capabilities(_model: string): ModelCapabilities {
    return { toolCalling: true, streaming: true, vision: false, maxContextTokens: 128_000 };
  }
  async complete(req: ModelRequest, onEvent: (e: StreamEvent) => void): Promise<ModelResponse> {
    this.calls++;
    if (req.signal.aborted) throw new ForgeError("Cancelled", "model request cancelled");
    const step = this.steps.length > 0 ? this.steps.shift()! : { text: "done (mock default)" };
    const text = step.text ?? "";
    // Stream in small deltas like a real provider.
    for (let i = 0; i < text.length; i += 24) {
      if (req.signal.aborted) throw new ForgeError("Cancelled", "model stream cancelled");
      onEvent({ kind: "text", delta: text.slice(i, i + 24) });
      await new Promise((r) => setTimeout(r, 1));
    }
    const toolCalls = (step.toolCalls ?? []).map((t, i) => ({ id: `mock_${this.calls}_${i}`, tool: t.tool, input: t.input }));
    for (const tc of toolCalls) onEvent({ kind: "toolcall", toolCall: tc });
    this.log?.debug(`mock step ${this.calls}: ${toolCalls.length} tool calls`, { provider: "mock" });
    return { text, toolCalls, finishReason: step.finishReason ?? (toolCalls.length ? "tool_calls" : "stop"), usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

export function createProvider(name: string, config: ForgeConfig, log: Logger, mockSteps?: MockStep[]): ModelProvider {
  if (name === "mock") return new MockProvider(mockSteps ?? [], log);
  if (name === "openai") return new OpenAIProvider(config, log);
  throw new ForgeError("InvalidRequest", `unknown provider: ${name} (available: openai, mock)`);
}
