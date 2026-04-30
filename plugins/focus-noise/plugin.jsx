// Focus Noise — generates white / pink / brown noise + simulated thunderstorm
// entirely in Web Audio. No asset files.
//
// • Click a colored disc to start. Click again to stop. Volume slider on the right.
// • Noise types:
//     white  — flat spectrum, harsh
//     pink   — −3 dB/oct, balanced (Voss-McCartney via Paul Kellet's filter)
//     brown  — −6 dB/oct, muffled, deep
//     storm  — rainy bed + occasional thunder rumbles (low-passed brown bursts)
// • State persists; volume saved per session.

const KEY = 'plugin:focus-noise:state:v1';

const TYPES = [
  { id: 'white', label: 'white', color: 'var(--fg-bright)' },
  { id: 'pink',  label: 'pink',  color: '#ff8fb3' },
  { id: 'brown', label: 'brown', color: '#c08854' },
  { id: 'rain',  label: 'storm', color: '#5eeaff' },
];

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { volume: 0.4, type: null, ...raw };
  } catch {}
  return { volume: 0.4, type: null };
};

// Module-level engine so toggling tabs / re-rendering doesn't tear sound down.
let audioCtx = null;
let masterGain = null;
let activeNodes = [];
let activeType = null;
let activeIntervals = [];

const ensureCtx = () => {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('no AudioContext');
    audioCtx = new Ctor();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(audioCtx.destination);
  }
  return audioCtx;
};

const stopAll = () => {
  for (const n of activeNodes) {
    try { if (n.stop) n.stop(); } catch {}
    try { n.disconnect(); } catch {}
  }
  for (const id of activeIntervals) clearInterval(id);
  activeNodes = [];
  activeIntervals = [];
  activeType = null;
};

const buildWhiteSource = (ctx) => {
  const length = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
};

// Paul Kellet's pink-noise filter, applied to white-noise buffer.
const buildPinkSource = (ctx) => {
  const length = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
};

// Brown noise = integrated white noise.
const buildBrownSource = (ctx) => {
  const length = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last * 3.5;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
};

const buildNoise = (type, ctx) => {
  if (type === 'white') return buildWhiteSource(ctx);
  if (type === 'pink')  return buildPinkSource(ctx);
  if (type === 'brown') return buildBrownSource(ctx);
  return buildPinkSource(ctx);
};

// One thunder rumble — low-passed brown-noise burst with a sharp attack and
// a long exponential decay. Peak loudness and decay length are randomised so
// distant thunder sounds different from a nearby strike.
const triggerThunder = (ctx) => {
  const now = ctx.currentTime;
  const len = 4;                                   // seconds of buffer
  const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.04 * w) / 1.04;               // brown noise
    data[i] = last * 4;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 180 + Math.random() * 320;  // 180–500 Hz: rumble band
  lp.Q.value = 0.7;

  // Slight high-shelf boost at the very start gives the initial "crack"
  const hp = ctx.createBiquadFilter();
  hp.type = 'highshelf';
  hp.frequency.value = 800;
  hp.gain.value = 4;

  const g = ctx.createGain();
  const peak  = 0.35 + Math.random() * 0.55;       // distant vs near
  const decay = 1.6  + Math.random() * 2.6;        // 1.6–4.2 s decay
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(peak, now + 0.04 + Math.random() * 0.08);
  g.gain.exponentialRampToValueAtTime(0.001, now + decay);

  src.connect(hp).connect(lp).connect(g).connect(masterGain);
  src.start(now);
  src.stop(now + decay + 0.4);

  // Self-disconnect after the strike so we don't leak nodes between strikes.
  setTimeout(() => { try { src.disconnect(); hp.disconnect(); lp.disconnect(); g.disconnect(); } catch {} }, (decay + 1) * 1000);
};

