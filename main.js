const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, screen, clipboard, session, safeStorage, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const si = require('systeminformation');
const { ActivityLogger } = require('./activity-logger');
const { ActivityServer, scryptHash } = require('./activity-server');
const { VaultManager } = require('./vault-manager');
const platform = require('./lib/platform');
const { initUpdater } = require('./lib/updater');

// Try to load any installed node-pty variant. If none is available we fall
// back to child_process for the terminal plugin (limited features but no
// native build required). To upgrade to full PTY: install one of these
// (and run electron-rebuild if necessary):
//   npm i node-pty
//   npm i node-pty-prebuilt-multiarch
//   npm i @homebridge/node-pty-prebuilt-multiarch
let nodePty = null;
let nodePtyError = null;
function loadNodePty() {
  if (nodePty) return nodePty;
  if (nodePtyError !== null) return null;
  const candidates = [
    '@homebridge/node-pty-prebuilt-multiarch',
    'node-pty-prebuilt-multiarch',
    'node-pty',
  ];
  for (const name of candidates) {
    try {
      nodePty = require(name);
      console.log('[pty] loaded ' + name);
      return nodePty;
    } catch (e) {
      nodePtyError = e.message || String(e);
    }
  }
  console.log('[pty] no native PTY available — terminal will use child_process fallback');
  return null;
}

// Where plugins live: bundled-and-copied for packaged builds, in-tree for dev.
const PLUGINS_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'plugins')
  : path.join(__dirname, 'plugins');

// Persisted window/app state lives next to userData so it survives reinstalls
const SETTINGS_FILE = path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeWindowState(patch) {
  const cur = readWindowState();
  const next = { ...cur, ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('Failed to write window state:', e);
  }
  return next;
}

// Seeded once on the very first launch (no settings file yet). Locks in
// skinMode: false as the default — subsequent launches read whatever the
// user toggled to via setSkinMode(). The seeded marker prevents this from
// re-running and clobbering the user's later choice.
//
// On Windows, uninstalling Dashboard doesn't remove %APPDATA%/Dashboard, so
// without this scrub a fresh install would inherit the previous user's saved
// server credentials. We wipe saved-servers.bin on definitive first run so
// new installs always start with no remembered hubs.
function seedFirstRunDefaultsIfNeeded() {
  const cur = readWindowState();
  if (cur.firstRunSeeded) return;

  const serversFile = path.join(app.getPath('userData'), 'saved-servers.bin');
  try { fs.unlinkSync(serversFile); } catch { /* not present — fine */ }

  writeWindowState({
    skinMode: false,
    firstRunSeeded: true,
  });
}

// ---------- Skin mode ----------
// "Pin to desktop" implementation lives in lib/platform-{win32,darwin,linux}.js.
// On Windows the implementation reparents into Progman's wallpaper layer; on
// Linux it sets _NET_WM_WINDOW_TYPE_DESKTOP via xprop; on macOS it lowers the
// window level via setAlwaysOnTop(true, 'desktop'). Renderer detects platform
// support via app:supportsSkinMode below.

// Cross-platform window-handle accessor — used to filter our own window out
// of windows:list and as the renderer-facing identifier where needed.
function getWinHwnd(win) {
  if (!win) return null;
  const buf = win.getNativeWindowHandle();
  if (!buf || buf.length === 0) return null;
  if (process.platform === 'win32') {
    return process.arch === 'x64'
      ? buf.readBigUInt64LE().toString()
      : buf.readUInt32LE().toString();
  }
  // Linux X11: 32-bit XID. macOS: NSView pointer (we don't compare against
  // any external API on mac — list() uses pid:index handles — so any stable
  // string is fine).
  if (buf.length >= 4) return buf.readUInt32LE().toString();
  return null;
}

const pinWindowToDesktop = platform.pinWindowToDesktop;

let mainWindow = null;

function createWindow() {
  const saved = readWindowState();
  const skinMode = !!saved.skinMode;

  const baseOpts = {
    show: false, // shown after ready-to-show (and after pinning if skin mode)
    backgroundColor: '#0a0e0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // enables the <webview> tag used by the browser plugin
    },
  };

  let opts;
  if (skinMode) {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    opts = {
      ...baseOpts,
      x: wa.x, y: wa.y,
      width: wa.width, height: wa.height,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: false,
      fullscreen: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
    };
  } else {
    opts = {
      ...baseOpts,
      width: saved.width || 1400,
      height: saved.height || 900,
      x: saved.x,
      y: saved.y,
      fullscreen: !!saved.fullScreen,
      alwaysOnTop: !!saved.alwaysOnTop,
      titleBarStyle: 'hiddenInset',
    };
  }

  const win = new BrowserWindow(opts);
  mainWindow = win;
  // Tell the auto-updater about the current window so update events route to
  // the live renderer (e.g. after a skin-mode toggle recreates the window).
  initUpdater(win);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', async () => {
    if (skinMode) {
      try { await pinWindowToDesktop(win); }
      catch (err) { console.error('Skin mode pin failed:', err.message); }
    }
    if (!win.isDestroyed()) win.show();
  });

  // Use captured `win` (not mainWindow) so listeners survive recreation
  win.on('enter-full-screen', () => {
    if (skinMode) return;
    writeWindowState({ fullScreen: true });
    if (!win.isDestroyed()) win.webContents.send('window:fullScreenChanged', true);
  });
  win.on('leave-full-screen', () => {
    if (skinMode) return;
    writeWindowState({ fullScreen: false });
    if (!win.isDestroyed()) win.webContents.send('window:fullScreenChanged', false);
  });

  if (!skinMode) {
    let saveTimer = null;
    const saveBounds = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win.isDestroyed() && !win.isFullScreen()) {
          const b = win.getBounds();
          writeWindowState({ width: b.width, height: b.height, x: b.x, y: b.y });
        }
      }, 400);
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
  }
}

let recreating = false;

async function setSkinMode(enabled) {
  recreating = true;
  // Skin mode + alwaysOnTop are mutually exclusive
  writeWindowState({ skinMode: !!enabled, alwaysOnTop: false });

  const old = mainWindow;
  createWindow(); // reassigns mainWindow

  // Wait for the new window to actually be visible before closing the old one
  await new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve();
    if (mainWindow.isVisible()) return resolve();
    const onShow = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => {
      mainWindow && mainWindow.removeListener('show', onShow);
      resolve();
    }, 5000);
    mainWindow.once('show', onShow);
  });

  if (old && !old.isDestroyed()) {
    try { old.removeAllListeners(); } catch {}
    try { old.destroy(); } catch {}
  }

  recreating = false;
  return !!enabled;
}

async function ensurePluginsDir() {
  await fsp.mkdir(PLUGINS_DIR, { recursive: true });
}

async function listPlugins() {
  await ensurePluginsDir();
  const entries = await fsp.readdir(PLUGINS_DIR, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const full = path.join(PLUGINS_DIR, entry.name);
    if (entry.isDirectory()) {
      // Look for plugin.jsx, plugin.js, index.jsx, index.js
      const candidates = ['plugin.jsx', 'plugin.js', 'index.jsx', 'index.js'];
      for (const c of candidates) {
        const p = path.join(full, c);
        if (fs.existsSync(p)) {
          plugins.push({ id: entry.name, path: p });
          break;
        }
      }
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.jsx'))) {
      plugins.push({ id: entry.name.replace(/\.(jsx?|tsx?)$/, ''), path: full });
    }
  }
  return plugins;
}

async function readPluginSource(pluginPath) {
  // Safety: only allow paths inside PLUGINS_DIR
  const resolved = path.resolve(pluginPath);
  if (!resolved.startsWith(path.resolve(PLUGINS_DIR))) {
    throw new Error('Refusing to read outside plugins directory');
  }
  const source = await fsp.readFile(resolved, 'utf8');
  return source;
}

// ---------- Activity logger + host server ----------
// All persisted "everything you do in the app" lives in userData/activity/.
// The logger wraps ipcMain.handle below so every IPC call is logged for free.
// Renderer-side events (localStorage writes, plugin-emitted activity) come in
// via the 'activity:log' channel, and the HTTP server in activity-server.js
// exposes the log over a token-authed loopback (or LAN) endpoint.

const ACTIVITY_DIR = path.join(app.getPath('userData'), 'activity');
const HOST_CONFIG_FILE = path.join(app.getPath('userData'), 'host-config.json');

