/**
 * Tool runtime. Every agent capability is a registered tool with a schema,
 * permission requirements, timeout, cancellation, structured results and
 * telemetry. All workspace mutation flows through here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { platform, arch, cpus, totalmem, freemem } from 'node:os';
import { AgentId, SessionId, TaskId, ToolCallId, toolCallId } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import { Workspace } from './workspace.js';
import { ApprovalGate, ApprovalPolicy, AutonomyLevel, autonomyGte, classifyCommand, redactSecrets } from './permissions.js';

// ---------------------------------------------------------------- schemas ---

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
}

/** Minimal JSON-schema-subset validator with default injection. */
export function validateInput(schema: JsonSchema, input: unknown): { value: unknown; errors: string[] } {
  const errors: string[] = [];
  const walk = (s: JsonSchema, v: unknown, path: string): unknown => {
    if (v === undefined) {
      if (s.default !== undefined) return s.default;
      return undefined;
    }
    if (s.enum && !s.enum.includes(v)) {
      errors.push(`${path}: value not in enum ${JSON.stringify(s.enum)}`);
      return v;
    }
    switch (s.type) {
      case 'object': {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) { errors.push(`${path}: expected object`); return v; }
        const obj = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, sub] of Object.entries(s.properties ?? {})) {
          const val = walk(sub, obj[k], path ? `${path}.${k}` : k);
          if (val !== undefined) out[k] = val;
        }
        if (s.additionalProperties === false) {
          for (const k of Object.keys(obj)) {
            if (!s.properties || !(k in s.properties)) errors.push(`${path ? `${path}.${k}` : k}: unexpected property`);
          }
        } else {
          for (const [k, val] of Object.entries(obj)) if (!(k in out)) out[k] = val;
        }
        for (const req of s.required ?? []) {
          if (out[req] === undefined) errors.push(`${path ? `${path}.${req}` : req}: required`);
        }
        return out;
      }
      case 'array': {
        if (!Array.isArray(v)) { errors.push(`${path}: expected array`); return v; }
        return s.items ? v.map((item, i) => walk(s.items as JsonSchema, item, `${path}[${i}]`)) : v;
      }
      case 'string':
        if (typeof v !== 'string') errors.push(`${path}: expected string`);
        return v;
      case 'number':
        if (typeof v !== 'number') errors.push(`${path}: expected number`);
        return v;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) errors.push(`${path}: expected integer`);
        return v;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`${path}: expected boolean`);
        return v;
      default:
        return v;
    }
  };
  const value = walk(schema, input ?? {}, '');
  return { value, errors };
}

/** Convert a Forge JsonSchema to provider-agnostic JSON Schema for tool calling. */
export function toJsonSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) props[k] = toJsonSchema(v);
    out.properties = props;
  }
  if (schema.required) out.required = schema.required;
  if (schema.additionalProperties === false) out.additionalProperties = false;
  if (schema.items) out.items = toJsonSchema(schema.items);
  return out;
}

// ------------------------------------------------------------------ types ---

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Minimum autonomy required to invoke. */
  minAutonomy: AutonomyLevel;
  timeoutMs?: number;
  mutating?: boolean;
}

export interface ToolOutputChunk {
  stream: 'stdout' | 'stderr' | 'log';
  text: string;
}

export interface ToolContextBase {
  sessionId?: SessionId;
  agentId?: AgentId;
  taskId?: TaskId;
  workspace: Workspace;
  autonomy: AutonomyLevel;
  policy: ApprovalPolicy;
  gate: ApprovalGate;
  bus?: EventBus;
  signal?: AbortSignal;
  onOutput?: (chunk: ToolOutputChunk) => void;
  verboseEvents?: boolean;
  defaultTimeoutMs?: number;
}

export interface ToolContext extends ToolContextBase {
  callId: ToolCallId;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

interface ActiveCall {
  id: ToolCallId;
  name: string;
  controller: AbortController;
  startedAt: number;
}

// ---------------------------------------------------------------- registry ---

export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();
  private handlers = new Map<string, ToolHandler>();
  private active = new Map<string, ActiveCall>();