const startSound = (type) => {
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();

  if (type === 'rain') {
    // Pink base + high-shelf cut + a bandpass shimmer for "wet" texture
    const base = buildPinkSource(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    lp.Q.value = 0.6;
    const baseGain = ctx.createGain();
    baseGain.gain.value = 0.7;
    base.connect(lp).connect(baseGain).connect(masterGain);
    base.start();

    const shimmer = buildWhiteSource(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.9;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.18;
    shimmer.connect(bp).connect(shimmerGain).connect(masterGain);
    shimmer.start();

    activeNodes.push(base, lp, baseGain, shimmer, bp, shimmerGain);

    // Sparse droplet "ticks" via filtered noise bursts
    const dropletId = setInterval(() => {
      if (activeType !== 'rain') return;
      const burstCount = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < burstCount; i++) {
        const buf = ctx.createBuffer(1, ctx.sampleRate * 0.06, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / d.length);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1200 + Math.random() * 2200;
        f.Q.value = 4;
        const g = ctx.createGain();
        g.gain.value = 0.22 + Math.random() * 0.25;
        src.connect(f).connect(g).connect(masterGain);
        const start = ctx.currentTime + Math.random() * 0.4;
        src.start(start);
        src.stop(start + 0.07);
      }
    }, 350);
    activeIntervals.push(dropletId);

    // Thunder strikes — every check has a chance to fire, giving an average
    // of one strike every ~30 seconds. Tighter spacing right after a near-
    // strike feels storm-like; we hint at it by occasionally firing twice.
    const thunderId = setInterval(() => {
      if (activeType !== 'rain') return;
      if (Math.random() < 0.18) {
        triggerThunder(ctx);
        // Distant follow-up rumble ~30% of the time
        if (Math.random() < 0.3) {
          setTimeout(() => { if (activeType === 'rain') triggerThunder(ctx); }, 1800 + Math.random() * 2200);
        }
      }
    }, 6000);
    activeIntervals.push(thunderId);
  } else {
    const src = buildNoise(type, ctx);
    src.connect(masterGain);
    src.start();
    activeNodes.push(src);
  }

  activeType = type;
};

export default {
  id: 'focus-noise',
  name: 'Focus Noise',
  width: 2,
  height: 1,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    // We don't auto-restore audio on mount (browsers require a gesture);
    // but we keep the last-selected type as a hint button.
    const [playing, setPlaying] = useState(activeType);
    const volumeRef = useRef(state.volume);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);
    useEffect(() => { volumeRef.current = state.volume; }, [state.volume]);

    // Apply volume changes live
    useEffect(() => {
      if (!audioCtx || !masterGain) return;
      const target = playing ? state.volume : 0;
      try {
        masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
        masterGain.gain.linearRampToValueAtTime(target, audioCtx.currentTime + 0.08);
      } catch {}
    }, [state.volume, playing]);

    // Stop sound if widget unmounts (plugin disabled / window closed)
    useEffect(() => {
      return () => {
        if (activeType) {
          stopAll();
          if (masterGain) masterGain.gain.value = 0;
        }
      };
    }, []);

    const toggle = (typeId) => {
      try {
        ensureCtx();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if (playing === typeId) {
          // Fade out then stop
          masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
          masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.15);
          setTimeout(() => { stopAll(); }, 200);
          setPlaying(null);
          setState((s) => ({ ...s, type: null }));
          return;
        }
        // Switching types: stop existing first
        stopAll();
        masterGain.gain.value = 0;
        startSound(typeId);
        masterGain.gain.linearRampToValueAtTime(volumeRef.current, audioCtx.currentTime + 0.2);
        setPlaying(typeId);
        setState((s) => ({ ...s, type: typeId }));
      } catch (e) {
        console.error('focus-noise:', e);
      }
    };

    return (
      <div className="p-col" style={{ height: '100%', justifyContent: 'space-between', gap: 8 }}>
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="p-label">focus noise</span>
          <span className="p-dim" style={{ fontSize: 10 }}>
            {playing
              ? <span style={{ color: 'var(--accent)', textShadow: 'var(--glow)' }}>● {(TYPES.find(t => t.id === playing) || {}).label || playing}</span>
              : '○ off'}
          </span>
        </div>

        <div className="p-row" style={{ justifyContent: 'space-around', alignItems: 'center', flex: 1 }}>
          {TYPES.map((t) => {
            const active = playing === t.id;
            return (
              <button
                key={t.id}
                onClick={() => toggle(t.id)}
                title={t.label}
                style={{
                  width: 44, height: 44,
                  borderRadius: 22,
                  background: active ? t.color : 'transparent',
                  border: '2px solid ' + t.color,
                  boxShadow: active ? '0 0 16px ' + t.color : 'inset 0 0 8px rgba(0,0,0,0.3)',
                  cursor: 'pointer',
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  color: active ? 'var(--bg)' : t.color,
                  letterSpacing: '0.1em',
                  fontWeight: active ? 700 : 400,
                  textTransform: 'uppercase',
                  padding: 0,
                  transition: 'box-shadow 0.15s ease, background 0.15s ease',
                  outline: 'none',
                }}
              >{t.label}</button>
            );
          })}
        </div>

        <div className="p-row" style={{ alignItems: 'center', gap: 8 }}>
          <span className="p-dim" style={{ fontSize: 10, width: 22 }}>vol</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={state.volume}
            onChange={(e) => setState((s) => ({ ...s, volume: parseFloat(e.target.value) }))}
            style={{
              flex: 1,
              accentColor: 'var(--accent)',
              cursor: 'pointer',
            }}
          />
          <span className="p-mono" style={{ fontSize: 10, width: 28, textAlign: 'right', color: 'var(--accent)' }}>
            {Math.round(state.volume * 100)}
          </span>
        </div>
      </div>
    );
  },
};
