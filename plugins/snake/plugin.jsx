// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

// Snake — Classic snake on a phosphor grid.
//
// • Click the playfield to give it focus, then arrow keys (or WASD) to
//   steer. p / Space to pause. r restarts after game over.
// • Snake grows on each food. Walls and self collisions = game over.
// • Persistent high-score. Speed setting (slow / med / fast).
// • Tiny chiptune blip on food via Web Audio.
//
// Pure renderer · canvas + RAF · no host APIs.

const KEY = 'plugin:snake:state:v1';

const TERM_BG = () => _cv('--bg', '#0a0e0a');
const GRID_LINE = () => 'rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.06)';
const SNAKE_HEAD = () => _cv('--fg-bright', '#9cff9c');
const SNAKE_BODY = () => _cv('--accent', '#39ff14');
const SNAKE_GLOW = () => 'rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.6)';
const FOOD = () => _cv('--accent-warm', '#ffb454');
const FOOD_GLOW = 'rgba(255,180,84,0.6)';

const SPEEDS = { slow: 160, med: 110, fast: 70 };
const GRID_W = 22, GRID_H = 18;

const DIRS = {
  ArrowUp:    { x: 0,  y: -1, key: 'up' },
  ArrowDown:  { x: 0,  y:  1, key: 'down' },
  ArrowLeft:  { x: -1, y: 0,  key: 'left' },
  ArrowRight: { x: 1,  y: 0,  key: 'right' },
  KeyW:       { x: 0,  y: -1, key: 'up' },
  KeyS:       { x: 0,  y:  1, key: 'down' },
  KeyA:       { x: -1, y: 0,  key: 'left' },
  KeyD:       { x: 1,  y: 0,  key: 'right' },
};

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { highScore: 0, speed: 'med', ...raw };
  } catch {}
  return { highScore: 0, speed: 'med' };
};

let audioCtx = null;
const blip = (freq, dur) => {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.005);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {}
};

const initialSnake = () => [
  { x: Math.floor(GRID_W / 2) - 1, y: Math.floor(GRID_H / 2) },
  { x: Math.floor(GRID_W / 2),     y: Math.floor(GRID_H / 2) },
];

const randomFood = (snake) => {
  const cells = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (!snake.some((s) => s.x === x && s.y === y)) cells.push({ x, y });
    }
  }
  if (cells.length === 0) return null; // win condition
  return cells[Math.floor(Math.random() * cells.length)];
};

