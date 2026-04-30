// World Clocks — multiple timezones in retro digital style.
//
// • Default zones cover SF / NYC / London / Tokyo. Add or remove from the
//   gear menu — pick from any IANA timezone the runtime supports.
// • Each clock shows label, time, and day-offset relative to local
//   ("today", "+1d", "−1d"). Highlights work-hours (09–17) in green,
//   night (22–07) in dim, otherwise amber.
// • 24h / 12h toggle persists.

const KEY = 'plugin:world-clocks:state:v1';

const DEFAULT_CLOCKS = [
  { id: 'local', label: 'local', tz: null },
  { id: 'sf', label: 'SF', tz: 'America/Los_Angeles' },
  { id: 'nyc', label: 'NYC', tz: 'America/New_York' },
  { id: 'lon', label: 'LON', tz: 'Europe/London' },
  { id: 'tyo', label: 'TYO', tz: 'Asia/Tokyo' },
];

const COMMON_ZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Moscow', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.clocks)) return { hour12: false, ...raw };
  } catch {}
  return { clocks: DEFAULT_CLOCKS, hour12: false };
};

const partsFor = (date, tz) => {
  const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' };
  if (tz) opts.timeZone = tz;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', opts);
    const parts = fmt.formatToParts(date);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return {
      hh: get('hour'),
      mm: get('minute'),
      ss: get('second'),
      yyyy: get('year'),
      mo: get('month'),
      dd: get('day'),
      wk: get('weekday'),
      ok: true,
    };
  } catch (e) {
    return { ok: false, err: e.message };
  }
};

const dayOffset = (clockParts, localParts) => {
  if (!clockParts.ok || !localParts.ok) return 0;
  const a = Date.UTC(+clockParts.yyyy, +clockParts.mo - 1, +clockParts.dd);
  const b = Date.UTC(+localParts.yyyy, +localParts.mo - 1, +localParts.dd);
  return Math.round((a - b) / 86400000);
};

const tzShortName = (tz) => {
  if (!tz) return null;
  const segs = tz.split('/');
  return segs[segs.length - 1].replace(/_/g, ' ');
};

export default {
  id: 'world-clocks',
  name: 'World Clocks',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [now, setNow] = useState(() => new Date());
    const [editing, setEditing] = useState(false);
    const [adding, setAdding] = useState({ tz: 'America/Los_Angeles', label: '' });

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    useEffect(() => {
      // Tick once per second, aligned to the wall clock
      let cancelled = false;
      const tick = () => {
        if (cancelled) return;
        setNow(new Date());
      };
      tick();
      const id = setInterval(tick, 1000);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    const local = useMemo(() => partsFor(now, null), [now]);

    const addClock = () => {
      if (!adding.tz) return;
      const label = (adding.label || tzShortName(adding.tz) || 'CLK').toUpperCase().slice(0, 6);
      const id = adding.tz + ':' + Date.now();
      setState((s) => ({ ...s, clocks: [...s.clocks, { id, label, tz: adding.tz }] }));
      setAdding({ tz: 'America/Los_Angeles', label: '' });
    };

    const removeClock = (id) => {
      setState((s) => ({ ...s, clocks: s.clocks.filter((c) => c.id !== id) }));
    };

    const toggle12 = () => setState((s) => ({ ...s, hour12: !s.hour12 }));

    const formatTime = (parts) => {
      if (!parts.ok) return '--:--:--';
      let { hh, mm, ss } = parts;
      if (state.hour12) {
        const h24 = +hh;
        const ampm = h24 >= 12 ? 'pm' : 'am';
        const h12 = ((h24 + 11) % 12) + 1;
        return String(h12).padStart(2, '0') + ':' + mm + ' ' + ampm;
      }
      return hh + ':' + mm + ':' + ss;
    };

    const colorFor = (hh) => {
      const h = +hh;
      if (Number.isNaN(h)) return 'var(--fg-dim)';
      if (h >= 9 && h < 17) return 'var(--accent)';
      if (h >= 22 || h < 7) return 'var(--fg-dim)';
      return 'var(--accent-warm)';
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="p-label">world clocks</span>
          <div className="p-row" style={{ gap: 4 }}>
            <button
              className="p-btn"
              onClick={toggle12}
              style={{ fontSize: 10, padding: '2px 8px' }}
              title="toggle 12/24 hour"
            >{state.hour12 ? '12h' : '24h'}</button>
            <button
              className="p-btn"
              onClick={() => setEditing((e) => !e)}
              style={{ fontSize: 10, padding: '2px 8px' }}
              title="edit clocks"
            >{editing ? 'done' : '⚙'}</button>
          </div>
        </div>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 6,
          alignContent: 'start',
        }}>
          {state.clocks.map((c) => {
            const parts = partsFor(now, c.tz);
            const off = dayOffset(parts, local);
            const offLabel = off === 0 ? 'today' : (off > 0 ? '+' + off + 'd' : off + 'd');
            const color = colorFor(parts.hh);
            return (
              <div key={c.id} style={{
                border: '1px solid var(--border-bright)',
                borderRadius: 4,
                padding: '6px 8px',
                background: 'rgba(var(--accent-rgb),0.02)',
                position: 'relative',
              }}>
                {editing && c.id !== 'local' && (
                  <button
                    onClick={() => removeClock(c.id)}
                    title="remove"
                    style={{
                      position: 'absolute',
                      top: 2, right: 4,
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--danger)',
                      cursor: 'pointer',
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >×</button>
                )}
                <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span className="p-label" style={{ fontSize: 9 }}>{c.label}</span>
                  <span className="p-dim" style={{ fontSize: 9 }}>{offLabel}</span>
                </div>
                <div style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 22,
                  fontWeight: 600,
                  color,
                  textShadow: '0 0 6px ' + color,
                  letterSpacing: '0.04em',
                  lineHeight: 1.2,
                }}>{formatTime(parts)}</div>
                <div className="p-dim" style={{ fontSize: 9, letterSpacing: '0.06em' }}>
                  {parts.ok ? (parts.wk + ' ' + parts.dd + '/' + parts.mo) : (parts.err || 'invalid tz')}
                </div>
              </div>
            );
          })}
        </div>

        {editing && (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 4,
            padding: 6,
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
          }}>
            <select
              className="p-input"
              value={adding.tz}
              onChange={(e) => setAdding((a) => ({ ...a, tz: e.target.value }))}
              style={{ flex: 1, minWidth: 120, fontSize: 11 }}
            >
              {COMMON_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <input
              className="p-input"
              value={adding.label}
              onChange={(e) => setAdding((a) => ({ ...a, label: e.target.value }))}
              placeholder="label"
              maxLength={6}
              style={{ width: 70, fontSize: 11 }}
            />
            <button
              className="p-btn"
              onClick={addClock}
              style={{ fontSize: 10, padding: '2px 10px' }}
            >+ add</button>
          </div>
        )}
      </div>
    );
  },
};
