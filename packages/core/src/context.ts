import type { Message } from "@forge/protocol";
import { loadInstructions, renderInstructions, type InstructionFile } from "./agentsMd.ts";
import type { Workspace } from "./workspace.ts";

/** Crude-but-bounded token estimate (~4 chars/token for English/code mix). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BuiltContext {
  system: string;
  messages: { role: "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: { id: string; tool: string; input: unknown }[] }[];
  instructions: InstructionFile[];
  estimatedTokens: number;
  truncated: { conversation: boolean; toolResults: boolean };
}

const SYSTEM_BASE = `You are Forge, an autonomous coding agent running inside a real repository.
You have tools to inspect, search, edit, and test code. Work iteratively:

1. Understand the request, then inspect the repository (list files, read relevant code, search).
2. Make the smallest correct change. Prefer edit_file for surgical edits.
3. Run the relevant tests or build. Observe failures and repair them.
4. Never claim success unless a tool actually confirmed it.
5. Keep the final summary short: what changed, how it was verified.

Rules:
- Only use the tools provided. Never invent file contents; read before editing.
- Stay inside the workspace. Destructive commands are denied by policy.
- When tests fail, read the output, fix the cause, and re-run.
- Do not dump secrets. Do not exfiltrate data.`;

/**
 * Bounded, token-aware, deduplicated, inspectable context builder.
 * Budgets: instructions 8k tokens, conversation 24k, tool results 24k (Phase-1 defaults).
 */
export async function buildContext(opts: {
  workspace: Workspace;
  targetPath?: string;
  history: Message[];
  toolResults: { toolCallId: string; tool: string; output: string }[];
  userRequest: string;
  budgetTokens?: number;
}): Promise<BuiltContext> {
  const budget = opts.budgetTokens ?? 48_000;
  const instructions = await loadInstructions(opts.workspace, opts.targetPath ?? ".");
  const rendered = renderInstructions(instructions);
  const system = rendered ? `${SYSTEM_BASE}\n\n${rendered}` : SYSTEM_BASE;

  // Deduplicate identical consecutive tool results (keep first + count).
  const seen = new Map<string, number>();
  const deduped: typeof opts.toolResults = [];
  for (const tr of opts.toolResults) {
    const key = `${tr.tool}:${tr.output}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) deduped.push(tr);
    else deduped.push({ ...tr, output: `[duplicate of previous identical ${tr.tool} result ×${n + 1}; omitted]` });
  }

  const toolBudget = Math.floor(budget * 0.5);
  const convBudget = Math.floor(budget * 0.35);
  let toolTokens = 0;
  const toolMsgs: BuiltContext["messages"] = [];
  let toolTruncated = false;
  // Keep most recent tool results; drop oldest first.
  for (let i = deduped.length - 1; i >= 0; i--) {
    const tr = deduped[i]!;
    const content = `Result of ${tr.tool}:\n${tr.output}`;
    const t = estimateTokens(content);
    if (toolTokens + t > toolBudget && toolMsgs.length > 0) {
      toolTruncated = true;
      continue;
    }
    toolTokens += t;
    toolMsgs.unshift({ role: "tool", content: content.slice(0, 60_000), toolCallId: tr.toolCallId });
  }

  let convTokens = 0;
  const convMsgs: BuiltContext["messages"] = [];
  let convTruncated = false;
  for (let i = opts.history.length - 1; i >= 0; i--) {
    const m = opts.history[i]!;
    if (m.role !== "user" && m.role !== "agent") continue;
    const content = m.content.slice(0, 40_000);
    const t = estimateTokens(content);
    if (convTokens + t > convBudget && convMsgs.length > 0) {
      convTruncated = true;
      break;
    }
    convTokens += t;
    convMsgs.unshift({ role: m.role === "agent" ? "assistant" : "user", content });
  }

  const messages: BuiltContext["messages"] = [...convMsgs, ...toolMsgs, { role: "user", content: opts.userRequest.slice(0, 60_000) }];
  const estimatedTokens = estimateTokens(system) + toolTokens + convTokens + estimateTokens(opts.userRequest);
  return { system, messages, instructions, estimatedTokens, truncated: { conversation: convTruncated, toolResults: toolTruncated } };
}
