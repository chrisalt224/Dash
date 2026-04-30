// Hacker News — top / new / best stories from the public Firebase API.
//
// • Tabs: top · new · best · ask · show. No auth, no API key.
// • Click title -> opens story URL in default browser (or HN comments if
//   the story has no URL, e.g. Ask HN).
// • Click [N] -> always opens HN comments page.
// • Caches the latest fetch in localStorage so an offline reload still
//   shows something.
// • Refresh button + auto-refresh every 5 minutes when active.

const KEY = 'plugin:hacker-news:state:v2';
const PAGE_SIZE = 30;
const AUTO_REFRESH_MS = 5 * 60 * 1000;

const TABS = [
  { id: 'top', label: 'top', endpoint: 'topstories' },
  { id: 'new', label: 'new', endpoint: 'newstories' },
  { id: 'best', label: 'best', endpoint: 'beststories' },
  { id: 'ask', label: 'ask', endpoint: 'askstories' },
  { id: 'show', label: 'show', endpoint: 'showstories' },
];

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return { tab: 'top', cache: {} };
};

const fetchJson = async (url, signal) => {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
};

const ageStr = (ts) => {
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
};

const hostOf = (url) => {
  if (!url) return 'news.ycombinator.com';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

export default {
  id: 'hacker-news',
  name: 'Hacker News',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [items, setItems] = useState(() => {
      try {
        const cached = state.cache && state.cache[state.tab];
        if (cached && Array.isArray(cached.items)) return cached.items;
      } catch {}
      return [];
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [lastFetched, setLastFetched] = useState(() => {
      const c = state.cache && state.cache[state.tab];
      return c ? c.fetchedAt : 0;
    });
    const abortRef = useRef(null);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    const loadTab = async (tabId) => {
      const tab = TABS.find((t) => t.id === tabId) || TABS[0];
      // Cancel in-flight
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const ids = await fetchJson(
          'https://hacker-news.firebaseio.com/v0/' + tab.endpoint + '.json',
          ctrl.signal
        );
        const top = ids.slice(0, PAGE_SIZE);
        const stories = await Promise.all(
          top.map((id) =>
            fetchJson('https://hacker-news.firebaseio.com/v0/item/' + id + '.json', ctrl.signal)
              .catch(() => null)
          )
        );
        if (ctrl.signal.aborted) return;
        const filtered = stories.filter(Boolean);
        setItems(filtered);
        const fetchedAt = Date.now();
        setLastFetched(fetchedAt);
        setState((s) => ({
          ...s,
          cache: { ...s.cache, [tabId]: { items: filtered, fetchedAt } },
        }));
      } catch (e) {
        if (e.name === 'AbortError') return;
        setError(e.message);
        // Fall back to cached items
        const cached = state.cache && state.cache[tabId];
        if (cached && Array.isArray(cached.items)) {
          setItems(cached.items);
          setLastFetched(cached.fetchedAt || 0);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    };

    // Load when tab changes
    useEffect(() => {
      // Hydrate cached first for instant paint
      const cached = state.cache && state.cache[state.tab];
      if (cached && Array.isArray(cached.items)) {
        setItems(cached.items);
        setLastFetched(cached.fetchedAt || 0);
      } else {
        setItems([]);
      }
      loadTab(state.tab);
      return () => { if (abortRef.current) abortRef.current.abort(); };
    }, [state.tab]);

    // Auto-refresh
    useEffect(() => {
      const id = setInterval(() => loadTab(state.tab), AUTO_REFRESH_MS);
      return () => clearInterval(id);
    }, [state.tab]);

    const open = (url) => {
      if (!url) return;
      try {
        if (window.dashboard && window.dashboard.shell) {
          window.dashboard.shell.openExternal(url);
        } else {
          window.open(url, '_blank');
        }
      } catch {}
    };

    const ageOfFetch = lastFetched ? ageStr(Math.floor(lastFetched / 1000)) : '—';

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 4,
            overflow: 'hidden',
          }}>
            {TABS.map((t) => {
              const active = state.tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setState((s) => ({ ...s, tab: t.id }))}
                  style={{
                    background: active ? 'var(--accent-warm)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '3px 8px',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >{t.label}</button>
              );
            })}
          </div>
          <button
            className="p-btn"
            onClick={() => loadTab(state.tab)}
            disabled={loading}
            style={{ fontSize: 10, padding: '2px 8px' }}
            title="refresh"
          >{loading ? '…' : '↻'}</button>
        </div>

        {error && !items.length && (
          <div style={{
            padding: '4px 10px',
            color: 'var(--danger)',
            border: '1px dashed var(--danger)',
            borderRadius: 4,
            fontSize: 11,
          }}>! {error}</div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {!items.length && loading && (
            <div className="p-dim" style={{ padding: 8, textAlign: 'center', fontSize: 11 }}>loading…</div>
          )}
          {items.map((it, i) => {
            if (!it) return null;
            const url = it.url || ('https://news.ycombinator.com/item?id=' + it.id);
            const comments = 'https://news.ycombinator.com/item?id=' + it.id;
            return (
              <div
                key={it.id}
                style={{
                  padding: '4px 6px',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  background: 'rgba(var(--accent-rgb),0.02)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                }}
              >
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--fg-dim)',
                  width: 22,
                  textAlign: 'right',
                  flexShrink: 0,
                  paddingTop: 2,
                }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    onClick={() => open(url)}
                    style={{
                      cursor: 'pointer',
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      color: 'var(--fg-bright)',
                      lineHeight: 1.3,
                      wordBreak: 'break-word',
                    }}
                    title={url}
                  >{it.title || '(no title)'}</div>
                  <div className="p-row" style={{ gap: 6, fontSize: 9, marginTop: 2, color: 'var(--fg-dim)' }}>
                    <span style={{ color: 'var(--accent)' }}>{it.score || 0}↑</span>
                    <span>{it.by}</span>
                    <span>{ageStr(it.time)}</span>
                    <span style={{ flex: 1, textAlign: 'right', fontStyle: 'italic' }}>{hostOf(it.url)}</span>
                    <span
                      onClick={() => open(comments)}
                      style={{ cursor: 'pointer', color: 'var(--accent-warm)' }}
                      title="open comments"
                    >[{it.descendants || 0}]</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-row" style={{ justifyContent: 'space-between', fontSize: 10 }}>
          <span className="p-dim">{items.length} stories</span>
          <span className="p-dim">updated {ageOfFetch} ago</span>
        </div>
      </div>
    );
  },
};
