/**
 * Checkpoints + rollback. A checkpoint captures git state plus the full
 * orchestration state (agents/tasks/teams) and the event position so work
 * can be inspected and restored. Restores are explicit and safety-aware:
 * a safety checkpoint is always taken first.
 */
import { CheckpointId, SessionId, checkpointId, nowIso } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import type { SqliteStore } from './store.js';
import { runProcess } from './tools.js';

export interface CheckpointState {
  agents: unknown[];
  tasks: unknown[];
  teams: unknown[];
}

export interface Checkpoint {
  id: CheckpointId;
  sessionId: SessionId;
  label: string;
  createdAt: string;
  gitHead?: string;
  gitDirty?: boolean;
  eventSeq: number;
  state: CheckpointState;
}

const KIND = 'checkpoint';

export interface GitSnapshot {
  head?: string;
  dirty?: boolean;
  available: boolean;
}

export class CheckpointManager {
  constructor(private store: SqliteStore, private bus: EventBus, private projectDir: string) {}

  async captureGit(): Promise<GitSnapshot> {
    try {
      const head = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: this.projectDir, timeoutMs: 10_000 });
      if (head.exitCode !== 0) return { available: false };
      const status = await runProcess('git', ['status', '--porcelain'], { cwd: this.projectDir, timeoutMs: 10_000 });
      return { head: head.stdout.trim() || undefined, dirty: status.stdout.trim().length > 0, available: true };
    } catch {
      return { available: false };
    }
  }

  async create(sessionId: SessionId, label: string, state: CheckpointState, eventSeq: number): Promise<Checkpoint> {
    const git = await this.captureGit();
    const ckpt: Checkpoint = {
      id: checkpointId(),
      sessionId,
      label,
      createdAt: nowIso(),
      gitHead: git.head,
      gitDirty: git.available ? git.dirty : undefined,
      eventSeq,
      state,
    };
    this.store.putDoc(KIND, ckpt.id, sessionId, ckpt.createdAt, ckpt);
    this.bus.emit({
      type: 'checkpoint.created', sessionId,
      data: { checkpointId: ckpt.id, label, gitHead: ckpt.gitHead, gitDirty: ckpt.gitDirty },
    });
    return ckpt;
  }

  get(id: string): Checkpoint {
    const c = this.store.getDoc<Checkpoint>(KIND, id);
    if (!c) throw new ForgeError('NOT_FOUND', `Checkpoint not found: ${id}`);
    return c;
  }

  list(sessionId?: string): Checkpoint[] {
    return this.store.listDocs<Checkpoint>(KIND, sessionId);
  }

  /**
   * Restore tracked-file git state to the checkpoint's HEAD. The current
   * work is stashed (never destroyed) and this requires explicit opt-in.
   */
  async restoreGit(id: string, opts?: { allowDirtyRestore?: boolean }): Promise<{ stashed: boolean; head?: string }> {
    const ckpt = this.get(id);
    if (!ckpt.gitHead) throw new ForgeError('CHECKPOINT_FAILED', `Checkpoint ${id} has no git state to restore`);
    const current = await this.captureGit();
    if (!current.available) throw new ForgeError('CHECKPOINT_FAILED', 'Not a git repository — cannot restore git state');
    if (current.dirty && !opts?.allowDirtyRestore) {
      throw new ForgeError('CHECKPOINT_FAILED',
        'Working tree has uncommitted changes. Pass allowDirtyRestore to stash them and continue, or commit first.',
        { details: { gitHead: ckpt.gitHead } });
    }
    let stashed = false;
    if (current.dirty) {
      const stash = await runProcess('git', ['stash', 'push', '-m', `forge-checkpoint-restore-${ckpt.id}`], { cwd: this.projectDir, timeoutMs: 30_000 });
      if (stash.exitCode !== 0) throw new ForgeError('CHECKPOINT_FAILED', `Failed to stash working tree: ${stash.stderr.slice(0, 1000)}`);
      stashed = true;
    }
    const reset = await runProcess('git', ['reset', '--hard', ckpt.gitHead], { cwd: this.projectDir, timeoutMs: 60_000 });
    if (reset.exitCode !== 0) throw new ForgeError('CHECKPOINT_FAILED', `git reset failed: ${reset.stderr.slice(0, 1000)}`);
    this.bus.emit({ type: 'checkpoint.restored', sessionId: ckpt.sessionId, data: { checkpointId: ckpt.id, git: true, stashed } });
    return { stashed, head: ckpt.gitHead };
  }
}
