# Plugin Build Prompt

> **How to use:** copy this entire file into a new AI chat. Replace the `BUILD THIS:` block at the bottom with your plugin idea. Output is one ready-to-drop `.jsx` file.

---

You are building a single-file plugin for a modular **Electron + React dashboard**. The dashboard is **themable** — the user can switch between retro-terminal (phosphor green + scanlines, the default), amber CRT, cyberpunk, modern dark, clean light, nord, and paper-with-serif themes, override the accent color, and pick a mono / sans / serif font family. **Your plugin must read all colors and fonts from CSS variables** so it retints automatically when the theme changes. Don't hardcode green, dark backgrounds, or `JetBrains Mono`.

Output **ONE complete `.jsx` file** — no surrounding explanation, no markdown fences. The file goes at `dashboard/plugins/<id>/plugin.jsx` and is hot-reloaded by the host. The user can drag, resize, minimize, hide, and disable any plugin from the grid.

## File contract

```jsx
export default {
  id: 'unique-id',                    // optional; defaults to folder name
  name: 'Display Name',               // shown in widget header
  width: 2,                           // initial grid units 1–4 (default 1)
  height: 2,                          // initial grid units 1–8 (default 1)
  component: ({ React, useState, useEffect, useMemo, useRef, useCallback }) => {
    return <div>...</div>;
  },
};
```

The user can resize past your defaults — your component **must work at any size from 1×1 to 4×8**.

## Hard rules (do NOT break these)

1. **NO `import` statements anywhere.** Babel-standalone runs the file as CommonJS at runtime. Hooks come AS PROPS to your `component` function — destructure them.
2. **NO `confirm()` / `alert()` / `prompt()`.** These corrupt Electron's window focus state on Windows; users can't type in any widget until they minimize/restore. Use inline two-click confirms or custom panels.
3. **NO hardcoded colors or font families.** Use `var(--accent)`, `var(--fg)`, `var(--mono)`, etc. — never `#39ff14`, never `'JetBrains Mono'` literally. The user can re-skin the dashboard at runtime; hardcoded values break theming. (The one allowed exception is the terminal-immersive style below — see its caveats.)
4. **NO direct Node APIs** (`require('fs')`, `process.env`). Use `window.dashboard.*` host APIs.
5. **NO closure capture of state in async callbacks.** Use refs (see Patterns).
6. **NO side effects inside state setter callbacks.** Don't write `setX(prev => { setOther(...); return ... })` — pull `setOther` out into a separate `useEffect`.

## Host APIs — `window.dashboard.*`

All return Promises unless noted. Listeners return an unsubscribe function.

**Filesystem:**
- `fs.home()` → user home dir
- `fs.list(path)` → `[{name, path, isDir, isFile, size, mtime}]`
- `fs.stat(path)` → `{size, mtime, ctime, isDir, isFile}`
- `fs.read(path, encoding?)` → string
- `fs.write(path, content)` → true

**Shell / process:**
- `shell.open(target)` — open file/folder with default app
- `shell.openExternal(url)` — open URL in default browser
- `shell.reveal(path)` — show in Explorer with file selected
- `shell.launch(exe, args)` — spawn process detached
- `shell.getFileIcon(path, size?)` → base64 PNG data URL
- `shell.readShortcut(lnkPath)` → `{target, args, icon, ...}` or null

**Native dialogs:**
- `dialog.openFile({filters})` → abs path or null
- `dialog.openDirectory({defaultPath})` → abs path or null

**Hardware sensors:**
- `system.stats()` → `{cpu, cpuLoad, mem, gpu, siTemp, lhm, timestamp}`

**Installed apps (Start Menu .lnk scan):**
- `apps.discover({refresh?})` → `[{id, name, target, args, launchPath, iconDataUrl}]`

**Notes (markdown files on disk):**
- `notes.getDir()` → current notes folder path
- `notes.list()` → `[{path, body, mtime}]` (path is relative to notes dir)
- `notes.write(relPath, body)` / `notes.rename(from, to)` / `notes.delete(relPath)`
- `notes.openFolder()` — open in Explorer
- `notes.setDir(absPath)` — switch the notes folder
- `notes.onDirChanged(cb)` — subscribe to folder switches

**HTTP:** `fetch()` to any `https://` URL works (CSP allows it). Cache responses in `localStorage` so widgets stay useful offline.

**Persistent state** (not files): `localStorage` with key `plugin:<id>:<thing>:v1`. Bump the version suffix when changing schema.

## Multi-device sync (IMPORTANT — must consider for every new plugin)

The dashboard mirrors `localStorage` and notes between connected devices. Every new plugin's state is **synced by default** unless you add its keys to the deny-list.

When building a new plugin, decide for **each** of its `localStorage` keys:

- **Sync (do nothing — default).** State should appear identically across devices. Use for: user data (todos, alarms, kanban cards), preferences, custom themes, content the user typed.
- **Don't sync (add to deny-list).** State is machine-specific. Use for: file paths, device IDs, hardware selections, terminal session IDs, browser cookies, "current selection" UI state that would be confusing to mirror, anything containing absolute paths from this machine, anything that depends on this machine's installed apps.

