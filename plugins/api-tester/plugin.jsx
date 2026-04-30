// API Tester — curl-style HTTP requester with response viewer.
//
// • Method · URL · headers (key/value rows) · body (textarea, only for
//   methods that take one). Uses window.dashboard.net.fetch so requests
//   bypass renderer CORS — works against any HTTP(S) endpoint.
// • Response: status (color-coded), timing, headers, body. JSON bodies are
//   auto-pretty-printed; HTML/XML stay as text.
// • Persistent history of last 20 requests (method + URL). Click any
//   history entry to load that request back into the editor.
// • Ctrl+Enter from the URL or body sends the request.

const KEY = 'plugin:api-tester:state:v1';
const HISTORY_MAX = 20;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const HAS_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const DEFAULTS = {
  method: 'GET',
  url: 'https://httpbin.org/get',
  headers: [{ k: 'Accept', v: 'application/json' }],
  body: '',
  history: [],
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw };
  } catch {}
  return { ...DEFAULTS };
};

const statusColor = (s) => {
  if (!s) return 'var(--fg-dim)';
  if (s >= 200 && s < 300) return 'var(--accent)';
  if (s >= 300 && s < 400) return 'var(--accent-warm)';
  if (s >= 400) return 'var(--danger)';
  return 'var(--fg-dim)';
};

const fmtMs = (ms) => {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(2) + 's';
};

const fmtSize = (b) => {
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 ** 2).toFixed(2) + ' MB';
};

