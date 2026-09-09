import { dirname, join, relative, sep } from "node:path";
import type { Workspace } from "./workspace.ts";

export interface InstructionFile {
  path: string; // workspace-relative
  content: string;
  depth: number; // 0 = workspace root
}

/**
 * Load applicable AGENTS.md instructions for a target path: workspace root
 * first, then each nested directory down to the target's directory.
 * Later (deeper) files take precedence in ordering.
 */
export async function loadInstructions(ws: Workspace, targetPath = ".", maxBytes = 60_000): Promise<InstructionFile[]> {
  const abs = ws.resolvePath(targetPath);
  const chain: string[] = [];
  let dir = abs;
  // Walk from root down to the target dir.
  const rel = relative(ws.root, abs);
  const parts = rel === "" ? [] : rel.split(sep);
  chain.push(ws.root);
  let acc = ws.root;
  for (const part of parts) {
    acc = join(acc, part);
    chain.push(acc);
  }
  void dirname;
  const out: InstructionFile[] = [];
  let budget = maxBytes;
  for (let depth = 0; depth < chain.length && budget > 0; depth++) {
    const candidate = chain[depth]!;
    for (const name of ["AGENTS.md", "agents.md"]) {
      const relPath = relative(ws.root, join(candidate, name)).split(sep).join("/") || name;
      try {
        const r = await ws.readFile(relPath, Math.min(budget + 1000, 32_000));
        const content = r.content.slice(0, budget);
        budget -= content.length;
        out.push({ path: r.rel, content, depth });
        break; // one file per directory
      } catch {
        /* absent — fine */
      }
    }
  }
  return out;
}

export function renderInstructions(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  const sections = files.map((f) => `--- ${f.path} ---\n${f.content.trim()}`).join("\n\n");
  return `Project instructions (root first; deeper files override on conflict):\n${sections}`;
}
