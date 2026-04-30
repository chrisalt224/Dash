// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

export default {
  id: 'hyperspace-starfield',
  name: 'HYPERSPACE',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const KEY = 'plugin:hyperspace-starfield:state:v1';

    const [warp, setWarp] = useState(() => {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw).warp || 8 : 8;
      } catch { return 8; }
    });
    const [isPaused, setIsPaused] = useState(false);

    const canvasRef = useRef(null);
    const wrapRef = useRef(null);
    const starsRef = useRef([]);
    const rafRef = useRef(null);
    const keysRef = useRef({ up: false, down: false });
    const lastTimeRef = useRef(performance.now());

    // Persist warp
    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify({ warp })); } catch {}
    }, [warp]);

    // Initialize stars
    const initStars = (count = 420) => {
      const arr = [];
      for (let i = 0; i < count; i++) {
        arr.push({
          x: (Math.random() - 0.5) * 1600,
          y: (Math.random() - 0.5) * 900,
          z: Math.random() * 900 + 50,
          size: Math.random() * 1.8 + 0.6,
          hue: Math.random() > 0.7 ? 'var(--accent)' : (Math.random() > 0.5 ? '#00ffff' : 'var(--fg-bright)')
        });
      }
      starsRef.current = arr;
    };

    // Keyboard handling (only when canvas focused)
    useEffect(() => {
      const handleKeyDown = (e) => {
        if (document.activeElement !== canvasRef.current) return;
        if (e.key === 'ArrowUp') keysRef.current.up = true;
        if (e.key === 'ArrowDown') keysRef.current.down = true;
        if (e.key.toLowerCase() === ' ') {
          e.preventDefault();
          setIsPaused(p => !p);
        }
      };

      const handleKeyUp = (e) => {
        if (document.activeElement !== canvasRef.current) return;
        if (e.key === 'ArrowUp') keysRef.current.up = false;
        if (e.key === 'ArrowDown') keysRef.current.down = false;
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
      };
    }, []);

    // Main animation loop
    useEffect(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;

      const ctx = canvas.getContext('2d', { alpha: true });
      let cssW = 0, cssH = 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      if (starsRef.current.length === 0) initStars();

      const resize = () => {
        const r = wrap.getBoundingClientRect();
        cssW = Math.max(120, r.width);
        cssH = Math.max(120, r.height);
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };

      const ro = new ResizeObserver(resize);
      ro.observe(wrap);
      resize();

      const draw = (now) => {
        const dt = Math.min(0.05, (now - lastTimeRef.current) / 1000);
        lastTimeRef.current = now;

        ctx.fillStyle = _cv('--bg', '#050a05');
        ctx.fillRect(0, 0, cssW, cssH);

        // Subtle vignette
        const grad = ctx.createRadialGradient(
          cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.3,
          cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.85
        );
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.65)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cssW, cssH);

        const cx = cssW / 2;
        const cy = cssH / 2;
        const stars = starsRef.current;

        let currentWarp = warp;
        if (keysRef.current.up) currentWarp = Math.min(48, currentWarp + 18);
        if (keysRef.current.down) currentWarp = Math.max(1, currentWarp - 18);

        const speed = currentWarp * 42 * dt;

        for (let i = 0; i < stars.length; i++) {
          const s = stars[i];

          // Move toward camera (decrease z)
          s.z -= speed;

          // Respawn when too close
          if (s.z < 8) {
            s.x = (Math.random() - 0.5) * 1600;
            s.y = (Math.random() - 0.5) * 900;
            s.z = 850 + Math.random() * 120;
            s.size = Math.random() * 1.8 + 0.6;
          }

          // Project 3D → 2D
          const scale = 420 / s.z;
          const px = cx + s.x * scale;
          const py = cy + s.y * scale;

          // Previous position for motion trail
          const prevScale = 420 / (s.z + speed * 0.6);
          const prevX = cx + s.x * prevScale;
          const prevY = cy + s.y * prevScale;

          // Draw motion blur line
          ctx.strokeStyle = s.hue;
          ctx.lineWidth = Math.max(0.6, s.size * scale * 0.9);
          ctx.shadowColor = s.hue;
          ctx.shadowBlur = 6;

          ctx.beginPath();
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(px, py);
          ctx.stroke();

          // Bright core
          ctx.fillStyle = '#ffffff';
          ctx.shadowBlur = 2;
          const coreSize = Math.max(0.8, s.size * scale * 0.65);
          ctx.fillRect(px - coreSize / 2, py - coreSize / 2, coreSize, coreSize);

          ctx.shadowBlur = 0;
        }

        // HUD
        ctx.fillStyle = _cv('--accent', '#39ff14');
        ctx.font = '10px var(--mono)';
        ctx.shadowColor = _cv('--accent', '#39ff14');
        ctx.shadowBlur = 4;
        ctx.fillText(`WARP ${currentWarp.toFixed(0)}×`, 10, 18);
        ctx.shadowBlur = 0;

        if (isPaused) {
          ctx.fillStyle = 'rgba(255,180,84,0.9)';
          ctx.font = 'bold 11px var(--mono)';
          ctx.fillText('⏸ PAUSED', cssW - 72, 18);
        }

        // Instructions (faint)
        if (!isPaused && currentWarp < 12) {
          ctx.fillStyle = 'rgba(111,154,111,0.6)';
          ctx.font = '8px var(--mono)';
          ctx.fillText('↑↓ warp  •  SPACE pause  •  click to focus', 10, cssH - 8);
        }
      };

      const loop = (now) => {
        if (!isPaused) draw(now);
        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);

      // Click to focus for keyboard
      const focusCanvas = () => canvas.focus();
      canvas.addEventListener('click', focusCanvas);

      return () => {
        ro.disconnect();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        canvas.removeEventListener('click', focusCanvas);
      };
    }, [warp, isPaused]);

    const changeWarp = (newWarp) => {
      const clamped = Math.max(1, Math.min(50, Math.round(newWarp)));
      setWarp(clamped);
    };

    return (
      <div className="p-col" style={{ height: '100%', background: 'var(--bg)', overflow: 'hidden' }}>
        <div ref={wrapRef} style={{ flex: 1, position: 'relative' }}>
          <canvas
            ref={canvasRef}
            tabIndex={0}
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              outline: 'none',
              cursor: 'crosshair'
            }}
          />
        </div>

        {/* Bottom control bar */}
        <div 
          className="p-row" 
          style={{ 
            padding: '4px 8px', 
            background: '#0a120a', 
            borderTop: '1px solid var(--border)',
            fontSize: 9,
            alignItems: 'center',
            gap: 8
          }}
        >
          <div className="p-dim" style={{ fontSize: 8 }}>WARP</div>
          
          <input 
            type="range" 
            min="1" 
            max="50" 
            step="1"
            value={warp}
            onChange={(e) => changeWarp(parseInt(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
          />
          
          <div style={{ 
            fontSize: 10, 
            color: 'var(--accent)', 
            minWidth: 28, 
            textAlign: 'right',
            fontFamily: 'var(--mono)'
          }}>
            {warp}×
          </div>

          <button 
            className="p-btn" 
            style={{ padding: '1px 8px', fontSize: 9 }}
            onClick={() => setIsPaused(p => !p)}
          >
            {isPaused ? '▶' : '⏸'}
          </button>
        </div>
      </div>
    );
  },
};
