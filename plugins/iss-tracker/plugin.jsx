// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

// ISS Tracker — Live position of the International Space Station.
//
// • Polls api.wheretheiss.at every 5s for current lat / lon / altitude /
//   velocity / visibility (daylight or eclipsed).
// • Renders on a stylized phosphor world map: continent dots derived from
//   a tiny embedded coastline summary (no external image), plus lat/lon
//   gridlines and labeled reference cities.
// • A glowing dot tracks the current position; a fading trail shows the
//   last 12 minutes of motion.
//
// Free API · no key needed.

const KEY = 'plugin:iss-tracker:state:v1';
const API_URL = 'https://api.wheretheiss.at/v1/satellites/25544';
const POLL_MS = 5000;
const TRAIL_MAX = 144; // 144 * 5s = 12 minutes

// Reference cities — drawn as labeled dots on the map for spatial anchor
const CITIES = [
  { name: 'NYC', lat: 40.7,  lon: -74.0 },
  { name: 'LON', lat: 51.5,  lon: -0.1 },
  { name: 'TYO', lat: 35.7,  lon: 139.7 },
  { name: 'SYD', lat: -33.9, lon: 151.2 },
  { name: 'SF',  lat: 37.8,  lon: -122.4 },
  { name: 'CAI', lat: 30.0,  lon: 31.2 },
  { name: 'RIO', lat: -22.9, lon: -43.2 },
  { name: 'MOW', lat: 55.8,  lon: 37.6 },
  { name: 'JNB', lat: -26.2, lon: 28.0 },
  { name: 'SIN', lat: 1.4,   lon: 103.8 },
  { name: 'LAX', lat: 34.0,  lon: -118.2 },
  { name: 'DEL', lat: 28.6,  lon: 77.2 },
];

// Stylized continent dots — a coarse coastline sample. Each entry is
// [lat, lon] of a point that lands on land. Renders as faint phosphor
// dots so the user can read which ocean the ISS is over without an actual
// image asset.
const LAND_DOTS = (() => {
  const out = [];
  // North America
  for (let la = 25; la <= 70; la += 5) for (let lo = -170; lo <= -55; lo += 5)
    if (((la < 50 && lo > -130 && lo < -70) || (la >= 50 && lo > -160 && lo < -60)) && !((la < 30 && lo < -110))) out.push([la, lo]);
  // South America
  for (let la = -55; la <= 12; la += 4) for (let lo = -82; lo <= -34; lo += 4)
    if (lo + Math.abs(la) * 0.6 > -85 && lo - Math.abs(la) * 0.4 < -32) out.push([la, lo]);
  // Europe
  for (let la = 35; la <= 70; la += 4) for (let lo = -10; lo <= 60; lo += 4)
    if (la > 38 || lo > 0) out.push([la, lo]);
  // Africa
  for (let la = -34; la <= 35; la += 4) for (let lo = -18; lo <= 50; lo += 4)
    if (lo > -18 + Math.abs(la) * 0.2 && lo < 52 - Math.abs(la) * 0.3) out.push([la, lo]);
  // Asia
  for (let la = 5; la <= 75; la += 5) for (let lo = 60; lo <= 180; lo += 5)
    if (!(la < 25 && lo > 100 && lo < 130)) out.push([la, lo]);
  // SE Asia / Indonesia
  for (let la = -10; la <= 22; la += 3) for (let lo = 95; lo <= 145; lo += 3)
    if (Math.abs(la) < 12 || lo > 120) out.push([la, lo]);
  // Australia
  for (let la = -38; la <= -12; la += 4) for (let lo = 113; lo <= 153; lo += 4) out.push([la, lo]);
  return out;
})();

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { trail: [], ...raw };
  } catch {}
  return { trail: [] };
};

const fmtCoord = (n, posChar, negChar) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.abs(n);
  return v.toFixed(2) + '° ' + (n >= 0 ? posChar : negChar);
};

// Convert lat/lon to canvas (x, y) for an equirectangular projection
const project = (lat, lon, w, h) => {
  // lon in [-180, 180] → x in [0, w]
  // lat in [-90, 90] → y in [0, h] (inverted: +90 at top)
  const x = ((lon + 180) / 360) * w;
  const y = ((90 - lat) / 180) * h;
  return [x, y];
};

