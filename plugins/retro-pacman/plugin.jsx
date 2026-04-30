// Retro Pac-Man — single-file plugin recreating the 1980 arcade as faithfully
// as a Canvas + Web Audio rebuild allows.
//
// Mechanics (all from publicly-documented gameplay):
//   • Ghost AI (per the Pac-Man Dossier):
//       Blinky targets pacman's tile.
//       Pinky targets 4 tiles ahead of pacman.
//       Inky targets the vector from Blinky to (pacman+2-ahead) doubled.
//       Clyde targets pacman if >8 tiles away, else his scatter corner.
//     Ghosts pick the move that minimizes squared distance to their target.
//     Ties broken in arcade order: up > left > down > right. No reversing
//     except on a forced reversal (mode change / power pellet eaten).
//   • Mode timer (level 1): 7s scatter, 20s chase, 7s scatter, 20s chase,
//     5s scatter, 20s chase, 5s scatter, infinite chase.
//   • Frightened: 6.5s. Random valid direction at every step, slower speed,
//     timer paused, ghosts reverse on entry.
//   • Tunnels on row 14 wrap horizontally.
//   • Sounds: chiptune Web Audio — alternating waka per dot, descending
//     death warble, rising ghost-eat sweep, looping pitch-modulated siren.

const PACMAN_TICK_MS = 200;
const GHOST_TICK_MS = 220;
const GHOST_FRIGHT_TICK_MS = 340;
const GHOST_EATEN_TICK_MS = 110;       // "eyes" race back to the house
const FRIGHTENED_MS = 6500;
const READY_MS = 1700;
const HIGH_SCORE_KEY = 'pacman_highscore_v2';
const LB_KEY = 'pacman_leaderboard_v2';
const LEADERBOARD_SIZE = 5;

const COLOR_BG = '#000000';
const COLOR_WALL = '#2121de';
const COLOR_WALL_EDGE = '#5a5aff';
const COLOR_GATE = '#ffb8ff';
const COLOR_DOT = '#ffd0a8';
const COLOR_PACMAN = '#ffeb00';
const COLOR_FRIGHT = '#1c2afc';
const COLOR_FRIGHT_FLASH = '#ffffff';
const COLOR_FRIGHT_EYES = '#ffeb00';
const COLOR_HUD = '#ffffff';
const COLOR_HIGH = '#ffeb00';
const COLOR_DANGER = '#ff3b30';

const MODE_SCHEDULE = [
  { mode: 'scatter', ms: 7000 },
  { mode: 'chase',   ms: 20000 },
  { mode: 'scatter', ms: 7000 },
  { mode: 'chase',   ms: 20000 },
  { mode: 'scatter', ms: 5000 },
  { mode: 'chase',   ms: 20000 },
  { mode: 'scatter', ms: 5000 },
  { mode: 'chase',   ms: Infinity },
];

// Canonical 28x31 Pac-Man maze:
//   • outer walls form a closed border (no off-screen voids on the side
//     corridors — those rows extend wall-to-edge as in the arcade)
//   • 2-tile-thick wall bands above and below the ghost house (rows 10-11
//     and 19-20) — the arcade's signature "double rail"
//   • tunnel centered on row 15 (single row that wraps L↔R)
//   • ghost house: gate at row 13, interior rows 14-16, cols 11-16
//   • power pellets at the four canonical corners (rows 4 and 24)
const MAZE = [
  "############################",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#o####.#####.##.#####.####o#",
  "#.####.#####.##.#####.####.#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.##### ## #####.######",
  "######.##### ## #####.######",
  "######.##          ##.######",
  "######.## ###--### ##.######",
  "######.## #      # ##.######",
  "      .   #      #   .      ",
  "######.## #      # ##.######",
  "######.## ######## ##.######",
  "######.##          ##.######",
  "######.## ######## ##.######",
  "######.## ######## ##.######",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#o..##................##..o#",
  "###.##.##.########.##.##.###",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#.##########.##.##########.#",
  "############################",
];
const COLS = MAZE[0].length;
const ROWS = MAZE.length;

// Scatter targets — out-of-bounds corners, per arcade behavior.
const SCATTER_TARGETS = [
  { x: 25, y: 0 },   // Blinky → top-right
  { x: 2,  y: 0 },   // Pinky  → top-left
  { x: 27, y: 30 },  // Inky   → bottom-right
  { x: 0,  y: 30 },  // Clyde  → bottom-left
];

// Pac-Man's home tile: bottom-center horizontal corridor (row 24, between the
// power pellets). The dot at this tile is removed at init so he doesn't
// auto-eat his own spawn.
const PAC_SPAWN = { x: 13, y: 24, dir: 'left' };

// Ghosts spawn just above the gate at row 12 (the open corridor that the
// arcade ghosts fill after they've exited the box).
const GHOST_SPAWNS = [
  { x: 13, y: 12, dir: 'left',  color: '#ff2020', name: 'blinky' },
  { x: 14, y: 12, dir: 'right', color: '#ffb8ff', name: 'pinky'  },
  { x: 12, y: 12, dir: 'left',  color: '#00ffff', name: 'inky'   },
  { x: 15, y: 12, dir: 'right', color: '#ffb851', name: 'clyde'  },
];

const REVERSE = { left: 'right', right: 'left', up: 'down', down: 'up' };
const TIE_PRIORITY = ['up', 'left', 'down', 'right'];

