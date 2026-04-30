// Browser — Multi-tab embedded Chromium with bookmarks, history, and
// private mode.
//
// Architecture
//   • One <webview> per tab; inactive tabs are display:none (state preserved).
//   • Tab subcomponent owns its webview ref + listeners; updates parent state
//     via callbacks. Parent keeps a Map<tabId, webviewElement> for imperative
//     control (back/forward/reload/loadURL).
//   • Private tabs use a non-persistent partition ("private-shared") shared
//     across all private tabs in the session — same model as Firefox's
//     private window. Closing the last private tab clears that partition's
//     in-memory state when the app exits.
//   • Persistent tabs (non-private) save their URLs across reloads so the
//     plugin restores your session.
//
// Requires webviewTag: true on the BrowserWindow (set in main.js).

const KEY = 'plugin:browser:state:v2';
const HISTORY_MAX = 500;
const PARTITION_NORMAL  = 'persist:dashboard-browser';
const PARTITION_PRIVATE = 'private-shared'; // no "persist:" prefix → in-memory only
const NEW_TAB_URL = 'about:blank';

// Match Electron 33's underlying Chromium (130). Older UA strings get
// flagged as "outdated browser" by some sites (notably Google).
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const SEARCH_ENGINES = {
  duckduckgo: { label: 'duckduckgo', url: 'https://duckduckgo.com/?q=' },
  google:     { label: 'google',     url: 'https://www.google.com/search?q=' },
  bing:       { label: 'bing',       url: 'https://www.bing.com/search?q=' },
  brave:      { label: 'brave',      url: 'https://search.brave.com/search?q=' },
};

// Letter-tile colors for bookmark tiles
const TILE_COLORS = ['var(--accent)', 'var(--accent-warm)', '#5eeaff', '#ff6bd6', 'var(--fg-bright)', '#ff9c39', '#a3ff7a'];

const DEFAULTS = {
  homeUrl: 'https://duckduckgo.com',
  searchEngine: 'duckduckgo',
  spoofChromeUA: true,
  showBookmarks: true,
  bookmarks: [
    { id: 'b1', title: 'DuckDuckGo', url: 'https://duckduckgo.com' },
    { id: 'b2', title: 'GitHub',     url: 'https://github.com' },
    { id: 'b3', title: 'Wikipedia',  url: 'https://www.wikipedia.org' },
  ],
  history: [],
  tabs: [{ id: 't0', url: 'https://duckduckgo.com', title: '', isPrivate: false }],
  activeId: 't0',
};

const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length > 0) return { ...DEFAULTS, ...raw };
  } catch {}
  // Migrate from v1 if present
  try {
    const v1 = JSON.parse(localStorage.getItem('plugin:browser:state:v1'));
    if (v1) {
      const homeUrl = v1.homeUrl || DEFAULTS.homeUrl;
      return {
        ...DEFAULTS,
        homeUrl,
        searchEngine: v1.searchEngine || DEFAULTS.searchEngine,
        spoofChromeUA: v1.spoofChromeUA != null ? v1.spoofChromeUA : DEFAULTS.spoofChromeUA,
        history: Array.isArray(v1.history) ? v1.history.slice(0, HISTORY_MAX) : [],
        tabs: [{ id: 't0', url: homeUrl, title: '', isPrivate: false }],
        activeId: 't0',
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULTS));
};

