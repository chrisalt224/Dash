// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

export default {
  id: 'glitch-art-studio',
  name: 'GLITCH ART',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const KEY = 'plugin:glitch-art-studio:state:v1';

    const [text, setText] = useState('WELCOME TO THE MATRIX');
    const [intensity, setIntensity] = useState(65);
    const [speed, setSpeed] = useState(45);
    const [corruption, setCorruption] = useState(40);
    const [colorMode, setColorMode] = useState('green'); // green, amber, rgb, mono
    const [effects, setEffects] = useState({
      scanlines: true,
      rgbSplit: true,
      tears: true,
      noise: true,
      echo: false
    });
    const [mode, setMode] = useState('text'); // text or webcam
    const [isGlitching, setIsGlitching] = useState(false);

    const canvasRef = useRef(null);
    const videoRef = useRef(null);
    const rafRef = useRef(null);
    const streamRef = useRef(null);
    const frameRef = useRef(0);
    const echoCanvasRef = useRef(null);

    // Load saved state
    useEffect(() => {
      try {
        const saved = localStorage.getItem(KEY);
        if (saved) {
          const data = JSON.parse(saved);
          if (data.text) setText(data.text);
          if (data.intensity) setIntensity(data.intensity);
          if (data.speed) setSpeed(data.speed);
          if (data.corruption) setCorruption(data.corruption);
          if (data.colorMode) setColorMode(data.colorMode);
          if (data.effects) setEffects(data.effects);
          if (data.mode) setMode(data.mode);
        }
      } catch {}
    }, []);

    // Save state
    useEffect(() => {
      const data = { text, intensity, speed, corruption, colorMode, effects, mode };
      localStorage.setItem(KEY, JSON.stringify(data));
    }, [text, intensity, speed, corruption, colorMode, effects, mode]);

    // Main animation loop
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d', { alpha: true });
      let cssW = 280;
      let cssH = 180;

      const resizeCanvas = () => {
        const rect = canvas.getBoundingClientRect();
        cssW = Math.max(200, rect.width);
        cssH = Math.max(120, rect.height);
        canvas.width = cssW;
        canvas.height = cssH;
      };

      resizeCanvas();
      const ro = new ResizeObserver(resizeCanvas);
      ro.observe(canvas);

      const draw = () => {
        ctx.fillStyle = _cv('--bg', '#050a05');
        ctx.fillRect(0, 0, cssW, cssH);

        frameRef.current++;

        if (mode === 'text') {
          drawGlitchedText(ctx, cssW, cssH);
        } else if (mode === 'webcam' && videoRef.current && videoRef.current.readyState === 4) {
          drawGlitchedWebcam(ctx, cssW, cssH);
        }

        // Global scanlines
        if (effects.scanlines) {
          ctx.strokeStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.12)');
          ctx.lineWidth = 1;
          for (let y = 0; y < cssH; y += 3) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(cssW, y);
            ctx.stroke();
          }
        }

        // Subtle vignette
        const grad = ctx.createRadialGradient(
          cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.4,
          cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.9
        );
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(5,10,5,0.55)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cssW, cssH);

        rafRef.current = requestAnimationFrame(draw);
      };

      rafRef.current = requestAnimationFrame(draw);

      return () => {
        ro.disconnect();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }, [mode, effects, colorMode, intensity, corruption]);

    // Webcam setup
    const startWebcam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 320, height: 240 } 
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        setMode('webcam');
      } catch (err) {
        alert('Camera access denied or not available. Using text mode instead.');
        setMode('text');
      }
    };

    const stopWebcam = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      setMode('text');
    };

    // Glitch text rendering
    const drawGlitchedText = (ctx, w, h) => {
      const baseColor = colorMode === 'green' ? _cv('--accent', '#39ff14') :
                       colorMode === 'amber' ? _cv('--accent-warm', '#ffb454') :
                       colorMode === 'mono' ? _cv('--fg-bright', '#9cff9c') : '#ffffff';

      ctx.font = `${Math.max(18, Math.min(w / 12, 42))}px ${_cv('--mono', 'JetBrains Mono, monospace')}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const lines = text.split('\n').slice(0, 5);
      const lineHeight = Math.max(22, h / (lines.length + 1));
      const startY = h / 2 - (lines.length - 1) * lineHeight / 2;

      lines.forEach((line, lineIndex) => {
        const y = startY + lineIndex * lineHeight;
        
        // Base text
        ctx.fillStyle = baseColor;
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = 6;
        ctx.fillText(line, w / 2, y);

        // Glitch layers
        const glitchAmount = intensity / 100;
        const corruptAmount = corruption / 100;

        // RGB split
        if (effects.rgbSplit && colorMode === 'rgb') {
          ctx.fillStyle = '#ff0000';
          ctx.fillText(line, w / 2 + (Math.random() - 0.5) * 8 * glitchAmount, y);
          ctx.fillStyle = '#00ffff';
          ctx.fillText(line, w / 2 + (Math.random() - 0.5) * 8 * glitchAmount, y);
        }

        // Random tears / shifts
        if (effects.tears && Math.random() < glitchAmount * 0.6) {
          const tearY = y + (Math.random() - 0.5) * 20;
          const tearW = 30 + Math.random() * 60;
          ctx.fillStyle = baseColor;
          ctx.fillRect(w / 2 - tearW / 2, tearY - 8, tearW, 3);
        }

        // Character corruption
        if (corruptAmount > 0.1 && Math.random() < corruptAmount * 0.8) {
          const chars = '01アイウエオ@#$%&*';
          let corrupted = '';
          for (let i = 0; i < line.length; i++) {
            corrupted += Math.random() < corruptAmount * 0.7 ? 
              chars[Math.floor(Math.random() * chars.length)] : line[i];
          }
          ctx.fillStyle = colorMode === 'rgb' ? '#ffff00' : baseColor;
          ctx.fillText(corrupted, w / 2 + (Math.random() - 0.5) * 4, y);
        }

        // Noise blocks
        if (effects.noise && Math.random() < glitchAmount * 0.5) {
          ctx.fillStyle = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.6)');
          const bx = Math.random() * w;
          const by = y - 10 + Math.random() * 20;
          ctx.fillRect(bx, by, 4 + Math.random() * 12, 2);
        }
      });

      ctx.shadowBlur = 0;
    };

    // Glitched webcam rendering
    const drawGlitchedWebcam = (ctx, w, h) => {
      const video = videoRef.current;
      if (!video) return;

      // Draw base video
      ctx.drawImage(video, 0, 0, w, h);

      const glitchAmount = intensity / 100;
      const corruptAmount = corruption / 100;

      // Apply glitch effects to video pixels
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;

      for (let i = 0; i < data.length; i += 4) {
        if (Math.random() < glitchAmount * 0.03) {
          // Random color shifts
          const r = data[i];
          data[i] = data[i + 1] * 0.8;
          data[i + 1] = data[i + 2] * 0.8;
          data[i + 2] = r * 0.8;
        }

        if (effects.noise && Math.random() < glitchAmount * 0.08) {
          const val = Math.random() * 255;
          data[i] = val;
          data[i + 1] = val;
          data[i + 2] = val;
        }
      }

      ctx.putImageData(imageData, 0, 0);

      // RGB split overlay
      if (effects.rgbSplit) {
        ctx.globalAlpha = 0.4;
        ctx.drawImage(video, 3 + Math.random() * 2, 0, w, h);
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 0.4;
        ctx.drawImage(video, -3 - Math.random() * 2, 0, w, h);
        ctx.fillStyle = '#00ffff';
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }

      // Echo / feedback
      if (effects.echo && echoCanvasRef.current) {
        const echoCtx = echoCanvasRef.current.getContext('2d');
        echoCtx.globalAlpha = 0.25;
        echoCtx.drawImage(canvasRef.current, 0, 0);
        ctx.globalAlpha = 0.35;
        ctx.drawImage(echoCanvasRef.current, 0, 0);
        ctx.globalAlpha = 1;
      }

      // Scanlines on video
      if (effects.scanlines) {
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        for (let y = 0; y < h; y += 3) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
      }
    };

    // One-shot strong glitch
    const triggerGlitchBurst = () => {
      setIsGlitching(true);
      setTimeout(() => setIsGlitching(false), 280);
    };

    // Export current canvas as PNG
    const exportPNG = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
        const link = document.createElement('a');
        link.download = `glitch-art-${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch (e) {
        alert('Export failed: ' + e.message);
      }
    };

    // Color mode button colors
    const getColorModeStyle = (mode) => {
      if (colorMode === mode) {
        return { background: 'var(--border)', borderColor: 'var(--accent)' };
      }
      return {};
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4, padding: '4px 6px', background: 'var(--bg)', overflow: 'hidden' }}>
        {/* Header */}
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div>
            <div className="p-label" style={{ fontSize: 9 }}>GLITCH ART STUDIO</div>
            <div style={{ fontSize: 8, color: 'var(--fg-dim)' }}>{mode.toUpperCase()} MODE</div>
          </div>
          <div className="p-row" style={{ gap: 3 }}>
            <button 
              className="p-btn" 
              style={{ fontSize: 8, padding: '1px 6px' }}
              onClick={triggerGlitchBurst}
            >
              ⚡ BURST
            </button>
            <button 
              className="p-btn" 
              style={{ fontSize: 8, padding: '1px 6px' }}
              onClick={exportPNG}
            >
              📤 PNG
            </button>
          </div>
        </div>

        {/* Canvas Area */}
        <div style={{ 
          flex: 1, 
          position: 'relative', 
          border: '1px solid var(--border)', 
          borderRadius: 3, 
          overflow: 'hidden',
          background: '#000'
        }}>
          <canvas 
            ref={canvasRef} 
            style={{ 
              width: '100%', 
              height: '100%', 
              display: 'block',
              imageRendering: 'pixelated'
            }} 
          />
          <video 
            ref={videoRef} 
            style={{ display: 'none' }} 
            muted 
            playsInline 
          />
        </div>

        {/* Controls */}
        <div style={{ flexShrink: 0, fontSize: 8 }}>
          {/* Mode Toggle */}
          <div className="p-row" style={{ gap: 4, marginBottom: 4 }}>
            <button 
              className="p-btn" 
              style={{ flex: 1, padding: '2px 6px', fontSize: 8, ...(mode === 'text' ? { background: 'var(--border)', borderColor: 'var(--accent)' } : {}) }}
              onClick={() => { stopWebcam(); setMode('text'); }}
            >
              TEXT
            </button>
            <button 
              className="p-btn" 
              style={{ flex: 1, padding: '2px 6px', fontSize: 8, ...(mode === 'webcam' ? { background: 'var(--border)', borderColor: 'var(--accent)' } : {}) }}
              onClick={mode === 'webcam' ? stopWebcam : startWebcam}
            >
              {mode === 'webcam' ? 'STOP CAM' : 'WEBCAM'}
            </button>
          </div>

          {/* Text Input (only in text mode) */}
          {mode === 'text' && (
            <div style={{ marginBottom: 4 }}>
              <textarea 
                className="p-input" 
                value={text} 
                onChange={e => setText(e.target.value)}
                placeholder="Type glitchy text..."
                style={{ 
                  width: '100%', 
                  height: 38, 
                  fontSize: 10, 
                  resize: 'none',
                  fontFamily: 'var(--mono)'
                }}
              />
            </div>
          )}

          {/* Sliders */}
          <div className="p-row" style={{ gap: 8, marginBottom: 4 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--fg-dim)', marginBottom: 1 }}>INTENSITY</div>
              <input 
                type="range" 
                min="0" 
                max="100" 
                value={intensity} 
                onChange={e => setIntensity(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
              <div style={{ textAlign: 'right', color: 'var(--accent)', fontSize: 7 }}>{intensity}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--fg-dim)', marginBottom: 1 }}>SPEED</div>
              <input 
                type="range" 
                min="5" 
                max="90" 
                value={speed} 
                onChange={e => setSpeed(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
              <div style={{ textAlign: 'right', color: 'var(--accent)', fontSize: 7 }}>{speed}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--fg-dim)', marginBottom: 1 }}>CORRUPT</div>
              <input 
                type="range" 
                min="0" 
                max="100" 
                value={corruption} 
                onChange={e => setCorruption(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
              <div style={{ textAlign: 'right', color: 'var(--accent)', fontSize: 7 }}>{corruption}</div>
            </div>
          </div>

          {/* Color Modes */}
          <div className="p-row" style={{ gap: 3, marginBottom: 4 }}>
            {['green', 'amber', 'rgb', 'mono'].map(m => (
              <button 
                key={m}
                className="p-btn" 
                style={{ 
                  flex: 1, 
                  padding: '1px 4px', 
                  fontSize: 7,
                  ...getColorModeStyle(m)
                }}
                onClick={() => setColorMode(m)}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Effect Toggles */}
          <div className="p-row" style={{ gap: 3, flexWrap: 'wrap' }}>
            {Object.keys(effects).map(key => (
              <button 
                key={key}
                className="p-btn" 
                style={{ 
                  padding: '1px 5px', 
                  fontSize: 7,
                  background: effects[key] ? 'var(--border)' : undefined,
                  borderColor: effects[key] ? 'var(--accent)' : undefined
                }}
                onClick={() => setEffects(prev => ({ ...prev, [key]: !prev[key] }))}
              >
                {key.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 6, color: 'var(--fg-dim)', textAlign: 'center', flexShrink: 0 }}>
          REAL-TIME GLITCH ENGINE • EXPORT PNG • WEBCAM SUPPORT
        </div>
      </div>
    );
  },
};
