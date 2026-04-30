// Disk Usage — Per-drive used/free bars + system-wide R/W rates.
//
// • Polls window.dashboard.system.drives() every 4s (drives don't fill up
//   that fast). I/O sparkline polls every 1.5s for smooth motion.
// • Each drive: label (mount or fs), color-coded fill bar (green→amber→red
//   thresholds), used/total in human units, and the % use number.
// • Click any drive to open it in Explorer (window.dashboard.shell.open).
// • Read/write footer shows current rate + dual sparkline.

const KEY = 'plugin:disk-usage:state:v1';
const DRIVES_POLL_MS = 4000;
const IO_POLL_MS = 3000;
const SAMPLE_COUNT = 60;

const fmtBytes = (b) => {
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return b.toFixed(0) + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + ' MB';
  if (b < 1024 ** 4) return (b / 1024 ** 3).toFixed(1) + ' GB';
  return (b / 1024 ** 4).toFixed(2) + ' TB';
};
const fmtRate = (bps) => {
  if (!Number.isFinite(bps) || bps < 0) return '—';
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1024 ** 2) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1024 ** 2).toFixed(1) + ' MB/s';
};

// Color thresholds for use percent
const usageColor = (pct) => {
  if (pct == null) return 'var(--fg-dim)';
  if (pct >= 90) return 'var(--danger)';
  if (pct >= 75) return 'var(--accent-warm)';
  return 'var(--accent)';
};

// Drives may include system mounts we don't care about (Linux loop, snap, etc.)
// On Windows fs is "C:", "D:", etc. — keep all.
const isUserDrive = (d) => {
  if (!d || !d.fs) return false;
  // Windows drive letters
  if (/^[A-Za-z]:$/.test(d.fs)) return true;
  // Filter ephemerals on other OSes
  if (d.fs.startsWith('/dev/loop') || d.fs.startsWith('overlay')) return false;
  if (d.type && /squashfs|tmpfs|overlay/i.test(d.type)) return false;
  return true;
};