const wrapX = (x) => (x < 0 ? COLS - 1 : x >= COLS ? 0 : x);

const isWall = (x, y) => {
  if (y < 0 || y >= ROWS) return true;
  const cx = wrapX(x);
  const t = MAZE[y][cx];
  return t === '#' || t === '-';
};

// Gate is wall-like for everyone in this build (eaten ghosts teleport-respawn
// at their spawn tile rather than re-entering the box).
const isGhostBlocked = isWall;

const stepXY = (x, y, dir) => {
  if (dir === 'left')  return { x: wrapX(x - 1), y };
  if (dir === 'right') return { x: wrapX(x + 1), y };
  if (dir === 'up')    return { x, y: y - 1 };
  return { x, y: y + 1 };
};

const ghostTarget = (g, idx) => {
  const ghost = g.ghosts[idx];
  if (ghost.eaten) return { x: GHOST_SPAWNS[idx].x, y: GHOST_SPAWNS[idx].y };
  if (ghost.mode === 'scatter') return SCATTER_TARGETS[idx];
  const p = g.pacman;
  const ahead = (n) => {
    if (p.dir === 'left')  return { x: p.x - n, y: p.y };
    if (p.dir === 'right') return { x: p.x + n, y: p.y };
    if (p.dir === 'up')    return { x: p.x,     y: p.y - n };
    return                       { x: p.x,     y: p.y + n };
  };
  switch (idx) {
    case 0: return { x: p.x, y: p.y };
    case 1: return ahead(4);
    case 2: {
      const a = ahead(2);
      const b = g.ghosts[0];
      return { x: a.x + (a.x - b.x), y: a.y + (a.y - b.y) };
    }
    case 3: {
      const dx = ghost.x - p.x;
      const dy = ghost.y - p.y;
      return (dx*dx + dy*dy) > 64 ? { x: p.x, y: p.y } : SCATTER_TARGETS[3];
    }
    default: return { x: p.x, y: p.y };
  }
};

const loadLeaderboard = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(LB_KEY));
    if (Array.isArray(raw)) {
      return raw
        .filter(e => e && typeof e.score === 'number' && typeof e.name === 'string')
        .slice(0, LEADERBOARD_SIZE);
    }
  } catch (e) {}
  return [];
};

const qualifies = (board, score) => {
  if (score <= 0) return false;
  if (board.length < LEADERBOARD_SIZE) return true;
  return score > board[board.length - 1].score;
};

