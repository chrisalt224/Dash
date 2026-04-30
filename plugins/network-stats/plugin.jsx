// Network Stats — Live download / upload throughput + ping.
//
// • Polls window.dashboard.system.networkStats() every 1.5s, computing rates
//   from rx_bytes/tx_bytes deltas (more reliable than si's rx_sec which can
//   be -1 on first poll).
// • Mirrored sparkline: download (green) draws downward from center,
//   upload (amber) draws upward. Auto-scales Y to peak in window.
// • Ping every 5s to a configurable host (default 1.1.1.1). Color-coded:
//   <50 green, <150 amber, ≥150 red.
// • ⚙ opens an inline panel to change the ping host and the interface
//   (default = OS-default, * = aggregate all up interfaces).
//
// Storage: localStorage. Samples are NOT persisted — they re-fill on reload.

const KEY = 'plugin:network-stats:state:v1';
const POLL_MS = 2500;
const PING_MS = 10000;
const SAMPLE_COUNT = 80;

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { pingHost: '1.1.1.1', iface: '', ...raw };
  } catch {}
  return { pingHost: '1.1.1.1', iface: '' };
};

const fmtRate = (bps) => {
  if (!Number.isFinite(bps) || bps < 0) return '—';
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  if (bps < 1024 * 1024 * 1024) return (bps / 1024 / 1024).toFixed(2) + ' MB/s';
  return (bps / 1024 / 1024 / 1024).toFixed(2) + ' GB/s';
};

const fmtBytes = (b) => {
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return b.toFixed(0) + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};

const pingColor = (ms, ok) => {
  if (!ok || ms == null) return 'var(--danger)';
  if (ms < 50) return 'var(--accent)';
  if (ms < 150) return 'var(--accent-warm)';
  return 'var(--danger)';
};

// Sum rx/tx across all "up" interfaces (or whichever entries the host returned).
const sumStats = (arr) => {
  let rx = 0, tx = 0, picked = [];
  for (const s of (arr || [])) {
    if (!s) continue;
    // Treat unknown operstate as up — some virtual ifaces don't report it
    if (s.operstate && s.operstate !== 'up' && s.operstate !== 'unknown') continue;
    rx += Number(s.rx_bytes) || 0;
    tx += Number(s.tx_bytes) || 0;
    if (s.iface) picked.push(s.iface);
  }
  return { rx, tx, ifaces: picked };
};

