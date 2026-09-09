#!/usr/bin/env node
/**
 * Forge CLI — thin client over the Core protocol. No agent logic here:
 * it requests operations and renders the Core event stream.
 */
import { ForgeError, type AgentId, type EventEnvelope, type SessionId } from "@forge/protocol";
import { ForgeClient } from "@forge/client";
import { createApp, CoreServer, type ForgeApp } from "@forge/core";

const VERSION = "0.1.0";
const DEFAULT_CORE_URL = process.env.FORGE_CORE_URL ?? "http://127.0.0.1:8710";

function help(): string {
  return `forge ${VERSION} — autonomous coding agents

Usage:
  forge serve [--port 8710] [--host 127.0.0.1]   Start a standalone Core server
  forge run "task" [options]                     Run an agent on a task (streams events)
  forge session list                             List sessions
  forge session resume <id> [--tail 30]          Show session snapshot + recent events
  forge status                                   Core health + session count
  forge agents --session <id>                    List agents in a session
  forge events --session <id> [--after N] [--follow]  Show / follow session events
  forge cancel --agent <id>                      Cancel a running agent

run options:
  --workspace DIR        Workspace root (default: cwd)
  --session ID           Continue an existing session
  --provider NAME        Model provider (default: config/env)
  --model NAME           Model name
  --max-iterations N     Agent iteration budget
  --yes                  Auto-approve approval gates (use with care)
  --no-spawn             Never start an embedded Core; fail if unreachable
  --core URL             Core URL (default: FORGE_CORE_URL or ${DEFAULT_CORE_URL})

Examples:
  forge run "Fix the failing test in this repository"
  forge run "Add input validation to src/api.ts" --workspace ./myrepo
`;
}

type Args = { _: string[]; [k: string]: string | boolean | string[] | undefined };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        out[a.slice(2)] = argv[++i];
      } else {
        out[a.slice(2)] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function flag(args: Args, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" ? v : undefined;
}

let spawned: { app: ForgeApp; server: CoreServer } | null = null;

async function ensureCore(coreUrl: string, opts: { spawn: boolean; autoApprove: boolean }): Promise<ForgeClient> {
  const client = new ForgeClient(coreUrl);
  try {
    await client.health();
    return client;
  } catch {
    if (!opts.spawn) throw new ForgeError("ProviderUnavailable", `core unreachable at ${coreUrl} (--no-spawn)`);
    const parsed = new URL(coreUrl);
    const port = parsed.port ? Number(parsed.port) : 8710;
    const app = createApp({ autoApprove: opts.autoApprove, logLevel: "warn" });
    app.config.port = port;
    app.config.host = "127.0.0.1";
    const server = new CoreServer(app);
    await server.listen();
    spawned = { app, server };
    return new ForgeClient(`http://127.0.0.1:${port}`);
  }
}

async function shutdownSpawned(): Promise<void> {
  if (spawned) {
    await spawned.server.close().catch(() => {});
    spawned = null;
  }
}

/** Compact one-line event renderer for the terminal. */
function renderEvent(e: EventEnvelope): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "agent.started":
      return `[agent] started ${(p.agentId as string).slice(0, 18)}…`;
    case "agent.state_changed":
      return `[agent] ${p.from} → ${p.to}${p.reason ? ` (${String(p.reason).slice(0, 80)})` : ""}`;
    case "agent.progress":
      return `[agent] ${p.message}`;
    case "agent.completed":
      return `[agent] completed in ${p.iterations} iterations`;
    case "agent.failed":
      return `[agent] FAILED: ${p.error}`;
    case "agent.cancelled":
      return `[agent] cancelled: ${p.reason}`;
    case "model.requested":
      return `[model] ${p.provider}/${p.model} requesting…`;
    case "model.completed": {
      const tools = (p.toolCalls as { tool: string }[] | undefined) ?? [];
      return tools.length ? `[model] wants tools: ${tools.map((t) => t.tool).join(", ")}` : "[model] answered";
    }
    case "model.failed":
      return `[model] FAILED: ${p.error}`;
    case "tool.started":
      return `[tool] ${p.tool} → started`;
    case "tool.completed":
      return `[tool] ${p.tool} ✓ ${p.durationMs}ms`;
    case "tool.failed":
      return `[tool] ${p.tool} ✗ ${String(p.error).slice(0, 200)}`;
    case "file.created":
      return `[file] created ${p.path}`;
    case "file.modified":
      return `[file] modified ${p.path}`;
    case "file.deleted":
      return `[file] deleted ${p.path}`;
    case "command.completed":
      return `[cmd] exit ${p.exitCode} in ${p.durationMs}ms: ${String(p.command).slice(0, 100)}`;
    case "command.failed":
      return `[cmd] FAILED exit ${p.exitCode}: ${String(p.command).slice(0, 100)}`;
    case "test.started":
      return `[test] running: ${p.command}`;
    case "test.passed":
      return `[test] PASSED (${p.durationMs}ms)`;
    case "test.failed":
      return `[test] FAILED: ${String(p.summary ?? "").slice(0, 200)}`;
    case "message.user":
      return `[you] ${String(p.content).slice(0, 300)}`;
    case "message.agent":
      return null; // printed in full at completion
    case "approval.requested":
      return `[approval] ${p.tool} needs approval: ${p.reason} (id: ${p.approvalId})`;
    case "approval.resolved":
      return `[approval] ${p.approved ? "approved" : "denied"} (${p.approvalId})`;
    default:
      return null; // model.stream / tool.output / command.output are too noisy for line mode
  }
}

