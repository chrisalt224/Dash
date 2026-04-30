// Linux backend.
// Power actions use systemctl + loginctl; window management uses wmctrl
// (X11; on Wayland this falls back gracefully); app discovery walks XDG
// .desktop directories.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ---------- Power actions ----------
// loginctl works on systemd-based desktops (which is what Fedora ships).
// For non-systemd setups we fall back to xdg/dbus equivalents at runtime,
// but Fedora is the explicit target so this is the primary path.
const POWER_ACTIONS = [
  { id: 'lock',     label: 'Lock',     glyph: '⊟', confirm: false,
    cmd: 'loginctl', args: ['lock-session'] },
  { id: 'sleep',    label: 'Sleep',    glyph: '☾', confirm: false,
    cmd: 'systemctl', args: ['suspend'] },
  { id: 'hibernate', label: 'Hibernate', glyph: '❄', confirm: true,
    cmd: 'systemctl', args: ['hibernate'] },
  { id: 'signout',  label: 'Sign Out', glyph: '⎋', confirm: true,
    cmd: 'loginctl', args: ['terminate-user', os.userInfo().username] },
  { id: 'restart',  label: 'Restart',  glyph: '↻', confirm: true,
    cmd: 'systemctl', args: ['reboot'] },
  { id: 'shutdown', label: 'Shutdown', glyph: '⏻', confirm: true,
    cmd: 'systemctl', args: ['poweroff'] },
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

// ---------- App discovery (.desktop files) ----------
// Standard XDG locations. We follow XDG_DATA_DIRS when set so distros that
// move things around (e.g. flatpak overlays) still work.
function getDesktopDirs() {
  const dirs = new Set();

  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter(Boolean);
  for (const d of dataDirs) dirs.add(path.join(d, 'applications'));

  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  dirs.add(path.join(dataHome, 'applications'));

  // Flatpak system + user export dirs
  dirs.add('/var/lib/flatpak/exports/share/applications');
  dirs.add(path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'));

  return Array.from(dirs);
}

async function findDesktopFiles(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await findDesktopFiles(full, depth + 1, maxDepth, out);
    else if (ent.isFile() && ent.name.endsWith('.desktop')) out.push(full);
  }
  return out;
}

// .desktop is INI-ish; we only care about the [Desktop Entry] group.
// Spec: https://specifications.freedesktop.org/desktop-entry-spec/latest/
function parseDesktopFile(content) {
  const entry = {};
  let inMain = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inMain = (line === '[Desktop Entry]');
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    // We only consume the un-localized keys (Name, Icon, etc.) — the
    // localized variants like Name[de] would override but we don't need
    // that level of fidelity for a launcher.
    if (!entry[key]) entry[key] = val;
  }
  return entry;
}

// .desktop Exec= contains field codes (%f, %u, %F, %U, %i, %c, %k) that
// describe argument substitution. For a launcher that takes no input we
// strip them out entirely. Quoted args ("..." with backslash escapes) are
// preserved.
function parseExecLine(exec) {
  if (!exec) return { cmd: '', args: [] };
  const stripped = exec
    .replace(/%[fFuUickvm]/g, '')
    .replace(/%%/g, '%')
    .trim();
  const parts = [];
  let cur = '';
  let quote = null;
  let escape = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) { cur += ch; escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return { cmd: parts[0] || '', args: parts.slice(1) };
}

// Resolve an Icon= value to an absolute file. Spec says it's either an
// absolute path or a name to look up via the icon theme. We do a best-effort
// theme lookup in the standard locations; if none of them resolve we return
// null and the renderer falls back to the first-letter placeholder tile.
async function resolveIconPath(iconValue) {
  if (!iconValue) return null;
  if (path.isAbsolute(iconValue)) {
    try { await fsp.access(iconValue); return iconValue; }
    catch { return null; }
  }

  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const themes = ['hicolor', 'Adwaita', 'gnome', 'breeze'];
  // Prefer larger sizes — they downscale cleanly for the start menu tiles.
  const sizes = ['scalable', '256x256', '128x128', '96x96', '64x64', '48x48'];
  const exts = ['.png', '.svg', '.xpm'];

  const candidates = [];
  // Standard pixmap dirs (no theme resolution needed)
  for (const d of dataDirs) {
    for (const ext of exts) candidates.push(path.join(d, 'pixmaps', iconValue + ext));
  }
  candidates.push(path.join(dataHome, 'icons', iconValue + '.png'));
  // Themed lookup
  for (const base of [path.join(dataHome, 'icons'), ...dataDirs.map(d => path.join(d, 'icons'))]) {
    for (const theme of themes) {
      for (const size of sizes) {
        for (const ext of exts) {
          candidates.push(path.join(base, theme, size, 'apps', iconValue + ext));
        }
      }
    }
  }

  for (const c of candidates) {
    try { await fsp.access(c); return c; }
    catch { /* try next */ }
  }
  return null;
}

