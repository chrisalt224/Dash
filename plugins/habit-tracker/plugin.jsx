// Habit Tracker — Daily check-offs with streak counts + GitHub-style heatmap.
//
// • Each habit row: color dot · name · 🔥streak · ✓ today · × delete (armed).
//   Click anywhere on the row (except the buttons) to focus that habit's
//   heatmap below. Click "all" tab to see combined activity.
// • + new opens a name + color picker form.
// • Heatmap: GitHub-style 7-row × N-week grid ending today. Cell intensity
//   when "all" is selected = fraction of habits checked that day.
// • Storage: localStorage. Sparse log: { [habitId]: { 'YYYY-MM-DD': 1 } }.

const KEY = 'plugin:habit-tracker:state:v1';
const HEATMAP_WEEKS = 26;
const CELL = 9;
const CELL_GAP = 2;

const COLORS = {
  green:  { hex: 'var(--accent)', glow: '0 0 6px var(--accent)' },
  amber:  { hex: 'var(--accent-warm)', glow: '0 0 6px var(--accent-warm)' },
  pink:   { hex: '#ff6bd6', glow: '0 0 6px #ff6bd6' },
  cyan:   { hex: '#5eeaff', glow: '0 0 6px #5eeaff' },
  red:    { hex: 'var(--danger)', glow: '0 0 6px var(--danger)' },
};
const COLOR_KEYS = Object.keys(COLORS);

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + da;
};
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};

const newId = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object' && Array.isArray(raw.habits)) {
      return { habits: [], log: {}, selected: 'all', ...raw };
    }
  } catch {}
  return { habits: [], log: {}, selected: 'all' };
};

// Walk back from today counting consecutive done days.
const streakInfo = (habitId, log) => {
  const days = log[habitId] || {};
  let current = 0;
  let d = new Date();
  for (let i = 0; i < 3650; i++) {
    if (days[ymd(d)]) current++;
    else break;
    d = addDays(d, -1);
  }
  // Best streak: scan keys
  const keys = Object.keys(days).sort();
  let best = 0, run = 0;
  let prev = null;
  for (const k of keys) {
    const cur = parseYmd(k);
    if (prev && (cur - prev) === 86400000) run++;
    else run = 1;
    if (run > best) best = run;
    prev = cur;
  }
  return { current, best, total: keys.length };
};

// Combined-activity intensity for "all" view. Returns a number 0..1.
const combinedIntensity = (habits, log, dateKey) => {
  if (!habits.length) return 0;
  let n = 0;
  for (const h of habits) {
    if (log[h.id] && log[h.id][dateKey]) n++;
  }
  return n / habits.length;
};

