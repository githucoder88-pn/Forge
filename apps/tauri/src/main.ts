import "@forge/web-ui/styles.css";
import { mountForgeUI } from "@forge/web-ui";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// Behind a remote preview host use same-origin (vite proxies to Core);
// on a local machine talk to the loopback Core directly.
const remote = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
mountForgeUI(root, { defaultCoreUrl: remote ? "" : "http://127.0.0.1:8710", storagePrefix: "forge-tauri" });
