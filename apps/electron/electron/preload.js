// Minimal, audited bridge: versions only. No fs/shell/process access.
"use strict";
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("forgeDesktop", {
  shell: "electron",
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