function readHostConfig() {
  try {
    const o = JSON.parse(fs.readFileSync(HOST_CONFIG_FILE, 'utf8'));
    if (!o || typeof o !== 'object') return {};
    return o;
  } catch { return {}; }
}
function writeHostConfig(patch) {
  const cur = readHostConfig();
  const next = { ...cur, ...patch };
  try {
    fs.mkdirSync(path.dirname(HOST_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(HOST_CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch (e) { console.error('host config write failed:', e); }
  return next;
}

const activityLogger = new ActivityLogger(ACTIVITY_DIR);
const activityServer = new ActivityServer(activityLogger);

// IPC channels we don't want to log because they're chatty / pure reads.
// (system stats poll multiple times per second per plugin.)
const IPC_NOLOG = new Set([
  'system:stats', 'system:processes', 'system:networkStats', 'system:networkInterfaces',
  'system:drives', 'system:battery', 'system:ping',
  'windows:list',
  'plugins:list', 'plugins:read', 'plugins:dirPath',
  'notes:list', 'notes:getDir', 'notes:getDefaultDir',
  'fs:list', 'fs:stat', 'fs:read',
  'shell:getFileIcon', 'shell:readShortcut',
  'apps:discover',
  'clipboard:read',
  'window:isFullScreen', 'window:isAlwaysOnTop', 'window:isSkinMode',
  'app:version', 'app:isPackaged', 'app:platform',
  'power:list',
  'updates:status',
  'settings:getAutoStart',
  'browser:getStealthPreloadUrl',
  'host:status', 'host:tail', 'host:getConfig', 'host:localIps',
  'servers:list', 'servers:getPassword', // password values would leak otherwise
  'host:setPassword', // raw password is the argument — never log it
  'activity:log', // logged directly with its real source/channel
  'pty:write', 'pty:resize', // very chatty terminal traffic
]);

// Wrap ipcMain.handle so every channel gets logged automatically.
const _origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function loggedHandle(channel, listener) {
  return _origHandle(channel, async (event, ...args) => {
    const t0 = Date.now();
    let ok = true, error;
    try {
      const result = await listener(event, ...args);
      return result;
    } catch (err) {
      ok = false;
      error = err && err.message ? err.message : String(err);
      throw err;
    } finally {
      if (!IPC_NOLOG.has(channel)) {
        activityLogger.log('ipc', channel, args, {
          ok,
          ms: Date.now() - t0,
          ...(error ? { error } : {}),
        });
      }
    }
  });
};

// Renderer-side event bridge. The preload exposes window.dashboard.activity.log
// and a localStorage proxy that calls into it.
ipcMain.handle('activity:log', (_e, source, channel, payload, extras) => {
  activityLogger.log(
    String(source || 'renderer'),
    String(channel || ''),
    payload,
    extras && typeof extras === 'object' ? extras : undefined,
  );
  return true;
});

// Host tab IPC — auth is password-based; the password is hashed with
// scrypt and stored in host-config.json. Sessions live in server memory.
function loadCredentialsIntoServer() {
  const cfg = readHostConfig();
  activityServer.setCredentials({
    passwordHashHex: cfg.passwordHashHex || null,
    passwordSaltHex: cfg.passwordSaltHex || null,
  });
}

ipcMain.handle('host:status', () => activityServer.status());

ipcMain.handle('host:getConfig', () => {
  const cfg = readHostConfig();
  return {
    port: cfg.port || 7878,
    lan: !!cfg.lan,
    autoStart: !!cfg.autoStart,
    passwordSet: !!cfg.passwordHashHex,
    loggingEnabled: cfg.loggingEnabled !== false,
  };
});

ipcMain.handle('host:setConfig', (_e, patch) => {
  const p = patch || {};
  const next = {};
  if (typeof p.port === 'number' && p.port > 0 && p.port < 65536) next.port = Math.floor(p.port);
  if (typeof p.lan === 'boolean') next.lan = p.lan;
  if (typeof p.autoStart === 'boolean') next.autoStart = p.autoStart;
  if (typeof p.loggingEnabled === 'boolean') {
    next.loggingEnabled = p.loggingEnabled;
    activityLogger.setEnabled(p.loggingEnabled);
  }
  const saved = writeHostConfig(next);
  return {
    port: saved.port || 7878,
    lan: !!saved.lan,
    autoStart: !!saved.autoStart,
    passwordSet: !!saved.passwordHashHex,
    loggingEnabled: saved.loggingEnabled !== false,
  };
});

ipcMain.handle('host:setPassword', async (_e, newPassword) => {
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return { ok: false, error: 'password must be at least 6 characters' };
  }
  const salt = crypto.randomBytes(16);
  const hash = await scryptHash(newPassword, salt);
  writeHostConfig({
    passwordHashHex: hash.toString('hex'),
    passwordSaltHex: salt.toString('hex'),
  });
  loadCredentialsIntoServer();
  activityLogger.log('system', 'host:password-changed', null);
  return { ok: true };
});

ipcMain.handle('host:clearPassword', () => {
  writeHostConfig({ passwordHashHex: null, passwordSaltHex: null });
  loadCredentialsIntoServer();
  // If running, stop — server can't run without a password
  if (activityServer.isRunning()) activityServer.stop();
  activityLogger.log('system', 'host:password-cleared', null);
  return { ok: true };
});

ipcMain.handle('host:start', async () => {
  const cfg = readHostConfig();
  if (!cfg.passwordHashHex) {
    return { ok: false, error: 'set a password first' };
  }
  loadCredentialsIntoServer();
  try {
    const status = await activityServer.start({
      port: cfg.port || 7878,
      lan: !!cfg.lan,
    });
    activityLogger.log('system', 'host:started', { port: status.port, lan: status.lan });
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('host:stop', async () => {
  try {
    const status = await activityServer.stop();
    activityLogger.log('system', 'host:stopped', null);
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('host:tail', (_e, limit) => activityLogger.getTail(limit));

ipcMain.handle('host:openLogFolder', () => shell.openPath(ACTIVITY_DIR));

ipcMain.handle('host:clearLogs', async () => activityLogger.clear());

ipcMain.handle('host:listDays', () => activityLogger.listDays());

// Report which network IPs the user could give to a remote client.
// Filters out loopback / link-local. We don't try to detect Tailscale
// specifically — Tailscale shows up as an interface like any other.
ipcMain.handle('host:localIps', () => {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      // skip APIPA/link-local
      if (/^169\.254\./.test(a.address)) continue;
      // tag obvious tailnet / common LAN ranges so the UI can highlight
      let kind = 'lan';
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) kind = 'tailscale';
      else if (/^10\./.test(a.address) || /^192\.168\./.test(a.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) kind = 'lan';
      else kind = 'public-ish';
      out.push({ iface: name, address: a.address, kind });
    }
  }
  return out;
});

// ---------- Saved servers (client-side directory) ----------
// Stored encrypted in userData via Electron's safeStorage so the password
// field never touches the renderer's localStorage (where it'd be picked up
// by the activity logger). Renderer gets the list with passwords masked;
// it must explicitly ask for one entry's password when it wants to connect.

const SERVERS_FILE = path.join(app.getPath('userData'), 'saved-servers.bin');

function readSavedServers() {
  try {
    if (!fs.existsSync(SERVERS_FILE)) return [];
    const buf = fs.readFileSync(SERVERS_FILE);
    if (!buf.length) return [];
    let plain;
    if (safeStorage.isEncryptionAvailable()) {
      try { plain = safeStorage.decryptString(buf); }
      catch {
        // First-write fallback or platform without keychain — accept plaintext too
        plain = buf.toString('utf8');
      }
    } else {
      plain = buf.toString('utf8');
    }
    const arr = JSON.parse(plain);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.error('[servers] read failed:', err.message);
    return [];
  }
}

function writeSavedServers(list) {
  const json = JSON.stringify(Array.isArray(list) ? list : [], null, 2);
  fs.mkdirSync(path.dirname(SERVERS_FILE), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(SERVERS_FILE, safeStorage.encryptString(json));
  } else {
    // Best effort — at least restrict perms a bit on POSIX. On Windows the
    // userData dir is per-user so this isn't terrible.
    fs.writeFileSync(SERVERS_FILE, json, { mode: 0o600 });
  }
}

function maskServers(list) {
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    hasPassword: !!s.password,
  }));
}

ipcMain.handle('servers:list', () => maskServers(readSavedServers()));

ipcMain.handle('servers:save', (_e, entry) => {
  const e = entry || {};
  if (typeof e.url !== 'string' || !e.url.trim()) throw new Error('url required');
  const list = readSavedServers();
  const id = e.id || crypto.randomBytes(8).toString('hex');
  const idx = list.findIndex((s) => s.id === id);
  const next = {
    id,
    name: String(e.name || '').trim() || e.url,
    url: String(e.url).trim().replace(/\/+$/, ''),
    // password is optional — empty/undefined means "don't save it"
    password: typeof e.password === 'string' ? e.password : (idx >= 0 ? list[idx].password : ''),
  };
  if (idx >= 0) list[idx] = next; else list.push(next);
  writeSavedServers(list);
  return maskServers(list);
});

ipcMain.handle('servers:delete', (_e, id) => {
  const list = readSavedServers().filter((s) => s.id !== id);
  writeSavedServers(list);
  return maskServers(list);
});

ipcMain.handle('servers:getPassword', (_e, id) => {
  const s = readSavedServers().find((x) => x.id === id);
  return s ? (s.password || '') : '';
});

// Wipe every saved server entry from disk. Used by the "forget all" button
// in Settings → Host. Doesn't touch live connections — main process keeps
// running until the user hits disconnect.
ipcMain.handle('servers:clearAll', () => {
  try { fs.unlinkSync(SERVERS_FILE); } catch {}
  return [];
});

// ---------- Sync manager (multi-device localStorage + notes) ----------
const { SyncManager } = require('./sync-manager');
const SYNC_DIR = path.join(app.getPath('userData'), 'sync');

const syncManager = new SyncManager({
  stateDir: SYNC_DIR,
  log: (source, channel, payload) => activityLogger.log(source, channel, payload),

  // Apply a remote-incoming localStorage write to our renderer.
  // Must run in the main world (page) because that's where the localStorage
  // wrapper and the bypass set live. webContents.send goes to the preload's
  // isolated world, which can't reach the page's localStorage. So we inject
  // a small expression via executeJavaScript instead.
  onApplyToRenderer: (payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { key, value, removed } = payload || {};
    if (!key) return;
    const expr = `window.__dashboardApplyRemoteWrite && window.__dashboardApplyRemoteWrite(${JSON.stringify(key)}, ${JSON.stringify(value)}, ${JSON.stringify(!!removed)});`;
    try { mainWindow.webContents.executeJavaScript(expr, true).catch(() => {}); } catch {}
  },

  // Apply a remote note operation locally — write through the existing IPC
  // primitives directly so any other listeners (file watchers etc.) react.
  onApplyNoteWrite: async (relPath, body) => {
    await writeNote(relPath, body);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('notes:remoteChange', { kind: 'write', path: relPath }); } catch {}
    }
  },
  onApplyNoteRename: async (from, to) => {
    try { await renameNoteFile(from, to); } catch (err) { /* might not exist locally */ }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('notes:remoteChange', { kind: 'rename', from, to }); } catch {}
    }
  },
  onApplyNoteDelete: async (relPath) => {
    try { await deleteNoteFile(relPath); } catch (err) { /* already gone */ }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('notes:remoteChange', { kind: 'delete', path: relPath }); } catch {}
    }
  },
});

