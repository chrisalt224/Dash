// Countdown — Big retro digital countdown(s) to any date.
//
// • Stack multiple countdowns. The "primary" one (★) is shown big up top.
//   Click any other to promote it.
// • Add new ones with a name + ISO date+time. Color picker (green / amber /
//   pink) so you can tell them apart at a glance.
// • Past dates count UP ("12d ago") — useful for milestones.

const KEY = 'plugin:countdown:state:v1';

const DEFAULT_STATE = {
  primaryId: null,
  items: [
    {
      id: 'newyear',
      name: 'New Year',
      // dynamic — recomputed on load if past
      iso: null,
      color: 'green',
    },
  ],
};

const COLORS = {
  green:  { fg: 'var(--accent)',      glow: '0 0 10px var(--accent)' },
  amber:  { fg: 'var(--accent-warm)', glow: '0 0 10px var(--accent-warm)' },
  pink:   { fg: '#ff6bd6',            glow: '0 0 10px #ff6bd6' },
  red:    { fg: 'var(--danger)',      glow: '0 0 10px var(--danger)' },
  cyan:   { fg: '#5eeaff',            glow: '0 0 10px #5eeaff' },
};

const computeNewYear = () => {
  const now = new Date();
  return new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0).toISOString();
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.items)) {
      // Hydrate dynamic newyear if missing
      const items = raw.items.map((it) =>
        it.id === 'newyear' && !it.iso ? { ...it, iso: computeNewYear() } : it
      );
      return { ...raw, items };
    }
  } catch {}
  return { ...DEFAULT_STATE, items: DEFAULT_STATE.items.map((it) =>
    it.id === 'newyear' ? { ...it, iso: computeNewYear() } : it
  ) };
};