export default {
  id: 'habit-tracker',
  name: 'Habits',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [state, setState] = useState(loadState);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState({ name: '', color: 'green' });
    const [confirmId, setConfirmId] = useState(null);
    const [today, setToday] = useState(() => ymd(new Date()));
    const confirmTimer = useRef(null);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    // Re-roll today every minute so a long-running widget rolls into the new day
    useEffect(() => {
      const id = setInterval(() => {
        const cur = ymd(new Date());
        setToday((prev) => (prev === cur ? prev : cur));
      }, 30000);
      return () => clearInterval(id);
    }, []);

    const addHabit = () => {
      const name = draft.name.trim();
      if (!name) return;
      const habit = { id: newId(), name, color: draft.color, createdAt: today };
      setState((s) => ({ ...s, habits: [...s.habits, habit] }));
      setDraft({ name: '', color: 'green' });
      setAdding(false);
    };

    const removeHabit = (id) => {
      if (confirmId === id) {
        setState((s) => {
          const log = { ...s.log };
          delete log[id];
          const selected = s.selected === id ? 'all' : s.selected;
          return { ...s, habits: s.habits.filter((h) => h.id !== id), log, selected };
        });
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    const toggleToday = (habitId) => {
      setState((s) => {
        const cur = s.log[habitId] || {};
        const next = { ...cur };
        if (next[today]) delete next[today];
        else next[today] = 1;
        return { ...s, log: { ...s.log, [habitId]: next } };
      });
    };

    const select = (id) => setState((s) => ({ ...s, selected: id }));

    // Build the heatmap grid
    const grid = useMemo(() => {
      const todayD = parseYmd(today);
      const todayDow = todayD.getDay(); // 0=Sun
      // Latest column ends at "today"; this column may be partially in the future
      // (rows below today's weekday are upcoming days of this week).
      const cols = [];
      for (let c = 0; c < HEATMAP_WEEKS; c++) {
        const col = [];
        const colWeekOffset = HEATMAP_WEEKS - 1 - c; // 0 = current week
        for (let r = 0; r < 7; r++) {
          // r=0 is Sunday
          const dayOffset = r - todayDow - colWeekOffset * 7;
          const date = addDays(todayD, dayOffset);
          col.push(date);
        }
        cols.push(col);
      }
      return cols;
    }, [today]);

    const heatLog = useMemo(() => {
      if (state.selected === 'all') return null;
      return state.log[state.selected] || {};
    }, [state.selected, state.log]);

    const heatColor = useMemo(() => {
      if (state.selected === 'all') return COLORS.green;
      const h = state.habits.find((x) => x.id === state.selected);
      return COLORS[(h && h.color) || 'green'] || COLORS.green;
    }, [state.selected, state.habits]);

    const heatTitle = state.selected === 'all'
      ? 'all habits'
      : (state.habits.find((h) => h.id === state.selected) || {}).name || 'all';

    const totalToday = state.habits.reduce(
      (acc, h) => acc + (state.log[h.id] && state.log[h.id][today] ? 1 : 0), 0
    );

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="p-label">habits</span>
          <span className="p-dim" style={{ fontSize: 10 }}>
            {state.habits.length > 0 && (
              <span style={{ color: totalToday === state.habits.length ? 'var(--accent)' : 'var(--fg-dim)' }}>
                {totalToday}/{state.habits.length} today
              </span>
            )}
          </span>
          <button
            className="p-btn"
            onClick={() => setAdding((a) => !a)}
            style={{ fontSize: 10, padding: '2px 8px' }}
          >{adding ? 'cancel' : '+ new'}</button>
        </div>

        {adding && (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 3, padding: 6,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <input
              className="p-input"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="habit (e.g. meditate, read)"
              autoFocus
              maxLength={32}
              style={{ fontSize: 11 }}
              onKeyDown={(e) => { if (e.key === 'Enter') addHabit(); if (e.key === 'Escape') setAdding(false); }}
            />
            <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
              {COLOR_KEYS.map((k) => (
                <button
                  key={k}
                  onClick={() => setDraft((d) => ({ ...d, color: k }))}
                  title={k}
                  style={{
                    width: 16, height: 16, borderRadius: 8,
                    background: COLORS[k].hex,
                    border: draft.color === k ? '2px solid var(--fg-bright)' : '1px solid var(--border)',
                    boxShadow: draft.color === k ? COLORS[k].glow : 'none',
                    cursor: 'pointer', padding: 0,
                  }}
                />
              ))}
              <span style={{ flex: 1 }} />
              <button className="p-btn" onClick={addHabit} style={{ fontSize: 10, padding: '2px 12px' }}>add</button>
            </div>
          </div>
        )}

        {/* Habit list */}
        <div style={{
          flex: 1, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 2,
          minHeight: 40,
        }}>
          {state.habits.length === 0 && !adding && (
            <div className="p-dim" style={{ padding: 12, textAlign: 'center', fontSize: 11 }}>
              no habits yet — click "+ new" to begin
            </div>
          )}
          {state.habits.map((h) => {
            const c = COLORS[h.color] || COLORS.green;
            const { current, best } = streakInfo(h.id, state.log);
            const doneToday = !!(state.log[h.id] && state.log[h.id][today]);
            const armed = confirmId === h.id;
            const isSelected = state.selected === h.id;
            return (
              <div
                key={h.id}
                onClick={() => select(h.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 6px',
                  border: '1px solid ' + (isSelected ? c.hex : 'var(--border)'),
                  borderLeft: '3px solid ' + c.hex,
                  borderRadius: 3,
                  background: isSelected ? 'rgba(var(--accent-rgb),0.04)' : 'rgba(var(--accent-rgb),0.02)',
                  cursor: 'pointer',
                }}
              >
                <span style={{
                  flex: 1, minWidth: 0,
                  fontFamily: 'var(--mono)', fontSize: 12,
                  color: 'var(--fg-bright)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{h.name}</span>
                <span title={'best ' + best + ' day' + (best !== 1 ? 's' : '')} style={{
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: current > 0 ? c.hex : 'var(--fg-dim)',
                  textShadow: current > 0 ? c.glow : 'none',
                  width: 36, textAlign: 'right',
                  flexShrink: 0,
                }}>
                  {current > 0 ? '🔥' : '·'}{current}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleToday(h.id); }}
                  title={doneToday ? 'done today (click to undo)' : 'check today'}
                  style={{
                    width: 22, height: 22, borderRadius: 3,
                    background: doneToday ? c.hex : 'transparent',
                    border: '1px solid ' + c.hex,
                    boxShadow: doneToday ? c.glow : 'none',
                    color: doneToday ? 'var(--bg)' : c.hex,
                    fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700,
                    cursor: 'pointer', padding: 0, lineHeight: 1,
                    flexShrink: 0,
                  }}
                >{doneToday ? '✓' : ''}</button>
                <button
                  onClick={(e) => { e.stopPropagation(); removeHabit(h.id); }}
                  title="delete"
                  style={{
                    background: 'transparent', border: 'none',
                    color: armed ? 'var(--danger)' : 'var(--fg-dim)',
                    cursor: 'pointer', fontFamily: 'var(--mono)',
                    fontSize: armed ? 11 : 14, lineHeight: 1, padding: '0 4px',
                    fontWeight: armed ? 700 : 400, flexShrink: 0,
                  }}
                >{armed ? '✓?' : '×'}</button>
              </div>
            );
          })}
        </div>

        {/* Heatmap header + tabs */}
        {state.habits.length > 0 && (
          <>
            <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border-bright)', paddingTop: 4 }}>
              <span className="p-label" style={{ fontSize: 9 }}>{heatTitle}</span>
              <div className="p-row" style={{ gap: 3 }}>
                <button
                  onClick={() => select('all')}
                  style={{
                    background: state.selected === 'all' ? 'var(--accent)' : 'transparent',
                    color: state.selected === 'all' ? 'var(--bg)' : 'var(--fg-dim)',
                    border: '1px solid var(--border-bright)',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
                    fontWeight: state.selected === 'all' ? 700 : 400,
                    outline: 'none',
                  }}
                >all</button>
              </div>
            </div>

            {/* Heatmap */}
            <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(' + HEATMAP_WEEKS + ', ' + CELL + 'px)',
                gridTemplateRows: 'repeat(7, ' + CELL + 'px)',
                gridAutoFlow: 'column',
                gap: CELL_GAP,
                width: 'max-content',
              }}>
                {grid.map((col) =>
                  col.map((date) => {
                    const key = ymd(date);
                    const isFuture = date > parseYmd(today);
                    let intensity = 0;
                    if (!isFuture) {
                      if (state.selected === 'all') {
                        intensity = combinedIntensity(state.habits, state.log, key);
                      } else if (heatLog && heatLog[key]) {
                        intensity = 1;
                      }
                    }
                    const isToday = key === today;
                    const opacity = intensity > 0 ? (0.25 + intensity * 0.75) : 0;
                    return (
                      <div
                        key={key}
                        title={key + (intensity > 0
                          ? state.selected === 'all'
                            ? ' · ' + Math.round(intensity * state.habits.length) + '/' + state.habits.length
                            : ' · ✓'
                          : '')}
                        style={{
                          width: CELL,
                          height: CELL,
                          background: intensity > 0 ? heatColor.hex : 'rgba(var(--accent-rgb),0.04)',
                          opacity: isFuture ? 0.15 : (intensity > 0 ? opacity : 1),
                          boxShadow: intensity > 0 ? '0 0 3px ' + heatColor.hex : 'none',
                          border: isToday ? '1px solid var(--fg-bright)' : '1px solid var(--border)',
                          borderRadius: 1,
                        }}
                      />
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>
    );
  },
};
