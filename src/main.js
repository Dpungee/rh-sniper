import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sniper } from './engine/sniper.js';
import { keystoreExists, saveKey, unlock, savedAddress } from './engine/keystore.js';
import { loadConfig } from './engine/chain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win = null;
let sniper = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: true,
    backgroundColor: '#0b0d10',
    title: 'RH Chain Sniper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui/index.html'));
}

function ensureSniper() {
  if (sniper) return sniper;
  sniper = new Sniper();
  sniper.on('log', (e) => send('log', e));
  sniper.on('state', (e) => send('state', e));
  sniper.on('fired', (e) => send('fired', { hash: e.hash, symbol: e.token.symbol }));
  return sniper;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- IPC ----
ipcMain.handle('config:get', () => {
  const cfg = loadConfig();
  return {
    chain: cfg.chain,
    dex: cfg.dex,
    defaults: cfg.defaults,
    safetyEnabled: !!cfg.safety?.enabled,
    hasKey: keystoreExists(),
    address: savedAddress(),
    routerSet: !/^0x0+$/.test(cfg.dex.router),
    factorySet: !/^0x0+$/.test(cfg.dex.factory)
  };
});

ipcMain.handle('key:import', (_e, { privateKey, password }) => {
  const address = saveKey(privateKey, password);
  return { address };
});

ipcMain.handle('key:unlock', (_e, { password }) => {
  const account = unlock(password);
  ensureSniper().useAccount(account);
  return { address: account.address };
});

ipcMain.handle('snipe:arm', (_e, params) => {
  ensureSniper().arm(params);
  return { ok: true };
});

ipcMain.handle('snipe:disarm', () => {
  ensureSniper().disarm();
  return { ok: true };
});
