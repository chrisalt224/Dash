// macOS backend.
// Power actions use AppleScript / pmset; window management uses System Events
// AppleScript; app discovery walks /Applications and ~/Applications.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ---------- Power actions ----------
const POWER_ACTIONS = [
  // pmset displaysleepnow → just blanks the screen and triggers screen-saver/lock
  // depending on Security & Privacy settings; closest equivalent to LockWorkStation.
  { id: 'lock',     label: 'Lock',     glyph: '⊟', confirm: false,
    cmd: 'pmset', args: ['displaysleepnow'] },
  { id: 'sleep',    label: 'Sleep',    glyph: '☾', confirm: false,
    cmd: 'pmset', args: ['sleepnow'] },
  { id: 'signout',  label: 'Sign Out', glyph: '⎋', confirm: true,
    cmd: 'osascript', args: ['-e', 'tell application "System Events" to log out'] },
  { id: 'restart',  label: 'Restart',  glyph: '↻', confirm: true,
    cmd: 'osascript', args: ['-e', 'tell application "System Events" to restart'] },
  { id: 'shutdown', label: 'Shutdown', glyph: '⏻', confirm: true,
    cmd: 'osascript', args: ['-e', 'tell application "System Events" to shut down'] },
  // Hibernate as a discrete action doesn't exist on macOS — it's part of sleep
  // behavior controlled by `pmset hibernatemode`. Omitted.
];

function listPowerActions() {
  return POWER_ACTIONS.map(({ id, label, glyph, confirm }) => ({ id, label, glyph, confirm }));
}

function executePowerAction(id) {
  const action = POWER_ACTIONS.find(a => a.id === id);
  if (!action) return { ok: false, error: 'unknown_action' };
  try {
    const child = spawn(action.cmd, action.args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- App discovery ----------
async function findAppBundles(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const full = path.join(dir, ent.name);
    if (ent.name.endsWith('.app')) {
      out.push(full);
      // Don't descend into a .app bundle's contents.
      continue;
    }
    // Recurse into normal subdirectories (e.g. /Applications/Utilities/).
    if (depth < maxDepth) await findAppBundles(full, depth + 1, maxDepth, out);
  }
  return out;
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, ...opts }, (err, stdout) => {
      if (err) resolve('');
      else resolve((stdout || '').toString());
    });
  });
}

async function getBundleDisplayName(bundlePath) {
  // mdls is the cleanest source of the localized display name; falls back
  // to the bundle filename if Spotlight isn't enabled or the call fails.
  const out = await execFileP('mdls', ['-name', 'kMDItemDisplayName', '-raw', bundlePath]);
  const trimmed = out.trim().replace(/\.app$/i, '');
  if (trimmed && trimmed !== '(null)') return trimmed;
  return path.basename(bundlePath, '.app');
}