// Smart input parsing
const looksLikeUrl = (s) => {
  if (!s) return false;
  if (/^[a-z]+:\/\//i.test(s)) return true;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(s)) return true;
  if (/\s/.test(s)) return false;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return true;
  return false;
};

const parseInput = (input, engineKey) => {
  const s = (input || '').trim();
  if (!s) return null;
  if (/^[a-z]+:\/\//i.test(s)) return s;
  if (looksLikeUrl(s)) return 'https://' + s;
  const eng = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.duckduckgo;
  return eng.url + encodeURIComponent(s);
};

const niceUrl = (url) => {
  if (!url || url === 'about:blank') return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch { return url; }
};

const hostnameOf = (url) => {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
};

const tileFor = (url, title) => {
  const host = hostnameOf(url) || title || '?';
  const letter = (host[0] || '?').toUpperCase();
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) | 0;
  return { letter, color: TILE_COLORS[Math.abs(h) % TILE_COLORS.length] };
};

const ymd = (ms) => {
  const d = new Date(ms);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
};

// Group history by day for the panel
const groupHistoryByDay = (items) => {
  const groups = new Map();
  const today = ymd(Date.now());
  const yesterday = ymd(Date.now() - 86400000);
  for (const h of items) {
    const day = ymd(h.ts);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(h);
  }
  const result = [];
  for (const [day, list] of groups) {
    const label = day === today ? 'today' : day === yesterday ? 'yesterday' : day;
    result.push({ day, label, items: list });
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────
// Tab subcomponent — owns one webview + its event listeners
// ─────────────────────────────────────────────────────────────────
function Tab(props) {
  const {
    React, useEffect, useRef,
    tab, isActive,
    registerWebview,
    onUpdate, onAddHistory, onNewTab, onCloseTab,
    spoofChromeUA, stealthPreloadUrl,
  } = props;

  const wvRef = useRef(null);
  const updateRef = useRef(onUpdate);
  const historyRef = useRef(onAddHistory);
  const newTabRef = useRef(onNewTab);
  useEffect(() => { updateRef.current = onUpdate; }, [onUpdate]);
  useEffect(() => { historyRef.current = onAddHistory; }, [onAddHistory]);
  useEffect(() => { newTabRef.current = onNewTab; }, [onNewTab]);

  // One-time setup. tab.id and tab.isPrivate are stable for a given tab.
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    registerWebview(tab.id, wv);

    // Set initial src once mounted
    try {
      if (tab.url) wv.setAttribute('src', tab.url);
    } catch {}

    const onStartLoading = () => updateRef.current(tab.id, { loading: true, error: null });
    const onStopLoading = () => {
      try {
        const url = wv.getURL();
        const title = wv.getTitle();
        updateRef.current(tab.id, {
          loading: false,
          url,
          title,
          canBack: wv.canGoBack(),
          canFwd: wv.canGoForward(),
        });
        if (!tab.isPrivate && url && !/^about:blank/.test(url)) {
          historyRef.current(url, title);
        }
      } catch {}
    };
    const onNavigate = (e) => {
      if (e.url) updateRef.current(tab.id, { url: e.url });
      try {
        updateRef.current(tab.id, {
          canBack: wv.canGoBack(),
          canFwd: wv.canGoForward(),
        });
      } catch {}
    };
    const onTitle = (e) => updateRef.current(tab.id, { title: e.title || '' });
    const onFailLoad = (e) => {
      if (e.errorCode !== -3 && e.isMainFrame) {
        updateRef.current(tab.id, { loading: false, error: e.errorDescription + ' (' + e.errorCode + ')' });
      }
    };
    const onNewWindow = (e) => {
      if (e.preventDefault) e.preventDefault();
      // ctrl+click / middle-click / target=_blank → new tab
      // Direct user "open in new window" → also new tab (we don't have actual new windows)
      const inBackground = e.disposition === 'background-tab';
      newTabRef.current(e.url, tab.isPrivate, !inBackground);
    };
    const onDomReady = () => {
      try {
        updateRef.current(tab.id, {
          canBack: wv.canGoBack(),
          canFwd: wv.canGoForward(),
        });
      } catch {}
    };

    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFailLoad);
    wv.addEventListener('new-window', onNewWindow);
    wv.addEventListener('dom-ready', onDomReady);

    return () => {
      registerWebview(tab.id, null);
      try {
        wv.removeEventListener('did-start-loading', onStartLoading);
        wv.removeEventListener('did-stop-loading', onStopLoading);
        wv.removeEventListener('did-navigate', onNavigate);
        wv.removeEventListener('did-navigate-in-page', onNavigate);
        wv.removeEventListener('page-title-updated', onTitle);
        wv.removeEventListener('did-fail-load', onFailLoad);
        wv.removeEventListener('new-window', onNewWindow);
        wv.removeEventListener('dom-ready', onDomReady);
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attrs = {
    ref: wvRef,
    partition: tab.isPrivate ? PARTITION_PRIVATE : PARTITION_NORMAL,
    allowpopups: 'true',
    useragent: spoofChromeUA ? CHROME_UA : undefined,
    webpreferences: 'contextIsolation=yes,nodeIntegration=no',
    // AutomationControlled is the Blink feature that exposes navigator.webdriver
    // and other "this is an automated browser" signals. Disabling it makes
    // the webview look more like a normal Chrome window to sites that probe
    // for embedded/automated browsers (Google sign-in, Cloudflare, etc).
    disableblinkfeatures: 'AutomationControlled',
    style: {
      width: '100%',
      height: '100%',
      display: isActive ? 'inline-flex' : 'none',
    },
  };
  if (stealthPreloadUrl) attrs.preload = stealthPreloadUrl;
  return React.createElement('webview', attrs);
}

// ─────────────────────────────────────────────────────────────────
// Plugin manifest
// ─────────────────────────────────────────────────────────────────
export default {
  id: 'browser',
  name: 'Browser',
  width: 3,
  height: 4,
  component: ({ React, useState, useEffect, useRef, useMemo, useCallback }) => {
    const [state, setState] = useState(loadState);
    const [urlInput, setUrlInput] = useState('');
    const [supported, setSupported] = useState(true);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [historyQuery, setHistoryQuery] = useState('');

    const tabsWebviews = useRef(new Map()); // tabId -> webview element
    const urlInputRef = useRef(null);
    const stateRef = useRef(state);
    const [toast, setToast] = useState(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const confirmResetTimer = useRef(null);
    useEffect(() => { stateRef.current = state; }, [state]);

    // Configure the partitions once at mount: set the spoofed UA at session
    // level (so it's applied to *every* HTTP request, not just the navigator
    // string) and strip Electron's X-Requested-With header.
    useEffect(() => {
      const api = window.dashboard && window.dashboard.browser;
      if (!api || !api.configurePartition) return;
      const ua = state.spoofChromeUA ? CHROME_UA : null;
      api.configurePartition(PARTITION_NORMAL, ua).catch(() => {});
      api.configurePartition(PARTITION_PRIVATE, ua).catch(() => {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.spoofChromeUA]);

    // Load stealth preload URL once. Webviews use this as their `preload`
    // attribute to inject anti-detection overrides into every page. Initial
    // value is `null` (= "still loading"); resolves to a string (URL or '')
    // so tabs always end up mounting whether stealth is available or not.
    const [stealthPreloadUrl, setStealthPreloadUrl] = useState(null);
    useEffect(() => {
      const api = window.dashboard && window.dashboard.browser;
      if (!api || !api.getStealthPreloadUrl) {
        setStealthPreloadUrl('');
        return;
      }
      api.getStealthPreloadUrl()
        .then((url) => setStealthPreloadUrl(url || ''))
        .catch(() => setStealthPreloadUrl(''));
    }, []);

    const flashToast = (msg, kind) => {
      setToast({ msg, kind: kind || 'ok' });
      setTimeout(() => setToast(null), 1800);
    };

    // Persist (skip private tabs from saved state — only retain public sessions)
    useEffect(() => {
      const id = setTimeout(() => {
        const persistable = {
          ...state,
          tabs: state.tabs.filter((t) => !t.isPrivate).map((t) => ({
            id: t.id,
            url: t.url || '',
            title: t.title || '',
            isPrivate: false,
          })),
        };
        // Ensure activeId points at a kept tab; if not, fall back to first
        if (!persistable.tabs.find((t) => t.id === persistable.activeId)) {
          persistable.activeId = persistable.tabs[0] ? persistable.tabs[0].id : null;
        }
        try { localStorage.setItem(KEY, JSON.stringify(persistable)); } catch {}
      }, 250);
      return () => clearTimeout(id);
    }, [state]);

    // Detect webview support
    useEffect(() => {
      if (typeof customElements !== 'undefined' && !customElements.get('webview')) {
        setSupported(false);
      }
    }, []);

    // Sync URL bar to active tab when tab switches or active tab navigates
    const activeTab = state.tabs.find((t) => t.id === state.activeId);
    useEffect(() => {
      if (!activeTab) return;
      if (document.activeElement !== urlInputRef.current) {
        setUrlInput(activeTab.url || '');
      }
    }, [state.activeId, activeTab && activeTab.url]);

    // Stable callbacks for Tab subcomponents
    const registerWebview = useCallback((tabId, el) => {
      if (el) tabsWebviews.current.set(tabId, el);
      else tabsWebviews.current.delete(tabId);
    }, []);

    const updateTab = useCallback((tabId, patch) => {
      setState((s) => ({
        ...s,
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, ...patch } : t),
      }));
    }, []);

    const addHistory = useCallback((url, title) => {
      if (!url) return;
      setState((s) => {
        const last = s.history[0];
        // Dedupe consecutive same-URL hits within 30s
        if (last && last.url === url && Date.now() - last.ts < 30000) return s;
        return {
          ...s,
          history: [{ url, title: title || '', ts: Date.now() }, ...s.history].slice(0, HISTORY_MAX),
        };
      });
    }, []);

    // Tab management
    const newTab = useCallback((url, isPrivate, focus = true) => {
      const id = newId('t');
      const targetUrl = url || stateRef.current.homeUrl;
      setState((s) => ({
        ...s,
        tabs: [...s.tabs, { id, url: targetUrl, title: '', isPrivate: !!isPrivate }],
        activeId: focus ? id : s.activeId,
      }));
    }, []);

    const closeTab = useCallback((tabId) => {
      setState((s) => {
        if (s.tabs.length <= 1) {
          // Last tab — replace with a fresh blank one rather than empty UI
          const id = newId('t');
          return {
            ...s,
            tabs: [{ id, url: s.homeUrl, title: '', isPrivate: false }],
            activeId: id,
          };
        }
        const idx = s.tabs.findIndex((t) => t.id === tabId);
        const tabs = s.tabs.filter((t) => t.id !== tabId);
        let activeId = s.activeId;
        if (activeId === tabId) {
          // Pick neighbor: the one at the same index (next), else previous
          activeId = tabs[Math.min(idx, tabs.length - 1)].id;
        }
        return { ...s, tabs, activeId };
      });
    }, []);

    const switchTab = (tabId) => setState((s) => ({ ...s, activeId: tabId }));

    // Navigation methods on the active tab
    const navigate = (input) => {
      const url = parseInput(input, stateRef.current.searchEngine);
      if (!url) return;
      const wv = tabsWebviews.current.get(stateRef.current.activeId);
      if (wv && wv.loadURL) {
        try { wv.loadURL(url); } catch (e) { console.error('loadURL', e); }
      } else if (wv) {
        try { wv.setAttribute('src', url); } catch {}
      }
      setShowSuggestions(false);
    };

    const back = () => {
      const wv = tabsWebviews.current.get(state.activeId);
      try { if (wv && wv.canGoBack()) wv.goBack(); } catch {}
    };
    const forward = () => {
      const wv = tabsWebviews.current.get(state.activeId);
      try { if (wv && wv.canGoForward()) wv.goForward(); } catch {}
    };
    const reload = () => {
      const wv = tabsWebviews.current.get(state.activeId);
      try {
        if (activeTab && activeTab.loading) wv.stop();
        else if (wv) wv.reload();
      } catch {}
    };
    const home = () => navigate(state.homeUrl);

    const openExternal = () => {
      if (!activeTab || !activeTab.url) return;
      try {
        if (window.dashboard && window.dashboard.shell && window.dashboard.shell.openExternal) {
          window.dashboard.shell.openExternal(activeTab.url);
        }
      } catch {}
    };

    const openDevTools = () => {
      const wv = tabsWebviews.current.get(state.activeId);
      try { wv && wv.openDevTools(); } catch {}
    };

    // Bookmarks
    const addBookmark = () => {
      if (!activeTab || !activeTab.url || activeTab.url === 'about:blank') return;
      // Skip if already bookmarked
      if (state.bookmarks.some((b) => b.url === activeTab.url)) return;
      setState((s) => ({
        ...s,
        bookmarks: [...s.bookmarks, {
          id: newId('b'),
          title: activeTab.title || hostnameOf(activeTab.url) || activeTab.url,
          url: activeTab.url,
        }],
      }));
    };
    const removeBookmark = (id) => {
      setState((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
    };
    const toggleBookmarks = () => setState((s) => ({ ...s, showBookmarks: !s.showBookmarks }));

    const isCurrentBookmarked = activeTab && state.bookmarks.some((b) => b.url === activeTab.url);

    // History
    const clearHistory = () => setState((s) => ({ ...s, history: [] }));
    const removeHistoryItem = (ts) => setState((s) => ({ ...s, history: s.history.filter((h) => h.ts !== ts) }));

    // Cache / cookies / storage clearing — touches the actual webview session
    const clearCache = async () => {
      const api = window.dashboard && window.dashboard.browser;
      if (!api || !api.clearCache) { flashToast('host API unavailable', 'err'); return; }
      const r1 = await api.clearCache(PARTITION_NORMAL);
      const r2 = await api.clearCache(PARTITION_PRIVATE);
      if (r1 && r1.ok && r2 && r2.ok) flashToast('cache cleared');
      else flashToast((r1 && r1.error) || (r2 && r2.error) || 'failed', 'err');
    };

    const clearCookies = async () => {
      const api = window.dashboard && window.dashboard.browser;
      if (!api || !api.clearStorage) { flashToast('host API unavailable', 'err'); return; }
      const opts = { storages: ['cookies'] };
      const r1 = await api.clearStorage(PARTITION_NORMAL, opts);
      const r2 = await api.clearStorage(PARTITION_PRIVATE, opts);
      // After clearing cookies, reload the active tab so the user sees logged-out state
      const wv = tabsWebviews.current.get(stateRef.current.activeId);
      if (wv) try { wv.reload(); } catch {}
      if (r1 && r1.ok && r2 && r2.ok) flashToast('cookies cleared · logged out');
      else flashToast((r1 && r1.error) || (r2 && r2.error) || 'failed', 'err');
    };

    const resetEverything = async () => {
      if (!confirmReset) {
        setConfirmReset(true);
        if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
        confirmResetTimer.current = setTimeout(() => setConfirmReset(false), 3000);
        return;
      }
      setConfirmReset(false);
      if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
      const api = window.dashboard && window.dashboard.browser;
      if (!api) { flashToast('host API unavailable', 'err'); return; }
      // Clear EVERYTHING for both partitions (cache + cookies + localStorage +
      // indexedDB + service workers + cache storage)
      await api.clearCache(PARTITION_NORMAL).catch(() => {});
      await api.clearCache(PARTITION_PRIVATE).catch(() => {});
      await api.clearStorage(PARTITION_NORMAL).catch(() => {});
      await api.clearStorage(PARTITION_PRIVATE).catch(() => {});
      // Reset bookmarks + history too
      setState((s) => ({ ...s, history: [] }));
      // Reload active tab
      const wv = tabsWebviews.current.get(stateRef.current.activeId);
      if (wv) try { wv.reload(); } catch {}
      flashToast('full reset — fresh slate');
    };

    // URL bar handlers
    const onUrlSubmit = (e) => {
      e.preventDefault();
      navigate(urlInput);
    };

    // Ctrl+L focuses the URL bar
    useEffect(() => {
      const onKey = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
          if (urlInputRef.current) {
            e.preventDefault();
            urlInputRef.current.focus();
            urlInputRef.current.select();
          }
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
          e.preventDefault();
          newTab(undefined, false, true);
        } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          newTab(undefined, true, true);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
          e.preventDefault();
          if (stateRef.current.activeId) closeTab(stateRef.current.activeId);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
          e.preventDefault();
          setShowHistory((h) => !h);
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [newTab, closeTab]);

    // URL-bar autocomplete: top history matches
    const suggestions = useMemo(() => {
      const q = urlInput.trim().toLowerCase();
      if (!q) return state.history.slice(0, 6);
      return state.history.filter((h) =>
        h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)
      ).slice(0, 6);
    }, [urlInput, state.history]);

    const filteredHistory = useMemo(() => {
      const q = historyQuery.trim().toLowerCase();
      if (!q) return state.history;
      return state.history.filter((h) =>
        h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)
      );
    }, [historyQuery, state.history]);

    const groupedHistory = useMemo(() => groupHistoryByDay(filteredHistory), [filteredHistory]);

    // ─────────── Render ───────────
    if (!supported) {
      return (
        <div className="p-col" style={{
          height: '100%', alignItems: 'center', justifyContent: 'center',
          color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 11, padding: 16, textAlign: 'center',
        }}>
          <div style={{ marginBottom: 8 }}>webview tag not enabled</div>
          <div style={{ fontSize: 10 }}>
            set <code style={{ color: 'var(--accent)' }}>webviewTag: true</code> in
            main.js webPreferences and restart
          </div>
        </div>
      );
    }

    return (
      <div className="p-col" style={{ height: '100%', gap: 4, position: 'relative' }}>
        {/* Tab strip */}
        <div style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 2,
          minHeight: 24,
          paddingBottom: 2,
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto',
        }}>
          {state.tabs.map((tab) => {
            const isActive = tab.id === state.activeId;
            const isPrivate = tab.isPrivate;
            const tile = tab.url ? tileFor(tab.url, tab.title) : null;
            return (
              <div
                key={tab.id}
                onClick={() => switchTab(tab.id)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}
                title={(tab.title || hostnameOf(tab.url) || 'new tab') + (isPrivate ? ' · private' : '')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 4px 2px 6px',
                  background: isActive
                    ? (isPrivate ? 'rgba(255,107,214,0.12)' : 'rgba(var(--accent-rgb),0.08)')
                    : 'transparent',
                  border: '1px solid ' + (isActive
                    ? (isPrivate ? '#ff6bd6' : 'var(--accent)')
                    : 'var(--border-bright)'),
                  borderBottom: isActive ? '1px solid transparent' : '1px solid var(--border-bright)',
                  borderRadius: '3px 3px 0 0',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: isActive ? 'var(--fg-bright)' : 'var(--fg-dim)',
                  cursor: 'pointer',
                  minWidth: 60,
                  maxWidth: 160,
                  flexShrink: 0,
                }}
              >
                {isPrivate ? (
                  <span title="private" style={{
                    display: 'inline-block',
                    width: 8, height: 8, borderRadius: 4,
                    background: '#ff6bd6',
                    boxShadow: '0 0 4px #ff6bd6',
                    flexShrink: 0,
                  }} />
                ) : tile && tab.url && tab.url !== 'about:blank' ? (
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center',
                    width: 12, height: 12, borderRadius: 2,
                    background: tile.color,
                    color: 'var(--bg)',
                    fontSize: 8, fontWeight: 700,
                    flexShrink: 0,
                  }}>{tile.letter}</span>
                ) : (
                  <span style={{
                    display: 'inline-block',
                    width: 8, height: 8, borderRadius: 4,
                    background: tab.loading ? 'var(--accent)' : 'var(--border-bright)',
                    flexShrink: 0,
                  }} />
                )}
                <span style={{
                  flex: 1, minWidth: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  fontStyle: tab.loading ? 'italic' : 'normal',
                }}>
                  {tab.title || (tab.url && tab.url !== 'about:blank' ? hostnameOf(tab.url) : 'new tab')}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  title="close (middle-click works too)"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--fg-dim)',
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: '0 3px',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >×</button>
              </div>
            );
          })}
          <button
            onClick={() => newTab(undefined, false, true)}
            title="new tab (Ctrl+T)"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-bright)',
              borderRadius: '3px 3px 0 0',
              color: 'var(--fg-dim)',
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              fontSize: 14,
              padding: '0 8px',
              flexShrink: 0,
            }}
          >+</button>
          <button
            onClick={() => newTab(undefined, true, true)}
            title="new private tab (Ctrl+Shift+P)"
            style={{
              background: 'transparent',
              border: '1px dashed #ff6bd6',
              borderRadius: '3px 3px 0 0',
              color: '#ff6bd6',
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              fontSize: 9,
              padding: '0 6px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}
          >+ priv</button>
        </div>

        {/* Toolbar */}
        <div className="p-row" style={{ alignItems: 'center', gap: 3 }}>
          <button onClick={back} disabled={!activeTab || !activeTab.canBack} title="back" style={navBtn(activeTab && activeTab.canBack)}>‹</button>
          <button onClick={forward} disabled={!activeTab || !activeTab.canFwd} title="forward" style={navBtn(activeTab && activeTab.canFwd)}>›</button>
          <button onClick={reload} title={activeTab && activeTab.loading ? 'stop' : 'reload'} style={navBtn(true)}>
            {activeTab && activeTab.loading ? '×' : '↻'}
          </button>
          <button onClick={home} title="home" style={navBtn(true)}>⌂</button>

          {/* URL bar */}
          <form onSubmit={onUrlSubmit} style={{ flex: 1, position: 'relative' }}>
            <input
              ref={urlInputRef}
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setShowSuggestions(true); }}
              onFocus={(e) => { e.target.select(); setShowSuggestions(true); }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.target.blur(); setShowSuggestions(false); } }}
              placeholder="search or enter URL · Ctrl+L"
              spellCheck={false}
              className="p-input"
              style={{
                width: '100%', fontSize: 11,
                paddingLeft: activeTab && activeTab.loading ? 22 : 8,
                fontFamily: 'var(--mono)',
                color: looksLikeUrl(urlInput) || /^[a-z]+:\/\//i.test(urlInput) ? 'var(--accent)' : 'var(--fg)',
                borderColor: activeTab && activeTab.isPrivate ? '#ff6bd6' : undefined,
              }}
            />
            {activeTab && activeTab.loading && (
              <span style={{
                position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)',
                fontFamily: 'var(--mono)', fontSize: 10,
                color: 'var(--accent)', textShadow: 'var(--glow)',
              }}>●</span>
            )}
            {/* Autocomplete dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0, right: 0,
                zIndex: 30,
                background: '#0a140a',
                border: '1px solid var(--border-bright)',
                borderRadius: 3,
                boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
                maxHeight: 200, overflowY: 'auto',
              }}>
                {suggestions.map((h, i) => (
                  <div
                    key={i}
                    onMouseDown={(e) => { e.preventDefault(); navigate(h.url); }}
                    style={{
                      padding: '4px 8px',
                      cursor: 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 11,
                      borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none',
                    }}
                  >
                    <div style={{ color: 'var(--fg-bright)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {h.title || hostnameOf(h.url)}
                    </div>
                    <div style={{ color: 'var(--fg-dim)', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {niceUrl(h.url)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </form>

          <button
            onClick={addBookmark}
            disabled={!activeTab || activeTab.isPrivate}
            title={activeTab && activeTab.isPrivate ? "can't bookmark from private tab" : (isCurrentBookmarked ? 'already bookmarked' : 'add bookmark')}
            style={{
              ...navBtn(activeTab && !activeTab.isPrivate),
              color: isCurrentBookmarked ? 'var(--accent-warm)' : (activeTab && !activeTab.isPrivate ? 'var(--fg-dim)' : 'rgba(111,154,111,0.4)'),
              textShadow: isCurrentBookmarked ? '0 0 4px var(--accent-warm)' : 'none',
            }}
          >★</button>
          <button
            onClick={() => setShowHistory((h) => !h)}
            title="history (Ctrl+H)"
            style={{ ...navBtn(true), color: showHistory ? 'var(--accent)' : 'var(--fg-dim)' }}
          >▤</button>
          <button onClick={openExternal} title="open in default browser" style={navBtn(activeTab && !!activeTab.url)}>↗</button>
          <button onClick={openDevTools} title="webview devtools" style={navBtn(true)}>{'<>'}</button>
          <button
            onClick={() => setShowSettings((s) => !s)}
            title="settings"
            style={{ ...navBtn(true), color: showSettings ? 'var(--accent)' : 'var(--fg-dim)' }}
          >⚙</button>
        </div>

        {/* Bookmarks bar */}
        {state.showBookmarks && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            padding: '2px 0',
            overflowX: 'auto',
            borderBottom: '1px solid var(--border)',
          }}>
            {state.bookmarks.length === 0 && (
              <span className="p-dim" style={{ fontSize: 9, padding: '0 4px' }}>
                ★ to add a bookmark
              </span>
            )}
            {state.bookmarks.map((b) => {
              const tile = tileFor(b.url, b.title);
              return (
                <div
                  key={b.id}
                  onClick={() => navigate(b.url)}
                  onContextMenu={(e) => { e.preventDefault(); removeBookmark(b.id); }}
                  title={b.url + ' · right-click to remove'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '2px 6px',
                    background: 'rgba(var(--accent-rgb),0.02)',
                    border: '1px solid var(--border)',
                    borderRadius: 2,
                    cursor: 'pointer',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--fg)',
                    flexShrink: 0,
                    maxWidth: 140,
                  }}
                >
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center',
                    width: 12, height: 12, borderRadius: 2,
                    background: tile.color,
                    color: 'var(--bg)',
                    fontSize: 8, fontWeight: 700,
                    flexShrink: 0,
                  }}>{tile.letter}</span>
                  <span style={{
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{b.title}</span>
                </div>
              );
            })}
            <span style={{ flex: 1 }} />
            <button
              onClick={toggleBookmarks}
              title="hide bookmark bar"
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--fg-dim)', cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 11,
                padding: '0 4px',
                flexShrink: 0,
              }}
            >▴</button>
          </div>
        )}
        {!state.showBookmarks && (
          <button
            onClick={toggleBookmarks}
            title="show bookmark bar"
            style={{
              alignSelf: 'flex-start',
              background: 'transparent', border: 'none',
              color: 'var(--fg-dim)', cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '0 4px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >▾ bookmarks</button>
        )}

        {/* Settings panel */}
        {showSettings && (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 3, padding: 6,
            display: 'flex', flexDirection: 'column', gap: 4,
            fontSize: 11,
          }}>
            <span className="p-label" style={{ fontSize: 9 }}>home URL</span>
            <input
              value={state.homeUrl}
              onChange={(e) => setState((s) => ({ ...s, homeUrl: e.target.value }))}
              spellCheck={false}
              className="p-input"
              style={{ fontSize: 11 }}
            />
            <span className="p-label" style={{ fontSize: 9, marginTop: 4 }}>search engine</span>
            <select
              value={state.searchEngine}
              onChange={(e) => setState((s) => ({ ...s, searchEngine: e.target.value }))}
              className="p-input"
              style={{ fontSize: 11 }}
            >
              {Object.entries(SEARCH_ENGINES).map(([id, e]) => (
                <option key={id} value={id}>{e.label}</option>
              ))}
            </select>
            <label className="p-row" style={{ alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={state.spoofChromeUA}
                onChange={(e) => setState((s) => ({ ...s, spoofChromeUA: e.target.checked }))}
              />
              <span>spoof Chrome user-agent</span>
              <span className="p-dim" style={{ fontSize: 9 }}>(takes effect on next tab)</span>
            </label>
            <label className="p-row" style={{ alignItems: 'center', gap: 6, fontSize: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={state.showBookmarks}
                onChange={(e) => setState((s) => ({ ...s, showBookmarks: e.target.checked }))}
              />
              <span>show bookmark bar</span>
            </label>
            <div className="p-row" style={{ marginTop: 6, gap: 4 }}>
              <span className="p-dim" style={{ fontSize: 9, flex: 1 }}>
                history: {state.history.length}/{HISTORY_MAX} · bookmarks: {state.bookmarks.length}
              </span>
              <button className="p-btn" onClick={clearHistory} style={{ fontSize: 10, padding: '2px 8px' }}>clear history</button>
            </div>

            {/* Site data controls — these touch the actual Chromium session */}
            <span className="p-label" style={{ fontSize: 9, marginTop: 8 }}>site data</span>
            <div className="p-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              <button
                className="p-btn"
                onClick={clearCache}
                title="clear HTTP cache (keeps cookies / login state)"
                style={{ fontSize: 10, padding: '2px 8px' }}
              >clear cache</button>
              <button
                className="p-btn"
                onClick={clearCookies}
                title="clear cookies (logs you out everywhere)"
                style={{ fontSize: 10, padding: '2px 8px' }}
              >clear cookies</button>
              <button
                onClick={resetEverything}
                title="cache + cookies + localStorage + indexedDB + service workers"
                style={{
                  background: confirmReset ? 'rgba(255,107,107,0.15)' : 'transparent',
                  border: '1px solid ' + (confirmReset ? 'var(--danger)' : 'var(--border-bright)'),
                  color: confirmReset ? 'var(--danger)' : 'var(--fg-dim)',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  padding: '2px 8px', borderRadius: 2, cursor: 'pointer',
                  fontWeight: confirmReset ? 700 : 400,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                }}
              >{confirmReset ? '✓ confirm reset' : 'reset all'}</button>
            </div>
            <div className="p-dim" style={{ fontSize: 9, lineHeight: 1.4 }}>
              clears for both normal & private partitions. "reset all" also wipes localStorage, indexedDB, and service workers — full fresh-install behavior.
            </div>

            <div className="p-dim" style={{ fontSize: 9, marginTop: 6, lineHeight: 1.4 }}>
              shortcuts: Ctrl+T new · Ctrl+Shift+P private · Ctrl+W close · Ctrl+L url · Ctrl+H history
            </div>
          </div>
        )}

        {/* Toast — sits over the webview, doesn't catch clicks */}
        {toast && (
          <div style={{
            position: 'absolute',
            bottom: 22, left: '50%',
            transform: 'translateX(-50%)',
            padding: '4px 12px',
            background: toast.kind === 'err' ? 'rgba(255,107,107,0.15)' : 'rgba(var(--accent-rgb),0.12)',
            color: toast.kind === 'err' ? 'var(--danger)' : 'var(--accent)',
            border: '1px solid ' + (toast.kind === 'err' ? 'var(--danger)' : 'var(--accent)'),
            borderRadius: 3,
            fontFamily: 'var(--mono)', fontSize: 11,
            textShadow: toast.kind === 'err' ? 'none' : 'var(--glow)',
            pointerEvents: 'none',
            zIndex: 50,
          }}>{toast.msg}</div>
        )}

        {/* Webview area + history overlay */}
        <div style={{
          flex: 1, minHeight: 0,
          position: 'relative',
          background: '#fff',
          border: '1px solid ' + (activeTab && activeTab.isPrivate ? '#ff6bd6' : 'var(--border-bright)'),
          borderRadius: 3,
          overflow: 'hidden',
        }}>
          {/* Render every tab — only active is visible */}
          {/* Don't mount until we know whether stealth is available, otherwise
              the first webview spawns without it and stays unaffected. */}
          {stealthPreloadUrl !== null && state.tabs.map((tab) => (
            <Tab
              key={tab.id}
              React={React}
              useEffect={useEffect}
              useRef={useRef}
              tab={tab}
              isActive={tab.id === state.activeId}
              registerWebview={registerWebview}
              onUpdate={updateTab}
              onAddHistory={addHistory}
              onNewTab={newTab}
              onCloseTab={closeTab}
              spoofChromeUA={state.spoofChromeUA}
              stealthPreloadUrl={stealthPreloadUrl}
            />
          ))}

          {/* Private mode banner */}
          {activeTab && activeTab.isPrivate && (
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0,
              padding: '3px 8px',
              background: 'rgba(255,107,214,0.85)',
              color: 'var(--bg)',
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.16em', textTransform: 'uppercase',
              textAlign: 'center',
              pointerEvents: 'none',
              zIndex: 10,
            }}>● private mode · history & cookies are not saved</div>
          )}

          {/* Tab error */}
          {activeTab && activeTab.error && (
            <div style={{
              position: 'absolute', bottom: 4, left: 4, right: 4,
              padding: '4px 8px',
              background: 'rgba(255,107,107,0.92)',
              color: 'var(--bg)',
              border: '1px solid var(--danger)',
              borderRadius: 2,
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              zIndex: 10,
            }}>! {activeTab.error}</div>
          )}

          {/* History overlay */}
          {showHistory && (
            <div style={{
              position: 'absolute', inset: 0,
              background: '#0a140a',
              display: 'flex', flexDirection: 'column',
              zIndex: 20,
            }}>
              <div className="p-row" style={{
                alignItems: 'center', gap: 6,
                padding: '6px 8px',
                borderBottom: '1px solid var(--border-bright)',
              }}>
                <span className="p-label">history · {state.history.length}</span>
                <input
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="search history…"
                  spellCheck={false}
                  className="p-input"
                  autoFocus
                  style={{ flex: 1, fontSize: 11 }}
                />
                <button className="p-btn" onClick={clearHistory} style={{ fontSize: 10, padding: '2px 8px' }}>clear all</button>
                <button
                  onClick={() => setShowHistory(false)}
                  style={{
                    background: 'transparent', border: 'none',
                    color: 'var(--fg-dim)', cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 14, padding: '0 4px',
                  }}
                >×</button>
              </div>
              <div style={{
                flex: 1, overflowY: 'auto',
                display: 'flex', flexDirection: 'column', gap: 6,
                padding: 8,
              }}>
                {groupedHistory.length === 0 && (
                  <div className="p-dim" style={{ padding: 16, textAlign: 'center', fontSize: 11 }}>
                    {state.history.length === 0 ? 'no history yet' : 'no matches for "' + historyQuery + '"'}
                  </div>
                )}
                {groupedHistory.map((group) => (
                  <div key={group.day}>
                    <div className="p-label" style={{
                      fontSize: 9,
                      paddingBottom: 2,
                      borderBottom: '1px solid var(--border)',
                      marginBottom: 3,
                    }}>{group.label}</div>
                    {group.items.map((h) => {
                      const t = new Date(h.ts);
                      const time = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
                      const tile = tileFor(h.url, h.title);
                      return (
                        <div
                          key={h.ts + h.url}
                          onClick={() => { navigate(h.url); setShowHistory(false); }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '3px 4px',
                            cursor: 'pointer',
                            borderRadius: 2,
                            fontFamily: 'var(--mono)', fontSize: 10,
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(var(--accent-rgb),0.06)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <span style={{
                            color: 'var(--fg-dim)', width: 36, flexShrink: 0,
                            fontSize: 9,
                          }}>{time}</span>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center', justifyContent: 'center',
                            width: 12, height: 12, borderRadius: 2,
                            background: tile.color,
                            color: 'var(--bg)', fontSize: 8, fontWeight: 700,
                            flexShrink: 0,
                          }}>{tile.letter}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              color: 'var(--fg-bright)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>{h.title || hostnameOf(h.url)}</div>
                            <div style={{
                              color: 'var(--fg-dim)', fontSize: 9,
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>{niceUrl(h.url)}</div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeHistoryItem(h.ts); }}
                            title="forget this"
                            style={{
                              background: 'transparent', border: 'none',
                              color: 'var(--fg-dim)', cursor: 'pointer',
                              fontFamily: 'var(--mono)', fontSize: 12,
                              padding: '0 4px', flexShrink: 0,
                            }}
                          >×</button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="p-row" style={{
          alignItems: 'center', justifyContent: 'space-between',
          fontSize: 9, color: 'var(--fg-dim)', fontFamily: 'var(--mono)',
        }}>
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1, marginRight: 6,
          }} title={activeTab && activeTab.url}>
            {activeTab && activeTab.loading
              ? 'loading ' + niceUrl(activeTab.url) + '…'
              : (activeTab && niceUrl(activeTab.url)) || ''}
          </span>
          <span style={{
            color: activeTab && activeTab.isPrivate ? '#ff6bd6' : 'var(--fg-dim)',
          }}>
            {state.tabs.length} tab{state.tabs.length !== 1 ? 's' : ''}
            {state.tabs.some((t) => t.isPrivate) && (
              <span style={{ marginLeft: 4 }}>· {state.tabs.filter((t) => t.isPrivate).length} private</span>
            )}
          </span>
        </div>
      </div>
    );
  },
};

function navBtn(enabled) {
  return {
    background: 'transparent',
    border: '1px solid ' + (enabled ? 'var(--border-bright)' : 'var(--border)'),
    color: enabled ? 'var(--fg-dim)' : 'rgba(111,154,111,0.4)',
    fontFamily: 'var(--mono)',
    fontSize: 14,
    width: 24,
    height: 22,
    borderRadius: 2,
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: 0,
    lineHeight: 1,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}
