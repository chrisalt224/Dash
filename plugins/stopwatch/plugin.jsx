// Stopwatch — Open-ended count-up timer with lap splits and history.
//
// • start/pause toggles. lap captures a split (time since prev lap + total).
// • reset clears current run; if there was elapsed time it gets pushed to a
//   persistent history (last 20 runs). Click any history entry to expand it.
// • Display uses requestAnimationFrame so the millisecond field actually
//   ticks smoothly. Wall-clock anchored — pausing for an hour and resuming
//   keeps the elapsed count honest.

const KEY = 'plugin:stopwatch:state:v1';
const HISTORY_MAX = 20;

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.history)) return raw;
  } catch {}
  return { history: [] };
};

const fmt = (ms, showMs = true) => {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ml = total % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  if (h > 0) return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + (showMs ? '.' + pad(ml, 3) : '');
  return pad(m, 2) + ':' + pad(s, 2) + (showMs ? '.' + pad(ml, 3) : '');
};

export default {
  id: 'stopwatch',
  name: 'Stopwatch',
  width: 1,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [startedAt, setStartedAt] = useState(null);
    const [accumulated, setAccumulated] = useState(0);
    const [laps, setLaps] = useState([]); // ms-since-run-start at each lap
    const [elapsed, setElapsed] = useState(0);
    const [expandedRun, setExpandedRun] = useState(null);
    const [confirmId, setConfirmId] = useState(null);
    const startedAtRef = useRef(startedAt);
    const accumulatedRef = useRef(accumulated);
    const confirmTimer = useRef(null);

    useEffect(() => { startedAtRef.current = startedAt; }, [startedAt]);
    useEffect(() => { accumulatedRef.current = accumulated; }, [accumulated]);
    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    // RAF-driven elapsed update while running
    useEffect(() => {
      if (startedAt == null) return;
      let raf;
      const tick = () => {
        const cur = startedAtRef.current;
        if (cur == null) return;
        setElapsed(accumulatedRef.current + (Date.now() - cur));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [startedAt]);

    const running = startedAt != null;
    const dirty = running || elapsed > 0;

    const startPause = () => {
      if (running) {
        const cur = accumulated + (Date.now() - startedAt);
        setAccumulated(cur);
        setElapsed(cur);
        setStartedAt(null);
      } else {
        setStartedAt(Date.now());
      }
    };

    const lap = () => {
      if (!dirty) return;
      const cur = running ? accumulated + (Date.now() - startedAt) : elapsed;
      setLaps((l) => [...l, cur]);
    };

    const reset = () => {
      if (dirty) {
        setState((s) => ({
          ...s,
          history: [...s.history, { totalMs: elapsed, laps, ts: Date.now() }].slice(-HISTORY_MAX),
        }));
      }
      setStartedAt(null);
      setAccumulated(0);
      setElapsed(0);
      setLaps([]);
    };

    const armReset = () => {
      if (!dirty) return;
      if (confirmId === '__reset__') {
        reset();
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId('__reset__');
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    const deleteHistory = (ts) => {
      if (confirmId === ts) {
        setState((s) => ({ ...s, history: s.history.filter((h) => h.ts !== ts) }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId(ts);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    // Render lap rows newest-first with split (delta from previous lap)
    const lapRows = laps.map((t, i) => ({
      n: i + 1,
      total: t,
      split: i === 0 ? t : t - laps[i - 1],
    })).reverse();

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Big clock */}
        <div style={{
          fontFamily: 'var(--mono)',
          fontSize: 28,
          fontWeight: 600,
          color: running ? 'var(--accent)' : 'var(--fg-bright)',
          textShadow: running ? '0 0 8px var(--accent)' : 'var(--glow-soft)',
          textAlign: 'center',
          letterSpacing: '0.02em',
          lineHeight: 1.1,
          padding: '4px 0',
        }}>{fmt(elapsed)}</div>

        {/* Buttons */}
        <div className="p-row" style={{ gap: 4 }}>
          <button
            className="p-btn"
            onClick={startPause}
            style={{
              flex: 2, padding: '5px 8px',
              color: running ? 'var(--accent-warm)' : 'var(--accent)',
              borderColor: running ? 'var(--accent-warm)' : 'var(--accent)',
            }}
          >{running ? '⏸ pause' : (elapsed > 0 ? '▶ resume' : '▶ start')}</button>
          <button
            className="p-btn"
            onClick={lap}
            disabled={!dirty}
            style={{ flex: 1, padding: '5px 4px', opacity: dirty ? 1 : 0.4, fontSize: 11 }}
            title="record lap"
          >+ lap</button>
          <button
            className="p-btn"
            onClick={armReset}
            disabled={!dirty}
            style={{
              flex: 1, padding: '5px 4px', fontSize: 11,
              opacity: dirty ? 1 : 0.4,
              color: confirmId === '__reset__' ? 'var(--danger)' : undefined,
              borderColor: confirmId === '__reset__' ? 'var(--danger)' : undefined,
            }}
          >{confirmId === '__reset__' ? '✓?' : '↻'}</button>
        </div>

        {/* Current laps */}
        {lapRows.length > 0 && (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div className="p-label" style={{ fontSize: 9 }}>laps</div>
            {lapRows.map((row) => {
              const isFastest = row.split === Math.min(...laps.map((t, i) => i === 0 ? t : t - laps[i - 1]));
              const isSlowest = laps.length > 1 && row.split === Math.max(...laps.map((t, i) => i === 0 ? t : t - laps[i - 1]));
              return (
                <div key={row.n} className="p-row" style={{
                  fontFamily: 'var(--mono)', fontSize: 10,
                  padding: '2px 4px',
                  border: '1px solid var(--border)',
                  borderRadius: 2,
                  background: 'rgba(var(--accent-rgb),0.02)',
                }}>
                  <span style={{ color: 'var(--fg-dim)', width: 22 }}>#{row.n}</span>
                  <span style={{
                    flex: 1,
                    color: isFastest && laps.length > 1 ? 'var(--accent)' : isSlowest ? 'var(--accent-warm)' : 'var(--fg)',
                    textShadow: isFastest && laps.length > 1 ? '0 0 4px var(--accent)' : 'none',
                  }}>{fmt(row.split)}</span>
                  <span style={{ color: 'var(--fg-dim)' }}>{fmt(row.total, false)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* History — collapsed list, click to expand */}
        {!dirty && state.history.length > 0 && (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div className="p-label" style={{ fontSize: 9 }}>history</div>
            {state.history.slice().reverse().map((h) => {
              const expanded = expandedRun === h.ts;
              const armed = confirmId === h.ts;
              const date = new Date(h.ts);
              const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) + ' ' +
                date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
              return (
                <div key={h.ts} style={{
                  border: '1px solid var(--border)',
                  borderRadius: 2,
                  background: 'rgba(var(--accent-rgb),0.02)',
                  padding: '2px 4px',
                }}>
                  <div className="p-row" style={{ fontFamily: 'var(--mono)', fontSize: 10, alignItems: 'center' }}>
                    <span
                      onClick={() => setExpandedRun(expanded ? null : h.ts)}
                      style={{ flex: 1, cursor: h.laps.length > 0 ? 'pointer' : 'default' }}
                    >
                      <span style={{ color: 'var(--fg-dim)' }}>{dateStr}</span>
                      <span style={{ marginLeft: 6, color: 'var(--accent)' }}>{fmt(h.totalMs, false)}</span>
                      {h.laps.length > 0 && (
                        <span style={{ marginLeft: 4, color: 'var(--fg-dim)', fontSize: 9 }}>
                          ({h.laps.length} {expanded ? '▾' : '▸'})
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => deleteHistory(h.ts)}
                      title="delete"
                      style={{
                        background: 'transparent', border: 'none',
                        color: armed ? 'var(--danger)' : 'var(--fg-dim)',
                        cursor: 'pointer', fontFamily: 'var(--mono)',
                        fontSize: armed ? 10 : 12, lineHeight: 1, padding: '0 4px',
                      }}
                    >{armed ? '✓?' : '×'}</button>
                  </div>
                  {expanded && h.laps.length > 0 && (
                    <div style={{ paddingLeft: 6, paddingTop: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {h.laps.map((t, i) => (
                        <div key={i} style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--fg-dim)' }}>
                          #{i + 1} {fmt(i === 0 ? t : t - h.laps[i - 1])}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  },
};
