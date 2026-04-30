export default {
  id: 'morse-beacon',
  name: 'MORSE BEACON',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef }) => {
    const KEY = 'plugin:morse-beacon:state:v1';

    const MORSE = {
      'A': '•—', 'B': '—•••', 'C': '—•—•', 'D': '—••', 'E': '•',
      'F': '••—•', 'G': '——•', 'H': '••••', 'I': '••', 'J': '•———',
      'K': '—•—', 'L': '•—••', 'M': '——', 'N': '—•', 'O': '———',
      'P': '•——•', 'Q': '——•—', 'R': '•—•', 'S': '•••', 'T': '—',
      'U': '••—', 'V': '•••—', 'W': '•——', 'X': '—••—', 'Y': '—•——',
      'Z': '——••',
      '0': '—————', '1': '•————', '2': '••———', '3': '•••——',
      '4': '••••—', '5': '•••••', '6': '—••••', '7': '——•••',
      '8': '———••', '9': '————•',
      '.': '•—•—•—', ',': '——••——', '?': '••——••', "'": '•———•',
      '!': '—•—•——', '/': '—••—•', '(': '—•——•', ')': '—•——•—',
      '&': '•—•••', ':': '———•••', ';': '—•—•—•', '=': '—•••—',
      '+': '•—•—•', '-': '—••••—', '_': '••——•—', '"': '•—••—•',
      '$': '•••—••—', '@': '•——•—•'
    };

    const [state, setState] = useState(() => {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : { text: '', wpm: 20, lastMorse: '' };
      } catch { return { text: '', wpm: 20, lastMorse: '' }; }
    });

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [morseDisplay, setMorseDisplay] = useState('');
    const [error, setError] = useState(null);

    const audioCtxRef = useRef(null);
    const timeoutRef = useRef(null);
    const playingRef = useRef(false);
    const sequenceRef = useRef([]);

    // Persist state
    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    }, [state]);

    const getDotDuration = (wpm) => 1200 / wpm; // standard PARIS timing

    const playTone = async (durationMs, freq = 750) => {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.value = freq;
      filter.type = 'lowpass';
      filter.frequency.value = 1200;

      const now = ctx.currentTime;
      gain.gain.value = 0.0001;
      gain.gain.linearRampToValueAtTime(0.35, now + 0.008);
      gain.gain.linearRampToValueAtTime(0.0001, now + durationMs / 1000 + 0.02);

      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.05);
    };

    const transmit = async () => {
      const text = state.text.trim().toUpperCase();
      if (!text || isPlaying) return;

      setError(null);
      setIsPlaying(true);
      playingRef.current = true;

      // Build sequence
      const seq = [];
      const words = text.split(/\s+/);
      words.forEach((word, wi) => {
        for (let i = 0; i < word.length; i++) {
          const ch = word[i];
          const code = MORSE[ch];
          if (code) {
            for (let j = 0; j < code.length; j++) {
              const sym = code[j];
              seq.push({ ch, sym, type: sym === '•' ? 'dot' : 'dash' });
            }
            if (i < word.length - 1) {
              seq.push({ ch: ' ', sym: ' ', type: 'letter-gap' });
            }
          }
        }
        if (wi < words.length - 1) {
          seq.push({ ch: ' ', sym: ' ', type: 'word-gap' });
        }
      });

      sequenceRef.current = seq;
      setMorseDisplay(seq.map(s => s.sym === ' ' ? ' ' : s.sym).join(''));

      const dotMs = getDotDuration(state.wpm);
      const dashMs = dotMs * 3;
      const intraGap = dotMs;
      const letterGap = dotMs * 3;
      const wordGap = dotMs * 7;

      let idx = 0;
      setCurrentIndex(0);

      const playNext = async () => {
        if (!playingRef.current || idx >= seq.length) {
          finish();
          return;
        }

        const item = seq[idx];
        setCurrentIndex(idx);

        if (item.type === 'dot') {
          await playTone(dotMs);
          await new Promise(r => setTimeout(r, intraGap));
        } else if (item.type === 'dash') {
          await playTone(dashMs);
          await new Promise(r => setTimeout(r, intraGap));
        } else if (item.type === 'letter-gap') {
          await new Promise(r => setTimeout(r, letterGap - intraGap));
        } else if (item.type === 'word-gap') {
          await new Promise(r => setTimeout(r, wordGap - intraGap));
        }

        idx++;
        if (playingRef.current) {
          timeoutRef.current = setTimeout(playNext, 0);
        }
      };

      const finish = () => {
        playingRef.current = false;
        setIsPlaying(false);
        setCurrentIndex(-1);
        setState(s => ({ ...s, lastMorse: morseDisplay }));
      };

      playNext();
    };

    const stop = () => {
      playingRef.current = false;
      setIsPlaying(false);
      setCurrentIndex(-1);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const clearAll = () => {
      stop();
      setState({ text: '', wpm: state.wpm, lastMorse: '' });
      setMorseDisplay('');
      setError(null);
    };

    const updateText = (val) => {
      setState(s => ({ ...s, text: val }));
      if (isPlaying) stop();
    };

    const setWpm = (w) => {
      setState(s => ({ ...s, wpm: w }));
    };

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        playingRef.current = false;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
    }, []);

    return (
      <div className="p-col" style={{ height: '100%', gap: 6, padding: '6px 8px', background: 'var(--bg)' }}>
        {/* Header */}
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="p-label" style={{ fontSize: 9 }}>MORSE BEACON • {state.wpm} WPM</div>
          <div style={{ fontSize: 9, color: isPlaying ? 'var(--accent)' : 'var(--fg-dim)' }}>
            {isPlaying ? '● TRANSMITTING' : 'READY'}
          </div>
        </div>

        {/* Input */}
        <input
          className="p-input"
          style={{ fontSize: 13, padding: '4px 8px', flexShrink: 0 }}
          placeholder="TYPE MESSAGE TO TRANSMIT..."
          value={state.text}
          onChange={(e) => updateText(e.target.value)}
          disabled={isPlaying}
          maxLength={80}
        />

        {/* Morse Visual */}
        <div 
          style={{ 
            flex: 1, 
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-bright)',
            borderRadius: 4,
            padding: '8px 10px',
            fontSize: 15,
            lineHeight: 1.35,
            fontFamily: 'var(--mono)',
            color: 'var(--fg-bright)',
            overflowY: 'auto',
            minHeight: 48,
            position: 'relative'
          }}
        >
          {morseDisplay ? (
            morseDisplay.split('').map((sym, i) => (
              <span 
                key={i} 
                style={{ 
                  color: i === currentIndex ? 'var(--accent-warm)' : 'var(--fg-bright)',
                  textShadow: i === currentIndex ? '0 0 6px var(--accent-warm)' : 'none',
                  transition: 'color 0.05s'
                }}
              >
                {sym === ' ' ? '\u00A0\u00A0' : sym}
              </span>
            ))
          ) : (
            <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>Morse code will appear here...</span>
          )}
        </div>

        {/* WPM Controls */}
        <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
          <div className="p-dim" style={{ fontSize: 9, width: 32 }}>SPEED</div>
          {[10, 15, 20, 25, 30].map(w => (
            <button
              key={w}
              className="p-btn"
              style={{
                padding: '1px 6px',
                fontSize: 9,
                background: state.wpm === w ? 'var(--border)' : undefined,
                borderColor: state.wpm === w ? 'var(--accent)' : undefined
              }}
              onClick={() => setWpm(w)}
              disabled={isPlaying}
            >
              {w}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div className="p-dim" style={{ fontSize: 8 }}>WPM</div>
        </div>

        {/* Action Buttons */}
        <div className="p-row" style={{ gap: 6 }}>
          <button
            className="p-btn"
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: 11,
              fontWeight: 600,
              background: isPlaying ? 'rgba(255,107,107,0.15)' : undefined,
              borderColor: isPlaying ? 'var(--danger)' : 'var(--accent)',
              color: isPlaying ? 'var(--danger)' : 'var(--accent)'
            }}
            onClick={isPlaying ? stop : transmit}
            disabled={!state.text.trim()}
          >
            {isPlaying ? '■ STOP' : '▶ TRANSMIT'}
          </button>

          <button
            className="p-btn"
            style={{ padding: '6px 12px', fontSize: 11 }}
            onClick={clearAll}
          >
            CLEAR
          </button>
        </div>

        {error && (
          <div style={{
            fontSize: 9,
            color: 'var(--danger)',
            border: '1px dashed var(--danger)',
            padding: '2px 6px',
            borderRadius: 2
          }}>
            ⚠ {error}
          </div>
        )}

        {state.lastMorse && !isPlaying && (
          <div style={{ fontSize: 8, color: 'var(--fg-dim)', textAlign: 'center' }}>
            LAST: {state.lastMorse.slice(0, 60)}{state.lastMorse.length > 60 ? '…' : ''}
          </div>
        )}
      </div>
    );
  },
};