**To exclude keys from sync**, add a pattern to the deny-list in `dashboard/sync-manager.js` (`DEFAULT_DENY_PATTERNS`). Use prefixes — e.g. `plugin:my-plugin:tempPath:` covers all versions.

**When you (the AI) build a new plugin, you must explicitly state in the response which keys sync and which don't, and propose deny-list additions for any that shouldn't.** Don't ship a plugin without thinking about this — silent sync of a machine-specific value (a file path, a hardware UUID) leads to broken state on the other device.

Defaults to follow:
- File paths (anything resolved via `dashboard.fs.*` or `dialog.open*`) → don't sync
- Hardware/system data (CPU/GPU/battery/process/network specifics) → don't sync
- Currently-selected device IDs (audio input, webcam, monitor) → don't sync
- Per-machine preferences (window position, "compact view" setting if it depends on screen size) → don't sync
- Saved server lists, credentials, session tokens → don't sync

## Visual tokens — STRICT

CSS variables — reference as `var(--accent)` etc. **Never hardcode the values shown below** — they are the *retro* theme defaults; other themes change them. Reading from the variables is what makes your plugin retheme correctly.

```
--bg              page background          (retro: #0a0e0a)
--bg-elev         widget surface           (retro: #0f1510)
--border          subtle dividers          (retro: #1f2a1f)
--border-bright   visible borders          (retro: #2f4a2f)
--fg              default text             (retro: #c8f0c8)
--fg-dim          secondary, labels        (retro: #6f9a6f)
--fg-bright       emphasized text          (retro: #9cff9c)
--accent          primary accent           (retro: #39ff14 phosphor green)
--accent-rgb      same value as r,g,b      (retro: 57, 255, 20) — use for translucent washes: rgba(var(--accent-rgb), 0.08)
--accent-warm     warnings, amber          (retro: #ffb454)
--danger          errors, destructive      (retro: #ff6b6b)
--glow            short accent text-shadow (some themes set this to `none`)
--glow-soft       soft accent box-shadow   (some themes set this to a 1-2px ring instead)
--mono            font family — may be mono OR sans OR serif depending on theme/font setting
```

For translucent fills, **always** use `rgba(var(--accent-rgb), X)` instead of a hardcoded `rgba(57, 255, 20, X)`. That's how hovers and washes retint when the theme changes.

**Typography:** body 12–13px · labels 10px uppercase letter-spacing 0.18em · stat numbers 24–32px · footer 10–11px.
**Borders:** default `1px solid var(--border-bright)` · hover/focus `border-color: var(--accent)` + `box-shadow: var(--glow-soft)` · errors `1px solid var(--danger)`.
**Radius:** 3–6px inputs/buttons, 6–10px cards. **Important text** gets `text-shadow: var(--glow)`.

**Helper classes** (provided by host stylesheet — use when they fit):
| Class | Effect |
|---|---|
| `p-row` / `p-col` | flex row/col, gap 8px |
| `p-mono` | monospace |
| `p-dim` | dim foreground |
| `p-accent` | accent + glow |
| `p-stat-num` | big green stat number |
| `p-label` | small uppercase label |
| `p-input` | styled input/textarea |
| `p-btn` | styled button |

**Terminal-immersive style** (only when the plugin IS a screen — editors, REPLs, log viewers, retro games — and is *intentionally* always-green regardless of theme): you may opt out of theming and inline the constants below. Document this choice in a comment at the top of the file. **Do NOT use this just because you want a "cool" look** — most plugins should retheme, not opt out.

```js
const TERM_BG = '#050a05';
const TERM_BORDER = '#1a2a1a';
const TERM_GREEN = '#39ff14';
const TERM_GREEN_DIM = '#6f9a6f';
const TERM_GREEN_BRIGHT = '#9cff9c';
const TERM_AMBER = '#ffb454';
const TERM_DANGER = '#ff6b6b';
```

Wrap content in a container with `background: TERM_BG`, `boxShadow: 'inset 0 0 24px rgba(0,0,0,0.55)'`, a `$` prompt-style header prefix, and a blinking `▮` cursor in the footer.

**Themable alternative** (preferred for most "screen-like" plugins): use `var(--bg)` / `var(--accent)` / `var(--fg-bright)` instead of the `TERM_*` constants. The plugin will then look right on amber, modern, paper, etc. as well.

## Patterns

### Standard widget shell
```jsx
<div className="p-col" style={{ height: '100%', gap: 8 }}>
  <div className="p-row">{/* header */}</div>
  <div style={{ flex: 1, overflowY: 'auto' }}>{/* main */}</div>
  <div className="p-row" style={{ fontSize: 10 }}>{/* footer */}</div>
</div>
```

### Persistent state with localStorage
```jsx
const KEY = 'plugin:myid:state:v1';
const [state, setState] = useState(() => {
  try { return JSON.parse(localStorage.getItem(KEY)) || defaults; }
  catch { return defaults; }
});
useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);
```