async function cmdRun(task: string, args: Args): Promise<number> {
  const coreUrl = flag(args, "core") ?? DEFAULT_CORE_URL;
  const client = await ensureCore(coreUrl, { spawn: args["no-spawn"] !== true, autoApprove: args.yes === true });
  const sessionIdFlag = flag(args, "session");
  let sessionId: SessionId;
  if (sessionIdFlag) {
    sessionId = sessionIdFlag as SessionId;
    await client.getSession(sessionId); // validates
    console.log(`continuing session ${sessionId}`);
  } else {
    const session = await client.createSession({
      workspaceRoot: flag(args, "workspace") ?? process.cwd(),
      ...(flag(args, "provider") ? { provider: flag(args, "provider")! } : {}),
      ...(flag(args, "model") ? { model: flag(args, "model")! } : {}),
      ...(flag(args, "max-iterations") ? { maxIterations: Number(flag(args, "max-iterations")) } : {}),
    });
    sessionId = session.id;
    console.log(`session ${sessionId} @ ${session.workspaceRoot}`);
  }

  // Subscribe BEFORE sending so no events are missed on fast runs.
  let streamOpen = false;
  let myAgent: string | null = null;
  const sub = client.subscribe(sessionId, (e) => {
    if (e.type === "model.stream") {
      // Rolling window chunks would duplicate on print; show one marker instead.
      // (Full live text is available in the GUI clients.)
      if (!streamOpen) {
        console.log("[model] streaming…");
        streamOpen = true;
      }
      return;
    }
    streamOpen = false;
    const line = renderEvent(e);
    if (line) console.log(line);
    if (e.type === "message.agent" && (e.payload as { agentId?: string }).agentId === myAgent) {
      console.log(`\n${(e.payload as { content: string }).content}\n`);
    }
  });
  // Give the socket a moment to establish before the run starts.
  await new Promise((r) => setTimeout(r, 300));

  const { agentId } = await client.sendMessage(sessionId, task);
  myAgent = agentId;
  console.log(`agent ${agentId} — streaming events (Ctrl-C to cancel)\n`);

  const terminal = await waitForAgent(client, sessionId, agentId, async () => {
    // On SIGINT: cancel the agent, then resolve when it terminates.
    try {
      await client.cancelAgent(agentId, "cancelled from CLI (SIGINT)");
    } catch {
      /* already done */
    }
  });
  // Drain trailing events (terminal state is polled; the stream lags slightly).
  for (let i = 0; i < 20; i++) {
    try {
      const s = await client.getSession(sessionId);
      if (sub.lastSeq >= s.lastSeq) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  sub.close();

  if (terminal === "completed") {
    const state = await client.getSessionState(sessionId);
    const last = [...state.snapshot.messages].reverse().find((m) => m.role === "agent");
    if (last) console.log(`\nDone. Session: ${sessionId}\n`);
    await shutdownSpawned();
    return 0;
  }
  await shutdownSpawned();
  return terminal === "cancelled" ? 130 : 1;
}

async function waitForAgent(
  client: ForgeClient,
  _sessionId: SessionId,
  agentId: AgentId,
  onSigint: () => Promise<void>,
): Promise<string> {
  void _sessionId;
  let state = "";
  let sigint = false;
  const handler = (): void => {
    if (!sigint) {
      sigint = true;
      console.log("\ncancelling… (press Ctrl-C again to force)");
      void onSigint();
    } else {
      console.log("\nforced exit");
      process.exit(130);
    }
  };
  process.on("SIGINT", handler);
  try {
    for (;;) {
      try {
        const agent = await client.getAgent(agentId);
        state = agent.state;
      } catch {
        state = "";
      }
      if (state === "completed" || state === "failed" || state === "cancelled") return state;
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    process.off("SIGINT", handler);
  }
}

async function cmdServe(args: Args): Promise<number> {
  const app = createApp({ autoApprove: process.env.FORGE_AUTO_APPROVE === "1" });
  if (flag(args, "port")) app.config.port = Number(flag(args, "port"));
  if (flag(args, "host")) app.config.host = flag(args, "host")!;
  const server = new CoreServer(app);
  const { url } = await server.listen();
  console.log(`forge-core ${url} (protocol 1.0) — Ctrl-C to stop`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void server.close().then(() => resolve());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

async function cmdSession(args: Args): Promise<number> {
  const client = await ensureCore(flag(args, "core") ?? DEFAULT_CORE_URL, { spawn: false, autoApprove: false });
  const sub = args._[1];
  if (sub === "list") {
    const { sessions } = await client.listSessions();
    if (!sessions.length) {
      console.log("no sessions");
      return 0;
    }
    for (const s of sessions) {
      console.log(`${s.id}  ${s.title}  @ ${s.workspaceRoot}  (updated ${s.updatedAt})`);
    }
    return 0;
  }
  if (sub === "resume") {
    const id = args._[2] as SessionId;
    if (!id) {
      console.error("usage: forge session resume <id>");
      return 2;
    }
    const { snapshot, events } = await client.resumeSession(id);
    console.log(`session ${snapshot.session.id} — ${snapshot.session.title}`);
    console.log(`workspace: ${snapshot.session.workspaceRoot}`);
    console.log(`agents: ${snapshot.agents.map((a) => `${a.id.slice(0, 14)}…(${a.state})`).join(", ") || "none"}`);
    console.log(`messages: ${snapshot.messages.length}  lastSeq: ${snapshot.lastSeq}`);
    const tail = Number(flag(args, "tail") ?? 30);
    console.log(`\nlast ${Math.min(tail, events.length)} events:`);
    for (const e of events.slice(-tail)) {
      console.log(`  #${e.seq} ${e.type}`);
    }
    return 0;
  }
  console.error(help());
  return 2;
}

async function cmdStatus(args: Args): Promise<number> {
  const client = await ensureCore(flag(args, "core") ?? DEFAULT_CORE_URL, { spawn: false, autoApprove: false });
  const h = await client.health();
  const { sessions } = await client.listSessions(5);
  console.log(`core ${h.version} protocol=${h.protocol} uptime=${Math.round(h.uptimeMs / 1000)}s sessions~${sessions.length >= 5 ? "5+" : sessions.length}`);
  return 0;
}

async function cmdAgents(args: Args): Promise<number> {
  const sessionId = flag(args, "session") as SessionId | undefined;
  if (!sessionId) {
    console.error("usage: forge agents --session <id>");
    return 2;
  }
  const client = await ensureCore(flag(args, "core") ?? DEFAULT_CORE_URL, { spawn: false, autoApprove: false });
  const { snapshot } = await client.getSessionState(sessionId);
  for (const a of snapshot.agents) {
    console.log(`${a.id}  ${a.name}  ${a.state}  progress=${a.progress.toFixed(2)}  tools=${a.metrics.toolCalls}  model=${a.model}`);
  }
  return 0;
}

async function cmdEvents(args: Args): Promise<number> {
  const sessionId = flag(args, "session") as SessionId | undefined;
  if (!sessionId) {
    console.error("usage: forge events --session <id> [--after N] [--follow]");
    return 2;
  }
  const client = await ensureCore(flag(args, "core") ?? DEFAULT_CORE_URL, { spawn: false, autoApprove: false });
  const after = Number(flag(args, "after") ?? 0);
  if (args.follow === true) {
    console.log(`following ${sessionId} from seq ${after} (Ctrl-C to stop)`);
    const sub = client.subscribe(sessionId, (e) => {
      const line = renderEvent(e) ?? `#${e.seq} ${e.type}`;
      console.log(line);
    }, { afterSeq: after });
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        sub.close();
        resolve();
      });
    });
    return 0;
  }
  const { events } = await client.getSessionState(sessionId, after);
  for (const e of events) {
    console.log(`#${e.seq} ${e.ts} ${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`);
  }
  return 0;
}

async function cmdCancel(args: Args): Promise<number> {
  const agentId = flag(args, "agent") as AgentId | undefined;
  if (!agentId) {
    console.error("usage: forge cancel --agent <id>");
    return 2;
  }
  const client = await ensureCore(flag(args, "core") ?? DEFAULT_CORE_URL, { spawn: false, autoApprove: false });
  const r = await client.cancelAgent(agentId, "cancelled from CLI");
  console.log(r.cancelled ? "cancelled" : "agent was not running");
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(help());
        return 0;
      case "--version":
      case "version":
        console.log(VERSION);
        return 0;
      case "serve":
        return await cmdServe(args);
      case "run": {
        const task = args._[1];
        if (!task) {
          console.error('usage: forge run "task"');
          return 2;
        }
        return await cmdRun(task, args);
      }
      case "session":
        return await cmdSession(args);
      case "status":
        return await cmdStatus(args);
      case "agents":
        return await cmdAgents(args);
      case "events":
        return await cmdEvents(args);
      case "cancel":
        return await cmdCancel(args);
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.error(help());
        return 2;
    }
  } catch (e) {
    if (ForgeError.isForgeError(e)) {
      console.error(`error [${e.code}]: ${e.message}`);
    } else {
      console.error(`error: ${(e as Error).message}`);
    }
    await shutdownSpawned();
    return 1;
  }
}

process.exit(await main());
