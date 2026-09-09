import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    // Preview/proxy-friendly (Tauri devUrl also uses localhost:1420).
    allowedHosts: true as unknown as string[],
    // Same-origin Core access: the browser never calls localhost directly —
    // /rpc, /health and /ws are proxied to the local Core server.
    proxy: {
      "/rpc": "http://127.0.0.1:8710",
      "/health": "http://127.0.0.1:8710",
      "/ws": { target: "ws://127.0.0.1:8710", ws: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