// Hub broadcast: when the activity server is running, sync events get fanned
// out to all connected SSE clients via the existing /stream channel.
syncManager.setHubBroadcast((event) => {
  if (activityServer.isRunning()) activityServer.broadcastSync(event);
});

// ---- Remote-control signaling (used by remote-host / remote-viewer) ----
// Carries WebRTC offer/answer/ICE + custom requests between any two devices
// connected to the same hub. The transport piggy-backs on the existing SSE
// fan-out — every device receives every event, then the renderer filters by
// the `to` field. We don't apply these to local state; we just route them.
function handleRemoteControlEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('remote-control:event', event); } catch {}
  }
}

// Hub-side handlers for the activity server: receiving an incoming push,
// answering a snapshot request, vault routing.
// Note: `vault` is attached to activityServer.sync separately, after
// vaultManager is constructed (further down in this file).
activityServer.setSync({
  handler: async (event) => {
    // Remote-control signaling: forward to our renderer + fan out to other clients.
    if (event && event.kind === 'remote-control') {
      handleRemoteControlEvent(event);
      if (activityServer.isRunning()) {
        try { activityServer.broadcastSync(event); } catch {}
      }
      return;
    }
    return syncManager.applyIncoming(event);
  },
  snapshot: async () => syncManager.buildSnapshot(),
  readNoteBody: async (relPath) => {
    try { return await vaultManager.read('notes', relPath); }
    catch { return null; }
  },
});

// ---- Renderer → main: localStorage write ----
ipcMain.handle('sync:local-write', (_e, payload) => {
  const { event: kind, key, value } = payload || {};
  if (!key) return false;
  return syncManager.recordLocalWrite({
    key,
    value,
    removed: kind === 'removeItem',
  });
});

// ---- Renderer → main: seed our snapshot from localStorage at boot ----
ipcMain.handle('sync:seed', (_e, stateMap) => {
  syncManager.seedLocalState(stateMap || {});
  return true;
});

// ---- Sync client mode: connect/disconnect/status ----
// Owned by main so the connection survives plugin remounts and minimizes.
const syncClient = {
  active: null, // { server, password, token, baseUrl, sse, status, error, since }
  controller: null,
};

function emitSyncStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const s = syncClient.active;
  try {
    mainWindow.webContents.send('sync:status-changed', s ? {
      connected: s.status === 'connected',
      status: s.status,
      error: s.error || null,
      server: { id: s.server.id, name: s.server.name, url: s.server.url },
    } : { connected: false, status: 'idle', error: null, server: null });
  } catch {}
}

async function syncClientPushEvent(event) {
  const s = syncClient.active;
  if (!s || !s.token || !s.baseUrl) throw new Error('not connected');
  const res = await fetch(s.baseUrl + '/sync/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + s.token,
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`push ${res.status}: ${text || res.statusText}`);
  }
}

async function syncClientFetchNote(relPath) {
  const s = syncClient.active;
  if (!s) return null;
  const res = await fetch(s.baseUrl + '/sync/note?path=' + encodeURIComponent(relPath), {
    headers: { 'Authorization': 'Bearer ' + s.token },
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j && typeof j.body === 'string' ? j.body : null;
}

function syncClientCloseSse() {
  const s = syncClient.active;
  if (!s) return;
  if (s.sseReq) {
    try { s.sseReq.destroy(); } catch {}
    s.sseReq = null;
  }
  if (s.sseRes) {
    try { s.sseRes.destroy(); } catch {}
    s.sseRes = null;
  }
}

// Use raw http/https module for the SSE stream — Node's built-in fetch can
// buffer streaming response bodies and fails to deliver SSE chunks until
// arbitrary thresholds are hit. http.request hands us each TCP chunk as soon
// as it arrives, which is what SSE needs.
function syncClientOpenSse() {
  const s = syncClient.active;
  if (!s) return;
  syncClientCloseSse();

  let urlObj;
  try { urlObj = new URL(s.baseUrl + '/stream'); }
  catch (err) {
    s.status = 'error';
    s.error = 'bad url: ' + err.message;
    syncManager.setClientConnected(false);
    emitSyncStatus();
    return;
  }

  console.log('[sync] opening SSE →', urlObj.hostname + ':' + (urlObj.port || 80));

  const httpMod = urlObj.protocol === 'https:' ? require('https') : require('http');
  const req = httpMod.request({
    method: 'GET',
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    headers: {
      'Authorization': 'Bearer ' + s.token,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-store',
    },
  });

  s.sseReq = req;

  req.on('error', (err) => {
    console.log('[sync] req error:', err.message);
    if (syncClient.active !== s) return;
    s.status = 'reconnecting';
    s.error = err.message;
    syncManager.setClientConnected(false);
    emitSyncStatus();
    setTimeout(() => { if (syncClient.active === s) syncClientOpenSse(); }, 3000);
  });

  req.on('socket', (sock) => {
    console.log('[sync] socket assigned');
    try { sock.setNoDelay(true); } catch {}
    try { sock.setKeepAlive(true, 30000); } catch {}
  });

  req.on('response', (res) => {
    console.log('[sync] response received, status', res.statusCode);
    if (syncClient.active !== s) { try { res.destroy(); } catch {} return; }
    if (res.statusCode !== 200) {
      s.status = 'error';
      s.error = `stream ${res.statusCode}`;
      syncManager.setClientConnected(false);
      emitSyncStatus();
      try { res.destroy(); } catch {}
      return;
    }
    s.sseRes = res;
    s.status = 'connected';
    s.error = null;
    syncManager.setClientConnected(true);
    emitSyncStatus();

    // One-time test ping so we can verify main→renderer IPC at all.
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[sync] sending test event to renderer (channel: sync:remote-event)');
      try {
        mainWindow.webContents.send('sync:remote-event', {
          ts: Date.now(), source: 'test', channel: 'sync:test-ping', payload: 'hello',
        });
      } catch (err) {
        console.log('[sync] test send failed:', err.message);
      }
    } else {
      console.log('[sync] mainWindow not available — cannot send test event!');
    }

    res.setEncoding('utf8');
    let buf = '';
    let chunkCount = 0;
    let eventCount = 0;
    let forwardedCount = 0;
    res.on('data', (chunk) => {
      chunkCount++;
      console.log('[sync] chunk', chunkCount, '(' + chunk.length + ' bytes)');
      buf += chunk;
      while (true) {
        const idx = buf.indexOf('\n\n');
        if (idx === -1) break;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          let ev;
          try { ev = JSON.parse(json); } catch { continue; }
          eventCount++;
          if (ev && ev.__dashboard_sync) {
            console.log('[sync] event #' + eventCount + ' SYNC:', ev.kind, ev.key || ev.name || ev.path || '');
            // vault-changed events are routing-only — forward to renderer so
            // any plugin showing vault content can refresh.
            if (ev.kind === 'vault-changed' && mainWindow && !mainWindow.isDestroyed()) {
              try { mainWindow.webContents.send('vault:changed', { name: ev.name, op: ev.op, payload: ev.payload, device: ev.device }); } catch {}
            } else if (ev.kind === 'remote-control') {
              // Remote-control signaling: forward to renderer; do not touch state.
              handleRemoteControlEvent(ev);
            } else {
              syncManager.applyIncoming(ev).catch(() => {});
            }
          } else {
            const hasWin = !!(mainWindow && !mainWindow.isDestroyed());
            console.log('[sync] event #' + eventCount + ' ACTIVITY:', ev.channel || ev.event, '| forward to renderer:', hasWin);
            if (hasWin) {
              try {
                mainWindow.webContents.send('sync:remote-event', ev);
                forwardedCount++;
              } catch (err) {
                console.log('[sync] send failed:', err.message);
              }
            }
          }
        }
      }
      if (chunkCount % 10 === 0) console.log('[sync] tally: ' + chunkCount + ' chunks, ' + eventCount + ' events, ' + forwardedCount + ' forwarded');
    });
    res.on('end', () => {
      console.log('[sync] stream ended');
      if (syncClient.active !== s) return;
      s.status = 'reconnecting';
      s.error = 'stream ended';
      syncManager.setClientConnected(false);
      emitSyncStatus();
      setTimeout(() => { if (syncClient.active === s) syncClientOpenSse(); }, 3000);
    });
    res.on('error', (err) => {
      console.log('[sync] res error:', err.message);
      if (syncClient.active !== s) return;
      s.status = 'reconnecting';
      s.error = err.message;
      syncManager.setClientConnected(false);
      emitSyncStatus();
      setTimeout(() => { if (syncClient.active === s) syncClientOpenSse(); }, 3000);
    });
  });

  req.end();
  console.log('[sync] req sent');
}

