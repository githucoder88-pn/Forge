import { z } from "zod";
import { PROTOCOL_VERSION } from "./events.ts";

/**
 * Forge Protocol v1 — JSON-RPC 2.0 over HTTP POST /rpc and WebSocket.
 * Every method has a zod-validated params schema; responses are plain JSON.
 */

export const RPC_METHODS = [
  "health",
  "create_session",
  "get_session",
  "list_sessions",
  "resume_session",
  "send_message",
  "get_agent",
  "get_session_state",
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "search_files",
  "execute_shell",
  "git_status",
  "git_diff",
  "git_log",
  "run_test",
  "run_build",
  "stream_events",
  "cancel_agent",
  "resolve_approval",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

const idString = z.string().min(1).max(128);

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
  protocol: z.literal(PROTOCOL_VERSION).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const HealthParams = z.object({}).strict().optional();
export const CreateSessionParams = z.object({
  workspaceRoot: z.string().min(1).max(1024),
  title: z.string().max(256).optional(),
  provider: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  permissions: z
    .object({
      mode: z.enum(["read-only", "workspace-write", "full-workspace"]).optional(),
      approval: z.enum(["always", "risky-only", "never"]).optional(),
    })
    .optional(),
  maxIterations: z.number().int().min(1).max(200).optional(),
});
export const GetSessionParams = z.object({ sessionId: idString });
export const ListSessionsParams = z
  .object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() })
  .optional();
export const ResumeSessionParams = z.object({ sessionId: idString, afterSeq: z.number().int().min(0).optional() });
export const SendMessageParams = z.object({
  sessionId: idString,
  content: z.string().min(1).max(200_000),
  agentId: idString.optional(),
});
export const GetAgentParams = z.object({ agentId: idString });
export const GetSessionStateParams = z.object({ sessionId: idString, afterSeq: z.number().int().min(0).optional() });
export const ReadFileParams = z.object({ sessionId: idString, path: z.string().min(1).max(1024) });
export const WriteFileParams = z.object({
  sessionId: idString,
  path: z.string().min(1).max(1024),
  content: z.string().max(5_000_000),
  createDirs: z.boolean().optional(),
});
export const EditFileParams = z.object({
  sessionId: idString,
  path: z.string().min(1).max(1024),
  oldText: z.string().min(1).max(1_000_000),
  newText: z.string().max(1_000_000),
  expectUnique: z.boolean().optional(),
});
export const ListDirectoryParams = z.object({
  sessionId: idString,
  path: z.string().max(1024).optional(),
  recursive: z.boolean().optional(),
});
export const SearchFilesParams = z.object({
  sessionId: idString,
  query: z.string().min(1).max(512),
  include: z.string().max(256).optional(),
  maxResults: z.number().int().min(1).max(500).optional(),
});
export const ExecuteShellParams = z.object({
  sessionId: idString,
  command: z.string().min(1).max(8000),
  cwd: z.string().max(1024).optional(),
  timeoutMs: z.number().int().min(100).max(1_800_000).optional(),
});
export const GitStatusParams = z.object({ sessionId: idString });
export const GitDiffParams = z.object({
  sessionId: idString,
  staged: z.boolean().optional(),
  path: z.string().max(1024).optional(),
});
export const GitLogParams = z.object({ sessionId: idString, limit: z.number().int().min(1).max(100).optional() });
export const RunTestParams = z.object({
  sessionId: idString,
  command: z.string().max(8000).optional(),
  cwd: z.string().max(1024).optional(),
  timeoutMs: z.number().int().min(100).max(1_800_000).optional(),
});
export const RunBuildParams = RunTestParams;
export const StreamEventsParams = z.object({
  sessionId: idString,
  afterSeq: z.number().int().min(0).optional(),
});
export const CancelAgentParams = z.object({ agentId: idString, reason: z.string().max(512).optional() });
export const ResolveApprovalParams = z.object({ approvalId: idString, approved: z.boolean() });

export const PARAM_SCHEMAS: Record<RpcMethod, z.ZodTypeAny> = {
  health: HealthParams,
  create_session: CreateSessionParams,
  get_session: GetSessionParams,
  list_sessions: ListSessionsParams,
  resume_session: ResumeSessionParams,
  send_message: SendMessageParams,
  get_agent: GetAgentParams,
  get_session_state: GetSessionStateParams,
  read_file: ReadFileParams,
  write_file: WriteFileParams,
  edit_file: EditFileParams,
  list_directory: ListDirectoryParams,
  search_files: SearchFilesParams,
  execute_shell: ExecuteShellParams,
  git_status: GitStatusParams,
  git_diff: GitDiffParams,
  git_log: GitLogParams,
  run_test: RunTestParams,
  run_build: RunBuildParams,
  stream_events: StreamEventsParams,
  cancel_agent: CancelAgentParams,
  resolve_approval: ResolveApprovalParams,
};

export interface RpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
  protocol: typeof PROTOCOL_VERSION;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: string | number;
  error: { code: number; message: string; data?: { forgeCode: string; retryable: boolean; details?: unknown } };
  protocol: typeof PROTOCOL_VERSION;
}

export type RpcResponse<T = unknown> = RpcSuccess<T> | RpcFailure;
