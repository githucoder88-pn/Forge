import { defineConfig } from "vite";

export default defineConfig({
  root: "renderer",
  server: {
    port: 1421,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true as unknown as string[],
    // Same-origin Core access (see apps/tauri/vite.config.ts).
    proxy: {
      "/rpc": "http://127.0.0.1:8710",
      "/health": "http://127.0.0.1:8710",
      "/ws": { target: "ws://127.0.0.1:8710", ws: true },
    },
  },
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
    target: "es2022",
  },
});
