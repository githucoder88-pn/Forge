#!/usr/bin/env node
/** `forge serve` entry — starts a standalone Core server. */
import { createApp } from "./app.ts";
import { CoreServer } from "./server.ts";

const app = createApp({
  autoApprove: process.env.FORGE_AUTO_APPROVE === "1",
  logLevel: (process.env.FORGE_LOG_LEVEL as "info") ?? "info",
});
const server = new CoreServer(app);

const shutdown = async (): Promise<void> => {
  app.log.info("shutting down core");
  await server.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const { url } = await server.listen();
console.log(`forge-core ${url} (protocol 1.0)`);