ipcMain.handle('sync:connect', async (_e, server, password) => {
  if (!server || !server.url) return { ok: false, error: 'no server' };
  // If already connected somewhere, drop it
  if (syncClient.active) await disconnectSync();

  const baseUrl = String(server.url).trim().replace(/\/+$/, '');
  // Login first
  let loginRes;
  try {
    loginRes = await fetch(baseUrl + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password || '' }),
    });
  } catch (err) {
    return { ok: false, error: 'cannot reach: ' + err.message };
  }
  if (!loginRes.ok) {
    const j = await loginRes.json().catch(() => ({}));
    return { ok: false, error: j.error || `login ${loginRes.status}` };
  }
  const sess = await loginRes.json();

  syncClient.active = {
    server, baseUrl, token: sess.token, expiresAt: sess.expiresAt,
    status: 'syncing-snapshot', error: null, sse: null,
  };
  emitSyncStatus();
  syncManager.setClientPush(syncClientPushEvent);

  // Pull snapshot and merge
  try {
    const snapRes = await fetch(baseUrl + '/sync/snapshot', {
      headers: { 'Authorization': 'Bearer ' + sess.token },
    });
    if (snapRes.ok) {
      const snap = await snapRes.json();
      // Connect first so applyAndDiffSnapshot's clientPush actually flushes.
      syncManager.setClientConnected(true);
      // applyAndDiffSnapshot may want note bodies — we wire that up inline:
      const want = [];
      const onWant = (p) => want.push(p);
      syncManager.on('snapshot:want-note', onWant);
      try {
        await syncManager.applyAndDiffSnapshot(snap, listNotes, async (rel) => {
          const safe = sanitizeNotePath(rel);
          const full = path.join(NOTES_DIR, safe);
          return await fsp.readFile(full, 'utf8');
        });
      } finally {
        syncManager.off('snapshot:want-note', onWant);
      }
      // Fetch the note bodies the snapshot diff said we need
      for (const p of want) {
        const body = await syncClientFetchNote(p).catch(() => null);
        if (body != null) {
          await syncManager.applyIncoming({
            kind: 'note-write', device: snap.device, ts: snap.noteTimestamps[p] || Date.now(),
            path: p, body,
          });
        }
      }
    }
  } catch (err) {
    activityLogger.log('sync', 'snapshot-failed', { error: err.message });
  }

  // Open the SSE stream for ongoing updates
  await syncClientOpenSse();

  return { ok: true, status: syncClient.active && syncClient.active.status };
});

async function disconnectSync() {
  syncClientCloseSse();
  const s = syncClient.active;
  if (s && s.token) {
    try {
      await fetch(s.baseUrl + '/logout', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + s.token },
      });
    } catch {}
  }
  syncClient.active = null;
  syncManager.setClientConnected(false);
  syncManager.setClientPush(null);
  emitSyncStatus();
}

ipcMain.handle('sync:disconnect', async () => { await disconnectSync(); return { ok: true }; });

ipcMain.handle('sync:status', () => {
  const s = syncClient.active;
  return s ? {
    connected: s.status === 'connected',
    status: s.status,
    error: s.error || null,
    server: { id: s.server.id, name: s.server.name, url: s.server.url },
  } : { connected: false, status: 'idle', error: null, server: null };
});

// Stable per-installation device id. Used by renderer code (and plugins) to
// distinguish their own writes from cross-device events when filtering
// vault:changed / sync events to avoid echo-driven loops.
ipcMain.handle('sync:deviceId', () => syncManager.deviceId);

// ---------- Remote desktop (remote-host / remote-viewer plugins) ----------
// Three pieces:
//   1. signaling: dispatch a remote-control event to all other devices on the
//      shared hub (broadcast if we're the hub; push if we're a client; both).
//   2. screen capture: handled in renderer via getDisplayMedia. We auto-grant
//      requests below so the user isn't prompted on every accept.
//   3. input injection: a long-lived PowerShell child process driving Win32
//      user32.dll via P/Invoke. We pipe one JSON command per stdin line.
//      mac/Linux currently throw a clear error from the renderer.

function dispatchRemoteControl(event) {
  if (!event || typeof event !== 'object') return;
  const stamped = {
    __dashboard_sync: true,
    kind: 'remote-control',
    ts: Date.now(),
    ...event,
    from: syncManager.deviceId,
  };
  // If we're the hub, fan out to clients via SSE.
  if (activityServer.isRunning()) {
    try { activityServer.broadcastSync(stamped); } catch {}
  }
  // If we're connected as a client to a remote hub, push there too.
  // (Hub will then re-broadcast to its other clients via the setSync handler.)
  if (syncClient.active && syncClient.active.status === 'connected') {
    syncClientPushEvent(stamped).catch(() => {});
  }
  return stamped;
}

ipcMain.handle('remote-control:send', (_e, event) => dispatchRemoteControl(event));
ipcMain.handle('remote-control:deviceId', () => syncManager.deviceId);
ipcMain.handle('remote-control:deviceName', () => os.hostname());

// Auto-grant getDisplayMedia for the primary screen so the host plugin can
// start streaming without a system picker every time. This is the same
// implicit-trust posture used for microphone access elsewhere in this app.
let displayMediaHandlerInstalled = false;
function ensureDisplayMediaHandler() {
  if (displayMediaHandlerInstalled) return;
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (sources && sources.length) callback({ video: sources[0] });
        else callback({});
      } catch { callback({}); }
    });
    displayMediaHandlerInstalled = true;
  } catch (err) {
    console.error('[remote] setDisplayMediaRequestHandler failed:', err.message);
  }
}

ipcMain.handle('remote-control:listScreens', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 160, height: 100 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null,
    }));
  } catch (err) {
    return { error: err.message };
  }
});

