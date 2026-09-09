/**
 * Scoped project memory (global/project/session/team/agent/task). Searchable,
 * persisted, and injected selectively — never dumped wholesale into context.
 */
import { MemoryId, memoryId, nowIso } from './ids.js';
import { ForgeError } from './errors.js';
import type { SqliteStore } from './store.js';

export type MemoryScope = 'global' | 'project' | 'session' | 'team' | 'agent' | 'task';

export interface MemoryEntry {
  id: MemoryId;
  scope: MemoryScope;
  scopeId: string;
  key: string;
  value: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  constructor(private store: SqliteStore) {}

  put(scope: MemoryScope, scopeId: string, key: string, value: string, tags: string[] = []): MemoryEntry {
    if (!key.trim()) throw new ForgeError('INVALID_INPUT', 'Memory key must not be empty');
    const existing = this.get(scope, scopeId, key);
    const entry: MemoryEntry = {
      id: existing?.id ?? memoryId(),
      scope, scopeId, key, value, tags,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    this.store.putMemory({ id: entry.id, scope, scopeId, key, updatedAt: entry.updatedAt, data: entry });
    return entry;
  }

  get(scope: MemoryScope, scopeId: string, key: string): MemoryEntry | undefined {
    const all = this.list(scope, scopeId);
    return all.find((e) => e.key === key);
  }

  getById(id: string): MemoryEntry | undefined {
    return this.store.getMemory(id) as MemoryEntry | undefined;
  }

  delete(id: string): void {
    this.store.deleteMemory(id);
  }

  list(scope: MemoryScope, scopeId: string, limit = 200): MemoryEntry[] {
    const rows = this.store.searchMemory({ scope, scopeId, limit }) as MemoryEntry[];
    return rows;
  }

  /** Ranked keyword search across scopes (terms matched against key/value/tags). */
  search(query: string, opts?: { scopes?: { scope: MemoryScope; scopeId: string }[]; limit?: number }): MemoryEntry[] {
    const limit = opts?.limit ?? 20;
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const pool: MemoryEntry[] = [];
    if (opts?.scopes?.length) {
      for (const s of opts.scopes) pool.push(...this.list(s.scope, s.scopeId, 200));
    } else {
      pool.push(...(this.store.searchMemory({ limit: 500 }) as MemoryEntry[]));
    }
    const scored = pool.map((e) => {
      const hay = `${e.key} ${e.value} ${e.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (e.key.toLowerCase().includes(t)) score += 3;
        else if (hay.includes(t)) score += 1;
      }
      return { e, score };
    }).filter((s) => terms.length === 0 || s.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.e);
  }
}