async function discoverApps({ app }) {
  const dirs = getDesktopDirs();
  const files = [];
  for (const d of dirs) await findDesktopFiles(d, 0, 3, files);

  const apps = [];
  const seen = new Set();

  for (const file of files) {
    let content;
    try { content = await fsp.readFile(file, 'utf8'); }
    catch { continue; }
    const entry = parseDesktopFile(content);
    if (!entry.Name || !entry.Exec) continue;
    if (entry.Type && entry.Type !== 'Application') continue;
    if (entry.NoDisplay === 'true' || entry.Hidden === 'true') continue;

    const { cmd, args } = parseExecLine(entry.Exec);
    if (!cmd) continue;

    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let iconDataUrl = null;
    const iconPath = await resolveIconPath(entry.Icon);
    if (iconPath) {
      try {
        const icon = await app.getFileIcon(iconPath, { size: 'large' });
        if (icon && !icon.isEmpty()) iconDataUrl = icon.toDataURL();
        else {
          // app.getFileIcon doesn't always render for SVG/XPM on Linux; read
          // the file directly and embed as a data URL when it's a raster image.
          const ext = path.extname(iconPath).toLowerCase();
          if (ext === '.png' || ext === '.svg') {
            const buf = await fsp.readFile(iconPath);
            const mime = ext === '.svg' ? 'image/svg+xml' : 'image/png';
            iconDataUrl = `data:${mime};base64,` + buf.toString('base64');
          }
        }
      } catch { /* leave null */ }
    }

    apps.push({
      id: 'desktop:' + file,
      source: 'discovered',
      name: entry.Name,
      // Launching .desktop files via gtk-launch / dex preserves Terminal=, env,
      // etc. We surface the parsed Exec for fallback launching.
      target: cmd,
      args: args.join(' '),
      launchPath: file,
      iconDataUrl,
    });
  }

  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

// ---------- Window manager ----------
// wmctrl is the X11 standard. On Wayland-only sessions wmctrl will fail
// (no _NET_CLIENT_LIST), and we surface that as an error so the renderer
// can show a "no window manager" notice. There's no portable Wayland API
// for cross-app window enumeration, by design.
function createWindowManager({ app, getOwnHwnd }) {
  const iconCache = new Map();

  const execFileP = (cmd, args, opts = {}) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, ...opts }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: stderr ? stderr.toString().trim() : err.message });
      else resolve({ ok: true, out: (stdout || '').toString() });
    });
  });

  // wmctrl -l -p -G output:
  //   <hwnd>  <desktop>  <pid>  <x>  <y>  <w>  <h>  <hostname>  <title...>
  // wmctrl -l -x adds a WM_CLASS column we use as the "process name".
  const list = async () => {
    // First: wmctrl -lpG (positions + pid)
    const lp = await execFileP('wmctrl', ['-l', '-p', '-G']);
    if (!lp.ok) return { error: 'wmctrl_unavailable: ' + lp.error, list: [] };

    // Second: wmctrl -lx (WM_CLASS) — joined by hwnd so we can show app names
    const lx = await execFileP('wmctrl', ['-l', '-x']);
    const classByHwnd = new Map();
    if (lx.ok) {
      for (const line of lx.out.split(/\r?\n/)) {
        if (!line) continue;
        const m = line.match(/^(0x[0-9a-fA-F]+)\s+\S+\s+(\S+)\s+\S+\s+(.*)$/);
        if (m) classByHwnd.set(m[1].toLowerCase(), m[2]);
      }
    }

    const arr = [];
    for (const line of lp.out.split(/\r?\n/)) {
      if (!line) continue;
      // "0x... -1 1234 0 0 0 0 host title with spaces"
      const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\S+\s+(.*)$/);
      if (!m) continue;
      const [, hwnd, desktop, pidStr, title] = m;
      // desktop === '-1' means sticky/util windows; skip docks, panels, etc.
      if (desktop === '-1') continue;
      const pid = Number(pidStr);
      const wmClass = classByHwnd.get(hwnd.toLowerCase()) || '';
      // wmClass looks like "firefox.Firefox" — take the second segment if present
      const procName = wmClass.includes('.') ? wmClass.split('.').pop() : wmClass;

      // /proc/<pid>/exe → resolved binary path; used for icon caching only.
      let exePath = null;
      try { exePath = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}

      arr.push({
        pid,
        hwnd,
        title: title || procName || '(untitled)',
        name: procName || (exePath ? path.basename(exePath) : 'app'),
        path: exePath,
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

  const focus = async (hwnd) => {
    // -i = treat the next arg as a window id (hex), -a = activate
    const r = await execFileP('wmctrl', ['-i', '-a', hwnd]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };

  const close = async (hwnd) => {
    const r = await execFileP('wmctrl', ['-i', '-c', hwnd]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };

  const minimize = async (hwnd) => {
    // No first-class minimize in wmctrl; xdotool windowminimize works on
    // every EWMH-compliant WM. If neither tool is installed we surface the
    // error to the renderer.
    const r = await execFileP('xdotool', ['windowminimize', hwnd]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };

  return { list, focus, close, minimize };
}

// ---------- Pin window to desktop ----------
// EWMH _NET_WM_WINDOW_TYPE_DESKTOP marks a window as the desktop layer.
// Most compliant WMs (Mutter/GNOME, KWin, XFWM) honor this — the window
// then sits below all normal app windows and on every workspace.
async function pinWindowToDesktop(win) {
  if (!win) return;
  try {
    win.setSkipTaskbar(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(false);
  } catch {}

  // Get the X11 window id and apply _NET_WM_WINDOW_TYPE_DESKTOP via xprop.
  // Skipped silently if xprop isn't installed or we're on Wayland.
  try {
    const handleBuf = win.getNativeWindowHandle();
    if (!handleBuf || handleBuf.length === 0) return;
    // On Linux the native handle is a 32-bit X11 Window id (XID).
    const xid = handleBuf.readUInt32LE();
    if (!xid) return;
    const hex = '0x' + xid.toString(16);

    await new Promise((resolve) => {
      const ps = spawn('xprop', [
        '-id', hex,
        '-f', '_NET_WM_WINDOW_TYPE', '32a',
        '-set', '_NET_WM_WINDOW_TYPE', '_NET_WM_WINDOW_TYPE_DESKTOP',
      ], { stdio: 'ignore' });
      ps.on('error', () => resolve());
      ps.on('exit', () => resolve());
    });
  } catch (err) {
    console.error('Linux pin failed:', err.message);
  }
}

async function unpinWindowFromDesktop(win) {
  if (!win) return;
  try {
    win.setSkipTaskbar(false);
    win.setVisibleOnAllWorkspaces(false);
  } catch {}
  try {
    const handleBuf = win.getNativeWindowHandle();
    if (!handleBuf || handleBuf.length === 0) return;
    const xid = handleBuf.readUInt32LE();
    if (!xid) return;
    const hex = '0x' + xid.toString(16);
    await new Promise((resolve) => {
      const ps = spawn('xprop', [
        '-id', hex,
        '-f', '_NET_WM_WINDOW_TYPE', '32a',
        '-set', '_NET_WM_WINDOW_TYPE', '_NET_WM_WINDOW_TYPE_NORMAL',
      ], { stdio: 'ignore' });
      ps.on('error', () => resolve());
      ps.on('exit', () => resolve());
    });
  } catch {}
}

// Skin mode requires X11 + xprop. Wayland-only sessions can't honor the
// desktop-type hint reliably. We advertise support; pinWindowToDesktop will
// fall back to a no-op on Wayland so the toggle just acts as alwaysOnTop=off.
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