export default {
  id: 'disk-usage',
  name: 'Disks',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [drives, setDrives] = useState([]);
    const [error, setError] = useState(null);
    const [io, setIo] = useState({ rxSec: 0, wxSec: 0 });
    const [samples, setSamples] = useState([]); // {t, r, w}

    // Drives poll (slow)
    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        try {
          const api = window.dashboard && window.dashboard.system;
          if (!api || !api.drives) {
            if (!cancelled) setError('host has no drives API — restart the app');
            return;
          }
          const res = await api.drives();
          if (cancelled) return;
          if (res && res.error) setError(res.error);
          else setError(null);
          setDrives((res && res.drives ? res.drives : []).filter(isUserDrive));
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      };
      tick();
      const id = setInterval(tick, DRIVES_POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    // I/O poll (fast — for sparkline + live rate)
    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        try {
          const api = window.dashboard && window.dashboard.system;
          if (!api || !api.drives) return;
          const res = await api.drives();
          if (cancelled) return;
          if (res && res.io) {
            const r = Math.max(0, Number(res.io.rxSec) || 0);
            const w = Math.max(0, Number(res.io.wxSec) || 0);
            setIo({ rxSec: r, wxSec: w });
            setSamples((prev) => {
              const next = [...prev, { t: Date.now(), r, w }];
              if (next.length > SAMPLE_COUNT) next.splice(0, next.length - SAMPLE_COUNT);
              return next;
            });
          }
        } catch {}
      };
      tick();
      const id = setInterval(tick, IO_POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    const peak = useMemo(() => {
      let m = 1;
      for (const s of samples) {
        if (s.r > m) m = s.r;
        if (s.w > m) m = s.w;
      }
      return m;
    }, [samples]);

    const VB_W = 100, VB_H = 24, MID = 12;
    const paths = useMemo(() => {
      if (samples.length < 2) return null;
      const n = samples.length;
      const stepX = VB_W / (SAMPLE_COUNT - 1);
      const offsetX = VB_W - (n - 1) * stepX;
      const buildArea = (key, baseY, sign) => {
        let d = 'M' + offsetX + ',' + baseY;
        for (let i = 0; i < n; i++) {
          const x = offsetX + i * stepX;
          const y = baseY + sign * (samples[i][key] / peak) * MID;
          d += ' L' + x + ',' + y;
        }
        d += ' L' + (offsetX + (n - 1) * stepX) + ',' + baseY + ' Z';
        return d;
      };
      return {
        rArea: buildArea('r', MID, 1),  // read draws downward
        wArea: buildArea('w', MID, -1), // write draws upward
      };
    }, [samples, peak]);

    const open = (mount) => {
      try {
        const api = window.dashboard && window.dashboard.shell;
        if (api && mount) api.open(mount);
      } catch {}
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {error && (
          <div style={{
            padding: '3px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Drive bars */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {drives.length === 0 && !error && (
            <div className="p-dim" style={{ padding: 8, textAlign: 'center', fontSize: 11 }}>loading…</div>
          )}
          {drives.map((d) => {
            const pct = d.use != null ? d.use : (d.size > 0 ? (d.used / d.size) * 100 : 0);
            const c = usageColor(pct);
            const label = d.mount || d.fs;
            return (
              <div
                key={d.fs}
                onClick={() => open(d.mount || d.fs)}
                title={'click to open · ' + (d.type || 'fs') + (d.mount ? ' · ' + d.mount : '')}
                style={{
                  cursor: 'pointer',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  padding: '4px 6px',
                  background: 'rgba(var(--accent-rgb),0.02)',
                }}
              >
                <div className="p-row" style={{ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 12,
                    color: 'var(--fg-bright)', fontWeight: 600,
                  }}>{label}</span>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 10, color: c,
                    textShadow: pct >= 75 ? '0 0 4px ' + c : 'none',
                  }}>{pct != null ? pct.toFixed(0) : '—'}%</span>
                </div>
                <div style={{
                  height: 6, background: 'rgba(0,0,0,0.4)',
                  borderRadius: 1, overflow: 'hidden',
                  border: '1px solid var(--border)',
                }}>
                  <div style={{
                    width: Math.max(0, Math.min(100, pct)) + '%',
                    height: '100%',
                    background: c,
                    boxShadow: '0 0 4px ' + c,
                    transition: 'width 0.4s ease',
                  }} />
                </div>
                <div className="p-dim" style={{ fontSize: 9, marginTop: 1, fontFamily: 'var(--mono)' }}>
                  {fmtBytes(d.used)} of {fmtBytes(d.size)} · {fmtBytes(d.available)} free
                </div>
              </div>
            );
          })}
        </div>

        {/* I/O footer */}
        <div style={{
          borderTop: '1px solid var(--border-bright)',
          paddingTop: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <div style={{ minWidth: 60 }}>
            <div className="p-label" style={{ fontSize: 8, color: 'var(--accent)' }}>↓ read</div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)',
              textShadow: io.rxSec > 0 ? '0 0 4px var(--accent)' : 'none',
              lineHeight: 1.1,
            }}>{fmtRate(io.rxSec)}</div>
          </div>
          <div style={{
            flex: 1, height: 24,
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid var(--border)',
            borderRadius: 2,
            overflow: 'hidden',
          }}>
            <svg viewBox={'0 0 ' + VB_W + ' ' + VB_H} preserveAspectRatio="none"
              style={{ width: '100%', height: '100%', display: 'block' }}>
              <line x1={0} y1={MID} x2={VB_W} y2={MID}
                stroke="var(--border-bright)" strokeWidth="0.2" strokeDasharray="1 1" />
              {paths && (
                <>
                  <path d={paths.rArea} fill="var(--accent)" fillOpacity={0.3} />
                  <path d={paths.wArea} fill="var(--accent-warm)" fillOpacity={0.3} />
                </>
              )}
            </svg>
          </div>
          <div style={{ minWidth: 60, textAlign: 'right' }}>
            <div className="p-label" style={{ fontSize: 8, color: 'var(--accent-warm)' }}>↑ write</div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent-warm)',
              textShadow: io.wxSec > 0 ? '0 0 4px var(--accent-warm)' : 'none',
              lineHeight: 1.1,
            }}>{fmtRate(io.wxSec)}</div>
          </div>
        </div>
      </div>
    );
  },
};
