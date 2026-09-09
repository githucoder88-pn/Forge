// Forge Tauri shell (Phase 1).
//
// The shell is deliberately thin: all agent/session/tool/model state lives in
// Forge Core and is reached over the versioned HTTP+WebSocket protocol. The
// frontend (Vite, ../../src) connects to an already-running Core — the shell
// owns no task state and executes no tools.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run Forge");
}
