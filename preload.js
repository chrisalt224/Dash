const { contextBridge, ipcRenderer } = require('electron');

// ---------- Sync internals (exposed to main-world storage-mirror.js) ----------
// With contextIsolation: true, a wrapper installed on window.localStorage in
// this preload context doesn't intercept writes from the page world (React,
// plugins, DevTools). So the actual wrapping lives in renderer/storage-mirror.js
// (loaded by index.html in the main world) and calls back here through
// contextBridge to invoke the appropriate IPC channels.

contextBridge.exposeInMainWorld('__dashboardSyncInternal', {
  reportLocalWrite: (event, key, value) => {
    if (!key) return;
    // Activity log (always)
    try { ipcRenderer.invoke('activity:log', 'localStorage', key, value, { event }); } catch {}
    // Sync to remote / fan-out to clients (deny-list applies in main)
    try { ipcRenderer.invoke('sync:local-write', { event, key, value }); } catch {}
  },
  reportLocalClear: () => {
    try { ipcRenderer.invoke('activity:log', 'localStorage', '*', null, { event: 'clear' }); } catch {}
    // Intentionally NOT mirrored to sync — too dangerous to wipe other devices.
  },
  // Seed our current localStorage state to main on startup so the sync
  // manager has a baseline before any writes happen.
  seedSnapshot: (state) => {
    try { ipcRenderer.invoke('sync:seed', state); } catch {}
  },
});