export default {
  id: 'snake',
  name: 'Snake',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [score, setScore] = useState(0);
    const [running, setRunning] = useState(false);
    const [gameOver, setGameOver] = useState(false);
    const [paused, setPaused] = useState(false);
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);

    // Game state in refs (mutated outside React)
    const snakeRef = useRef(initialSnake());
    const dirRef = useRef('right');
    const queuedDirRef = useRef('right');
    const foodRef = useRef(randomFood(snakeRef.current));
    const lastTickRef = useRef(0);
    const stateRef = useRef(state);
    const runningRef = useRef(false);
    const pausedRef = useRef(false);
    const gameOverRef = useRef(false);
    const scoreRef = useRef(0);

    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { runningRef.current = running; }, [running]);
    useEffect(() => { pausedRef.current = paused; }, [paused]);
    useEffect(() => { gameOverRef.current = gameOver; }, [gameOver]);
    useEffect(() => { scoreRef.current = score; }, [score]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const reset = () => {
      snakeRef.current = initialSnake();
      dirRef.current = 'right';
      queuedDirRef.current = 'right';
      foodRef.current = randomFood(snakeRef.current);
      lastTickRef.current = 0;
      setScore(0);
      setGameOver(false);
      setPaused(false);
    };

    const start = () => {
      if (gameOverRef.current) reset();
      setRunning(true);
      setPaused(false);
      // Touch audio context inside a user gesture so first-blip works
      try {
        if (!audioCtx) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor) audioCtx = new Ctor();
        }
      } catch {}
      // Refocus the canvas so keyboard works
      if (canvasRef.current) canvasRef.current.focus();
    };

    const togglePause = () => {
      if (gameOverRef.current) { reset(); start(); return; }
      if (!runningRef.current) { start(); return; }
      setPaused((p) => !p);
    };

    const onKeyDown = (e) => {
      const code = e.code;
      if (code === 'Space' || code === 'KeyP') {
        e.preventDefault();
        togglePause();
        return;
      }
      if (code === 'KeyR') { e.preventDefault(); reset(); start(); return; }
      const d = DIRS[code];
      if (!d) return;
      e.preventDefault();
      if (!runningRef.current && !gameOverRef.current) start();
      const cur = dirRef.current;
      // Don't allow 180° reversal in same tick (queue against current actual dir)
      if (OPPOSITE[d.key] === cur) return;
      queuedDirRef.current = d.key;
    };

    // Canvas setup + render loop
    useEffect(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;

      let cssW = 0, cssH = 0, cell = 16;
      let raf;

      const resize = () => {
        const r = wrap.getBoundingClientRect();
        cssW = Math.max(1, r.width);
        cssH = Math.max(1, r.height);
        // Compute integer cell size that fits both axes
        cell = Math.max(4, Math.floor(Math.min(cssW / GRID_W, cssH / GRID_H)));
        const drawW = cell * GRID_W;
        const drawH = cell * GRID_H;
        canvas.width = Math.floor(drawW * dpr);
        canvas.height = Math.floor(drawH * dpr);
        canvas.style.width = drawW + 'px';
        canvas.style.height = drawH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };

      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(wrap);

      const tick = () => {
        const cur = queuedDirRef.current;
        // Apply queued direction (we already filtered 180° in onKeyDown)
        dirRef.current = cur;
        const dirVec =
          cur === 'up'    ? { x: 0,  y: -1 } :
          cur === 'down'  ? { x: 0,  y:  1 } :
          cur === 'left'  ? { x: -1, y:  0 } :
                            { x: 1,  y:  0 };
        const head = snakeRef.current[snakeRef.current.length - 1];
        const next = { x: head.x + dirVec.x, y: head.y + dirVec.y };
        // Wall collision
        if (next.x < 0 || next.y < 0 || next.x >= GRID_W || next.y >= GRID_H) {
          endGame();
          return;
        }
        // Self collision (allow moving into the tail because tail will move)
        const willEat = foodRef.current && next.x === foodRef.current.x && next.y === foodRef.current.y;
        const checkUntil = willEat ? snakeRef.current.length : snakeRef.current.length - 1;
        for (let i = 1; i <= checkUntil && i < snakeRef.current.length; i++) {
          const seg = snakeRef.current[i];
          if (seg.x === next.x && seg.y === next.y) {
            endGame();
            return;
          }
        }
        snakeRef.current.push(next);
        if (willEat) {
          foodRef.current = randomFood(snakeRef.current);
          const newScore = scoreRef.current + 1;
          setScore(newScore);
          blip(660 + newScore * 20, 0.07);
        } else {
          snakeRef.current.shift();
        }
      };

      const endGame = () => {
        runningRef.current = false;
        gameOverRef.current = true;
        setRunning(false);
        setGameOver(true);
        // Sad descending blip
        blip(220, 0.12);
        setTimeout(() => blip(160, 0.18), 130);
        // Update high score
        const cur = scoreRef.current;
        const hs = stateRef.current.highScore || 0;
        if (cur > hs) setState((s) => ({ ...s, highScore: cur }));
      };

      const draw = (now) => {
        // Background
        ctx.fillStyle = TERM_BG();
        ctx.fillRect(0, 0, GRID_W * cell, GRID_H * cell);
        // Grid lines
        ctx.strokeStyle = GRID_LINE();
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= GRID_W; x++) {
          ctx.moveTo(x * cell + 0.5, 0);
          ctx.lineTo(x * cell + 0.5, GRID_H * cell);
        }
        for (let y = 0; y <= GRID_H; y++) {
          ctx.moveTo(0, y * cell + 0.5);
          ctx.lineTo(GRID_W * cell, y * cell + 0.5);
        }
        ctx.stroke();

        // Food
        if (foodRef.current) {
          ctx.shadowColor = FOOD_GLOW;
          ctx.shadowBlur = 8;
          ctx.fillStyle = FOOD();
          const f = foodRef.current;
          ctx.fillRect(f.x * cell + 2, f.y * cell + 2, cell - 4, cell - 4);
          ctx.shadowBlur = 0;
        }

        // Snake
        ctx.shadowColor = SNAKE_GLOW();
        ctx.shadowBlur = 6;
        const segs = snakeRef.current;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          const isHead = i === segs.length - 1;
          ctx.fillStyle = isHead ? SNAKE_HEAD : SNAKE_BODY();
          ctx.fillRect(s.x * cell + 1, s.y * cell + 1, cell - 2, cell - 2);
        }
        ctx.shadowBlur = 0;

        // Tick game forward at speed
        if (runningRef.current && !pausedRef.current && !gameOverRef.current) {
          const interval = SPEEDS[stateRef.current.speed] || SPEEDS.med;
          if (now - lastTickRef.current >= interval) {
            lastTickRef.current = now;
            tick();
          }
        } else {
          lastTickRef.current = now; // freeze the clock while paused
        }

        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
      };
    }, []);

    const setSpeed = (sp) => setState((s) => ({ ...s, speed: sp }));

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="p-label">snake</span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700,
            color: 'var(--accent)',
            textShadow: 'var(--glow)',
          }}>{score}</span>
          <span className="p-dim" style={{ fontSize: 9 }}>hi {state.highScore}</span>
        </div>

        {/* Playfield */}
        <div
          ref={wrapRef}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: TERM_BG(),
            border: '1px solid var(--border-bright)',
            borderRadius: 3,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onClick={() => canvasRef.current && canvasRef.current.focus()}
            style={{
              outline: 'none',
              cursor: gameOver ? 'pointer' : 'default',
              display: 'block',
            }}
          />
          {/* Overlay messages */}
          {!running && !gameOver && (
            <div style={overlayStyle}>
              <div style={{ fontSize: 11, color: 'var(--accent)', textShadow: 'var(--glow)' }}>
                ▶ click or press any arrow
              </div>
              <div className="p-dim" style={{ fontSize: 9, marginTop: 4 }}>
                arrows / wasd · p pause · r reset
              </div>
            </div>
          )}
          {paused && running && (
            <div style={overlayStyle}>
              <div style={{ fontSize: 14, color: 'var(--accent-warm)', textShadow: '0 0 6px var(--accent-warm)' }}>⏸ paused</div>
            </div>
          )}
          {gameOver && (
            <div style={overlayStyle}>
              <div style={{ fontSize: 14, color: 'var(--danger)', textShadow: '0 0 6px var(--danger)' }}>game over</div>
              <div className="p-dim" style={{ fontSize: 10, marginTop: 2 }}>score {score}{score === state.highScore && score > 0 ? ' · new best' : ''}</div>
              <div className="p-dim" style={{ fontSize: 9, marginTop: 2 }}>r or click to restart</div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
          <button
            onClick={() => running && !gameOver ? togglePause() : start()}
            className="p-btn"
            style={{ flex: 1, padding: '3px 8px', fontSize: 11 }}
          >
            {gameOver ? '↻ restart' : (running ? (paused ? '▶ resume' : '⏸ pause') : '▶ start')}
          </button>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 3, overflow: 'hidden',
          }}>
            {Object.keys(SPEEDS).map((sp) => {
              const active = state.speed === sp;
              return (
                <button
                  key={sp}
                  onClick={() => setSpeed(sp)}
                  style={{
                    background: active ? 'var(--accent-warm)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    padding: '2px 6px', cursor: 'pointer',
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                  }}
                >{sp}</button>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
};

const overlayStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
  fontFamily: 'var(--mono)',
  background: 'rgba(5,10,5,0.4)',
};
