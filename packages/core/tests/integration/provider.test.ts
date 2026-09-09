import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ForgeError } from "@forge/protocol";
import { loadConfig } from "../../src/config.ts";
import { Logger } from "../../src/logger.ts";
import { OpenAIProvider } from "../../src/models.ts";

/** Local stub of the OpenAI chat-completions SSE API — proves the real adapter. */
function startStub(chunks: string[], status = 200): Promise<{ url: string; close: () => Promise<void>; seen: { body: string } }> {
  const seen = { body: "" };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.body = body;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const c of chunks) res.write(`data: ${c}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())), seen });
    });
  });
}

describe("openai provider adapter", () => {
  it("streams text and accumulates tool calls", async () => {
    const msg = (delta: unknown, finish?: string) =>
      JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] });
    const stub = await startStub([
      msg({ content: "I'll read " }),
      msg({ content: "the file." }),
      msg({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path"' } }] }),
      msg({ tool_calls: [{ index: 0, function: { arguments: ': "a.txt"}' } }] }, "tool_calls"),
    ]);
    try {
      const config = loadConfig({ openaiApiKey: "sk-test-stub", openaiBaseUrl: stub.url });
      const provider = new OpenAIProvider(config, new Logger("error"));
      const events: string[] = [];
      const resp = await provider.complete(
        {
          model: "stub-model",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "read_file", description: "r", parameters: { type: "object", properties: {} } }],
          signal: new AbortController().signal,
        },
        (e) => events.push(e.kind),
      );
      assert.equal(resp.text, "I'll read the file.");
      assert.equal(resp.toolCalls.length, 1);
      assert.equal(resp.toolCalls[0]?.tool, "read_file");
      assert.deepEqual(resp.toolCalls[0]?.input, { path: "a.txt" });
      assert.ok(events.includes("text") && events.includes("toolcall"));
      const sent = JSON.parse(stub.seen.body) as { model: string; stream: boolean; tools: unknown[] };
      assert.equal(sent.model, "stub-model");
      assert.equal(sent.stream, true);
      assert.equal(sent.tools.length, 1);
    } finally {
      await stub.close();
    }
  });

  it("maps provider errors to typed failures and requires credentials", async () => {
    const stub = await startStub([], 500);
    try {
      const config = loadConfig({ openaiApiKey: "sk-test-stub", openaiBaseUrl: stub.url });
      const provider = new OpenAIProvider(config, new Logger("error"));
      await assert.rejects(
        () => provider.complete({ model: "m", system: "s", messages: [], tools: [], signal: new AbortController().signal }, () => {}),
        (e: unknown) => e instanceof ForgeError && e.code === "ProviderUnavailable",
      );
    } finally {
      await stub.close();
    }
    const noKey = loadConfig({ openaiApiKey: null });
    const p2 = new OpenAIProvider(noKey, new Logger("error"));
    await assert.rejects(
      () => p2.complete({ model: "m", system: "s", messages: [], tools: [], signal: new AbortController().signal }, () => {}),
      (e: unknown) => e instanceof ForgeError && e.code === "ProviderUnavailable",
    );
  });

  it("propagates cancellation to the in-flight request", async () => {
    const stub = await startStub([JSON.stringify({ choices: [{ delta: { content: "hi" } }] })]);
    try {
      const config = loadConfig({ openaiApiKey: "sk-test-stub", openaiBaseUrl: stub.url });
      const provider = new OpenAIProvider(config, new Logger("error"));
      const c = new AbortController();
      c.abort(new Error("stop"));
      await assert.rejects(
        () => provider.complete({ model: "m", system: "s", messages: [], tools: [], signal: c.signal }, () => {}),
        (e: unknown) => e instanceof ForgeError && e.code === "Cancelled",
      );
    } finally {
      await stub.close();
    }
  });
});
