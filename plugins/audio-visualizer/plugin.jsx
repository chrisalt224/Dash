// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

// Audio Visualizer — Real-time spectrum / waveform / bars from the mic.
//
// • Click "▶ start" to grab the default microphone via getUserMedia. Once
//   running, the canvas reflects audio in your chosen mode.
// • Modes:
//     bars     — classic frequency bars (FFT magnitude per bin)
//     wave     — time-domain waveform line
//     spectrum — full FFT plotted as a continuous "skyline"
//     orb      — radial bars in a circle (shows full spectrum at once)
// • Sensitivity slider amplifies the drawn output (input gain stays at 1.0
//   so we don't risk clipping the audio API).
// • DPR-aware canvas; ResizeObserver re-fits.
//
// Requires a media permission handler in main.js (added alongside this plugin).

const KEY = 'plugin:audio-visualizer:state:v1';

const MODES = [
  { id: 'bars', label: 'bars' },
  { id: 'wave', label: 'wave' },
  { id: 'spectrum', label: 'spectrum' },
  { id: 'orb', label: 'orb' },
];

const DEFAULTS = { mode: 'bars', sensitivity: 1.4, smoothing: 0.7 };

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw };
  } catch {}
  return { ...DEFAULTS };
};

const TERM_BG = () => _cv('--bg', '#0a0e0a');
const ACCENT = () => _cv('--accent', '#39ff14');
const ACCENT_DIM = () => _cv('--fg-dim', '#6f9a6f');
const ACCENT_BRIGHT = () => _cv('--fg-bright', '#9cff9c');

