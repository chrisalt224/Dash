// Crypto Ticker — Live prices + 24h change + 7-day sparkline.
//
// • CoinGecko's free API — no key. /coins/markets endpoint is one round trip
//   for everything we need.
// • Configurable coin list (CoinGecko IDs like "bitcoin,ethereum,solana").
// • Polls every 90s. Caches the last successful response in localStorage so
//   an offline reload still shows something.
// • Click any row to open the coin's CoinGecko page in your default browser.
// • Sparkline = 7-day price (rendered from `sparkline_in_7d` data).

const KEY = 'plugin:crypto-ticker:state:v1';
const POLL_MS = 90000;
const DEFAULT_COINS = 'bitcoin,ethereum,solana,dogecoin';
const DEFAULT_VS = 'usd';

const VS_SYMBOLS = { usd: '$', eur: '€', gbp: '£', jpy: '¥', btc: '₿', eth: 'Ξ' };

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { coins: DEFAULT_COINS, vs: DEFAULT_VS, cache: null, ...raw };
  } catch {}
  return { coins: DEFAULT_COINS, vs: DEFAULT_VS, cache: null };
};

const fmtPrice = (p, vs) => {
  if (p == null || !Number.isFinite(p)) return '—';
  const sym = VS_SYMBOLS[vs] || (vs.toUpperCase() + ' ');
  if (p >= 1000) return sym + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return sym + p.toFixed(2);
  if (p >= 0.01) return sym + p.toFixed(4);
  return sym + p.toFixed(6);
};

const fmtPct = (p) => {
  if (p == null || !Number.isFinite(p)) return '—';
  const s = p >= 0 ? '+' : '';
  return s + p.toFixed(2) + '%';
};

const ageStr = (ts) => {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  return Math.floor(sec / 3600) + 'h ago';
};

