// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

// Tetris — Classic block-stacking with hold, ghost piece, 7-bag randomizer.
//
// Controls (when widget has focus — click on the board first):
//   ← / →    move horizontally
//   ↓        soft drop (+1 score per cell)
//   space    hard drop (+2 score per cell)
//   ↑ / x    rotate clockwise
//   z        rotate counterclockwise
//   c        hold (or swap with held piece) — once per piece
//   p        pause
//   r        reset
//
// • 7-bag randomizer: fair distribution; you'll never wait too long for an I.
// • Naive rotation kicks: tries +1/-1 horizontal then -1 vertical when a
//   rotation would collide. Not full SRS but feels right for casual play.
// • Speed scales with level (lines / 10).

const KEY = 'plugin:tetris:state:v1';
const COLS = 10, ROWS = 20;

const COLORS = {
  I: { fill: '#5eeaff', glow: 'rgba(94,234,255,0.5)' },
  O: { fill: '#ffd54a', glow: 'rgba(255,213,74,0.5)' },
  T: { fill: '#ff6bd6', glow: 'rgba(255,107,214,0.5)' },
  S: { fill: 'var(--accent)', glow: 'rgba(var(--accent-rgb),0.5)' },
  Z: { fill: 'var(--danger)', glow: 'rgba(255,107,107,0.5)' },
  J: { fill: '#5eaaff', glow: 'rgba(94,170,255,0.5)' },
  L: { fill: 'var(--accent-warm)', glow: 'rgba(255,180,84,0.5)' },
};

// 4 rotation states for each piece. Some pieces have visually identical
// states across rotations — keeping all 4 simplifies the rotation index math.
const SHAPES = {
  I: [
    [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],
    [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]],
  ],
  O: [
    [[1,1],[1,1]],
    [[1,1],[1,1]],
    [[1,1],[1,1]],
    [[1,1],[1,1]],
  ],
  T: [
    [[0,1,0],[1,1,1],[0,0,0]],
    [[0,1,0],[0,1,1],[0,1,0]],
    [[0,0,0],[1,1,1],[0,1,0]],
    [[0,1,0],[1,1,0],[0,1,0]],
  ],
  S: [
    [[0,1,1],[1,1,0],[0,0,0]],
    [[0,1,0],[0,1,1],[0,0,1]],
    [[0,0,0],[0,1,1],[1,1,0]],
    [[1,0,0],[1,1,0],[0,1,0]],
  ],
  Z: [
    [[1,1,0],[0,1,1],[0,0,0]],
    [[0,0,1],[0,1,1],[0,1,0]],
    [[0,0,0],[1,1,0],[0,1,1]],
    [[0,1,0],[1,1,0],[1,0,0]],
  ],
  J: [
    [[1,0,0],[1,1,1],[0,0,0]],
    [[0,1,1],[0,1,0],[0,1,0]],
    [[0,0,0],[1,1,1],[0,0,1]],
    [[0,1,0],[0,1,0],[1,1,0]],
  ],
  L: [
    [[0,0,1],[1,1,1],[0,0,0]],
    [[0,1,0],[0,1,0],[0,1,1]],
    [[0,0,0],[1,1,1],[1,0,0]],
    [[1,1,0],[0,1,0],[0,1,0]],
  ],
};

const PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(null));

const newBag = () => {
  const bag = PIECE_TYPES.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
};

const spawnPiece = (type) => ({
  type,
  rotation: 0,
  // Spawn at top, roughly centered. Subtract size/2 for proper centering.
  x: Math.floor((COLS - SHAPES[type][0][0].length) / 2),
  y: 0,
});

const cellsOf = (piece) => {
  const shape = SHAPES[piece.type][piece.rotation];
  const cells = [];
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) cells.push([piece.y + r, piece.x + c]);
    }
  }
  return cells;
};

const collides = (board, piece) => {
  for (const [r, c] of cellsOf(piece)) {
    if (c < 0 || c >= COLS || r >= ROWS) return true;
    if (r >= 0 && board[r][c]) return true;
  }
  return false;
};

const lockPiece = (board, piece) => {
  const next = board.map((row) => row.slice());
  for (const [r, c] of cellsOf(piece)) {
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) next[r][c] = piece.type;
  }
  return next;
};

