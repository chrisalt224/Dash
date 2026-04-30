// Pomodoro — Focus / Break timer with adjustable durations, persistence,
// and a retro chiptune alarm when the timer hits zero.
//
// • Toggle between FOCUS (green) and BREAK (amber). Each mode has its own
//   duration and its own remaining-time, so flipping modes preserves both.
// • While paused, ± buttons next to the time adjust the current mode's
//   duration in 1-minute increments (range 1–99). Disappear while running.
// • Click ↻ to reset the current mode to its full duration.
// • Time-up plays a six-beep square-wave alarm via Web Audio API.

const KEY = 'plugin:pomodoro:state:v2';

const DEFAULTS = {
  mode: 'focus',
  focusMinutes: 25,
  breakMinutes: 5,
  focusRemaining: 25 * 60,
  breakRemaining: 5 * 60,
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw };
  } catch {}
  return { ...DEFAULTS };
};

// ---- Retro chiptune alarm (Web Audio API, no asset file needed) ----
let audioCtx = null;
const playAlarm = async () => {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const ctx = audioCtx;
    const beep = (freq, start, duration, vol) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      const t = ctx.currentTime + start;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol || 0.22, t + 0.005);
      gain.gain.setValueAtTime(vol || 0.22, t + duration - 0.02);
      gain.gain.linearRampToValueAtTime(0, t + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    };
    // Two bursts of three rapid beeps, ~1.5s total
    beep(880, 0.00, 0.10);
    beep(880, 0.18, 0.10);
    beep(880, 0.36, 0.10);
    beep(1100, 0.85, 0.10);
    beep(1100, 1.03, 0.10);
    beep(1100, 1.21, 0.14);
  } catch (e) { console.error('alarm failed:', e); }
};

const adjustBtnStyle = {
  background: 'transparent',
  border: '1px solid var(--border-bright)',
  color: 'var(--fg-dim)',
  cursor: 'pointer',
  width: 22,
  height: 22,
  fontSize: 14,
  fontFamily: 'var(--mono)',
  borderRadius: 3,
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
};

const pillStyle = (active, activeColor) => ({
  background: active ? activeColor : 'transparent',
  color: active ? 'var(--bg)' : 'var(--fg-dim)',
  border: 'none',
  padding: '3px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  cursor: 'pointer',
  textTransform: 'uppercase',
  fontWeight: active ? 700 : 400,
  textShadow: active ? '0 0 4px ' + activeColor : 'none',
  transition: 'all 0.12s ease',
  outline: 'none',
});

