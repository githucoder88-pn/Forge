import { promises as fs, constants as fsConstants, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { ForgeError } from "@forge/protocol";

/**
 * Workspace abstraction — every filesystem operation flows through here.
 * Paths are normalized and jailed to `root`; traversal escapes are rejected
 * with WorkspaceViolation before any I/O happens.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    const resolved = resolve(root);
    try {
      const st = statSync(resolved);
      if (!st.isDirectory()) throw new ForgeError("InvalidRequest", `workspace root is not a directory: ${root}`);
    } catch (e) {
      if (ForgeError.isForgeError(e)) throw e;
      throw new ForgeError("NotFound", `workspace root does not exist: ${root}`, { cause: e });
    }
    this.root = resolved;
  }

  /** Resolve a workspace-relative (or absolute-inside-root) path to an absolute path. Throws on escape. */
  resolvePath(p: string): string {
    if (typeof p !== "string" || p.length === 0 || p.length > 4096) {
      throw new ForgeError("InvalidRequest", "path must be a non-empty string");
    }
    if (p.includes("\0")) throw new ForgeError("InvalidRequest", "path contains NUL byte");
    // Disallow home-dir expansion tricks and UNC shares.
    if (p.startsWith("~")) throw new ForgeError("WorkspaceViolation", "home-relative paths are not allowed");
    const abs = isAbsolute(p) ? normalize(p) : resolve(join(this.root, p));
    const rel = relative(this.root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ForgeError("WorkspaceViolation", `path escapes workspace: ${p}`);
    }
    return abs;
  }

  /** Workspace-relative display path (posix-style) for events and model context. */
  displayPath(abs: string): string {
    return relative(this.root, abs).split(sep).join("/") || ".";
  }

  async readFile(p: string, maxBytes: number): Promise<{ abs: string; rel: string; content: string; bytes: number; lines: number; truncated: boolean }> {
    const abs = this.resolvePath(p);
    let st;
    try {
      st = await fs.stat(abs);
    } catch (e) {
      throw new ForgeError("NotFound", `file not found: ${p}`, { cause: e });
    }
    if (!st.isFile()) throw new ForgeError("InvalidRequest", `not a file: ${p}`);
    const fh = await fs.open(abs, fsConstants.O_RDONLY);
    try {
      const size = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      const content = buf.toString("utf8");
      return { abs, rel: this.displayPath(abs), content, bytes: st.size, lines: content.split("\n").length, truncated: st.size > maxBytes };
    } finally {
      await fh.close();
    }
  }

  async writeFile(p: string, content: string, opts?: { createDirs?: boolean }): Promise<{ abs: string; rel: string; bytes: number; created: boolean }> {
    const abs = this.resolvePath(p);
    let created = false;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new ForgeError("InvalidRequest", `not a file: ${p}`);
    } catch (e) {
      if (e instanceof ForgeError && e.code !== "NotFound") throw e;
      if (e instanceof ForgeError && e.code === "NotFound" && (e as unknown as { code: string }).code === "NotFound") {
        created = true; // stat says missing OR our own NotFound — treat as create
      } else if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        created = true;
      } else if (!ForgeError.isForgeError(e)) {
        throw ForgeError.fromUnknown(e);
      } else throw e;
    }
    if (opts?.createDirs) await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return { abs, rel: this.displayPath(abs), bytes: Buffer.byteLength(content), created };
  }

  async deleteFile(p: string): Promise<{ abs: string; rel: string }> {
    const abs = this.resolvePath(p);
    try {
      await fs.unlink(abs);
    } catch (e) {
      throw new ForgeError("NotFound", `file not found: ${p}`, { cause: e });
    }
    return { abs, rel: this.displayPath(abs) };
  }

  async listDir(p = ".", recursive = false): Promise<{ path: string; name: string; type: "file" | "dir" | "other"; size: number }[]> {
    const abs = this.resolvePath(p);
    const out: { path: string; name: string; type: "file" | "dir" | "other"; size: number }[] = [];
    const skip = new Set([".git", "node_modules", ".forge"]);
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        if (depth === 0 && skip.has(e.name) && e.name !== ".") continue;
        const full = join(dir, e.name);
        let size = 0;
        try {
          const st = await fs.stat(full);
          size = st.size;
        } catch {
          continue;
        }
        out.push({
          path: this.displayPath(full),
          name: e.name,
          type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
          size,
        });
        if (recursive && e.isDirectory() && out.length < 5000) await walk(full, depth + 1);
      }
    };
    await walk(abs, 0);
    return out;
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.stat(this.resolvePath(p));
      return true;
    } catch {
      return false;
    }
  }
}