async function discoverApps({ app }) {
  const dirs = [
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications'),
  ];

  const bundles = [];
  for (const d of dirs) await findAppBundles(d, 0, 2, bundles);

  const apps = [];
  const seen = new Set();
  const skipName = /^(uninstall|readme|license)$/i;

  for (const bundlePath of bundles) {
    const baseName = path.basename(bundlePath, '.app');
    if (skipName.test(baseName)) continue;
    const key = bundlePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const name = await getBundleDisplayName(bundlePath);

    let iconDataUrl = null;
    try {
      const icon = await app.getFileIcon(bundlePath, { size: 'large' });
      if (icon && !icon.isEmpty()) iconDataUrl = icon.toDataURL();
    } catch { /* leave null */ }

    apps.push({
      id: 'app:' + bundlePath,
      source: 'discovered',
      name,
      target: bundlePath,
      args: '',
      launchPath: bundlePath,
      iconDataUrl,
    });
  }

  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

// ---------- Window manager ----------
// AppleScript via System Events. List/focus are reasonably well-supported;
// per-window close/minimize work for most apps but not all (Electron, some
// Java apps). On first call macOS will prompt for Accessibility permission.
function createWindowManager({ app, getOwnHwnd }) {
  const iconCache = new Map();
  const ownPid = process.pid;

  // osascript's `-e` flag is one-line-only. For multi-line scripts we have
  // to pipe via stdin (no-arg invocation reads from stdin).
  const runOsa = (script) => new Promise((resolve) => {
    const ps = spawn('osascript', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    ps.stdout.on('data', d => out += d);
    ps.stderr.on('data', d => err += d);
    ps.on('error', () => resolve({ ok: false, error: 'osascript_spawn_failed' }));
    ps.on('close', (code) => {
      if (code === 0) resolve({ ok: true, out: out.trim() });
      else resolve({ ok: false, error: (err.trim() || out.trim() || 'osascript_failed').slice(0, 200) });
    });
    try { ps.stdin.write(script); ps.stdin.end(); }
    catch { /* close handler will resolve with error */ }
  });

  // List visible app processes that have at least one visible window.
  // Output format: <pid>\t<bundle path>\t<process name>\t<window title>
  // (one line per window — apps with multiple windows produce multiple rows).
  const list = async () => {
    const script = `
set out to ""
tell application "System Events"
  set procs to (every process whose visible is true and background only is false)
  repeat with p in procs
    try
      set procPid to unix id of p
      set procName to name of p
      set bundlePath to ""
      try
        set bundleId to bundle identifier of p
        set bundlePath to POSIX path of (path to application id bundleId)
      end try
      set wins to (every window of p)
      repeat with w in wins
        try
          set wTitle to name of w
        on error
          set wTitle to procName
        end try
        if wTitle is missing value then set wTitle to procName
        set out to out & procPid & tab & bundlePath & tab & procName & tab & wTitle & linefeed
      end repeat
    end try
  end repeat
end tell
return out`;

    const res = await runOsa(script);
    if (!res.ok) return { error: res.error || 'list_failed', list: [] };

    const arr = [];
    const lines = res.out.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 4) continue;
      const [pidStr, bundlePath, procName, title] = parts;
      const pid = Number(pidStr);
      if (!pid || pid === ownPid) continue;
      // Synthesize a stable handle: pid + window-index. Renderer treats this
      // as opaque; we parse it back in focus/close/minimize.
      const hwnd = pid + ':' + idx;
      arr.push({
        pid,
        hwnd,
        title: title || procName,
        name: procName,
        path: bundlePath || null,
      });
    }

    const own = getOwnHwnd ? getOwnHwnd() : null;
    const filtered = own ? arr.filter(w => String(w.hwnd) !== String(own)) : arr;

    for (const w of filtered) {
      if (!w.path) { w.iconDataUrl = null; continue; }
      if (iconCache.has(w.path)) { w.iconDataUrl = iconCache.get(w.path); continue; }
      try {
        const img = await app.getFileIcon(w.path, { size: 'small' });
        const url = (img && !img.isEmpty()) ? img.toDataURL() : null;
        if (iconCache.size >= 150) iconCache.delete(iconCache.keys().next().value);
        iconCache.set(w.path, url);
        w.iconDataUrl = url;
      } catch {
        if (iconCache.size >= 150) iconCache.delete(iconCache.keys().next().value);
        iconCache.set(w.path, null);
        w.iconDataUrl = null;
      }
    }
    return { list: filtered };
  };

  // Each handle is `<pid>:<windowIndex>` as produced by list(). To act on a
  // specific window we have to drive its parent process by name; AppleScript
  // doesn't expose direct hwnd-style addressing.
  const parseHandle = (h) => {
    const [pidStr] = String(h).split(':');
    return { pid: Number(pidStr) || 0 };
  };

  const focus = async (handle) => {
    const { pid } = parseHandle(handle);
    if (!pid) return { ok: false, error: 'bad_handle' };
    const res = await runOsa(`
tell application "System Events"
  set p to first process whose unix id is ${pid}
  set frontmost of p to true
end tell`);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  };

  const close = async (handle) => {
    const { pid } = parseHandle(handle);
    if (!pid) return { ok: false, error: 'bad_handle' };
    // Close just the front window of the target process; matches the
    // "close one window" semantics of WM_CLOSE on Windows.
    const res = await runOsa(`
tell application "System Events"
  set p to first process whose unix id is ${pid}
  try
    click (first button of front window of p whose subrole is "AXCloseButton")
  on error
    keystroke "w" using command down
  end try
end tell`);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  };

  const minimize = async (handle) => {
    const { pid } = parseHandle(handle);
    if (!pid) return { ok: false, error: 'bad_handle' };
    const res = await runOsa(`
tell application "System Events"
  set p to first process whose unix id is ${pid}
  try
    click (first button of front window of p whose subrole is "AXMinimizeButton")
  end try
end tell`);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  };

  return { list, focus, close, minimize };
}

// ---------- Pin window to desktop ----------
// macOS doesn't support reparenting into the wallpaper layer the way Windows
// Progman does. Best approximation: drop the window's level so it sits below
// normal app windows but above the desktop, and stick it on every space.
async function pinWindowToDesktop(win) {
  if (!win) return;
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(false);
    // 'desktop' is the lowest level Electron exposes on macOS. Not a true
    // wallpaper-layer pin, but the closest the public API allows.
    if (typeof win.setAlwaysOnTop === 'function') {
      win.setAlwaysOnTop(true, 'desktop');
    }
  } catch (err) {
    console.error('macOS pin failed:', err.message);
  }
}

async function unpinWindowFromDesktop(win) {
  if (!win) return;
  try {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
  } catch {}
}

// macOS skin mode is best-effort; advertise it as supported so the toggle
// still appears, but caveats apply (see pinWindowToDesktop above).
function supportsSkinMode() { return true; }
function supportsShortcutFiles() { return false; }

module.exports = {
  listPowerActions,
  executePowerAction,
  discoverApps,
  createWindowManager,
  pinWindowToDesktop,
  unpinWindowFromDesktop,
  supportsSkinMode,
  supportsShortcutFiles,
};
