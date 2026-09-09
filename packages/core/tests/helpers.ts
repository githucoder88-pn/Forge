import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ForgeApp } from "../src/app.ts";
import { MockProvider, type MockStep, type ModelProvider } from "../src/models.ts";
import { CoreServer } from "../src/server.ts";

export function tempDir(prefix = "forge-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface TestApp {
  app: ForgeApp;
  dataDir: string;
  mock: MockProvider;
  cleanup: () => void;
}

/** Isolated Core app with a mock model provider and a scratch workspace. */
export function makeApp(steps: MockStep[] = []): TestApp {
  const dataDir = tempDir();
  const mock = new MockProvider(steps);
  const app = createApp({
    dataDir,
    dbFilename: "test.db",
    autoApprove: true,
    logLevel: "error",
    getProvider: () => mock,
  });
  return { app, dataDir, mock, cleanup: () => app.close() };
}

export interface TestServer {
  server: CoreServer;
  url: string;
  cleanup: () => Promise<void>;
}

/** Start an ephemeral CoreServer for an existing app (port 0). */
export async function startTestServer(app: ForgeApp): Promise<TestServer> {
  app.config.port = 0;
  app.config.host = "127.0.0.1";
  const server = new CoreServer(app);
  const { url } = await server.listen();
  return { server, url, cleanup: async () => { await server.close(); } };
}

export async function rpcCall(
  url: string,
  method: string,
  params: unknown,
  id = 1,
): Promise<{ result?: unknown; error?: { message: string; data?: { forgeCode: string } } }> {
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as { result?: unknown; error?: { message: string; data?: { forgeCode: string } } };
}

export type { ModelProvider };

export function makeWorkspace(files: Record<string, string> = {}): string {
  const root = tempDir("forge-ws-");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
