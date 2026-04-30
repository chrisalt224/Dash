// Battery — Charge percent, AC status, time-remaining, and a discharge graph.
//
// • Polls window.dashboard.system.battery() every 30s. Battery state changes
//   slowly so frequent polling buys nothing.
// • Big percent number with color thresholds (red <20, amber <50, green ≥50).
//   AC adapter symbol (⚡) glows when plugged in.
// • Sparkline shows percent history while the plugin is loaded; persists
//   across reloads so an overnight discharge curve survives.
// • If the system has no battery (desktop), the widget shows a friendly
//   "no battery detected" panel — still useful as a "system has AC only"
//   indicator.

const KEY = 'plugin:battery:state:v1';
const POLL_MS = 30000;
const MAX_HISTORY = 480; // 4 hours @ 30s ≈ 480 samples

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.history)) return raw;
  } catch {}
  return { history: [] };
};

const fmtTime = (mins) => {
  if (mins == null || !Number.isFinite(mins) || mins < 0) return '—';
  if (mins < 60) return mins.toFixed(0) + 'm';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h + 'h ' + String(m).padStart(2, '0') + 'm';
};

const pctColor = (p, charging) => {
  if (charging) return 'var(--accent)';
  if (p == null) return 'var(--fg-dim)';
  if (p < 20) return 'var(--danger)';
  if (p < 50) return 'var(--accent-warm)';
  return 'var(--accent)';
};

export default {
  id: 'battery',
  name: 'Battery',
  width: 1,
  height: 2,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [data, setData] = useState({ hasBattery: false });
    const [error, setError] = useState(null);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        try {
          const api = window.dashboard && window.dashboard.system;
          if (!api || !api.battery) {
            if (!cancelled) setError('host has no battery API — restart the app');
            return;
          }
          const r = await api.battery();
          if (cancelled) return;
          if (r && r.error) setError(r.error);
          else setError(null);
          setData(r || { hasBattery: false });
          if (r && r.hasBattery && r.percent != null) {
            setState((s) => {
              const last = s.history[s.history.length - 1];
              // Skip duplicate consecutive samples (same percent + same charging)
              if (last && last.p === r.percent && last.c === !!r.isCharging) {
                // Update timestamp only — but skip writing to keep file traffic low
                return s;
              }
              const next = [...s.history, { t: Date.now(), p: r.percent, c: !!r.isCharging }];
              if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
              return { ...s, history: next };
            });
          }
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      };
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    const VB_W = 100, VB_H = 30;
    const path = useMemo(() => {
      const h = state.history;
      if (h.length < 2) return null;
      const t0 = h[0].t;
      const t1 = h[h.length - 1].t;
      const span = Math.max(1, t1 - t0);
      let d = '';
      let prev = null;
      for (let i = 0; i < h.length; i++) {
        const x = ((h[i].t - t0) / span) * VB_W;
        const y = VB_H - (h[i].p / 100) * VB_H;
        d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
        prev = h[i];
      }
      return { line: d, area: d + ' L' + VB_W + ',' + VB_H + ' L0,' + VB_H + ' Z' };
    }, [state.history]);

    if (data && !data.hasBattery && !error) {
      return (
        <div className="p-col" style={{
          height: '100%', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 36, color: 'var(--fg-dim)',
            lineHeight: 1, textShadow: 'var(--glow-soft)',
          }}>⚡</div>
          <div className="p-dim" style={{ fontSize: 10, textAlign: 'center', padding: '0 12px' }}>
            no battery detected — running on AC only
          </div>
        </div>
      );
    }

    const pct = data.percent;
    const charging = !!data.isCharging;
    const ac = !!data.acConnected;
    const c = pctColor(pct, charging);
    const tr = data.timeRemaining;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {error && (
          <div style={{
            padding: '3px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Big percent + AC indicator */}
        <div className="p-row" style={{ alignItems: 'flex-start', gap: 4 }}>
          <div style={{ flex: 1 }}>
            <div className="p-label">{charging ? 'charging' : (ac ? 'on ac' : 'discharging')}</div>
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: 30,
              fontWeight: 700,
              color: c,
              textShadow: '0 0 8px ' + c,
              lineHeight: 1,
            }}>
              {pct != null ? pct.toFixed(0) : '—'}<span style={{ fontSize: 14, marginLeft: 2, opacity: 0.7 }}>%</span>
            </div>
          </div>
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: 22,
            color: ac ? 'var(--accent)' : 'var(--fg-dim)',
            textShadow: ac ? '0 0 8px var(--accent)' : 'none',
            opacity: ac ? 1 : 0.4,
          }} title={ac ? 'plugged in' : 'unplugged'}>⚡</div>
        </div>

        {/* Battery icon (visual fill) */}
        <div style={{
          position: 'relative',
          height: 14,
          border: '1px solid var(--fg-dim)',
          borderRadius: 2,
          padding: 1,
          marginRight: 4,
        }}>
          <div style={{
            position: 'absolute',
            right: -4, top: 3, bottom: 3,
            width: 3,
            background: 'var(--fg-dim)',
            borderRadius: '0 1px 1px 0',
          }} />
          <div style={{
            width: Math.max(0, Math.min(100, pct || 0)) + '%',
            height: '100%',
            background: c,
            boxShadow: 'inset 0 0 4px ' + c,
            transition: 'width 0.6s ease, background 0.3s ease',
          }} />
        </div>

        {/* Time remaining */}
        <div className="p-row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span className="p-dim" style={{ fontSize: 9 }}>
            {charging ? 'time to full' : 'time remaining'}
          </span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg)',
          }}>{fmtTime(tr)}</span>
        </div>

        {/* History sparkline */}
        <div style={{
          flex: 1,
          minHeight: 30,
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid var(--border)',
          borderRadius: 2,
          overflow: 'hidden',
          position: 'relative',
        }}>
          {path ? (
            <svg viewBox={'0 0 ' + VB_W + ' ' + VB_H} preserveAspectRatio="none"
              style={{ width: '100%', height: '100%', display: 'block' }}>
              {/* 50% gridline */}
              <line x1={0} y1={VB_H * 0.5} x2={VB_W} y2={VB_H * 0.5}
                stroke="var(--border-bright)" strokeWidth="0.2" strokeDasharray="1 1" />
              {/* 20% gridline */}
              <line x1={0} y1={VB_H * 0.8} x2={VB_W} y2={VB_H * 0.8}
                stroke="var(--danger)" strokeWidth="0.15" strokeDasharray="1 1" opacity="0.4" />
              <path d={path.area} fill={c} fillOpacity={0.18} />
              <path d={path.line} fill="none" stroke={c} strokeWidth="0.6" />
            </svg>
          ) : (
            <div className="p-dim" style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9,
            }}>collecting samples…</div>
          )}
        </div>

        {/* Footer details — show if data has them */}
        {(data.cycleCount != null && data.cycleCount > 0) || data.maxCapacity ? (
          <div className="p-dim" style={{ fontSize: 9, fontFamily: 'var(--mono)', display: 'flex', justifyContent: 'space-between' }}>
            {data.cycleCount != null && data.cycleCount > 0 && <span>cycles {data.cycleCount}</span>}
            {data.maxCapacity && data.designedCapacity ? (
              <span title="health = max / design">
                {((data.maxCapacity / data.designedCapacity) * 100).toFixed(0)}%
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  },
};
