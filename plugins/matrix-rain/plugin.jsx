// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

// Matrix Rain — Cascading green glyphs on a phosphor canvas.
//
// • Per-column streams of falling characters; bright leading glyph fades to
//   dim trail. Glyph rotates randomly each frame for that "they're moving"
//   feel. New streams spawn at top after old ones exit the bottom.
// • Settings (gear icon, top-right):
//     glyphs:   katakana / latin / binary / mixed
//     speed:    0.3 → 2.0
//     density:  fraction of columns active at once
// • DPR-aware canvas; ResizeObserver re-fits on widget resize.
// • Low-CPU: only redraws when streams need to advance (frame-paced via RAF
//   but with a frame-time accumulator to control speed).

const KEY = 'plugin:matrix-rain:state:v1';

const GLYPH_SETS = {
  katakana: 'ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ012789Z+-*=<>',
  latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  binary: '01',
  mixed: 'ｦｱｳｴｵｶｷｸｹｺABCDEFGHJKLMNPQRSTUWXYZ0123456789@#$%&*+=<>',
};

const FONT_PX = 14;
const HEAD_COLOR = () => _cv('--fg-bright', '#9cff9c');
const BODY_COLOR = () => _cv('--accent', '#39ff14');
const FADE_COLOR = 'rgba(5, 10, 5, 0.08)';

const DEFAULTS = { glyphs: 'katakana', speed: 1.0, density: 0.85 };

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw };
  } catch {}
  return { ...DEFAULTS };
};

const pickGlyph = (chars) => chars[(Math.random() * chars.length) | 0];

export default {
  id: 'matrix-rain',
  name: 'Matrix Rain',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    useEffect(() => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;

      let cssW = 0, cssH = 0, cols = 0;
      let drops = [];
      let lastT = performance.now();
      let raf;

      const initDrops = () => {
        cols = Math.max(1, Math.floor(cssW / FONT_PX));
        drops = new Array(cols);
        for (let i = 0; i < cols; i++) {
          drops[i] = {
            // y in pixels; start above the top, staggered
            y: -Math.random() * cssH,
            // per-stream delay so columns don't all march in lockstep
            speed: 0.5 + Math.random() * 1.0,
            // stream is "alive" — controlled by density
            alive: Math.random() < stateRef.current.density,
          };
        }
      };

      const resize = () => {
        const r = wrap.getBoundingClientRect();
        cssW = Math.max(1, r.width);
        cssH = Math.max(1, r.height);
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = FONT_PX + 'px var(--mono), monospace';
        ctx.textBaseline = 'top';
        // Clear with full opaque background to reset
        ctx.fillStyle = _cv('--bg', '#050a05');
        ctx.fillRect(0, 0, cssW, cssH);
        initDrops();
      };

      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(wrap);

      const draw = (now) => {
        const s = stateRef.current;
        // Frame-time pacing: at speed=1.0, advance ~once per 50ms (~20fps)
        const dt = Math.min(100, now - lastT);
        lastT = now;
        const stepMs = 50 / s.speed;
        // Number of advance steps in this frame
        const steps = Math.max(1, Math.floor(dt / stepMs));
        for (let step = 0; step < steps; step++) {
          // Fade overlay — leaves a trail
          ctx.fillStyle = FADE_COLOR;
          ctx.fillRect(0, 0, cssW, cssH);

          const chars = GLYPH_SETS[s.glyphs] || GLYPH_SETS.katakana;
          for (let i = 0; i < cols; i++) {
            const d = drops[i];
            if (!d.alive) {
              // Occasionally wake a column based on density
              if (Math.random() < 0.005 * s.density) {
                d.alive = true;
                d.y = -FONT_PX * (5 + Math.random() * 30);
                d.speed = 0.5 + Math.random() * 1.0;
              }
              continue;
            }
            const x = i * FONT_PX;
            // Bright head
            ctx.fillStyle = HEAD_COLOR();
            ctx.shadowColor = HEAD_COLOR();
            ctx.shadowBlur = 6;
            ctx.fillText(pickGlyph(chars), x, d.y);
            // Dimmer mid-tail (one or two glyphs above)
            ctx.shadowBlur = 0;
            ctx.fillStyle = BODY_COLOR();
            ctx.fillText(pickGlyph(chars), x, d.y - FONT_PX);
            d.y += FONT_PX * d.speed;
            if (d.y > cssH + FONT_PX * 5) {
              if (Math.random() < (1 - s.density) * 0.5) d.alive = false;
              else { d.y = -FONT_PX; d.speed = 0.5 + Math.random() * 1.0; }
            }
          }
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
      };
    }, []);

    return (
      <div ref={wrapRef} style={{
        position: 'relative',
        height: '100%',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 3,
        overflow: 'hidden',
      }}>
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            // Slight scanline gradient on top of the canvas
            backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0 1px, transparent 1px 3px)',
          }}
        />
        {/* Gear toggle */}
        <button
          onClick={() => setSettingsOpen((o) => !o)}
          title="settings"
          style={{
            position: 'absolute',
            top: 4, right: 4,
            background: 'rgba(0,0,0,0.5)',
            border: '1px solid var(--border-bright)',
            color: settingsOpen ? 'var(--accent)' : 'var(--fg-dim)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 2,
            cursor: 'pointer',
            lineHeight: 1.2,
          }}
        >⚙</button>
        {/* Settings panel */}
        {settingsOpen && (
          <div style={{
            position: 'absolute',
            top: 28, right: 4,
            background: 'rgba(5, 10, 5, 0.92)',
            border: '1px solid var(--border-bright)',
            borderRadius: 3,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            minWidth: 160,
            backdropFilter: 'blur(4px)',
          }}>
            <div className="p-col" style={{ gap: 2 }}>
              <span className="p-label" style={{ fontSize: 9 }}>glyphs</span>
              <select
                value={state.glyphs}
                onChange={(e) => setState((s) => ({ ...s, glyphs: e.target.value }))}
                className="p-input"
                style={{ fontSize: 11 }}
              >
                {Object.keys(GLYPH_SETS).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div className="p-col" style={{ gap: 2 }}>
              <span className="p-label" style={{ fontSize: 9 }}>speed: {state.speed.toFixed(1)}x</span>
              <input
                type="range" min="0.3" max="2" step="0.1"
                value={state.speed}
                onChange={(e) => setState((s) => ({ ...s, speed: parseFloat(e.target.value) }))}
                style={{ accentColor: 'var(--accent)' }}
              />
            </div>
            <div className="p-col" style={{ gap: 2 }}>
              <span className="p-label" style={{ fontSize: 9 }}>density: {Math.round(state.density * 100)}%</span>
              <input
                type="range" min="0.2" max="1" step="0.05"
                value={state.density}
                onChange={(e) => setState((s) => ({ ...s, density: parseFloat(e.target.value) }))}
                style={{ accentColor: 'var(--accent)' }}
              />
            </div>
          </div>
        )}
      </div>
    );
  },
};