export default {
  id: 'network-stats',
  name: 'Network',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef, useMemo, useCallback }) => {
    const [state, setState] = useState(loadState);
    const [samples, setSamples] = useState([]); // [{ t, dl, up }]
    const [totals, setTotals] = useState({ rx: 0, tx: 0 });
    const [ping, setPing] = useState({ ok: false, ms: null, host: '1.1.1.1' });
    const [error, setError] = useState(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [draftHost, setDraftHost] = useState(state.pingHost);
    const [draftIface, setDraftIface] = useState(state.iface);
    const [ifaces, setIfaces] = useState([]); // for picker
    const lastRef = useRef(null); // { rx, tx, t }
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    // Network stats poll
    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        const api = window.dashboard && window.dashboard.system;
        if (!api || !api.networkStats) {
          if (!cancelled) setError('host has no networkStats — restart the app');
          return;
        }
        try {
          const ifaceArg = stateRef.current.iface || undefined; // undefined = default
          const stats = await api.networkStats(ifaceArg);
          if (cancelled) return;
          setError(null);
          const summed = sumStats(stats);
          const now = Date.now();
          const last = lastRef.current;
          if (last && now > last.t) {
            const dt = (now - last.t) / 1000;
            // Guard against counter resets / first poll garbage
            const dlBytes = Math.max(0, summed.rx - last.rx);
            const upBytes = Math.max(0, summed.tx - last.tx);
            // If interface changed (different totals direction), skip this sample
            const dl = dt > 0 ? dlBytes / dt : 0;
            const up = dt > 0 ? upBytes / dt : 0;
            setSamples((prev) => {
              const next = [...prev, { t: now, dl, up }];
              if (next.length > SAMPLE_COUNT) next.splice(0, next.length - SAMPLE_COUNT);
              return next;
            });
            setTotals((prev) => ({ rx: prev.rx + dlBytes, tx: prev.tx + upBytes }));
          }
          lastRef.current = { rx: summed.rx, tx: summed.tx, t: now };
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      };
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, [state.iface]);

    // Ping poll
    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        const api = window.dashboard && window.dashboard.system;
        if (!api || !api.ping) return;
        try {
          const r = await api.ping(stateRef.current.pingHost);
          if (cancelled) return;
          if (r && r.ok) setPing({ ok: true, ms: r.ms, host: r.host || stateRef.current.pingHost });
          else setPing({ ok: false, ms: null, host: stateRef.current.pingHost });
        } catch {
          if (!cancelled) setPing({ ok: false, ms: null, host: stateRef.current.pingHost });
        }
      };
      tick();
      const id = setInterval(tick, PING_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, [state.pingHost]);

    // Load interface list when settings open
    useEffect(() => {
      if (!settingsOpen) return;
      let cancelled = false;
      (async () => {
        try {
          const api = window.dashboard && window.dashboard.system;
          if (!api || !api.networkInterfaces) return;
          const list = await api.networkInterfaces();
          if (!cancelled) setIfaces(list || []);
        } catch {}
      })();
      return () => { cancelled = true; };
    }, [settingsOpen]);

    const lastSample = samples[samples.length - 1] || { dl: 0, up: 0 };
    const peak = useMemo(() => {
      let m = 1;
      for (const s of samples) {
        if (s.dl > m) m = s.dl;
        if (s.up > m) m = s.up;
      }
      return m;
    }, [samples]);

    // Build SVG paths for mirrored sparkline. ViewBox W=100 H=40 (centerline at 20).
    const VB_W = 100, VB_H = 40, MID = 20;
    const buildPaths = useMemo(() => {
      if (samples.length < 2) return { dl: '', up: '' };
      const n = samples.length;
      const stepX = VB_W / (SAMPLE_COUNT - 1); // anchored to fixed sample slot
      const offsetX = VB_W - (n - 1) * stepX; // newest sample is on the right
      const ptDl = (s, i) => {
        const x = offsetX + i * stepX;
        const h = (s.dl / peak) * MID;
        return [x, MID + h];
      };
      const ptUp = (s, i) => {
        const x = offsetX + i * stepX;
        const h = (s.up / peak) * MID;
        return [x, MID - h];
      };
      const buildArea = (samples, ptFn, baseY) => {
        const pts = samples.map(ptFn);
        let d = 'M' + pts[0][0] + ',' + baseY;
        for (const [x, y] of pts) d += ' L' + x + ',' + y;
        d += ' L' + pts[pts.length - 1][0] + ',' + baseY + ' Z';
        return d;
      };
      const buildLine = (samples, ptFn) => {
        const pts = samples.map(ptFn);
        let d = 'M' + pts[0][0] + ',' + pts[0][1];
        for (let i = 1; i < pts.length; i++) d += ' L' + pts[i][0] + ',' + pts[i][1];
        return d;
      };
      return {
        dlArea: buildArea(samples, ptDl, MID),
        dlLine: buildLine(samples, ptDl),
        upArea: buildArea(samples, ptUp, MID),
        upLine: buildLine(samples, ptUp),
      };
    }, [samples, peak]);

    const saveSettings = () => {
      setState((s) => ({ ...s, pingHost: draftHost.trim() || '1.1.1.1', iface: draftIface }));
      setSettingsOpen(false);
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {/* Top: DL / UP big numbers */}
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="p-label" style={{ fontSize: 9, color: 'var(--accent)' }}>↓ download</div>
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--accent)',
              textShadow: lastSample.dl > 0 ? '0 0 6px var(--accent)' : 'none',
              lineHeight: 1.1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>{fmtRate(lastSample.dl)}</div>
          </div>
          <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
            <div className="p-label" style={{ fontSize: 9, color: 'var(--accent-warm)' }}>↑ upload</div>
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--accent-warm)',
              textShadow: lastSample.up > 0 ? '0 0 6px var(--accent-warm)' : 'none',
              lineHeight: 1.1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>{fmtRate(lastSample.up)}</div>
          </div>
        </div>

        {error && (
          <div style={{
            padding: '3px 8px',
            color: 'var(--danger)',
            border: '1px dashed var(--danger)',
            borderRadius: 3,
            fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Mirrored sparkline */}
        {!settingsOpen && (
          <div style={{
            flex: 1,
            minHeight: 50,
            border: '1px solid var(--border)',
            borderRadius: 3,
            background: 'rgba(0,0,0,0.25)',
            position: 'relative',
            overflow: 'hidden',
          }}>
            <svg
              viewBox={'0 0 ' + VB_W + ' ' + VB_H}
              preserveAspectRatio="none"
              style={{ width: '100%', height: '100%', display: 'block' }}
            >
              {/* Center line */}
              <line x1={0} y1={MID} x2={VB_W} y2={MID}
                stroke="var(--border-bright)" strokeWidth="0.2" strokeDasharray="1 1" />
              {samples.length >= 2 && (
                <>
                  <path d={buildPaths.dlArea} fill="var(--accent)" fillOpacity={0.18} />
                  <path d={buildPaths.dlLine} fill="none" stroke="var(--accent)" strokeWidth="0.6" />
                  <path d={buildPaths.upArea} fill="var(--accent-warm)" fillOpacity={0.2} />
                  <path d={buildPaths.upLine} fill="none" stroke="var(--accent-warm)" strokeWidth="0.6" />
                </>
              )}
            </svg>
            {samples.length < 2 && (
              <div className="p-dim" style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10,
              }}>warming up…</div>
            )}
            {/* Peak marker */}
            <div className="p-dim" style={{
              position: 'absolute', top: 2, left: 4, fontSize: 9,
            }}>peak {fmtRate(peak)}</div>
          </div>
        )}

        {/* Settings panel */}
        {settingsOpen && (
          <div style={{
            flex: 1,
            border: '1px dashed var(--border-bright)',
            borderRadius: 3,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            overflowY: 'auto',
          }}>
            <label className="p-label" style={{ fontSize: 9 }}>ping host</label>
            <input
              className="p-input"
              value={draftHost}
              onChange={(e) => setDraftHost(e.target.value)}
              placeholder="1.1.1.1"
              spellCheck={false}
              style={{ fontSize: 11 }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveSettings(); }}
            />
            <label className="p-label" style={{ fontSize: 9, marginTop: 4 }}>interface</label>
            <select
              className="p-input"
              value={draftIface}
              onChange={(e) => setDraftIface(e.target.value)}
              style={{ fontSize: 11 }}
            >
              <option value="">(default)</option>
              <option value="*">* all interfaces</option>
              {ifaces.map((i) => (
                <option key={i.iface} value={i.iface}>
                  {i.iface}{i.ifaceName && i.ifaceName !== i.iface ? ' · ' + i.ifaceName : ''}
                </option>
              ))}
            </select>
            <div className="p-row" style={{ gap: 4, marginTop: 4 }}>
              <button className="p-btn" onClick={() => setSettingsOpen(false)} style={{ fontSize: 10, padding: '2px 8px' }}>cancel</button>
              <span style={{ flex: 1 }} />
              <button className="p-btn" onClick={saveSettings} style={{ fontSize: 10, padding: '2px 12px' }}>save</button>
            </div>
          </div>
        )}

        {/* Footer: totals + ping + cog */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between', fontSize: 10, gap: 6 }}>
          <span className="p-dim" title="session totals (since plugin loaded)">
            ↓ {fmtBytes(totals.rx)} · ↑ {fmtBytes(totals.tx)}
          </span>
          <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
            <span style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: pingColor(ping.ms, ping.ok),
              textShadow: ping.ok ? '0 0 4px ' + pingColor(ping.ms, ping.ok) : 'none',
            }}
              title={'ping ' + (ping.host || state.pingHost) + (ping.ok ? ' = ' + ping.ms + 'ms' : ' (failed)')}
            >
              {ping.ok ? ping.ms.toFixed(0) + 'ms' : '×'}
            </span>
            <span className="p-dim" style={{ fontSize: 9 }}>{ping.host || state.pingHost}</span>
            <button
              onClick={() => {
                setDraftHost(state.pingHost);
                setDraftIface(state.iface);
                setSettingsOpen((o) => !o);
              }}
              title="settings"
              style={{
                background: 'transparent',
                border: '1px solid var(--border-bright)',
                color: settingsOpen ? 'var(--accent)' : 'var(--fg-dim)',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                padding: '0 6px',
                borderRadius: 2,
                cursor: 'pointer',
                lineHeight: 1.4,
              }}
            >⚙</button>
          </div>
        </div>
      </div>
    );
  },
};
