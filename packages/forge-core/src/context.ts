/**
 * Context engine: bounded, token-aware, prioritized, deduplicated context
 * construction. The system never silently grows context — every build
 * reports exact token stats against an explicit budget.
 */
import { estimateTokens } from './providers.js';
import type { Workspace } from './workspace.js';
import type { MemoryStore } from './memory.js';

export type ContextKind =
  | 'system' | 'instructions' | 'user' | 'task' | 'file'
  | 'tool_output' | 'message' | 'memory' | 'decision';

export interface ContextItem {
  kind: ContextKind;
  label: string;
  content: string;
  tokens: number;
  /** Higher = kept first under budget pressure. */
  priority: number;
  dedupKey?: string;
}

export interface ContextStats {
  items: number;
  tokens: number;
  budget: number;
  utilization: number;
  dropped: number;
}

export function formatStats(s: ContextStats): string {
  return `${s.tokens.toLocaleString('en-US')} / ${s.budget.toLocaleString('en-US')} tokens`;
}

export function makeItem(kind: ContextKind, label: string, content: string, priority: number, dedupKey?: string): ContextItem {
  return { kind, label, content, tokens: estimateTokens(content) + 8, priority, dedupKey };
}

export class ContextBuilder {
  private items: ContextItem[] = [];
  private seen = new Set<string>();
  dropped = 0;

  constructor(readonly budget: number) {}

  add(item: ContextItem): boolean {
    if (item.dedupKey) {
      if (this.seen.has(item.dedupKey)) return false;
      this.seen.add(item.dedupKey);
    }
    this.items.push(item);
    return true;
  }

  addMany(items: ContextItem[]): void {
    for (const i of items) this.add(i);
  }

  /** Priority-ordered, budget-fitted items (highest priority first). */
  build(): { items: ContextItem[]; stats: ContextStats } {
    const sorted = [...this.items].sort((a, b) => b.priority - a.priority);
    const kept: ContextItem[] = [];
    let tokens = 0;
    let dropped = 0;
    for (const item of sorted) {
      if (tokens + item.tokens <= this.budget) {
        kept.push(item);
        tokens += item.tokens;
      } else {
        dropped++;
      }
    }
    // Restore stable kind ordering for the model: system → instructions → ….
    const order: Record<ContextKind, number> = {
      system: 0, instructions: 1, user: 2, task: 3, decision: 4,
      memory: 5, file: 6, message: 7, tool_output: 8,
    };
    kept.sort((a, b) => order[a.kind] - order[b.kind] || b.priority - a.priority);
    this.dropped = dropped;
    return {
      items: kept,
      stats: { items: kept.length, tokens, budget: this.budget, utilization: this.budget > 0 ? tokens / this.budget : 0, dropped },
    };
  }

  /**
   * Compact to `targetTokens` by dropping lowest-priority items first,
   * then truncating the largest remaining tool outputs with markers.
   * Returns the removed items for observability.
   */
  compact(targetTokens: number): { removed: ContextItem[]; stats: ContextStats } {
    const removed: ContextItem[] = [];
    const sorted = [...this.items].sort((a, b) => a.priority - b.priority);
    let tokens = this.items.reduce((n, i) => n + i.tokens, 0);
    const keep = new Set(sorted);
    for (const item of sorted) {
      if (tokens <= targetTokens) break;
      if (item.kind === 'system' || item.kind === 'user') continue;
      keep.delete(item);
      removed.push(item);
      tokens -= item.tokens;
    }
    // Truncate large tool outputs if still over budget.
    for (const item of [...keep].sort((a, b) => b.tokens - a.tokens)) {
      if (tokens <= targetTokens) break;
      if (item.kind !== 'tool_output' || item.tokens < 2000) continue;
      const over = tokens - targetTokens;
      const cut = Math.min(item.content.length - 500, Math.ceil(over * 4));
      if (cut > 0) {
        item.content = item.content.slice(0, Math.max(500, item.content.length - cut)) + '\n…[truncated by compaction]…';
        const newTokens = estimateTokens(item.content) + 8;
        tokens -= item.tokens - newTokens;
        item.tokens = newTokens;
      }
    }
    this.items = [...keep];
    const { stats } = this.build();
    return { removed, stats };
  }

  tokenCount(): number {
    return this.items.reduce((n, i) => n + i.tokens, 0);
  }

  clear(): void {
    this.items = [];
    this.seen.clear();
    this.dropped = 0;
  }
}

