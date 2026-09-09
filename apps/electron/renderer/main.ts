import "@forge/web-ui/styles.css";
import { mountForgeUI } from "@forge/web-ui";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// Same Core/protocol as the Tauri and CLI clients — one shared session.
const remote = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
mountForgeUI(root, { defaultCoreUrl: remote ? "" : "http://127.0.0.1:8710", storagePrefix: "forge-electron" });
