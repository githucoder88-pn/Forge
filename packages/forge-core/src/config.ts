/**
 * Layered configuration: defaults < global < project < env < session overrides.
 * Never hardcode API keys — providers read credentials from env / OS keychain
 * (via explicit env vars in this implementation).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ForgeError } from './errors.js';
import type { AutonomyLevel, ApprovalPolicy } from './permissions.js';
import type { RoutingStrategy } from './router.js';

export interface ModelRef {
  provider: string;
  model: string;
}

export interface ProviderConfig {
  /** e.g. openai-compatible | anthropic | google | ollama | lmstudio | custom */
  kind: string;
  baseUrl?: string;
  /** Name of the env var holding the API key (key itself is never stored). */
  apiKeyEnv?: string;
  models?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  enabled?: boolean;
  /** Static capability hint when discovery is unavailable. */
  capabilities?: string[];
}

export interface ForgeConfig {
  project?: { name?: string; root?: string };
  orchestration?: {
    mode?: 'solo' | 'supervisor' | 'parallel' | 'pipeline' | 'debate' | 'review-loop' | 'swarm' | 'company';
    maxAgents?: number;
    maxParallelTasks?: number;
    maxParallelTools?: number;
    maxQueueSize?: number;
    defaultTimeoutMs?: number;
    maxIterations?: number;
  };
  models?: { primary?: ModelRef; fast?: ModelRef; reviewer?: ModelRef; fallbackChain?: ModelRef[] };
  providers?: Record<string, ProviderConfig>;
  routing?: {
    strategy?: RoutingStrategy;
    fallback?: boolean;
    costAware?: boolean;
    latencyAware?: boolean;
    localFirst?: boolean;
  };
  autonomy?: { default?: AutonomyLevel; approvalPolicy?: ApprovalPolicy };
  permissions?: {
    allowedRoots?: string[];
    deniedPaths?: string[];
    allowUnrestrictedShell?: boolean;
    approvalTimeoutMs?: number;
  };
  performance?: {
    lowResourceMode?: boolean;
    maxParallelAgents?: number;
    maxContextCacheMb?: number;
    backgroundIndexing?: boolean;
    localEmbeddings?: boolean;
    verboseEvents?: boolean;
  };
  session?: { persist?: boolean; storePath?: string };
}

export const DEFAULT_CONFIG: Required<Pick<ForgeConfig, 'orchestration' | 'routing' | 'autonomy' | 'performance'>> & ForgeConfig = {
  orchestration: {
    mode: 'solo',
    maxAgents: 8,
    maxParallelTasks: 4,
    maxParallelTools: 4,
    maxQueueSize: 256,
    defaultTimeoutMs: 120_000,
    maxIterations: 25,
  },
  routing: { strategy: 'adaptive', fallback: true, costAware: true, latencyAware: true, localFirst: false },
  autonomy: { default: 'workspace-write', approvalPolicy: 'on-risky-commands' },
  performance: {
    lowResourceMode: false,
    maxParallelAgents: 4,
    maxContextCacheMb: 256,
    backgroundIndexing: true,
    localEmbeddings: false,
    verboseEvents: true,
  },
  providers: {
    // Local-first defaults; cloud providers activate when their key env var exists.
    ollama: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true },
    lmstudio: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
    openai: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', enabled: true },
    anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', enabled: true },
    google: { kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'GOOGLE_API_KEY', enabled: true },
    openrouter: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', enabled: true },
  },
};

const CONFIG_FILENAMES = ['forge.yaml', 'forge.yml', 'forge.json', '.forge.yaml', '.forge.json'];

export function globalConfigDir(): string {
  return process.env.FORGE_HOME || join(homedir(), '.forge');
}

export function findConfigFile(dir: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const direct = join(dir, name);
    if (existsSync(direct)) return direct;
    const nested = join(dir, '.forge', name);
    if (existsSync(nested)) return nested;
  }
  return undefined;
}