// ---- PowerShell-based input injector (Windows only) ----
// Embedded as a string so it bundles cleanly through asar — written to
// userData on first use and spawned with -File. Script reads JSON commands
// from stdin (one per line) and dispatches them to user32 via Add-Type.
const REMOTE_INJECTOR_PS1 = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
}
"@
$w = [U32]::GetSystemMetrics(0)
$h = [U32]::GetSystemMetrics(1)
[Console]::Out.WriteLine("ready " + $w + "x" + $h)
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.t) {
      'm' {
        $px = [int]([double]$c.x * $w)
        $py = [int]([double]$c.y * $h)
        if ($px -lt 0) { $px = 0 } elseif ($px -ge $w) { $px = $w - 1 }
        if ($py -lt 0) { $py = 0 } elseif ($py -ge $h) { $py = $h - 1 }
        [void][U32]::SetCursorPos($px, $py)
      }
      'd' {
        switch ([int]$c.b) {
          0 { [U32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero) }
          1 { [U32]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero) }
          2 { [U32]::mouse_event(0x0020, 0, 0, 0, [IntPtr]::Zero) }
        }
      }
      'u' {
        switch ([int]$c.b) {
          0 { [U32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero) }
          1 { [U32]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero) }
          2 { [U32]::mouse_event(0x0040, 0, 0, 0, [IntPtr]::Zero) }
        }
      }
      'w' {
        [U32]::mouse_event(0x0800, 0, 0, [int]$c.dy, [IntPtr]::Zero)
      }
      'k' {
        $flags = 0
        if ($c.up) { $flags = 2 }
        [U32]::keybd_event([byte][int]$c.vk, 0, [uint32]$flags, [IntPtr]::Zero)
      }
    }
  } catch {}
}
`;

const remoteInjector = {
  proc: null,
  ready: false,
  screen: null, // "WxH" reported by the script
};

function ensureInjectorScript() {
  const dir = path.join(app.getPath('userData'), 'remote-control');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'injector.ps1');
  // Always rewrite so updates to the embedded source land on next launch.
  fs.writeFileSync(file, REMOTE_INJECTOR_PS1, 'utf8');
  return file;
}

function startRemoteInjector() {
  if (process.platform !== 'win32') {
    throw new Error('input injection currently supported on Windows only');
  }
  if (remoteInjector.proc) return { ok: true, screen: remoteInjector.screen };
  const scriptPath = ensureInjectorScript();
  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ], { windowsHide: true });
  remoteInjector.proc = proc;
  remoteInjector.ready = false;
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.startsWith('ready ')) {
        remoteInjector.ready = true;
        remoteInjector.screen = line.slice(6);
        console.log('[remote] injector ready', remoteInjector.screen);
      }
    }
  });
  proc.stderr.on('data', (c) => console.error('[remote] injector stderr:', c.toString()));
  proc.on('exit', (code) => {
    console.log('[remote] injector exited', code);
    remoteInjector.proc = null;
    remoteInjector.ready = false;
  });
  return { ok: true };
}

function stopRemoteInjector() {
  if (!remoteInjector.proc) return { ok: true };
  try { remoteInjector.proc.kill(); } catch {}
  remoteInjector.proc = null;
  remoteInjector.ready = false;
  return { ok: true };
}

function injectRemoteCommand(cmd) {
  if (!remoteInjector.proc || !remoteInjector.proc.stdin.writable) {
    throw new Error('injector not running');
  }
  try {
    remoteInjector.proc.stdin.write(JSON.stringify(cmd) + '\n');
  } catch (err) {
    throw new Error('inject write failed: ' + err.message);
  }
}

ipcMain.handle('remote-control:startInjector', () => {
  try { return startRemoteInjector(); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('remote-control:stopInjector', () => stopRemoteInjector());
ipcMain.handle('remote-control:injectorStatus', () => ({
  running: !!remoteInjector.proc,
  ready: remoteInjector.ready,
  screen: remoteInjector.screen,
  platform: process.platform,
}));
ipcMain.handle('remote-control:injectInput', (_e, cmd) => {
  try { injectRemoteCommand(cmd); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Make sure the display-media handler is installed before any plugin tries
// getDisplayMedia(). Wired here (rather than at app.whenReady) so it survives
// a window recreation triggered by skin-mode toggle — handler lives on the
// session, not the window.
ensureDisplayMediaHandler();

// ---------- Central vaults (shared content folders) ----------
// Each vault is a named directory on the host. Plugins use vault:* IPC
// (or the legacy notes:* IPC, which routes to the 'notes' vault) to read
// and write files. When the laptop is sync-connected to a desktop, all
// vault calls route through HTTP to the desktop instead of touching local
// files. Disconnected → operations fail (no offline cache, by design).

const VAULTS_BASE_DIR = path.join(app.getPath('userData'), 'vaults');
const vaultManager = new VaultManager();

// 'notes' vault uses the legacy notes folder (which is user-configurable);
// 'cognicore' has a fixed default directory under userData. We register
// 'notes' right here using window-state so it's ready immediately, even
// though the variable `NOTES_DIR` isn't declared until later in the file.
{
  const cfg = readWindowState();
  const notesDir = cfg.notesDir || path.join(app.getPath('userData'), 'notes');
  vaultManager.register('notes', notesDir);
  vaultManager.register('cognicore', path.join(VAULTS_BASE_DIR, 'cognicore'));
}

// Late-bind the vault hook on the activity server. activityServer.setSync
// was called earlier (before vaultManager existed), so we mutate the
// `sync` object we set then.
if (activityServer.sync) activityServer.sync.vault = vaultManager;

function isClientConnected() {
  return !!(syncClient.active && syncClient.active.status === 'connected');
}

async function remoteVault(method, vaultName, op, body, query) {
  const s = syncClient.active;
  if (!s || !s.token) throw new Error('not connected');
  let url = s.baseUrl + '/sync/vault/' + encodeURIComponent(vaultName) + '/' + op;
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v != null)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    if (qs) url += '?' + qs;
  }
  const init = {
    method,
    headers: {
      'Authorization': 'Bearer ' + s.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    let err = `vault ${method} ${op} → ${res.status}`;
    try { const j = await res.json(); if (j && j.error) err = j.error; } catch {}
    throw new Error(err);
  }
  return await res.json().catch(() => null);
}

// Broadcast a vault change to all connected clients via the existing SSE
// channel, AND notify our own renderer so it can refresh. The `device` field
// is the *originating* device — set to the requester's id for HTTP-routed
// writes, or to our own deviceId for local writes. Receivers use it to ignore
// echoes of their own writes (otherwise the SSE round trip remounts the
// originating plugin and clobbers in-progress edits).
function announceVaultChange(name, op, payload, originator) {
  const device = originator || (syncManager ? syncManager.deviceId : 'main');
  const event = {
    kind: 'vault-changed',
    device,
    ts: Date.now(),
    name, op, payload,
  };
  if (activityServer.isRunning()) {
    try { activityServer.broadcastSync(event); } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('vault:changed', { name, op, payload, device }); } catch {}
  }
}

// Subscribe to vault changes so writes through the IPC path get broadcast.
vaultManager.onChange(({ name, op, payload, originator }) => announceVaultChange(name, op, payload, originator));

// ---- vault:* IPC ----
// On the host (or any disconnected instance), these go straight to the local
// VaultManager. On a connected client, they're routed to the host via HTTP.

ipcMain.handle('vault:list', async (_e, name) => {
  if (isClientConnected()) return await remoteVault('GET', name, 'list');
  return await vaultManager.listEntries(name);
});

ipcMain.handle('vault:listNotes', async (_e, name) => {
  if (isClientConnected()) return await remoteVault('GET', name, 'notes');
  return await vaultManager.listNotes(name);
});

ipcMain.handle('vault:info', async (_e, name) => {
  if (isClientConnected()) return await remoteVault('GET', name, 'info');
  return await vaultManager.info(name);
});

ipcMain.handle('vault:read', async (_e, name, p) => {
  if (isClientConnected()) {
    const r = await remoteVault('GET', name, 'read', null, { path: p });
    return r && typeof r.body === 'string' ? r.body : null;
  }
  return await vaultManager.read(name, p);
});

ipcMain.handle('vault:write', async (_e, name, p, content) => {
  const dev = syncManager.deviceId;
  if (isClientConnected()) {
    await remoteVault('POST', name, 'write', { path: p, content, device: dev });
    return true;
  }
  return await vaultManager.write(name, p, content, dev);
});

ipcMain.handle('vault:mkdir', async (_e, name, p) => {
  const dev = syncManager.deviceId;
  if (isClientConnected()) {
    await remoteVault('POST', name, 'mkdir', { path: p, device: dev });
    return true;
  }
  return await vaultManager.mkdir(name, p, dev);
});

ipcMain.handle('vault:rename', async (_e, name, from, to) => {
  const dev = syncManager.deviceId;
  if (isClientConnected()) {
    await remoteVault('POST', name, 'rename', { from, to, device: dev });
    return true;
  }
  return await vaultManager.rename(name, from, to, dev);
});

ipcMain.handle('vault:delete', async (_e, name, p) => {
  const dev = syncManager.deviceId;
  if (isClientConnected()) {
    await remoteVault('POST', name, 'delete', { path: p, device: dev });
    return true;
  }
  return await vaultManager.delete(name, p, dev);
});

// Push live events to the renderer for the Host tab's live tail.
activityLogger.subscribe((ev) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('activity:event', ev); } catch {}
  }
});

ipcMain.handle('plugins:list', () => listPlugins());
ipcMain.handle('plugins:read', (_e, p) => readPluginSource(p));
ipcMain.handle('plugins:openFolder', () => shell.openPath(PLUGINS_DIR));
ipcMain.handle('plugins:dirPath', () => PLUGINS_DIR);

// ---------- Notes (markdown files on disk) ----------
const DEFAULT_NOTES_DIR = path.join(app.getPath('userData'), 'notes');
let NOTES_DIR = readWindowState().notesDir || DEFAULT_NOTES_DIR;

async function ensureNotesDir() {
  await fsp.mkdir(NOTES_DIR, { recursive: true });
}

function sanitizeNotePath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) throw new Error('empty note path');
  for (const seg of normalized.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error('invalid note path');
  }
  if (!normalized.toLowerCase().endsWith('.md')) throw new Error('note path must end in .md');
  return normalized;
}

async function cleanupEmptyDirsUpTo(startDir) {
  const root = path.resolve(NOTES_DIR);
  let cur = path.resolve(startDir);
  while (cur !== root && cur.startsWith(root + path.sep)) {
    try {
      const entries = await fsp.readdir(cur);
      if (entries.length > 0) break;
      await fsp.rmdir(cur);
      cur = path.dirname(cur);
    } catch { break; }
  }
}

async function listNotes() {
  await ensureNotesDir();
  const out = [];
  async function walk(absDir, relPrefix) {
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const fullPath = path.join(absDir, ent.name);
      const relPath = (relPrefix ? relPrefix + '/' : '') + ent.name;
      if (ent.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        try {
          const body = await fsp.readFile(fullPath, 'utf8');
          const stat = await fsp.stat(fullPath);
          out.push({ path: relPath, body, mtime: stat.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(NOTES_DIR, '');
  return out;
}

async function writeNote(relPath, body) {
  await ensureNotesDir();
  const safe = sanitizeNotePath(relPath);
  const full = path.join(NOTES_DIR, safe);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, body, 'utf8');
  return true;
}

async function renameNoteFile(fromRel, toRel) {
  await ensureNotesDir();
  const fromSafe = sanitizeNotePath(fromRel);
  const toSafe = sanitizeNotePath(toRel);
  if (fromSafe === toSafe) return true;
  const fromFull = path.join(NOTES_DIR, fromSafe);
  const toFull = path.join(NOTES_DIR, toSafe);
  // Don't silently overwrite an existing note
  try {
    await fsp.access(toFull);
    throw new Error('a note already exists at the target path');
  } catch (err) {
    if (err.code !== 'ENOENT' && !err.message.includes('a note already')) {
      // re-throw real errors
    } else if (err.message && err.message.includes('a note already')) {
      throw err;
    }
  }
  await fsp.mkdir(path.dirname(toFull), { recursive: true });
  await fsp.rename(fromFull, toFull);
  await cleanupEmptyDirsUpTo(path.dirname(fromFull));
  return true;
}

async function deleteNoteFile(relPath) {
  await ensureNotesDir();
  const safe = sanitizeNotePath(relPath);
  const full = path.join(NOTES_DIR, safe);
  await fsp.unlink(full);
  await cleanupEmptyDirsUpTo(path.dirname(full));
  return true;
}

// notes:* now routes through the central 'notes' vault. When connected to a
// remote host, the laptop's calls go over HTTP to the desktop's vault; when
// running standalone (or as the host itself), they hit local files. The
// previous file-replication path (recordNoteOp on every write) is gone.
ipcMain.handle('notes:getDir', async () => {
  if (isClientConnected()) {
    const info = await remoteVault('GET', 'notes', 'info');
    return (info && info.dir) || '(remote)';
  }
  await ensureNotesDir();
  return NOTES_DIR;
});

ipcMain.handle('notes:list', async () => {
  if (isClientConnected()) return await remoteVault('GET', 'notes', 'notes');
  return await vaultManager.listNotes('notes');
});

ipcMain.handle('notes:write', async (_e, p, body) => {
  const dev = syncManager.deviceId;
  if (isClientConnected()) {
    await remoteVault('POST', 'notes', 'write', { path: p, content: body, device: dev });
    return true;
  }
  return await vaultManager.write('notes', p, body, dev);
});

ipcMain.handle('notes:rename', async (_e, from, to) => {
  const dev = syncManager.deviceId;
  if (isClientConnected()) {
    await remoteVault('POST', 'notes', 'rename', { from, to, device: dev });
    return true;
  }
  return await vaultManager.rename('notes', from, to, dev);
});

ipcMain.handle('notes:delete', async (_e, p) => {
  const dev = syncManager.deviceId;
  if (isClientConnected()) {
    await remoteVault('POST', 'notes', 'delete', { path: p, device: dev });
    return true;
  }
  return await vaultManager.delete('notes', p, dev);
});

ipcMain.handle('notes:openFolder', async () => {
  // Only meaningful on the host. On a connected client, the folder is on
  // the desktop and we can't open it here.
  if (isClientConnected()) return null;
  await ensureNotesDir();
  return shell.openPath(NOTES_DIR);
});

// Switch the notes folder. Only meaningful when running standalone or as
// the host — when sync-connected as a client, the dir lives on the desktop.
ipcMain.handle('notes:setDir', async (_e, newDir) => {
  if (isClientConnected()) {
    throw new Error('disconnect from sync first to change the notes folder');
  }
  const target = newDir ? path.resolve(newDir) : DEFAULT_NOTES_DIR;
  try {
    await fsp.mkdir(target, { recursive: true });
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) throw new Error('not a directory');
    const probe = path.join(target, '.dashboard-write-test');
    await fsp.writeFile(probe, '');
    await fsp.unlink(probe);
  } catch (e) {
    throw new Error('cannot use folder: ' + (e.message || e));
  }
  NOTES_DIR = target;
  vaultManager.setDir('notes', target);
  writeWindowState({ notesDir: target === DEFAULT_NOTES_DIR ? null : target });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notes:dirChanged', NOTES_DIR);
  }
  return NOTES_DIR;
});

ipcMain.handle('notes:getDefaultDir', () => DEFAULT_NOTES_DIR);

// Folder picker (companion to the existing dialog:openFile)
ipcMain.handle('dialog:openDirectory', async (_e, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    ...(options || {}),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ---------- Settings / window IPC ----------
function loginItemArgs() {
  // In dev, we launch via `electron .`, so we need to pass the project path
  // back to the electron binary. In a packaged build, the exe knows its own app dir.
  return app.isPackaged ? [] : [path.resolve(__dirname)];
}

// On Linux, Electron's app.setLoginItemSettings is a no-op (the underlying
// platform call only ships for Windows + macOS). Manage a freedesktop.org
// autostart entry by hand instead — every desktop environment that follows
// the spec (GNOME, KDE, XFCE, Cinnamon...) honors files in this directory.
const LINUX_AUTOSTART_FILE = path.join(
  os.homedir(),
  '.config',
  'autostart',
  'dashboard-app.desktop',
);

function getLinuxAutoStart() {
  try { return fs.existsSync(LINUX_AUTOSTART_FILE); }
  catch { return false; }
}

function setLinuxAutoStart(enabled) {
  if (!enabled) {
    try { fs.unlinkSync(LINUX_AUTOSTART_FILE); } catch {}
    return getLinuxAutoStart();
  }
  try {
    fs.mkdirSync(path.dirname(LINUX_AUTOSTART_FILE), { recursive: true });
    // AppImage extracts to /tmp on every run; the stable launcher path is in
    // $APPIMAGE. Falls through to process.execPath for deb/rpm installs.
    const execPath = process.env.APPIMAGE || process.execPath;
    const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    const execLine = app.isPackaged
      ? quote(execPath)
      : `${quote(execPath)} ${quote(path.resolve(__dirname))}`;
    const body = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Dashboard',
      `Exec=${execLine}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      'Hidden=false',
      '',
    ].join('\n');
    fs.writeFileSync(LINUX_AUTOSTART_FILE, body, 'utf8');
  } catch (e) {
    console.error('Failed to write autostart file:', e);
  }
  return getLinuxAutoStart();
}