const clearLines = (board) => {
  const kept = board.filter((row) => !row.every((cell) => cell !== null));
  const cleared = ROWS - kept.length;
  while (kept.length < ROWS) kept.unshift(Array(COLS).fill(null));
  return { board: kept, cleared };
};

// Score per line clear count, before level multiplier
const LINE_SCORES = [0, 100, 300, 500, 800];

const fallSpeedMs = (level) => {
  // Roughly classic NES gravity but capped so high levels stay playable
  const tab = [800, 720, 640, 560, 480, 400, 320, 240, 180, 140, 120, 100, 90, 80, 70, 60, 50, 45, 40, 35, 30];
  return tab[Math.min(level, tab.length - 1)];
};

const loadBest = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return { highScore: 0 };
};

let audioCtx = null;
const beep = (freq, dur, vol) => {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol || 0.15, t + 0.005);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {}
};

export default {
  id: 'tetris',
  name: 'Tetris',
  width: 2,
  height: 4,
  component: ({ useState, useEffect, useRef }) => {
    const [persisted, setPersisted] = useState(loadBest);
    const [running, setRunning] = useState(false);
    const [paused, setPaused] = useState(false);
    const [gameOver, setGameOver] = useState(false);
    const [score, setScore] = useState(0);
    const [lines, setLines] = useState(0);

    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const previewRef = useRef(null);  // for next + hold

    // Game state in refs (mutated outside React)
    const boardRef = useRef(emptyBoard());
    const pieceRef = useRef(null);
    const bagRef = useRef([]);
    const nextRef = useRef([]); // queue of next pieces
    const holdRef = useRef(null);
    const canHoldRef = useRef(true);
    const lastFallRef = useRef(0);
    const accRef = useRef(0);
    const lockTimerRef = useRef(0);
    const stateRef = useRef({ score: 0, lines: 0, level: 0 });

    const runningRef = useRef(running);
    const pausedRef = useRef(paused);
    const gameOverRef = useRef(gameOver);
    useEffect(() => { runningRef.current = running; }, [running]);
    useEffect(() => { pausedRef.current = paused; }, [paused]);
    useEffect(() => { gameOverRef.current = gameOver; }, [gameOver]);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(persisted)), 200);
      return () => clearTimeout(id);
    }, [persisted]);

    const drawNext = () => {
      const canvas = previewRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = _cv('--bg', '#050a05');
      ctx.fillRect(0, 0, w, h);

      const cellSize = Math.floor(w / 6);
      const drawMini = (type, originY, label) => {
        ctx.fillStyle = 'var(--fg-dim)';
        ctx.font = '8px var(--mono), monospace';
        // Use direct color since CSS vars don't apply to canvas
        ctx.fillStyle = 'rgba(111,154,111,0.8)';
        ctx.textBaseline = 'top';
        ctx.fillText(label, 4, originY);
        if (!type) return;
        const shape = SHAPES[type][0];
        const color = COLORS[type];
        const ox = (w - shape[0].length * cellSize) / 2;
        const oy = originY + 12;
        for (let r = 0; r < shape.length; r++) {
          for (let c = 0; c < shape[r].length; c++) {
            if (!shape[r][c]) continue;
            const x = ox + c * cellSize, y = oy + r * cellSize;
            ctx.fillStyle = color.fill;
            ctx.shadowColor = color.glow;
            ctx.shadowBlur = 4;
            ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
            ctx.shadowBlur = 0;
          }
        }
      };

      const next = nextRef.current[0];
      drawMini(next, 0, 'NEXT');
      const previewH = Math.floor(h / 2);
      drawMini(holdRef.current, previewH, 'HOLD');
    };

    const drawBoard = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width);
      const cssH = Math.max(1, rect.height);
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Compute integer cell size that fits both axes
      const cell = Math.max(4, Math.floor(Math.min(cssW / COLS, cssH / ROWS)));
      const boardW = cell * COLS;
      const boardH = cell * ROWS;
      const offsetX = Math.floor((cssW - boardW) / 2);
      const offsetY = Math.floor((cssH - boardH) / 2);

      // Background
      ctx.fillStyle = _cv('--bg', '#050a05');
      ctx.fillRect(0, 0, cssW, cssH);

      // Playfield outline
      ctx.strokeStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.2)');
      ctx.strokeRect(offsetX - 0.5, offsetY - 0.5, boardW + 1, boardH + 1);

      // Grid lines
      ctx.strokeStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.05)');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < COLS; c++) {
        const x = offsetX + c * cell + 0.5;
        ctx.moveTo(x, offsetY); ctx.lineTo(x, offsetY + boardH);
      }
      for (let r = 1; r < ROWS; r++) {
        const y = offsetY + r * cell + 0.5;
        ctx.moveTo(offsetX, y); ctx.lineTo(offsetX + boardW, y);
      }
      ctx.stroke();

      // Locked cells
      const board = boardRef.current;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const t = board[r][c];
          if (!t) continue;
          const x = offsetX + c * cell, y = offsetY + r * cell;
          const color = COLORS[t];
          ctx.fillStyle = color.fill;
          ctx.shadowColor = color.glow;
          ctx.shadowBlur = 4;
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
          ctx.shadowBlur = 0;
        }
      }

      // Ghost piece (drop preview)
      const piece = pieceRef.current;
      if (piece && !gameOverRef.current) {
        let ghostY = piece.y;
        while (!collides(board, { ...piece, y: ghostY + 1 })) ghostY++;
        const ghost = { ...piece, y: ghostY };
        const color = COLORS[piece.type];
        ctx.strokeStyle = color.fill;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.45;
        for (const [r, c] of cellsOf(ghost)) {
          if (r < 0) continue;
          const x = offsetX + c * cell, y = offsetY + r * cell;
          ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
        }
        ctx.globalAlpha = 1;

        // Active piece (always drawn after ghost so it overlays cleanly)
        for (const [r, c] of cellsOf(piece)) {
          if (r < 0) continue;
          const x = offsetX + c * cell, y = offsetY + r * cell;
          ctx.fillStyle = color.fill;
          ctx.shadowColor = color.glow;
          ctx.shadowBlur = 8;
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
          ctx.shadowBlur = 0;
        }
      }
    };

    const ensureNext = () => {
      // Keep the next-queue topped up using the 7-bag
      while (nextRef.current.length < 4) {
        if (bagRef.current.length === 0) bagRef.current = newBag();
        nextRef.current.push(bagRef.current.shift());
      }
    };

    const spawn = () => {
      ensureNext();
      const type = nextRef.current.shift();
      ensureNext();
      const piece = spawnPiece(type);
      // Game over if spawn collides immediately
      if (collides(boardRef.current, piece)) {
        gameOverRef.current = true;
        setGameOver(true);
        runningRef.current = false;
        setRunning(false);
        beep(300, 0.15);
        setTimeout(() => beep(200, 0.2), 130);
        // High score
        if (stateRef.current.score > persisted.highScore) {
          setPersisted({ highScore: stateRef.current.score });
        }
        return;
      }
      pieceRef.current = piece;
      canHoldRef.current = true;
    };

    const reset = () => {
      boardRef.current = emptyBoard();
      bagRef.current = newBag();
      nextRef.current = [];
      ensureNext();
      holdRef.current = null;
      canHoldRef.current = true;
      stateRef.current = { score: 0, lines: 0, level: 0 };
      setScore(0);
      setLines(0);
      setGameOver(false);
      gameOverRef.current = false;
      setPaused(false);
      pausedRef.current = false;
      lastFallRef.current = 0;
      accRef.current = 0;
      pieceRef.current = null;
      spawn();
    };

    const start = () => {
      if (gameOverRef.current) reset();
      else if (!pieceRef.current) reset();
      setRunning(true);
      runningRef.current = true;
      setPaused(false);
      pausedRef.current = false;
      // Touch audio context for first-blip
      try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
      if (canvasRef.current) canvasRef.current.focus();
    };

    const togglePause = () => {
      if (gameOverRef.current) { start(); return; }
      if (!runningRef.current) { start(); return; }
      const np = !pausedRef.current;
      setPaused(np);
      pausedRef.current = np;
    };

    const tryMove = (dx, dy) => {
      const p = pieceRef.current;
      if (!p) return false;
      const next = { ...p, x: p.x + dx, y: p.y + dy };
      if (collides(boardRef.current, next)) return false;
      pieceRef.current = next;
      return true;
    };

    const tryRotate = (dir) => {
      const p = pieceRef.current;
      if (!p || p.type === 'O') return false;
      const newRot = (p.rotation + (dir > 0 ? 1 : 3)) % 4;
      const candidates = [
        { x: p.x,     y: p.y },
        { x: p.x + 1, y: p.y },
        { x: p.x - 1, y: p.y },
        { x: p.x,     y: p.y - 1 },
        { x: p.x + 2, y: p.y },
        { x: p.x - 2, y: p.y },
      ];
      for (const c of candidates) {
        const test = { ...p, x: c.x, y: c.y, rotation: newRot };
        if (!collides(boardRef.current, test)) {
          pieceRef.current = test;
          return true;
        }
      }
      return false;
    };

    const lockAndAdvance = () => {
      const p = pieceRef.current;
      if (!p) return;
      boardRef.current = lockPiece(boardRef.current, p);
      const { board, cleared } = clearLines(boardRef.current);
      boardRef.current = board;
      if (cleared > 0) {
        const newLines = stateRef.current.lines + cleared;
        const level = Math.floor(newLines / 10);
        const points = LINE_SCORES[cleared] * (stateRef.current.level + 1);
        stateRef.current = { score: stateRef.current.score + points, lines: newLines, level };
        setLines(newLines);
        setScore(stateRef.current.score);
        beep(cleared === 4 ? 880 : 660, 0.08, 0.18);
      } else {
        beep(200, 0.04, 0.1);
      }
      pieceRef.current = null;
      spawn();
    };

    const softDrop = () => {
      if (!tryMove(0, 1)) {
        lockAndAdvance();
      } else {
        stateRef.current.score += 1;
        setScore(stateRef.current.score);
      }
    };

    const hardDrop = () => {
      const p = pieceRef.current;
      if (!p) return;
      let dropped = 0;
      while (tryMove(0, 1)) dropped++;
      stateRef.current.score += dropped * 2;
      setScore(stateRef.current.score);
      lockAndAdvance();
    };

    const hold = () => {
      if (!canHoldRef.current || !pieceRef.current) return;
      const cur = pieceRef.current.type;
      if (holdRef.current) {
        const nextType = holdRef.current;
        holdRef.current = cur;
        pieceRef.current = spawnPiece(nextType);
        if (collides(boardRef.current, pieceRef.current)) {
          // Edge case: spawn into stack — game over
          gameOverRef.current = true;
          setGameOver(true);
          runningRef.current = false;
          setRunning(false);
        }
      } else {
        holdRef.current = cur;
        pieceRef.current = null;
        spawn();
      }
      canHoldRef.current = false;
    };

    // Keyboard
    const onKeyDown = (e) => {
      if (gameOverRef.current) {
        if (e.code === 'KeyR' || e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          reset(); start();
        }
        return;
      }
      if (e.code === 'KeyP') { e.preventDefault(); togglePause(); return; }
      if (e.code === 'KeyR') { e.preventDefault(); reset(); start(); return; }
      if (!runningRef.current) {
        // Any control key starts the game
        if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp','Space','KeyZ','KeyX','KeyC'].includes(e.code)) {
          e.preventDefault();
          start();
          return;
        }
      }
      if (pausedRef.current) return;
      switch (e.code) {
        case 'ArrowLeft':  e.preventDefault(); tryMove(-1, 0); break;
        case 'ArrowRight': e.preventDefault(); tryMove(1, 0);  break;
        case 'ArrowDown':  e.preventDefault(); softDrop();     break;
        case 'Space':      e.preventDefault(); hardDrop();     break;
        case 'ArrowUp':
        case 'KeyX':       e.preventDefault(); tryRotate(1);   break;
        case 'KeyZ':       e.preventDefault(); tryRotate(-1);  break;
        case 'KeyC':       e.preventDefault(); hold();          break;
      }
    };

    // Render + game tick loop
    useEffect(() => {
      const wrap = wrapRef.current;
      if (!wrap) return;

      let raf;
      const loop = (now) => {
        if (lastFallRef.current === 0) lastFallRef.current = now;
        const dt = now - lastFallRef.current;
        lastFallRef.current = now;
        if (runningRef.current && !pausedRef.current && !gameOverRef.current && pieceRef.current) {
          accRef.current += dt;
          const interval = fallSpeedMs(stateRef.current.level);
          while (accRef.current >= interval) {
            accRef.current -= interval;
            if (!tryMove(0, 1)) {
              // Hit floor — start lock delay
              lockTimerRef.current += interval;
              if (lockTimerRef.current >= 500) {
                lockTimerRef.current = 0;
                lockAndAdvance();
              }
            } else {
              lockTimerRef.current = 0;
            }
          }
        } else {
          lastFallRef.current = now;
        }
        drawBoard();
        drawNext();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      const ro = new ResizeObserver(() => { drawBoard(); drawNext(); });
      ro.observe(wrap);

      return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }, []);

    // Cleanup audio on unmount
    useEffect(() => () => {
      try { if (audioCtx) audioCtx.close(); audioCtx = null; } catch {}
    }, []);

    const level = Math.floor(lines / 10);

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="p-label">tetris</span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-dim)',
          }}>hi {persisted.highScore}</span>
        </div>

        {/* Board + side panel */}
        <div ref={wrapRef} style={{
          flex: 1, minHeight: 0,
          display: 'flex', gap: 4,
        }}>
          <canvas
            ref={canvasRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onClick={() => canvasRef.current && canvasRef.current.focus()}
            style={{
              flex: 1,
              minWidth: 0,
              outline: 'none',
              cursor: 'pointer',
              background: 'var(--bg)',
              border: '1px solid var(--border-bright)',
              borderRadius: 3,
              backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 3px)',
              display: 'block',
            }}
          />
          <div style={{
            width: 70,
            display: 'flex', flexDirection: 'column', gap: 4,
            flexShrink: 0,
          }}>
            <canvas
              ref={previewRef}
              style={{
                width: '100%',
                height: 130,
                background: 'var(--bg)',
                border: '1px solid var(--border-bright)',
                borderRadius: 3,
                display: 'block',
              }}
            />
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              border: '1px solid var(--border)',
              borderRadius: 3,
              padding: '4px 6px',
              background: 'rgba(0,0,0,0.25)',
              flex: 1,
              display: 'flex', flexDirection: 'column', justifyContent: 'space-around',
              gap: 4,
            }}>
              <div>
                <div className="p-dim" style={{ fontSize: 8, letterSpacing: '0.1em' }}>SCORE</div>
                <div style={{ color: 'var(--accent)', textShadow: 'var(--glow-soft)', fontSize: 13, fontWeight: 600, lineHeight: 1.1 }}>{score}</div>
              </div>
              <div>
                <div className="p-dim" style={{ fontSize: 8, letterSpacing: '0.1em' }}>LINES</div>
                <div style={{ color: 'var(--fg-bright)', fontSize: 12, fontWeight: 600, lineHeight: 1.1 }}>{lines}</div>
              </div>
              <div>
                <div className="p-dim" style={{ fontSize: 8, letterSpacing: '0.1em' }}>LEVEL</div>
                <div style={{ color: 'var(--accent-warm)', textShadow: '0 0 4px var(--accent-warm)', fontSize: 12, fontWeight: 600, lineHeight: 1.1 }}>{level}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Status overlay messages */}
        {(!running && !gameOver) && (
          <div className="p-dim" style={{ fontSize: 9, textAlign: 'center', fontFamily: 'var(--mono)' }}>
            click board · arrows / wasd · space drop · c hold · p pause
          </div>
        )}
        {paused && running && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--accent-warm)', textShadow: '0 0 6px var(--accent-warm)',
            textAlign: 'center',
          }}>⏸ paused · p to resume</div>
        )}
        {gameOver && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--danger)', textShadow: '0 0 6px var(--danger)',
            textAlign: 'center',
          }}>
            game over · score {score}
            {score > 0 && score >= persisted.highScore && score === persisted.highScore && score > 0 && (
              <span style={{ color: 'var(--accent)', textShadow: 'var(--glow)', marginLeft: 4 }}>· new best</span>
            )}
            <span style={{ color: 'var(--fg-dim)', marginLeft: 6 }}>· r to restart</span>
          </div>
        )}

        {/* Controls */}
        <div className="p-row" style={{ gap: 4 }}>
          <button
            onClick={() => running && !gameOver ? togglePause() : start()}
            className="p-btn"
            style={{ flex: 1, padding: '4px 8px', fontSize: 11 }}
          >{gameOver ? '↻ restart' : (running ? (paused ? '▶ resume' : '⏸ pause') : '▶ start')}</button>
          <button
            onClick={() => { reset(); start(); }}
            className="p-btn"
            style={{ padding: '4px 10px', fontSize: 11 }}
            title="new game"
          >↻</button>
        </div>
      </div>
    );
  },
};