contextBridge.exposeInMainWorld('dashboard', {
  // Plugins
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  readPlugin: (path) => ipcRenderer.invoke('plugins:read', path),
  openPluginsFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  pluginsDirPath: () => ipcRenderer.invoke('plugins:dirPath'),
  onPluginsChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('plugins:changed', handler);
    return () => ipcRenderer.removeListener('plugins:changed', handler);
  },

  // Settings (persisted at the OS level)
  getAutoStart: () => ipcRenderer.invoke('settings:getAutoStart'),
  setAutoStart: (v) => ipcRenderer.invoke('settings:setAutoStart', v),

  // Window controls
  setFullScreen: (v) => ipcRenderer.invoke('window:setFullScreen', v),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('window:setAlwaysOnTop', v),
  isAlwaysOnTop: () => ipcRenderer.invoke('window:isAlwaysOnTop'),
  setSkinMode: (v) => ipcRenderer.invoke('window:setSkinMode', v),
  isSkinMode: () => ipcRenderer.invoke('window:isSkinMode'),
  openDevTools: () => ipcRenderer.invoke('window:openDevTools'),
  reloadWindow: () => ipcRenderer.invoke('window:reload'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onFullScreenChange: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on('window:fullScreenChanged', handler);
    return () => ipcRenderer.removeListener('window:fullScreenChanged', handler);
  },

  // App info
  appVersion: () => ipcRenderer.invoke('app:version'),
  appIsPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  appPlatform: () => ipcRenderer.invoke('app:platform'),

  // Power actions (lock / sleep / shutdown / etc). The renderer asks main
  // for the menu via `list()` so the labels & set of actions match the host OS.
  power: {
    list: () => ipcRenderer.invoke('power:list'),
    execute: (id) => ipcRenderer.invoke('power:execute', id),
  },

  // Auto-update — driven by lib/updater.js (electron-updater).
  // status state values: idle | dev | no-config | checking | available |
  //                      not-available | downloading | downloaded | error
  updates: {
    getStatus: () => ipcRenderer.invoke('updates:status'),
    check:     () => ipcRenderer.invoke('updates:check'),
    install:   () => ipcRenderer.invoke('updates:install'),
    onStatus: (cb) => {
      const handler = (_e, status) => cb(status);
      ipcRenderer.on('updates:status', handler);
      return () => ipcRenderer.removeListener('updates:status', handler);
    },
  },

  // Hardware sensors (CPU, RAM, GPU, temps, fans)
  system: {
    stats: () => ipcRenderer.invoke('system:stats'),
    processes: () => ipcRenderer.invoke('system:processes'),
    killProcess: (pid) => ipcRenderer.invoke('system:killProcess', pid),
    networkStats: (iface) => ipcRenderer.invoke('system:networkStats', iface),
    networkInterfaces: () => ipcRenderer.invoke('system:networkInterfaces'),
    ping: (host) => ipcRenderer.invoke('system:ping', host),
    drives: () => ipcRenderer.invoke('system:drives'),
    battery: () => ipcRenderer.invoke('system:battery'),
  },

  // OS window management — list / focus / close other application windows
  windows: {
    list: () => ipcRenderer.invoke('windows:list'),
    focus: (hwnd) => ipcRenderer.invoke('windows:focus', hwnd),
    close: (hwnd) => ipcRenderer.invoke('windows:close', hwnd),
    minimize: (hwnd) => ipcRenderer.invoke('windows:minimize', hwnd),
  },

  // Browser plugin — session-level controls (cache, cookies, partition setup)
  browser: {
    clearCache: (partition) => ipcRenderer.invoke('browser:clearCache', partition),
    clearStorage: (partition, opts) => ipcRenderer.invoke('browser:clearStorage', partition, opts),
    configurePartition: (partition, ua) => ipcRenderer.invoke('browser:configurePartition', partition, ua),
    getStealthPreloadUrl: () => ipcRenderer.invoke('browser:getStealthPreloadUrl'),
  },

  // PTY (terminal plugin) — node-pty wrapper
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('pty:kill', id),
    onData: (cb) => {
      const handler = (_e, id, data) => cb(id, data);
      ipcRenderer.on('pty:data', handler);
      return () => ipcRenderer.removeListener('pty:data', handler);
    },
    onExit: (cb) => {
      const handler = (_e, id, code, signal) => cb(id, code, signal);
      ipcRenderer.on('pty:exit', handler);
      return () => ipcRenderer.removeListener('pty:exit', handler);
    },
  },

  // Network helper — fetches in main process so requests bypass renderer CORS
  // (RSS feeds rarely send Access-Control-Allow-Origin, etc.)
  net: {
    fetch: (opts) => ipcRenderer.invoke('net:fetch', opts),
  },

  // System clipboard — polled in main so it captures copies from any app
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
    onChange: (cb) => {
      const handler = (_e, text) => cb(text);
      ipcRenderer.on('clipboard:changed', handler);
      return () => ipcRenderer.removeListener('clipboard:changed', handler);
    },
  },

  // Filesystem
  fs: {
    home: () => ipcRenderer.invoke('fs:home'),
    list: (p) => ipcRenderer.invoke('fs:list', p),
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
    read: (p, encoding) => ipcRenderer.invoke('fs:read', p, encoding),
    write: (p, content) => ipcRenderer.invoke('fs:write', p, content),
    mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
    delete: (p) => ipcRenderer.invoke('fs:delete', p),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
  },

  // Shell / process
  shell: {
    open: (target) => ipcRenderer.invoke('shell:open', target),
    reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    launch: (exePath, args) => ipcRenderer.invoke('shell:launch', exePath, args),
    getFileIcon: (p, size) => ipcRenderer.invoke('shell:getFileIcon', p, size),
    readShortcut: (lnkPath) => ipcRenderer.invoke('shell:readShortcut', lnkPath),
  },

  // Native dialogs
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    openDirectory: (options) => ipcRenderer.invoke('dialog:openDirectory', options),
  },

  // Installed app discovery (Start Menu .lnk scan)
  apps: {
    discover: (opts) => ipcRenderer.invoke('apps:discover', opts),
  },

  // Activity — explicit event emitter for plugins that want to emit semantic
  // events ("alarm fired", "pomodoro complete") rather than relying on the
  // automatic localStorage mirror.
  activity: {
    log: (channel, payload, extras) => ipcRenderer.invoke(
      'activity:log',
      'activity',
      channel,
      payload,
      extras && typeof extras === 'object' ? extras : undefined,
    ),
  },

  // Host server (Settings → Host tab)
  host: {
    status:        () => ipcRenderer.invoke('host:status'),
    getConfig:     () => ipcRenderer.invoke('host:getConfig'),
    setConfig:     (patch) => ipcRenderer.invoke('host:setConfig', patch),
    setPassword:   (pw) => ipcRenderer.invoke('host:setPassword', pw),
    clearPassword: () => ipcRenderer.invoke('host:clearPassword'),
    start:         () => ipcRenderer.invoke('host:start'),
    stop:          () => ipcRenderer.invoke('host:stop'),
    tail:          (limit) => ipcRenderer.invoke('host:tail', limit),
    listDays:      () => ipcRenderer.invoke('host:listDays'),
    openLogFolder: () => ipcRenderer.invoke('host:openLogFolder'),
    clearLogs:     () => ipcRenderer.invoke('host:clearLogs'),
    localIps:      () => ipcRenderer.invoke('host:localIps'),
    onEvent: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('activity:event', handler);
      return () => ipcRenderer.removeListener('activity:event', handler);
    },
  },

  // Saved remote servers (client side — used by the Servers plugin)
  // Passwords are stored encrypted in main process; renderer never sees them
  // unless it explicitly asks via getPassword(id).
  servers: {
    list:        () => ipcRenderer.invoke('servers:list'),
    save:        (entry) => ipcRenderer.invoke('servers:save', entry),
    delete:      (id) => ipcRenderer.invoke('servers:delete', id),
    getPassword: (id) => ipcRenderer.invoke('servers:getPassword', id),
  },

  // Multi-device sync (driven by the Servers plugin). Connection is owned
  // by main so it survives plugin remount / minimize.
  sync: {
    connect:    (entry, password) => ipcRenderer.invoke('sync:connect', entry, password),
    disconnect: () => ipcRenderer.invoke('sync:disconnect'),
    status:     () => ipcRenderer.invoke('sync:status'),
    onStatus: (cb) => {
      const handler = (_e, st) => cb(st);
      ipcRenderer.on('sync:status-changed', handler);
      return () => ipcRenderer.removeListener('sync:status-changed', handler);
    },
    onEvent: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('sync:remote-event', handler);
      return () => ipcRenderer.removeListener('sync:remote-event', handler);
    },
  },

  // Central vault — named, shared content folders. When the dashboard is
  // sync-connected to a remote desktop, all calls route through HTTP to the
  // desktop (which owns the files); otherwise they hit a local folder under
  // userData. Plugins should use this for any user content they want shared
  // between devices.
  vault: {
    info:      (name) => ipcRenderer.invoke('vault:info', name),
    list:      (name) => ipcRenderer.invoke('vault:list', name),
    listNotes: (name) => ipcRenderer.invoke('vault:listNotes', name),
    read:      (name, path) => ipcRenderer.invoke('vault:read', name, path),
    write:     (name, path, content) => ipcRenderer.invoke('vault:write', name, path, content),
    mkdir:     (name, path) => ipcRenderer.invoke('vault:mkdir', name, path),
    rename:    (name, from, to) => ipcRenderer.invoke('vault:rename', name, from, to),
    delete:    (name, path) => ipcRenderer.invoke('vault:delete', name, path),
    onChanged: (cb) => {
      const handler = (_e, info) => cb(info);
      ipcRenderer.on('vault:changed', handler);
      return () => ipcRenderer.removeListener('vault:changed', handler);
    },
  },

  // Notes — markdown files on disk; folder is user-configurable
  notes: {
    getDir: () => ipcRenderer.invoke('notes:getDir'),
    getDefaultDir: () => ipcRenderer.invoke('notes:getDefaultDir'),
    setDir: (path) => ipcRenderer.invoke('notes:setDir', path),
    list: () => ipcRenderer.invoke('notes:list'),
    write: (path, body) => ipcRenderer.invoke('notes:write', path, body),
    rename: (from, to) => ipcRenderer.invoke('notes:rename', from, to),
    delete: (path) => ipcRenderer.invoke('notes:delete', path),
    openFolder: () => ipcRenderer.invoke('notes:openFolder'),
    onDirChanged: (cb) => {
      const handler = (_e, dir) => cb(dir);
      ipcRenderer.on('notes:dirChanged', handler);
      return () => ipcRenderer.removeListener('notes:dirChanged', handler);
    },
    onRemoteChange: (cb) => {
      const handler = (_e, info) => cb(info);
      ipcRenderer.on('notes:remoteChange', handler);
      return () => ipcRenderer.removeListener('notes:remoteChange', handler);
    },
  },
});
