(function () {
  const { useState, useEffect, useMemo, useRef, useCallback } = React;
  const e = React.createElement;

  // Must match CSS values in styles.css
  const GRID_COLS = 4;
  const CELL_HEIGHT = 200;
  const GRID_GAP = 14;
  const MIN_W = 1, MAX_W = GRID_COLS;
  const MIN_H = 1, MAX_H = 8;

  const LAYOUT_KEY = 'dashboard:layout:v1';
  const SETTINGS_KEY = 'dashboard:settings:v1';
  const DISABLED_KEY = 'dashboard:disabledPlugins:v1';
  const MINIMIZED_KEY = 'dashboard:minimized:v1';
  // First-run sentinel — set once after the very first launch so we never
  // re-apply the install-time defaults on subsequent runs.
  const FIRST_RUN_KEY = 'dashboard:firstRunComplete:v1';
  // Two-step plugin-disable on first run: we set this flag synchronously
  // before skin-mode triggers a window recreate, then the next renderer
  // (or the same one, if plugins load fast enough) drains it once the
  // plugin list is available and disables all loaded plugins in bulk.
  const PENDING_DISABLE_ALL_KEY = 'dashboard:pendingDisableAllPlugins:v1';
  const DEFAULT_SETTINGS = {
    scanlines: true,
    clock24h: true,
    theme: 'retro',     // retro | amber | cyber | modern | clean | nord | paper | custom:<id>
    font: 'auto',       // auto | mono | sans | serif  (auto = use the theme's default)
    accent: null,       // optional hex — overrides theme accent
    bg: null,           // optional hex — overrides theme background
    fg: null,           // optional hex — overrides theme foreground
    greeting: '',           // shown large in the empty grid; blank = no text shown
    greetingEnabled: false, // master toggle — off by default
  };
  const CUSTOM_THEMES_KEY = 'dashboard:customThemes:v1';
  const MAX_CUSTOM_THEMES = 3;

  // Theme catalogue — used to render the picker and for swatch previews.
  // `bg` / `accent` / `fg` mirror the CSS so the color pickers know each theme's defaults.
  // The CSS in styles.css is the source of truth for what each theme actually does.
  const THEMES = [
    { id: 'retro',  name: 'Retro CRT', hint: 'phosphor green · scanlines',  bg: '#0a0e0a', accent: '#39ff14', fg: '#c8f0c8' },
    { id: 'amber',  name: 'Amber CRT', hint: 'orange phosphor · scanlines', bg: '#0d0a05', accent: '#ffb454', fg: '#f0d8a8' },
    { id: 'cyber',  name: 'Cyberpunk', hint: 'magenta + cyan · scanlines',  bg: '#0a0612', accent: '#ff2bd6', fg: '#e8c8ff' },
    { id: 'modern', name: 'Modern',    hint: 'clean dark · sans-serif',     bg: '#0f1115', accent: '#6ea8fe', fg: '#d8dde8' },
    { id: 'clean',  name: 'Clean',     hint: 'minimal light',               bg: '#fafafa', accent: '#2563eb', fg: '#18181b' },
    { id: 'nord',   name: 'Nord',      hint: 'cool blue-gray',              bg: '#2e3440', accent: '#88c0d0', fg: '#e5e9f0' },
    { id: 'paper',  name: 'Paper',     hint: 'warm light · serif',          bg: '#f4ecd8', accent: '#b65c00', fg: '#3a3226' },
  ];

  function hexToRgbTriple(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }

  // Shift a hex color toward white (positive amount) or black (negative amount).
  // Used to derive --bg-elev / --border / --border-bright from an overridden --bg
  // so widget surfaces and dividers stay distinguishable from the page background.
  function shadeHex(hex, amount) {
    const m = (hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return hex;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    // Light bg → push darker for "elevated" surfaces; dark bg → push lighter.
    const dir = lum > 0.5 ? -1 : 1;
    const d = amount * dir;
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v + d)));
    const nr = clamp(r), ng = clamp(g), nb = clamp(b);
    return '#' + [nr, ng, nb].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function loadCustomThemes() {
    try {
      const arr = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)) || [];
      return Array.isArray(arr) ? arr.slice(0, MAX_CUSTOM_THEMES) : [];
    } catch { return []; }
  }
  function saveCustomThemes(arr) {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(arr.slice(0, MAX_CUSTOM_THEMES)));
  }
  // These are now baked into the app as the SysDock — skip loading them as plugins
  const BUILTIN_PLUGIN_IDS = new Set(['taskbar', 'launcher', 'lock-controls']);

  function loadMinimized() {
    try {
      const arr = JSON.parse(localStorage.getItem(MINIMIZED_KEY)) || [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  }
  function saveMinimized(set) {
    localStorage.setItem(MINIMIZED_KEY, JSON.stringify([...set]));
  }

  function loadDisabled() {
    try {
      const arr = JSON.parse(localStorage.getItem(DISABLED_KEY)) || [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  }
  function saveDisabled(set) {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...set]));
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      return { ...DEFAULT_SETTINGS, ...saved };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  // ---------- Plugin loader ----------
  function compilePlugin(source, filename) {
    const transformed = Babel.transform(source, {
      filename,
      presets: [
        ['env', { modules: 'commonjs', targets: { esmodules: true } }],
        ['react', { runtime: 'classic' }],
      ],
    }).code;

    const moduleObj = { exports: {} };
    const requireShim = (name) => {
      if (name === 'react') return React;
      if (name === 'react-dom') return ReactDOM;
      throw new Error(`Plugin tried to require unknown module: ${name}`);
    };

    // eslint-disable-next-line no-new-func
    const fn = new Function('module', 'exports', 'require', 'React', transformed);
    fn(moduleObj, moduleObj.exports, requireShim, React);

    const mod = moduleObj.exports;
    const manifest = mod.default || mod;
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Plugin must export a default object');
    }
    if (!manifest.component || typeof manifest.component !== 'function') {
      throw new Error('Plugin manifest is missing a `component` function');
    }
    return manifest;
  }

  async function loadAllPlugins() {
    const list = await window.dashboard.listPlugins();
    const out = [];
    for (const item of list) {
      try {
        const src = await window.dashboard.readPlugin(item.path);
        const manifest = compilePlugin(src, item.path);
        if (BUILTIN_PLUGIN_IDS.has(manifest.id || item.id)) continue;
        out.push({
          id: manifest.id || item.id,
          name: manifest.name || item.id,
          defaultW: clampInt(manifest.width, MIN_W, MAX_W, 1),
          defaultH: clampInt(manifest.height, MIN_H, MAX_H, 1),
          component: manifest.component,
          error: null,
        });
      } catch (err) {
        out.push({
          id: item.id, name: item.id, defaultW: 1, defaultH: 1,
          component: null, error: err.message || String(err),
        });
      }
    }
    return out;
  }

  function clampInt(v, min, max, dflt) {
    const n = Number.isFinite(v) ? Math.floor(v) : dflt;
    return Math.max(min, Math.min(max, n));
  }

  // ---------- Layout state ----------
  // Shape: { [pluginId]: { col: 0..3, row: 0..3, width: 1..4, height: 1..8 } }
  //
  // 4×4 = 16 snap zones. Each widget's top-left lives at one zone; the
  // widget extends down/right by its width/height. Multiple widgets cannot
  // occupy overlapping cells — collisions during drag swap places. Layout
  // syncs across devices since zones are proportional, not pixel-based.

  function loadLayout() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; }
    catch { return {}; }
  }
  function saveLayout(layout) {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }

  // Plugins listed here get auto-flowed first, so on a fresh install (or any
  // time a new plugin id appears) they end up at the top of the grid before
  // alphabetically-earlier neighbors get a chance to fill the prime real
  // estate. Order in this array = placement order.
  const PLUGIN_PLACEMENT_PRIORITY = ['servers'];

  function placementPriority(id) {
    const idx = PLUGIN_PLACEMENT_PRIORITY.indexOf(id);
    return idx === -1 ? 1000 : idx;
  }

  // Greedy auto-flow placement. Walks row-major, picks first free spot that
  // fits the item's width. Used to migrate `order`-based entries and to
  // place newly-seen plugins.
  function placeNext(occupied, w, h) {
    const fits = (col, row) => {
      if (col + w > GRID_COLS) return false;
      for (const p of occupied) {
        if (col < p.col + p.width && col + w > p.col &&
            row < p.row + p.height && row + h > p.row) return false;
      }
      return true;
    };
    for (let row = 0; row < 200; row++) {
      for (let col = 0; col + w <= GRID_COLS; col++) {
        if (fits(col, row)) return { col, row };
      }
    }
    return { col: 0, row: 0 };
  }

  // True if a placement would overlap any of the others in `entries`
  // (an array of {id, col, row, width, height}). Optionally exclude an id.
  function overlapsAny(col, row, w, h, entries, excludeId) {
    for (const p of entries) {
      if (excludeId && p.id === excludeId) continue;
      if (col < p.col + p.width && col + w > p.col &&
          row < p.row + p.height && row + h > p.row) return p;
    }
    return null;
  }

  function useLayout(plugins) {
    const [layout, setLayout] = useState(loadLayout);

    // Backfill / migrate entries. Old entries used `order`; we convert by
    // running auto-flow. New plugins (no entry) also get auto-flowed in.
    useEffect(() => {
      setLayout((prev) => {
        const next = { ...prev };
        // Detect any entries that need migration (old format) — entries
        // without col/row but with order.
        const oldEntries = [];
        const placedEntries = []; // already in new format
        for (const p of plugins) {
          const e = next[p.id];
          if (!e) continue;
          if (Number.isInteger(e.col) && Number.isInteger(e.row)) {
            placedEntries.push({ id: p.id, col: e.col, row: e.row, width: e.width || p.defaultW || 1, height: e.height || p.defaultH || 1 });
          } else {
            oldEntries.push({ id: p.id, order: e.order ?? 1e9, width: e.width || p.defaultW || 1, height: e.height || p.defaultH || 1 });
          }
        }

        let changed = false;

        // Migrate old order-based entries to col/row by auto-flow ordered by `order`.
        oldEntries.sort((a, b) => a.order - b.order);
        for (const o of oldEntries) {
          const w = Math.min(GRID_COLS, o.width);
          const { col, row } = placeNext(placedEntries, w, o.height);
          placedEntries.push({ id: o.id, col, row, width: w, height: o.height });
          next[o.id] = { col, row, width: w, height: o.height };
          changed = true;
        }

        // Add brand-new plugins (no entry at all yet).
        // Plugins listed in PLUGIN_PLACEMENT_PRIORITY are placed first so
        // they always end up near the top of the grid on a fresh install.
        // Everything else falls back to its natural (alphabetical) order
        // from listPlugins().
        const newPlugins = plugins
          .filter((p) => !next[p.id])
          .slice()
          .sort((a, b) => placementPriority(a.id) - placementPriority(b.id));
        for (const p of newPlugins) {
          const w = Math.min(GRID_COLS, p.defaultW || 1);
          const h = p.defaultH || 1;
          const { col, row } = placeNext(placedEntries, w, h);
          placedEntries.push({ id: p.id, col, row, width: w, height: h });
          next[p.id] = { col, row, width: w, height: h };
          changed = true;
        }

        if (changed) saveLayout(next);
        return changed ? next : prev;
      });
    }, [plugins]);

    const update = useCallback((updater) => {
      setLayout((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        saveLayout(next);
        return next;
      });
    }, []);

    // Re-read layout from localStorage when a remote sync changes it.
    useEffect(() => {
      const onRemote = (ev) => {
        const k = ev && ev.detail && ev.detail.key;
        if (k === LAYOUT_KEY) setLayout(loadLayout());
      };
      window.addEventListener('dashboard:remote-sync', onRemote);
      return () => window.removeEventListener('dashboard:remote-sync', onRemote);
    }, []);

    const reset = useCallback(() => {
      localStorage.removeItem(LAYOUT_KEY);
      setLayout({});
    }, []);

    return [layout, update, reset];
  }

  // ---------- Clock ----------
  function useNow(intervalMs = 1000) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
      const id = setInterval(() => setNow(new Date()), intervalMs);
      return () => clearInterval(id);
    }, [intervalMs]);
    return now;
  }

  function Clock({ hour12 }) {
    const now = useNow(1000);
    const time = now.toLocaleTimeString('en-US', { hour12: !!hour12 });
    const date = now.toLocaleDateString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: '2-digit',
    });
    return e('div', { className: 'clock' },
      e('div', { className: 'clock-time' }, time),
      e('div', { className: 'clock-date' }, date),
    );
  }

  // ---------- Settings UI primitives ----------
  function Toggle({ label, value, onChange, hint }) {
    return e('label', { className: 'set-row' },
      e('span', { className: 'set-label' },
        label,
        hint ? e('span', { className: 'set-hint' }, hint) : null,
      ),
      e('button', {
        type: 'button',
        className: 'switch' + (value ? ' on' : ''),
        role: 'switch',
        'aria-checked': !!value,
        onClick: () => onChange(!value),
      }, e('span', { className: 'switch-knob' })),
    );
  }

  function Section({ title, children }) {
    return e('section', { className: 'set-section' },
      e('h3', { className: 'set-title' }, title),
      e('div', { className: 'set-body' }, children),
    );
  }

  function KV({ label, value }) {
    return e('div', { className: 'set-kv' },
      e('span', { className: 'set-kv-label' }, label),
      e('span', { className: 'set-kv-value' }, value),
    );
  }

  function PluginsSection({ plugins, disabledIds, onTogglePluginEnabled }) {
    const FKEY  = 'dashboard:pluginFolders:v1';
    const FMKEY = 'dashboard:pluginFolderMap:v1';
    const FCKEY = 'dashboard:pluginFoldersCollapsed:v1';
    const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

    const [query, setQuery]       = useState('');
    const [folders, setFolders]   = useState(() => lsGet(FKEY, []));
    const [folderMap, setFolderMap] = useState(() => lsGet(FMKEY, {}));
    const [collapsed, setCollapsed] = useState(() => new Set(lsGet(FCKEY, [])));
    const [editingId, setEditingId] = useState(null);
    const [editName, setEditName]   = useState('');

    const saveFolders   = v => { setFolders(v);   localStorage.setItem(FKEY,  JSON.stringify(v)); };
    const saveFolderMap = v => { setFolderMap(v); localStorage.setItem(FMKEY, JSON.stringify(v)); };
    const saveCollapsed = v => { setCollapsed(v); localStorage.setItem(FCKEY, JSON.stringify([...v])); };

    // Folders sync across devices via the localStorage mirror. When a remote
    // device updates one of our keys, re-read it so the UI reflects the
    // change without needing a remount.
    useEffect(() => {
      const onRemote = (ev) => {
        const k = ev && ev.detail && ev.detail.key;
        if (k === FKEY)        setFolders(lsGet(FKEY, []));
        else if (k === FMKEY)  setFolderMap(lsGet(FMKEY, {}));
        else if (k === FCKEY)  setCollapsed(new Set(lsGet(FCKEY, [])));
      };
      window.addEventListener('dashboard:remote-sync', onRemote);
      return () => window.removeEventListener('dashboard:remote-sync', onRemote);
    }, []);

    const addFolder = () => {
      const id = 'f:' + Date.now();
      saveFolders([...folders, { id, name: 'New folder' }]);
      setEditingId(id);
      setEditName('New folder');
    };

    const startRename = (id) => {
      const f = folders.find(x => x.id === id);
      if (!f) return;
      setEditingId(id);
      setEditName(f.name);
    };

    const commitRename = (id) => {
      const name = editName.trim();
      if (name) saveFolders(folders.map(f => f.id === id ? { ...f, name } : f));
      setEditingId(null);
    };

    const deleteFolder = (id) => {
      saveFolders(folders.filter(f => f.id !== id));
      const next = { ...folderMap };
      Object.keys(next).forEach(pid => { if (next[pid] === id) delete next[pid]; });
      saveFolderMap(next);
      const c = new Set(collapsed); c.delete(id); saveCollapsed(c);
    };

    const movePlugin = (pluginId, folderId) => {
      const next = { ...folderMap };
      if (!folderId) delete next[pluginId];
      else next[pluginId] = folderId;
      saveFolderMap(next);
    };

    const toggleCollapsed = (id) => {
      const next = new Set(collapsed);
      next.has(id) ? next.delete(id) : next.add(id);
      saveCollapsed(next);
    };

    const list    = plugins || [];
    const total   = list.length;
    const enabled = total - (disabledIds ? disabledIds.size : 0);
    const q       = query.trim().toLowerCase();
    const hasFolders = folders.length > 0;

    const filtered = q
      ? list.filter(p =>
          (p.name || '').toLowerCase().includes(q) ||
          (p.id || '').toLowerCase().includes(q))
      : null;

    const renderPluginRow = (p) => e('div', { key: p.id, className: 'plugin-row' },
      e(Toggle, {
        label: p.name || p.id,
        hint: (p.error ? '⚠ load error · ' : '') + p.id,
        value: !(disabledIds && disabledIds.has(p.id)),
        onChange: () => onTogglePluginEnabled(p.id),
      }),
      hasFolders && !q && e('select', {
        className: 'plugin-folder-select',
        value: folderMap[p.id] || '',
        onChange: ev => movePlugin(p.id, ev.target.value),
        title: 'move to folder',
      },
        e('option', { value: '' }, '📁 ungrouped'),
        folders.map(f => e('option', { key: f.id, value: f.id }, '📁 ' + f.name)),
      ),
    );

    const renderFolder = (f) => {
      const members = list.filter(p => folderMap[p.id] === f.id);
      const isOpen  = !collapsed.has(f.id);
      const editing = editingId === f.id;
      return e('div', { key: f.id, className: 'folder-section' },
        e('div', { className: 'folder-header', onClick: () => !editing && toggleCollapsed(f.id) },
          e('span', { className: 'folder-chevron' + (isOpen ? ' open' : '') }, '▶'),
          editing
            ? e('input', {
                className: 'folder-name-input',
                value: editName,
                autoFocus: true,
                onChange: ev => setEditName(ev.target.value),
                onBlur: () => commitRename(f.id),
                onKeyDown: ev => {
                  if (ev.key === 'Enter')  { ev.preventDefault(); commitRename(f.id); }
                  if (ev.key === 'Escape') setEditingId(null);
                },
                onClick: ev => ev.stopPropagation(),
              })
            : e('span', { className: 'folder-name' }, '📁 ' + f.name),
          e('span', { className: 'folder-count' }, members.length + (members.length === 1 ? ' plugin' : ' plugins')),
          e('div', { className: 'folder-actions', onClick: ev => ev.stopPropagation() },
            e('button', { className: 'folder-btn', onClick: () => startRename(f.id), title: 'rename' }, '✏'),
            e('button', { className: 'folder-btn danger', onClick: () => deleteFolder(f.id), title: 'delete folder — plugins move back to ungrouped' }, '×'),
          ),
        ),
        isOpen && e('div', { className: 'folder-body' },
          members.length === 0
            ? e('div', { className: 'set-hint', style: { padding: '8px 14px', fontStyle: 'italic' } }, 'empty — assign plugins using the 📁 dropdown')
            : members.map(renderPluginRow),
        ),
      );
    };

    const renderUngrouped = () => {
      const members = list.filter(p => !folderMap[p.id]);
      const isOpen  = !collapsed.has('__ungrouped__');
      return e('div', { key: '__ungrouped__', className: 'folder-section' },
        e('div', { className: 'folder-header', onClick: () => toggleCollapsed('__ungrouped__') },
          e('span', { className: 'folder-chevron' + (isOpen ? ' open' : '') }, '▶'),
          e('span', { className: 'folder-name ungrouped' }, 'ungrouped'),
          e('span', { className: 'folder-count' }, members.length + (members.length === 1 ? ' plugin' : ' plugins')),
        ),
        isOpen && e('div', { className: 'folder-body' },
          members.length === 0
            ? e('div', { className: 'set-hint', style: { padding: '8px 14px', fontStyle: 'italic' } }, 'all plugins are in folders ✓')
            : members.map(renderPluginRow),
        ),
      );
    };

    return e(Section, { title: `▸ PLUGINS  (${enabled} on / ${total} total)` },
      total === 0
        ? e('div', { className: 'set-hint' }, 'no plugins detected')
        : e(React.Fragment, null,
            e('input', {
              type: 'text',
              value: query,
              onChange: ev => setQuery(ev.target.value),
              placeholder: 'search plugins...',
              spellCheck: false,
              className: 'p-input',
              style: { width: '100%', fontSize: 12, marginBottom: 8 },
            }),
            !q && e('div', { className: 'folder-bar' },
              e('span', { className: 'set-hint' },
                hasFolders
                  ? `${folders.length} folder${folders.length !== 1 ? 's' : ''}`
                  : 'no folders yet'),
              e('button', {
                className: 'btn',
                onClick: addFolder,
                style: { fontSize: 10, padding: '3px 10px' },
                title: 'create a new plugin folder',
              }, '+ new folder'),
            ),
            e('div', { className: 'plugin-list' + (hasFolders && !q ? ' folders-mode' : '') },
              q
                ? (filtered.length === 0
                    ? e('div', { className: 'set-hint', style: { padding: '12px 8px' } }, `no plugins match "${q}"`)
                    : filtered.map(renderPluginRow))
                : hasFolders
                  ? [...folders.map(renderFolder), renderUngrouped()]
                  : list.map(renderPluginRow),
            ),
          ),
    );
  }

  function ColorPicker({ label, value, themeDefault, onChange }) {
    // The swatch displays the user's override when set, otherwise the theme's
    // own value — so opening the picker on Modern shows blue, on Paper shows
    // burnt-orange, etc. (rather than always defaulting to retro green).
    const live = value || themeDefault;
    return e('div', { className: 'p-col', style: { gap: 4, flex: 1, minWidth: 0 } },
      e('div', { className: 'set-hint' }, label),
      e('div', { className: 'accent-row', style: { gap: 6 } },
        e('input', {
          type: 'color',
          value: live,
          onChange: ev => onChange(ev.target.value),
          title: `pick a custom ${label}`,
        }),
        e('span', {
          className: 'p-mono',
          style: { fontSize: 10, color: 'var(--fg-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
        }, value ? value : `${themeDefault}`),
        value && e('button', {
          className: 'p-btn',
          style: { fontSize: 9, padding: '2px 6px' },
          onClick: () => onChange(null),
          title: 'reset to theme default',
        }, '⟲'),
      ),
    );
  }

  function CustomizeSection(props) {
    const {
      theme, onTheme, font, onFont,
      accent, onAccent, bg, onBg, fg, onFg,
      customThemes, onSaveCustom, onApplyCustom, onDeleteCustom,
    } = props;
    const active = THEMES.find(t => t.id === theme) || THEMES[0];

    const [namingOpen, setNamingOpen] = useState(false);
    const [draftName, setDraftName] = useState('');
    const slotsLeft = MAX_CUSTOM_THEMES - customThemes.length;

    const startSave = () => {
      if (slotsLeft <= 0) return;
      setDraftName(`Custom ${customThemes.length + 1}`);
      setNamingOpen(true);
    };
    const commitSave = () => {
      const name = draftName.trim().slice(0, 24);
      if (!name) { setNamingOpen(false); return; }
      onSaveCustom(name);
      setNamingOpen(false);
    };

    return e(Section, { title: '▸ CUSTOMIZE' },
      e('div', { className: 'set-hint', style: { marginBottom: 8 } }, 'theme'),
      e('div', { className: 'theme-grid' },
        THEMES.map(t => e('button', {
          key: t.id,
          type: 'button',
          className: 'theme-tile' + (theme === t.id ? ' active' : ''),
          onClick: () => onTheme(t.id),
          title: t.hint,
        },
          e('div', { className: 'theme-tile-name' }, t.name),
          e('div', { className: 'theme-tile-hint' }, t.hint),
          e('div', { className: 'theme-tile-swatch' },
            [t.bg, t.accent, t.fg].map((c, i) => e('span', { key: i, style: { background: c } })),
          ),
        )),
      ),
      // Custom theme grid (only renders if at least one is saved)
      customThemes.length > 0 && e('div', { className: 'set-hint', style: { marginTop: 12, marginBottom: 6 } },
        `your themes (${customThemes.length}/${MAX_CUSTOM_THEMES})`),
      customThemes.length > 0 && e('div', { className: 'theme-grid' },
        customThemes.map(t => e('div', { key: t.id, className: 'theme-tile-wrap' },
          e('button', {
            type: 'button',
            className: 'theme-tile',
            onClick: () => onApplyCustom(t),
            title: 'apply this saved theme',
          },
            e('div', { className: 'theme-tile-name' }, t.name),
            e('div', { className: 'theme-tile-hint' }, 'custom'),
            e('div', { className: 'theme-tile-swatch' },
              [t.bg, t.accent, t.fg].map((c, i) => e('span', { key: i, style: { background: c } })),
            ),
          ),
          e('button', {
            type: 'button',
            className: 'theme-tile-del',
            onClick: (ev) => { ev.stopPropagation(); onDeleteCustom(t.id); },
            title: 'delete this custom theme',
          }, '×'),
        )),
      ),
      e('div', { className: 'set-hint', style: { marginTop: 14, marginBottom: 6 } }, 'font'),
      e('div', { className: 'font-row' },
        [
          { id: 'auto',  label: 'Auto', cls: '' },
          { id: 'mono',  label: 'Mono', cls: 'font-chip-mono' },
          { id: 'sans',  label: 'Sans', cls: 'font-chip-sans' },
          { id: 'serif', label: 'Serif', cls: 'font-chip-serif' },
        ].map(f => e('button', {
          key: f.id,
          type: 'button',
          className: 'font-chip ' + f.cls + (font === f.id ? ' active' : ''),
          onClick: () => onFont(f.id),
          title: f.id === 'auto' ? "use the theme's default font" : f.label + ' font family',
        }, f.label)),
      ),
      e('div', { className: 'set-hint', style: { marginTop: 14, marginBottom: 6 } }, 'colors (override the theme)'),
      e('div', { className: 'p-row', style: { gap: 10, alignItems: 'flex-start' } },
        e(ColorPicker, { label: 'background', value: bg, themeDefault: active.bg, onChange: onBg }),
        e(ColorPicker, { label: 'accent',     value: accent, themeDefault: active.accent, onChange: onAccent }),
        e(ColorPicker, { label: 'text',       value: fg, themeDefault: active.fg, onChange: onFg }),
      ),
      // Save / clear actions
      e('div', { className: 'p-row', style: { marginTop: 10, gap: 6 } },
        !namingOpen && e('button', {
          className: 'p-btn',
          style: { fontSize: 10 },
          disabled: slotsLeft <= 0 || (!bg && !accent && !fg),
          onClick: startSave,
          title: slotsLeft <= 0
            ? `${MAX_CUSTOM_THEMES} custom themes max — delete one to save another`
            : (!bg && !accent && !fg)
              ? 'change at least one color to save a custom theme'
              : 'save these colors as a named theme',
        }, slotsLeft <= 0 ? `+ save (full · ${customThemes.length}/${MAX_CUSTOM_THEMES})` : `+ save as theme (${slotsLeft} left)`),
        namingOpen && e('input', {
          type: 'text',
          autoFocus: true,
          maxLength: 24,
          value: draftName,
          onChange: ev => setDraftName(ev.target.value),
          onKeyDown: ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); commitSave(); }
            if (ev.key === 'Escape') setNamingOpen(false);
          },
          className: 'p-input',
          style: { fontSize: 11, flex: 1 },
          placeholder: 'theme name',
        }),
        namingOpen && e('button', { className: 'p-btn', style: { fontSize: 10 }, onClick: commitSave }, 'save'),
        namingOpen && e('button', { className: 'p-btn', style: { fontSize: 10 }, onClick: () => setNamingOpen(false) }, 'cancel'),
        !namingOpen && (bg || accent || fg) && e('button', {
          className: 'p-btn',
          style: { fontSize: 10 },
          onClick: () => { onBg(null); onAccent(null); onFg(null); },
          title: 'clear all color overrides',
        }, '⟲ clear overrides'),
      ),
    );
  }

  // ---------- Host (server) section ----------
  // Exposes the activity log over HTTP/SSE so other apps on this machine
  // (or, if you flip "Allow LAN", on this network) can read everything you
  // do in the dashboard. Bearer-token authed; loopback by default.
  function HostSection() {
    const [status, setStatus] = useState({ running: false, port: 7878, lan: false });
    const [config, setConfig] = useState({ port: 7878, lan: false, autoStart: false, passwordSet: false, loggingEnabled: true });
    const [tail, setTail] = useState([]);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState('');
    const [logSize, setLogSize] = useState(0);
    const [portInput, setPortInput] = useState('7878');
    const [pwInput, setPwInput] = useState('');
    const [pwInput2, setPwInput2] = useState('');
    const [pwShow, setPwShow] = useState(false);
    const [pwSaving, setPwSaving] = useState(false);
    const [pwMsg, setPwMsg] = useState('');
    const [ips, setIps] = useState([]);

    const refreshStatus = useCallback(async () => {
      try { setStatus(await window.dashboard.host.status()); } catch {}
    }, []);
    const refreshConfig = useCallback(async () => {
      try {
        const c = await window.dashboard.host.getConfig();
        setConfig(c);
        setPortInput(String(c.port || 7878));
      } catch {}
    }, []);
    const refreshTail = useCallback(async () => {
      try { setTail(await window.dashboard.host.tail(50)); } catch {}
    }, []);
    const refreshSize = useCallback(async () => {
      try {
        const days = await window.dashboard.host.listDays();
        setLogSize(days.reduce((s, d) => s + (d.size || 0), 0));
      } catch {}
    }, []);
    const refreshIps = useCallback(async () => {
      try { setIps(await window.dashboard.host.localIps()); } catch {}
    }, []);

    useEffect(() => {
      refreshStatus(); refreshConfig(); refreshTail(); refreshSize(); refreshIps();
      const off = window.dashboard.host.onEvent((ev) => {
        setTail((prev) => {
          const next = prev.concat([ev]);
          return next.length > 50 ? next.slice(-50) : next;
        });
      });
      const t = setInterval(refreshSize, 5000);
      return () => { off(); clearInterval(t); };
    }, [refreshStatus, refreshConfig, refreshTail, refreshSize, refreshIps]);

    const start = async () => {
      setBusy(true);
      try {
        await window.dashboard.host.setConfig({
          port: Math.max(1, Math.min(65535, parseInt(portInput, 10) || 7878)),
          lan: config.lan,
        });
        const r = await window.dashboard.host.start();
        if (r && r.ok) { await refreshStatus(); await refreshConfig(); }
        else alert('Failed to start: ' + (r && r.error ? r.error : 'unknown'));
      } finally { setBusy(false); }
    };
    const stop = async () => {
      setBusy(true);
      try { await window.dashboard.host.stop(); await refreshStatus(); }
      finally { setBusy(false); }
    };
    const savePassword = async () => {
      setPwMsg('');
      if (pwInput.length < 6) { setPwMsg('password must be at least 6 characters'); return; }
      if (pwInput !== pwInput2) { setPwMsg("passwords don't match"); return; }
      setPwSaving(true);
      try {
        const r = await window.dashboard.host.setPassword(pwInput);
        if (r && r.ok) {
          setPwMsg('✓ password saved · existing sessions invalidated');
          setPwInput(''); setPwInput2('');
          await refreshConfig(); await refreshStatus();
        } else {
          setPwMsg('failed: ' + (r && r.error ? r.error : 'unknown'));
        }
      } finally { setPwSaving(false); }
    };
    const clearPassword = async () => {
      if (!confirm('Clear the password? The server will stop and refuse to start until you set a new one.')) return;
      await window.dashboard.host.clearPassword();
      await refreshConfig(); await refreshStatus();
      setPwMsg('password cleared');
    };
    const copy = async (text, label) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(label);
        setTimeout(() => setCopied(''), 1200);
      } catch { /* ignore */ }
    };
    const toggleLan = async (v) => {
      if (v && !confirm(
        'Allow LAN/Tailscale access?\n\n' +
        'The server will bind to all network interfaces. Anyone reachable on\n' +
        'your network (or tailnet) needs the password to connect — but the\n' +
        'port itself becomes visible to them.\n\n' +
        'Recommended only with Tailscale or a trusted LAN.'
      )) return;
      await window.dashboard.host.setConfig({ lan: v });
      setConfig((c) => ({ ...c, lan: v }));
      if (status.running) { await stop(); await start(); }
    };
    const toggleAutoStart = async (v) => {
      await window.dashboard.host.setConfig({ autoStart: v });
      setConfig((c) => ({ ...c, autoStart: v }));
    };
    const toggleLogging = async (v) => {
      await window.dashboard.host.setConfig({ loggingEnabled: v });
      setConfig((c) => ({ ...c, loggingEnabled: v }));
    };
    const clearLogs = async () => {
      if (!confirm('Permanently delete all activity logs on disk?')) return;
      await window.dashboard.host.clearLogs();
      setTail([]);
      await refreshSize();
    };

    const fmtBytes = (b) => {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      return (b / (1024 * 1024)).toFixed(2) + ' MB';
    };
    const fmtTs = (ts) => {
      const d = new Date(ts);
      return d.toTimeString().slice(0, 8);
    };
    const port = status.port || config.port || 7878;

    return e('div', { className: 'set-body' },
      // Status header
      e('div', { className: 'set-kv', style: { marginBottom: 14 } },
        e('span', { className: 'set-kv-label' }, 'status'),
        e('span', {
          className: 'set-kv-value',
          style: { color: status.running ? 'var(--accent)' : 'var(--fg-dim, #888)' },
        }, status.running
          ? `● running on ${status.bind || (status.lan ? '0.0.0.0' : '127.0.0.1')}:${status.port}`
          : '○ stopped'),
      ),

      // Tailscale hint when LAN is enabled
      config.lan && e('div', {
        className: 'set-hint',
        style: { padding: 8, background: 'var(--bg-elev, rgba(255,255,255,0.04))', borderRadius: 4, marginBottom: 12 },
      },
        'For internet-anywhere access, install Tailscale on this machine and on the device you want to connect from. ',
        'They will be reachable through the 100.x.y.z address shown below.',
      ),

      // Start/stop + port
      e('div', { className: 'set-tools', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        e('span', { className: 'set-label', style: { minWidth: 50 } }, 'port'),
        e('input', {
          type: 'number', min: 1, max: 65535,
          className: 'p-input',
          style: { width: 90 },
          value: portInput,
          disabled: status.running || busy,
          onChange: (ev) => setPortInput(ev.target.value),
        }),
        !status.running
          ? e('button', {
              className: 'btn', onClick: start,
              disabled: busy || !config.passwordSet,
              title: !config.passwordSet ? 'set a password first' : null,
            }, busy ? '…' : '▶ Start server')
          : e('button', { className: 'btn', onClick: stop, disabled: busy }, busy ? '…' : '■ Stop server'),
      ),

      e('div', { className: 'set-hint', style: { marginTop: 6, marginBottom: 14 } },
        config.lan
          ? 'Bound to 0.0.0.0 — reachable from any IP on this machine (LAN, Tailscale, etc).'
          : 'Bound to 127.0.0.1 — only apps running on this PC can connect.'),

      // Reachable-at IPs
      status.running && ips.length > 0 && e('div', { className: 'set-section', style: { marginBottom: 14 } },
        e('div', { className: 'set-label', style: { marginBottom: 4 } }, 'reachable at'),
        ips.map((ip) => {
          const url = `http://${ip.address}:${port}`;
          const tag = ip.kind === 'tailscale' ? 'TAILSCALE' : ip.kind === 'lan' ? 'LAN' : ip.kind.toUpperCase();
          return e('div', {
            key: ip.address,
            style: { display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'monospace', fontSize: 11, padding: '2px 0' },
          },
            e('span', {
              style: {
                fontSize: 9, padding: '1px 5px', borderRadius: 3,
                background: ip.kind === 'tailscale' ? 'var(--accent)' : 'var(--border)',
                color: ip.kind === 'tailscale' ? 'var(--bg)' : 'var(--fg)',
                minWidth: 64, textAlign: 'center',
              },
            }, tag),
            e('span', { style: { flex: 1 } }, url),
            e('span', { style: { opacity: 0.5, fontSize: 10 } }, ip.iface),
            e('button', {
              className: 'p-btn',
              style: { fontSize: 10 },
              onClick: () => copy(url, 'ip:' + ip.address),
            }, copied === 'ip:' + ip.address ? '✓' : 'copy'),
          );
        }),
      ),

      // Toggles
      e(Toggle, {
        label: 'Allow remote access (LAN / Tailscale)',
        value: !!config.lan, onChange: toggleLan,
        hint: 'off = loopback only · on = bind to all interfaces (Tailscale recommended)',
      }),
      e(Toggle, {
        label: 'Start server when dashboard launches',
        value: !!config.autoStart, onChange: toggleAutoStart,
        hint: 'requires a password to be set',
      }),
      e(Toggle, {
        label: 'Log activity to disk',
        value: config.loggingEnabled !== false, onChange: toggleLogging,
        hint: 'turn off to pause capture without stopping the server',
      }),

      // Password section
      e('div', { className: 'set-section', style: { marginTop: 14 } },
        e('div', { className: 'set-label' },
          config.passwordSet ? 'change password' : 'set password',
          e('span', { className: 'set-hint' }, ' clients log in with POST /login {password} and receive a session token'),
        ),
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
          e('input', {
            type: pwShow ? 'text' : 'password',
            className: 'p-input',
            placeholder: 'new password (6+ chars)',
            value: pwInput,
            onChange: (ev) => { setPwInput(ev.target.value); setPwMsg(''); },
            style: { fontSize: 12 },
          }),
          e('input', {
            type: pwShow ? 'text' : 'password',
            className: 'p-input',
            placeholder: 'confirm password',
            value: pwInput2,
            onChange: (ev) => { setPwInput2(ev.target.value); setPwMsg(''); },
            style: { fontSize: 12 },
          }),
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            e('button', { className: 'btn', onClick: savePassword, disabled: pwSaving || !pwInput }, pwSaving ? '…' : 'save password'),
            e('button', { className: 'p-btn', style: { fontSize: 11 }, onClick: () => setPwShow((v) => !v) }, pwShow ? 'hide' : 'show'),
            config.passwordSet && e('button', {
              className: 'p-btn', style: { fontSize: 11, color: 'var(--danger)' },
              onClick: clearPassword,
            }, 'clear'),
            pwMsg && e('span', { className: 'set-hint', style: { fontSize: 11 } }, pwMsg),
          ),
        ),
        !config.passwordSet && e('div', {
          className: 'set-hint',
          style: { color: 'var(--danger)', marginTop: 6 },
        }, 'no password set — server cannot start'),
      ),

      // Live tail
      e('div', { className: 'set-section', style: { marginTop: 14 } },
        e('div', {
          style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 },
        },
          e('span', { className: 'set-label' }, `live activity (${tail.length})`),
          e('span', { className: 'set-hint' }, fmtBytes(logSize) + ' on disk'),
        ),
        e('div', {
          style: {
            background: 'var(--bg-elev, rgba(0,0,0,0.25))',
            border: '1px solid var(--border, rgba(255,255,255,0.1))',
            padding: 8,
            fontSize: 10.5,
            fontFamily: 'monospace',
            height: 220,
            overflowY: 'auto',
            borderRadius: 4,
          },
          ref: (el) => { if (el) el.scrollTop = el.scrollHeight; },
        },
          tail.length === 0
            ? e('div', { className: 'set-hint' }, 'no events yet — interact with the dashboard to see activity here')
            : tail.map((ev, i) => e('div', {
                key: ev.ts + ':' + i,
                style: { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' },
              },
                e('span', { style: { opacity: 0.5 } }, fmtTs(ev.ts)),
                ' ',
                e('span', { style: { color: 'var(--accent)' } }, ev.source),
                ' ',
                e('span', null, ev.channel || ev.event || ''),
                ev.ok === false ? e('span', { style: { color: 'var(--danger, #ff6b6b)' } }, ' ✗') : null,
                ev.ms != null ? e('span', { style: { opacity: 0.5 } }, ` ${ev.ms}ms`) : null,
              )),
        ),
      ),

      // Tools
      e('div', { className: 'set-tools', style: { marginTop: 14 } },
        e('button', { className: 'btn', onClick: () => window.dashboard.host.openLogFolder() }, 'Open log folder'),
        e('button', {
          className: 'btn',
          style: { borderColor: 'var(--danger)', color: 'var(--danger)' },
          onClick: clearLogs,
        }, '✕ Clear all logs'),
      ),
    );
  }

  // ---------- Updates section (Settings → Updates) ----------
  function UpdatesSection({ status, version, packaged, onCheck, onInstall }) {
    const [busy, setBusy] = useState(false);
    const s = status || { state: 'idle' };

    // Human-readable summary of the current update state.
    let title, sub;
    switch (s.state) {
      case 'checking':       title = 'Checking for updates…';                       sub = ''; break;
      case 'available':      title = 'Update available';                            sub = s.info && s.info.version ? 'Version ' + s.info.version + ' — downloading in the background.' : 'Downloading in the background.'; break;
      case 'downloading':    title = 'Downloading update…';                         sub = s.progress ? (s.progress.percent + '% · ' + Math.round((s.progress.bytesPerSecond || 0) / 1024) + ' KB/s') : ''; break;
      case 'downloaded':     title = 'Update ready to install';                     sub = s.info && s.info.version ? 'Version ' + s.info.version + ' — restart to apply.' : 'Restart to apply.'; break;
      case 'not-available':  title = 'You’re on the latest version.';          sub = 'Last checked just now.'; break;
      case 'dev':            title = 'Auto-update disabled (development mode)';     sub = 'Auto-updates only run on packaged builds.'; break;
      case 'no-config':      title = 'Auto-update not configured';                  sub = 'Set the GitHub publish target in package.json (build.publish).'; break;
      case 'error':          title = 'Update check failed';                         sub = s.error || 'unknown error'; break;
      default:               title = 'No update info yet';                          sub = 'Click "Check for updates" to query.'; break;
    }

    const handleCheck = async () => {
      if (!onCheck || busy) return;
      setBusy(true);
      try { await onCheck(); }
      finally { setBusy(false); }
    };

    return e('div', { className: 'set-body' },
      e(KV, { label: 'current version', value: version || '—' }),
      e(KV, { label: 'mode',            value: packaged ? 'packaged' : 'development' }),
      e('div', { className: 'set-update-card' + (s.state === 'downloaded' ? ' update-ready' : '') },
        e('div', { className: 'set-update-title' }, title),
        sub && e('div', { className: 'set-update-sub p-dim' }, sub),
        s.state === 'downloading' && s.progress && e('div', { className: 'set-update-progress' },
          e('div', {
            className: 'set-update-progress-bar',
            style: { width: Math.min(100, Math.max(0, s.progress.percent || 0)) + '%' },
          }),
        ),
      ),
      e('div', { className: 'set-tools', style: { marginTop: 12 } },
        s.state === 'downloaded'
          ? e('button', {
              className: 'btn btn-accent',
              onClick: () => { if (onInstall) onInstall(); },
              title: 'restart now and install the new version',
            }, '↻ Restart & install')
          : null,
        e('button', {
          className: 'btn',
          onClick: handleCheck,
          disabled: busy || s.state === 'checking' || s.state === 'downloading',
          title: 'check the release server now',
        }, busy || s.state === 'checking' ? 'Checking…' : 'Check for updates'),
      ),
      e('div', { className: 'set-hint', style: { marginTop: 10 } },
        'Updates are downloaded automatically in the background. You’ll see a notification dot here and on the Settings button when one is ready to install.'),
    );
  }

  // True if the supplied status represents a pending update the user can act on.
  function isUpdateBadgeVisible(status) {
    return !!status && ['available', 'downloading', 'downloaded'].includes(status.state);
  }

  // ---------- Settings overlay (Discord-style: sidebar + content pane) ----------
  // Each entry in CATEGORIES is { id, label, glyph, render(props) }. The sidebar
  // lists them; the content pane renders the active category's content. Only
  // one category is mounted at a time so the right pane stays focused and not
  // a long scroll list.
  const SETTINGS_CATEGORIES = [
    {
      id: 'system', label: 'System', glyph: '⌬',
      render: (p) => e('div', { className: 'set-body' },
        e(Toggle, {
          label: 'Run On Start-Up',
          value: p.autoStart, onChange: p.onAutoStart,
          hint: p.packaged === false ? 'dev mode: launches the Electron binary with this project path' : null,
        }),
        e(Toggle, {
          label: 'Fullscreen',
          value: p.fullScreen, onChange: p.onFullScreen,
          hint: 'F11 also toggles natively',
        }),
        e(Toggle, {
          label: 'Always on top',
          value: p.alwaysOnTop, onChange: p.onAlwaysOnTop,
          hint: p.skinMode
            ? 'disabled while skin mode is active'
            : 'forces above other windows · for skin behavior, use Skin mode below instead',
        }),
        e(Toggle, {
          label: 'Skin mode (desktop layer)',
          value: p.skinMode, onChange: p.onSkinMode,
          hint: 'pins window BEHIND all apps as a custom desktop. recreates the window. Win+D to see, Ctrl+Shift+D to focus, Ctrl+Shift+Q to quit.',
        }),
      ),
    },
    {
      id: 'display', label: 'Display', glyph: '◉',
      render: (p) => e('div', { className: 'set-body' },
        e(Toggle, {
          label: 'CRT scanlines',
          value: p.scanlines, onChange: p.onScanlines,
          hint: 'auto-hidden on non-CRT themes',
        }),
        e(Toggle, {
          label: '12-hour clock',
          value: p.clock12h, onChange: p.onClock12h,
          hint: 'off = 24-hour',
        }),
        e(Toggle, {
          label: 'Show greeting on empty dashboard',
          value: p.greetingEnabled, onChange: p.onGreetingEnabled,
          hint: 'large welcome text shown when no plugins are open',
        }),
        // Disable the input when the toggle is off so it's clear which
        // setting is the master switch. Persists across devices via the
        // existing localStorage sync.
        e('div', { className: 'set-kv' },
          e('div', { className: 'set-kv-label' }, 'Greeting text'),
          e('input', {
            className: 'p-input',
            type: 'text',
            value: p.greeting || '',
            placeholder: 'Welcome back',
            maxLength: 80,
            disabled: !p.greetingEnabled,
            onChange: (ev) => p.onGreeting(ev.target.value),
            style: { flex: 1, minWidth: 0 },
          }),
        ),
      ),
    },
    {
      id: 'customize', label: 'Customize', glyph: '◐',
      render: (p) => e(CustomizeSection, {
        theme: p.theme, onTheme: p.onTheme,
        font: p.font, onFont: p.onFont,
        accent: p.accent, onAccent: p.onAccent,
        bg: p.bg, onBg: p.onBg,
        fg: p.fg, onFg: p.onFg,
        customThemes: p.customThemes || [],
        onSaveCustom: p.onSaveCustom,
        onApplyCustom: p.onApplyCustom,
        onDeleteCustom: p.onDeleteCustom,
      }),
    },
    {
      id: 'plugins', label: 'Plugins', glyph: '◇',
      render: (p) => e(PluginsSection, {
        plugins: p.plugins,
        disabledIds: p.disabledIds,
        onTogglePluginEnabled: p.onTogglePluginEnabled,
      }),
    },
    {
      id: 'layout', label: 'Layout', glyph: '⊞',
      render: (p) => e('div', { className: 'set-body' },
        e('div', { className: 'set-tools' },
          e('button', {
            className: 'btn',
            onClick: p.onResetLayout,
            title: 'reset every widget back to its default position and size',
          }, '⟲ Reset widget layout'),
          e('button', {
            className: 'btn',
            onClick: p.onReloadPlugins,
            title: 'rescan the plugins folder and re-mount any changed plugins',
          }, '↻ Reload plugins'),
        ),
        e('div', { className: 'set-hint', style: { marginTop: 10 } },
          'Reset removes any custom widget positions and sizes you’ve set by dragging.'),
      ),
    },
    {
      id: 'tools', label: 'Tools', glyph: '⚒',
      render: (p) => e('div', { className: 'set-body' },
        e('div', { className: 'set-tools' },
          e('button', { className: 'btn', onClick: () => window.dashboard.openDevTools() },
            'Open DevTools'),
          e('button', { className: 'btn', onClick: () => window.dashboard.openPluginsFolder() },
            'Open plugins folder'),
          e('button', { className: 'btn', onClick: p.onReload },
            'Hard reload window'),
          e('button', {
            className: 'btn',
            onClick: async () => {
              if (!confirm('Forget every saved server (URL + remembered password) on this device?\n\nThis only affects this device — other connected dashboards keep their own lists.')) return;
              try { await window.dashboard.servers.clearAll(); }
              catch {}
            },
            title: 'wipe saved-servers.bin on this device',
          }, 'Forget all saved servers'),
        ),
      ),
    },
    {
      id: 'host', label: 'Host', glyph: '⇄',
      render: () => e(HostSection),
    },
    {
      id: 'updates', label: 'Updates', glyph: '⇩',
      // Sidebar dot — visible whenever there's a pending update. The category
      // body shows the same state in detail.
      badge: (p) => isUpdateBadgeVisible(p.updateStatus),
      render: (p) => e(UpdatesSection, {
        status: p.updateStatus,
        version: p.version,
        packaged: p.packaged,
        onCheck: p.onCheckUpdate,
        onInstall: p.onInstallUpdate,
      }),
    },
    {
      id: 'about', label: 'About', glyph: 'ⓘ',
      render: (p) => e('div', { className: 'set-body' },
        e(KV, { label: 'version',        value: p.version || '0.1.0' }),
        e(KV, { label: 'plugins loaded', value: String(p.pluginCount) }),
        e(KV, { label: 'plugins folder', value: p.pluginsPath || '—' }),
        e(KV, { label: 'mode',           value: p.packaged ? 'packaged' : 'development' }),
      ),
    },
    {
      id: 'danger', label: 'Quit', glyph: '⏻', danger: true,
      render: (p) => e('div', { className: 'set-body' },
        e('div', { className: 'set-hint', style: { marginBottom: 10 } },
          'You can also press Ctrl+Shift+Q from anywhere — it works in fullscreen and always-on-top mode.'),
        e('button', {
          className: 'btn',
          style: { borderColor: 'var(--danger)', color: 'var(--danger)' },
          onClick: () => {
            if (confirm('Quit the dashboard?\n\nTip: Ctrl+Shift+Q quits from anywhere.')) {
              window.dashboard.quit();
            }
          },
        }, '⏻ Quit dashboard'),
      ),
    },
  ];

  function SettingsPanel(props) {
    const { open, onClose } = props;
    const [activeId, setActiveId] = useState('system');

    useEffect(() => {
      if (!open) return;
      const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const active = SETTINGS_CATEGORIES.find(c => c.id === activeId) || SETTINGS_CATEGORIES[0];

    return e('div', { className: 'set-fullscreen', onClick: onClose },
      e('div', {
        className: 'set-window',
        onClick: (ev) => ev.stopPropagation(),
      },
        // Sidebar — category list
        e('aside', { className: 'set-sidebar' },
          e('div', { className: 'set-sidebar-hdr' },
            e('div', { className: 'brand-mark' }, '⚙ SETTINGS'),
            e('div', { className: 'brand-sub' }, 'dashboard preferences'),
          ),
          e('nav', { className: 'set-nav' },
            SETTINGS_CATEGORIES.map(cat => {
              const showBadge = typeof cat.badge === 'function' && cat.badge(props);
              return e('button', {
                key: cat.id,
                type: 'button',
                className: 'set-nav-item'
                  + (activeId === cat.id ? ' active' : '')
                  + (cat.danger ? ' danger' : '')
                  + (showBadge ? ' has-badge' : ''),
                onClick: () => setActiveId(cat.id),
              },
                e('span', { className: 'set-nav-glyph' }, cat.glyph),
                e('span', { className: 'set-nav-label' }, cat.label),
                showBadge && e('span', { className: 'badge-dot', title: 'update available' }),
              );
            }),
          ),
          e('div', { className: 'set-sidebar-ftr' },
            e('span', { className: 'p-dim', style: { fontSize: 10 } }, `v${props.version || '0.1.0'}`),
          ),
        ),
        // Content pane — only the active category renders here
        e('section', { className: 'set-content' },
          e('header', { className: 'set-content-hdr' },
            e('div', null,
              e('div', { className: 'set-content-title' }, active.label),
              e('div', { className: 'set-content-sub' }, `${active.glyph} ${active.id}`),
            ),
            e('button', { className: 'set-close', onClick: onClose, title: 'close (esc)' }, '×'),
          ),
          e('div', { className: 'set-content-body' },
            active.render(props),
          ),
        ),
      ),
    );
  }

  // ---------- Widget ----------
  class WidgetBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error: error.message || String(error) }; }
    componentDidCatch(error, info) {
      console.error('Plugin crashed:', this.props.plugin.id, error, info);
    }
    componentDidUpdate(prev) {
      if (prev.plugin !== this.props.plugin && this.state.error) this.setState({ error: null });
    }
    render() {
      if (this.state.error) {
        return e('div', { className: 'widget-error-body' }, 'Runtime error:\n' + this.state.error);
      }
      return this.props.children;
    }
  }

  function Widget({
    plugin, col, row, w, h,
    isDragging, isOver, isMaximized, dragOffset,
    onHeaderMouseDown, onResizeStart, onMinimize, onClose, onToggleMaximize,
  }) {
    // When maximized, drop the grid-placement style so the absolute-positioned
    // .widget--maximized rule controls placement.
    let style = null;
    if (!isMaximized) {
      style = {
        gridColumn: `${col + 1} / span ${w}`,
        gridRow:    `${row + 1} / span ${h}`,
      };
      if (isDragging && dragOffset) {
        style.transform = `translate(${dragOffset.dx}px, ${dragOffset.dy}px)`;
        style.zIndex = 1000;
        style.pointerEvents = 'none';
      }
    }
    const className =
      'widget' +
      (plugin.error ? ' error' : '') +
      (isDragging ? ' dragging' : '') +
      (isOver ? ' drop-target' : '') +
      (isMaximized ? ' widget--maximized' : '');

    const stop = (ev) => ev.stopPropagation();

    const headerChildren = [
      e('span', { key: 't', className: 'widget-title' }, plugin.name),
      !isMaximized && e('span', { key: 's', className: 'widget-size p-dim' }, `${w}×${h}`),
      e('div', { key: 'a', className: 'widget-actions' },
        e('button', {
          className: 'widget-action',
          onMouseDown: stop,
          onClick: (ev) => { stop(ev); onMinimize(plugin.id); },
          title: 'minimize to dock',
        }, '−'),
        e('button', {
          className: 'widget-action',
          onMouseDown: stop,
          onClick: (ev) => { stop(ev); onToggleMaximize(plugin.id); },
          title: isMaximized ? 'restore (esc)' : 'maximize',
        }, isMaximized ? '❐' : '□'),
        e('button', {
          className: 'widget-action widget-action-close',
          onMouseDown: stop,
          onClick: (ev) => { stop(ev); onClose(plugin.id); },
          title: 'close (disable plugin)',
        }, '×'),
      ),
    ];

    let body;
    if (plugin.error) {
      body = e('div', { className: 'widget-error-body' }, plugin.error);
    } else {
      const PluginComponent = plugin.component;
      body = e(WidgetBoundary, { plugin },
        e(PluginComponent, {
          React, useState, useEffect, useMemo, useRef, useCallback,
        }),
      );
    }

    return e('div', {
      className, style,
      'data-plugin-id': plugin.id,
    },
      e('div', {
        className: 'widget-header',
        onMouseDown: isMaximized ? null : (ev) => onHeaderMouseDown(plugin.id, ev),
      }, headerChildren),
      e('div', { className: 'widget-body' }, body),
      // Hide the resize handle while maximized — size is fixed to the grid area.
      !isMaximized && e('div', {
        className: 'widget-resize',
        title: 'drag to resize',
        onMouseDown: (ev) => onResizeStart(plugin.id, ev),
      }),
    );
  }


  // ---------- Built-in SysDock (taskbar + start menu) ----------
  // Shared localStorage keys — intentionally match the old plugin keys so any
  // previously saved favourites / hidden / order data migrates automatically.
  const SM_USER_KEY   = 'plugin:launcher:userApps:v1';
  const SM_HIDDEN_KEY = 'plugin:launcher:hidden:v1';
  const SM_FAVS_KEY   = 'plugin:launcher:favs:v1';
  const SM_ORDER_KEY  = 'plugin:launcher:order:v1';

  // Power actions are populated from main via window.dashboard.power.list().
  // Different platforms expose different sets (e.g. macOS has no Hibernate),
  // so the StartMenu component fetches at mount time.

  function StartMenuTile({ app, isFav, onLaunch, onToggleFav, onToggleHide, onRemove }) {
    const [hover, setHover] = useState(false);
    return e('div', {
      className: 'sm-tile' + (hover ? ' hovered' : ''),
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onClick: onLaunch,
      title: app.name + (app.target ? '\n' + app.target : ''),
    },
      isFav && e('span', { className: 'sm-tile-fav' }, '★'),
      app.iconDataUrl
        ? e('img', { src: app.iconDataUrl, width: 32, height: 32, alt: '', draggable: false, style: { imageRendering: 'auto' } })
        : e('div', { className: 'sm-tile-icon-ph' }, (app.name || '?')[0].toUpperCase()),
      e('div', { className: 'sm-tile-name' }, app.name),
      hover && e('div', { className: 'sm-tile-btns' },
        e('button', { onClick: ev => { ev.stopPropagation(); onToggleFav(); }, title: isFav ? 'unfavorite' : 'favorite' }, '★'),
        e('button', { onClick: ev => { ev.stopPropagation(); onToggleHide(); }, title: 'hide' }, '−'),
        onRemove && e('button', { className: 'remove', onClick: ev => { ev.stopPropagation(); onRemove(); }, title: 'remove' }, '×'),
      ),
    );
  }

  // Tile for the "Dashboard Apps" view in the start menu — shows plugin name,
  // an indicator dot when the plugin is currently visible in the grid, and
  // toggles open/closed on click (first click opens, second click closes).
  function PluginTile({ plugin, isOpen, onToggle }) {
    const [hover, setHover] = useState(false);
    return e('button', {
      type: 'button',
      className: 'sm-plugin-tile' + (hover ? ' hovered' : '') + (isOpen ? ' open' : ''),
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onClick: onToggle,
      title: plugin.error
        ? `${plugin.name} — load error: ${plugin.error}`
        : (isOpen ? `close ${plugin.name}` : `open ${plugin.name}`),
    },
      e('span', { className: 'sm-plugin-dot' + (isOpen ? ' on' : '') }),
      e('span', { className: 'sm-plugin-name' }, plugin.name || plugin.id),
      plugin.error && e('span', { className: 'sm-plugin-err', title: plugin.error }, '⚠'),
    );
  }

  function StartMenu({ onClose, plugins, disabledIds, minimizedIds, onOpenPlugin, onClosePlugin, onOpenSettings, updateStatus }) {
    // True whenever there's a pending update the user could act on.
    // 'available' is shown while electron-updater is downloading, 'downloaded'
    // means a quitAndInstall is the next step.
    const hasUpdate = updateStatus &&
      ['available', 'downloading', 'downloaded'].includes(updateStatus.state);
    const loadJson = (key, dflt) => { try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch { return dflt; } };

    const [discovered, setDiscovered] = useState([]);
    const [userApps, setUserApps] = useState(() => loadJson(SM_USER_KEY, []));
    const [hidden, setHidden] = useState(() => new Set(loadJson(SM_HIDDEN_KEY, [])));
    const [favs, setFavs] = useState(() => new Set(loadJson(SM_FAVS_KEY, [])));
    const [order, setOrder] = useState(() => loadJson(SM_ORDER_KEY, []));
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [showHidden, setShowHidden] = useState(false);
    const [armedId, setArmedId] = useState(null);
    const [busyId, setBusyId] = useState(null);
    const [powerActions, setPowerActions] = useState([]);
    const [mode, setMode] = useState('programs');  // programs | plugins
    const armTimer = useRef(null);
    const searchRef = useRef(null);

    // Plugin folder layout — read live from the same keys the Settings panel
    // writes to so the Dashboard Apps view mirrors that organization exactly.
    const pluginFolders = loadJson('dashboard:pluginFolders:v1', []);
    const pluginFolderMap = loadJson('dashboard:pluginFolderMap:v1', {});

    useEffect(() => { if (searchRef.current) searchRef.current.focus(); }, []);

    useEffect(() => {
      const onKey = ev => { if (ev.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    useEffect(() => {
      let cancelled = false;
      window.dashboard.apps.discover()
        .then(apps => { if (!cancelled) { setDiscovered(apps || []); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, []);

    // Pull the platform-appropriate power-action menu from main. Different
    // hosts expose different actions (e.g. macOS has no Hibernate).
    useEffect(() => {
      let cancelled = false;
      const api = window.dashboard && window.dashboard.power;
      if (!api) return;
      api.list()
        .then(list => { if (!cancelled && Array.isArray(list)) setPowerActions(list); })
        .catch(() => {});
      return () => { cancelled = true; };
    }, []);

    const persist = (key, val) => localStorage.setItem(key, JSON.stringify(val));
    const persistUserApps = next => { setUserApps(next); persist(SM_USER_KEY, next); };
    const persistHidden   = next => { setHidden(next);   persist(SM_HIDDEN_KEY, [...next]); };
    const persistFavs     = next => { setFavs(next);     persist(SM_FAVS_KEY,   [...next]); };
    const persistOrder    = next => { setOrder(next);    persist(SM_ORDER_KEY,  next); };

    const allApps = useMemo(() => {
      const seen = new Set();
      return [...userApps, ...discovered].filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
    }, [userApps, discovered]);

    const visibleApps = useMemo(() => {
      const q = search.trim().toLowerCase();
      const orderMap = new Map(order.map((id, i) => [id, i]));
      return allApps
        .filter(a => {
          const isHid = hidden.has(a.id);
          if (showHidden ? !isHid : isHid) return false;
          return !q || a.name.toLowerCase().includes(q);
        })
        .sort((a, b) => {
          const af = favs.has(a.id), bf = favs.has(b.id);
          if (af !== bf) return af ? -1 : 1;
          const ao = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
          const bo = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
          return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
        });
    }, [allApps, hidden, showHidden, search, favs, order]);

    const launch = a => {
      const target = a.launchPath || a.target;
      if (!target) return;
      if (/\.lnk$/i.test(target) || a.source === 'discovered') window.dashboard.shell.open(target);
      else window.dashboard.shell.launch(target, []);
    };

    const addApp = async () => {
      const platformInfo = await (window.dashboard.appPlatform
        ? window.dashboard.appPlatform().catch(() => ({}))
        : Promise.resolve({}));
      const platformId = platformInfo && platformInfo.id;

      // Filters and stripping logic vary per OS; on macOS the user picks a
      // .app bundle directory, on Linux a binary or .desktop, on Windows
      // an .exe / .lnk.
      let filters;
      if (platformId === 'darwin') {
        filters = [{ name: 'Applications', extensions: ['app'] }, { name: 'All files', extensions: ['*'] }];
      } else if (platformId === 'linux') {
        filters = [{ name: 'Apps', extensions: ['desktop', 'sh', 'AppImage'] }, { name: 'All files', extensions: ['*'] }];
      } else {
        filters = [{ name: 'Programs', extensions: ['exe', 'lnk', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }];
      }

      const dialogOpts = { title: 'Add an app', filters };
      // On macOS .app bundles are directories — show them as files in the picker.
      if (platformId === 'darwin') dialogOpts.properties = ['openFile', 'treatPackageAsDirectory'];

      const filePath = await window.dashboard.dialog.openFile(dialogOpts);
      if (!filePath) return;

      let target = filePath, launchPath = filePath, iconSource = filePath;
      // Windows: dereference .lnk so we can pull a clean icon from the target .exe
      if (platformId === 'win32' && /\.lnk$/i.test(filePath) && platformInfo.supportsShortcutFiles) {
        const link = await window.dashboard.shell.readShortcut(filePath);
        if (link && link.target) { target = link.target; iconSource = link.target; }
      }
      let iconDataUrl = await window.dashboard.shell.getFileIcon(iconSource);
      if (!iconDataUrl && iconSource !== filePath) iconDataUrl = await window.dashboard.shell.getFileIcon(filePath);
      const baseName = filePath.split(/[\\/]/).pop().replace(/\.(exe|lnk|bat|cmd|app|desktop|AppImage|sh)$/i, '');
      const newApp = { id: 'user:' + filePath, source: 'user', name: baseName, target, launchPath, iconDataUrl };
      if (!userApps.some(a => a.id === newApp.id)) persistUserApps([...userApps, newApp]);
    };

    const refresh = async () => {
      setLoading(true);
      try { const apps = await window.dashboard.apps.discover({ refresh: true }); setDiscovered(apps || []); }
      finally { setLoading(false); }
    };

    const toggleHide = id => { const n = new Set(hidden); n.has(id) ? n.delete(id) : n.add(id); persistHidden(n); };
    const toggleFav  = id => { const n = new Set(favs);   n.has(id) ? n.delete(id) : n.add(id); persistFavs(n);   };
    const removeUser = id => {
      persistUserApps(userApps.filter(a => a.id !== id));
      if (favs.has(id))   { const f = new Set(favs);   f.delete(id); persistFavs(f);   }
      if (hidden.has(id)) { const h = new Set(hidden); h.delete(id); persistHidden(h); }
      if (order.includes(id)) persistOrder(order.filter(x => x !== id));
    };

    const execPower = async action => {
      const api = window.dashboard && window.dashboard.power;
      if (!api) return;
      setBusyId(action.id);
      try { await api.execute(action.id); } catch {}
      finally { setTimeout(() => setBusyId(null), 600); }
    };
    const handlePower = action => {
      if (busyId) return;
      if (!action.confirm) { execPower(action); return; }
      if (armedId === action.id) {
        setArmedId(null);
        if (armTimer.current) clearTimeout(armTimer.current);
        execPower(action);
        return;
      }
      setArmedId(action.id);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmedId(null), 3000);
    };

    // Plugins view — apply the search filter to the plugin list, otherwise
    // show every plugin grouped by the same folders the Settings panel uses.
    const q = search.trim().toLowerCase();
    const filteredPlugins = q
      ? (plugins || []).filter(p => (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q))
      : (plugins || []);
    const isPluginOpen = (id) => !((disabledIds || new Set()).has(id)) && !((minimizedIds || new Set()).has(id));
    // First click = open; second click = close. The dot on the tile reflects
    // the current state so it's obvious what the next click will do.
    const togglePlugin = (id) => {
      if (isPluginOpen(id)) onClosePlugin(id);
      else onOpenPlugin(id);
    };
    const renderPluginsView = () => {
      if (!plugins || plugins.length === 0) {
        return e('div', { className: 'p-dim', style: { padding: 20, textAlign: 'center', gridColumn: '1/-1' } }, 'no plugins detected');
      }
      if (q) {
        return filteredPlugins.length === 0
          ? e('div', { className: 'p-dim', style: { padding: 20, textAlign: 'center', gridColumn: '1/-1' } }, `no plugins match "${q}"`)
          : filteredPlugins.map(p => e(PluginTile, {
              key: p.id, plugin: p, isOpen: isPluginOpen(p.id),
              onToggle: () => togglePlugin(p.id),
            }));
      }
      // Grouped by folder. Render folder sections and an "ungrouped" tail.
      const sections = [];
      for (const f of pluginFolders) {
        const members = filteredPlugins.filter(p => pluginFolderMap[p.id] === f.id);
        if (members.length === 0) continue;
        sections.push(e('div', { key: f.id, className: 'sm-plugin-section' },
          e('div', { className: 'sm-plugin-section-hdr' }, '📁 ' + f.name),
          e('div', { className: 'sm-plugin-section-body' },
            members.map(p => e(PluginTile, {
              key: p.id, plugin: p, isOpen: isPluginOpen(p.id),
              onToggle: () => togglePlugin(p.id),
            })),
          ),
        ));
      }
      const ungrouped = filteredPlugins.filter(p => !pluginFolderMap[p.id]);
      if (ungrouped.length > 0) {
        sections.push(e('div', { key: '__ungrouped__', className: 'sm-plugin-section' },
          pluginFolders.length > 0 && e('div', { className: 'sm-plugin-section-hdr ungrouped' }, 'ungrouped'),
          e('div', { className: 'sm-plugin-section-body' },
            ungrouped.map(p => e(PluginTile, {
              key: p.id, plugin: p, isOpen: isPluginOpen(p.id),
              onToggle: () => togglePlugin(p.id),
            })),
          ),
        ));
      }
      return sections;
    };

    return e(React.Fragment, null,
      e('div', { className: 'start-backdrop', onClick: onClose }),
      e('div', { className: 'start-menu' },
        e('div', { className: 'start-menu-hdr' },
          e('span', { className: 'start-menu-title' }, '◈  START'),
          e('div', { className: 'start-menu-hdr-btns' },
            mode === 'programs' && e('button', { className: 'btn', onClick: addApp,  title: 'browse for an app to add', style: { fontSize: 10, padding: '2px 10px' } }, '+ add'),
            mode === 'programs' && e('button', { className: 'btn', onClick: refresh, title: 'rescan Windows Start Menu', style: { fontSize: 10, padding: '2px 10px' } }, '↻ refresh'),
            mode === 'programs' && e('button', {
              className: 'btn' + (showHidden ? ' btn-primary' : ''),
              onClick: () => setShowHidden(v => !v),
              title: 'toggle hidden apps',
              style: { fontSize: 10, padding: '2px 10px' },
            }, showHidden ? '← back' : `${hidden.size} hidden`),
            e('button', { className: 'set-close', onClick: onClose, title: 'close (esc)' }, '×'),
          ),
        ),
        // Mode tabs — Programs (Windows apps) vs Dashboard Apps (plugins),
        // plus a settings opener anchored to the right that closes the start
        // menu and opens the Discord-style settings overlay on top.
        e('div', { className: 'sm-mode-tabs' },
          e('button', {
            type: 'button',
            className: 'sm-mode-tab' + (mode === 'programs' ? ' active' : ''),
            onClick: () => setMode('programs'),
          }, 'Programs'),
          e('button', {
            type: 'button',
            className: 'sm-mode-tab' + (mode === 'plugins' ? ' active' : ''),
            onClick: () => setMode('plugins'),
          }, `Dashboard Apps${plugins ? ` (${plugins.length})` : ''}`),
          e('span', { className: 'sm-mode-spacer' }),
          e('button', {
            type: 'button',
            className: 'sm-mode-settings' + (hasUpdate ? ' has-badge' : ''),
            onClick: () => onOpenSettings && onOpenSettings(),
            title: hasUpdate ? 'update available — open Settings → Updates' : 'open settings',
          },
            '⚙ Settings',
            hasUpdate && e('span', { className: 'badge-dot', title: 'update available' }),
          ),
        ),
        e('div', { className: 'start-menu-search' },
          e('input', {
            ref: searchRef,
            className: 'p-input',
            placeholder: mode === 'programs' ? 'search apps…' : 'search plugins…',
            value: search,
            onChange: ev => setSearch(ev.target.value),
            style: { fontSize: 12 },
          }),
        ),
        mode === 'programs'
          ? e('div', { className: 'start-menu-tiles' },
              loading
                ? e('div', { className: 'p-dim', style: { padding: 20, textAlign: 'center', gridColumn: '1/-1' } }, '▸ scanning Start Menu…')
                : visibleApps.length === 0
                  ? e('div', { className: 'p-dim', style: { padding: 20, textAlign: 'center', gridColumn: '1/-1' } },
                      search ? 'no matches' : (showHidden ? 'no hidden apps' : 'no apps — click + add'))
                  : visibleApps.map(a => e(StartMenuTile, {
                      key: a.id, app: a, isFav: favs.has(a.id),
                      onLaunch:      () => { launch(a); onClose(); },
                      onToggleFav:   () => toggleFav(a.id),
                      onToggleHide:  () => toggleHide(a.id),
                      onRemove: a.source === 'user' ? () => removeUser(a.id) : null,
                    })),
            )
          : e('div', { className: 'sm-plugins-list' }, renderPluginsView()),
        e('div', { className: 'start-menu-divider' }),
        e('div', { className: 'start-menu-power' },
          powerActions.map(a => {
            const armed = armedId === a.id, busy = busyId === a.id;
            return e('button', {
              key: a.id,
              className: 'start-power-btn' + (armed ? ' armed' : ''),
              onClick: () => handlePower(a),
              disabled: !!busyId,
              title: a.confirm ? 'click twice to ' + a.label.toLowerCase() : a.label,
            },
              e('span', { className: 'start-power-glyph' }, a.glyph),
              e('span', null, armed ? '✓?' : (busy ? '…' : a.label)),
            );
          }),
        ),
      ),
    );
  }

  function SysDock({ startOpen, onToggleStart, settings }) {
    const [windows, setWindows] = useState([]);
    const [hoverHwnd, setHoverHwnd] = useState(null);
    const [confirmHwnd, setConfirmHwnd] = useState(null);
    const busyRef = useRef(false);
    const confirmTimer = useRef(null);
    const now = useNow(1000);

    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        if (busyRef.current) return;
        const api = window.dashboard && window.dashboard.windows;
        if (!api) return;
        try {
          const res = await api.list();
          if (cancelled) return;
          setWindows(res && Array.isArray(res.list) ? res.list : []);
        } catch {}
      };
      tick();
      const id = setInterval(tick, 3000);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    const focusWindow = async hwnd => {
      const api = window.dashboard && window.dashboard.windows;
      if (!api) return;
      busyRef.current = true;
      try { await api.focus(hwnd); } catch {}
      finally { setTimeout(() => { busyRef.current = false; }, 250); }
    };

    const closeWindow = hwnd => {
      if (confirmHwnd === hwnd) {
        setConfirmHwnd(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        const api = window.dashboard && window.dashboard.windows;
        if (api) api.close(hwnd).catch(() => {});
        setWindows(ws => ws.filter(w => String(w.hwnd) !== String(hwnd)));
        return;
      }
      setConfirmHwnd(hwnd);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmHwnd(null), 2500);
    };

    const minimizeWindow = hwnd => {
      const api = window.dashboard && window.dashboard.windows;
      if (api) api.minimize(hwnd).catch(() => {});
    };

    const fmtTime = d => d.toLocaleTimeString('en-US', { hour12: !!(settings && settings.clock12h), hour: '2-digit', minute: '2-digit' });
    const fmtDate = d => d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });

    return e('div', { className: 'sysdock' },
      e('button', {
        className: 'start-btn' + (startOpen ? ' active' : ''),
        onClick: onToggleStart,
        title: 'Start — apps & power options',
      },
        e('span', { className: 'start-glyph' }, '◈'),
        e('span', null, 'START'),
      ),
      e('div', { className: 'sysdock-sep' }),
      e('div', { className: 'sysdock-windows' },
        windows.length === 0
          ? e('span', { className: 'sysdock-no-wins' }, 'no open windows')
          : windows.map(w => {
              const hovered = hoverHwnd === w.hwnd;
              const armed   = confirmHwnd === w.hwnd;
              const rawTitle = w.title || w.name || '?';
              const label = rawTitle.length > 34 ? rawTitle.slice(0, 33) + '…' : rawTitle;
              return e('div', {
                key: w.hwnd,
                className: 'sysdock-chip' + (hovered ? ' hovered' : '') + (armed ? ' armed' : ''),
                onMouseEnter:   () => setHoverHwnd(w.hwnd),
                onMouseLeave:   () => { setHoverHwnd(null); if (!armed) setConfirmHwnd(null); },
                onClick:        () => focusWindow(w.hwnd),
                onContextMenu:  ev => { ev.preventDefault(); closeWindow(w.hwnd); },
                title: (w.name || '') + (w.title ? ' — ' + w.title : '') + ' · pid ' + w.pid,
              },
                w.iconDataUrl
                  ? e('img', { src: w.iconDataUrl, width: 16, height: 16, alt: '', style: { flexShrink: 0 } })
                  : e('span', { className: 'sysdock-chip-dot' }),
                e('span', { className: 'sysdock-chip-label' }, label),
                (hovered || armed) && e('div', { className: 'sysdock-chip-acts' },
                  e('button', { onClick: ev => { ev.stopPropagation(); minimizeWindow(w.hwnd); }, title: 'minimize' }, '_'),
                  e('button', {
                    className: armed ? 'armed' : '',
                    onClick: ev => { ev.stopPropagation(); closeWindow(w.hwnd); },
                    title: armed ? 'click again to close' : 'close (right-click also)',
                  }, armed ? '✓?' : '×'),
                ),
              );
            }),
      ),
      e('div', { className: 'sysdock-clock' },
        e('div', null, fmtTime(now)),
        e('div', { className: 'sysdock-clock-date' }, fmtDate(now)),
      ),
    );
  }

  // ---------- App ----------
  function App() {
    const [plugins, setPlugins] = useState([]);
    const [pluginsPath, setPluginsPath] = useState('');
    const [reloadKey, setReloadKey] = useState(0);
    const [layout, updateLayout, resetLayout] = useLayout(plugins);

    const [dragId, setDragId] = useState(null);
    const gridRef = useRef(null);
    const resizeRef = useRef(null); // mid-drag transient sizes { id, w, h }
    // Holds the id of the plugin that was just opened/restored. Cleared by the
    // "scroll on visible-change" effect once the widget is in the DOM.
    const pendingScrollIdRef = useRef(null);
    const [, forceTick] = useState(0);

    // Settings state
    const [settings, setSettings] = useState(loadSettings);
    const [autoStart, setAutoStart] = useState(false);
    const [fullScreen, setFullScreen] = useState(false);
    const [alwaysOnTop, setAlwaysOnTop] = useState(false);
    const [skinMode, setSkinModeState] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [version, setVersion] = useState('');
    const [packaged, setPackaged] = useState(false);
    const [updateStatus, setUpdateStatus] = useState({ state: 'idle' });
    const [disabledIds, setDisabledIds] = useState(loadDisabled);
    const [minimizedIds, setMinimizedIds] = useState(loadMinimized);
    const [startOpen, setStartOpen] = useState(false);
    const [customThemes, setCustomThemes] = useState(loadCustomThemes);
    const [maximizedId, setMaximizedId] = useState(null);

    // Find the widget with the given plugin id and scroll the grid so it's
    // centered. No-ops when the widget isn't (yet) in the DOM — callers also
    // set pendingScrollIdRef so the "visible changed" effect retries after
    // the next render.
    const scrollToPlugin = useCallback((id) => {
      const grid = gridRef.current;
      if (!grid || !id) return;
      const sel = `[data-plugin-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(id) : id}"]`;
      const el = grid.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, []);

    // Re-place a plugin at the first free zone, scanning row-major from
    // top-left. Called when a plugin transitions from hidden → visible so
    // it reliably appears at the top of the grid (the user's request).
    // Other widgets retain their positions; we only move the one being shown.
    const placeAtFirstFree = useCallback((id) => {
      updateLayout((prev) => {
        const newPlug = plugins.find((p) => p.id === id);
        if (!newPlug) return prev;
        const item = prev[id] || {};
        const w = Math.min(GRID_COLS, item.width || newPlug.defaultW || 1);
        const h = item.height || newPlug.defaultH || 1;
        // Visible plugins (other than the one being shown) — they keep their slots
        const others = plugins
          .filter((p) => p.id !== id && !disabledIds.has(p.id) && !minimizedIds.has(p.id))
          .map((p) => prev[p.id])
          .filter((p) => p && Number.isInteger(p.col) && Number.isInteger(p.row));
        const { col, row } = placeNext(others, w, h);
        return { ...prev, [id]: { ...item, col, row, width: w, height: h } };
      });
    }, [plugins, disabledIds, minimizedIds, updateLayout]);

    const togglePluginEnabled = useCallback((id) => {
      let wasDisabled = false;
      setDisabledIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) { wasDisabled = true; next.delete(id); }
        else next.add(id);
        saveDisabled(next);
        return next;
      });
      // Re-enabling a closed plugin clears any minimized state too
      setMinimizedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        saveMinimized(next);
        return next;
      });
      // Going hidden → visible: re-place at first free zone
      if (wasDisabled) placeAtFirstFree(id);
    }, [placeAtFirstFree]);

    const minimizePlugin = useCallback((id) => {
      setMinimizedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        saveMinimized(next);
        return next;
      });
    }, []);

    const restorePlugin = useCallback((id) => {
      setMinimizedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        saveMinimized(next);
        return next;
      });
      placeAtFirstFree(id);
      pendingScrollIdRef.current = id;
      scrollToPlugin(id);
    }, [placeAtFirstFree, scrollToPlugin]);

    // One-way "open": enable the plugin (if disabled) and restore it (if
    // minimized). Idempotent — clicking an already-open plugin is a no-op,
    // which is what the Dashboard Apps view in the start menu wants.
    const openPlugin = useCallback((id) => {
      let wasHidden = false;
      setDisabledIds((prev) => {
        if (!prev.has(id)) return prev;
        wasHidden = true;
        const next = new Set(prev);
        next.delete(id);
        saveDisabled(next);
        return next;
      });
      setMinimizedIds((prev) => {
        if (!prev.has(id)) return prev;
        wasHidden = true;
        const next = new Set(prev);
        next.delete(id);
        saveMinimized(next);
        return next;
      });
      if (wasHidden) placeAtFirstFree(id);
      // The widget may not be in the DOM yet (state-update batching), so the
      // immediate scroll attempt is a no-op for newly-opened plugins. Setting
      // pendingScrollIdRef makes the visible-change effect retry once the
      // widget mounts. For already-open plugins the immediate call wins.
      pendingScrollIdRef.current = id;
      scrollToPlugin(id);
    }, [placeAtFirstFree, scrollToPlugin]);

    // Closing from a widget header = disable the plugin
    const closePlugin = useCallback((id) => {
      setDisabledIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        saveDisabled(next);
        return next;
      });
      setMinimizedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        saveMinimized(next);
        return next;
      });
    }, []);

    const persistSettings = useCallback((next) => {
      setSettings(next);
      saveSettings(next);
    }, []);

    const saveCustomTheme = useCallback((name) => {
      setSettings((prev) => {
        const active = THEMES.find(t => t.id === prev.theme) || THEMES[0];
        const entry = {
          id: 'c:' + Date.now().toString(36),
          name,
          bg:     prev.bg     || active.bg,
          accent: prev.accent || active.accent,
          fg:     prev.fg     || active.fg,
        };
        setCustomThemes((cur) => {
          const next = [...cur, entry].slice(-MAX_CUSTOM_THEMES);
          saveCustomThemes(next);
          return next;
        });
        return prev;
      });
    }, []);

    const applyCustomTheme = useCallback((entry) => {
      setSettings((prev) => {
        const next = { ...prev, bg: entry.bg, accent: entry.accent, fg: entry.fg };
        saveSettings(next);
        return next;
      });
    }, []);

    const deleteCustomTheme = useCallback((id) => {
      setCustomThemes((cur) => {
        const next = cur.filter(t => t.id !== id);
        saveCustomThemes(next);
        return next;
      });
    }, []);

    const toggleMaximize = useCallback((id) => {
      setMaximizedId((cur) => (cur === id ? null : id));
    }, []);

    // Escape exits maximized mode (matches the title attribute hint).
    useEffect(() => {
      if (!maximizedId) return;
      const onKey = (ev) => { if (ev.key === 'Escape') setMaximizedId(null); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [maximizedId]);

    // If the maximized plugin gets disabled, minimized, or removed, drop the
    // maximized state so we don't end up with a phantom overlay.
    useEffect(() => {
      if (!maximizedId) return;
      const stillThere = plugins.some(p => p.id === maximizedId)
        && !disabledIds.has(maximizedId)
        && !minimizedIds.has(maximizedId);
      if (!stillThere) setMaximizedId(null);
    }, [plugins, disabledIds, minimizedIds, maximizedId]);

    const reload = useCallback(async () => {
      const next = await loadAllPlugins();
      setPlugins(next);
    }, []);

    useEffect(() => {
      window.dashboard.pluginsDirPath().then(setPluginsPath);
      window.dashboard.getAutoStart().then(setAutoStart).catch(() => {});
      window.dashboard.isFullScreen().then(setFullScreen).catch(() => {});
      window.dashboard.isAlwaysOnTop().then(setAlwaysOnTop).catch(() => {});
      window.dashboard.isSkinMode().then(setSkinModeState).catch(() => {});
      window.dashboard.appVersion().then(setVersion).catch(() => {});
      window.dashboard.appIsPackaged().then(setPackaged).catch(() => {});

      // Auto-update — pull cached status on mount, subscribe for live changes.
      let offUpdates = null;
      if (window.dashboard.updates) {
        window.dashboard.updates.getStatus().then(setUpdateStatus).catch(() => {});
        offUpdates = window.dashboard.updates.onStatus(setUpdateStatus);
      }

      reload();
      const offPlugins = window.dashboard.onPluginsChanged(() => setReloadKey((k) => k + 1));
      const offFs = window.dashboard.onFullScreenChange(setFullScreen);
      return () => {
        offPlugins && offPlugins();
        offFs && offFs();
        offUpdates && offUpdates();
      };
    }, [reload]);

    // Per-plugin remount counter — bumped when a remote-sync arrives for any
    // key starting with `plugin:<id>:`, OR when a remote note write/delete
    // arrives (for plugins that read notes from disk like scratchpad and
    // cognicore). Bumping changes the React key, which forces a remount so
    // the plugin's `useState(() => loadFromLocalStorage())` runs again with
    // the fresh value. Most plugins don't subscribe to storage events, so
    // this is the universal way to make them react to remote state changes.
    const [pluginVersions, setPluginVersions] = useState({});
    const bumpPluginVersion = useCallback((pluginId) => {
      if (!pluginId) return;
      setPluginVersions((prev) => ({ ...prev, [pluginId]: (prev[pluginId] || 0) + 1 }));
    }, []);
    // Map of vault name → list of plugin ids that read from it. Vault-changed
    // events bump those plugins' versions so they re-fetch from the host.
    // Cognicore is intentionally NOT here — it subscribes to vault.onChanged
    // itself and refreshes without losing editor state.
    const VAULT_READERS = {
      notes: ['notes', 'markdown-preview'],
    };

    // Keys for the plugin-folder feature (Settings → Plugins). Changing them
    // remotely needs to re-render the StartMenu (which reads them on each
    // render) so its grouped view stays in sync.
    const FOLDER_KEYS = ['dashboard:pluginFolders:v1', 'dashboard:pluginFolderMap:v1', 'dashboard:pluginFoldersCollapsed:v1'];

    // Listen for remote sync events. When a key we own React state for
    // changes (settings, custom themes), reload that state from localStorage
    // so the UI reflects the remote change immediately. For plugin-owned
    // keys, bump that plugin's version to force a remount.
    useEffect(() => {
      const onRemote = (ev) => {
        const key = ev && ev.detail && ev.detail.key;
        if (!key) return;
        if (key === SETTINGS_KEY)        setSettings(loadSettings());
        else if (key === CUSTOM_THEMES_KEY) setCustomThemes(loadCustomThemes());

        if (FOLDER_KEYS.indexOf(key) !== -1) forceTick((t) => t + 1);

        const m = key.match(/^plugin:([^:]+):/);
        if (m) bumpPluginVersion(m[1]);
      };
      window.addEventListener('dashboard:remote-sync', onRemote);

      // Vault changes (notes / cognicore content) — remount plugins that
      // display content from the affected vault. Plugins that subscribe to
      // dashboard.vault.onChanged themselves get a finer-grained refresh
      // and may not need a full remount; for the rest, the remount is the
      // only way to make them re-read.
      const offVault = window.dashboard.vault.onChanged((info) => {
        const vaultName = info && info.name;
        if (!vaultName) return;
        const readers = VAULT_READERS[vaultName] || [];
        for (const id of readers) bumpPluginVersion(id);
      });

      return () => {
        window.removeEventListener('dashboard:remote-sync', onRemote);
        offVault && offVault();
      };
    }, [bumpPluginVersion]);

    // ── First-run defaults ──────────────────────────────────────────────
    // On the very first launch after install, default the app to fullscreen
    // + skin mode, and disable every plugin. After this fires once we set a
    // sentinel in localStorage so subsequent launches respect whatever the
    // user has chosen since.
    //
    // We also short-circuit if any of the well-known persistence keys
    // already exist — that means the user has used the app before this
    // sentinel was introduced, and we shouldn't surprise them by clobbering
    // their fullscreen / plugin state.
    useEffect(() => {
      const hasPriorState =
        localStorage.getItem(FIRST_RUN_KEY) ||
        localStorage.getItem(SETTINGS_KEY) ||
        localStorage.getItem(DISABLED_KEY) ||
        localStorage.getItem(LAYOUT_KEY);
      if (hasPriorState) {
        // Make sure the sentinel exists so the next mount fast-paths through.
        if (!localStorage.getItem(FIRST_RUN_KEY)) localStorage.setItem(FIRST_RUN_KEY, '1');
        return;
      }

      // Mark complete IMMEDIATELY — skin mode below will recreate the window
      // and tear this renderer down. Without this flag set first we'd hit an
      // infinite first-run loop on every restart.
      localStorage.setItem(FIRST_RUN_KEY, '1');
      // Plugins haven't loaded yet at this point. Stash a pending flag that
      // the plugin-load effect (below) drains.
      localStorage.setItem(PENDING_DISABLE_ALL_KEY, '1');

      (async () => {
        try { await window.dashboard.setFullScreen(true); } catch {}
        // setSkinMode recreates the window and kills this renderer. Awaiting
        // ensures the IPC has at least dispatched before everything tears
        // down; the next renderer load will see the FIRST_RUN_KEY and the
        // pending-disable flag, finish the disable pass, then idle.
        try { await window.dashboard.setSkinMode(true); } catch {}
      })();
    }, []);

    // Drain the "disable all plugins on first run" flag once the plugin list
    // is actually available. Runs on the first mount where plugins.length
    // becomes non-zero — applies regardless of whether the disable was queued
    // moments ago (same renderer) or one boot ago (skin-mode window recreate).
    useEffect(() => {
      if (plugins.length === 0) return;
      if (!localStorage.getItem(PENDING_DISABLE_ALL_KEY)) return;
      const all = new Set(plugins.map(p => p.id));
      setDisabledIds(all);
      saveDisabled(all);
      localStorage.removeItem(PENDING_DISABLE_ALL_KEY);
    }, [plugins.length]);

    // Apply renderer-side settings to the DOM
    useEffect(() => {
      document.body.classList.toggle('no-scanlines', !settings.scanlines);
    }, [settings.scanlines]);

    useEffect(() => {
      document.body.dataset.theme = settings.theme || 'retro';
    }, [settings.theme]);

    useEffect(() => {
      // 'auto' = let the theme pick — clear the attribute so theme rules win
      if (!settings.font || settings.font === 'auto') delete document.body.dataset.font;
      else document.body.dataset.font = settings.font;
    }, [settings.font]);

    useEffect(() => {
      const triple = hexToRgbTriple(settings.accent);
      if (settings.accent && triple) {
        document.body.style.setProperty('--accent', settings.accent);
        document.body.style.setProperty('--accent-rgb', triple);
      } else {
        document.body.style.removeProperty('--accent');
        document.body.style.removeProperty('--accent-rgb');
      }
    }, [settings.accent]);

    // Background override — also derive --bg-elev / borders so widget surfaces
    // stay distinguishable from the page background. The shadeHex helper picks
    // a direction (toward white or black) based on the bg's luminosity.
    useEffect(() => {
      if (settings.bg) {
        document.body.style.setProperty('--bg', settings.bg);
        document.body.style.setProperty('--bg-elev', shadeHex(settings.bg, 10));
        document.body.style.setProperty('--border', shadeHex(settings.bg, 25));
        document.body.style.setProperty('--border-bright', shadeHex(settings.bg, 50));
      } else {
        document.body.style.removeProperty('--bg');
        document.body.style.removeProperty('--bg-elev');
        document.body.style.removeProperty('--border');
        document.body.style.removeProperty('--border-bright');
      }
    }, [settings.bg]);

    // Foreground override — covers default text plus the "bright" variant used
    // for emphasis. We don't touch --fg-dim; it stays theme-default.
    useEffect(() => {
      if (settings.fg) {
        document.body.style.setProperty('--fg', settings.fg);
        document.body.style.setProperty('--fg-bright', settings.fg);
      } else {
        document.body.style.removeProperty('--fg');
        document.body.style.removeProperty('--fg-bright');
      }
    }, [settings.fg]);

    useEffect(() => { if (reloadKey > 0) reload(); }, [reloadKey, reload]);

    // Layout-merged list — disabled and minimized plugins filtered out.
    // Sort by row then col for stable DOM order (helpful for keyboard tab).
    const visible = useMemo(() => {
      return plugins
        .filter((p) => !disabledIds.has(p.id) && !minimizedIds.has(p.id))
        .map((p) => {
          const l = layout[p.id] || { col: 0, row: 0, width: p.defaultW, height: p.defaultH };
          return {
            plugin: p,
            col:    l.col || 0,
            row:    l.row || 0,
            width:  l.width  || p.defaultW || 1,
            height: l.height || p.defaultH || 1,
          };
        })
        .sort((a, b) => (a.row - b.row) || (a.col - b.col));
    }, [plugins, layout, disabledIds, minimizedIds]);

    const minimizedList = useMemo(() =>
      plugins.filter((p) => minimizedIds.has(p.id) && !disabledIds.has(p.id)),
      [plugins, minimizedIds, disabledIds]);

    // ---------- Drag with snap-to-zone ----------
    // Free dragging: while dragging the widget visually follows the cursor.
    // On release the top-left snaps to the nearest grid cell. If the snap
    // position would overlap another widget, swap with that one widget (only
    // if exactly one is overlapped). If multiple, revert to original.

    const visibleRef = useRef(visible);
    useEffect(() => { visibleRef.current = visible; }, [visible]);

    // Scroll behavior keyed off the visible plugin list:
    //   - When nothing is visible, snap the grid to the top.
    //   - When openPlugin / restorePlugin queued an id, scroll to that widget
    //     after it has been placed in the DOM.
    useEffect(() => {
      const grid = gridRef.current;
      if (!grid) return;
      if (visible.length === 0) {
        grid.scrollTop = 0;
        pendingScrollIdRef.current = null;
        return;
      }
      const id = pendingScrollIdRef.current;
      if (!id) return;
      pendingScrollIdRef.current = null;
      scrollToPlugin(id);
    }, [visible, scrollToPlugin]);

    // Mid-drag transient state (cursor offset, snap target preview).
    // Stored in refs because the drag handler reads/updates them every
    // animation frame; we forceTick to repaint when the snap target changes.
    const dragRef = useRef(null); // { id, startCol, startRow, w, h, dx, dy, snapCol, snapRow, swapId }

    const onHeaderMouseDown = useCallback((id, ev) => {
      if (ev.button !== 0) return;
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'button' || tag === 'input' || tag === 'a') return;

      const item = visibleRef.current.find((v) => v.plugin.id === id);
      if (!item) return;
      const gridEl = gridRef.current;
      if (!gridEl) return;

      ev.preventDefault();
      setDragId(id);

      const gridRect = gridEl.getBoundingClientRect();
      const cellWidth  = (gridRect.width  - (GRID_COLS - 1) * GRID_GAP) / GRID_COLS;
      const cellHeight = CELL_HEIGHT;
      // Pointer offset within the widget itself, so dragging feels natural
      const widgetEl = ev.currentTarget.closest('.widget');
      const widgetRect = widgetEl ? widgetEl.getBoundingClientRect() : { left: ev.clientX, top: ev.clientY };
      const grabOffsetX = ev.clientX - widgetRect.left;
      const grabOffsetY = ev.clientY - widgetRect.top;

      dragRef.current = {
        id,
        startCol: item.col,
        startRow: item.row,
        w: item.width,
        h: item.height,
        gridLeft: gridRect.left,
        gridTop:  gridRect.top,
        cellWidth,
        cellHeight,
        grabOffsetX,
        grabOffsetY,
        ptrX: ev.clientX,
        ptrY: ev.clientY,
        snapCol: item.col,
        snapRow: item.row,
        swapId: null,
      };

      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';

      let moveRaf = null;
      const onMove = (e) => {
        if (!dragRef.current) return;
        dragRef.current.ptrX = e.clientX;
        dragRef.current.ptrY = e.clientY;
        if (moveRaf) return;
        moveRaf = requestAnimationFrame(() => {
          moveRaf = null;
          const d = dragRef.current;
          if (!d) return;
          // Snap target: pixel position of widget top-left → cell (col,row)
          const px = d.ptrX - d.gridLeft - d.grabOffsetX;
          const py = d.ptrY - d.gridTop  - d.grabOffsetY;
          // Round to nearest cell boundary instead of floor — gives "closest" snap.
          let col = Math.round(px / (d.cellWidth + GRID_GAP));
          let row = Math.round(py / (d.cellHeight + GRID_GAP));
          col = Math.max(0, Math.min(GRID_COLS - d.w, col));
          row = Math.max(0, row);

          // Detect swap target: a widget whose top-left == this snap pos
          // (most natural reading of "drop one tile onto another")
          let swapId = null;
          for (const v of visibleRef.current) {
            if (v.plugin.id === d.id) continue;
            if (v.col === col && v.row === row) { swapId = v.plugin.id; break; }
          }
          if (d.snapCol !== col || d.snapRow !== row || d.swapId !== swapId) {
            d.snapCol = col;
            d.snapRow = row;
            d.swapId = swapId;
            forceTick((t) => t + 1);
          }
        });
      };

      const onUp = (e) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;

        const d = dragRef.current;
        dragRef.current = null;
        setDragId(null);

        if (!d) return;
        const newCol = d.snapCol, newRow = d.snapRow;
        if (newCol === d.startCol && newRow === d.startRow) {
          forceTick((t) => t + 1);
          return; // no-op
        }

        // Build "everyone else" entries for collision check
        const others = visibleRef.current
          .filter((v) => v.plugin.id !== d.id)
          .map((v) => ({ id: v.plugin.id, col: v.col, row: v.row, width: v.width, height: v.height }));

        // Find widgets occupying the new placement area
        const overlapping = [];
        for (const p of others) {
          if (newCol < p.col + p.width && newCol + d.w > p.col &&
              newRow < p.row + p.height && newRow + d.h > p.row) {
            overlapping.push(p);
          }
        }

        if (overlapping.length === 0) {
          // Clean placement
          updateLayout((prev) => ({
            ...prev,
            [d.id]: { ...(prev[d.id] || {}), col: newCol, row: newRow, width: d.w, height: d.h },
          }));
        } else if (overlapping.length === 1) {
          // Swap: drop target's widget moves to this widget's old position.
          // We also verify the swap doesn't itself create new overlaps.
          const partner = overlapping[0];
          const partnerNewOverlaps = others.filter((p) =>
            p.id !== partner.id &&
            d.startCol < p.col + p.width && d.startCol + partner.width > p.col &&
            d.startRow < p.row + p.height && d.startRow + partner.height > p.row
          );
          if (partnerNewOverlaps.length > 0) {
            // Can't cleanly swap — revert
            forceTick((t) => t + 1);
            return;
          }
          if (d.startCol + partner.width > GRID_COLS) {
            forceTick((t) => t + 1);
            return;
          }
          updateLayout((prev) => ({
            ...prev,
            [d.id]: { ...(prev[d.id] || {}), col: newCol, row: newRow, width: d.w, height: d.h },
            [partner.id]: { ...(prev[partner.id] || {}), col: d.startCol, row: d.startRow },
          }));
        } else {
          // Multiple collisions — revert
          forceTick((t) => t + 1);
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }, [updateLayout]);

    // ---------- Resize ----------
    const onResizeStart = useCallback((id, ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const widgetEl = ev.currentTarget.closest('.widget');
      const item = visible.find((v) => v.plugin.id === id);
      if (!widgetEl || !item) return;

      const rect = widgetEl.getBoundingClientRect();
      const startW = item.width;
      const startH = item.height;
      // Solve for cellWidth from current pixel width (accounts for inter-cell gaps)
      const cellWidth = (rect.width - (startW - 1) * GRID_GAP) / startW;
      const cellHeight = CELL_HEIGHT;
      const startX = ev.clientX;
      const startY = ev.clientY;

      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';

      // With explicit grid placement, the widget can't grow past the right edge
      const widthCeiling = Math.min(MAX_W, GRID_COLS - item.col);
      const onMove = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const newPxW = startW * cellWidth + (startW - 1) * GRID_GAP + dx;
        const newPxH = startH * cellHeight + (startH - 1) * GRID_GAP + dy;
        const newW = Math.max(MIN_W, Math.min(widthCeiling,
          Math.round((newPxW + GRID_GAP) / (cellWidth + GRID_GAP))));
        const newH = Math.max(MIN_H, Math.min(MAX_H,
          Math.round((newPxH + GRID_GAP) / (cellHeight + GRID_GAP))));
        resizeRef.current = { id, w: newW, h: newH };
        forceTick((t) => t + 1);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const r = resizeRef.current;
        resizeRef.current = null;
        if (r) {
          updateLayout((prev) => ({
            ...prev,
            [r.id]: { ...(prev[r.id] || { order: 0 }), width: r.w, height: r.h },
          }));
        }
        forceTick((t) => t + 1);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }, [visible, updateLayout]);

    const okCount = plugins.filter((p) => !p.error).length;
    const errCount = plugins.length - okCount;

    return e(React.Fragment, null,
      // Top brand bar — hidden entirely while a widget is maximized so the
      // maximized plugin gets every available pixel above the SysDock.
      // The old "toolbar" strip below it (plugin count / drag hint / settings
      // button) was removed — settings now lives inside the start menu, and
      // the drag/resize affordances are surfaced in the widget hover state.
      !maximizedId && e('header', { className: 'topbar' },
        e('div', { className: 'brand' },
          e('span', { className: 'brand-mark' }, '◢ DASH'),
          e('span', { className: 'brand-sub' }, 'modular // v' + (version || '…')),
        ),
        e(Clock, { hour12: !!settings.clock12h }),
      ),
      e(SettingsPanel, {
        open: settingsOpen,
        onClose: () => setSettingsOpen(false),
        autoStart,
        onAutoStart: async (v) => {
          const result = await window.dashboard.setAutoStart(v);
          setAutoStart(result);
        },
        fullScreen,
        onFullScreen: async (v) => {
          await window.dashboard.setFullScreen(v);
          setFullScreen(v);
        },
        alwaysOnTop,
        onAlwaysOnTop: async (v) => {
          await window.dashboard.setAlwaysOnTop(v);
          setAlwaysOnTop(v);
        },
        skinMode,
        onSkinMode: async (v) => {
          if (v) {
            const ok = confirm(
              'Enable skin mode?\n\n' +
              '• Window pins behind all other apps as a custom desktop\n' +
              '• Disappears from taskbar and Alt-Tab\n' +
              '• Disables always-on-top automatically\n\n' +
              'Use Win+D (show desktop) to see the dashboard.\n' +
              'Use Ctrl+Shift+D to focus it.\n' +
              'Use Ctrl+Shift+Q to quit from anywhere.'
            );
            if (!ok) return;
          }
          await window.dashboard.setSkinMode(v);
          // Window will be recreated; this renderer is destroyed.
        },
        scanlines: settings.scanlines,
        onScanlines: (v) => persistSettings({ ...settings, scanlines: v }),
        clock12h: !!settings.clock12h,
        onClock12h: (v) => persistSettings({ ...settings, clock12h: v }),
        greeting: settings.greeting || '',
        onGreeting: (v) => persistSettings({ ...settings, greeting: v }),
        greetingEnabled: !!settings.greetingEnabled,
        onGreetingEnabled: (v) => persistSettings({ ...settings, greetingEnabled: v }),
        theme: settings.theme || 'retro',
        onTheme: (v) => persistSettings({ ...settings, theme: v }),
        font: settings.font || 'auto',
        onFont: (v) => persistSettings({ ...settings, font: v }),
        accent: settings.accent || null,
        onAccent: (v) => persistSettings({ ...settings, accent: v || null }),
        bg: settings.bg || null,
        onBg: (v) => persistSettings({ ...settings, bg: v || null }),
        fg: settings.fg || null,
        onFg: (v) => persistSettings({ ...settings, fg: v || null }),
        customThemes,
        onSaveCustom: saveCustomTheme,
        onApplyCustom: applyCustomTheme,
        onDeleteCustom: deleteCustomTheme,
        plugins,
        disabledIds,
        onTogglePluginEnabled: togglePluginEnabled,
        pluginCount: plugins.length,
        enabledCount: okCount - disabledIds.size,
        pluginsPath,
        version,
        packaged,
        updateStatus,
        onCheckUpdate: () => window.dashboard.updates && window.dashboard.updates.check(),
        onInstallUpdate: () => window.dashboard.updates && window.dashboard.updates.install(),
        onResetLayout: resetLayout,
        onReload: () => window.dashboard.reloadWindow(),
        onReloadPlugins: reload,
      }),
      e('main', {
        className: 'grid' + (maximizedId ? ' grid--maximized' : ''),
        ref: gridRef,
      },
        visible.length === 0
          ? (settings.greetingEnabled && (settings.greeting || '').trim()
              ? e('div', { className: 'greeting' },
                  e('span', { className: 'greeting-text' }, settings.greeting))
              : null)
          : [
              ...visible.map((v) => {
                const transient = resizeRef.current && resizeRef.current.id === v.plugin.id
                  ? resizeRef.current
                  : null;
                const drag = dragRef.current && dragRef.current.id === v.plugin.id ? dragRef.current : null;
                return e(Widget, {
                  key: v.plugin.id + ':' + reloadKey + ':' + (pluginVersions[v.plugin.id] || 0),
                  plugin: v.plugin,
                  col: v.col,
                  row: v.row,
                  w: transient ? transient.w : v.width,
                  h: transient ? transient.h : v.height,
                  isDragging: dragId === v.plugin.id,
                  isOver: dragRef.current && dragRef.current.swapId === v.plugin.id,
                  isMaximized: maximizedId === v.plugin.id,
                  dragOffset: drag ? {
                    dx: drag.ptrX - drag.gridLeft - drag.grabOffsetX -
                        (drag.startCol * (drag.cellWidth + GRID_GAP)),
                    dy: drag.ptrY - drag.gridTop  - drag.grabOffsetY -
                        (drag.startRow * (drag.cellHeight + GRID_GAP)),
                  } : null,
                  onHeaderMouseDown, onResizeStart,
                  onMinimize: minimizePlugin,
                  onClose: closePlugin,
                  onToggleMaximize: toggleMaximize,
                });
              }),
              dragRef.current && !maximizedId ? e('div', {
                key: '__snap_preview',
                className: 'snap-preview',
                style: {
                  gridColumn: `${dragRef.current.snapCol + 1} / span ${dragRef.current.w}`,
                  gridRow:    `${dragRef.current.snapRow + 1} / span ${dragRef.current.h}`,
                },
              }) : null,
            ],
      ),
      minimizedList.length > 0 && e('div', { className: 'dock' },
        e('span', { className: 'dock-label' }, '↑ minimized:'),
        ...minimizedList.map((p) =>
          e('button', {
            key: p.id,
            className: 'dock-chip',
            onClick: () => restorePlugin(p.id),
            onContextMenu: (ev) => { ev.preventDefault(); closePlugin(p.id); },
            title: `${p.name} — click to restore · right-click to close`,
          },
            e('span', { className: 'dock-icon' }, '▣'),
            e('span', null, p.name),
          )
        ),
      ),
      startOpen && e(StartMenu, {
        onClose: () => setStartOpen(false),
        plugins,
        disabledIds,
        minimizedIds,
        onOpenPlugin: openPlugin,
        onClosePlugin: closePlugin,
        onOpenSettings: () => { setStartOpen(false); setSettingsOpen(true); },
        updateStatus,
      }),
      e(SysDock, { startOpen, onToggleStart: () => setStartOpen(v => !v), settings }),
    );
  }

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(e(App));
})();
