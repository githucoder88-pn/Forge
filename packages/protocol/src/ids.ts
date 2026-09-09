/**
 * Forge domain identity system.
 *
 * All entity IDs are time-sortable UUIDv7 values (RFC 9562) rendered with a
 * human-readable, type-tagged prefix. The prefix makes accidental ID mixing
 * visible at runtime; the branded types below make it a compile error.
 *
 * Randomness comes from `crypto.getRandomValues` (CSPRNG). `Math.random()` is
 * NEVER used for identity generation.
 */

export type Brand<Tag extends string, T = string> = T & { readonly __brand: Tag };

export type AgentId = Brand<"AgentId">;
export type SessionId = Brand<"SessionId">;
export type TaskId = Brand<"TaskId">;
export type MessageId = Brand<"MessageId">;
export type ToolCallId = Brand<"ToolCallId">;
export type WorkspaceId = Brand<"WorkspaceId">;
export type ModelId = Brand<"ModelId">;
export type ProviderId = Brand<"ProviderId">;
export type CheckpointId = Brand<"CheckpointId">;
export type EventId = Brand<"EventId">;
export type ApprovalId = Brand<"ApprovalId">;
export type MemoryId = Brand<"MemoryId">;

const PREFIXES = {
  agent: "agent",
  session: "sess",
  task: "task",
  message: "msg",
  toolcall: "tool",
  workspace: "ws",
  model: "model",
  provider: "prov",
  checkpoint: "ckpt",
  event: "evt",
  approval: "appr",
  memory: "mem",
} as const;

type PrefixKey = keyof typeof PREFIXES;

const UUIDV7_HEX_RE = /^[0-9a-f]{32}$/;

function uuidv7Bytes(nowMs: number, rand: Uint8Array): Uint8Array {
  if (rand.length < 10) throw new Error("ids: need 10 random bytes");
  const b = new Uint8Array(16);
  const t = BigInt(nowMs);
  b[0] = Number((t >> 40n) & 0xffn);
  b[1] = Number((t >> 32n) & 0xffn);
  b[2] = Number((t >> 24n) & 0xffn);
  b[3] = Number((t >> 16n) & 0xffn);
  b[4] = Number((t >> 8n) & 0xffn);
  b[5] = Number(t & 0xffn);
  // version 7 + 12 bits rand_a
  b[6] = 0x70 | (rand[0]! & 0x0f);
  b[7] = rand[1]!;
  // variant 10 + 62 bits rand_b
  b[8] = 0x80 | (rand[2]! & 0x3f);
  b[9] = rand[3]!;
  b[10] = rand[4]!;
  b[11] = rand[5]!;
  b[12] = rand[6]!;
  b[13] = rand[7]!;
  b[14] = rand[8]!;
  b[15] = rand[9]!;
  return b;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Generate a raw (unprefixed) UUIDv7 hex string. Monotonic within the same millisecond. */
let lastMs = 0;
let lastRand = new Uint8Array(10);
function uuidv7Hex(nowMs: number = Date.now()): string {
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand); // CSPRNG — never Math.random()
  if (nowMs === lastMs) {
    // increment previous random bytes to preserve sort order on clock collision
    let carry = 1;
    for (let i = 9; i >= 0 && carry > 0; i--) {
      const v = (lastRand[i] ?? 0) + carry;
      lastRand[i] = v & 0xff;
      carry = v >> 8;
    }
    for (let i = 0; i < 10; i++) rand[i] = lastRand[i]!;
  } else {
    lastRand = Uint8Array.from(rand);
    lastMs = nowMs;
  }
  return hex(uuidv7Bytes(nowMs, rand));
}

function makeId<T extends string>(kind: PrefixKey): Brand<T> {
  return `${PREFIXES[kind]}_${uuidv7Hex()}` as Brand<T>;
}

export function createAgentId(nowMs?: number): AgentId {
  return nowMs === undefined ? makeId<"AgentId">("agent") : (`agent_${uuidv7Hex(nowMs)}` as AgentId);
}
export function createSessionId(): SessionId {
  return makeId<"SessionId">("session");
}
export function createTaskId(): TaskId {
  return makeId<"TaskId">("task");
}
export function createMessageId(): MessageId {
  return makeId<"MessageId">("message");
}
export function createToolCallId(): ToolCallId {
  return makeId<"ToolCallId">("toolcall");
}
export function createWorkspaceId(): WorkspaceId {
  return makeId<"WorkspaceId">("workspace");
}
export function createModelId(): ModelId {
  return makeId<"ModelId">("model");
}
export function createProviderId(): ProviderId {
  return makeId<"ProviderId">("provider");
}
export function createCheckpointId(): CheckpointId {
  return makeId<"CheckpointId">("checkpoint");
}
export function createEventId(): EventId {
  return makeId<"EventId">("event");
}
export function createApprovalId(): ApprovalId {
  return makeId<"ApprovalId">("approval");
}
export function createMemoryId(): MemoryId {
  return makeId<"MemoryId">("memory");
}

export interface ParsedId {
  kind: PrefixKey;
  uuidHex: string;
  /** Milliseconds since epoch embedded in the UUIDv7 timestamp. */
  timestampMs: number;
}

/** Parse + validate a Forge ID. Returns null when malformed. */
export function parseId(id: string): ParsedId | null {
  const sep = id.indexOf("_");
  if (sep <= 0) return null;
  const prefix = id.slice(0, sep);
  const rest = id.slice(sep + 1);
  const entry = (Object.entries(PREFIXES) as [PrefixKey, string][]).find(([, p]) => p === prefix);
  if (!entry) return null;
  if (!UUIDV7_HEX_RE.test(rest)) return null;
  // version nibble must be 7, variant bits 10
  if (rest[12] !== "7") return null;
  const variant = parseInt(rest[16]!, 16);
  if ((variant & 0b1100) !== 0b1000) return null;
  const timestampMs = Number(BigInt("0x" + rest.slice(0, 12)));
  return { kind: entry[0], uuidHex: rest, timestampMs };
}

/** True when `id` is a well-formed Forge ID of the given kind. */
export function isIdOfKind(id: string, kind: PrefixKey): boolean {
  return parseId(id)?.kind === kind;
}

export const ID_PREFIX = PREFIXES;
