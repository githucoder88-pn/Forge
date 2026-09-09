/**
 * Model router: capability-aware provider selection, retries with backoff,
 * fallback chains, health tracking and circuit breaking. Every routing
 * decision is explainable (decision.reason) and emitted as an event.
 */
import { AgentId, SessionId, TaskId, nowIso } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import type { ModelRef } from './config.js';
import type { ChatRequest, ChatResponse, ModelProvider, ProviderCapability } from './providers.js';

export type RoutingStrategy =
  | 'manual' | 'priority' | 'highest_quality' | 'lowest_cost'
  | 'lowest_latency' | 'adaptive' | 'local_first' | 'cloud_first';

export type ProviderHealth = 'available' | 'degraded' | 'rate_limited' | 'offline';

export interface ProviderEntry {
  provider: ModelProvider;
  health: ProviderHealth;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastError?: string;
  /** Exponential moving average of chat latency (ms). */
  latencyEwma?: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  circuitOpenUntil?: number;
  modelsCache?: { at: number; models: string[] };
}

export interface RouteRequest {
  strategy?: RoutingStrategy;
  preferred?: ModelRef;
  requiredCapabilities?: ProviderCapability[];
  agentRole?: string;
  taskComplexity?: 'trivial' | 'simple' | 'moderate' | 'complex';
  sessionId?: SessionId;
  agentId?: AgentId;
  taskId?: TaskId;
}

export interface RouteCandidate {
  providerId: string;
  model: string;
}

export interface RouteDecision {
  providerId: string;
  model: string;
  /** Full ordered chain: primary first, then fallbacks. */
  chain: RouteCandidate[];
  reason: string;
  timeoutMs: number;
}

export interface RouterOptions {
  defaultStrategy?: RoutingStrategy;
  fallbackEnabled?: boolean;
  maxRetries?: number;
  baseBackoffMs?: number;
  defaultTimeoutMs?: number;
  defaultModels?: Record<string, string>;
  bus?: EventBus;
}

