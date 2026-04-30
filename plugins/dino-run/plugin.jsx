// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

// Dino Run — endless side-scroller. Click the canvas to focus, then:
//   ↑ / Space  jump
//   ↓          duck
// Avoid the cacti and birds. Speed ramps up over time. High score persists.

const HI_KEY = 'plugin:dino-run:hiscore:v1';

const ACCENT = () => _cv('--accent', '#39ff14');
const ACCENT_DIM = () => _cv('--fg-dim', '#6f9a6f');
const ACCENT_BRIGHT = () => _cv('--fg-bright', '#9cff9c');
const DANGER = () => _cv('--danger', '#ff6b6b');
const TERM_BG = () => _cv('--bg', '#0a0e0a');
const TERM_BORDER = () => _cv('--border', '#1f2a1f');

const GROUND_PAD = 24;       // distance from bottom to ground line
const PLAYER_X = 50;
const PLAYER_W = 24;
const PLAYER_H = 32;
const DUCK_W = 36;
const DUCK_H = 16;
const GRAVITY = 1900;
const JUMP_VY = -680;
const HOLD_GRAVITY = 1100;   // softer gravity while ↑ is held → variable jump height

export default {
  id: 'dino-run',
  name: 'Dino Run',
  width: 4,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const canvasRef = useRef(null);
    const wrapRef = useRef(null);
    const [focused, setFocused] = useState(false);

    // All real-time game state lives in a ref to avoid React re-renders
    const gs = useRef({
      mode: 'idle', // 'idle' | 'playing' | 'gameover' | 'paused'
      time: 0,
      score: 0,
      hiScore: Number(localStorage.getItem(HI_KEY)) || 0,
      speed: 220,
      cssW: 0,
      cssH: 0,
      keys: { up: false, down: false },
      player: { y: 0, vy: 0, jumping: false },
      obstacles: [],
      spawnTimer: 0,
      nextSpawnIn: 1.4,
      flashTimer: 0,
    });

    useEffect(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;

      const resize = () => {
        const rect = wrap.getBoundingClientRect();
        gs.current.cssW = rect.width;
        gs.current.cssH = rect.height;
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Reset player to ground if off
        const groundY = gs.current.cssH - GROUND_PAD;
        if (!gs.current.player.jumping) {
          gs.current.player.y = groundY - PLAYER_H;
        }
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(wrap);

      const startGame = () => {
        const s = gs.current;
        const groundY = s.cssH - GROUND_PAD;
        s.mode = 'playing';
        s.time = 0;
        s.score = 0;
        s.speed = 220;
        s.spawnTimer = 0;
        s.nextSpawnIn = 1.4;
        s.obstacles = [];
        s.flashTimer = 0;
        s.player = { y: groundY - PLAYER_H, vy: 0, jumping: false };
      };

      const spawnObstacle = () => {
        const s = gs.current;
        const groundY = s.cssH - GROUND_PAD;
        // After a bit of speed, allow birds; force ducking under low ones too
        const allowBird = s.time > 6 && Math.random() < 0.32;
        if (allowBird) {
          // Bird height: low enough that you must duck (around player head)
          const lowBird = Math.random() < 0.5;
          const birdH = 16;
          const offset = lowBird ? 22 : 50;
          s.obstacles.push({
            type: 'bird',
            x: s.cssW + 30,
            y: groundY - PLAYER_H - offset,
            w: 28,
            h: birdH,
          });
        } else {
          // Cactus — sometimes a cluster of two
          const cluster = Math.random() < 0.2 ? 2 : 1;
          const baseW = 12;
          for (let i = 0; i < cluster; i++) {
            s.obstacles.push({
              type: 'cactus',
              x: s.cssW + 30 + i * (baseW + 4),
              y: groundY - 30,
              w: baseW,
              h: 30,
            });
          }
        }
      };

      const playerHitbox = () => {
        const s = gs.current;
        const groundY = s.cssH - GROUND_PAD;
        const ducking = s.keys.down && !s.player.jumping;
        if (ducking) {
          return { x: PLAYER_X, y: groundY - DUCK_H, w: DUCK_W, h: DUCK_H };
        }
        return { x: PLAYER_X, y: s.player.y, w: PLAYER_W, h: PLAYER_H };
      };

      const collides = (a, b) => {
        const pad = 3; // small forgiveness
        return a.x + pad < b.x + b.w &&
               a.x + a.w - pad > b.x &&
               a.y + pad < b.y + b.h &&
               a.y + a.h - pad > b.y;
      };

      const update = (dt) => {
        const s = gs.current;
        s.time += dt;
        if (s.flashTimer > 0) s.flashTimer = Math.max(0, s.flashTimer - dt);
        if (s.mode !== 'playing') return;

        const groundY = s.cssH - GROUND_PAD;

        // Player physics
        if (s.player.jumping) {
          // Variable jump height: lighter gravity while ascending and holding ↑
          const g = (s.player.vy < 0 && s.keys.up) ? HOLD_GRAVITY : GRAVITY;
          s.player.vy += g * dt;
          s.player.y += s.player.vy * dt;
          if (s.player.y + PLAYER_H >= groundY) {
            s.player.y = groundY - PLAYER_H;
            s.player.vy = 0;
            s.player.jumping = false;
          }
        }

        // Obstacle spawn + move
        s.spawnTimer += dt;
        if (s.spawnTimer >= s.nextSpawnIn) {
          s.spawnTimer = 0;
          // Spawn rate scales loosely with speed
          const minGap = Math.max(0.55, 1.2 - s.time * 0.01);
          const maxGap = Math.max(1.0, 2.0 - s.time * 0.015);
          s.nextSpawnIn = minGap + Math.random() * (maxGap - minGap);
          spawnObstacle();
        }
        for (const obs of s.obstacles) obs.x -= s.speed * dt;
        s.obstacles = s.obstacles.filter((o) => o.x + o.w > -10);

        // Speed ramp
        s.speed = Math.min(720, 220 + s.time * 9);

        // Score (10 per second, like the original)
        const newScore = Math.floor(s.time * 10);
        if (newScore > s.score) {
          // Brief flash on every 100 milestone
          if (Math.floor(newScore / 100) > Math.floor(s.score / 100)) {
            s.flashTimer = 0.6;
          }
          s.score = newScore;
        }

        // Collision check
        const pBox = playerHitbox();
        for (const obs of s.obstacles) {
          if (collides(pBox, obs)) {
            s.mode = 'gameover';
            if (s.score > s.hiScore) {
              s.hiScore = s.score;
              localStorage.setItem(HI_KEY, String(s.score));
            }
            break;
          }
        }
      };

      // ---- Drawing helpers ----
      const drawPlayer = () => {
        const s = gs.current;
        const groundY = s.cssH - GROUND_PAD;
        const ducking = s.keys.down && !s.player.jumping;
        ctx.fillStyle = ACCENT();
        ctx.shadowColor = ACCENT();
        ctx.shadowBlur = 6;
        if (ducking) {
          // Body (long, low)
          ctx.fillRect(PLAYER_X, groundY - DUCK_H, 32, 12);
          // Head sticking forward
          ctx.fillRect(PLAYER_X + 28, groundY - DUCK_H - 4, 12, 8);
          // Tiny eye notch
          ctx.fillStyle = TERM_BG();
          ctx.fillRect(PLAYER_X + 34, groundY - DUCK_H - 2, 2, 2);
          // Legs
          ctx.fillStyle = ACCENT();
          ctx.fillRect(PLAYER_X + 6, groundY - 4, 4, 4);
          ctx.fillRect(PLAYER_X + 22, groundY - 4, 4, 4);
        } else {
          const py = s.player.y;
          // Head
          ctx.fillRect(PLAYER_X + 12, py, 12, 12);
          // Eye
          ctx.fillStyle = TERM_BG();
          ctx.fillRect(PLAYER_X + 19, py + 3, 2, 2);
          ctx.fillStyle = ACCENT();
          // Body
          ctx.fillRect(PLAYER_X, py + 12, 22, 16);
          // Tail
          ctx.fillRect(PLAYER_X - 6, py + 16, 6, 4);
          // Legs (animated when not jumping)
          if (!s.player.jumping) {
            const phase = Math.floor(s.time * 12) % 2;
            if (phase === 0) {
              ctx.fillRect(PLAYER_X + 4, py + 28, 4, 8);
              ctx.fillRect(PLAYER_X + 14, py + 28, 4, 4);
            } else {
              ctx.fillRect(PLAYER_X + 4, py + 28, 4, 4);
              ctx.fillRect(PLAYER_X + 14, py + 28, 4, 8);
            }
          } else {
            // Tucked legs
            ctx.fillRect(PLAYER_X + 4, py + 28, 14, 4);
          }
        }
        ctx.shadowBlur = 0;
      };

      const drawObstacle = (obs) => {
        ctx.fillStyle = ACCENT_BRIGHT();
        ctx.shadowColor = ACCENT();
        ctx.shadowBlur = 4;
        if (obs.type === 'cactus') {
          ctx.fillRect(obs.x, obs.y, obs.w, obs.h);
          // arms
          ctx.fillRect(obs.x - 4, obs.y + 8, 4, 10);
          ctx.fillRect(obs.x + obs.w, obs.y + 14, 4, 8);
        } else {
          // bird
          ctx.fillRect(obs.x + 4, obs.y + 4, 16, 8);
          ctx.fillRect(obs.x + 18, obs.y + 6, 8, 4);
          ctx.fillRect(obs.x + 24, obs.y + 7, 2, 2);
          const flap = Math.floor(gs.current.time * 10) % 2;
          if (flap === 0) {
            ctx.fillRect(obs.x + 6, obs.y - 4, 12, 4);
          } else {
            ctx.fillRect(obs.x + 6, obs.y + 12, 12, 4);
          }
        }
        ctx.shadowBlur = 0;
      };

      const draw = () => {
        const s = gs.current;
        const w = s.cssW;
        const h = s.cssH;

        // Background
        ctx.fillStyle = TERM_BG();
        ctx.fillRect(0, 0, w, h);

        // Subtle scanline overlay
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
        for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);

        // Ground (dotted)
        const groundY = h - GROUND_PAD;
        ctx.strokeStyle = ACCENT_DIM();
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(0, groundY + 1);
        ctx.lineTo(w, groundY + 1);
        ctx.stroke();
        ctx.setLineDash([]);

        // A few "stars" / specks in the sky for ambience (parallax)
        ctx.fillStyle = 'rgba(108, 154, 108, 0.6)';
        for (let i = 0; i < 14; i++) {
          const px = ((i * 73 + s.time * 18) % (w + 40)) - 20;
          const py = ((i * 41) % (groundY - 20)) + 10;
          ctx.fillRect(Math.floor(px), Math.floor(py), 1, 1);
        }

        // Obstacles
        for (const obs of s.obstacles) drawObstacle(obs);

        // Player
        drawPlayer();

        // Score (top-right, retro style). Flashes amber every other frame on milestones.
        const flashOn = s.flashTimer > 0 && Math.floor(s.flashTimer * 12) % 2 === 0;
        ctx.fillStyle = flashOn ? _cv('--accent-warm', '#ffb454') : ACCENT_BRIGHT();
        ctx.font = '11px ' + _cv('--mono', 'JetBrains Mono, Cascadia Code, Menlo, monospace');
        ctx.textAlign = 'right';
        ctx.shadowColor = ACCENT();
        ctx.shadowBlur = 4;
        ctx.fillText('HI ' + String(s.hiScore).padStart(5, '0'), w - 78, 16);
        ctx.fillText(String(s.score).padStart(5, '0'), w - 8, 16);
        ctx.shadowBlur = 0;

        // Overlays
        if (s.mode === 'idle') {
          ctx.fillStyle = ACCENT_BRIGHT();
          ctx.font = '13px ' + _cv('--mono', 'JetBrains Mono, monospace');
          ctx.textAlign = 'center';
          ctx.shadowColor = ACCENT();
          ctx.shadowBlur = 6;
          ctx.fillText(focused ? 'press ↑ to play' : 'click to focus', w / 2, h / 2 - 6);
          ctx.font = '9px ' + _cv('--mono', 'JetBrains Mono, monospace');
          ctx.fillStyle = ACCENT_DIM();
          ctx.shadowBlur = 0;
          ctx.fillText('↑ jump · ↓ duck', w / 2, h / 2 + 12);
        } else if (s.mode === 'paused') {
          ctx.fillStyle = ACCENT_BRIGHT();
          ctx.font = '13px ' + _cv('--mono', 'JetBrains Mono, monospace');
          ctx.textAlign = 'center';
          ctx.shadowColor = ACCENT();
          ctx.shadowBlur = 6;
          ctx.fillText('paused', w / 2, h / 2);
          ctx.shadowBlur = 0;
        } else if (s.mode === 'gameover') {
          ctx.fillStyle = DANGER();
          ctx.font = 'bold 16px ' + _cv('--mono', 'JetBrains Mono, monospace');
          ctx.textAlign = 'center';
          ctx.shadowColor = DANGER();
          ctx.shadowBlur = 8;
          ctx.fillText('▣ GAME OVER ▣', w / 2, h / 2 - 6);
          ctx.font = '10px ' + _cv('--mono', 'JetBrains Mono, monospace');
          ctx.fillStyle = ACCENT_BRIGHT();
          ctx.shadowColor = ACCENT();
          ctx.shadowBlur = 4;
          ctx.fillText('press ↑ to restart', w / 2, h / 2 + 14);
          ctx.shadowBlur = 0;
        }
      };

      // ---- Loop ----
      let raf = 0;
      let lastT = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.05, (now - lastT) / 1000);
        lastT = now;
        update(dt);
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      // ---- Input ----
      const onKeyDown = (e) => {
        const s = gs.current;
        if (e.key === 'ArrowUp' || e.key === ' ') {
          e.preventDefault();
          s.keys.up = true;
          if (s.mode === 'idle' || s.mode === 'gameover') {
            startGame();
          } else if (s.mode === 'paused') {
            s.mode = 'playing';
          } else if (s.mode === 'playing' && !s.player.jumping) {
            s.player.vy = JUMP_VY;
            s.player.jumping = true;
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          s.keys.down = true;
        }
      };
      const onKeyUp = (e) => {
        const s = gs.current;
        if (e.key === 'ArrowUp' || e.key === ' ') s.keys.up = false;
        if (e.key === 'ArrowDown') s.keys.down = false;
      };
      const onFocus = () => {
        setFocused(true);
        if (gs.current.mode === 'paused') gs.current.mode = 'playing';
      };
      const onBlur = () => {
        setFocused(false);
        if (gs.current.mode === 'playing') gs.current.mode = 'paused';
        gs.current.keys.up = false;
        gs.current.keys.down = false;
      };

      canvas.addEventListener('keydown', onKeyDown);
      canvas.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('focus', onFocus);
      canvas.addEventListener('blur', onBlur);

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas.removeEventListener('keydown', onKeyDown);
        canvas.removeEventListener('keyup', onKeyUp);
        canvas.removeEventListener('focus', onFocus);
        canvas.removeEventListener('blur', onBlur);
      };
    }, []);

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        <div
          ref={wrapRef}
          style={{
            flex: 1,
            background: TERM_BG(),
            border: '1px solid ' + (focused ? ACCENT : TERM_BORDER()),
            borderRadius: 4,
            overflow: 'hidden',
            position: 'relative',
            boxShadow: focused ? '0 0 12px rgba(var(--accent-rgb),0.3)' : 'inset 0 0 24px rgba(0,0,0,0.55)',
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          }}
          onClick={() => canvasRef.current && canvasRef.current.focus()}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            style={{
              display: 'block',
              outline: 'none',
              cursor: 'pointer',
            }}
          />
        </div>
        <div className="p-row" style={{
          fontSize: 9,
          color: 'var(--fg-dim)',
          letterSpacing: '0.12em',
          padding: '2px 4px 0',
          justifyContent: 'space-between',
        }}>
          <span>{focused ? '● focused · ↑ jump · ↓ duck' : '○ click to focus'}</span>
          <span>arcade // dino.exe</span>
        </div>
      </div>
    );
  },
};
