// Windows backend.
// Contains the original PowerShell-based implementations that previously
// lived inline in main.js. Surface (powerActions, discoverApps, WindowManager,
// pinWindowToDesktop) is identical across the three platform modules.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

// ---------- Power actions ----------
// `id`/`label`/`glyph`/`confirm` are surfaced to the renderer; cmd/args stay
// in main so the renderer never has to know about platform-specific binaries.
const POWER_ACTIONS = [
  { id: 'lock',      label: 'Lock',      glyph: '⊟', confirm: false, cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
  { id: 'sleep',     label: 'Sleep',     glyph: '☾', confirm: false, cmd: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] },
  { id: 'signout',   label: 'Sign Out',  glyph: '⎋', confirm: true,  cmd: 'shutdown.exe', args: ['/l'] },
  { id: 'hibernate', label: 'Hibernate', glyph: '❄', confirm: true,  cmd: 'shutdown.exe', args: ['/h'] },
  { id: 'restart',   label: 'Restart',   glyph: '↻', confirm: true,  cmd: 'shutdown.exe', args: ['/r', '/t', '0'] },
  { id: 'shutdown',  label: 'Shutdown',  glyph: '⏻', confirm: true,  cmd: 'shutdown.exe', args: ['/s', '/t', '0'] },
];

function listPowerActions() {
  return POWER_ACTIONS.map(({ id, label, glyph, confirm }) => ({ id, label, glyph, confirm }));
}

