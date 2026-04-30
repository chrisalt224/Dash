// UUID Generator — UUIDv4 / UUIDv7 / nanoid / ULID with history.
//
// • Tabs pick the format. ↻ regenerates. Click any value (current or in
//   history) to copy. History keeps the last 20 generated values; persists
//   across reloads.
// • All randomness from window.crypto.getRandomValues — no Math.random
//   anywhere in the ID generation paths.

const KEY = 'plugin:uuid-generator:state:v1';
const HISTORY_MAX = 20;

const TYPES = [
  { id: 'v4', label: 'uuid v4', hint: 'random' },
  { id: 'v7', label: 'uuid v7', hint: 'time-ordered, 2022 spec' },
  { id: 'nanoid', label: 'nanoid', hint: '21 url-safe chars' },
  { id: 'ulid', label: 'ulid', hint: '26 chars, time-sortable' },
];

const NANOID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U

const hex = (b) => b.toString(16).padStart(2, '0');

const genV4 = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback: build manually
  const r = crypto.getRandomValues(new Uint8Array(16));
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const h = Array.from(r, hex).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
};

const genV7 = () => {
  // 48 bits unix-ms timestamp, 4 bits version (7), 12 bits rand_a,
  // 2 bits variant (10), 62 bits rand_b
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, '0'); // 48 bits = 12 hex chars
  const r = crypto.getRandomValues(new Uint8Array(10)); // 80 bits randomness
  // rand_a (12 bits) goes into bytes 0..1; force version nibble = 7
  r[0] = (r[0] & 0x0f) | 0x70;
  // rand_b: byte 2 high 2 bits = variant 10
  r[2] = (r[2] & 0x3f) | 0x80;
  const rh = Array.from(r, hex).join('');
  return tsHex.slice(0, 8) + '-' + tsHex.slice(8, 12) + '-' + rh.slice(0, 4) + '-' + rh.slice(4, 8) + '-' + rh.slice(8, 20);
};

const genNanoid = (n = 21) => {
  // Use rejection sampling over a 64-char alphabet (perfect power of 2 = no bias)
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += NANOID_ALPHABET[bytes[i] & 63];
  return s;
};

const genULID = () => {
  const ts = Date.now();
  // 48-bit timestamp → 10 base32 chars
  let tsStr = '';
  let n = ts;
  for (let i = 0; i < 10; i++) {
    tsStr = CROCKFORD[n % 32] + tsStr;
    n = Math.floor(n / 32);
  }
  // 80 bits randomness → 16 base32 chars (5 bits per char)
  const r = crypto.getRandomValues(new Uint8Array(10));
  let val = 0n, bits = 0n, rStr = '';
  for (const b of r) {
    val = (val << 8n) | BigInt(b);
    bits += 8n;
    while (bits >= 5n) {
      bits -= 5n;
      rStr += CROCKFORD[Number((val >> bits) & 31n)];
    }
  }
  return tsStr + rStr;
};

const generate = (type) => {
  switch (type) {
    case 'v4': return genV4();
    case 'v7': return genV7();
    case 'nanoid': return genNanoid();
    case 'ulid': return genULID();
    default: return genV4();
  }
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { type: 'v4', history: [], ...raw };
  } catch {}
  return { type: 'v4', history: [] };
};

export default {
  id: 'uuid-generator',
  name: 'UUID',
  width: 2,
  height: 2,
  component: ({ useState, useEffect }) => {
    const [state, setState] = useState(loadState);
    const [current, setCurrent] = useState(() => generate(loadState().type));
    const [toast, setToast] = useState(null);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    const regen = () => {
      const v = generate(state.type);
      setCurrent(v);
      setState((s) => ({
        ...s,
        history: [{ type: state.type, value: v, ts: Date.now() }, ...s.history].slice(0, HISTORY_MAX),
      }));
    };

    const copy = async (v) => {
      if (!v) return;
      try {
        const api = window.dashboard && window.dashboard.clipboard;
        if (api && api.write) await api.write(v);
        else if (navigator.clipboard) await navigator.clipboard.writeText(v);
        setToast(v.length > 12 ? v.slice(0, 12) + '… copied' : v + ' copied');
        setTimeout(() => setToast(null), 1500);
      } catch {
        setToast('copy failed');
        setTimeout(() => setToast(null), 1500);
      }
    };

    const clearHistory = () => setState((s) => ({ ...s, history: [] }));

    const setType = (t) => {
      setState((s) => ({ ...s, type: t }));
      const v = generate(t);
      setCurrent(v);
      setState((s) => ({
        ...s, type: t,
        history: [{ type: t, value: v, ts: Date.now() }, ...s.history].slice(0, HISTORY_MAX),
      }));
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Type tabs */}
        <div style={{
          display: 'flex',
          border: '1px solid var(--border-bright)',
          borderRadius: 4,
          overflow: 'hidden',
        }}>
          {TYPES.map((t) => {
            const active = state.type === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setType(t.id)}
                title={t.hint}
                style={{
                  flex: 1,
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--bg)' : 'var(--fg-dim)',
                  border: 'none',
                  padding: '3px 4px',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: active ? 700 : 400,
                  cursor: 'pointer',
                }}
              >{t.label}</button>
            );
          })}
        </div>

        {/* Big output */}
        <div
          onClick={() => copy(current)}
          title="click to copy"
          style={{
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: state.type === 'ulid' || state.type === 'nanoid' ? 13 : 14,
            color: 'var(--fg-bright)',
            textShadow: '0 0 6px var(--accent)',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid var(--border-bright)',
            borderRadius: 3,
            padding: '10px 12px',
            wordBreak: 'break-all',
            lineHeight: 1.3,
            textAlign: 'center',
          }}
        >{current}</div>

        <div className="p-row" style={{ gap: 4 }}>
          <button className="p-btn" onClick={regen} style={{ flex: 1, padding: '4px 8px' }}>↻ regenerate</button>
          <button className="p-btn" onClick={() => copy(current)} style={{ flex: 1, padding: '4px 8px' }}>copy</button>
        </div>

        {/* History */}
        {state.history.length > 0 && (
          <>
            <div className="p-row" style={{ alignItems: 'center', borderTop: '1px solid var(--border-bright)', paddingTop: 4 }}>
              <span className="p-label" style={{ flex: 1, fontSize: 9 }}>history ({state.history.length})</span>
              <button
                onClick={clearHistory}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--fg-dim)',
                  fontSize: 9,
                  fontFamily: 'var(--mono)',
                  cursor: 'pointer',
                  padding: 0,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}
              >clear</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
              {state.history.map((h, i) => (
                <div
                  key={i}
                  onClick={() => copy(h.value)}
                  title={h.type + ' · click to copy'}
                  style={{
                    cursor: 'pointer',
                    padding: '2px 4px',
                    border: '1px solid var(--border)',
                    borderRadius: 2,
                    background: 'rgba(var(--accent-rgb),0.02)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 8,
                    color: 'var(--fg-dim)',
                    width: 30,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    flexShrink: 0,
                  }}>{h.type}</span>
                  <span style={{
                    flex: 1,
                    fontFamily: 'var(--mono)', fontSize: 10,
                    color: 'var(--fg)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>{h.value}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {toast && (
          <div style={{
            position: 'absolute',
            bottom: 6, right: 6,
            padding: '2px 8px',
            background: 'rgba(var(--accent-rgb),0.15)',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 2,
            fontFamily: 'var(--mono)',
            fontSize: 10,
            textShadow: 'var(--glow)',
            pointerEvents: 'none',
          }}>{toast}</div>
        )}
      </div>
    );
  },
};