const splitDuration = (ms) => {
  const total = Math.abs(Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return { days, hours, mins, secs };
};

const pad = (n) => String(n).padStart(2, '0');

const ymdLocal = (date) => {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  return y + '-' + m + '-' + d;
};

const hmLocal = (date) => pad(date.getHours()) + ':' + pad(date.getMinutes());

export default {
  id: 'countdown',
  name: 'Countdown',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [state, setState] = useState(loadState);
    const [now, setNow] = useState(Date.now());
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState(() => {
      const tomorrow = new Date(Date.now() + 86400000);
      return { name: '', date: ymdLocal(tomorrow), time: '12:00', color: 'green' };
    });
    const [confirmId, setConfirmId] = useState(null);
    const confirmTimer = useRef(null);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    useEffect(() => {
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    }, []);

    const items = state.items;
    const primary = useMemo(() => {
      if (state.primaryId) {
        const found = items.find((it) => it.id === state.primaryId);
        if (found) return found;
      }
      return items[0];
    }, [items, state.primaryId]);

    const others = items.filter((it) => !primary || it.id !== primary.id);

    const addItem = () => {
      const iso = (() => {
        try {
          const d = new Date(draft.date + 'T' + (draft.time || '00:00') + ':00');
          if (!Number.isFinite(d.getTime())) return null;
          return d.toISOString();
        } catch { return null; }
      })();
      if (!iso) return;
      const id = 'cd' + Date.now() + Math.random().toString(36).slice(2, 5);
      const name = draft.name.trim() || 'untitled';
      setState((s) => ({ ...s, items: [...s.items, { id, name, iso, color: draft.color }] }));
      setAdding(false);
      const tomorrow = new Date(Date.now() + 86400000);
      setDraft({ name: '', date: ymdLocal(tomorrow), time: '12:00', color: 'green' });
    };

    const removeItem = (id) => {
      if (confirmId === id) {
        setState((s) => {
          const items = s.items.filter((it) => it.id !== id);
          const primaryId = s.primaryId === id ? null : s.primaryId;
          return { ...s, items, primaryId };
        });
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    const promote = (id) => setState((s) => ({ ...s, primaryId: id }));

    const renderRemaining = (item) => {
      if (!item) return null;
      const target = new Date(item.iso).getTime();
      const diff = target - now;
      const past = diff < 0;
      const { days, hours, mins, secs } = splitDuration(diff);
      const c = COLORS[item.color] || COLORS.green;
      return { c, days, hours, mins, secs, past, target };
    };

    const big = renderRemaining(primary);

    return (
      <div className="p-col" style={{ height: '100%', gap: 8 }}>
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="p-label">countdown</span>
          <button
            className="p-btn"
            onClick={() => setAdding((a) => !a)}
            style={{ fontSize: 10, padding: '2px 8px' }}
          >{adding ? 'cancel' : '+ new'}</button>
        </div>

        {adding ? (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 4,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}>
            <input
              className="p-input"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="name (e.g. vacation)"
              autoFocus
              style={{ fontSize: 11 }}
            />
            <div className="p-row" style={{ gap: 4 }}>
              <input
                className="p-input"
                type="date"
                value={draft.date}
                onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
                style={{ flex: 2, fontSize: 11 }}
              />
              <input
                className="p-input"
                type="time"
                value={draft.time}
                onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))}
                style={{ flex: 1, fontSize: 11 }}
              />
            </div>
            <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
              <span className="p-dim" style={{ fontSize: 10 }}>color</span>
              {Object.keys(COLORS).map((k) => (
                <button
                  key={k}
                  onClick={() => setDraft((d) => ({ ...d, color: k }))}
                  title={k}
                  style={{
                    width: 18, height: 18, borderRadius: 9,
                    background: COLORS[k].fg,
                    boxShadow: draft.color === k ? COLORS[k].glow : 'none',
                    border: draft.color === k ? '2px solid var(--fg-bright)' : '1px solid var(--border)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
              <button
                className="p-btn"
                onClick={addItem}
                style={{ marginLeft: 'auto', fontSize: 10, padding: '3px 12px' }}
              >save</button>
            </div>
          </div>
        ) : (
          big && (
            <div style={{
              border: '1px solid var(--border-bright)',
              borderRadius: 4,
              padding: 10,
              background: 'rgba(var(--accent-rgb),0.02)',
              textAlign: 'center',
            }}>
              <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="p-label" style={{ color: big.c.fg }}>{primary.name}</span>
                <span className="p-dim" style={{ fontSize: 9 }}>
                  {big.past ? 'since' : 'until'} {new Date(primary.iso).toLocaleDateString()}
                </span>
              </div>
              <div style={{
                fontFamily: 'var(--mono)',
                fontSize: 30,
                fontWeight: 700,
                color: big.c.fg,
                textShadow: big.c.glow,
                letterSpacing: '0.04em',
                lineHeight: 1.1,
                marginTop: 4,
              }}>
                {big.days > 0 && (
                  <>
                    <span>{big.days}</span>
                    <span style={{ fontSize: 14, opacity: 0.7, marginLeft: 4, marginRight: 8 }}>d</span>
                  </>
                )}
                {pad(big.hours)}:{pad(big.mins)}:{pad(big.secs)}
              </div>
              <div className="p-dim" style={{ fontSize: 9, marginTop: 2 }}>
                {big.past ? '↓ elapsed' : '↑ remaining'}
              </div>
            </div>
          )
        )}

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {others.map((it) => {
            const r = renderRemaining(it);
            const summary = r.past
              ? r.days > 0 ? r.days + 'd ago' : pad(r.hours) + ':' + pad(r.mins) + ' ago'
              : r.days > 0 ? r.days + 'd ' + pad(r.hours) + 'h' : pad(r.hours) + ':' + pad(r.mins) + ':' + pad(r.secs);
            return (
              <div
                key={it.id}
                className="p-row"
                onClick={() => promote(it.id)}
                style={{
                  cursor: 'pointer',
                  alignItems: 'center',
                  padding: '4px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  background: 'rgba(var(--accent-rgb),0.02)',
                }}
                title="click to promote"
              >
                <span style={{
                  width: 8, height: 8, borderRadius: 4,
                  background: r.c.fg,
                  boxShadow: r.c.glow,
                  marginRight: 8,
                  flexShrink: 0,
                }} />
                <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg)' }}>
                  {it.name}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: r.c.fg,
                  textShadow: r.past ? 'none' : '0 0 4px ' + r.c.fg,
                  marginRight: 8,
                  opacity: r.past ? 0.6 : 1,
                }}>{summary}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeItem(it.id); }}
                  title="delete"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: confirmId === it.id ? 'var(--danger)' : 'var(--fg-dim)',
                    cursor: 'pointer',
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    lineHeight: 1,
                    padding: '0 4px',
                  }}
                >{confirmId === it.id ? '✓?' : '×'}</button>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};