export default {
  id: 'iss-tracker',
  name: 'ISS',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [pos, setPos] = useState(null);
    const [error, setError] = useState(null);
    const [lastFetch, setLastFetch] = useState(0);
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const stateRef = useRef(state);
    const posRef = useRef(pos);
    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { posRef.current = pos; }, [pos]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    // Polling
    useEffect(() => {
      let cancelled = false;
      const tick = async () => {
        try {
          const api = window.dashboard && window.dashboard.net;
          if (!api || !api.fetch) {
            if (!cancelled) setError('host net.fetch unavailable');
            return;
          }
          const r = await api.fetch({ url: API_URL, method: 'GET', timeout: 8000 });
          if (cancelled) return;
          if (r.error) { setError(r.error); return; }
          if (!r.ok) { setError('http ' + r.status); return; }
          const j = JSON.parse(r.text);
          setError(null);
          setLastFetch(Date.now());
          const newPos = {
            lat: j.latitude,
            lon: j.longitude,
            altitude: j.altitude,
            velocity: j.velocity,
            visibility: j.visibility,
            ts: Date.now(),
          };
          setPos(newPos);
          // Append to trail (skip if no movement to avoid duplicate points)
          setState((s) => {
            const last = s.trail[s.trail.length - 1];
            if (last && last.lat === newPos.lat && last.lon === newPos.lon) return s;
            const trail = [...s.trail, { lat: newPos.lat, lon: newPos.lon, ts: newPos.ts }];
            if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
            return { ...s, trail };
          });
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      };
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    // Canvas render — repaints on every position update + DPR resize
    useEffect(() => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      let cssW = 0, cssH = 0;

      const resize = () => {
        const r = wrap.getBoundingClientRect();
        cssW = Math.max(1, r.width);
        cssH = Math.max(1, r.height);
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
      };

      const draw = () => {
        if (cssW === 0) return;
        ctx.fillStyle = _cv('--bg', '#050a05');
        ctx.fillRect(0, 0, cssW, cssH);

        // Lat/lon grid lines
        ctx.strokeStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.06)');
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Equator + tropics + arctic circles
        for (const lat of [-66.5, -23.5, 0, 23.5, 66.5]) {
          const [, y] = project(lat, 0, cssW, cssH);
          ctx.moveTo(0, y);
          ctx.lineTo(cssW, y);
        }
        // Prime meridian + 90s + 180
        for (const lon of [-180, -90, 0, 90, 180]) {
          const [x] = project(0, lon, cssW, cssH);
          ctx.moveTo(x, 0);
          ctx.lineTo(x, cssH);
        }
        ctx.stroke();

        // Equator (brighter)
        ctx.strokeStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.12)');
        ctx.lineWidth = 1;
        ctx.beginPath();
        const [, eqY] = project(0, 0, cssW, cssH);
        ctx.moveTo(0, eqY);
        ctx.lineTo(cssW, eqY);
        ctx.stroke();

        // Land dots
        ctx.fillStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.18)');
        for (const [la, lo] of LAND_DOTS) {
          const [x, y] = project(la, lo, cssW, cssH);
          ctx.fillRect(x - 1, y - 1, 2, 2);
        }

        // Reference cities
        ctx.fillStyle = 'rgba(255,180,84,0.55)';
        ctx.font = '8px var(--mono), monospace';
        ctx.textBaseline = 'middle';
        for (const c of CITIES) {
          const [x, y] = project(c.lat, c.lon, cssW, cssH);
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
          if (cssW > 220) {
            ctx.fillStyle = 'rgba(255,180,84,0.4)';
            ctx.fillText(c.name, x + 3, y);
            ctx.fillStyle = 'rgba(255,180,84,0.55)';
          }
        }

        // ISS trail — draw with fading opacity per segment, splitting where
        // the path wraps around the antimeridian
        const trail = stateRef.current.trail;
        if (trail.length > 1) {
          for (let i = 1; i < trail.length; i++) {
            const a = trail[i - 1];
            const b = trail[i];
            // Skip wrap-around segments (longitude jumps > 180°)
            if (Math.abs(b.lon - a.lon) > 180) continue;
            const [ax, ay] = project(a.lat, a.lon, cssW, cssH);
            const [bx, by] = project(b.lat, b.lon, cssW, cssH);
            const alpha = (i / trail.length) * 0.7;
            ctx.strokeStyle = 'rgba(' + _cv('--accent-rgb', '57, 255, 20') + ',' + alpha.toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }

        // ISS position (current)
        const p = posRef.current;
        if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
          const [x, y] = project(p.lat, p.lon, cssW, cssH);
          // Footprint circle (visibility radius is ~2200km on ground; rough)
          ctx.strokeStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.15)');
          ctx.lineWidth = 1;
          ctx.beginPath();
          // ~2000km on ground ≈ 18° arc of latitude
          const radius = (18 / 180) * cssH;
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.stroke();
          // Outer pulse
          ctx.strokeStyle = _cv('--accent', '#39ff14');
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.stroke();
          // Bright dot
          ctx.fillStyle = _cv('--fg-bright', '#9cff9c');
          ctx.shadowColor = _cv('--accent', '#39ff14');
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          // Cross-hairs to make it readable in dim field
          ctx.strokeStyle = 'rgba(156,255,156,0.6)';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x - 8, y); ctx.lineTo(x - 4, y);
          ctx.moveTo(x + 4, y); ctx.lineTo(x + 8, y);
          ctx.moveTo(x, y - 8); ctx.lineTo(x, y - 4);
          ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 8);
          ctx.stroke();
        }
      };

      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(wrap);
      // Redraw on data change (state.trail / pos)
      draw();
      return () => ro.disconnect();
    }, [pos, state.trail.length]);

    const visIcon = pos && pos.visibility === 'daylight' ? '☀' : '☾';
    const visLabel = pos && pos.visibility ? pos.visibility : '—';

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {/* Top stats */}
        <div className="p-row" style={{ alignItems: 'flex-start', gap: 6, fontSize: 10, fontFamily: 'var(--mono)' }}>
          <div style={{ flex: 1 }}>
            <div className="p-label" style={{ fontSize: 8 }}>position</div>
            <div style={{ color: 'var(--accent)', fontSize: 11, lineHeight: 1.2 }}>
              {pos ? fmtCoord(pos.lat, 'N', 'S') : '—'}
            </div>
            <div style={{ color: 'var(--accent)', fontSize: 11, lineHeight: 1.2 }}>
              {pos ? fmtCoord(pos.lon, 'E', 'W') : '—'}
            </div>
          </div>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div className="p-label" style={{ fontSize: 8 }}>altitude</div>
            <div style={{
              color: 'var(--fg-bright)', fontSize: 13, fontWeight: 600,
              textShadow: 'var(--glow-soft)',
            }}>
              {pos && Number.isFinite(pos.altitude) ? pos.altitude.toFixed(0) : '—'}
              <span style={{ fontSize: 9, color: 'var(--fg-dim)', marginLeft: 2 }}>km</span>
            </div>
          </div>
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div className="p-label" style={{ fontSize: 8 }}>velocity</div>
            <div style={{
              color: 'var(--fg-bright)', fontSize: 13, fontWeight: 600,
              textShadow: 'var(--glow-soft)',
            }}>
              {pos && Number.isFinite(pos.velocity) ? (pos.velocity / 3600).toFixed(1) : '—'}
              <span style={{ fontSize: 9, color: 'var(--fg-dim)', marginLeft: 2 }}>km/s</span>
            </div>
          </div>
        </div>

        {error && (
          <div style={{
            padding: '3px 6px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Map */}
        <div ref={wrapRef} style={{
          flex: 1, minHeight: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border-bright)',
          borderRadius: 3,
          overflow: 'hidden',
          position: 'relative',
        }}>
          <canvas
            ref={canvasRef}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 3px)',
            }}
          />
          {!pos && !error && (
            <div className="p-dim" style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontFamily: 'var(--mono)',
              pointerEvents: 'none',
            }}>acquiring signal…</div>
          )}
        </div>

        {/* Footer */}
        <div className="p-row" style={{
          alignItems: 'center', justifyContent: 'space-between',
          fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--fg-dim)',
        }}>
          <span>
            {pos ? (
              <>
                <span style={{ color: pos.visibility === 'daylight' ? 'var(--accent-warm)' : 'var(--fg-dim)' }}>
                  {visIcon} {visLabel}
                </span>
                {' · trail ' + state.trail.length}
              </>
            ) : '—'}
          </span>
          <span>
            updated {lastFetch ? Math.max(0, Math.floor((Date.now() - lastFetch) / 1000)) + 's ago' : '—'}
          </span>
        </div>
      </div>
    );
  },
};