/** Static quality/cost tiers for known model families (used only for ordering). */
function modelTier(model: string): { quality: number; cost: number } {
  const m = model.toLowerCase();
  if (/(opus|gpt-5|o3|o4|gemini-.*ultra|command-r-plus)/.test(m)) return { quality: 5, cost: 5 };
  if (/(sonnet-4|gpt-4o|gpt-4\.1|gemini-2\.[50]-pro|qwen.*max|deepseek-r1)/.test(m)) return { quality: 4, cost: 4 };
  if (/(sonnet|gpt-4o-mini|gpt-4\.1-mini|gemini.*flash|haiku|qwen.*plus|llama.*70b|mixtral)/.test(m)) return { quality: 3, cost: 2 };
  if (/(haiku|flash-lite|mini|7b|8b|13b|phi|gemma)/.test(m)) return { quality: 2, cost: 1 };
  return { quality: 3, cost: 3 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ModelRouter {
  private entries = new Map<string, ProviderEntry>();
  private defaultStrategy: RoutingStrategy;
  private fallbackEnabled: boolean;
  private maxRetries: number;
  private baseBackoffMs: number;
  private defaultTimeoutMs: number;
  private defaultModels: Record<string, string>;
  private bus?: EventBus;

  constructor(opts?: RouterOptions) {
    this.defaultStrategy = opts?.defaultStrategy ?? 'adaptive';
    this.fallbackEnabled = opts?.fallbackEnabled ?? true;
    this.maxRetries = opts?.maxRetries ?? 2;
    this.baseBackoffMs = opts?.baseBackoffMs ?? 500;
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 120_000;
    this.defaultModels = opts?.defaultModels ?? {};
    this.bus = opts?.bus;
  }

  registerProvider(provider: ModelProvider): void {
    if (!this.entries.has(provider.id)) {
      this.entries.set(provider.id, {
        provider, health: 'available', consecutiveFailures: 0,
        requests: 0, tokensIn: 0, tokensOut: 0,
      });
    }
  }

  providerIds(): string[] { return [...this.entries.keys()]; }

  getHealth(providerId: string): ProviderHealth {
    const e = this.entries.get(providerId);
    if (!e) throw new ForgeError('NOT_FOUND', `Unknown provider: ${providerId}`);
    return this.effectiveHealth(e);
  }

  setHealth(providerId: string, health: ProviderHealth, reason?: string): void {
    const e = this.entries.get(providerId);
    if (!e) throw new ForgeError('NOT_FOUND', `Unknown provider: ${providerId}`);
    e.health = health;
    if (reason) e.lastError = reason;
  }

  stats(): Record<string, { health: ProviderHealth; requests: number; tokensIn: number; tokensOut: number; latencyEwma?: number; consecutiveFailures: number; lastError?: string }> {
    const out: Record<string, { health: ProviderHealth; requests: number; tokensIn: number; tokensOut: number; latencyEwma?: number; consecutiveFailures: number; lastError?: string }> = {};
    for (const [id, e] of this.entries) {
      out[id] = {
        health: this.effectiveHealth(e), requests: e.requests, tokensIn: e.tokensIn,
        tokensOut: e.tokensOut, latencyEwma: e.latencyEwma,
        consecutiveFailures: e.consecutiveFailures, lastError: e.lastError,
      };
    }
    return out;
  }

  private effectiveHealth(e: ProviderEntry): ProviderHealth {
    if (e.circuitOpenUntil && Date.now() < e.circuitOpenUntil) return 'offline';
    return e.health;
  }

  private eligible(required?: ProviderCapability[]): ProviderEntry[] {
    const out: ProviderEntry[] = [];
    for (const e of this.entries.values()) {
      if (this.effectiveHealth(e) === 'offline') continue;
      if (required && !required.every((c) => e.provider.capabilities.includes(c))) continue;
      out.push(e);
    }
    return out;
  }

  private async modelFor(e: ProviderEntry, preferredModel?: string): Promise<string> {
    if (preferredModel) return preferredModel;
    if (this.defaultModels[e.provider.id]) return this.defaultModels[e.provider.id] as string;
    const cached = e.modelsCache;
    if (cached && Date.now() - cached.at < 5 * 60_000 && cached.models.length > 0) {
      return cached.models[0] as string;
    }
    try {
      const models = await e.provider.listModels();
      e.modelsCache = { at: Date.now(), models: models.map((m) => m.id) };
      if (models.length > 0) return (models[0] as { id: string }).id;
    } catch {
      // Discovery failed — fall back to configured default below.
    }
    const fallback = this.defaultModels[e.provider.id];
    if (fallback) return fallback;
    throw new ForgeError('MODEL_UNAVAILABLE', `No model known for provider '${e.provider.id}' and discovery failed`);
  }

  async route(req: RouteRequest): Promise<RouteDecision> {
    const strategy = req.strategy ?? this.defaultStrategy;
    const eligible = this.eligible(req.requiredCapabilities);
    if (eligible.length === 0) {
      const states = [...this.entries.values()].map((e) => `${e.provider.id}=${this.effectiveHealth(e)}`).join(', ');
      throw new ForgeError('NO_PROVIDER',
        `No eligible provider available (registered: ${states || 'none'}). Configure a provider or start a local runtime (Ollama/LM Studio).`,
        { details: { requiredCapabilities: req.requiredCapabilities ?? [] } });
    }

    let ordered = [...eligible];
    const reasonParts: string[] = [`strategy=${strategy}`];
    switch (strategy) {
      case 'manual':
        if (!req.preferred) throw new ForgeError('INVALID_INPUT', 'manual strategy requires a preferred provider:model');
        ordered.sort((a, b) => (a.provider.id === req.preferred?.provider ? -1 : 0) - (b.provider.id === req.preferred?.provider ? -1 : 0));
        reasonParts.push(`preferred=${req.preferred.provider}:${req.preferred.model}`);
        break;
      case 'priority':
        reasonParts.push('registration order');
        break;
      case 'lowest_latency':
        ordered.sort((a, b) => (a.latencyEwma ?? 1e9) - (b.latencyEwma ?? 1e9));
        break;
      case 'local_first':
        ordered.sort((a, b) => Number(b.provider.local) - Number(a.provider.local));
        break;
      case 'cloud_first':
        ordered.sort((a, b) => Number(a.provider.local) - Number(b.provider.local));
        break;
      case 'highest_quality':
      case 'lowest_cost': {
        const scored = await Promise.all(ordered.map(async (e) => {
          let model = '';
          try { model = await this.modelFor(e, req.preferred?.provider === e.provider.id ? req.preferred.model : undefined); } catch { model = 'unknown'; }
          return { e, model, tier: modelTier(model) };
        }));
        scored.sort((a, b) => strategy === 'highest_quality' ? b.tier.quality - a.tier.quality : a.tier.cost - b.tier.cost);
        ordered = scored.map((s) => s.e);
        break;
      }
      case 'adaptive':
      default: {
        const score = (e: ProviderEntry): number => {
          let s = 0;
          const h = this.effectiveHealth(e);
          if (h === 'available') s += 100;
          else if (h === 'degraded') s += 40;
          else if (h === 'rate_limited') s += 10;
          s -= Math.min(50, e.consecutiveFailures * 10);
          if (e.latencyEwma !== undefined) s += Math.max(0, 30 - e.latencyEwma / 500);
          if (e.provider.local) s += 5;
          if (req.preferred?.provider === e.provider.id) s += 200;
          return s;
        };
        ordered.sort((a, b) => score(b) - score(a));
        break;
      }
    }

    const chain: RouteCandidate[] = [];
    for (const e of ordered) {
      try {
        const model = await this.modelFor(e, req.preferred?.provider === e.provider.id ? req.preferred.model : undefined);
        chain.push({ providerId: e.provider.id, model });
      } catch {
        // Provider has no resolvable model — skip it in the chain.
      }
    }
    if (chain.length === 0) {
      throw new ForgeError('MODEL_UNAVAILABLE', 'Eligible providers have no resolvable model (discovery failed and no default configured)');
    }
    const primary = chain[0] as RouteCandidate;
    const decision: RouteDecision = {
      providerId: primary.providerId,
      model: primary.model,
      chain: this.fallbackEnabled ? chain : [primary],
      reason: `${reasonParts.join(', ')} → ${primary.providerId}:${primary.model}${chain.length > 1 ? ` (fallbacks: ${chain.slice(1).map((c) => `${c.providerId}:${c.model}`).join(', ')})` : ''}`,
      timeoutMs: this.defaultTimeoutMs,
    };
    this.bus?.emit({
      type: 'model.routed', sessionId: req.sessionId, agentId: req.agentId, taskId: req.taskId,
      data: { strategy, decision },
    });
    return decision;
  }

  /**
   * Route + chat with per-provider retries (exponential backoff) and fallback
   * across the chain. Emits model.requested/started/completed/failed/fallback.
   */
  async chat(routeReq: RouteRequest, chatReq: Omit<ChatRequest, 'model'> & { model?: string }): Promise<ChatResponse> {
    const decision = await this.route(routeReq);
    const chain = chatReq.model
      ? [{ providerId: decision.providerId, model: chatReq.model }, ...decision.chain.slice(1)]
      : decision.chain;
    const errors: { provider: string; model: string; error: string }[] = [];

    this.bus?.emit({
      type: 'model.requested', sessionId: routeReq.sessionId, agentId: routeReq.agentId, taskId: routeReq.taskId,
      data: { chain, messages: chatReq.messages.length, tools: chatReq.tools?.length ?? 0 },
    });

    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i] as RouteCandidate;
      const entry = this.entries.get(candidate.providerId);
      if (!entry) continue;
      if (i > 0) {
        this.bus?.emit({
          type: 'model.fallback', sessionId: routeReq.sessionId, agentId: routeReq.agentId, taskId: routeReq.taskId,
          data: { from: chain[i - 1], to: candidate, previousError: errors[errors.length - 1]?.error },
        });
      }
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) {
          const backoff = Math.min(10_000, this.baseBackoffMs * 2 ** (attempt - 1)) + Math.random() * 200;
          await sleep(backoff);
        }
        this.bus?.emit({
          type: 'model.started', sessionId: routeReq.sessionId, agentId: routeReq.agentId, taskId: routeReq.taskId,
          data: { provider: candidate.providerId, model: candidate.model, attempt },
        });
        try {
          const res = await entry.provider.chat({ ...chatReq, model: candidate.model, timeoutMs: chatReq.timeoutMs ?? decision.timeoutMs });
          this.recordSuccess(entry, res);
          this.bus?.emit({
            type: 'model.completed', sessionId: routeReq.sessionId, agentId: routeReq.agentId, taskId: routeReq.taskId,
            data: { provider: candidate.providerId, model: candidate.model, latencyMs: res.latencyMs, usage: res.usage, simulated: res.simulated || undefined },
          });
          return res;
        } catch (e) {
          const err = e as ForgeError;
          const retryable = err.code === 'RATE_LIMITED' || err.code === 'TIMEOUT' || err.code === 'PROVIDER_ERROR';
          this.bus?.emit({
            type: 'model.failed', sessionId: routeReq.sessionId, agentId: routeReq.agentId, taskId: routeReq.taskId,
            data: { provider: candidate.providerId, model: candidate.model, attempt, error: { code: err.code ?? 'UNKNOWN', message: err.message }, retryable },
          });
          if (!retryable || attempt === this.maxRetries) {
            this.recordFailure(entry, err);
            errors.push({ provider: candidate.providerId, model: candidate.model, error: `${err.code ?? 'UNKNOWN'}: ${err.message}` });
            break;
          }
        }
      }
      if (!this.fallbackEnabled) break;
    }

    throw new ForgeError('MODEL_FAILED',
      `All providers in the fallback chain failed: ${errors.map((e) => `${e.provider}:${e.model} (${e.error})`).join(' → ') || 'no candidates'}`,
      { details: { errors, chain } });
  }

  async refreshHealth(): Promise<Record<string, ProviderHealth>> {
    const out: Record<string, ProviderHealth> = {};
    await Promise.all([...this.entries.values()].map(async (e) => {
      try {
        const h = await e.provider.checkHealth();
        e.health = h.healthy ? (e.consecutiveFailures > 0 ? 'degraded' : 'available') : 'offline';
        if (!h.healthy && h.error) e.lastError = h.error;
        if (h.healthy && h.latencyMs !== undefined) {
          e.latencyEwma = e.latencyEwma === undefined ? h.latencyMs : e.latencyEwma * 0.7 + h.latencyMs * 0.3;
        }
      } catch (err) {
        e.health = 'offline';
        e.lastError = (err as Error).message;
      }
      out[e.provider.id] = this.effectiveHealth(e);
    }));
    return out;
  }

  private recordSuccess(e: ProviderEntry, res: ChatResponse): void {
    e.requests++;
    e.tokensIn += res.usage.inputTokens;
    e.tokensOut += res.usage.outputTokens;
    e.consecutiveFailures = 0;
    e.lastSuccessAt = nowIso();
    e.lastError = undefined;
    e.circuitOpenUntil = undefined;
    e.latencyEwma = e.latencyEwma === undefined ? res.latencyMs : e.latencyEwma * 0.7 + res.latencyMs * 0.3;
    if (e.health === 'offline' || e.health === 'degraded' || e.health === 'rate_limited') e.health = 'available';
  }

  private recordFailure(e: ProviderEntry, err: { code?: string; message: string }): void {
    e.consecutiveFailures++;
    e.lastError = err.message;
    if (err.code === 'RATE_LIMITED') e.health = 'rate_limited';
    else if (e.consecutiveFailures >= 5) {
      e.health = 'offline';
      e.circuitOpenUntil = Date.now() + 60_000; // half-open after 60s
    } else if (e.consecutiveFailures >= 2) {
      e.health = 'degraded';
    }
  }
}