  register(def: ToolDefinition, handler: ToolHandler): void {
    if (this.defs.has(def.name)) throw new ForgeError('ALREADY_EXISTS', `Tool already registered: ${def.name}`);
    this.defs.set(def.name, def);
    this.handlers.set(def.name, handler);
  }

  has(name: string): boolean { return this.defs.has(name); }
  get(name: string): ToolDefinition {
    const d = this.defs.get(name);
    if (!d) throw new ForgeError('NOT_FOUND', `Unknown tool: ${name}`);
    return d;
  }
  list(): ToolDefinition[] { return [...this.defs.values()]; }

  activeCalls(): { id: string; name: string; startedAt: number }[] {
    return [...this.active.values()].map((c) => ({ id: c.id, name: c.name, startedAt: c.startedAt }));
  }

  cancelCall(id: string): boolean {
    const call = this.active.get(id);
    if (!call) return false;
    call.controller.abort();
    return true;
  }

  async invoke(name: string, rawInput: unknown, base: ToolContextBase): Promise<ToolResult> {
    const def = this.get(name);
    const handler = this.handlers.get(name) as ToolHandler;
    const startedAt = Date.now();
    const id = toolCallId();

    if (!autonomyGte(base.autonomy, def.minAutonomy)) {
      return this.fail(base, id, name, startedAt, new ForgeError('PERMISSION_DENIED',
        `Tool ${name} requires autonomy '${def.minAutonomy}' (agent has '${base.autonomy}')`));
    }

    const { value, errors } = validateInput(def.inputSchema, rawInput);
    if (errors.length > 0) {
      return this.fail(base, id, name, startedAt, new ForgeError('INVALID_INPUT', `Invalid input for ${name}: ${errors.join('; ')}`));
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    base.signal?.addEventListener('abort', onAbort, { once: true });
    this.active.set(id, { id, name, controller, startedAt });

    const ctx: ToolContext = { ...base, callId: id, signal: anySignal(base.signal, controller.signal) };
    base.bus?.emit({
      type: 'tool.started', sessionId: base.sessionId, agentId: base.agentId, taskId: base.taskId,
      data: { callId: id, tool: name, input: redactValue(value) },
    });

    const timeoutMs = def.timeoutMs ?? base.defaultTimeoutMs ?? 120_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ForgeError('TIMEOUT', `Tool ${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      const result = await Promise.race([handler(value as Record<string, unknown>, ctx), timeout]);
      return this.done(base, id, name, startedAt, result);
    } catch (e) {
      const err = e instanceof ForgeError ? e : new ForgeError('TOOL_FAILED', (e as Error).message ?? String(e), { cause: e });
      const cancelled = controller.signal.aborted && (base.signal?.aborted || err.code === 'TIMEOUT');
      return this.fail(base, id, name, startedAt, err, { timedOut: err.code === 'TIMEOUT', cancelled });
    } finally {
      if (timer) clearTimeout(timer);
      base.signal?.removeEventListener('abort', onAbort);
      this.active.delete(id);
    }
  }

  private done(base: ToolContextBase, id: ToolCallId, name: string, startedAt: number, result: unknown): ToolResult {
    const durationMs = Date.now() - startedAt;
    const safe = redactValue(result);
    base.bus?.emit({
      type: 'tool.completed', sessionId: base.sessionId, agentId: base.agentId, taskId: base.taskId,
      data: { callId: id, tool: name, durationMs, result: truncate(safe) },
    });
    return { ok: true, result: safe, durationMs };
  }

  private fail(base: ToolContextBase, id: ToolCallId, name: string, startedAt: number, err: ForgeError, extra?: { timedOut?: boolean; cancelled?: boolean }): ToolResult {
    const durationMs = Date.now() - startedAt;
    base.bus?.emit({
      type: 'tool.failed', sessionId: base.sessionId, agentId: base.agentId, taskId: base.taskId,
      data: { callId: id, tool: name, durationMs, error: { code: err.code, message: err.message } },
    });
    return { ok: false, error: { code: err.code, message: err.message }, durationMs, timedOut: extra?.timedOut, cancelled: extra?.cancelled };
  }
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { c.abort(); break; }
    s.addEventListener('abort', () => c.abort(), { once: true });
  }
  return c.signal;
}

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(val);
    return out;
  }
  return v;
}

function truncate(v: unknown, max = 4000): unknown {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= max) return v;
  return { __truncated: true, preview: s.slice(0, max) };
}

// ------------------------------------------------------------ processes ---

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  cwd: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ProcessOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onOutput?: (chunk: ToolOutputChunk) => void;
}

/** Spawn without a shell (preferred for git and other argv-style commands). */
/** Child processes must never inherit our test-runner context (it would make nested `node --test` runs vacuous). */
function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(extra ?? {}) };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function runProcess(file: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const maxBytes = opts.maxOutputBytes ?? 2 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, timedOut: boolean, cancelled: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, signal, durationMs: Date.now() - startedAt, cwd: opts.cwd, timedOut, cancelled });
    };

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: childEnv(opts.env),
        windowsHide: true,
      });
    } catch (e) {
      resolvePromise({ stdout: '', stderr: (e as Error).message, exitCode: null, signal: null, durationMs: Date.now() - startedAt, cwd: opts.cwd, timedOut: false, cancelled: false });
      return;
    }

    const timer = opts.timeoutMs ? setTimeout(() => { killTree(child); finish(null, 'SIGTERM', true, false); }, opts.timeoutMs) : undefined;
    timer?.unref?.();
    opts.signal?.addEventListener('abort', () => { killTree(child); finish(null, 'SIGTERM', false, true); }, { once: true });

    const append = (which: 'stdout' | 'stderr', text: string): void => {
      if (which === 'stdout') {
        if (stdout.length < maxBytes) stdout += text.slice(0, maxBytes - stdout.length);
      } else {
        if (stderr.length < maxBytes) stderr += text.slice(0, maxBytes - stderr.length);
      }
      opts.onOutput?.({ stream: which, text });
    };
    child.stdout?.on('data', (d: Buffer) => append('stdout', d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => append('stderr', d.toString('utf8')));
    child.on('error', (e) => finish(null, null, false, false) ?? resolvePromise({
      stdout, stderr: stderr + (e.message ?? String(e)), exitCode: 127, signal: null,
      durationMs: Date.now() - startedAt, cwd: opts.cwd, timedOut: false, cancelled: false,
    }));
    child.on('close', (code, sig) => finish(code, sig, false, false));
  });
}

/** Spawn through the system shell (for agent-authored commands). */
export function runShell(command: string, opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const maxBytes = opts.maxOutputBytes ?? 2 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, timedOut: boolean, cancelled: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, signal, durationMs: Date.now() - startedAt, cwd: opts.cwd, timedOut, cancelled });
    };
    const shell = process.platform === 'win32' ? true : '/bin/sh';
    const child = spawn(command, {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      shell: shell as unknown as string,
      windowsHide: true,
    });
    const timer = opts.timeoutMs ? setTimeout(() => { killTree(child); finish(null, 'SIGTERM', true, false); }, opts.timeoutMs) : undefined;
    timer?.unref?.();
    opts.signal?.addEventListener('abort', () => { killTree(child); finish(null, 'SIGTERM', false, true); }, { once: true });
    const append = (which: 'stdout' | 'stderr', text: string): void => {
      if (which === 'stdout') stdout += text.slice(0, Math.max(0, maxBytes - stdout.length));
      else stderr += text.slice(0, Math.max(0, maxBytes - stderr.length));
      opts.onOutput?.({ stream: which, text });
    };
    child.stdout?.on('data', (d: Buffer) => append('stdout', d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => append('stderr', d.toString('utf8')));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr: stderr + (e.message ?? String(e)), exitCode: 127, signal: null, durationMs: Date.now() - startedAt, cwd: opts.cwd, timedOut: false, cancelled: false });
    });
    child.on('close', (code, sig) => finish(code, sig, false, false));
  });
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM');
    } else {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 2000).unref?.();
    }
  } catch { /* already dead */ }
}

// ---------------------------------------------------------- builtin tools ---

const str = (description: string, extra?: Partial<JsonSchema>): JsonSchema => ({ type: 'string', description, ...extra });
const bool = (description: string, def?: boolean): JsonSchema => ({ type: 'boolean', description, default: def });
const int = (description: string, def?: number): JsonSchema => ({ type: 'integer', description, default: def });

function wsOf(ctx: ToolContext): Workspace {
  return ctx.workspace.scope(ctx.agentId, ctx.taskId);
}

async function gateShellCommand(command: string, ctx: ToolContext): Promise<void> {
  const { risk, reasons } = classifyCommand(command);
  if (risk === 'prohibited' && ctx.autonomy !== 'unrestricted') {
    throw new ForgeError('PERMISSION_DENIED', `Prohibited command blocked (${reasons.join(', ')}). Prohibited commands require 'unrestricted' autonomy plus explicit approval.`, {
      details: { command: command.slice(0, 500), risk, reasons },
    });
  }
  const needs = ctx.gate.needsApproval(command, ctx.policy, risk);
  if (!needs) {
    ctx.gate.markSeen(command);
    return;
  }
  ctx.bus?.emit({
    type: 'approval.requested', sessionId: ctx.sessionId, agentId: ctx.agentId, taskId: ctx.taskId,
    data: { kind: 'command', summary: command.slice(0, 500), risk, reasons },
  });
  const approved = await ctx.gate.request({
    agentId: ctx.agentId, kind: 'command',
    summary: command.slice(0, 500),
    detail: { command, risk, reasons, cwd: ctx.workspace.root },
    risk,
  });
  ctx.bus?.emit({
    type: 'approval.resolved', sessionId: ctx.sessionId, agentId: ctx.agentId, taskId: ctx.taskId,
    data: { kind: 'command', approved, risk },
  });
  if (!approved) {
    throw new ForgeError('APPROVAL_DENIED', `Command denied by approval gate: ${command.slice(0, 200)}`, {
      details: { command: command.slice(0, 500), risk, reasons },
    });
  }
  ctx.gate.markSeen(command);
}

/** Create a registry pre-loaded with the full built-in toolset. */
export function createToolRegistry(): ToolRegistry {
  const r = new ToolRegistry();

  r.register(
    { name: 'read_file', description: 'Read a UTF-8 text file from the workspace.', minAutonomy: 'read-only', inputSchema: { type: 'object', required: ['path'], properties: { path: str('Workspace-relative file path'), maxBytes: int('Maximum bytes to read', 1048576) }, additionalProperties: false } },
    async (input, ctx) => ({ path: input.path, content: wsOf(ctx).readFile(input.path as string, { maxBytes: input.maxBytes as number }) }),
  );

  r.register(
    { name: 'write_file', description: 'Write (create or overwrite) a workspace file, creating parent directories.', minAutonomy: 'workspace-write', mutating: true, inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: str('Workspace-relative file path'), content: str('Full file content') }, additionalProperties: false } },
    async (input, ctx) => wsOf(ctx).writeFile(input.path as string, input.content as string),
  );

  r.register(
    { name: 'create_file', description: 'Create a new file. Fails if the file already exists.', minAutonomy: 'workspace-write', mutating: true, inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: str('Workspace-relative file path'), content: str('Full file content') }, additionalProperties: false } },
    async (input, ctx) => wsOf(ctx).createFile(input.path as string, input.content as string),
  );

  r.register(
    { name: 'edit_file', description: 'Replace a block of text in a file. oldText must match exactly.', minAutonomy: 'workspace-write', mutating: true, inputSchema: { type: 'object', required: ['path', 'oldText', 'newText'], properties: { path: str('Workspace-relative file path'), oldText: str('Exact text to replace'), newText: str('Replacement text'), occurrence: { type: 'string', enum: ['first', 'all'], default: 'first' }, expectedOccurrences: int('Fail unless exactly this many matches exist') }, additionalProperties: false } },
    async (input, ctx) => wsOf(ctx).editFile(input.path as string, input.oldText as string, input.newText as string, { occurrence: (input.occurrence as 'first' | 'all' | undefined) ?? 'first', expectedOccurrences: input.expectedOccurrences as number | undefined }),
  );

  r.register(
    { name: 'delete_file', description: 'Delete a file or (with recursive=true) a directory.', minAutonomy: 'workspace-write', mutating: true, inputSchema: { type: 'object', required: ['path'], properties: { path: str('Workspace-relative path'), recursive: bool('Delete directories recursively', false) }, additionalProperties: false } },
    async (input, ctx) => {
      if (input.recursive && !autonomyGte(ctx.autonomy, 'full-workspace')) {
        throw new ForgeError('PERMISSION_DENIED', 'Recursive delete requires full-workspace autonomy');
      }
      return wsOf(ctx).deleteFile(input.path as string, { recursive: input.recursive as boolean });
    },
  );

  r.register(
    { name: 'list_directory', description: 'List a workspace directory.', minAutonomy: 'read-only', inputSchema: { type: 'object', properties: { path: str('Workspace-relative directory', ), recursive: bool('Recurse into subdirectories', false), maxEntries: int('Maximum entries', 2000), includeHidden: bool('Include dotfiles', false) }, additionalProperties: false } },
    async (input, ctx) => ({ entries: wsOf(ctx).listDirectory((input.path as string | undefined) ?? '.', { recursive: input.recursive as boolean, maxEntries: input.maxEntries as number, includeHidden: input.includeHidden as boolean }) }),
  );

  r.register(
    { name: 'search_files', description: 'Search file contents across the workspace (literal or regex).', minAutonomy: 'read-only', inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: str('Literal text or regex pattern'), paths: { type: 'array', items: str('path') }, regex: bool('Treat pattern as regex', false), flags: str('Regex flags, e.g. i'), maxResults: int('Maximum matches', 200) }, additionalProperties: false } },
    async (input, ctx) => ({ matches: wsOf(ctx).searchFiles(input.pattern as string, { paths: input.paths as string[] | undefined, regex: input.regex as boolean, flags: input.flags as string | undefined, maxResults: input.maxResults as number }) }),
  );

  r.register(
    { name: 'search_symbols', description: 'Search code symbols (classes, functions, types) by name.', minAutonomy: 'read-only', inputSchema: { type: 'object', properties: { query: str('Case-insensitive name fragment (empty = all symbols)'), paths: { type: 'array', items: str('path') }, kinds: { type: 'array', items: str('kind') }, maxResults: int('Maximum matches', 200) }, additionalProperties: false } },
    async (input, ctx) => ({ symbols: wsOf(ctx).searchSymbols((input.query as string | undefined) ?? '', { paths: input.paths as string[] | undefined, kinds: input.kinds as string[] | undefined, maxResults: input.maxResults as number }) }),
  );

  r.register(
    {
      name: 'shell', description: 'Execute a shell command in the workspace. Classified by risk; risky commands need approval per policy.', minAutonomy: 'workspace-write', mutating: true, timeoutMs: 300_000,
      inputSchema: { type: 'object', required: ['command'], properties: { command: str('Shell command'), cwd: str('Working directory relative to workspace root'), timeoutMs: int('Timeout in ms'), env: { type: 'object', description: 'Extra environment variables' } }, additionalProperties: false },
    },
    async (input, ctx) => {
      const command = input.command as string;
      await gateShellCommand(command, ctx);
      const cwd = (input.cwd as string | undefined) ? wsOf(ctx).resolvePath(input.cwd as string) : ctx.workspace.root;
      const timeoutMs = (input.timeoutMs as number | undefined) ?? ctx.defaultTimeoutMs ?? 300_000;
      const startedAt = Date.now();
      const res = await runShell(command, {
        cwd, timeoutMs, signal: ctx.signal,
        env: input.env as Record<string, string> | undefined,
        onOutput: (chunk) => {
          ctx.onOutput?.(chunk);
          if (ctx.verboseEvents !== false) {
            ctx.bus?.emit({ type: 'tool.output', sessionId: ctx.sessionId, agentId: ctx.agentId, taskId: ctx.taskId, data: { callId: ctx.callId, tool: 'shell', stream: chunk.stream, text: chunk.text.slice(0, 4000) } });
          }
        },
      });
      if (res.timedOut) throw new ForgeError('TIMEOUT', `shell timed out after ${timeoutMs}ms: ${command.slice(0, 200)}`);
      if (res.cancelled) throw new ForgeError('CANCELLED', 'shell execution cancelled');
      return {
        command, cwd, exitCode: res.exitCode, signal: res.signal, durationMs: Date.now() - startedAt,
        stdout: res.stdout.slice(-20000), stderr: res.stderr.slice(-20000),
        truncated: res.stdout.length > 20000 || res.stderr.length > 20000,
      };
    },
  );

  const gitTool = (name: string, description: string, mutating: boolean, minAutonomy: AutonomyLevel, schema: JsonSchema, run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>): void => {
    r.register({ name, description, minAutonomy, mutating, inputSchema: schema }, run);
  };

  const git = async (ctx: ToolContext, args: string[]): Promise<ProcessResult> => {
    const res = await runProcess('git', args, { cwd: ctx.workspace.root, timeoutMs: 60_000, signal: ctx.signal });
    if (res.exitCode !== 0 && res.exitCode !== null) {
      throw new ForgeError('TOOL_FAILED', `git ${args.join(' ')} failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 2000)}`);
    }
    return res;
  };

  gitTool('git_status', 'Show git working tree status (porcelain + branch).', false, 'read-only',
    { type: 'object', properties: { short: bool('Porcelain short format', true) }, additionalProperties: false },
    async (input, ctx) => {
      const branch = await git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: 'unknown' }) as ProcessResult);
      const status = await git(ctx, input.short === false ? ['status'] : ['status', '--porcelain=v1', '--branch']);
      return { branch: branch.stdout.trim(), status: status.stdout };
    });

  gitTool('git_diff', 'Show uncommitted or staged diff.', false, 'read-only',
    { type: 'object', properties: { staged: bool('Show staged (cached) diff', false), path: str('Limit diff to a path'), stat: bool('Show --stat instead of full diff', false), maxBytes: int('Truncate output to this size', 200000) }, additionalProperties: false },
    async (input, ctx) => {
      const args = ['diff', ...(input.staged ? ['--cached'] : []), ...(input.stat ? ['--stat'] : []), '--', ...((input.path as string | undefined) ? [input.path as string] : [])];
      const res = await git(ctx, args);
      const max = (input.maxBytes as number | undefined) ?? 200000;
      return { diff: res.stdout.slice(0, max), truncated: res.stdout.length > max };
    });

  gitTool('git_log', 'Show recent commit history.', false, 'read-only',
    { type: 'object', properties: { limit: int('Number of commits', 20), oneline: bool('One line per commit', true), path: str('Limit history to a path') }, additionalProperties: false },
    async (input, ctx) => {
      const args = ['log', `-${(input.limit as number | undefined) ?? 20}`, ...((input.oneline as boolean | undefined) === false ? [] : ['--oneline']), '--', ...((input.path as string | undefined) ? [input.path as string] : [])];
      const res = await git(ctx, args);
      return { log: res.stdout };
    });

  gitTool('git_add', 'Stage files for commit.', true, 'workspace-write',
    { type: 'object', required: ['paths'], properties: { paths: { type: 'array', items: str('path') } }, additionalProperties: false },
    async (input, ctx) => {
      const paths = input.paths as string[];
      if (paths.length === 0) throw new ForgeError('INVALID_INPUT', 'git_add requires at least one path');
      for (const p of paths) wsOf(ctx).resolvePath(p); // containment check
      await git(ctx, ['add', '--', ...paths]);
      return { staged: paths };
    });

  gitTool('git_commit', 'Create a commit from staged changes.', true, 'workspace-write',
    { type: 'object', required: ['message'], properties: { message: str('Commit message'), allowEmpty: bool('Allow empty commit', false) }, additionalProperties: false },
    async (input, ctx) => {
      const args = ['commit', '-m', input.message as string, ...((input.allowEmpty as boolean) ? ['--allow-empty'] : [])];
      const res = await git(ctx, args);
      const head = await git(ctx, ['rev-parse', 'HEAD']);
      ctx.bus?.emit({ type: 'git.changed', sessionId: ctx.sessionId, agentId: ctx.agentId, taskId: ctx.taskId, data: { head: head.stdout.trim(), message: input.message } });
      return { head: head.stdout.trim(), output: res.stdout.slice(0, 2000) };
    });

  gitTool('git_branch', 'List, create or switch branches.', true, 'workspace-write',
    { type: 'object', properties: { list: bool('List branches', true), create: str('Create and switch to this branch'), switch: str('Switch to this branch') }, additionalProperties: false },
    async (input, ctx) => {
      if (input.create) {
        await gateShellCommand(`git checkout -b ${input.create}`, ctx);
        await git(ctx, ['checkout', '-b', input.create as string]);
        return { current: input.create };
      }
      if (input.switch) {
        await gateShellCommand(`git checkout ${input.switch}`, ctx);
        await git(ctx, ['checkout', input.switch as string]);
        return { current: input.switch };
      }
      const res = await git(ctx, ['branch', '--show-current']);
      const all = await git(ctx, ['branch', '-a', '--format=%(refname:short)']);
      return { current: res.stdout.trim(), branches: all.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
    });

  const runPreset = (tool: string, description: string) => {
    r.register(
      {
        name: tool, description, minAutonomy: 'workspace-write', mutating: true, timeoutMs: 600_000,
        inputSchema: { type: 'object', properties: { command: str('Explicit command (auto-detected when omitted)'), cwd: str('Working directory relative to workspace root'), timeoutMs: int('Timeout in ms') }, additionalProperties: false },
      },
      async (input, ctx) => {
        const command = (input.command as string | undefined) ?? detectPreset(ctx.workspace, tool);
        if (!command) throw new ForgeError('INVALID_INPUT', `No ${tool} command detected; pass an explicit command`);
        await gateShellCommand(command, ctx);
        const cwd = (input.cwd as string | undefined) ? wsOf(ctx).resolvePath(input.cwd as string) : ctx.workspace.root;
        const timeoutMs = (input.timeoutMs as number | undefined) ?? 600_000;
        if (tool === 'run_tests') ctx.bus?.emit({ type: 'test.started', sessionId: ctx.sessionId, agentId: ctx.agentId, taskId: ctx.taskId, data: { command } });
        const res = await runShell(command, {
          cwd, timeoutMs, signal: ctx.signal,
          onOutput: (chunk) => {
            ctx.onOutput?.(chunk);
            if (ctx.verboseEvents !== false) {
              ctx.bus?.emit({ type: 'tool.output', sessionId: ctx.sessionId, agentId: ctx.agentId, taskId: ctx.taskId, data: { callId: ctx.callId, tool, stream: chunk.stream, text: chunk.text.slice(0, 4000) } });
            }
          },
        });
        if (tool === 'run_tests') {
          ctx.bus?.emit({
            type: res.exitCode === 0 ? 'test.passed' : 'test.failed',
            sessionId: ctx.sessionId, agentId: ctx.agentId, taskId: ctx.taskId,
            data: { command, exitCode: res.exitCode },
          });
        }
        if (res.timedOut) throw new ForgeError('TIMEOUT', `${tool} timed out after ${timeoutMs}ms`);
        if (res.cancelled) throw new ForgeError('CANCELLED', `${tool} cancelled`);
        return { command, cwd, exitCode: res.exitCode, signal: res.signal, durationMs: res.durationMs, stdout: res.stdout.slice(-20000), stderr: res.stderr.slice(-20000) };
      },
    );
  };
  runPreset('run_tests', 'Run the project test suite (auto-detects npm test / pytest / cargo test when command omitted).');
  runPreset('run_build', 'Run the project build (auto-detects npm run build / make / cargo build when command omitted).');
  runPreset('run_linter', 'Run the project linter (auto-detects npm run lint / ruff / cargo clippy when command omitted).');

  r.register(
    { name: 'inspect_environment', description: 'Inspect the execution environment (platform, runtimes, resources). Values that could leak secrets are omitted.', minAutonomy: 'read-only', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    async (_input, ctx) => {
      const safeEnv: Record<string, string> = {};
      for (const k of ['PATH', 'HOME', 'SHELL', 'LANG', 'TERM', 'NODE_ENV', 'CI']) {
        if (process.env[k]) safeEnv[k] = k === 'PATH' ? `${process.env[k]?.split(':').length} entries` : (process.env[k] as string);
      }
      const node = process.version;
      const npm = await runProcess('npm', ['--version'], { cwd: ctx.workspace.root, timeoutMs: 10_000 }).then((p) => p.stdout.trim()).catch(() => undefined);
      const gitV = await runProcess('git', ['--version'], { cwd: ctx.workspace.root, timeoutMs: 10_000 }).then((p) => p.stdout.trim()).catch(() => undefined);
      const python = await runProcess('python3', ['--version'], { cwd: ctx.workspace.root, timeoutMs: 10_000 }).then((p) => (p.stdout || p.stderr).trim()).catch(() => undefined);
      return {
        platform: platform(), arch: arch(), cpus: cpus().length,
        memory: { total: totalmem(), free: freemem() },
        runtimes: { node, npm, git: gitV, python },
        workspaceRoot: ctx.workspace.root,
        env: safeEnv,
      };
    },
  );

  r.register(
    { name: 'http_request', description: 'Perform an HTTP(S) request. Only http/https URLs; metadata endpoints blocked.', minAutonomy: 'workspace-write', inputSchema: { type: 'object', required: ['url'], properties: { url: str('http(s) URL'), method: str('HTTP method', ), headers: { type: 'object', description: 'Request headers' }, body: str('Request body'), timeoutMs: int('Timeout in ms', 30000), maxBytes: int('Max response bytes', 500000) }, additionalProperties: false } },
    async (input) => {
      const url = new URL(input.url as string);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ForgeError('INVALID_INPUT', 'Only http/https URLs are allowed');
      if (url.hostname === '169.254.169.254' || url.hostname === 'metadata.google.internal') {
        throw new ForgeError('PERMISSION_DENIED', 'Cloud metadata endpoints are blocked');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (input.timeoutMs as number | undefined) ?? 30000);
      try {
        const res = await fetch(url, {
          method: ((input.method as string | undefined) ?? 'GET').toUpperCase(),
          headers: input.headers as Record<string, string> | undefined,
          body: input.body as string | undefined,
          signal: controller.signal,
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const max = (input.maxBytes as number | undefined) ?? 500000;
        return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: buf.slice(0, max).toString('utf8'), truncated: buf.length > max };
      } catch (e) {
        throw new ForgeError('TOOL_FAILED', `http_request failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  return r;
}

function detectPreset(ws: Workspace, tool: string): string | undefined {
  if (tool === 'run_tests') {
    if (ws.exists('package.json')) {
      try {
        const pkg = JSON.parse(ws.readFile('package.json')) as { scripts?: Record<string, string> };
        if (pkg.scripts?.test) return 'npm test';
      } catch { /* ignore */ }
    }
    if (ws.exists('pytest.ini') || ws.exists('pyproject.toml') || ws.exists('tests')) return 'python3 -m pytest -q';
    if (ws.exists('Cargo.toml')) return 'cargo test';
    if (ws.exists('go.mod')) return 'go test ./...';
    if (ws.exists('Makefile')) return 'make test';
    return undefined;
  }
  if (tool === 'run_build') {
    if (ws.exists('package.json')) {
      try {
        const pkg = JSON.parse(ws.readFile('package.json')) as { scripts?: Record<string, string> };
        if (pkg.scripts?.build) return 'npm run build';
      } catch { /* ignore */ }
    }
    if (ws.exists('Cargo.toml')) return 'cargo build';
    if (ws.exists('go.mod')) return 'go build ./...';
    if (ws.exists('Makefile')) return 'make';
    return undefined;
  }
  if (ws.exists('package.json')) {
    try {
      const pkg = JSON.parse(ws.readFile('package.json')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.lint) return 'npm run lint';
    } catch { /* ignore */ }
  }
  if (ws.exists('pyproject.toml') || ws.exists('setup.cfg')) return 'python3 -m ruff check .';
  if (ws.exists('Cargo.toml')) return 'cargo clippy';
  return undefined;
}
