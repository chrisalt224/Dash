// Clipboard History — auto-captures every text copy you make in any app.
//
// • Subscribes to window.dashboard.clipboard.onChange (fed by a polling
//   watcher in the main process).
// • Click any item to copy it back to the clipboard.
// • ★ pins it (pinned items survive the size cap).
// • × removes a single item (two-click confirm). "clear" wipes unpinned.
// • Search filters live across all items.
//
// State persists to localStorage so history survives reloads.

const KEY = 'plugin:clipboard-history:state:v1';
const MAX_ITEMS = 200;

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {}
  return { items: [] };
};

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

export default {
  id: 'clipboard-history',
  name: 'Clipboard',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [query, setQuery] = useState('');
    const [confirmId, setConfirmId] = useState(null);
    const [toast, setToast] = useState(null);
    const stateRef = useRef(state);
    const confirmTimer = useRef(null);
    const toastTimer = useRef(null);

    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    // Subscribe to clipboard changes from main
    useEffect(() => {
      const api = window.dashboard && window.dashboard.clipboard;
      if (!api || !api.onChange) return;
      // Seed with current clipboard
      (async () => {
        try {
          const cur = await api.read();
          if (cur && cur.trim()) addItem(cur);
        } catch {}
      })();
      const unsub = api.onChange((text) => {
        if (text && text.trim()) addItem(text);
      });
      return unsub;
    }, []);

    const addItem = (text) => {
      setState((s) => {
        // Dedupe: if newest matches, skip; if any matches, move to top
        const existing = s.items.findIndex((it) => it.text === text);
        let items = s.items;
        if (existing === 0) return s;
        if (existing > 0) {
          const [it] = items.splice(existing, 1);
          items = [{ ...it, ts: Date.now() }, ...items];
        } else {
          items = [{ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), text, ts: Date.now(), pinned: false }, ...items];
        }
        // Cap unpinned
        const pinned = items.filter((it) => it.pinned);
        const unpinned = items.filter((it) => !it.pinned).slice(0, MAX_ITEMS - pinned.length);
        // Preserve original order: pinned where they were, unpinned trimmed
        const ids = new Set([...pinned.map((p) => p.id), ...unpinned.map((u) => u.id)]);
        return { ...s, items: items.filter((it) => ids.has(it.id)) };
      });
    };

    const copyBack = async (text, id) => {
      try {
        const api = window.dashboard && window.dashboard.clipboard;
        if (api && api.write) await api.write(text);
        else if (navigator.clipboard) await navigator.clipboard.writeText(text);
        showToast('copied');
        // Bump to top
        setState((s) => {
          const idx = s.items.findIndex((it) => it.id === id);
          if (idx <= 0) return s;
          const items = s.items.slice();
          const [it] = items.splice(idx, 1);
          items.unshift({ ...it, ts: Date.now() });
          return { ...s, items };
        });
      } catch (e) {
        showToast('copy failed');
      }
    };

    const showToast = (msg) => {
      setToast(msg);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 1200);
    };

    const togglePin = (id) => {
      setState((s) => ({
        ...s,
        items: s.items.map((it) => it.id === id ? { ...it, pinned: !it.pinned } : it),
      }));
    };

    const removeItem = (id) => {
      if (confirmId === id) {
        setState((s) => ({ ...s, items: s.items.filter((it) => it.id !== id) }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    const clearUnpinned = () => {
      if (confirmId === '__clear__') {
        setState((s) => ({ ...s, items: s.items.filter((it) => it.pinned) }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId('__clear__');
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      const items = state.items;
      const sorted = [...items.filter((it) => it.pinned), ...items.filter((it) => !it.pinned)];
      if (!q) return sorted;
      return sorted.filter((it) => it.text.toLowerCase().includes(q));
    }, [state.items, query]);

    const totalCount = state.items.length;
    const pinnedCount = state.items.filter((it) => it.pinned).length;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        <div className="p-row" style={{ gap: 6, alignItems: 'center' }}>
          <input
            className="p-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search…"
            style={{ flex: 1, fontSize: 11 }}
          />
          <button
            className="p-btn"
            onClick={clearUnpinned}
            style={{
              fontSize: 10,
              padding: '4px 8px',
              color: confirmId === '__clear__' ? 'var(--danger)' : undefined,
              borderColor: confirmId === '__clear__' ? 'var(--danger)' : undefined,
            }}
            title="clear all non-pinned"
          >
            {confirmId === '__clear__' ? '✓ clear?' : 'clear'}
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {filtered.length === 0 && (
            <div className="p-dim" style={{ fontSize: 11, padding: 8, textAlign: 'center' }}>
              {totalCount === 0
                ? 'copy something to get started'
                : 'no matches for "' + query + '"'}
            </div>
          )}
          {filtered.map((it) => {
            const lines = it.text.split('\n').length;
            const preview = truncate(it.text.replace(/\s+/g, ' ').trim(), 200);
            return (
              <div
                key={it.id}
                className="p-row"
                style={{
                  alignItems: 'flex-start',
                  gap: 4,
                  padding: '4px 6px',
                  background: 'rgba(var(--accent-rgb),0.03)',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                }}
              >
                <button
                  onClick={() => togglePin(it.id)}
                  title={it.pinned ? 'unpin' : 'pin'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: it.pinned ? 'var(--accent-warm)' : 'var(--fg-dim)',
                    textShadow: it.pinned ? '0 0 4px var(--accent-warm)' : 'none',
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: '2px 4px',
                    fontFamily: 'var(--mono)',
                  }}
                >★</button>
                <div
                  onClick={() => copyBack(it.text, it.id)}
                  style={{
                    flex: 1,
                    cursor: 'pointer',
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--fg)',
                    lineHeight: 1.35,
                    wordBreak: 'break-word',
                    paddingTop: 1,
                  }}
                  title={'click to copy · ' + lines + ' line' + (lines !== 1 ? 's' : '') + ' · ' + it.text.length + ' chars'}
                >
                  {preview}
                </div>
                <button
                  onClick={() => removeItem(it.id)}
                  title="delete"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: confirmId === it.id ? 'var(--danger)' : 'var(--fg-dim)',
                    cursor: 'pointer',
                    fontSize: 14,
                    padding: '0 4px',
                    lineHeight: 1,
                    fontFamily: 'var(--mono)',
                  }}
                >{confirmId === it.id ? '✓?' : '×'}</button>
              </div>
            );
          })}
        </div>
        <div className="p-row" style={{ justifyContent: 'space-between', fontSize: 10 }}>
          <span className="p-dim">{totalCount} item{totalCount !== 1 ? 's' : ''} · {pinnedCount} pinned</span>
          {toast && <span style={{ color: 'var(--accent)', textShadow: 'var(--glow)' }}>{toast}</span>}
        </div>
      </div>
    );
  },
};