export default {
  id: 'pomodoro',
  name: 'Pomodoro',
  width: 1,
  height: 1,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [running, setRunning] = useState(false);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    const { mode, focusMinutes, breakMinutes, focusRemaining, breakRemaining } = state;
    const isFocus = mode === 'focus';
    const minutes = isFocus ? focusMinutes : breakMinutes;
    const totalSeconds = minutes * 60;
    const remaining = isFocus ? focusRemaining : breakRemaining;
    const remKey = isFocus ? 'focusRemaining' : 'breakRemaining';
    const minKey = isFocus ? 'focusMinutes' : 'breakMinutes';

    // Tick down each second while running
    useEffect(() => {
      if (!running) return;
      const id = setInterval(() => {
        setState((s) => {
          const k = s.mode === 'focus' ? 'focusRemaining' : 'breakRemaining';
          return { ...s, [k]: Math.max(0, s[k] - 1) };
        });
      }, 1000);
      return () => clearInterval(id);
    }, [running]);

    // Auto-stop + alarm at zero (separate effect to avoid side effects in updaters)
    useEffect(() => {
      if (remaining === 0 && running) {
        setRunning(false);
        playAlarm();
      }
    }, [remaining, running]);

    const setMode = (newMode) => {
      if (newMode === mode) return;
      setRunning(false);
      setState((s) => ({ ...s, mode: newMode }));
    };

    const adjustMinutes = (delta) => {
      if (running) return;
      setState((s) => {
        const mk = s.mode === 'focus' ? 'focusMinutes' : 'breakMinutes';
        const rk = s.mode === 'focus' ? 'focusRemaining' : 'breakRemaining';
        const oldMin = s[mk];
        const newMin = Math.max(1, Math.min(99, oldMin + delta));
        if (newMin === oldMin) return s;
        const oldFull = oldMin * 60;
        const newFull = newMin * 60;
        // If sitting at full or zero, snap remaining to new full. Otherwise
        // keep current remaining but clamp it under the new ceiling.
        const wasFullOrZero = s[rk] === oldFull || s[rk] === 0;
        const nextRem = wasFullOrZero ? newFull : Math.min(s[rk], newFull);
        return { ...s, [mk]: newMin, [rk]: nextRem };
      });
    };

    const toggle = () => {
      // Make sure the audio context is created during a real user gesture
      // (Chromium's autoplay policy gets stricter without one).
      if (!audioCtx) {
        try {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor) audioCtx = new Ctor();
        } catch {}
      }
      if (remaining === 0) {
        setState((s) => {
          const rk = s.mode === 'focus' ? 'focusRemaining' : 'breakRemaining';
          const mk = s.mode === 'focus' ? 'focusMinutes' : 'breakMinutes';
          return { ...s, [rk]: s[mk] * 60 };
        });
        setRunning(true);
      } else {
        setRunning((r) => !r);
      }
    };

    const reset = () => {
      setRunning(false);
      setState((s) => {
        const rk = s.mode === 'focus' ? 'focusRemaining' : 'breakRemaining';
        const mk = s.mode === 'focus' ? 'focusMinutes' : 'breakMinutes';
        return { ...s, [rk]: s[mk] * 60 };
      });
    };

    const m = Math.floor(remaining / 60);
    const sec = remaining % 60;
    const display = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    const done = remaining === 0;
    const pct = totalSeconds === 0 ? 0 : (remaining / totalSeconds) * 100;

    const modeColor = isFocus ? 'var(--accent)' : 'var(--accent-warm)';
    const accentColor = done ? 'var(--danger)' : modeColor;
    const accentGlow = '0 0 8px ' + accentColor;

    return (
      <div className="p-col" style={{ height: '100%', justifyContent: 'space-between', gap: 4 }}>
        {/* Mode toggle + status */}
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 4,
            overflow: 'hidden',
          }}>
            <button
              type="button"
              style={pillStyle(isFocus, 'var(--accent)')}
              onClick={() => setMode('focus')}
            >focus</button>
            <button
              type="button"
              style={pillStyle(!isFocus, 'var(--accent-warm)')}
              onClick={() => setMode('break')}
            >break</button>
          </div>
          <span className="p-dim" style={{ fontSize: 9, letterSpacing: '0.1em' }}>
            {running ? '● running' : (done ? '○ done' : '○ paused')}
          </span>
        </div>

        {/* Time + adjust */}
        <div className="p-row" style={{ justifyContent: 'center', alignItems: 'center', gap: 8 }}>
          {!running && (
            <button
              type="button"
              onClick={() => adjustMinutes(-1)}
              style={adjustBtnStyle}
              title="−1 min"
            >−</button>
          )}
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: 36,
            fontWeight: 600,
            color: accentColor,
            textShadow: accentGlow,
            textAlign: 'center',
            letterSpacing: '0.06em',
            lineHeight: 1,
            minWidth: 110,
          }}>{display}</div>
          {!running && (
            <button
              type="button"
              onClick={() => adjustMinutes(1)}
              style={adjustBtnStyle}
              title="+1 min"
            >+</button>
          )}
        </div>

        {/* Progress bar */}
        <div style={{
          height: 3,
          background: 'rgba(0,0,0,0.4)',
          borderRadius: 2,
          overflow: 'hidden',
          border: '1px solid var(--border)',
        }}>
          <div style={{
            width: pct + '%',
            height: '100%',
            background: accentColor,
            boxShadow: '0 0 4px ' + accentColor,
            transition: 'width 1s linear',
          }} />
        </div>

        {/* Action buttons */}
        <div className="p-row" style={{ gap: 4 }}>
          <button
            className="p-btn"
            onClick={toggle}
            style={{ flex: 1, padding: '5px 8px' }}
          >{running ? '⏸ pause' : (done ? '↻ go again' : '▶ start')}</button>
          <button
            className="p-btn"
            onClick={reset}
            title={'reset to ' + minutes + ':00'}
            style={{ padding: '5px 10px' }}
          >↻</button>
        </div>
      </div>
    );
  },
};
