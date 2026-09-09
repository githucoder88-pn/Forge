/**
 * Workspace: the only path through which agents touch the filesystem.
 * Enforces root containment, records attribution for every mutation,
 * loads scoped project instructions (AGENTS.md), and provides search.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { AgentId, SessionId, TaskId, nowIso } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import { resolveWorkspacePath } from './permissions.js';
import type { SqliteStore } from './store.js';

export interface WorkspaceOptions {
  root: string;
  sessionId?: SessionId;
  agentId?: AgentId;
  taskId?: TaskId;
  bus?: EventBus;
  store?: SqliteStore;
  /** Filenames treated as project instructions (root → nested precedence). */
  instructionFiles?: string[];
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  size: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SymbolMatch {
  path: string;
  line: number;
  name: string;
  kind: string;
  signature: string;
}

export interface InstructionFile {
  path: string;
  content: string;
}

const DEFAULT_SKIPS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.venv', '__pycache__', '.forge', 'coverage']);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.tar', '.gz',
  '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.wasm', '.mp3', '.mp4', '.mov',
  '.avi', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.sqlite', '.db',
]);

const SYMBOL_PATTERNS: { kind: string; re: RegExp; exts?: Set<string> }[] = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: 'function', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/ },
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'enum', re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*def\s+([A-Za-z_]\w*)/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: 'struct', re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
];

export class Workspace {
  readonly root: string;
  sessionId?: SessionId;
  agentId?: AgentId;
  taskId?: TaskId;
  private bus?: EventBus;
  private store?: SqliteStore;
  private instructionFiles: string[];