function executePowerAction(id) {
  const action = POWER_ACTIONS.find(a => a.id === id);
  if (!action) return { ok: false, error: 'unknown_action' };
  try {
    const child = spawn(action.cmd, action.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- App discovery (Start Menu .lnk scan) ----------
async function findLnks(dir, depth, max, out) {
  if (depth > max) return out;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await findLnks(full, depth + 1, max, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.lnk')) out.push(full);
  }
  return out;
}

async function discoverApps({ shell, app }) {
  const startMenus = [
    process.env.PROGRAMDATA && path.join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.APPDATA     && path.join(process.env.APPDATA,     'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ].filter(Boolean);

  const lnks = [];
  for (const dir of startMenus) await findLnks(dir, 0, 5, lnks);

  const apps = [];
  const seen = new Set();
  const skipName = /unins|readme|license|help|support|repair|website|^docs?$|setup/i;

  // Resolved target executable usually has the cleanest icon; fall back to
  // the .lnk's explicit icon path, then the .lnk itself.
  const tryGetIcon = async (candidates) => {
    for (const c of candidates) {
      if (!c) continue;
      try {
        const icon = await app.getFileIcon(c, { size: 'large' });
        if (icon && !icon.isEmpty()) {
          const png = icon.toPNG();
          if (png && png.length > 256) return icon.toDataURL();
        }
      } catch { /* try next */ }
    }
    return null;
  };

  for (const lnkPath of lnks) {
    let link = null;
    try { link = shell.readShortcutLink(lnkPath); }
    catch { continue; }
    if (!link || !link.target) continue;
    const target = link.target;
    const tlower = target.toLowerCase();
    if (!tlower.endsWith('.exe')) continue;

    const baseName = path.basename(lnkPath, '.lnk');
    if (skipName.test(baseName)) continue;

    const key = baseName.toLowerCase() + '|' + tlower;
    if (seen.has(key)) continue;
    seen.add(key);

    const iconDataUrl = await tryGetIcon([target, link.icon, lnkPath]);

    apps.push({
      id: 'lnk:' + lnkPath,
      source: 'discovered',
      name: baseName,
      target,
      args: link.args || '',
      launchPath: lnkPath,
      iconDataUrl,
    });
  }

  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

// ---------- Window manager ----------
// Long-running PowerShell session — load user32 P/Invoke once and pipe
// newline-delimited commands to amortize the 300-500ms PS startup cost.
function createWindowManager({ app, getOwnHwnd, userDataDir }) {
  let ps = null;
  let buf = '';
  let pending = [];
  let starting = false;
  const iconCache = new Map();

  const ensureScriptOnDisk = () => {
    const scriptPath = path.join(userDataDir, 'windows-manager.ps1');
    const body = `
$ErrorActionPreference = 'Continue'
$null = Add-Type -Name DBWin -Namespace DB -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@ -ErrorAction SilentlyContinue

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line -split ' ', 2
  $cmd = $parts[0]
  $arg = if ($parts.Length -gt 1) { $parts[1].Trim() } else { '' }
  try {
    switch ($cmd) {
      'list' {
        $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' }
        $items = @()
        foreach ($p in $procs) {
          $path = $null
          try { $path = $p.MainModule.FileName } catch {}
          $items += [ordered]@{
            pid = $p.Id
            hwnd = [string]([int64]$p.MainWindowHandle)
            title = $p.MainWindowTitle
            name = $p.ProcessName
            path = $path
          }
        }
        $json = ConvertTo-Json -Compress -InputObject @($items)
        if (-not $json) { $json = '[]' }
        $json = $json -replace "\\r?\\n", ' '
        Write-Output ('OK ' + $json)
      }
      'focus' {
        $h = [IntPtr]::new([int64]$arg)
        $fg = [DB.DBWin]::GetForegroundWindow()
        $tFgPid = [uint32]0
        $tFg = [DB.DBWin]::GetWindowThreadProcessId($fg, [ref]$tFgPid)
        $tCur = [DB.DBWin]::GetCurrentThreadId()
        $attached = $false
        try {
          if ($tFg -ne $tCur) {
            $attached = [DB.DBWin]::AttachThreadInput($tCur, $tFg, $true)
          }
          if ([DB.DBWin]::IsIconic($h)) { [DB.DBWin]::ShowWindow($h, 9) | Out-Null }
          [DB.DBWin]::BringWindowToTop($h) | Out-Null
          [DB.DBWin]::SetForegroundWindow($h) | Out-Null
        } finally {
          if ($attached) { [DB.DBWin]::AttachThreadInput($tCur, $tFg, $false) | Out-Null }
        }
        Write-Output 'OK'
      }
      'close' {
        $h = [IntPtr]::new([int64]$arg)
        # WM_CLOSE = 0x0010 — graceful close, app gets to prompt to save etc.
        [DB.DBWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Write-Output 'OK'
      }
      'minimize' {
        $h = [IntPtr]::new([int64]$arg)
        [DB.DBWin]::ShowWindow($h, 6) | Out-Null
        Write-Output 'OK'
      }
      default {
        Write-Output ('ERR unknown_cmd ' + $cmd)
      }
    }
  } catch {
    $msg = $_.Exception.Message -replace "\\r?\\n", ' '
    Write-Output ('ERR ' + $msg)
  }
}
`;
    fs.writeFileSync(scriptPath, body, 'utf8');
    return scriptPath;
  };

  const start = () => {
    if (ps || starting) return;
    starting = true;
    try {
      const scriptPath = ensureScriptOnDisk();
      ps = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ], { windowsHide: true });

      ps.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          const next = pending.shift();
          if (next) next(line);
        }
      });
      ps.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        if (s.trim()) console.error('windows-mgr stderr:', s.trim());
      });
      ps.on('exit', () => {
        ps = null;
        starting = false;
        for (const r of pending) r('ERR ps_exited');
        pending = [];
      });
      starting = false;
    } catch (err) {
      starting = false;
      ps = null;
      console.error('windows-mgr failed to start:', err);
    }
  };

  const send = (cmd) => new Promise((resolve) => {
    if (!ps) start();
    if (!ps) { resolve('ERR no_ps'); return; }
    pending.push(resolve);
    try { ps.stdin.write(cmd + '\n'); }
    catch (err) {
      const idx = pending.indexOf(resolve);
      if (idx !== -1) pending.splice(idx, 1);
      resolve('ERR write_failed');
    }
    setTimeout(() => {
      const idx = pending.indexOf(resolve);
      if (idx !== -1) {
        pending.splice(idx, 1);
        resolve('ERR timeout');
      }
    }, 5000);
  });

  const list = async () => {
    const reply = await send('list');
    if (!reply.startsWith('OK ')) return { error: reply.replace(/^ERR ?/, '') || 'list_failed', list: [] };
    let arr;
    try {
      const parsed = JSON.parse(reply.slice(3));
      arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch (e) {
      return { error: 'parse_failed', list: [] };
    }
    const myHwnd = getOwnHwnd ? getOwnHwnd() : null;
    arr = arr.filter((w) => w && String(w.hwnd) !== String(myHwnd));
    for (const w of arr) {
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
    return { list: arr };
  };

  const focus = async (hwnd) => {
    const r = await send('focus ' + hwnd);
    return { ok: r.startsWith('OK'), error: r.startsWith('ERR') ? r.slice(4) : null };
  };
  const close = async (hwnd) => {
    const r = await send('close ' + hwnd);
    return { ok: r.startsWith('OK'), error: r.startsWith('ERR') ? r.slice(4) : null };
  };
  const minimize = async (hwnd) => {
    const r = await send('minimize ' + hwnd);
    return { ok: r.startsWith('OK'), error: r.startsWith('ERR') ? r.slice(4) : null };
  };

  return { list, focus, close, minimize };
}

// ---------- Pin window to desktop (skin mode) ----------
// Reparent the Electron window onto the desktop's icon-holding window
// (Progman/WorkerW) so it sits behind every other application like a
// custom wallpaper.
function getWinHwnd(win) {
  if (!win) return null;
  const buf = win.getNativeWindowHandle();
  if (!buf) return null;
  return process.arch === 'x64'
    ? buf.readBigUInt64LE().toString()
    : buf.readUInt32LE().toString();
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', '-',
    ], { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', (d) => out += d);
    ps.stderr.on('data', (d) => err += d);
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`PowerShell exit ${code}: ${err.trim() || '(no stderr)'}`));
    });
    ps.stdin.write(script);
    ps.stdin.end();
  });
}

