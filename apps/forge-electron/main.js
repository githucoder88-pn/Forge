/**
 * Forge Electron shell — a thin client. It connects to a running Core
 * server (forge serve) and hosts the web client. It implements no
 * orchestration, routing, tools or state of its own.
 *
 * Requires: `npm install --save-dev electron` on a machine with network
 * access to the Electron releases, then `npx electron .`.
 */
'use strict';

let electron;
try {
  electron = require('electron');
} catch {
  console.error('forge-electron: the `electron` runtime is not installed.');
  console.error('Install it with: npm install --save-dev electron');
  console.error('Then start the Core server (forge serve) and run: npx electron .');
  process.exit(1);
}

const { app, BrowserWindow } = electron;

const SERVER_URL = process.env.FORGE_URL || 'http://127.0.0.1:8719';

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Forge',
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(SERVER_URL.replace(/\/$/, '') + '/app/');
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    if (code === -102) return; // user abort
    win.loadURL('data:text/html,' + encodeURIComponent(
      '<body style="background:#0d1117;color:#d6dde6;font-family:sans-serif;padding:40px">' +
      '<h2>Forge server unreachable</h2><p>' + desc + '</p>' +
      '<p>Start it with <code>forge serve</code> (default ' + SERVER_URL + '), then reload.</p></body>',
    ));
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