### Async polling with cleanup
```jsx
useEffect(() => {
  let cancelled = false;
  const tick = async () => {
    try {
      const data = await window.dashboard.system.stats();
      if (!cancelled) setData(data);
    } catch (e) { if (!cancelled) setError(e.message); }
  };
  tick();
  const id = setInterval(tick, 2000);
  return () => { cancelled = true; clearInterval(id); };
}, []);
```

### Refs to avoid stale closures
```jsx
// ❌ stale — `notes` is from the render that registered this handler
const onSave = (text) => setTimeout(() => persist(notes, text), 500);

// ✅ ref always reads latest
const notesRef = useRef(notes);
useEffect(() => { notesRef.current = notes; }, [notes]);
const onSave = (text) => setTimeout(() => persist(notesRef.current, text), 500);
```

### Two-click confirm (replaces native `confirm()`)
```jsx
const [confirmId, setConfirmId] = useState(null);
const tRef = useRef(null);
const handleDelete = (id) => {
  if (confirmId === id) {
    actuallyDelete(id);
    setConfirmId(null);
    if (tRef.current) clearTimeout(tRef.current);
    return;
  }
  setConfirmId(id);
  tRef.current = setTimeout(() => setConfirmId(null), 3000);
};
// Button shows '✓?' in red when armed, '×' otherwise
```

### Inline error banner (replaces `alert()`)
```jsx
{error && (
  <div style={{
    padding: '4px 10px', color: 'var(--danger)',
    border: '1px dashed var(--danger)', borderRadius: 4, fontSize: 11,
  }}>! {error}</div>
)}
// setTimeout(() => setError(null), 4000) to auto-clear
```

### Web Audio for sounds (no asset files needed)
```jsx
let audioCtx = null;
const beep = async (freq, duration) => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square'; // or 'sine' / 'triangle' / 'sawtooth'
  osc.frequency.value = freq;
  const t = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.25, t + 0.005);
  gain.gain.linearRampToValueAtTime(0, t + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
};
// Initialize audioCtx inside a click handler so Chromium's autoplay policy is satisfied
```

### Canvas with smooth animation (games / visualizations)
```jsx
const canvasRef = useRef(null);
const wrapRef = useRef(null);
useEffect(() => {
  const canvas = canvasRef.current, wrap = wrapRef.current;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  let cssW = 0, cssH = 0;

  const resize = () => {
    const r = wrap.getBoundingClientRect();
    cssW = r.width; cssH = r.height;
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  let raf, lastT = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    update(dt); draw(ctx, cssW, cssH);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}, []);
```

For keyboard input: give the canvas `tabIndex={0}` and listen for `keydown`/`keyup` on it (NOT on `window`, or you'll capture keys meant for other widgets). Add `cursor: pointer` and an `onClick` that focuses it.

## Reference plugin (study this structure)

```jsx
// plugins/example-counter/plugin.jsx
const KEY = 'plugin:example-counter:value:v1';

export default {
  id: 'example-counter',
  name: 'Counter',
  width: 1,
  height: 1,
  component: ({ useState, useEffect }) => {
    const [n, setN] = useState(() => {
      const raw = localStorage.getItem(KEY);
      return raw == null ? 0 : Number(raw);
    });
    useEffect(() => { localStorage.setItem(KEY, String(n)); }, [n]);
    return (
      <div className="p-col" style={{ height: '100%', justifyContent: 'space-between' }}>
        <div>
          <div className="p-label">count</div>
          <div className="p-stat-num">{n}</div>
        </div>
        <div className="p-row">
          <button className="p-btn" onClick={() => setN(n - 1)}>−</button>
          <button className="p-btn" onClick={() => setN(n + 1)}>+</button>
          <button className="p-btn" onClick={() => setN(0)}>reset</button>
        </div>
      </div>
    );
  },
};
```

## Output checklist

- [ ] One file, default-exported manifest object
- [ ] No `import` statements
- [ ] Hooks destructured from `component` props
- [ ] Font family from `var(--mono)` (don't assume monospace — themes can swap to sans/serif)
- [ ] All colors from CSS variables — including translucent fills via `rgba(var(--accent-rgb), X)`. Hardcoded hex only allowed in opt-out terminal-immersive plugins, with a comment explaining why
- [ ] Works at sizes 1×1 through 4×8
- [ ] All state in localStorage with `plugin:<id>:` prefix OR uses host disk APIs
- [ ] No `alert()`, `confirm()`, `prompt()`
- [ ] Async work uses cleanup (`cancelled` flag, `clearInterval`, `cancelAnimationFrame`)
- [ ] Refs for state read in async callbacks
- [ ] Errors shown inline in the widget

---

## BUILD THIS:

> *(replace this line with your plugin description — name, what it does, ideal size, any specific behavior. example: "Build `weather` — fetches Open-Meteo for hardcoded lat 40.7 lon -74, shows current temp + condition, polls every 10 minutes, caches offline. Width 2 height 1.")*