async function pinWindowToDesktop(win) {
  const hwnd = getWinHwnd(win);
  if (!hwnd) throw new Error('No window handle');
  const script = `
$src = @'
using System;
using System.Runtime.InteropServices;
public static class Pin {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string a, string b);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr a, IntPtr b, string c, string d);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc p, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public static IntPtr Found;
  public static IntPtr FindIconHost() {
    IntPtr progman = FindWindow("Progman", null);
    IntPtr res;
    SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), IntPtr.Zero, 0, 1000, out res);
    Found = IntPtr.Zero;
    EnumWindows((top, lp) => {
      IntPtr defView = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (defView != IntPtr.Zero) Found = top;
      return true;
    }, IntPtr.Zero);
    if (Found == IntPtr.Zero) Found = progman;
    return Found;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp -ErrorAction SilentlyContinue
$target = [Pin]::FindIconHost()
if ($target -eq [IntPtr]::Zero) { Write-Error "no icon host"; exit 1 }
[Pin]::SetParent([IntPtr]::new([int64]"${hwnd}"), $target) | Out-Null
Write-Output "ok"
`;
  return runPowerShell(script);
}

// Skin mode requires a window recreate to detach from the desktop parent;
// the existing setSkinMode() in main.js handles that, so unpin is a no-op
// (the new window is just created without pinning).
async function unpinWindowFromDesktop(/* win */) { /* no-op */ }

// Whether this platform supports skin mode at all. Renderer hides the
// toggle on platforms that return false. Windows: yes.
function supportsSkinMode() { return true; }

// Whether shell.readShortcutLink can be called on this platform. Windows: yes.
function supportsShortcutFiles() { return true; }

module.exports = {
  listPowerActions,
  executePowerAction,
  discoverApps,
  createWindowManager,
  pinWindowToDesktop,
  unpinWindowFromDesktop,
  supportsSkinMode,
  supportsShortcutFiles,
  getWinHwnd,
};