const tryFormatBody = (text, contentType) => {
  if (!text) return { text: '', kind: 'empty' };
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json') || (text.trim().startsWith('{') || text.trim().startsWith('['))) {
    try {
      const parsed = JSON.parse(text);
      return { text: JSON.stringify(parsed, null, 2), kind: 'json' };
    } catch {}
  }
  if (ct.includes('xml') || ct.includes('html')) return { text, kind: 'markup' };
  return { text, kind: 'text' };
};

export default {
  id: 'api-tester',
  name: 'API',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [response, setResponse] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('body'); // 'body' | 'headers'
    const [showHistory, setShowHistory] = useState(false);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const send = async () => {
      const s = stateRef.current;
      if (!s.url.trim()) {
        setError('URL required');
        return;
      }
      const api = window.dashboard && window.dashboard.net;
      if (!api || !api.fetch) {
        setError('host net.fetch unavailable — restart the app');
        return;
      }
      setLoading(true);
      setError(null);
      setResponse(null);
      try {
        const headers = {};
        for (const { k, v } of s.headers) {
          if (k && k.trim()) headers[k.trim()] = v;
        }
        const r = await api.fetch({
          url: s.url.trim(),
          method: s.method,
          headers,
          body: HAS_BODY.has(s.method) ? s.body : undefined,
          timeout: 30000,
        });
        if (r.error) {
          setError(r.error);
        } else {
          setResponse(r);
        }
        // Add to history regardless
        setState((st) => ({
          ...st,
          history: [
            { method: s.method, url: s.url, ts: Date.now(), status: r.status || null },
            ...st.history.filter((h) => !(h.method === s.method && h.url === s.url)),
          ].slice(0, HISTORY_MAX),
        }));
      } catch (e) {
        setError(e.message || 'request failed');
      } finally {
        setLoading(false);
      }
    };

    const updateHeader = (i, patch) => {
      setState((s) => ({
        ...s,
        headers: s.headers.map((h, idx) => idx === i ? { ...h, ...patch } : h),
      }));
    };
    const addHeader = () => setState((s) => ({ ...s, headers: [...s.headers, { k: '', v: '' }] }));
    const removeHeader = (i) => setState((s) => ({ ...s, headers: s.headers.filter((_, idx) => idx !== i) }));

    const loadHistory = (h) => {
      setState((s) => ({ ...s, method: h.method, url: h.url }));
      setShowHistory(false);
    };

    const onUrlKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    };

    const formatted = useMemo(() => {
      if (!response) return null;
      return tryFormatBody(response.text, response.headers && response.headers['content-type']);
    }, [response]);

    const bodySize = response ? new TextEncoder().encode(response.text || '').length : 0;
    const showBody = HAS_BODY.has(state.method);

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Method + URL row */}
        <div className="p-row" style={{ alignItems: 'stretch', gap: 4 }}>
          <select
            value={state.method}
            onChange={(e) => setState((s) => ({ ...s, method: e.target.value }))}
            className="p-input"
            style={{
              width: 88, fontSize: 11, fontWeight: 700,
              color: 'var(--accent)',
              textAlign: 'center',
            }}
          >
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input
            value={state.url}
            onChange={(e) => setState((s) => ({ ...s, url: e.target.value }))}
            onKeyDown={onUrlKey}
            placeholder="https://api.example.com/…"
            spellCheck={false}
            className="p-input"
            style={{ flex: 1, fontSize: 12 }}
          />
          <button
            className="p-btn"
            onClick={send}
            disabled={loading}
            style={{
              padding: '4px 14px', fontSize: 11,
              background: loading ? 'transparent' : 'var(--accent)',
              color: loading ? 'var(--fg-dim)' : 'var(--bg)',
              borderColor: 'var(--accent)',
              fontWeight: 700,
              minWidth: 60,
            }}
          >{loading ? '…' : '▶ send'}</button>
          <button
            className="p-btn"
            onClick={() => setShowHistory((h) => !h)}
            title="history"
            style={{ padding: '4px 8px', fontSize: 11 }}
          >⟲</button>
        </div>

        {/* History panel */}
        {showHistory && (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 3,
            padding: 4,
            maxHeight: 100,
            overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            {state.history.length === 0 && (
              <div className="p-dim" style={{ fontSize: 10, padding: 4, textAlign: 'center' }}>(no history)</div>
            )}
            {state.history.map((h, i) => (
              <div
                key={i}
                onClick={() => loadHistory(h)}
                style={{
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '2px 6px',
                  borderRadius: 2,
                  fontFamily: 'var(--mono)', fontSize: 10,
                }}
              >
                <span style={{
                  width: 50,
                  color: 'var(--accent)', fontWeight: 700,
                  flexShrink: 0,
                }}>{h.method}</span>
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: 'var(--fg)',
                }}>{h.url}</span>
                {h.status && (
                  <span style={{ color: statusColor(h.status), flexShrink: 0 }}>{h.status}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div style={{
          display: 'flex',
          border: '1px solid var(--border-bright)',
          borderRadius: 4,
          overflow: 'hidden',
          width: 'fit-content',
        }}>
          {[
            { id: 'headers', label: 'headers (' + state.headers.filter((h) => h.k).length + ')' },
            ...(showBody ? [{ id: 'body', label: 'body' }] : []),
          ].map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  background: active ? 'var(--accent-warm)' : 'transparent',
                  color: active ? 'var(--bg)' : 'var(--fg-dim)',
                  border: 'none',
                  padding: '2px 10px',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  fontWeight: active ? 700 : 400,
                  cursor: 'pointer',
                }}
              >{t.label}</button>
            );
          })}
        </div>

        {/* Headers / body editor */}
        <div style={{
          minHeight: 60,
          maxHeight: 140,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 3,
          padding: 4,
          background: 'rgba(0,0,0,0.25)',
        }}>
          {tab === 'headers' ? (
            <div className="p-col" style={{ gap: 2 }}>
              {state.headers.map((h, i) => (
                <div key={i} className="p-row" style={{ gap: 2 }}>
                  <input
                    value={h.k}
                    onChange={(e) => updateHeader(i, { k: e.target.value })}
                    placeholder="key"
                    className="p-input"
                    style={{ flex: 1, fontSize: 10, padding: '2px 4px' }}
                  />
                  <input
                    value={h.v}
                    onChange={(e) => updateHeader(i, { v: e.target.value })}
                    placeholder="value"
                    className="p-input"
                    style={{ flex: 2, fontSize: 10, padding: '2px 4px' }}
                  />
                  <button
                    onClick={() => removeHeader(i)}
                    title="remove"
                    style={{
                      background: 'transparent', border: 'none',
                      color: 'var(--fg-dim)', cursor: 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 12,
                      padding: '0 4px', lineHeight: 1,
                    }}
                  >×</button>
                </div>
              ))}
              <button
                onClick={addHeader}
                style={{
                  background: 'transparent',
                  border: '1px dashed var(--border-bright)',
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  padding: '2px 6px', borderRadius: 2,
                  cursor: 'pointer',
                  letterSpacing: '0.1em',
                }}
              >+ header</button>
            </div>
          ) : (
            <textarea
              value={state.body}
              onChange={(e) => setState((s) => ({ ...s, body: e.target.value }))}
              onKeyDown={onUrlKey}
              placeholder='{"key": "value"}'
              spellCheck={false}
              style={{
                width: '100%', minHeight: 50,
                background: 'transparent', border: 'none',
                color: 'var(--fg)',
                fontFamily: 'var(--mono)', fontSize: 11,
                outline: 'none', resize: 'vertical',
                lineHeight: 1.4,
              }}
            />
          )}
        </div>

        {error && (
          <div style={{
            padding: '4px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 11,
          }}>! {error}</div>
        )}

        {/* Response */}
        <div style={{
          flex: 1, minHeight: 80,
          border: '1px solid var(--border-bright)',
          borderRadius: 3,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {response ? (
            <>
              <div className="p-row" style={{
                alignItems: 'center', gap: 8,
                padding: '4px 8px',
                borderBottom: '1px solid var(--border)',
                fontFamily: 'var(--mono)', fontSize: 11,
              }}>
                <span style={{
                  color: statusColor(response.status),
                  textShadow: '0 0 4px ' + statusColor(response.status),
                  fontWeight: 700,
                }}>{response.status} {response.statusText || ''}</span>
                <span className="p-dim">{fmtMs(response.ms)}</span>
                <span className="p-dim">{fmtSize(bodySize)}</span>
                {formatted && formatted.kind !== 'empty' && (
                  <span className="p-dim" style={{ fontSize: 9 }}>· {formatted.kind}</span>
                )}
                <span style={{ flex: 1 }} />
              </div>
              <div style={{
                flex: 1,
                overflow: 'auto',
                padding: '6px 8px',
                fontFamily: 'var(--mono)', fontSize: 11,
                color: 'var(--fg)',
                whiteSpace: 'pre',
                lineHeight: 1.4,
              }}>
                {formatted ? formatted.text : ''}
              </div>
            </>
          ) : (
            <div className="p-dim" style={{
              padding: 16, textAlign: 'center', fontSize: 11,
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {loading ? 'sending…' : 'press send to fetch'}
            </div>
          )}
        </div>
      </div>
    );
  },
};
