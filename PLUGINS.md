# Plugin Guide

A plugin is a single JavaScript file (`.js` or `.jsx`) that **default-exports a manifest object**. Drop it into the `plugins/` folder and the dashboard picks it up automatically — no rebuild, no restart.

---

## File layout (pick one)

```
plugins/my-thing.jsx                  # single file
plugins/my-thing/plugin.jsx           # folder form (lets you split into helper files)
plugins/my-thing/index.jsx            # also accepted
```

Folder form is recommended once a plugin grows past ~50 lines or needs assets.

> Filenames or folders starting with `.` or `_` are ignored — handy for drafts.

---

## Minimum viable plugin

```jsx
export default {
  name: 'Hello',
  component: () => <div>hello world</div>,
};
```

That's it. Save it as `plugins/hello.jsx` and it appears in the grid.

---

## The manifest

```js
export default {
  id: 'unique-id',          // optional. defaults to filename/folder name
  name: 'Display Name',     // shown in widget header
  width: 1,                 // initial grid units wide  (1–4, default 1)
  height: 1,                // initial grid units tall  (1–8, default 1)
  component: ({ ... }) => { /* React element */ },
};
```

The grid is 4 columns wide. A 2×2 widget takes a quarter of the screen.

> `width` and `height` are *initial* sizes. Once the user drags the corner handle to resize a widget, that override is saved per-plugin in localStorage and used instead. Dragging the widget header reorders it. Use the **⟲ reset layout** toolbar button to clear all overrides.

---

## The `component` function

Your component is a React function component. **Hooks are passed as props** so you don't need any imports:

```jsx
component: ({ React, useState, useEffect, useMemo, useRef, useCallback }) => {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>clicked {count}×</button>;
}
```

You can also use `React` directly via the prop — e.g. `React.createElement`, `React.Fragment`, etc.

### Why props instead of imports?
Plugins are evaluated at runtime via Babel-standalone. There is no bundler, no `node_modules` resolution. Passing hooks as props keeps plugins zero-dependency and zero-config.

If you need raw `react` / `react-dom`, you *can* do `import React from 'react'` — the loader maps those two names to the host's instances. Anything else will throw.

---

## Styling

The dashboard is **themable**. The user can pick from several themes (retro CRT — the default — amber, cyberpunk, modern dark, clean light, nord, paper) plus a font family (mono / sans / serif) and an optional accent override from the **⚙ settings → Customize** panel. Plugins that read from CSS variables retheme automatically; plugins that hardcode colors or `'JetBrains Mono'` will look out of place on every non-retro theme.

Use these built-in helper classes — they reference the live theme tokens:

| class | what it does |
|---|---|
| `p-row` / `p-col` | flex container, gap 8px |
| `p-mono` | uses `var(--mono)` (mono by default, sans/serif depending on theme) |
| `p-dim` | dim foreground |
| `p-accent` | accent color + glow |
| `p-stat-num` | big accent-colored stat number |
| `p-label` | small uppercase label |
| `p-input` | styled input/textarea |
| `p-btn` | styled button |

CSS variables you can read directly: `var(--bg)`, `var(--bg-elev)`, `var(--fg)`, `var(--fg-dim)`, `var(--fg-bright)`, `var(--accent)`, `var(--accent-warm)`, `var(--danger)`, `var(--border)`, `var(--border-bright)`, `var(--glow)`, `var(--glow-soft)`, `var(--mono)`.

For translucent washes (hover backgrounds, etc.), use `rgba(var(--accent-rgb), 0.08)` rather than `rgba(57, 255, 20, 0.08)` — the `--accent-rgb` triple updates with the theme.

---

## State & persistence

- `useState` works as normal — state lives as long as the widget is mounted.
- For cross-reload persistence, use `localStorage`. **Namespace your keys** to avoid collisions: `localStorage.setItem('plugin:myid:foo', value)`.
- See `plugins/notes/plugin.jsx` and `plugins/todo/plugin.jsx` for the pattern.

---

## Hot reload

- Saving a plugin file re-mounts that widget within ~150ms.
- Adding/removing a file or folder updates the grid live.
- If a plugin throws on load, it renders as a red error widget with the message — fix the file and save, it auto-recovers.
- If a plugin throws *during render*, an error boundary contains it so the rest of the dashboard keeps working.