ipcMain.handle('settings:getAutoStart', () => {
  if (process.platform === 'linux') return getLinuxAutoStart();
  return app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }).openAtLogin;
});

ipcMain.handle('settings:setAutoStart', (_e, enabled) => {
  if (process.platform === 'linux') return setLinuxAutoStart(!!enabled);
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath,
    args: loginItemArgs(),
  });
  return app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }).openAtLogin;
});

ipcMain.handle('window:setFullScreen', (_e, value) => {
  if (mainWindow) mainWindow.setFullScreen(!!value);
  writeWindowState({ fullScreen: !!value });
  return mainWindow ? mainWindow.isFullScreen() : false;
});
ipcMain.handle('window:isFullScreen', () => mainWindow ? mainWindow.isFullScreen() : false);

ipcMain.handle('window:setAlwaysOnTop', (_e, value) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!value);
  writeWindowState({ alwaysOnTop: !!value });
  return mainWindow ? mainWindow.isAlwaysOnTop() : false;
});
ipcMain.handle('window:isAlwaysOnTop', () => mainWindow ? mainWindow.isAlwaysOnTop() : false);

ipcMain.handle('window:openDevTools', () => {
  if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' });
});

ipcMain.handle('window:reload', () => {
  if (mainWindow) mainWindow.webContents.reload();
});

ipcMain.handle('app:quit', () => app.quit());

ipcMain.handle('window:setSkinMode', (_e, v) => setSkinMode(!!v));
ipcMain.handle('window:isSkinMode', () => !!readWindowState().skinMode);

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:isPackaged', () => app.isPackaged);
ipcMain.handle('app:platform', () => ({
  id: process.platform,
  arch: process.arch,
  supportsSkinMode: !!platform.supportsSkinMode && platform.supportsSkinMode(),
  supportsShortcutFiles: !!platform.supportsShortcutFiles && platform.supportsShortcutFiles(),
}));

// Power actions (lock / sleep / shutdown / etc). The renderer asks for the
// platform-appropriate menu via power:list; the actual execution happens here
// so the renderer never has to know about platform-specific binaries.
ipcMain.handle('power:list', () => platform.listPowerActions());
ipcMain.handle('power:execute', (_e, id) => platform.executePowerAction(String(id || '')));

// ---------- Hardware sensors ----------
// CPU temperature on Windows is slow (spawns wmic) and often returns 0
// without a kernel-mode helper. We cache it and also try LibreHardwareMonitor
// (LHM) if it is running with its embedded HTTP server enabled (port 8085).

const sensorCache = { siTemp: null, siTempAt: 0, cpuStatic: null };

async function getSiTempCached() {
  const now = Date.now();
  if (sensorCache.siTemp && now - sensorCache.siTempAt < 6000) {
    return sensorCache.siTemp;
  }
  try {
    const t = await si.cpuTemperature();
    sensorCache.siTemp = t;
    sensorCache.siTempAt = now;
    return t;
  } catch {
    return null;
  }
}

function flattenLhm(node, path, out) {
  if (!node) return out;
  const isLeaf = !node.Children || node.Children.length === 0;
  if (isLeaf && node.Text && node.Value) {
    const category = path[path.length - 1] || '';
    const device = path[path.length - 2] || '';
    const sensor = {
      name: node.Text,
      value: node.Value,
      min: node.Min,
      max: node.Max,
      device,
    };
    if (category === 'Temperatures') out.temps.push(sensor);
    else if (category === 'Fans') out.fans.push(sensor);
    else if (category === 'Load') out.loads.push(sensor);
    else if (category === 'Clocks') out.clocks.push(sensor);
  }
  if (node.Children) {
    for (const c of node.Children) flattenLhm(c, [...path, node.Text || ''], out);
  }
  return out;
}

async function getLhm() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    const res = await fetch('http://localhost:8085/data.json', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return flattenLhm(json, [], { temps: [], fans: [], loads: [], clocks: [] });
  } catch {
    return null;
  }
}

// ---------- Filesystem host APIs ----------
ipcMain.handle('fs:home', () => os.homedir());
ipcMain.handle('fs:list', async (_e, dir) => {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let size = null, mtime = null;
    try {
      const st = await fsp.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* permission denied etc — skip stat */ }
    out.push({
      name: ent.name,
      path: full,
      isDir: ent.isDirectory(),
      isFile: ent.isFile(),
      isLink: ent.isSymbolicLink(),
      size, mtime,
    });
  }
  return out;
});
ipcMain.handle('fs:stat', async (_e, p) => {
  const s = await fsp.stat(p);
  return {
    size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs,
    isDir: s.isDirectory(), isFile: s.isFile(),
  };
});
ipcMain.handle('fs:read', async (_e, p, encoding) => fsp.readFile(p, encoding || 'utf8'));
ipcMain.handle('fs:write', async (_e, p, content) => {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
  return true;
});
ipcMain.handle('fs:mkdir', async (_e, p) => {
  await fsp.mkdir(p, { recursive: true });
  return true;
});
ipcMain.handle('fs:delete', async (_e, p) => {
  const st = await fsp.stat(p);
  if (st.isDirectory()) {
    await fsp.rm(p, { recursive: true, force: true });
  } else {
    await fsp.unlink(p);
  }
  return true;
});
ipcMain.handle('fs:rename', async (_e, from, to) => {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return true;
});

