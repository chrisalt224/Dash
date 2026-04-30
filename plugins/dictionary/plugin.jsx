// Dictionary — Word lookup via dictionaryapi.dev (free, no API key).
//
// • Type a word, hit Enter (or click ↵). See definitions, parts of speech,
//   examples, synonyms / antonyms.
// • Phonetic spelling + audio link when available (click to play in default
//   player via shell.openExternal).
// • History of last 30 lookups. Click any to re-look-up.
// • Caches each word's response in localStorage so repeats are instant
//   and offline-friendly.

const KEY = 'plugin:dictionary:state:v1';
const CACHE_KEY = 'plugin:dictionary:cache:v1';
const HISTORY_MAX = 30;
const CACHE_MAX = 100;
const API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { history: [], ...raw };
  } catch {}
  return { history: [] };
};

const loadCache = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return {};
};

export default {
  id: 'dictionary',
  name: 'Dictionary',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [cache, setCache] = useState(loadCache);
    const [query, setQuery] = useState('');
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const inputRef = useRef(null);
    const abortRef = useRef(null);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(CACHE_KEY, JSON.stringify(cache)), 300);
      return () => clearTimeout(id);
    }, [cache]);

    const lookup = async (word) => {
      const w = word.trim().toLowerCase();
      if (!w) return;
      // Hit cache
      if (cache[w]) {
        setResult({ word: w, entries: cache[w], cached: true });
        setError(null);
        addHistory(w);
        return;
      }

      const api = window.dashboard && window.dashboard.net;
      if (!api || !api.fetch) {
        setError('host net.fetch unavailable — restart the app');
        return;
      }

      if (abortRef.current) abortRef.current = null; // we don't have AbortController here, just guard
      setLoading(true);
      setError(null);
      try {
        const r = await api.fetch({
          url: API_BASE + encodeURIComponent(w),
          method: 'GET',
          timeout: 10000,
        });
        if (r.error) throw new Error(r.error);
        if (r.status === 404) {
          setResult({ word: w, notFound: true });
          setLoading(false);
          return;
        }
        if (!r.ok) throw new Error('http ' + r.status);
        const data = JSON.parse(r.text);
        if (!Array.isArray(data) || data.length === 0) {
          setResult({ word: w, notFound: true });
          setLoading(false);
          return;
        }
        setResult({ word: w, entries: data });
        // Cache (cap size)
        setCache((c) => {
          const next = { ...c, [w]: data };
          const keys = Object.keys(next);
          if (keys.length > CACHE_MAX) {
            // Drop oldest by LRU-ish: keep only the most recent words from history
            const recent = new Set(state.history.slice(0, CACHE_MAX - 1));
            recent.add(w);
            const trimmed = {};
            for (const k of Object.keys(next)) if (recent.has(k)) trimmed[k] = next[k];
            return trimmed;
          }
          return next;
        });
        addHistory(w);
      } catch (e) {
        setError(e.message || 'lookup failed');
      } finally {
        setLoading(false);
      }
    };

    const addHistory = (w) => {
      setState((s) => {
        const filtered = s.history.filter((h) => h !== w);
        return { ...s, history: [w, ...filtered].slice(0, HISTORY_MAX) };
      });
    };

    const onSubmit = (e) => {
      e.preventDefault();
      lookup(query);
    };

    const playAudio = (url) => {
      if (!url) return;
      try {
        if (window.dashboard && window.dashboard.shell && window.dashboard.shell.openExternal) {
          window.dashboard.shell.openExternal(url);
        }
      } catch {}
    };

    const clearHistory = () => {
      setState((s) => ({ ...s, history: [] }));
      setCache({});
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Search */}
        <form onSubmit={onSubmit} className="p-row" style={{ gap: 4 }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="look up a word…"
            spellCheck={false}
            autoFocus
            className="p-input"
            style={{ flex: 1, fontSize: 12 }}
          />
          <button
            type="submit"
            disabled={!query.trim() || loading}
            className="p-btn"
            style={{ fontSize: 11, padding: '4px 10px' }}
          >{loading ? '…' : '↵'}</button>
        </form>

        {error && (
          <div style={{
            padding: '4px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Result */}
        <div style={{
          flex: 1, minHeight: 0,
          overflowY: 'auto',
          background: 'rgba(0,0,0,0.25)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          padding: 8,
        }}>
          {!result && !loading && state.history.length === 0 && (
            <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>
              type a word and press enter
            </div>
          )}
          {!result && !loading && state.history.length > 0 && (
            <div className="p-dim" style={{ padding: 8, textAlign: 'center', fontSize: 10 }}>
              type a word above, or pick one from history below
            </div>
          )}
          {loading && (
            <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>
              looking up "{query}"…
            </div>
          )}
          {result && result.notFound && (
            <div style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--fg-bright)' }}>
                "{result.word}"
              </div>
              <div className="p-dim" style={{ fontSize: 11, marginTop: 4 }}>
                no definitions found
              </div>
            </div>
          )}
          {result && !result.notFound && result.entries && (
            <div>
              {/* Word + phonetics */}
              <div className="p-row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 18,
                  fontWeight: 700,
                  color: 'var(--fg-bright)',
                  textShadow: 'var(--glow-soft)',
                }}>{result.word}</span>
                {(() => {
                  const phonetic = (result.entries[0].phonetic) ||
                    (result.entries[0].phonetics || []).map((p) => p.text).find(Boolean);
                  if (!phonetic) return null;
                  return (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--fg-dim)' }}>
                      {phonetic}
                    </span>
                  );
                })()}
                {(() => {
                  const audioUrl = (result.entries[0].phonetics || []).map((p) => p.audio).find(Boolean);
                  if (!audioUrl) return null;
                  return (
                    <button
                      onClick={() => playAudio(audioUrl)}
                      title="play pronunciation in default browser"
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border-bright)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--mono)', fontSize: 10,
                        padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
                      }}
                    >▶ audio</button>
                  );
                })()}
                {result.cached && (
                  <span className="p-dim" style={{ fontSize: 9, marginLeft: 'auto' }}>cached</span>
                )}
              </div>

              {/* Origin / etymology */}
              {result.entries[0].origin && (
                <div style={{
                  fontSize: 10, color: 'var(--fg-dim)',
                  marginTop: 4, fontStyle: 'italic',
                  borderLeft: '2px solid var(--border-bright)',
                  paddingLeft: 6,
                }}>
                  origin: {result.entries[0].origin}
                </div>
              )}

              {/* Meanings */}
              {result.entries.map((entry, ei) => (
                <div key={ei}>
                  {(entry.meanings || []).map((meaning, mi) => (
                    <div key={mi} style={{ marginTop: 8 }}>
                      <div style={{
                        fontSize: 9,
                        color: 'var(--accent-warm)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        fontStyle: 'italic',
                        marginBottom: 3,
                        paddingBottom: 2,
                        borderBottom: '1px solid var(--border)',
                      }}>{meaning.partOfSpeech}</div>
                      {(meaning.definitions || []).map((def, di) => (
                        <div key={di} style={{ marginTop: 4, marginBottom: 6 }}>
                          <div style={{
                            display: 'flex',
                            gap: 4,
                            alignItems: 'flex-start',
                            fontFamily: 'var(--mono)', fontSize: 11,
                            color: 'var(--fg)',
                            lineHeight: 1.4,
                          }}>
                            <span style={{
                              color: 'var(--fg-dim)', flexShrink: 0,
                              fontFamily: 'var(--mono)', fontSize: 10,
                              minWidth: 16,
                            }}>{di + 1}.</span>
                            <span>{def.definition}</span>
                          </div>
                          {def.example && (
                            <div style={{
                              fontSize: 10,
                              color: 'var(--fg-dim)',
                              fontStyle: 'italic',
                              marginLeft: 20,
                              marginTop: 2,
                              lineHeight: 1.4,
                            }}>
                              "{def.example}"
                            </div>
                          )}
                        </div>
                      ))}
                      {meaning.synonyms && meaning.synonyms.length > 0 && (
                        <div style={{
                          fontSize: 10, color: 'var(--accent)',
                          marginTop: 2, lineHeight: 1.4,
                        }}>
                          <span style={{ color: 'var(--fg-dim)' }}>synonyms: </span>
                          {meaning.synonyms.slice(0, 8).map((s, i) => (
                            <span key={i}>
                              <span
                                onClick={() => { setQuery(s); lookup(s); }}
                                style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                                title="look up"
                              >{s}</span>{i < Math.min(meaning.synonyms.length, 8) - 1 ? ', ' : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {meaning.antonyms && meaning.antonyms.length > 0 && (
                        <div style={{
                          fontSize: 10, color: 'var(--danger)',
                          marginTop: 2, lineHeight: 1.4, opacity: 0.85,
                        }}>
                          <span style={{ color: 'var(--fg-dim)' }}>antonyms: </span>
                          {meaning.antonyms.slice(0, 8).map((a, i) => (
                            <span key={i}>
                              <span
                                onClick={() => { setQuery(a); lookup(a); }}
                                style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                                title="look up"
                              >{a}</span>{i < Math.min(meaning.antonyms.length, 8) - 1 ? ', ' : ''}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* History */}
        {state.history.length > 0 && (
          <div>
            <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span className="p-label" style={{ fontSize: 9 }}>history · {state.history.length}</span>
              <button
                onClick={clearHistory}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--fg-dim)', fontSize: 9, fontFamily: 'var(--mono)',
                  cursor: 'pointer', padding: 0,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                }}
              >clear</button>
            </div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 3,
              maxHeight: 60, overflowY: 'auto',
            }}>
              {state.history.map((w) => (
                <button
                  key={w}
                  onClick={() => { setQuery(w); lookup(w); }}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: 'var(--fg-dim)',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
                  }}
                >{w}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  },
};
