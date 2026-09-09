import type { Agent, Session } from "@forge/protocol";
import { type ForgeConfig, loadConfig } from "./config.ts";
import { EventBus } from "./eventBus.ts";
import { registerExecTools } from "./execTools.ts";
import { registerFsTools } from "./fsTools.ts";
import { getLogger, type Logger } from "./logger.ts";
import { AgentRuntime } from "./agentLoop.ts";
import { createProvider, type ModelProvider } from "./models.ts";
import { SessionManager } from "./session.ts";
import { Store } from "./store.ts";
import { ToolRegistry } from "./toolRegistry.ts";

export interface AppOpts {
  config?: Partial<ForgeConfig>;
  dataDir?: string;
  dbFilename?: string;
  autoApprove?: boolean;
  getProvider?: (session: Session, agent: Agent) => ModelProvider;
  logLevel?: ForgeConfig["logLevel"];
}

export interface ForgeApp {
  config: ForgeConfig;
  log: Logger;
  store: Store;
  bus: EventBus;
  registry: ToolRegistry;
  runtime: AgentRuntime;
  sessions: SessionManager;
  close: () => void;
}

/** Assemble the full Forge Core (used by the server, CLI, and tests). */
export function createApp(opts: AppOpts = {}): ForgeApp {
  const config = loadConfig({ ...opts.config, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
  if (opts.logLevel) config.logLevel = opts.logLevel;
  const log = getLogger(config.logLevel);
  const store = new Store(config.dataDir, opts.dbFilename);
  const bus = new EventBus(store, log);
  const registry = new ToolRegistry(config);
  registerFsTools(registry);
  registerExecTools(registry);
  const runtime = new AgentRuntime({
    store, bus, registry, config, log,
    autoApprove: opts.autoApprove,
    getProvider: opts.getProvider ?? ((session: Session, _agent: Agent) => createProvider(session.config.provider, config, log)),
  });
  const sessions = new SessionManager(store, bus, runtime, config, log);
  return { config, log, store, bus, registry, runtime, sessions, close: () => store.close() };
}