// ---------- Shell / process host APIs ----------
ipcMain.handle('shell:open', (_e, target) => shell.openPath(target));
ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('shell:launch', (_e, exePath, args) => {
  const argv = Array.isArray(args) ? args : [];
  // On macOS, launching a .app bundle requires `open`; spawn() of the bundle
  // path itself will fail. On Linux, .desktop files want gtk-launch (or
  // xdg-open as a fallback). On Windows just spawn directly.
  let cmd = exePath;
  let cmdArgs = argv;
  let cwd = path.dirname(exePath);

  if (process.platform === 'darwin' && /\.app\/?$/.test(exePath)) {
    cmd = 'open';
    cmdArgs = argv.length ? ['-a', exePath, '--args', ...argv] : [exePath];
    cwd = process.env.HOME || process.cwd();
  } else if (process.platform === 'linux' && exePath.endsWith('.desktop')) {
    cmd = 'gtk-launch';
    // gtk-launch expects the desktop entry id (basename without .desktop)
    cmdArgs = [path.basename(exePath, '.desktop')];
    cwd = process.env.HOME || process.cwd();
  }

  const child = spawn(cmd, cmdArgs, {
    detached: true, stdio: 'ignore', cwd,
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid };
});
ipcMain.handle('shell:getFileIcon', async (_e, p, size) => {
  try {
    const img = await app.getFileIcon(p, { size: size || 'large' });
    return img.toDataURL();
  } catch { return null; }
});
ipcMain.handle('shell:readShortcut', (_e, lnkPath) => {
  // Electron's shell.readShortcutLink is Windows-only.
  if (process.platform !== 'win32') return null;
  try { return shell.readShortcutLink(lnkPath); }
  catch { return null; }
});

// ---------- Dialog ----------
ipcMain.handle('dialog:openFile', async (_e, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    ...(options || {}),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ---------- App discovery ----------
// Scans platform-appropriate locations for installed apps:
//   Windows: Start Menu .lnk files
//   macOS:   /Applications + /System/Applications + ~/Applications (.app bundles)
//   Linux:   XDG .desktop files in $XDG_DATA_DIRS/applications and Flatpak exports
// Implementation lives in lib/platform-*.js; the cache is shared.
const APP_CACHE = { apps: null, builtAt: 0 };

ipcMain.handle('apps:discover', async (_e, opts) => {
  const refresh = opts && opts.refresh;
  if (APP_CACHE.apps && !refresh && Date.now() - APP_CACHE.builtAt < 600000) {
    return APP_CACHE.apps;
  }
  const apps = await platform.discoverApps({ shell, app });
  APP_CACHE.apps = apps;
  APP_CACHE.builtAt = Date.now();
  return apps;
});

ipcMain.handle('system:processes', async () => {
  try {
    const procs = await si.processes();
    // Trim — UI only ever needs the top N by load anyway
    const list = (procs.list || []).map((p) => ({
      pid: p.pid,
      name: p.name,
      cpu: p.cpu,
      mem: p.mem,
      memRss: p.memRss,
      command: p.command,
      user: p.user,
    }));
    return {
      all: procs.all,
      running: procs.running,
      sleeping: procs.sleeping,
      list,
    };
  } catch (err) {
    return { error: err.message, list: [] };
  }
});

ipcMain.handle('system:killProcess', async (_e, pid) => {
  try {
    process.kill(Number(pid));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('system:networkStats', async (_e, iface) => {
  try {
    const stats = iface ? await si.networkStats(iface) : await si.networkStats();
    return Array.isArray(stats) ? stats : [stats].filter(Boolean);
  } catch {
    return [];
  }
});

ipcMain.handle('system:networkInterfaces', async () => {
  try {
    const ifaces = await si.networkInterfaces();
    return Array.isArray(ifaces) ? ifaces : [ifaces].filter(Boolean);
  } catch {
    return [];
  }
});

// Ping via systeminformation. Returns latency ms or null on failure / -1.
// si.inetLatency is fire-and-forget — it sends an ICMP packet (or TCP fallback
// if ICMP is blocked) and returns the round-trip in milliseconds.
ipcMain.handle('system:drives', async () => {
  try {
    const [sizes, io] = await Promise.all([
      si.fsSize().catch(() => []),
      si.fsStats().catch(() => null),
    ]);
    // si.fsSize returns array of { fs, type, size, used, available, use, mount }
    const drives = (sizes || []).map((d) => ({
      fs: d.fs,
      type: d.type,
      mount: d.mount,
      size: d.size,
      used: d.used,
      available: d.available !== undefined ? d.available : (d.size - d.used),
      use: d.use, // percent
    }));
    return {
      drives,
      io: io ? {
        rxSec: io.rx_sec,        // bytes/sec read
        wxSec: io.wx_sec,        // bytes/sec write
        rIO: io.rIO,
        wIO: io.wIO,
        ms: io.ms,
      } : null,
    };
  } catch (err) {
    return { error: err.message, drives: [], io: null };
  }
});

ipcMain.handle('system:battery', async () => {
  try {
    const b = await si.battery();
    if (!b) return { hasBattery: false };
    return {
      hasBattery: !!b.hasBattery,
      isCharging: !!b.isCharging,
      acConnected: !!b.acConnected,
      percent: b.percent,
      timeRemaining: b.timeRemaining, // minutes; null when charging or unknown
      cycleCount: b.cycleCount,
      voltage: b.voltage,
      designedCapacity: b.designedCapacity,
      maxCapacity: b.maxCapacity,
      currentCapacity: b.currentCapacity,
      capacityUnit: b.capacityUnit,
      type: b.type,
      model: b.model,
      manufacturer: b.manufacturer,
    };
  } catch (err) {
    return { error: err.message, hasBattery: false };
  }
});

ipcMain.handle('system:ping', async (_e, host) => {
  try {
    const target = (host && String(host).trim()) || '1.1.1.1';
    const ms = await si.inetLatency(target);
    if (typeof ms !== 'number' || ms < 0 || !Number.isFinite(ms)) return { ok: false };
    return { ok: true, ms, host: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Stealth preload script for the browser plugin's webviews. We expose the
// absolute file:// URL so the renderer can pass it to <webview preload="...">.
const { pathToFileURL } = require('url');
const STEALTH_PRELOAD_URL = pathToFileURL(
  path.join(__dirname, 'renderer', 'browser-stealth-preload.js')
).href;
ipcMain.handle('browser:getStealthPreloadUrl', () => STEALTH_PRELOAD_URL);

// ---------- Browser session controls ----------
// Renderer can ask main to clear cache / cookies / storage on a specific
// webview partition. Used by the browser plugin's settings panel.
ipcMain.handle('browser:clearCache', async (_e, partition) => {
  try {
    const ses = session.fromPartition(partition || '');
    await ses.clearCache();
    if (ses.clearAuthCache) await ses.clearAuthCache().catch(() => {});
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('browser:clearStorage', async (_e, partition, opts) => {
  try {
    const ses = session.fromPartition(partition || '');
    // opts.storages can be ['cookies','localstorage','indexdb','filesystem',
    // 'shadercache','serviceworkers','cachestorage']. Omit to clear all.
    await ses.clearStorageData(opts && opts.storages ? opts : undefined);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Configure a partition's session to look as much like real Chrome as
// possible — used by the browser plugin to placate sites (Google etc.) that
// gatekeep on signs of embedding/automation.
ipcMain.handle('browser:configurePartition', async (_e, partition, ua) => {
  try {
    const ses = session.fromPartition(partition || '');
    if (ua) ses.setUserAgent(ua);
    // Strip the X-Requested-With header that Electron adds — some Google
    // services flag it. Also normalize sec-ch-ua to match the spoofed UA.
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = { ...details.requestHeaders };
      delete h['X-Requested-With'];
      delete h['x-requested-with'];
      cb({ requestHeaders: h });
    });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- PTY / shell sessions (terminal plugin) ----------
// Per-spawn entry: { proc, exited, kind }. `kind` is 'pty' for real PTY
// (node-pty) or 'cp' for the child_process fallback.
const ptySessions = new Map();

ipcMain.handle('pty:spawn', (_e, opts) => {
  const o = opts || {};
  const id = 'pty' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const shell = o.shell || (process.platform === 'win32'
    ? (process.env.ComSpec || 'powershell.exe')
    : (process.env.SHELL || '/bin/bash'));
  const args = Array.isArray(o.args) ? o.args : [];
  const cwd = o.cwd || process.env.USERPROFILE || process.env.HOME || process.cwd();
  const cols = Math.max(2, Number(o.cols) || 80);
  const rows = Math.max(2, Number(o.rows) || 24);
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // FORCE_COLOR + CLICOLOR_FORCE coax most CLIs (git, npm, pip, ls...) to
    // emit ANSI colors even though they detect we're not a TTY.
    FORCE_COLOR: '1',
    CLICOLOR_FORCE: '1',
  };

  const send = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // Preferred path: real PTY via node-pty
  const pty = loadNodePty();
  if (pty) {
    let proc;
    try {
      proc = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env });
    } catch (err) {
      // Native module loaded but spawning blew up — fall through to child_process
      console.error('[pty] node-pty spawn failed, using child_process:', err.message);
    }
    if (proc) {
      proc.onData((data) => send('pty:data', id, data));
      proc.onExit(({ exitCode, signal }) => {
        send('pty:exit', id, exitCode, signal || null);
        const entry = ptySessions.get(id); if (entry) entry.exited = true;
      });
      ptySessions.set(id, { proc, exited: false, kind: 'pty' });
      return { id, shell, cwd, mode: 'pty' };
    }
  }

  // Fallback path: child_process.spawn — no real TTY but works without native
  // modules. Renderer is told mode === 'cp' so it can do local line buffering.
  const { spawn: cpSpawn } = require('child_process');
  let proc;
  try {
    proc = cpSpawn(shell, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { error: 'spawn failed: ' + err.message };
  }
  if (!proc.pid) {
    // Race: spawn returned a proc but it never started. Wait for 'error'.
    proc.once('error', (err) => send('pty:data', id, '\r\n[error: ' + err.message + ']\r\n'));
  }
  const onChunk = (buf) => send('pty:data', id, buf.toString('utf8'));
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);
  proc.on('error', (err) => {
    send('pty:data', id, '\r\n[spawn error: ' + err.message + ']\r\n');
  });
  proc.on('exit', (code, signal) => {
    send('pty:exit', id, code, signal || null);
    const entry = ptySessions.get(id); if (entry) entry.exited = true;
  });
  ptySessions.set(id, { proc, exited: false, kind: 'cp' });
  return { id, shell, cwd, mode: 'cp', notice: nodePtyError };
});

ipcMain.handle('pty:write', (_e, id, data) => {
  const entry = ptySessions.get(id);
  if (!entry || entry.exited) return false;
  try {
    if (entry.kind === 'pty') entry.proc.write(data);
    else entry.proc.stdin.write(data);
    return true;
  } catch { return false; }
});

ipcMain.handle('pty:resize', (_e, id, cols, rows) => {
  const entry = ptySessions.get(id);
  if (!entry || entry.exited) return false;
  if (entry.kind !== 'pty') return false; // child_process can't be resized
  try {
    entry.proc.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
    return true;
  } catch { return false; }
});

ipcMain.handle('pty:kill', (_e, id) => {
  const entry = ptySessions.get(id);
  if (!entry) return false;
  try {
    if (entry.kind === 'pty') entry.proc.kill();
    else entry.proc.kill('SIGTERM');
  } catch {}
  ptySessions.delete(id);
  return true;
});

// Reap leftover sessions on quit so we don't leave orphaned shells
app.on('before-quit', () => {
  for (const entry of ptySessions.values()) {
    try {
      if (entry.kind === 'pty') entry.proc.kill();
      else entry.proc.kill();
    } catch {}
  }
  ptySessions.clear();
  try { activityServer.stop(); } catch {}
  try { activityLogger.flush(); } catch {}
});

// ---------- Net fetch (main-side, CORS-free) ----------
// Returns { ok, status, statusText, headers, text, url, ms } on success,
// { error } on failure. Plugins use this when the renderer's fetch would
// be blocked by CORS (RSS feeds, third-party APIs without CORS headers, etc.)
ipcMain.handle('net:fetch', async (_e, opts) => {
  const t0 = Date.now();
  try {
    const o = opts || {};
    const url = String(o.url || '').trim();
    if (!url) return { error: 'url required' };
    if (!/^https?:\/\//i.test(url)) return { error: 'only http(s) URLs allowed' };
    const method = (o.method || 'GET').toUpperCase();
    const ctrl = new AbortController();
    const timeout = Math.min(60000, Math.max(1000, o.timeout || 30000));
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const init = {
      method,
      headers: o.headers || {},
      signal: ctrl.signal,
      redirect: o.redirect || 'follow',
    };
    if (o.body != null && method !== 'GET' && method !== 'HEAD') init.body = o.body;
    let res;
    try { res = await fetch(url, init); }
    finally { clearTimeout(timer); }
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      text,
      url: res.url,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      error: err.name === 'AbortError' ? 'timeout' : (err.message || String(err)),
      ms: Date.now() - t0,
    };
  }
});

// ---------- Clipboard host APIs ----------
// Poll clipboard.readText() in main; broadcast on change. This catches copies
// made in ANY app, not just the dashboard. Renderer can also write back.
let lastClipText = '';
let clipboardWatcherStarted = false;

function startClipboardWatcher() {
  if (clipboardWatcherStarted) return;
  clipboardWatcherStarted = true;
  try { lastClipText = clipboard.readText() || ''; } catch {}
  setInterval(() => {
    try {
      const cur = clipboard.readText() || '';
      if (cur !== lastClipText) {
        lastClipText = cur;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard:changed', cur);
        }
      }
    } catch {}
  }, 800);
}

ipcMain.handle('clipboard:read', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
ipcMain.handle('clipboard:write', (_e, text) => {
  try { clipboard.writeText(String(text || '')); lastClipText = String(text || ''); return true; }
  catch { return false; }
});

// ---------- OS window management ----------
// Backend lives in lib/platform-{win32,darwin,linux}.js:
//   Windows: long-lived PowerShell session driving user32 P/Invoke
//   macOS:   AppleScript via System Events (requires Accessibility permission)
//   Linux:   wmctrl / xdotool (X11; Wayland is not supported by either tool)
const winsMgr = platform.createWindowManager({
  app,
  userDataDir: app.getPath('userData'),
  getOwnHwnd: () => (mainWindow ? getWinHwnd(mainWindow) : null),
});


ipcMain.handle('windows:list', () => winsMgr.list());
ipcMain.handle('windows:focus', (_e, hwnd) => winsMgr.focus(hwnd));
ipcMain.handle('windows:close', (_e, hwnd) => winsMgr.close(hwnd));
ipcMain.handle('windows:minimize', (_e, hwnd) => winsMgr.minimize(hwnd));

ipcMain.handle('system:stats', async () => {
  // Static CPU info doesn't change — fetch once and reuse
  if (!sensorCache.cpuStatic) {
    try { sensorCache.cpuStatic = await si.cpu(); }
    catch { sensorCache.cpuStatic = null; }
  }

  // Multiple plugins (hardware, gpu-stats) call this at different intervals.
  // Cache for 1.5s so back-to-back calls share one set of si.* queries instead
  // of each plugin spawning its own wmic/dmidecode/etc. round-trip.
  const now = Date.now();
  if (sensorCache.statsResult && now - sensorCache.statsAt < 1500) {
    return sensorCache.statsResult;
  }
  // If a fetch is already in flight, wait for it rather than launching a second
  if (sensorCache.statsPending) return sensorCache.statsPending;

  sensorCache.statsPending = (async () => {
    const [cpuLoad, mem, gpu, osInfo, lhm, siTemp] = await Promise.all([
      si.currentLoad().catch(() => null),
      si.mem().catch(() => null),
      si.graphics().catch(() => null),
      si.osInfo().catch(() => null),
      getLhm(),
      getSiTempCached(),
    ]);
    const result = {
      cpu: sensorCache.cpuStatic,
      cpuLoad,
      mem,
      gpu,
      osInfo,
      siTemp,
      lhm,
      timestamp: Date.now(),
    };
    sensorCache.statsResult = result;
    sensorCache.statsAt = Date.now();
    sensorCache.statsPending = null;
    return result;
  })();

  return sensorCache.statsPending;
});

function watchPlugins() {
  ensurePluginsDir().then(() => {
    let debounce = null;
    const notify = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('plugins:changed');
        }
      }, 150);
    };
    fs.watch(PLUGINS_DIR, { recursive: true }, notify);
  });
}

async function seedPluginsIfPackaged() {
  if (!app.isPackaged) return;
  await ensurePluginsDir();
  // If the user's plugins dir is empty, copy the bundled examples in.
  try {
    const existing = await fsp.readdir(PLUGINS_DIR);
    if (existing.length > 0) return;
  } catch { /* will be created */ }
  const bundled = path.join(process.resourcesPath, 'plugins-bundled');
  try { await fsp.cp(bundled, PLUGINS_DIR, { recursive: true }); }
  catch (err) { console.error('Failed to seed plugins:', err); }
}

app.whenReady().then(async () => {
  // Auto-grant microphone / media permission so the audio-visualizer plugin
  // can call getUserMedia() without showing a system prompt. We're a personal
  // dashboard — the user implicitly consents by enabling that plugin.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone' || permission === 'notifications') {
      return cb(true);
    }
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media' || permission === 'audioCapture' || permission === 'microphone' || permission === 'notifications';
  });

  await seedPluginsIfPackaged();
  seedFirstRunDefaultsIfNeeded();
  createWindow();
  watchPlugins();
  startClipboardWatcher();

  // If the user previously enabled "auto-start server", boot it now.
  try {
    const cfg = readHostConfig();
    if (cfg.loggingEnabled === false) activityLogger.setEnabled(false);
    loadCredentialsIntoServer();
    if (cfg.autoStart && cfg.passwordHashHex) {
      await activityServer.start({
        port: cfg.port || 7878,
        lan: !!cfg.lan,
      });
      activityLogger.log('system', 'host:auto-started', { port: activityServer.port, lan: activityServer.lan });
    }
  } catch (err) {
    console.error('host server auto-start failed:', err.message);
  }

  // Global escape hatch — survives fullscreen + always-on-top + skin mode
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());

  // Bring dashboard to focus from anywhere (useful in skin mode where the
  // window is hidden from taskbar/Alt-Tab — Win+D shows the desktop layer,
  // but if you just want focus, this hotkey is faster).
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { stopRemoteInjector(); } catch {}
});

app.on('window-all-closed', () => {
  if (recreating) return;
  if (process.platform !== 'darwin') app.quit();
});
