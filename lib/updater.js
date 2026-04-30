// Auto-updater wrapper around electron-updater.
//
// Behavior:
//   - On packaged builds, checks for updates 10s after launch and every 4h.
//   - Auto-downloads in the background; the user is shown a "restart to install"
//     button in Settings → Updates (and a badge dot on the Settings entry).
//   - Falls back to no-op silently in dev mode (electron-updater needs a real
//     install path + code signing context to function).
//
// Renderer protocol:
//   ipc 'updates:status' (push)   — { state, info?, progress?, error? }
//     state ∈ 'idle' | 'dev' | 'no-config' | 'checking' | 'available' |
//             'not-available' | 'downloading' | 'downloaded' | 'error'
//   ipc 'updates:status' (invoke) — returns the latest cached status
//   ipc 'updates:check'  (invoke) — kicks off a check, returns updated status
//   ipc 'updates:install'(invoke) — quitAndInstall (only valid when downloaded)

const { app, ipcMain } = require('electron');

let autoUpdater = null;
let loadError = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (err) {
  loadError = err.message || String(err);
}

let mainWindow = null;
let cachedStatus = { state: 'idle' };
let initialized = false;

function publishConfigured() {
  // electron-updater reads publish config from app-update.yml inside the
  // packaged build. If publish is unset (or still set to the placeholder
  // owner=YOUR_GITHUB_USERNAME), checks would either 404 or hit the wrong
  // repo. We can't read app-update.yml from here cheaply, so use a soft
  // heuristic: defer to the auto-updater and surface its error.
  return true;
}

function setStatus(patch) {
  cachedStatus = { ...cachedStatus, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('updates:status', cachedStatus); }
    catch { /* renderer may not be ready */ }
  }
}

function attachListeners() {
  autoUpdater.on('checking-for-update', () =>
    setStatus({ state: 'checking', error: null }));

  autoUpdater.on('update-available', (info) =>
    setStatus({ state: 'available', info: pickInfo(info), error: null }));

  autoUpdater.on('update-not-available', (info) =>
    setStatus({ state: 'not-available', info: pickInfo(info), error: null }));

  autoUpdater.on('download-progress', (progress) =>
    setStatus({
      state: 'downloading',
      progress: {
        percent: Math.round(progress.percent || 0),
        bytesPerSecond: progress.bytesPerSecond || 0,
        transferred: progress.transferred || 0,
        total: progress.total || 0,
      },
      error: null,
    }));

  autoUpdater.on('update-downloaded', (info) =>
    setStatus({ state: 'downloaded', info: pickInfo(info), progress: null, error: null }));

  autoUpdater.on('error', (err) =>
    setStatus({ state: 'error', error: err && err.message ? err.message : String(err) }));
}

function pickInfo(info) {
  if (!info) return null;
  return {
    version: info.version || null,
    releaseName: info.releaseName || null,
    releaseDate: info.releaseDate || null,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
  };
}

function initUpdater(win) {
  mainWindow = win;
  if (initialized) {
    // Window changed — push the cached status to the new renderer.
    setStatus({});
    return;
  }
  initialized = true;

  if (!autoUpdater) {
    setStatus({ state: 'error', error: 'electron-updater not installed: ' + (loadError || 'unknown') });
    return;
  }
  if (!app.isPackaged) {
    setStatus({ state: 'dev' });
    return;
  }
  if (!publishConfigured()) {
    setStatus({ state: 'no-config' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // electron-updater logs to its own logger; route important events through
  // our setStatus instead of the user's console.
  autoUpdater.logger = null;

  attachListeners();

  // Stagger the first check so it doesn't fight with the initial load.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { /* error handler reports */ });
  }, 10_000);

  // Re-check every 4 hours while the app is running.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

ipcMain.handle('updates:status', () => cachedStatus);

ipcMain.handle('updates:check', async () => {
  if (!autoUpdater || !app.isPackaged) {
    setStatus({ state: app.isPackaged ? 'error' : 'dev', error: app.isPackaged ? loadError : null });
    return cachedStatus;
  }
  try {
    setStatus({ state: 'checking', error: null });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', error: err.message || String(err) });
  }
  return cachedStatus;
});

ipcMain.handle('updates:install', () => {
  if (!autoUpdater || cachedStatus.state !== 'downloaded') return false;
  // Defer one tick so the renderer can finish its current task / log the
  // click before the app shuts down.
  setImmediate(() => {
    try { autoUpdater.quitAndInstall(); } catch {}
  });
  return true;
});

module.exports = { initUpdater };
