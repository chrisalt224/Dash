// RSS Reader — Subscribe to feeds, see latest items aggregated.
//
// • Add feed URL → fetched via window.dashboard.net.fetch (bypasses CORS).
//   Supports RSS 2.0, Atom, and RDF/RSS 1.0 — anything DOMParser can read.
// • Items merged across feeds, sorted newest-first. Click to open in
//   default browser. Read items dim out (read-state stored locally).
// • Auto-refresh every 15 minutes; manual ↻ on demand.
// • Per-feed: ⚙ to rename or remove. Last-fetched-ago shown.

const KEY = 'plugin:rss-reader:state:v1';
const REFRESH_MS = 15 * 60 * 1000;
const MAX_ITEMS_PER_FEED = 30;
const MAX_TOTAL = 200;

const DEFAULTS = {
  feeds: [
    { id: 'hn', name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  ],
  read: {}, // { itemId: 1 }
  cache: {}, // { feedId: { items: [...], fetchedAt } }
};

const newId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.feeds)) return { ...DEFAULTS, ...raw };
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULTS));
};

const ageStr = (ts) => {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
};

const hostnameOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
};

// Strip HTML and decode common entities for clean snippet text
const stripHtml = (s) => {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
};

const itemHash = (s) => {
  // Cheap stable hash for read-state keys
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
};

// DOM-based feed parser. Handles RSS 2.0 <channel><item>, Atom <feed><entry>,
// and RDF (RSS 1.0) <item>. Returns array of normalized items.
const parseFeed = (xmlText) => {
  if (!xmlText || !xmlText.trim()) return { error: 'empty response', items: [], title: null };
  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(xmlText, 'application/xml');
    const errEl = doc.querySelector('parsererror');
    if (errEl) return { error: 'parse error', items: [], title: null };
  } catch (e) {
    return { error: e.message || 'parse failed', items: [], title: null };
  }
  const root = doc.documentElement;
  if (!root) return { error: 'no root element', items: [], title: null };

  const text = (el, name) => {
    if (!el) return '';
    // Try direct child first
    for (const c of el.children) {
      if (c.localName === name) return c.textContent || '';
    }
    return '';
  };
  const linkOf = (el) => {
    if (!el) return '';
    // Atom: <link href="..." rel="alternate" />
    for (const c of el.children) {
      if (c.localName === 'link') {
        const href = c.getAttribute && c.getAttribute('href');
        if (href) return href;
        if (c.textContent && c.textContent.trim()) return c.textContent.trim();
      }
    }
    return '';
  };
  const dateOf = (el) => {
    const t =
      text(el, 'pubDate') ||
      text(el, 'published') ||
      text(el, 'updated') ||
      text(el, 'date');
    if (!t) return null;
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  };

  let title = '';
  const items = [];
  // RSS 2.0 / RDF: items live under <channel> or root
  const channel = root.querySelector(':scope > channel') || root;
  title = text(channel, 'title') || text(root, 'title');

  // Find item elements (both RSS items and Atom entries)
  const itemEls = root.querySelectorAll('item, entry');
  itemEls.forEach((el) => {
    const t = text(el, 'title');
    const link = linkOf(el) || text(el, 'link') || text(el, 'guid');
    const desc =
      text(el, 'description') ||
      text(el, 'summary') ||
      text(el, 'content') ||
      '';
    const date = dateOf(el);
    if (!t && !link) return;
    items.push({
      title: t || '(no title)',
      url: link.trim(),
      summary: stripHtml(desc).slice(0, 220),
      date,
      id: itemHash((link || '') + '|' + t),
    });
  });

  return { error: null, items: items.slice(0, MAX_ITEMS_PER_FEED), title };
};