---

## Host APIs (`window.dashboard.*`)

Plugins run sandboxed in the renderer, but the host exposes a curated set of OS-level APIs through `window.dashboard`. Use these from inside your `component` function.

### `dashboard.fs` — filesystem
```js
await window.dashboard.fs.home()                  // → user home dir
await window.dashboard.fs.list(path)              // → [{ name, path, isDir, isFile, size, mtime }]
await window.dashboard.fs.stat(path)              // → { size, mtime, ctime, isDir, isFile }
await window.dashboard.fs.read(path, encoding?)   // → string (default utf8)
await window.dashboard.fs.write(path, content)    // → true
```

### `dashboard.shell` — shell / process
```js
await window.dashboard.shell.open(target)         // open file/folder with default app
await window.dashboard.shell.openExternal(url)    // open url in default browser
await window.dashboard.shell.reveal(path)         // show in Windows Explorer
await window.dashboard.shell.launch(exe, args)    // spawn process detached
await window.dashboard.shell.getFileIcon(path)    // → base64 PNG data URL (32px)
await window.dashboard.shell.readShortcut(lnk)    // → { target, args, ... } or null
```

### `dashboard.dialog` — native dialogs
```js
await window.dashboard.dialog.openFile({
  title: 'Pick something',
  filters: [{ name: 'Programs', extensions: ['exe', 'lnk'] }],
})  // → absolute path or null
```

### `dashboard.system` — hardware sensors
```js
await window.dashboard.system.stats()
// → { cpu, cpuLoad, mem, gpu, siTemp, lhm, timestamp }
```

### `dashboard.apps` — installed app discovery
```js
await window.dashboard.apps.discover({ refresh?: bool })
// → [{ id, name, target, args, launchPath, iconDataUrl }]
```
Scans both Start Menu folders, resolves `.lnk` files, returns icons. Cached for 10 minutes; pass `{ refresh: true }` to force a rescan.

### Other
```js
window.dashboard.openPluginsFolder()
await window.dashboard.appVersion()
await window.dashboard.appIsPackaged()
```

> ⚠️ **Trust model:** any plugin can read your files, launch any program, and reach the network. Only install plugins you trust. This is a personal tool, not a sandboxed extension store.

## Restrictions

- **No `require('node:fs')`** etc. directly — use the curated APIs above.
- **No npm imports.** Only `'react'` and `'react-dom'` resolve.
- **One default export.** Named exports are ignored.

---

## Asking Claude to build a plugin

Copy-paste this template into a chat:

> Build a dashboard plugin called **`<name>`** that does `<one-sentence behavior>`.
>
> - Width: `<1–4>`  Height: `<1–4>`
> - State persists across reloads: `<yes/no>`
> - Uses the helper classes (`p-mono`, `p-accent`, etc.) for styling
> - Save it to `plugins/<name>/plugin.jsx`
>
> Follow the spec in `PLUGINS.md`.

Claude already knows the spec from this file. Examples:

- *"Build a plugin called `weather` that shows the current temp for a hardcoded lat/lon using open-meteo. Width 2, height 1."*
- *"Build a `pomodoro` plugin: 25-minute timer with start/pause/reset buttons. Width 1, height 1. State does not need to persist."*
- *"Build a `quote` plugin that picks a random quote from a hardcoded array of 20 and rotates every 30 seconds. Width 2, height 1."*

---

## Reference: full annotated plugin

```jsx
// plugins/example/plugin.jsx
//
// id       — stable identifier; if omitted, derived from filename/folder
// name     — shown in the widget header
// width    — 1..4 grid columns (default 1)
// height   — 1..4 grid rows (default 1)
// component — React function component; receives hooks as props

const STORAGE_KEY = 'plugin:example:state';

export default {
  id: 'example',
  name: 'Example',
  width: 2,
  height: 1,
  component: ({ useState, useEffect }) => {
    const [n, setN] = useState(() =>
      Number(localStorage.getItem(STORAGE_KEY)) || 0
    );
    useEffect(() => {
      localStorage.setItem(STORAGE_KEY, String(n));
    }, [n]);
    return (
      <div className="p-col">
        <div className="p-label">counter</div>
        <div className="p-stat-num">{n}</div>
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
