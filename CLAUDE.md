# CLAUDE.md — Dashboard project notes

> Long-running personal project. This file is a brain-dump for future Claude
> sessions so we don't have to re-derive context every time. Keep it terse,
> update it when conventions change.

## What this is

Modular Electron + React dashboard. Drop-in JS plugins (no rebuild needed).
Owner: **chrisalt224** (Eric).

- Repo on GitHub: <https://github.com/chrisalt224/Dash> (note the capital D)
- Local working copy on Eric's Windows box: `C:\Users\Eric\Desktop\Claude\dashboard\`
- Local **git clone** of the GitHub repo: `C:\Users\Eric\Documents\Dash\`
  (the `Desktop\Claude\dashboard` folder is NOT a git checkout — Eric copies
  files from there into `Documents\Dash\` then commits + pushes)
- Linux dev box (Fedora) clone: `~/Downloads/dashboard/`

## Tech stack at a glance

- Electron 33 + React 18 (no bundler — Babel-standalone transforms plugin source at runtime)
- electron-builder 25 for packaging
- electron-updater 6 for auto-update (publishes to GitHub Releases)
- Native deps: `systeminformation`, `tesseract.js`, optional `node-pty`
- Cross-platform: lib/platform-{win32,darwin,linux}.js — power actions,
  app discovery, window manager, skin-mode pin

## Grid system (current as of v3.9.x)

- **6 columns** wide, gap 0, padding 18×22
- **Square cells** — row height set live by JS ResizeObserver to match cellW
  (CSS var `--cell-h` on `<body>`)
- Constants in `renderer/app.js` top: `GRID_COLS=6`, `GRID_GAP=0`,
  `MIN_W=1, MAX_W=6`, `MIN_H=1, MAX_H=12`
- Plugins declare `width: 1–6, height: 1–12` in their manifest
- Resize/drag math reads cellH from cellW (square assumption); the older
  `CELL_HEIGHT=200` constant is fallback-only

## Settings architecture

- Renderer-side: `dashboard:settings:v1` localStorage key holds the full
  settings object (`DEFAULT_SETTINGS` in `renderer/app.js` top)
- New defaults override old saved values only on truly fresh installs —
  existing users keep whatever they had saved (this is intentional)
- Settings panel is a Discord-style sidebar+content overlay; categories are
  defined in `SETTINGS_CATEGORIES` array
- Window/auto-start state is in `userData/window-state.json`, managed by
  `seedFirstRunDefaultsIfNeeded()` in `main.js`

### First-run-only defaults

- skin mode: off
- gridDotPx: 0 (snap dots hidden)
- greetingEnabled: true, greetingAnimation: 'float'

## Cross-platform notes

- Skin mode (Win32 wallpaper-pin) only works on Windows; macOS approximates
  via `setAlwaysOnTop(true, 'desktop')`; Linux uses `_NET_WM_WINDOW_TYPE_DESKTOP`
  via xprop (X11 only)
- Window manager (windows:list/focus/close): wmctrl/xdotool on Linux,
  AppleScript on macOS, PowerShell+P/Invoke on Windows
- Linux runtime deps: `dnf install wmctrl xdotool`. xprop usually preinstalled.
- macOS: AppleScript window-manager needs Accessibility permission first run

## Release workflow

### The setup (already done)

- `.github/workflows/release.yml` runs on tag push `v*`
- Builds Linux/Win/Mac in parallel, uploads to a **draft** release
- Uses auto-provisioned `GITHUB_TOKEN` (no PAT needed) — repo Actions
  permissions must be set to "Read and write"
- `package.json` `build.publish` is configured: github / chrisalt224 / Dash

### To cut a release

```bash
# 1. Eric edits files in C:\Users\Eric\Desktop\Claude\dashboard\
# 2. He copies the changed files into C:\Users\Eric\Documents\Dash\
#    Easiest: robocopy "C:\Users\Eric\Desktop\Claude\dashboard" .
#             /E /XD node_modules dist build .git out
# 3. From inside C:\Users\Eric\Documents\Dash\:
git status                    # confirm what changed
git add -A
git commit -m "vX.Y.Z: <what>"
git tag vX.Y.Z                # MUST match version in package.json exactly
git push origin main --tags
```

Then watch <https://github.com/chrisalt224/Dash/actions> until the three jobs
go green, open <https://github.com/chrisalt224/Dash/releases>, find the new
draft, click **Publish release**. Done.

### Common build failures + fixes

- `electron-updater not installed` in packaged app — forgot `npm install`
  after we added the dep; the dep needs to be in `node_modules` at build time
- Linux job red, "image must be at least 256x256" — `build/icon.png` missing.
  The workflow auto-generates it via `convert build/icon.ico[-1] -resize 512x512`
  in the Linux job (imagemagick step).
- Linux deb job red, "Please specify author 'email'" — `package.json` `author`
  field must have `email` set. Currently set.
- Windows installs that 404 on `latest.yml` — release is still a draft.
  Click Publish.

### Linux distribution caveats

- Auto-update only works for **AppImage** users (electron-updater can't apply
  `.deb` / `.rpm` updates — those are package-manager territory)
- Recommend AppImage for Linux users; deb/rpm are convenience-only
- macOS auto-update requires code signing + notarization; without an Apple
  Developer cert, .dmg installs but won't self-update

## Key files

| File | Purpose |
|---|---|
| `main.js` | Electron main process, all IPC handlers |
| `preload.js` | contextBridge surface — `window.dashboard.*` API |
| `renderer/app.js` | The whole UI (single file, ~3000 lines) |
| `renderer/styles.css` | All CSS, including theme tokens |
| `lib/platform.js` | Platform dispatcher (win32/darwin/linux) |
| `lib/updater.js` | electron-updater wrapper + IPC |
| `lib/platform-*.js` | Per-OS implementations |
| `activity-server.js` | Host server (multi-device sync) |
| `sync-manager.js` | localStorage + notes mirror; deny-list lives here |
| `vault-manager.js` | Vault folders for plugins to share content |
| `PLUGINS.md` | Plugin author guide |
| `PLUGIN_PROMPT.md` | AI-friendly plugin builder prompt |
| `.github/workflows/release.yml` | CI pipeline for releases |

## Conventions to remember

- Don't reproduce ANY hardcoded colors in plugin code — always use CSS vars
  (`var(--accent)`, `rgba(var(--accent-rgb), 0.x)` for translucent fills)
- Plugins must work at any size from 1×1 to 6×12 (cells are square)
- `localStorage` keys for plugins use `plugin:<id>:<thing>:v<n>` prefix;
  schema bumps go in the version suffix
- Saved server credentials live in `userData/saved-servers.bin` (encrypted via
  Electron `safeStorage`) — wiped on first run via
  `seedFirstRunDefaultsIfNeeded()` so fresh installs never inherit them
- Activity logger wraps every `ipcMain.handle`; chatty/sensitive channels are
  in the `IPC_NOLOG` set in `main.js`

## Things Eric tends to ask for

- "Bump version to X.Y.Z" — edit both `package.json` and `package-lock.json`
- "Make a setting for X" — add to `DEFAULT_SETTINGS`, add a Toggle/Slider/Picker
  in the matching `SETTINGS_CATEGORIES` entry, thread the prop through
  `e(SettingsPanel, { ... })` invocation, and apply via a `useEffect` that
  sets a CSS variable on `<body>` (this is the established pattern for theme,
  font, snap dots, greeting scale, etc.)
- "Add an animation" — define a CSS keyframe in `styles.css`, add a class
  selector, expose a Picker option in the Display tab. The greeting animations
  pattern in `.greeting-anim-*` is a good reference.
- "Migrate existing user state on a setting change" — DON'T flip saved values
  silently. Add a one-time migration keyed off a stored schema-version field
  if you really need to.

## Don't break

- `firstRunSeeded` marker in `window-state.json` — guards skin-mode + saved-
  servers wipe
- The localStorage sync deny-list in `sync-manager.js` — adding a new plugin
  with machine-specific state without updating the deny-list will silently
  push that state to other devices
- `sessionGreeting` is intentionally `useState` (not persisted) — it picks a
  new random greeting at every launch, that's the feature
- Resize math in `onResizeStart` and `onHeaderMouseDown` (drag) reads
  cellWidth from the live grid rect, not the constant — keep it that way
- `GRID_COLS` change requires re-checking every place it's used (search for
  `GRID_COLS` and `MAX_W`)