export default {
  id: 'audio-visualizer',
  name: 'Visualizer',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);
    const [level, setLevel] = useState(0);
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const ctxRef = useRef(null);
    const audioCtxRef = useRef(null);
    const streamRef = useRef(null);
    const analyserRef = useRef(null);
    const rafRef = useRef(null);
    const stateRef = useRef(state);
    const runningRef = useRef(running);
    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { runningRef.current = running; }, [running]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    // Apply smoothing changes to the AnalyserNode if it's already running
    useEffect(() => {
      if (analyserRef.current) analyserRef.current.smoothingTimeConstant = state.smoothing;
    }, [state.smoothing]);

    // Canvas setup
    useEffect(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const ctx = canvas.getContext('2d');
      ctxRef.current = ctx;
      const dpr = window.devicePixelRatio || 1;

      const resize = () => {
        const r = wrap.getBoundingClientRect();
        const cssW = Math.max(1, r.width);
        const cssH = Math.max(1, r.height);
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Wipe to background so prior frame doesn't smear during resize
        ctx.fillStyle = TERM_BG();
        ctx.fillRect(0, 0, cssW, cssH);
      };

      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(wrap);
      return () => ro.disconnect();
    }, []);

    const stop = () => {
      runningRef.current = false;
      setRunning(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (streamRef.current) {
        try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
        streamRef.current = null;
      }
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch {}
        audioCtxRef.current = null;
      }
      analyserRef.current = null;
      // Reset canvas
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      if (canvas && ctx) {
        const r = canvas.getBoundingClientRect();
        ctx.fillStyle = TERM_BG();
        ctx.fillRect(0, 0, r.width, r.height);
      }
    };

    const start = async () => {
      if (runningRef.current) return;
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const Ctor = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new Ctor();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = stateRef.current.smoothing;
        source.connect(analyser);
        // NOTE: do NOT connect to destination — we don't want to play the mic back
        streamRef.current = stream;
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;
        runningRef.current = true;
        setRunning(true);
        loop();
      } catch (e) {
        setError(e.message || 'mic access denied');
      }
    };

    // Cleanup on unmount
    useEffect(() => () => stop(), []);

    const loop = () => {
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      const analyser = analyserRef.current;
      if (!canvas || !ctx || !analyser || !runningRef.current) return;
      const r = canvas.getBoundingClientRect();
      const W = r.width, H = r.height;
      const sens = stateRef.current.sensitivity;
      const mode = stateRef.current.mode;

      const binCount = analyser.frequencyBinCount;

      // Fade previous frame for trail effect — use the theme's base bg
      ctx.fillStyle = 'rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0)';
      ctx.fillStyle = TERM_BG();
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;

      if (mode === 'wave') {
        const data = new Uint8Array(binCount);
        analyser.getByteTimeDomainData(data);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = ACCENT_BRIGHT();
        ctx.shadowColor = ACCENT();
        ctx.shadowBlur = 6;
        ctx.beginPath();
        const step = W / data.length;
        for (let i = 0; i < data.length; i++) {
          // 128 is the zero baseline for getByteTimeDomainData
          const v = (data[i] - 128) / 128;
          const y = H / 2 + v * (H / 2) * sens;
          const x = i * step;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        // Center line
        ctx.strokeStyle = ACCENT_DIM();
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.moveTo(0, H / 2);
        ctx.lineTo(W, H / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (mode === 'bars') {
        const data = new Uint8Array(binCount);
        analyser.getByteFrequencyData(data);
        // Skip the topmost bins (pure noise) — render the meaningful range
        const useBins = Math.floor(binCount * 0.55);
        const numBars = Math.min(64, Math.floor(W / 4));
        const binsPerBar = useBins / numBars;
        const barW = W / numBars;
        let total = 0;
        for (let i = 0; i < numBars; i++) {
          let sum = 0;
          for (let j = 0; j < binsPerBar; j++) {
            const idx = Math.floor(i * binsPerBar + j);
            sum += data[idx];
          }
          const v = (sum / binsPerBar / 255) * sens;
          total += v;
          const h = Math.min(H, v * H);
          // Gradient: dim → bright with intensity
          const x = i * barW + 1;
          const y = H - h;
          ctx.fillStyle = ACCENT();
          ctx.shadowColor = ACCENT();
          ctx.shadowBlur = h > H * 0.5 ? 10 : 4;
          ctx.fillRect(x, y, Math.max(1, barW - 2), h);
          // Bright top cap
          ctx.fillStyle = ACCENT_BRIGHT();
          ctx.fillRect(x, y, Math.max(1, barW - 2), Math.min(2, h));
        }
        ctx.shadowBlur = 0;
        setLevel(Math.min(1, (total / numBars)));
      } else if (mode === 'spectrum') {
        const data = new Uint8Array(binCount);
        analyser.getByteFrequencyData(data);
        const useBins = Math.floor(binCount * 0.7);
        ctx.beginPath();
        ctx.moveTo(0, H);
        // Logarithmic x scaling — low frequencies get more space
        for (let x = 0; x <= W; x++) {
          const t = x / W;
          // Logarithmic mapping
          const idx = Math.floor(Math.pow(t, 1.8) * useBins);
          const v = (data[idx] / 255) * sens;
          const y = H - v * H;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.55)'));
        grad.addColorStop(0.5, ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.3)'));
        grad.addColorStop(1, ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.05)'));
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = ACCENT_BRIGHT();
        ctx.lineWidth = 1;
        ctx.shadowColor = ACCENT();
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (mode === 'orb') {
        const data = new Uint8Array(binCount);
        analyser.getByteFrequencyData(data);
        const cx = W / 2, cy = H / 2;
        const baseR = Math.min(W, H) * 0.18;
        const maxR = Math.min(W, H) * 0.45;
        const numBars = 96;
        const useBins = Math.floor(binCount * 0.6);
        ctx.lineWidth = 2;
        ctx.shadowColor = ACCENT();
        ctx.shadowBlur = 4;
        for (let i = 0; i < numBars; i++) {
          const idx = Math.floor((i / numBars) * useBins);
          const v = (data[idx] / 255) * sens;
          const len = (maxR - baseR) * v;
          const angle = (i / numBars) * Math.PI * 2 - Math.PI / 2;
          const x1 = cx + Math.cos(angle) * baseR;
          const y1 = cy + Math.sin(angle) * baseR;
          const x2 = cx + Math.cos(angle) * (baseR + len);
          const y2 = cy + Math.sin(angle) * (baseR + len);
          ctx.strokeStyle = v > 0.5 ? ACCENT_BRIGHT() : ACCENT();
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        // Inner ring
        ctx.strokeStyle = ACCENT_DIM();
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
        ctx.stroke();
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <span className="p-label" style={{ flex: 1 }}>visualizer</span>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 3, overflow: 'hidden',
          }}>
            {MODES.map((m) => {
              const active = state.mode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setState((s) => ({ ...s, mode: m.id }))}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '2px 8px',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                  }}
                >{m.label}</button>
              );
            })}
          </div>
          <button
            onClick={running ? stop : start}
            style={{
              background: running ? 'rgba(255,107,107,0.1)' : 'var(--accent)',
              color: running ? 'var(--danger)' : 'var(--bg)',
              border: '1px solid ' + (running ? 'var(--danger)' : 'var(--accent)'),
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '2px 10px', borderRadius: 2, cursor: 'pointer',
              fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            }}
          >{running ? '■ stop' : '▶ start'}</button>
        </div>

        {error && (
          <div style={{
            padding: '4px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Canvas */}
        <div ref={wrapRef} style={{
          flex: 1, minHeight: 0,
          background: TERM_BG(),
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
          {!running && !error && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column',
              pointerEvents: 'none',
              color: 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 11,
              gap: 4,
            }}>
              <div style={{ color: 'var(--accent)', textShadow: 'var(--glow)' }}>● input idle</div>
              <div style={{ fontSize: 9, opacity: 0.7 }}>click ▶ start to listen</div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="p-row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="p-dim" style={{ fontSize: 9, width: 50 }}>sens {state.sensitivity.toFixed(1)}</span>
          <input
            type="range" min="0.5" max="3" step="0.1"
            value={state.sensitivity}
            onChange={(e) => setState((s) => ({ ...s, sensitivity: parseFloat(e.target.value) }))}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
          />
          <span className="p-dim" style={{ fontSize: 9, width: 60 }}>smooth {state.smoothing.toFixed(2)}</span>
          <input
            type="range" min="0" max="0.95" step="0.05"
            value={state.smoothing}
            onChange={(e) => setState((s) => ({ ...s, smoothing: parseFloat(e.target.value) }))}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
          />
        </div>
      </div>
    );
  },
};