export default {
  id: 'retro-pacman',
  name: 'Retro Pac-Man',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const containerRef = useRef(null);
    const canvasWrapRef = useRef(null);
    const canvasRef = useRef(null);
    const inputRef = useRef(null);
    const gameRef = useRef(null);
    const rafRef = useRef(null);
    const lastTimeRef = useRef(0);
    const wakaToggleRef = useRef(false);

    // Audio
    const audioCtxRef = useRef(null);
    const sirenRef = useRef(null);   // { osc, gain, lfo, lfoGain }
    const frightOscRef = useRef(null);

    const [gameState, setGameState] = useState('start');
    const gameStateRef = useRef('start');
    useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

    const [leaderboard, setLeaderboard] = useState(loadLeaderboard);
    const leaderboardRef = useRef(leaderboard);
    useEffect(() => { leaderboardRef.current = leaderboard; }, [leaderboard]);

    const [pendingScore, setPendingScore] = useState(null);
    const pendingScoreRef = useRef(null);
    useEffect(() => { pendingScoreRef.current = pendingScore; }, [pendingScore]);
    const [initials, setInitials] = useState('AAA');

    // ---------------- Audio ----------------

    const ensureCtx = () => {
      if (!audioCtxRef.current) {
        try {
          audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) { return null; }
      }
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    };

    const playWaka = () => {
      const ctx = ensureCtx(); if (!ctx) return;
      // Alternates two pitches per dot — the iconic "waka waka".
      wakaToggleRef.current = !wakaToggleRef.current;
      const freq = wakaToggleRef.current ? 720 : 440;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(freq, ctx.currentTime);
      // Slight pitch bend for "wa" / "ka" articulation
      o.frequency.exponentialRampToValueAtTime(freq * 0.7, ctx.currentTime + 0.07);
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 0.005);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.085);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.1);
    };

    const playEatGhost = () => {
      const ctx = ensureCtx(); if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(180, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(1800, ctx.currentTime + 0.35);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.36);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    };

    const playEatPellet = () => {
      const ctx = ensureCtx(); if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(900, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(280, ctx.currentTime + 0.18);
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.22);
    };

    const playDeath = () => {
      const ctx = ensureCtx(); if (!ctx) return;
      // Descending warble with vibrato — classic chiptune death sting.
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(700, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 1.4);
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 0.03);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
      lfo.frequency.setValueAtTime(18, ctx.currentTime);
      lfoGain.gain.value = 80;
      lfo.connect(lfoGain).connect(o.frequency);
      o.connect(g).connect(ctx.destination);
      o.start(); lfo.start();
      o.stop(ctx.currentTime + 1.55); lfo.stop(ctx.currentTime + 1.55);
    };

    const playIntro = () => {
      const ctx = ensureCtx(); if (!ctx) return;
      const notes = [392, 523, 659, 784]; // G C E G — short ascending fanfare
      const start = ctx.currentTime;
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = f;
        const t = start + i * 0.13;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.05, t + 0.01);
        g.gain.linearRampToValueAtTime(0, t + 0.12);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.14);
      });
    };

    const startSiren = () => {
      const ctx = ensureCtx(); if (!ctx) return;
      if (sirenRef.current) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 220;
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(0.014, ctx.currentTime + 0.4);
      lfo.frequency.value = 2.4;
      lfoGain.gain.value = 60;
      lfo.connect(lfoGain).connect(osc.frequency);
      osc.connect(gain).connect(ctx.destination);
      osc.start(); lfo.start();
      sirenRef.current = { osc, gain, lfo, lfoGain };
    };

    const stopSiren = () => {
      const ctx = audioCtxRef.current;
      const s = sirenRef.current;
      if (!ctx || !s) return;
      try {
        s.gain.gain.cancelScheduledValues(ctx.currentTime);
        s.gain.gain.setValueAtTime(s.gain.gain.value, ctx.currentTime);
        s.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
        s.osc.stop(ctx.currentTime + 0.15);
        s.lfo.stop(ctx.currentTime + 0.15);
      } catch (e) {}
      sirenRef.current = null;
    };

    const startFrightHum = () => {
      const ctx = ensureCtx(); if (!ctx) return;
      if (frightOscRef.current) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 130;
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(0.018, ctx.currentTime + 0.05);
      lfo.frequency.value = 6;
      lfoGain.gain.value = 30;
      lfo.connect(lfoGain).connect(osc.frequency);
      osc.connect(gain).connect(ctx.destination);
      osc.start(); lfo.start();
      frightOscRef.current = { osc, gain, lfo };
    };

    const stopFrightHum = () => {
      const ctx = audioCtxRef.current;
      const f = frightOscRef.current;
      if (!ctx || !f) return;
      try {
        f.gain.gain.cancelScheduledValues(ctx.currentTime);
        f.gain.gain.setValueAtTime(f.gain.gain.value, ctx.currentTime);
        f.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
        f.osc.stop(ctx.currentTime + 0.1);
        f.lfo.stop(ctx.currentTime + 0.1);
      } catch (e) {}
      frightOscRef.current = null;
    };

    // ---------------- Game ----------------

    const initGame = () => {
      const dots = [];
      const pellets = [];
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          // Skip the dot pacman would otherwise auto-eat on his spawn tile.
          if (x === PAC_SPAWN.x && y === PAC_SPAWN.y) continue;
          if (MAZE[y][x] === '.') dots.push({ x, y });
          if (MAZE[y][x] === 'o') pellets.push({ x, y });
        }
      }
      const initialMode = MODE_SCHEDULE[0].mode;
      gameRef.current = {
        pacman: { x: PAC_SPAWN.x, y: PAC_SPAWN.y, dir: PAC_SPAWN.dir, nextDir: PAC_SPAWN.dir, mouth: 0 },
        ghosts: GHOST_SPAWNS.map((s) => ({
          ...s, mode: initialMode, eaten: false, reverseQueued: false,
        })),
        dots, pellets,
        score: 0,
        lives: 3,
        level: 1,
        highScore: parseInt(localStorage.getItem(HIGH_SCORE_KEY) || '0', 10) || 0,
        ghostStreak: 0,
        modePhase: 0,
        modeTimer: 0,
        frightenedMs: 0,
        readyMs: READY_MS,
        pacmanAccum: 0,
        ghostAccum: 0,
      };
    };

    const respawnAfterDeath = () => {
      const g = gameRef.current; if (!g) return;
      g.pacman = { x: PAC_SPAWN.x, y: PAC_SPAWN.y, dir: PAC_SPAWN.dir, nextDir: PAC_SPAWN.dir, mouth: 0 };
      g.ghosts = GHOST_SPAWNS.map((s) => ({
        ...s, mode: MODE_SCHEDULE[g.modePhase].mode, eaten: false, reverseQueued: false,
      }));
      g.frightenedMs = 0;
      g.readyMs = READY_MS;
      g.pacmanAccum = 0;
      g.ghostAccum = 0;
      g.ghostStreak = 0;
      stopFrightHum();
    };

    const movePacman = () => {
      const g = gameRef.current;
      const p = g.pacman;

      // Try queued direction first
      const tryNext = stepXY(p.x, p.y, p.nextDir);
      if (!isWall(tryNext.x, tryNext.y)) {
        p.dir = p.nextDir;
        p.x = tryNext.x; p.y = tryNext.y;
      } else {
        const tryCur = stepXY(p.x, p.y, p.dir);
        if (isWall(tryCur.x, tryCur.y)) return;
        p.x = tryCur.x; p.y = tryCur.y;
      }

      p.mouth = (p.mouth + 0.55) % (Math.PI * 2);

      const di = g.dots.findIndex((d) => d.x === p.x && d.y === p.y);
      if (di !== -1) {
        g.dots.splice(di, 1);
        g.score += 10;
        playWaka();
      }
      const pi = g.pellets.findIndex((d) => d.x === p.x && d.y === p.y);
      if (pi !== -1) {
        g.pellets.splice(pi, 1);
        g.score += 50;
        g.frightenedMs = FRIGHTENED_MS;
        g.ghostStreak = 0;
        g.ghosts.forEach((gh) => { if (!gh.eaten) gh.reverseQueued = true; });
        playEatPellet();
        startFrightHum();
        stopSiren();
      }

      if (g.dots.length === 0 && g.pellets.length === 0) {
        // Win — stay on game-over for now (single level).
        gameStateRef.current = 'gameover';
        setGameState('gameover');
        finalizeScore();
      }
    };

    const moveOneGhost = (g, idx) => {
      const ghost = g.ghosts[idx];

      // Eaten ghosts: snap back to spawn when they reach it, then resume.
      if (ghost.eaten && ghost.x === GHOST_SPAWNS[idx].x && ghost.y === GHOST_SPAWNS[idx].y) {
        ghost.eaten = false;
        ghost.mode = MODE_SCHEDULE[g.modePhase].mode;
        ghost.dir = GHOST_SPAWNS[idx].dir;
      }

      if (ghost.reverseQueued) {
        ghost.dir = REVERSE[ghost.dir];
        ghost.reverseQueued = false;
      }

      // Build legal options (no reversing).
      const legal = [];
      for (const d of TIE_PRIORITY) {
        if (d === REVERSE[ghost.dir]) continue;
        const n = stepXY(ghost.x, ghost.y, d);
        if (!isGhostBlocked(n.x, n.y)) legal.push({ d, x: n.x, y: n.y });
      }
      // Dead end → reverse
      if (legal.length === 0) {
        const r = REVERSE[ghost.dir];
        const n = stepXY(ghost.x, ghost.y, r);
        if (!isGhostBlocked(n.x, n.y)) {
          ghost.dir = r; ghost.x = n.x; ghost.y = n.y;
        }
        return;
      }

      let chosen;
      if (g.frightenedMs > 0 && !ghost.eaten) {
        chosen = legal[Math.floor(Math.random() * legal.length)];
      } else {
        const t = ghostTarget(g, idx);
        let best = Infinity;
        chosen = legal[0];
        for (const opt of legal) {
          // Squared distance — and TIE_PRIORITY iteration order handles ties.
          const dx = opt.x - t.x;
          const dy = opt.y - t.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < best) { best = d2; chosen = opt; }
        }
      }
      ghost.dir = chosen.d;
      ghost.x = chosen.x;
      ghost.y = chosen.y;
    };

    const moveGhosts = () => {
      const g = gameRef.current;
      for (let i = 0; i < g.ghosts.length; i++) moveOneGhost(g, i);
    };

    const finalizeScore = () => {
      const g = gameRef.current; if (!g) return;
      if (g.score > g.highScore) {
        g.highScore = g.score;
        try { localStorage.setItem(HIGH_SCORE_KEY, String(g.score)); } catch (e) {}
      }
      stopSiren();
      stopFrightHum();
      if (qualifies(leaderboardRef.current, g.score)) {
        setPendingScore(g.score);
      }
    };

    const checkCollisions = () => {
      const g = gameRef.current;
      for (let i = 0; i < g.ghosts.length; i++) {
        const ghost = g.ghosts[i];
        if (ghost.eaten) continue;
        if (ghost.x !== g.pacman.x || ghost.y !== g.pacman.y) continue;
        if (g.frightenedMs > 0) {
          g.ghostStreak = Math.min(4, g.ghostStreak + 1);
          // 200, 400, 800, 1600 — same as arcade.
          g.score += 200 * (1 << (g.ghostStreak - 1));
          // Snap-respawn at spawn tile (no eyes-return animation in this build).
          ghost.x = GHOST_SPAWNS[i].x;
          ghost.y = GHOST_SPAWNS[i].y;
          ghost.dir = GHOST_SPAWNS[i].dir;
          ghost.mode = MODE_SCHEDULE[g.modePhase].mode;
          ghost.reverseQueued = false;
          playEatGhost();
        } else {
          playDeath();
          stopSiren();
          stopFrightHum();
          g.lives -= 1;
          if (g.lives <= 0) {
            gameStateRef.current = 'gameover';
            setGameState('gameover');
            finalizeScore();
          } else {
            respawnAfterDeath();
          }
          return;
        }
      }
    };

    const stepGame = (dt) => {
      const g = gameRef.current;
      if (!g || gameStateRef.current !== 'playing') return;

      if (g.readyMs > 0) {
        g.readyMs -= dt;
        return;
      }

      // Mode timer (paused while frightened)
      if (g.frightenedMs <= 0 && MODE_SCHEDULE[g.modePhase].ms !== Infinity) {
        g.modeTimer += dt;
        if (g.modeTimer >= MODE_SCHEDULE[g.modePhase].ms) {
          g.modePhase = Math.min(g.modePhase + 1, MODE_SCHEDULE.length - 1);
          g.modeTimer = 0;
          const newMode = MODE_SCHEDULE[g.modePhase].mode;
          g.ghosts.forEach((gh) => {
            if (!gh.eaten) {
              gh.mode = newMode;
              gh.reverseQueued = true;
            }
          });
        }
      }

      g.pacmanAccum += dt;
      if (g.pacmanAccum > PACMAN_TICK_MS * 4) g.pacmanAccum = PACMAN_TICK_MS * 4;
      while (g.pacmanAccum >= PACMAN_TICK_MS) {
        g.pacmanAccum -= PACMAN_TICK_MS;
        movePacman();
        checkCollisions();
        if (gameStateRef.current !== 'playing') return;
      }

      g.ghostAccum += dt;
      const ghostInterval = g.frightenedMs > 0 ? GHOST_FRIGHT_TICK_MS : GHOST_TICK_MS;
      const cap = ghostInterval * 4;
      if (g.ghostAccum > cap) g.ghostAccum = cap;
      while (g.ghostAccum >= ghostInterval) {
        g.ghostAccum -= ghostInterval;
        moveGhosts();
        checkCollisions();
        if (gameStateRef.current !== 'playing') return;
      }

      if (g.frightenedMs > 0) {
        g.frightenedMs -= dt;
        if (g.frightenedMs <= 0) {
          g.frightenedMs = 0;
          stopFrightHum();
          startSiren();
        }
      }
    };

    // ---------------- Drawing ----------------

    const layoutRef = useRef({ tile: 18, hudH: 50, mazeX: 0, mazeY: 0, w: 0, h: 0 });

    const draw = (ctx, w, h) => {
      const g = gameRef.current;
      if (!g) return;
      const { tile, hudH, mazeX, mazeY } = layoutRef.current;

      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, w, h);

      // ---- Walls (block-style; we don't have tile-corner detection so use solid blocks
      //       with subtle inner highlight to keep them readable) ----
      ctx.fillStyle = COLOR_WALL;
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          if (MAZE[y][x] === '#') {
            ctx.fillRect(mazeX + x * tile, mazeY + y * tile, tile, tile);
          }
        }
      }
      // Inner highlight pass — gives walls visual definition without per-edge math
      ctx.strokeStyle = COLOR_WALL_EDGE;
      ctx.lineWidth = Math.max(1, Math.floor(tile / 14));
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          if (MAZE[y][x] !== '#') continue;
          const px = mazeX + x * tile;
          const py = mazeY + y * tile;
          // Highlight the inner edge wherever a non-wall neighbour exists
          if (y > 0 && MAZE[y - 1][x] !== '#' && MAZE[y - 1][x] !== '-') {
            ctx.beginPath(); ctx.moveTo(px, py + 0.5); ctx.lineTo(px + tile, py + 0.5); ctx.stroke();
          }
          if (y < ROWS - 1 && MAZE[y + 1][x] !== '#' && MAZE[y + 1][x] !== '-') {
            ctx.beginPath(); ctx.moveTo(px, py + tile - 0.5); ctx.lineTo(px + tile, py + tile - 0.5); ctx.stroke();
          }
          if (x > 0 && MAZE[y][x - 1] !== '#' && MAZE[y][x - 1] !== '-') {
            ctx.beginPath(); ctx.moveTo(px + 0.5, py); ctx.lineTo(px + 0.5, py + tile); ctx.stroke();
          }
          if (x < COLS - 1 && MAZE[y][x + 1] !== '#' && MAZE[y][x + 1] !== '-') {
            ctx.beginPath(); ctx.moveTo(px + tile - 0.5, py); ctx.lineTo(px + tile - 0.5, py + tile); ctx.stroke();
          }
        }
      }

      // Gate
      ctx.fillStyle = COLOR_GATE;
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          if (MAZE[y][x] === '-') {
            ctx.fillRect(
              mazeX + x * tile,
              mazeY + y * tile + tile * 0.42,
              tile, tile * 0.16
            );
          }
        }
      }

      // Dots
      ctx.fillStyle = COLOR_DOT;
      const dotR = Math.max(1, tile * 0.12);
      g.dots.forEach((d) => {
        ctx.beginPath();
        ctx.arc(mazeX + d.x * tile + tile / 2, mazeY + d.y * tile + tile / 2, dotR, 0, Math.PI * 2);
        ctx.fill();
      });

      // Power pellets — pulse
      const pulse = Math.sin(Date.now() / 130) * tile * 0.06 + tile * 0.32;
      g.pellets.forEach((p) => {
        ctx.beginPath();
        ctx.arc(mazeX + p.x * tile + tile / 2, mazeY + p.y * tile + tile / 2, pulse, 0, Math.PI * 2);
        ctx.fill();
      });

      // Pac-Man — directional mouth
      const showPac = !(gameStateRef.current === 'playing' && g.readyMs > 0 && Math.floor(g.readyMs / 200) % 2 === 0);
      if (showPac || gameStateRef.current !== 'playing') {
        ctx.fillStyle = COLOR_PACMAN;
        const px = mazeX + g.pacman.x * tile + tile / 2;
        const py = mazeY + g.pacman.y * tile + tile / 2;
        const open = Math.abs(Math.sin(g.pacman.mouth));
        const base = open * 0.32 + 0.06;
        const dirAng =
          g.pacman.dir === 'right' ? 0 :
          g.pacman.dir === 'down'  ? Math.PI / 2 :
          g.pacman.dir === 'left'  ? Math.PI :
          -Math.PI / 2;
        ctx.beginPath();
        ctx.arc(px, py, tile * 0.46, dirAng + base, dirAng - base + Math.PI * 2);
        ctx.lineTo(px, py);
        ctx.fill();
      }

      // Ghosts
      g.ghosts.forEach((ghost) => {
        const gx = mazeX + ghost.x * tile + tile / 2;
        const gy = mazeY + ghost.y * tile + tile / 2;
        const r = tile * 0.42;
        const flicker = g.frightenedMs > 0 && g.frightenedMs < 1500 &&
          Math.floor(Date.now() / 180) % 2 === 0;

        if (ghost.eaten) {
          // Just eyes
          drawGhostEyes(ctx, gx, gy, r, ghost.dir, true);
          return;
        }

        ctx.fillStyle = g.frightenedMs > 0
          ? (flicker ? COLOR_FRIGHT_FLASH : COLOR_FRIGHT)
          : ghost.color;

        // Body — half circle on top, scalloped bottom
        ctx.beginPath();
        ctx.arc(gx, gy - r * 0.1, r, Math.PI, 0);
        ctx.lineTo(gx + r, gy + r * 0.7);
        // Three scallops
        const sc = r / 3;
        ctx.lineTo(gx + r - sc * 0.5, gy + r * 0.45);
        ctx.lineTo(gx + r - sc, gy + r * 0.7);
        ctx.lineTo(gx + r - sc * 1.5, gy + r * 0.45);
        ctx.lineTo(gx + r - sc * 2, gy + r * 0.7);
        ctx.lineTo(gx + r - sc * 2.5, gy + r * 0.45);
        ctx.lineTo(gx - r, gy + r * 0.7);
        ctx.closePath();
        ctx.fill();

        if (g.frightenedMs > 0) {
          // Frightened face
          ctx.fillStyle = flicker ? COLOR_FRIGHT : COLOR_FRIGHT_EYES;
          // Two eyes
          ctx.beginPath(); ctx.arc(gx - r * 0.3, gy - r * 0.1, r * 0.13, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(gx + r * 0.3, gy - r * 0.1, r * 0.13, 0, Math.PI * 2); ctx.fill();
          // Zigzag mouth
          ctx.strokeStyle = flicker ? COLOR_FRIGHT : COLOR_FRIGHT_EYES;
          ctx.lineWidth = Math.max(1, r * 0.1);
          ctx.beginPath();
          const my = gy + r * 0.25;
          ctx.moveTo(gx - r * 0.5, my);
          for (let i = 0; i < 4; i++) {
            ctx.lineTo(gx - r * 0.5 + (i + 0.5) * (r * 0.25), my + (i % 2 ? -r * 0.12 : r * 0.12));
          }
          ctx.lineTo(gx + r * 0.5, my);
          ctx.stroke();
        } else {
          drawGhostEyes(ctx, gx, gy, r, ghost.dir, false);
        }
      });

      // ---- HUD ----
      const hudFont = Math.max(10, Math.floor(hudH * 0.34));
      ctx.fillStyle = COLOR_HUD;
      ctx.font = 'bold ' + hudFont + 'px monospace';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText('1UP', Math.max(8, mazeX), 4);
      ctx.fillStyle = COLOR_HUD;
      ctx.fillText(g.score.toString().padStart(6, '0'), Math.max(8, mazeX), 4 + hudFont + 2);

      ctx.textAlign = 'center';
      ctx.fillStyle = COLOR_HIGH;
      ctx.fillText('HIGH SCORE', w / 2, 4);
      ctx.fillStyle = COLOR_HUD;
      ctx.fillText(Math.max(g.highScore, g.score).toString().padStart(6, '0'), w / 2, 4 + hudFont + 2);

      // Lives row & level — bottom of canvas
      const livesY = h - hudH * 0.65;
      const lifeR = tile * 0.42;
      for (let i = 0; i < g.lives - 1; i++) {
        const lx = mazeX + lifeR + i * (lifeR * 2.4 + 4);
        ctx.fillStyle = COLOR_PACMAN;
        ctx.beginPath();
        ctx.arc(lx, livesY, lifeR, 0.25 * Math.PI, 1.75 * Math.PI);
        ctx.lineTo(lx, livesY);
        ctx.fill();
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = COLOR_HIGH;
      ctx.font = 'bold ' + Math.max(10, Math.floor(hudH * 0.28)) + 'px monospace';
      ctx.fillText('LV ' + g.level, w - Math.max(8, mazeX), livesY - hudFont * 0.4);

      // ---- Overlays ----
      if (gameStateRef.current === 'start') {
        drawOverlay(ctx, w, h, 'PAC-MAN', 'PRESS SPACE TO START', g);
      } else if (gameStateRef.current === 'gameover') {
        drawOverlay(ctx, w, h, 'GAME OVER', 'PRESS SPACE TO PLAY AGAIN', g);
      } else if (g.readyMs > 0) {
        // Row 18 is the open corridor below the ghost house in the canonical
        // maze — same place the arcade prints READY!.
        ctx.textAlign = 'center';
        ctx.fillStyle = COLOR_HIGH;
        ctx.font = 'bold ' + Math.max(14, Math.floor(tile * 0.9)) + 'px monospace';
        ctx.fillText('READY!', mazeX + COLS * tile / 2, mazeY + 18.5 * tile);
      }
    };

    const drawGhostEyes = (ctx, gx, gy, r, dir, eatenOnly) => {
      const eyeR = r * 0.22;
      const pupR = r * 0.12;
      const ox = r * 0.3, oy = -r * 0.1;
      const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
      const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(gx - ox, gy + oy, eyeR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(gx + ox, gy + oy, eyeR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = eatenOnly ? '#000000' : '#1c2afc';
      ctx.beginPath(); ctx.arc(gx - ox + dx * pupR * 0.8, gy + oy + dy * pupR * 0.8, pupR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(gx + ox + dx * pupR * 0.8, gy + oy + dy * pupR * 0.8, pupR, 0, Math.PI * 2); ctx.fill();
    };

    const drawOverlay = (ctx, w, h, title, hint, g) => {
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.fillRect(0, h * 0.18, w, h * 0.66);

      ctx.textAlign = 'center';
      ctx.fillStyle = title === 'GAME OVER' ? COLOR_DANGER : COLOR_PACMAN;
      const titleSize = Math.max(18, Math.floor(h * 0.07));
      ctx.font = 'bold ' + titleSize + 'px monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(title, w / 2, h * 0.2);

      // Leaderboard — inject a "???" placeholder row at the right rank if a
      // qualifying score is awaiting initials.
      const lbHead = Math.max(11, Math.floor(h * 0.028));
      const lbRow = Math.max(11, Math.floor(h * 0.034));
      const base = leaderboardRef.current.filter((e) => e.name !== '???');
      const board = pendingScoreRef.current != null
        ? [...base, { name: '???', score: pendingScoreRef.current }]
            .sort((a, b) => b.score - a.score)
            .slice(0, LEADERBOARD_SIZE)
        : base;
      ctx.fillStyle = COLOR_HIGH;
      ctx.font = 'bold ' + lbHead + 'px monospace';
      const lbY = h * 0.31;
      ctx.fillText('-- LEADERBOARD --', w / 2, lbY);
      ctx.font = 'bold ' + lbRow + 'px monospace';
      const padX = Math.max(40, w * 0.22);
      const startY = lbY + lbHead + 6;
      for (let i = 0; i < LEADERBOARD_SIZE; i++) {
        const e = board[i];
        const yy = startY + i * (lbRow + 4);
        const isNew = e && e.name === '???';
        ctx.fillStyle = isNew ? COLOR_DANGER : (e ? COLOR_HUD : '#555555');
        ctx.textAlign = 'left';
        ctx.fillText((i + 1) + '. ' + (e ? e.name : '---'), padX, yy);
        ctx.textAlign = 'right';
        ctx.fillText((e ? e.score : 0).toString().padStart(6, '0'), w - padX, yy);
      }

      // Current-game score line on game over
      if (title === 'GAME OVER' && g) {
        ctx.fillStyle = COLOR_PACMAN;
        ctx.font = 'bold ' + Math.max(12, Math.floor(h * 0.034)) + 'px monospace';
        ctx.textAlign = 'center';
        const scoreY = startY + LEADERBOARD_SIZE * (lbRow + 4) + 8;
        ctx.fillText('YOUR SCORE  ' + g.score.toString().padStart(6, '0'), w / 2, scoreY);
      }

      // Hint
      ctx.fillStyle = COLOR_HUD;
      ctx.font = 'bold ' + Math.max(11, Math.floor(h * 0.028)) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(hint, w / 2, h * 0.78);
      ctx.fillStyle = '#888888';
      ctx.font = Math.max(9, Math.floor(h * 0.022)) + 'px monospace';
      ctx.fillText('CLICK BOARD TO FOCUS  ·  ARROWS / WASD', w / 2, h * 0.82);
    };

    // ---------------- Layout & resize ----------------

    const computeLayout = (w, h) => {
      // Reserve ~4 tiles vertically for HUD (2 top + 2 bottom). This keeps the
      // maze from ever overflowing — fits any aspect ratio down to ~120px.
      let tile = Math.floor(Math.min(w / COLS, h / (ROWS + 4)));
      tile = Math.max(3, Math.min(tile, 30));
      const mazeW = COLS * tile;
      const mazeH = ROWS * tile;
      const hudH = Math.max(20, Math.floor(tile * 2));
      const mazeX = Math.floor((w - mazeW) / 2);
      const mazeY = hudH;
      layoutRef.current = { tile, hudH, mazeX, mazeY, w, h };
    };

    const resizeCanvas = () => {
      const canvas = canvasRef.current;
      const wrap = canvasWrapRef.current;
      if (!canvas || !wrap) return;
      const rect = wrap.getBoundingClientRect();
      const cssW = Math.max(120, Math.floor(rect.width));
      const cssH = Math.max(120, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      computeLayout(cssW, cssH);
    };

    // ---------------- Input ----------------

    const startNewGame = () => {
      initGame();
      setPendingScore(null);
      setInitials('AAA');
      gameStateRef.current = 'playing';
      setGameState('playing');
      lastTimeRef.current = 0;
      playIntro();
      // Siren starts after the READY pause
      setTimeout(() => {
        if (gameStateRef.current === 'playing' &&
            gameRef.current && gameRef.current.frightenedMs <= 0) {
          startSiren();
        }
      }, READY_MS);
    };

    const submitInitials = () => {
      if (pendingScore == null) return;
      const name = (initials || '').toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(3, 'A').slice(0, 3);
      const base = leaderboardRef.current.filter((e) => e.name !== '???');
      const newBoard = [...base, { name, score: pendingScore }]
        .sort((a, b) => b.score - a.score)
        .slice(0, LEADERBOARD_SIZE);
      setLeaderboard(newBoard);
      try { localStorage.setItem(LB_KEY, JSON.stringify(newBoard)); } catch (e) {}
      setPendingScore(null);
      setInitials('AAA');
      // Re-focus canvas so SPACE works again
      requestAnimationFrame(() => { if (canvasRef.current) canvasRef.current.focus(); });
    };

    // ---------------- Setup effect ----------------

    useEffect(() => {
      initGame();
      resizeCanvas();

      const handleKeyDown = (e) => {
        const canvas = canvasRef.current;
        const g = gameRef.current;
        if (!g || !canvas) return;
        // Don't steal keys from the initials input or any other widget
        if (document.activeElement !== canvas) return;

        const k = e.key.toLowerCase();

        if (k === ' ' || k === 'enter') {
          if (gameStateRef.current === 'start' || gameStateRef.current === 'gameover') {
            if (pendingScoreRef.current != null) {
              // Wait for initials to be submitted first
              if (inputRef.current) inputRef.current.focus();
              e.preventDefault();
              return;
            }
            startNewGame();
            e.preventDefault();
            return;
          }
        }

        if (gameStateRef.current !== 'playing') return;

        if (k === 'arrowleft' || k === 'a')        { g.pacman.nextDir = 'left';  e.preventDefault(); }
        else if (k === 'arrowright' || k === 'd')  { g.pacman.nextDir = 'right'; e.preventDefault(); }
        else if (k === 'arrowup' || k === 'w')     { g.pacman.nextDir = 'up';    e.preventDefault(); }
        else if (k === 'arrowdown' || k === 's')   { g.pacman.nextDir = 'down';  e.preventDefault(); }
      };

      window.addEventListener('keydown', handleKeyDown);

      const ro = new ResizeObserver(resizeCanvas);
      if (canvasWrapRef.current) ro.observe(canvasWrapRef.current);

      const loop = (now) => {
        const t = typeof now === 'number' ? now : performance.now();
        const dt = lastTimeRef.current === 0 ? 0 : Math.min(100, t - lastTimeRef.current);
        lastTimeRef.current = t;
        stepGame(dt);
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const cssW = parseInt(canvas.style.width, 10) || canvas.width;
          const cssH = parseInt(canvas.style.height, 10) || canvas.height;
          draw(ctx, cssW, cssH);
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);

      return () => {
        cancelAnimationFrame(rafRef.current);
        window.removeEventListener('keydown', handleKeyDown);
        ro.disconnect();
        stopSiren();
        stopFrightHum();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-focus the input whenever a new pending score appears
    useEffect(() => {
      if (pendingScore != null) {
        setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 50);
      }
    }, [pendingScore]);

    // ---------------- Render ----------------

    const focusCanvas = () => {
      if (canvasRef.current) {
        canvasRef.current.focus();
        ensureCtx(); // unlock audio on first user gesture
      }
    };

    const showInitials = gameState === 'gameover' && pendingScore != null;

    return React.createElement('div', {
      ref: containerRef,
      style: {
        height: '100%', width: '100%',
        display: 'flex', flexDirection: 'column',
        background: COLOR_BG, color: COLOR_HUD,
        fontFamily: 'monospace', overflow: 'hidden',
      },
    },
      React.createElement('div', {
        style: {
          padding: '4px 8px', borderBottom: '1px solid var(--border)',
          fontSize: 12, letterSpacing: '0.3em', textAlign: 'center',
          color: 'var(--fg-bright)', flexShrink: 0,
        },
      }, 'RETRO PAC-MAN'),
      React.createElement('div', {
        ref: canvasWrapRef,
        style: {
          flex: 1, minHeight: 0, minWidth: 0,
          position: 'relative', background: COLOR_BG,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
        onClick: focusCanvas,
      },
        React.createElement('canvas', {
          ref: canvasRef,
          tabIndex: 0,
          style: { display: 'block', outline: 'none', background: COLOR_BG },
        }),
        showInitials && React.createElement('div', {
          style: {
            position: 'absolute',
            bottom: '14%',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex', gap: 6, alignItems: 'center',
            background: 'rgba(0,0,0,0.85)',
            border: '1px solid ' + COLOR_HIGH,
            padding: '6px 10px', borderRadius: 4,
            fontFamily: 'monospace',
            zIndex: 10,
          },
        },
          React.createElement('span', {
            style: { color: COLOR_HIGH, fontSize: 11, letterSpacing: '0.15em' },
          }, 'NEW HIGH! INITIALS:'),
          React.createElement('input', {
            ref: inputRef,
            value: initials,
            maxLength: 3,
            onChange: (e) => setInitials(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3)),
            onKeyDown: (e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitInitials(); }
              e.stopPropagation();
            },
            style: {
              width: 56, fontFamily: 'monospace', fontSize: 14,
              textAlign: 'center', letterSpacing: '0.3em',
              background: '#000', color: COLOR_PACMAN,
              border: '1px solid ' + COLOR_HIGH, borderRadius: 3, padding: '2px 4px',
              outline: 'none', textTransform: 'uppercase',
            },
          }),
          React.createElement('button', {
            onClick: submitInitials,
            style: {
              fontFamily: 'monospace', fontSize: 11,
              background: COLOR_HIGH, color: '#000',
              border: 'none', borderRadius: 3,
              padding: '3px 10px', cursor: 'pointer', fontWeight: 700,
              letterSpacing: '0.1em',
            },
          }, 'OK')
        )
      ),
      React.createElement('div', {
        style: {
          padding: '4px 8px', borderTop: '1px solid var(--border)',
          fontSize: 10, textAlign: 'center', color: 'var(--fg-dim)', flexShrink: 0,
        },
      }, 'ARROWS / WASD  •  SPACE to Start / Restart  •  click board to focus')
    );
  },
};
