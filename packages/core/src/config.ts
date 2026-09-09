import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ResourceLimits } from "@forge/protocol";

export interface ForgeConfig {
  port: number;
  host: string;
  dataDir: string;
  provider: string;
  model: string;
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  limits: ResourceLimits;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  maxConcurrentTools: 4,
  maxShellProcesses: 4,
  maxOutputBytes: 512_000,
  maxModelRequestBytes: 1_000_000,
  maxAgentRuntimeMs: 30 * 60_000,
  commandTimeoutMs: 120_000,
  maxIterations: 40,
  maxFileBytes: 1_000_000,
  maxSearchResults: 100,
};

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function defaultDataDir(): string {
  return process.env.FORGE_DATA_DIR ?? join(homedir(), ".forge");
}

/** Load config: defaults <- forge.config.json (cwd or dataDir) <- env vars. Never logs secrets. */
export function loadConfig(overrides?: Partial<ForgeConfig>): ForgeConfig {
  let fileCfg: Record<string, unknown> = {};
  for (const p of [join(process.cwd(), "forge.config.json"), join(defaultDataDir(), "forge.config.json")]) {
    try {
      if (existsSync(p)) fileCfg = { ...fileCfg, ...JSON.parse(readFileSync(p, "utf8")) };
    } catch {
      /* ignore malformed config file; env still applies */
    }
  }
  const env = process.env;
  const fileLimits = (fileCfg.limits ?? {}) as Partial<ResourceLimits>;
  const cfg: ForgeConfig = {
    port: num(env.FORGE_PORT, (fileCfg.port as number) ?? 8710),
    host: env.FORGE_HOST ?? (fileCfg.host as string) ?? "127.0.0.1",
    dataDir: defaultDataDir(),
    provider: env.FORGE_PROVIDER ?? (fileCfg.provider as string) ?? "openai",
    model: env.FORGE_MODEL ?? (fileCfg.model as string) ?? "gpt-4o-mini",
    openaiApiKey: env.OPENAI_API_KEY ?? null,
    openaiBaseUrl: env.OPENAI_BASE_URL ?? (fileCfg.openaiBaseUrl as string) ?? "https://api.openai.com/v1",
    logLevel: (env.FORGE_LOG_LEVEL as ForgeConfig["logLevel"]) ?? (fileCfg.logLevel as ForgeConfig["logLevel"]) ?? "info",
    limits: {
      maxConcurrentTools: num(env.FORGE_MAX_TOOLS, fileLimits.maxConcurrentTools ?? DEFAULT_LIMITS.maxConcurrentTools),
      maxShellProcesses: num(env.FORGE_MAX_SHELL, fileLimits.maxShellProcesses ?? DEFAULT_LIMITS.maxShellProcesses),
      maxOutputBytes: num(env.FORGE_MAX_OUTPUT, fileLimits.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes),
      maxModelRequestBytes: num(env.FORGE_MAX_REQ, fileLimits.maxModelRequestBytes ?? DEFAULT_LIMITS.maxModelRequestBytes),
      maxAgentRuntimeMs: num(env.FORGE_MAX_RUNTIME, fileLimits.maxAgentRuntimeMs ?? DEFAULT_LIMITS.maxAgentRuntimeMs),
      commandTimeoutMs: num(env.FORGE_CMD_TIMEOUT, fileLimits.commandTimeoutMs ?? DEFAULT_LIMITS.commandTimeoutMs),
      maxIterations: num(env.FORGE_MAX_ITERS, fileLimits.maxIterations ?? DEFAULT_LIMITS.maxIterations),
      maxFileBytes: num(env.FORGE_MAX_FILE, fileLimits.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes),
      maxSearchResults: num(env.FORGE_MAX_SEARCH, fileLimits.maxSearchResults ?? DEFAULT_LIMITS.maxSearchResults),
    },
  };
  return { ...cfg, ...overrides, limits: { ...cfg.limits, ...overrides?.limits } };
}