  constructor(opts: WorkspaceOptions) {
    this.root = resolve(opts.root);
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.taskId = opts.taskId;
    this.bus = opts.bus;
    this.store = opts.store;
    this.instructionFiles = opts.instructionFiles ?? ['AGENTS.md'];
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  /** Scoped clone for a different agent/task sharing the same root. */
  scope(agentId?: AgentId, taskId?: TaskId): Workspace {
    const w = new Workspace({
      root: this.root, sessionId: this.sessionId, agentId, taskId,
      bus: this.bus, store: this.store, instructionFiles: this.instructionFiles,
    });
    return w;
  }

  resolvePath(target: string): string {
    return resolveWorkspacePath(this.root, target);
  }

  rel(abs: string): string {
    return relative(this.root, abs) || '.';
  }

  exists(target = '.'): boolean {
    return existsSync(this.resolvePath(target));
  }

  readFile(target: string, opts?: { maxBytes?: number }): string {
    const abs = this.resolvePath(target);
    if (!existsSync(abs)) throw new ForgeError('NOT_FOUND', `File not found: ${target}`);
    const st = statSync(abs);
    if (!st.isFile()) throw new ForgeError('INVALID_INPUT', `Not a file: ${target}`);
    const max = opts?.maxBytes ?? 1024 * 1024;
    if (st.size > max) throw new ForgeError('INVALID_INPUT', `File exceeds read limit (${st.size} > ${max} bytes): ${target}`);
    return readFileSync(abs, 'utf8');
  }

  writeFile(target: string, content: string): { path: string; bytes: number; created: boolean } {
    const abs = this.resolvePath(target);
    const created = !existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    const rel = this.rel(abs);
    this.recordMutation(created ? 'created' : 'modified', rel);
    return { path: rel, bytes: Buffer.byteLength(content, 'utf8'), created };
  }

  createFile(target: string, content: string): { path: string; bytes: number } {
    const abs = this.resolvePath(target);
    if (existsSync(abs)) throw new ForgeError('ALREADY_EXISTS', `File already exists: ${target}`);
    return { path: this.writeFile(target, content).path, bytes: Buffer.byteLength(content, 'utf8') };
  }

  editFile(target: string, oldText: string, newText: string, opts?: { occurrence?: 'first' | 'all' | number; expectedOccurrences?: number }): { path: string; replacements: number } {
    if (oldText.length === 0) throw new ForgeError('INVALID_INPUT', 'edit_file requires non-empty oldText');
    const abs = this.resolvePath(target);
    const content = this.readFile(target);
    const parts = content.split(oldText);
    const count = parts.length - 1;
    if (count === 0) throw new ForgeError('NOT_FOUND', `oldText not found in ${target}`);
    if (opts?.expectedOccurrences !== undefined && count !== opts.expectedOccurrences) {
      throw new ForgeError('INVALID_INPUT', `Expected ${opts.expectedOccurrences} occurrence(s) in ${target}, found ${count}`);
    }
    const mode = opts?.occurrence ?? 'first';
    let next: string;
    let replacements: number;
    if (mode === 'all') {
      next = parts.join(newText);
      replacements = count;
    } else if (mode === 'first') {
      next = parts[0] + newText + parts.slice(1).join(oldText);
      replacements = 1;
    } else {
      const n = mode;
      if (n < 1 || n > count) throw new ForgeError('INVALID_INPUT', `Occurrence ${n} out of range (1..${count}) in ${target}`);
      next = parts.slice(0, n).join(oldText) + newText + parts.slice(n).join(oldText);
      replacements = 1;
    }
    writeFileSync(abs, next, 'utf8');
    this.recordMutation('modified', this.rel(abs));
    return { path: this.rel(abs), replacements };
  }

  deleteFile(target: string, opts?: { recursive?: boolean }): { path: string } {
    const abs = this.resolvePath(target);
    if (abs === this.root) throw new ForgeError('INVALID_INPUT', 'Refusing to delete the workspace root');
    if (!existsSync(abs)) throw new ForgeError('NOT_FOUND', `Path not found: ${target}`);
    rmSync(abs, { recursive: opts?.recursive ?? false, force: false });
    const rel = this.rel(abs);
    this.recordMutation('deleted', rel);
    return { path: rel };
  }

  listDirectory(target = '.', opts?: { recursive?: boolean; maxEntries?: number; includeHidden?: boolean; skip?: string[] }): DirEntry[] {
    const abs = this.resolvePath(target);
    if (!existsSync(abs)) throw new ForgeError('NOT_FOUND', `Directory not found: ${target}`);
    if (!statSync(abs).isDirectory()) throw new ForgeError('INVALID_INPUT', `Not a directory: ${target}`);
    const max = opts?.maxEntries ?? 2000;
    const skip = new Set([...DEFAULT_SKIPS, ...(opts?.skip ?? [])]);
    const out: DirEntry[] = [];
    const walk = (dir: string): void => {
      if (out.length >= max) return;
      const names = readdirSync(dir, { withFileTypes: true });
      for (const d of names) {
        if (out.length >= max) return;
        if (!opts?.includeHidden && d.name.startsWith('.') && d.name !== '.forge') {
          // Allow explicit .forge inspection but skip other dotfiles by default.
          if (d.name !== '.forge') continue;
        }
        if (skip.has(d.name)) continue;
        const full = join(dir, d.name);
        let size = 0;
        try { size = statSync(full).size; } catch { size = 0; }
        out.push({
          name: d.name,
          path: this.rel(full),
          type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
          size,
        });
        if (opts?.recursive && d.isDirectory()) walk(full);
      }
    };
    walk(abs);
    out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
    return out;
  }

  searchFiles(pattern: string, opts?: { paths?: string[]; maxResults?: number; regex?: boolean; flags?: string; includeExts?: string[] }): SearchMatch[] {
    const max = opts?.maxResults ?? 200;
    const matcher = this.compileMatcher(pattern, opts?.regex ?? false, opts?.flags ?? '');
    const roots = (opts?.paths ?? ['.']).map((p) => this.resolvePath(p));
    const includeExts = opts?.includeExts ? new Set(opts.includeExts) : undefined;
    const out: SearchMatch[] = [];
    const visitFile = (abs: string): void => {
      if (out.length >= max) return;
      const dot = abs.lastIndexOf('.');
      const ext = dot >= 0 ? abs.slice(dot).toLowerCase() : '';
      if (BINARY_EXTS.has(ext)) return;
      if (includeExts && !includeExts.has(ext)) return;
      let text: string;
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
        text = readFileSync(abs, 'utf8');
      } catch { return; }
      if (text.includes('\0')) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) {
        const line = lines[i] as string;
        matcher.lastIndex = 0;
        const m = matcher.exec(line);
        if (m) {
          out.push({ path: this.rel(abs), line: i + 1, column: (m.index ?? 0) + 1, text: line.slice(0, 500) });
          if (!matcher.global) continue;
        }
      }
    };
    const walk = (dir: string): void => {
      if (out.length >= max) return;
      let names;
      try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        if (out.length >= max) return;
        if (DEFAULT_SKIPS.has(d.name) || d.name === '.git') continue;
        const full = join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile()) visitFile(full);
      }
    };
    for (const r of roots) {
      try {
        const st = statSync(r);
        if (st.isDirectory()) walk(r);
        else visitFile(r);
      } catch { /* missing root — skip */ }
    }
    return out;
  }

  private compileMatcher(pattern: string, regex: boolean, flags: string): RegExp {
    if (regex) return new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'g');
  }

  searchSymbols(query: string, opts?: { paths?: string[]; maxResults?: number; kinds?: string[] }): SymbolMatch[] {
    const max = opts?.maxResults ?? 200;
    const q = query.toLowerCase();
    const kinds = opts?.kinds ? new Set(opts.kinds) : undefined;
    const roots = (opts?.paths ?? ['.']).map((p) => this.resolvePath(p));
    const out: SymbolMatch[] = [];
    const visitFile = (abs: string): void => {
      if (out.length >= max) return;
      let text: string;
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
        text = readFileSync(abs, 'utf8');
      } catch { return; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) {
        const line = lines[i] as string;
        for (const p of SYMBOL_PATTERNS) {
          const m = p.re.exec(line);
          if (m && m[1]) {
            const name = m[1];
            if (kinds && !kinds.has(p.kind)) break;
            if (q && !name.toLowerCase().includes(q)) break;
            out.push({ path: this.rel(abs), line: i + 1, name, kind: p.kind, signature: line.trim().slice(0, 300) });
            break;
          }
        }
      }
    };
    const walk = (dir: string): void => {
      if (out.length >= max) return;
      let names;
      try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        if (out.length >= max) return;
        if (DEFAULT_SKIPS.has(d.name) || d.name === '.git') continue;
        const full = join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|c|h|cpp|hpp|cs|swift|kt|scala)$/.test(d.name)) visitFile(full);
      }
    };
    for (const r of roots) {
      try {
        const st = statSync(r);
        if (st.isDirectory()) walk(r);
        else visitFile(r);
      } catch { /* skip */ }
    }
    return out;
  }

  /**
   * Load project instructions with directory scoping: root AGENTS.md applies
   * everywhere; deeper files add/override for their subtree. Ordered root→leaf.
   */
  loadInstructions(forDir = '.'): InstructionFile[] {
    const abs = this.resolvePath(forDir);
    const chain: string[] = [];
    let cur = abs;
    while (true) {
      chain.unshift(cur);
      if (cur === this.root) break;
      const parent = dirname(cur);
      if (parent === cur || !parent.startsWith(this.root)) break;
      cur = parent;
    }
    const out: InstructionFile[] = [];
    for (const dir of chain) {
      for (const name of this.instructionFiles) {
        const file = join(dir, name);
        if (existsSync(file)) {
          try {
            const content = readFileSync(file, 'utf8');
            if (content.trim().length > 0) out.push({ path: this.rel(file), content });
          } catch { /* unreadable — skip */ }
        }
      }
    }
    return out;
  }

  /** Answer "who changed this file and why" from persisted attribution. */
  fileHistory(target: string): { ts: string; op: string; agentId?: string; taskId?: string }[] {
    if (!this.store) return [];
    const abs = this.resolvePath(target);
    return this.store.fileHistory(this.rel(abs));
  }

  private recordMutation(op: 'created' | 'modified' | 'deleted', relPath: string): void {
    const ts = nowIso();
    this.store?.recordFileEvent({
      ts, path: relPath, op,
      agentId: this.agentId, taskId: this.taskId, sessionId: this.sessionId,
    });
    const type = op === 'created' ? 'file.created' : op === 'modified' ? 'file.modified' : 'file.deleted';
    this.bus?.emit({
      type, sessionId: this.sessionId, agentId: this.agentId, taskId: this.taskId,
      data: { path: relPath, op },
    });
  }
}