/** Score a file's relevance to query terms (0..1-ish, higher is better). */
export function scoreFileRelevance(path: string, head: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lowerPath = path.toLowerCase();
  const lowerHead = head.toLowerCase().slice(0, 8000);
  let score = 0;
  for (const raw of terms) {
    const t = raw.toLowerCase();
    if (!t) continue;
    if (lowerPath.includes(t)) score += 3;
    const occurrences = lowerHead.split(t).length - 1;
    score += Math.min(5, occurrences);
  }
  // Prefer source files over generated/lock artifacts.
  if (/\.(lock|snap|min\.js|map)$/.test(lowerPath)) score *= 0.2;
  return score / terms.length;
}

export function extractTerms(text: string, max = 24): string[] {
  const stop = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'have', 'will', 'for', 'are', 'was', 'were', 'been', 'into', 'your', 'you', 'our', 'their', 'what', 'when', 'where', 'which', 'then', 'than', 'also', 'just', 'about', 'after', 'before', 'make', 'made', 'file', 'files', 'code', 'please', 'should', 'could', 'would']);
  const words = text.toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length > 2 && !stop.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

export interface EngineOptions {
  workspace: Workspace;
  memory?: MemoryStore;
  defaultBudget?: number;
  /** Cap on files scanned during relevance selection. */
  maxScanFiles?: number;
  maxFileTokens?: number;
}

export interface TaskContextRequest {
  goal: string;
  taskDescription?: string;
  budget?: number;
  instructionsDir?: string;
  extraTerms?: string[];
  includeMemory?: { scopeId: string }[];
}

export interface BuiltContext {
  builder: ContextBuilder;
  stats: ContextStats;
  files: string[];
}

export class ContextEngine {
  private workspace: Workspace;
  private memory?: MemoryStore;
  private defaultBudget: number;
  private maxScanFiles: number;
  private maxFileTokens: number;
  private scanCache = new Map<string, { at: number; paths: string[] }>();

  constructor(opts: EngineOptions) {
    this.workspace = opts.workspace;
    this.memory = opts.memory;
    this.defaultBudget = opts.defaultBudget ?? 24_000;
    this.maxScanFiles = opts.maxScanFiles ?? 600;
    this.maxFileTokens = opts.maxFileTokens ?? 4000;
  }

  async buildForTask(req: TaskContextRequest): Promise<BuiltContext> {
    const budget = req.budget ?? this.defaultBudget;
    const builder = new ContextBuilder(budget);
    const terms = [...extractTerms(req.goal), ...(req.extraTerms ?? [])];

    builder.add(makeItem('user', 'goal', req.goal, 1000, 'goal'));
    if (req.taskDescription) builder.add(makeItem('task', 'task', req.taskDescription, 900, 'task'));

    for (const inst of this.workspace.loadInstructions(req.instructionsDir ?? '.')) {
      builder.add(makeItem('instructions', inst.path, `# ${inst.path}\n${inst.content}`, 800, `inst:${inst.path}`));
    }

    if (this.memory && req.includeMemory) {
      for (const m of req.includeMemory) {
        const entries = this.memory.search(terms.slice(0, 8).join(' '), { limit: 5 });
        for (const e of entries) {
          builder.add(makeItem('memory', `${e.scope}:${e.key}`, `${e.key}: ${e.value}`, 400, `mem:${e.id}`));
        }
        void m;
      }
    }

    const files = await this.selectFiles(terms, Math.floor(budget * 0.5));
    for (const f of files) {
      try {
        const content = this.workspace.readFile(f.path, { maxBytes: this.maxFileTokens * 4 });
        const clipped = content.length > this.maxFileTokens * 4
          ? content.slice(0, this.maxFileTokens * 4) + '\n…[truncated]…'
          : content;
        builder.add(makeItem('file', f.path, `// ${f.path} (relevance ${f.score.toFixed(1)})\n${clipped}`, 500 + Math.min(200, f.score * 10), `file:${f.path}`));
      } catch { /* unreadable — skip */ }
    }

    const { stats } = builder.build();
    return { builder, stats, files: files.map((f) => f.path) };
  }

  private async selectFiles(terms: string[], tokenBudget: number): Promise<{ path: string; score: number }[]> {
    void tokenBudget;
    if (terms.length === 0) return [];
    const cacheKey = this.workspace.root;
    let paths = this.scanCache.get(cacheKey);
    if (!paths || Date.now() - paths.at > 60_000) {
      const entries = this.workspace.listDirectory('.', { recursive: true, maxEntries: this.maxScanFiles });
      const found = entries.filter((e) => e.type === 'file').map((e) => e.path);
      this.scanCache.set(cacheKey, { at: Date.now(), paths: found });
      paths = { at: Date.now(), paths: found };
    }
    const scored: { path: string; score: number }[] = [];
    for (const p of paths.paths) {
      let head = '';
      try { head = this.workspace.readFile(p, { maxBytes: 6000 }); } catch { continue; }
      const score = scoreFileRelevance(p, head, terms);
      if (score > 0.5) scored.push({ path: p, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 12);
  }
}