export default {
  id: 'crypto-ticker',
  name: 'Crypto',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [data, setData] = useState(() => state.cache && state.cache.data || []);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [lastFetched, setLastFetched] = useState(() => state.cache && state.cache.fetchedAt || 0);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState({ coins: state.coins, vs: state.vs });
    const abortRef = useRef(null);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const fetchPrices = async () => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const ids = state.coins.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).join(',');
        if (!ids) throw new Error('no coins configured');
        const url =
          'https://api.coingecko.com/api/v3/coins/markets' +
          '?vs_currency=' + encodeURIComponent(state.vs) +
          '&ids=' + encodeURIComponent(ids) +
          '&order=market_cap_desc&per_page=50&page=1' +
          '&sparkline=true&price_change_percentage=24h';
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          if (res.status === 429) throw new Error('rate limited — try again soon');
          throw new Error('http ' + res.status);
        }
        const json = await res.json();
        if (!Array.isArray(json)) throw new Error('bad response');
        if (ctrl.signal.aborted) return;
        // Re-order to match the user's input order (CoinGecko returns by market cap)
        const orderMap = new Map(state.coins.split(',').map((s, i) => [s.trim().toLowerCase(), i]));
        json.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
        const fetchedAt = Date.now();
        setData(json);
        setLastFetched(fetchedAt);
        setState((s) => ({ ...s, cache: { data: json, fetchedAt } }));
      } catch (e) {
        if (e.name === 'AbortError') return;
        setError(e.message || 'fetch failed');
        // Fall back to cached
        if (state.cache && state.cache.data) {
          setData(state.cache.data);
          setLastFetched(state.cache.fetchedAt || 0);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    };

    useEffect(() => {
      fetchPrices();
      const id = setInterval(fetchPrices, POLL_MS);
      return () => { clearInterval(id); if (abortRef.current) abortRef.current.abort(); };
    }, [state.coins, state.vs]);

    const open = (coin) => {
      try {
        const api = window.dashboard && window.dashboard.shell;
        if (api && api.openExternal) api.openExternal('https://www.coingecko.com/en/coins/' + coin.id);
      } catch {}
    };

    const saveSettings = () => {
      const coins = (draft.coins || DEFAULT_COINS).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).join(',');
      const vs = (draft.vs || DEFAULT_VS).toLowerCase();
      setState((s) => ({ ...s, coins, vs }));
      setEditing(false);
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="p-label">crypto · {state.vs}</span>
          <div className="p-row" style={{ gap: 4 }}>
            <button
              onClick={fetchPrices}
              disabled={loading}
              style={{
                background: 'transparent',
                border: '1px solid var(--border-bright)',
                color: 'var(--fg-dim)',
                fontFamily: 'var(--mono)', fontSize: 10,
                padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
              }}
            >{loading ? '…' : '↻'}</button>
            <button
              onClick={() => { setDraft({ coins: state.coins, vs: state.vs }); setEditing((e) => !e); }}
              style={{
                background: 'transparent',
                border: '1px solid var(--border-bright)',
                color: editing ? 'var(--accent)' : 'var(--fg-dim)',
                fontFamily: 'var(--mono)', fontSize: 10,
                padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
              }}
            >⚙</button>
          </div>
        </div>

        {error && (
          <div style={{
            padding: '3px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Settings panel */}
        {editing ? (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 3, padding: 6,
            display: 'flex', flexDirection: 'column', gap: 4,
            flex: 1, minHeight: 0, overflowY: 'auto',
          }}>
            <span className="p-label" style={{ fontSize: 9 }}>coins (comma-separated CoinGecko IDs)</span>
            <input
              className="p-input"
              value={draft.coins}
              onChange={(e) => setDraft((d) => ({ ...d, coins: e.target.value }))}
              placeholder="bitcoin,ethereum,solana"
              style={{ fontSize: 11 }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveSettings(); }}
            />
            <span className="p-dim" style={{ fontSize: 9 }}>
              IDs use the slug from coingecko.com (e.g. "matic-network", not "matic")
            </span>
            <span className="p-label" style={{ fontSize: 9, marginTop: 4 }}>vs currency</span>
            <select
              className="p-input"
              value={draft.vs}
              onChange={(e) => setDraft((d) => ({ ...d, vs: e.target.value }))}
              style={{ fontSize: 11 }}
            >
              {['usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'btc', 'eth'].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <div className="p-row" style={{ gap: 4, marginTop: 4 }}>
              <button className="p-btn" onClick={() => setEditing(false)} style={{ fontSize: 10, padding: '2px 8px' }}>cancel</button>
              <span style={{ flex: 1 }} />
              <button className="p-btn" onClick={saveSettings} style={{ fontSize: 10, padding: '2px 12px' }}>save</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{
              flex: 1, minHeight: 0,
              overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 3,
            }}>
              {data.length === 0 && loading && (
                <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>fetching…</div>
              )}
              {data.length === 0 && !loading && !error && (
                <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>no data</div>
              )}
              {data.map((c) => {
                const change = c.price_change_percentage_24h;
                const up = change != null && change >= 0;
                const sym = (c.symbol || '').toUpperCase();
                const sparkPoints = c.sparkline_in_7d && c.sparkline_in_7d.price;
                let sparkPath = null;
                if (sparkPoints && sparkPoints.length >= 2) {
                  let min = sparkPoints[0], max = sparkPoints[0];
                  for (const v of sparkPoints) { if (v < min) min = v; if (v > max) max = v; }
                  const range = max - min || 1;
                  const W = 100, H = 18;
                  const stepX = W / (sparkPoints.length - 1);
                  let d = '';
                  for (let i = 0; i < sparkPoints.length; i++) {
                    const x = i * stepX;
                    const y = H - ((sparkPoints[i] - min) / range) * H;
                    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
                  }
                  sparkPath = d;
                }

                return (
                  <div
                    key={c.id}
                    onClick={() => open(c)}
                    title={'click to open ' + c.id + ' on CoinGecko'}
                    style={{
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 6px',
                      border: '1px solid var(--border)',
                      borderRadius: 3,
                      background: 'rgba(var(--accent-rgb),0.02)',
                    }}
                  >
                    <div style={{ width: 38, flexShrink: 0 }}>
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                        color: 'var(--fg-bright)', lineHeight: 1.1,
                      }}>{sym}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <svg viewBox="0 0 100 18" preserveAspectRatio="none"
                        style={{ width: '100%', height: 18, display: 'block' }}>
                        {sparkPath && (
                          <path
                            d={sparkPath}
                            fill="none"
                            stroke={up ? 'var(--accent)' : 'var(--danger)'}
                            strokeWidth="0.6"
                            opacity="0.9"
                          />
                        )}
                      </svg>
                    </div>
                    <div style={{ minWidth: 70, textAlign: 'right' }}>
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 11,
                        color: 'var(--fg-bright)', lineHeight: 1.1,
                      }}>{fmtPrice(c.current_price, state.vs)}</div>
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 9,
                        color: up ? 'var(--accent)' : 'var(--danger)',
                        textShadow: '0 0 3px ' + (up ? 'var(--accent)' : 'var(--danger)'),
                        lineHeight: 1.1,
                      }}>{fmtPct(change)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="p-dim" style={{
              fontSize: 9, textAlign: 'right',
              borderTop: '1px solid var(--border-bright)', paddingTop: 3,
            }}>
              {lastFetched ? 'updated ' + ageStr(lastFetched) : '—'}
            </div>
          </>
        )}
      </div>
    );
  },
};
