// Process Monitor — Top processes by CPU or RAM with one-click kill.
//
// • Toggle sort: CPU% / MEM%. Polls every 2s.
// • Two-click kill: × arms, ✓? confirms (auto-resets after 3s).
// • Search filters by name.
// • Header shows total process count + sleeping/running breakdown.
//
// Requires window.dashboard.system.processes() and .killProcess(pid).

const KEY = 'plugin:process-monitor:state:v1';

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { sort: 'cpu', limit: 12, ...raw };
  } catch {}
  return { sort: 'cpu', limit: 12 };
};

const trimName = (n, max) => {
  if (!n) return '?';
  // Drop .exe suffix, trim long .NET assembly names
  let s = n.replace(/\.exe$/i, '');
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
};

const colorFor = (pct) => {
  if (pct >= 50) return 'var(--danger)';
  if (pct >= 20) return 'var(--accent-warm)';
  if (pct >= 5)  return 'var(--accent)';
  return 'var(--fg-dim)';
};

export default {
  id: 'process-monitor',
  name: 'Processes',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [data, setData] = useState({ all: 0, running: 0, sleeping: 0, list: [] });
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const [confirmPid, setConfirmPid] = useState(null);
    const [toast, setToast] = useState(null);
    const confirmTimer = useRef(null);
    const toastTimer = useRef(null);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        try {
          const api = window.dashboard && window.dashboard.system;
          if (!api || !api.processes) {
            if (!cancelled) setError('host has no system.processes API');
            return;
          }
          const res = await api.processes();
          if (cancelled) return;
          if (res && res.error) setError(res.error);
          else setError(null);
          setData(res || { list: [] });
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      };
      tick();
      const id = setInterval(tick, 5000);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    const showToast = (msg, color) => {
      setToast({ msg, color: color || 'var(--accent)' });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 2000);
    };

    const armKill = (pid) => {
      if (confirmPid === pid) {
        kill(pid);
        return;
      }
      setConfirmPid(pid);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmPid(null), 3000);
    };

    const kill = async (pid) => {
      setConfirmPid(null);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      try {
        const api = window.dashboard && window.dashboard.system;
        if (!api || !api.killProcess) {
          showToast('no kill API', 'var(--danger)');
          return;
        }
        const res = await api.killProcess(pid);
        if (res && res.ok) showToast('killed pid ' + pid, 'var(--accent)');
        else showToast(res && res.error ? res.error : 'kill failed', 'var(--danger)');
      } catch (e) {
        showToast(e.message, 'var(--danger)');
      }
    };

    const sorted = useMemo(() => {
      const q = query.trim().toLowerCase();
      const list = (data.list || []).filter((p) =>
        p && (p.cpu > 0 || p.mem > 0 || !state.sort) &&
        (!q || (p.name && p.name.toLowerCase().includes(q)))
      );
      list.sort((a, b) => (b[state.sort] || 0) - (a[state.sort] || 0));
      return list.slice(0, state.limit);
    }, [data.list, state.sort, state.limit, query]);

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 4,
            overflow: 'hidden',
          }}>
            {[{ id: 'cpu', label: 'cpu' }, { id: 'mem', label: 'mem' }].map((t) => {
              const active = state.sort === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setState((s) => ({ ...s, sort: t.id }))}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '3px 10px',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >{t.label}</button>
              );
            })}
          </div>
          <input
            className="p-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter…"
            style={{ flex: 1, marginLeft: 6, fontSize: 11 }}
          />
        </div>

        {error && (
          <div style={{
            padding: '4px 10px',
            color: 'var(--danger)',
            border: '1px dashed var(--danger)',
            borderRadius: 4,
            fontSize: 11,
          }}>! {error}</div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sorted.length === 0 && !error && (
            <div className="p-dim" style={{ padding: 8, textAlign: 'center', fontSize: 11 }}>
              {query ? 'no matches' : 'loading…'}
            </div>
          )}
          {sorted.map((p) => {
            const cpu = p.cpu || 0;
            const mem = p.mem || 0;
            const primary = state.sort === 'cpu' ? cpu : mem;
            const c = colorFor(primary);
            const armed = confirmPid === p.pid;
            return (
              <div
                key={p.pid}
                className="p-row"
                style={{
                  alignItems: 'center',
                  padding: '3px 6px',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  background: 'rgba(var(--accent-rgb),0.02)',
                  gap: 6,
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div style={{
                  position: 'absolute',
                  left: 0, top: 0, bottom: 0,
                  width: Math.min(100, primary) + '%',
                  background: c,
                  opacity: 0.08,
                  pointerEvents: 'none',
                }} />
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--fg-dim)',
                  width: 50,
                  flexShrink: 0,
                  position: 'relative',
                }}>{p.pid}</span>
                <span style={{
                  flex: 1,
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--fg)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  position: 'relative',
                }} title={p.command || p.name}>{trimName(p.name, 32)}</span>
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: state.sort === 'cpu' ? c : 'var(--fg-dim)',
                  textShadow: state.sort === 'cpu' && cpu > 5 ? '0 0 4px ' + c : 'none',
                  width: 48,
                  textAlign: 'right',
                  position: 'relative',
                }}>{cpu.toFixed(1)}%</span>
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: state.sort === 'mem' ? c : 'var(--fg-dim)',
                  textShadow: state.sort === 'mem' && mem > 5 ? '0 0 4px ' + c : 'none',
                  width: 44,
                  textAlign: 'right',
                  position: 'relative',
                }}>{mem.toFixed(1)}%</span>
                <button
                  onClick={() => armKill(p.pid)}
                  title={armed ? 'click to confirm kill' : 'kill process'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: armed ? 'var(--danger)' : 'var(--fg-dim)',
                    cursor: 'pointer',
                    fontFamily: 'var(--mono)',
                    fontSize: armed ? 11 : 14,
                    lineHeight: 1,
                    padding: '0 4px',
                    fontWeight: armed ? 700 : 400,
                    position: 'relative',
                  }}
                >{armed ? '✓?' : '×'}</button>
              </div>
            );
          })}
        </div>

        <div className="p-row" style={{ justifyContent: 'space-between', fontSize: 10 }}>
          <span className="p-dim">
            {data.all || 0} total · {data.running || 0} run · {data.sleeping || 0} sleep
          </span>
          {toast ? (
            <span style={{ color: toast.color, textShadow: '0 0 4px ' + toast.color }}>{toast.msg}</span>
          ) : (
            <span className="p-dim">top {state.limit} by {state.sort}</span>
          )}
        </div>
      </div>
    );
  },
};