export function parseConfigFile(path: string): Partial<ForgeConfig> {
  const raw = readFileSync(path, 'utf8');
  try {
    if (path.endsWith('.json')) return JSON.parse(raw) as Partial<ForgeConfig>;
    return (parseYaml(raw) as Partial<ForgeConfig>) ?? {};
  } catch (e) {
    throw new ForgeError('CONFIG_ERROR', `Failed to parse config file ${path}: ${(e as Error).message}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge b into a (arrays replaced, records merged). */
export function mergeConfig<T>(a: T, b: Partial<T>): T {
  if (!isRecord(a) || !isRecord(b)) return (b as T) ?? a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isRecord(prev) && isRecord(v) ? mergeConfig(prev, v) : v;
  }
  return out as T;
}

export interface LoadedConfig {
  config: ForgeConfig;
  files: string[];
}

/**
 * Load layered config. Env overrides (highest precedence below session):
 * FORGE_AUTONOMY, FORGE_APPROVAL_POLICY, FORGE_STRATEGY, FORGE_MAX_AGENTS,
 * FORGE_LOW_RESOURCE, FORGE_STORE_PATH, FORGE_MODEL (provider:model).
 */
export function loadConfig(projectDir?: string): LoadedConfig {
  let merged = structuredClone(DEFAULT_CONFIG) as ForgeConfig;
  const files: string[] = [];

  const globalFile = findConfigFile(globalConfigDir());
  if (globalFile) {
    merged = mergeConfig(merged, parseConfigFile(globalFile));
    files.push(globalFile);
  }
  if (projectDir) {
    const projectFile = findConfigFile(projectDir);
    if (projectFile) {
      merged = mergeConfig(merged, parseConfigFile(projectFile));
      files.push(projectFile);
    }
  }

  const env = process.env;
  const overrides: Partial<ForgeConfig> = {};
  if (env.FORGE_AUTONOMY) overrides.autonomy = { default: env.FORGE_AUTONOMY as AutonomyLevel };
  if (env.FORGE_APPROVAL_POLICY) {
    overrides.autonomy = { ...(overrides.autonomy ?? {}), approvalPolicy: env.FORGE_APPROVAL_POLICY as ApprovalPolicy };
  }
  if (env.FORGE_STRATEGY) overrides.routing = { strategy: env.FORGE_STRATEGY as RoutingStrategy };
  if (env.FORGE_MAX_AGENTS) overrides.orchestration = { maxAgents: Number(env.FORGE_MAX_AGENTS) };
  if (env.FORGE_LOW_RESOURCE) overrides.performance = { lowResourceMode: env.FORGE_LOW_RESOURCE === '1' || env.FORGE_LOW_RESOURCE === 'true' };
  if (env.FORGE_STORE_PATH) overrides.session = { persist: true, storePath: env.FORGE_STORE_PATH };
  if (env.FORGE_MODEL) {
    const [provider, ...rest] = env.FORGE_MODEL.split(':');
    if (provider && rest.length > 0) overrides.models = { primary: { provider, model: rest.join(':') } };
  }
  merged = mergeConfig(merged, overrides);

  if (merged.performance?.lowResourceMode) {
    merged = mergeConfig(merged, {
      orchestration: { maxParallelTasks: 2 },
      performance: { maxParallelAgents: 2, verboseEvents: false, backgroundIndexing: false },
    });
  }
  return { config: merged, files };
}

export function applySessionOverrides(config: ForgeConfig, overrides: Partial<ForgeConfig>): ForgeConfig {
  return mergeConfig(structuredClone(config), overrides);
}

/** Resolve an API key by env var name. Returns undefined when absent (never throws). */
export function resolveApiKey(envVar?: string): string | undefined {
  if (!envVar) return undefined;
  const v = process.env[envVar];
  return v && v.length > 0 ? v : undefined;
}
