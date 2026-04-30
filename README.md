# Dash

A Electron + React dashboard with drag-and-drop JS plugins. Auto-starts at Windows login; supports fullscreen + always-on-top so it can act as a persistent skin layered on top of the normal Windows shell.

## Run in dev mode

```sh
cd dashboard
npm install
npm start
```

## Build a Windows installer

```sh
npm run package
```

Outputs `dist/Dashboard Setup <version>.exe` — a standard NSIS installer. Once installed, the user-editable plugins folder lives at `%APPDATA%/Dashboard/plugins/` (you can find the exact path in Settings → About).

## Global hotkey

`Ctrl+Shift+Q` quits the app from anywhere — including fullscreen + always-on-top. Critical escape hatch.

## Built-in plugins

- **system-stats** — uptime + animated load gauge
- **hardware** — CPU/RAM/GPU usage, temps, fans (LibreHardwareMonitor recommended for full sensor data)
- **launcher** — app tiles auto-discovered from Start Menu, plus user-added apps. Hide unwanted apps; choices persist
- **file-explorer** — browse the filesystem, open files with default apps
- **quick-links** — one-click bookmarks (URLs, folders, files, exes)
- **notes** — persistent scratchpad
- **todo** — checklist with localStorage

Drop new ones into `plugins/` (or `%APPDATA%/Dashboard/plugins/` after install). See [PLUGINS.md](./PLUGINS.md).
