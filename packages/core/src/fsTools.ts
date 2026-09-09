import { z } from "zod";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { ForgeError } from "@forge/protocol";
import type { ToolDefinition, ToolRegistry } from "./toolRegistry.ts";

const pathField = z.string().min(1).max(1024);

function diffPreview(before: string, after: string, maxLines = 24): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // Find first/last differing regions for a compact preview.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const ctx = 2;
  const from = Math.max(0, start - ctx);
  const out: string[] = [];
  for (let i = from; i < start; i++) out.push(`  ${a[i]}`);
  for (let i = start; i <= Math.min(endA, start + maxLines); i++) out.push(`- ${a[i]}`);
  if (endA - start > maxLines) out.push(`- … (${endA - start - maxLines} more lines)`);
  for (let i = start; i <= Math.min(endB, start + maxLines); i++) out.push(`+ ${b[i]}`);
  if (endB - start > maxLines) out.push(`+ … (${endB - start - maxLines} more lines)`);
  const tailA = endA + 1;
  for (let i = tailA; i < Math.min(a.length, tailA + ctx); i++) out.push(`  ${a[i]}`);
  return out.slice(0, maxLines + 8).join("\n");
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".forge", "dist", "build", "out", "target", "coverage",
  ".next", ".nuxt", ".output", ".turbo", ".parcel-cache", "vendor", "__pycache__",
  ".venv", ".idea", ".vscode",
]);

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export function registerFsTools(registry: ToolRegistry): void {
  const defs: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read a file from the workspace. Returns content with byte/line counts. Paths are workspace-relative.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path" } }, required: ["path"] },
      input: z.object({ path: pathField }),
      async execute(ctx) {
        const { path } = ctx.input as { path: string };
        const r = await ctx.workspace.readFile(path, ctx.config.limits.maxFileBytes);
        ctx.agent.metrics.filesRead++;
        return { path: r.rel, bytes: r.bytes, lines: r.lines, truncated: r.truncated, content: r.content };
      },
    },
    {
      name: "write_file",
      description: "Write (create or overwrite) a file in the workspace. Use edit_file for surgical changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          createDirs: { type: "boolean", description: "Create parent directories if missing" },
        },
        required: ["path", "content"],
      },
      input: z.object({ path: pathField, content: z.string().max(5_000_000), createDirs: z.boolean().optional() }),
      async execute(ctx) {
        const { path, content, createDirs } = ctx.input as { path: string; content: string; createDirs?: boolean };
        const before = await ctx.workspace.exists(path)
          ? await ctx.workspace.readFile(path, ctx.config.limits.maxFileBytes).then((r) => r.content).catch(() => "")
          : null;
        const r = await ctx.workspace.writeFile(path, content, { createDirs });
        ctx.agent.metrics.filesWritten++;
        ctx.bus.emit(ctx.sessionId, r.created ? "file.created" : "file.modified", {
          path: r.rel, agentId: ctx.agent.id, bytes: r.bytes,
          ...(before !== null ? { diffPreview: diffPreview(before, content) } : {}),
        });
        return { path: r.rel, bytes: r.bytes, created: r.created, success: true };
      },
    },
    {
      name: "create_file",
      description: "Create a new file. Fails if the file already exists (use edit_file to modify).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      input: z.object({ path: pathField, content: z.string().max(5_000_000) }),
      async execute(ctx) {
        const { path, content } = ctx.input as { path: string; content: string };
        if (await ctx.workspace.exists(path)) {
          return { path, success: false, error: `file already exists: ${path}` };
        }
        const r = await ctx.workspace.writeFile(path, content, { createDirs: true });
        ctx.agent.metrics.filesWritten++;
        ctx.bus.emit(ctx.sessionId, "file.created", { path: r.rel, agentId: ctx.agent.id, bytes: r.bytes });
        return { path: r.rel, bytes: r.bytes, success: true };
      },
    },
    {
      name: "edit_file",
      description: "Surgically replace a unique block of text in a file. oldText must appear exactly once (unless expectUnique is false, replacing the first occurrence).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string", description: "Exact text to find" },
          newText: { type: "string", description: "Replacement text" },
          expectUnique: { type: "boolean", description: "Fail unless oldText occurs exactly once (default true)" },
        },
        required: ["path", "oldText", "newText"],
      },
      input: z.object({ path: pathField, oldText: z.string().min(1).max(1_000_000), newText: z.string().max(1_000_000), expectUnique: z.boolean().optional() }),
      async execute(ctx) {
        const { path, oldText, newText, expectUnique } = ctx.input as { path: string; oldText: string; newText: string; expectUnique?: boolean };
        const r = await ctx.workspace.readFile(path, ctx.config.limits.maxFileBytes);
        const occurrences = r.content.split(oldText).length - 1;
        if ((expectUnique ?? true) && occurrences !== 1) {
          throw new ForgeError("InvalidRequest", `edit_file: oldText occurs ${occurrences} times in ${path} (expected exactly 1). Provide more surrounding context.`);
        }
        if (occurrences === 0) throw new ForgeError("InvalidRequest", `edit_file: oldText not found in ${path}`);
        const next = r.content.replace(oldText, newText);
        await ctx.workspace.writeFile(path, next);
        ctx.agent.metrics.filesWritten++;
        const preview = diffPreview(r.content, next);
        ctx.bus.emit(ctx.sessionId, "file.modified", { path: r.rel, agentId: ctx.agent.id, bytes: Buffer.byteLength(next), diffPreview: preview });
        return { path: r.rel, success: true, occurrencesReplaced: 1, diffPreview: preview };
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from the workspace. Destructive — requires approval unless policy allows.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      input: z.object({ path: pathField }),
      async execute(ctx) {
        const { path } = ctx.input as { path: string };
        const r = await ctx.workspace.deleteFile(path);
        ctx.bus.emit(ctx.sessionId, "file.deleted", { path: r.rel, agentId: ctx.agent.id });
        return { path: r.rel, success: true };
      },
    },
    {
      name: "list_directory",
      description: "List files in a workspace directory. Skips .git/node_modules by default.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, recursive: { type: "boolean" } },
        required: [],
      },
      input: z.object({ path: z.string().max(1024).optional(), recursive: z.boolean().optional() }),
      async execute(ctx) {
        const { path, recursive } = ctx.input as { path?: string; recursive?: boolean };
        const entries = await ctx.workspace.listDir(path ?? ".", recursive ?? false);
        return { path: path ?? ".", entries: entries.slice(0, 2000), truncated: entries.length > 2000 };
      },
    },
    {
      name: "search_files",
      description: "Search file contents across the workspace (substring match). Skips .git, node_modules, build output, and large/binary files. Independent of the AI model.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for" },
          include: { type: "string", description: "Optional glob filter, e.g. 'src/*.ts'" },
          maxResults: { type: "integer", description: "Max matches (default 100)" },
        },
        required: ["query"],
      },
      input: z.object({ query: z.string().min(1).max(512), include: z.string().max(256).optional(), maxResults: z.number().int().min(1).max(500).optional() }),
      timeoutMs: 30_000,
      async execute(ctx) {
        const { query, include, maxResults } = ctx.input as { query: string; include?: string; maxResults?: number };
        const limit = Math.min(maxResults ?? 100, ctx.config.limits.maxSearchResults);
        const includeRe = include ? globToRegExp(include) : null;
        const root = ctx.workspace.root;
        const matches: { path: string; line: number; preview: string }[] = [];
        let filesScanned = 0;
        let truncated = false;
        const deadline = Date.now() + 25_000;
        const stack: string[] = [root];
        const q = query.toLowerCase();
        while (stack.length > 0 && matches.length < limit) {
          if (Date.now() > deadline) {
            truncated = true;
            break;
          }
          const dir = stack.pop()!;
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of entries) {
            if (matches.length >= limit) {
              truncated = true;
              break;
            }
            const full = join(dir, e.name);
            const rel = relative(root, full).split(sep).join("/");
            if (e.isDirectory()) {
              if (!SKIP_DIRS.has(e.name)) stack.push(full);
              continue;
            }
            if (!e.isFile()) continue;
            if (includeRe && !includeRe.test(rel) && !includeRe.test(e.name)) continue;
            let st;
            try {
              st = await fs.stat(full);
            } catch {
              continue;
            }
            if (st.size > 512_000) continue;
            filesScanned++;
            let content: string;
            try {
              const buf = await fs.readFile(full);
              if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) continue; // gzip
              let binary = false;
              for (let i = 0; i < Math.min(buf.length, 8000); i++) {
                if (buf[i] === 0) {
                  binary = true;
                  break;
                }
              }
              if (binary) continue;
              content = buf.toString("utf8");
            } catch {
              continue;
            }
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && matches.length < limit; i++) {
              const line = lines[i]!;
              if (line.toLowerCase().includes(q)) {
                matches.push({ path: rel, line: i + 1, preview: line.trim().slice(0, 240) });
              }
            }
          }
        }
        return { query, matches, filesScanned, truncated };
      },
    },
  ];
  for (const d of defs) registry.register(d);
}