export default {
  id: 'rss-reader',
  name: 'RSS',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [loading, setLoading] = useState(new Set());
    const [errors, setErrors] = useState({});
    const [editing, setEditing] = useState(false);
    const [draftUrl, setDraftUrl] = useState('');
    const [draftName, setDraftName] = useState('');
    const [filter, setFilter] = useState(null); // feedId or null
    const [showRead, setShowRead] = useState(false);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const fetchFeed = async (feed) => {
      const api = window.dashboard && window.dashboard.net;
      if (!api || !api.fetch) {
        setErrors((e) => ({ ...e, [feed.id]: 'host net.fetch unavailable' }));
        return;
      }
      setLoading((l) => { const s = new Set(l); s.add(feed.id); return s; });
      try {
        const r = await api.fetch({ url: feed.url, method: 'GET', timeout: 15000 });
        if (r.error) {
          setErrors((e) => ({ ...e, [feed.id]: r.error }));
          return;
        }
        if (!r.ok) {
          setErrors((e) => ({ ...e, [feed.id]: 'http ' + r.status }));
          return;
        }
        const parsed = parseFeed(r.text);
        if (parsed.error) {
          setErrors((e) => ({ ...e, [feed.id]: parsed.error }));
          return;
        }
        setErrors((e) => { const c = { ...e }; delete c[feed.id]; return c; });
        const fetchedAt = Date.now();
        setState((s) => ({
          ...s,
          cache: {
            ...s.cache,
            [feed.id]: { items: parsed.items, fetchedAt, title: parsed.title },
          },
          // Auto-name feed if user didn't set one
          feeds: s.feeds.map((f) =>
            f.id === feed.id && !f.name && parsed.title ? { ...f, name: parsed.title } : f
          ),
        }));
      } catch (e) {
        setErrors((e2) => ({ ...e2, [feed.id]: e.message || 'fetch failed' }));
      } finally {
        setLoading((l) => { const s = new Set(l); s.delete(feed.id); return s; });
      }
    };

    const fetchAll = () => {
      for (const f of stateRef.current.feeds) fetchFeed(f);
    };

    useEffect(() => {
      fetchAll();
      const id = setInterval(fetchAll, REFRESH_MS);
      return () => clearInterval(id);
    }, []);

    const addFeed = () => {
      const url = draftUrl.trim();
      if (!url) return;
      const fullUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      const id = newId();
      const feed = { id, url: fullUrl, name: draftName.trim() || '' };
      setState((s) => ({ ...s, feeds: [...s.feeds, feed] }));
      setDraftUrl('');
      setDraftName('');
      // Fire fetch immediately
      setTimeout(() => fetchFeed(feed), 50);
    };

    const removeFeed = (feedId) => {
      setState((s) => {
        const feeds = s.feeds.filter((f) => f.id !== feedId);
        const cache = { ...s.cache };
        delete cache[feedId];
        return { ...s, feeds, cache };
      });
      if (filter === feedId) setFilter(null);
      setErrors((e) => { const c = { ...e }; delete c[feedId]; return c; });
    };

    const renameFeed = (feedId, name) => {
      setState((s) => ({
        ...s,
        feeds: s.feeds.map((f) => f.id === feedId ? { ...f, name } : f),
      }));
    };

    const markRead = (itemId) => {
      setState((s) => ({ ...s, read: { ...s.read, [itemId]: 1 } }));
    };
    const markAllRead = () => {
      const allIds = {};
      for (const feedId in state.cache) {
        for (const it of (state.cache[feedId].items || [])) allIds[it.id] = 1;
      }
      setState((s) => ({ ...s, read: { ...s.read, ...allIds } }));
    };

    const open = (item) => {
      try {
        const api = window.dashboard && window.dashboard.shell;
        if (api && api.openExternal) api.openExternal(item.url);
      } catch {}
      markRead(item.id);
    };

    // Aggregated item list, sorted newest-first
    const aggregated = useMemo(() => {
      const out = [];
      for (const feed of state.feeds) {
        if (filter && feed.id !== filter) continue;
        const c = state.cache[feed.id];
        if (!c || !c.items) continue;
        for (const item of c.items) {
          if (!showRead && state.read[item.id]) continue;
          out.push({ ...item, feedId: feed.id, feedName: feed.name || hostnameOf(feed.url) });
        }
      }
      out.sort((a, b) => (b.date || 0) - (a.date || 0));
      return out.slice(0, MAX_TOTAL);
    }, [state.feeds, state.cache, state.read, filter, showRead]);

    const totalUnread = useMemo(() => {
      let n = 0;
      for (const feed of state.feeds) {
        const c = state.cache[feed.id];
        if (!c || !c.items) continue;
        for (const item of c.items) if (!state.read[item.id]) n++;
      }
      return n;
    }, [state.feeds, state.cache, state.read]);

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <span className="p-label">
            rss · <span style={{ color: 'var(--accent)' }}>{totalUnread}</span> unread
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => setShowRead((r) => !r)}
            title="show read items"
            style={{
              background: showRead ? 'rgba(var(--accent-rgb),0.1)' : 'transparent',
              border: '1px solid ' + (showRead ? 'var(--accent)' : 'var(--border-bright)'),
              color: showRead ? 'var(--accent)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}
          >read</button>
          <button
            onClick={fetchAll}
            disabled={loading.size > 0}
            style={{
              background: 'transparent',
              border: '1px solid var(--border-bright)',
              color: 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
            }}
          >{loading.size > 0 ? '…' : '↻'}</button>
          <button
            onClick={() => setEditing((e) => !e)}
            style={{
              background: editing ? 'rgba(255,180,84,0.15)' : 'transparent',
              border: '1px solid ' + (editing ? 'var(--accent-warm)' : 'var(--border-bright)'),
              color: editing ? 'var(--accent-warm)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
            }}
          >⚙</button>
        </div>

        {/* Feed-filter chips */}
        {state.feeds.length > 1 && !editing && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 3,
          }}>
            <button
              onClick={() => setFilter(null)}
              style={chipStyle(filter == null)}
            >all</button>
            {state.feeds.map((f) => {
              const active = filter === f.id;
              const err = errors[f.id];
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(active ? null : f.id)}
                  style={chipStyle(active, err)}
                  title={err ? 'error: ' + err : f.url}
                >{f.name || hostnameOf(f.url) || '?'}</button>
              );
            })}
          </div>
        )}

        {/* Edit panel */}
        {editing && (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 3, padding: 6,
            display: 'flex', flexDirection: 'column', gap: 4,
            maxHeight: 200, overflowY: 'auto',
          }}>
            <span className="p-label" style={{ fontSize: 9 }}>add feed</span>
            <input
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="https://example.com/feed.xml"
              spellCheck={false}
              className="p-input"
              style={{ fontSize: 11 }}
              onKeyDown={(e) => { if (e.key === 'Enter') addFeed(); }}
            />
            <div className="p-row" style={{ gap: 4 }}>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="name (optional)"
                spellCheck={false}
                className="p-input"
                style={{ flex: 1, fontSize: 11 }}
                onKeyDown={(e) => { if (e.key === 'Enter') addFeed(); }}
              />
              <button className="p-btn" onClick={addFeed} style={{ fontSize: 10, padding: '2px 12px' }}>+ add</button>
            </div>
            <span className="p-label" style={{ fontSize: 9, marginTop: 6 }}>feeds</span>
            {state.feeds.map((f) => {
              const c = state.cache[f.id];
              const err = errors[f.id];
              return (
                <div key={f.id} className="p-row" style={{
                  alignItems: 'center', gap: 4,
                  padding: '3px 4px',
                  border: '1px solid var(--border)',
                  borderRadius: 2,
                  background: 'rgba(var(--accent-rgb),0.02)',
                }}>
                  <input
                    value={f.name || ''}
                    onChange={(e) => renameFeed(f.id, e.target.value)}
                    placeholder={hostnameOf(f.url)}
                    className="p-input"
                    style={{ flex: 1, fontSize: 10, padding: '1px 4px' }}
                  />
                  <span className="p-dim" style={{ fontSize: 9 }}>
                    {err ? <span style={{ color: 'var(--danger)' }}>!</span>
                      : c ? ageStr(c.fetchedAt) : '—'}
                  </span>
                  <button
                    onClick={() => fetchFeed(f)}
                    disabled={loading.has(f.id)}
                    title="refetch"
                    style={{
                      background: 'transparent', border: 'none',
                      color: 'var(--fg-dim)', cursor: 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 11, padding: '0 4px',
                    }}
                  >{loading.has(f.id) ? '…' : '↻'}</button>
                  <button
                    onClick={() => removeFeed(f.id)}
                    title="remove feed"
                    style={{
                      background: 'transparent', border: 'none',
                      color: 'var(--danger)', cursor: 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 12, padding: '0 4px',
                    }}
                  >×</button>
                </div>
              );
            })}
            <div className="p-row" style={{ marginTop: 4, gap: 4 }}>
              <button className="p-btn" onClick={markAllRead} style={{ fontSize: 10, padding: '2px 8px' }}>mark all read</button>
            </div>
          </div>
        )}

        {/* Items */}
        {!editing && (
          <div style={{
            flex: 1, minHeight: 0,
            overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            {aggregated.length === 0 && state.feeds.length === 0 && (
              <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>
                click ⚙ to add a feed
              </div>
            )}
            {aggregated.length === 0 && state.feeds.length > 0 && loading.size === 0 && (
              <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>
                {showRead ? 'no items yet' : 'all caught up · click "read" to see archive'}
              </div>
            )}
            {aggregated.length === 0 && loading.size > 0 && (
              <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>fetching…</div>
            )}
            {aggregated.map((item) => {
              const isRead = !!state.read[item.id];
              return (
                <div
                  key={item.feedId + ':' + item.id}
                  onClick={() => open(item)}
                  onAuxClick={(e) => { if (e.button === 1) markRead(item.id); }}
                  title={item.url + '\nmiddle-click to mark read'}
                  style={{
                    cursor: 'pointer',
                    padding: '4px 6px',
                    border: '1px solid var(--border)',
                    borderRadius: 2,
                    background: 'rgba(var(--accent-rgb),0.02)',
                    opacity: isRead ? 0.45 : 1,
                  }}
                >
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11,
                    color: isRead ? 'var(--fg-dim)' : 'var(--fg-bright)',
                    fontWeight: isRead ? 400 : 600,
                    lineHeight: 1.3,
                    wordBreak: 'break-word',
                  }}>{item.title}</div>
                  {item.summary && (
                    <div className="p-dim" style={{
                      fontSize: 10, marginTop: 1,
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}>{item.summary}</div>
                  )}
                  <div className="p-row" style={{
                    fontSize: 9, marginTop: 2,
                    color: 'var(--fg-dim)',
                    justifyContent: 'space-between',
                  }}>
                    <span style={{ color: 'var(--accent-warm)' }}>{item.feedName}</span>
                    <span>{item.date ? ageStr(item.date) + ' ago' : '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  },
};

function chipStyle(active, hasError) {
  return {
    background: active ? 'var(--accent-warm)' : 'transparent',
    color: active ? 'var(--bg)' : (hasError ? 'var(--danger)' : 'var(--fg-dim)'),
    border: '1px solid ' + (active ? 'var(--accent-warm)' : (hasError ? 'var(--danger)' : 'var(--border-bright)')),
    fontFamily: 'var(--mono)', fontSize: 9,
    padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
    letterSpacing: '0.08em',
    fontWeight: active ? 700 : 400,
    maxWidth: 120,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
}
