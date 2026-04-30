// Theme resolver — canvas can't parse var(...), so we read live values from <body>.
// Resolved on each call; getComputedStyle on body is fast enough for per-frame use.
const _cv = (n, d) => (typeof document !== 'undefined'
  ? (getComputedStyle(document.body).getPropertyValue(n).trim() || d)
  : d);

// ── Retro 8-bit alarm sound patterns ──────────────────────────────────────────
// All frequencies are equal-temperament note pitches (A4 = 440 Hz).
// Square wave = NES pulse channel. Triangle wave = NES triangle channel.
// Each sound loops indefinitely until stopped.
const SOUND_PATTERNS = {
  // NES-style ascending C-major arpeggio — the classic alarm climb
  classic: {
    seq:    [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25], // C5 E5 G5 C6 G5 E5
    wave:   'square', stepMs: 150, dur: 0.12, vol: 0.28,
  },
  // Two-voice chiptune: A-minor melody (square) + bass pulse (triangle)
  chiptune: {
    seq:    [880, 1046.5, 1318.5, 1046.5, 880, 659.25, 880, 0], // A5 C6 E6 C6 A5 E5 A5 rest
    bass:   [220,   220,    220,    220,  220,    220,  220, 0], // A3 triangle pulse
    bWave:  'triangle',
    wave:   'square', stepMs: 110, dur: 0.09, vol: 0.25, bVol: 0.13,
  },
  // Radar sweep: low-to-high ascending ping
  radar: {
    seq:    [220, 277.18, 329.63, 415.30, 523.25, 659.25, 880, 523.25], // A3→E4→A4→C6
    wave:   'square', stepMs: 280, dur: 0.22, vol: 0.24,
  },
  // Fast double-beep: classic terminal warning
  beep: {
    seq:    [880, 880, 0, 0, 0, 0], // BEEP BEEP .....
    wave:   'square', stepMs: 72, dur: 0.055, vol: 0.32,
  },
};

export default {
  id: 'alarms',
  name: 'ALARMS',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const KEY      = 'plugin:alarms:state:v1';
    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    const [alarms,     setAlarms]     = useState(() => {
      try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : []; }
      catch { return []; }
    });
    const [now,        setNow]        = useState(new Date());
    const [showForm,   setShowForm]   = useState(false);
    const [editingId,  setEditingId]  = useState(null);
    const [form,       setForm]       = useState({ time:'07:00', label:'', days:[1,2,3,4,5], sound:'classic' });
    const [triggering, setTriggering] = useState(null);
    const [snoozeCount,setSnoozeCount]= useState(0);

    // DOM / timer refs
    const audioCtxRef     = useRef(null);
    const alarmIntervalRef= useRef(null);
    const checkIntervalRef= useRef(null);
    const animationRef    = useRef(null);
    const canvasRef       = useRef(null);

    // Boolean refs that callbacks read directly — avoids stale React-state closures.
    // Without these, the recursive playStep/animate functions saw triggering = null
    // forever (the state update hadn't flushed when they were first called).
    const isPlayingRef    = useRef(false);
    const isAnimatingRef  = useRef(false);

    // ── Persist alarms ─────────────────────────────────────────────────────
    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(alarms)); } catch {}
    }, [alarms]);

    // ── Live clock (minute resolution) ─────────────────────────────────────
    useEffect(() => {
      const id = setInterval(() => setNow(new Date()), 30000);
      return () => clearInterval(id);
    }, []);

    // ── Alarm checker ──────────────────────────────────────────────────────
    useEffect(() => {
      const check = () => {
        if (triggering) return;
        const t      = new Date();
        const hhmm   = t.toTimeString().slice(0, 5);
        const day    = t.getDay();
        const today  = t.toDateString();
        alarms.forEach(alarm => {
          if (!alarm.enabled)           return;
          if (alarm.time !== hhmm)      return;
          const days = alarm.days || [0,1,2,3,4,5,6];
          if (!days.includes(day))      return;
          if (alarm.days && alarm.days.length < 7 && alarm.lastTriggered === today) return;
          setTriggering({ ...alarm });
          setSnoozeCount(0);
          playAlarmSound(alarm.sound || 'classic'); // sound starts here (no DOM needed)
          // animation starts in the useEffect below, after canvas mounts
        });
      };
      checkIntervalRef.current = setInterval(check, 20000);
      check();
      return () => clearInterval(checkIntervalRef.current);
    }, [alarms, triggering]);

    // ── Start/stop animation reactively ───────────────────────────────────
    // The canvas is inside {triggering && ...}, so it only exists in the DOM
    // AFTER this effect fires — which is exactly after React re-renders with
    // the new triggering state.
    useEffect(() => {
      if (triggering) {
        startAlarmAnimation();
      } else {
        isAnimatingRef.current = false;
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
      }
    }, [triggering]);

    // ── Cleanup on unmount ─────────────────────────────────────────────────
    useEffect(() => {
      return () => {
        isPlayingRef.current   = false;
        isAnimatingRef.current = false;
        clearTimeout(alarmIntervalRef.current);
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
        if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
      };
    }, []);

    // ── 8-bit Sound Engine ─────────────────────────────────────────────────
    //
    // isPlayingRef is set synchronously (not via setState) so the recursive
    // playStep closure always reads the up-to-date value — no stale captures.

    const playAlarmSound = (soundType = 'classic', maxSteps = Infinity) => {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      // Stop whatever is currently playing before starting fresh
      isPlayingRef.current = false;
      clearTimeout(alarmIntervalRef.current);

      const pat  = SOUND_PATTERNS[soundType] || SOUND_PATTERNS.classic;
      let   step = 0;
      isPlayingRef.current = true; // set BEFORE first playStep call

      const playStep = () => {
        if (!isPlayingRef.current)  return;  // stopped externally
        if (step >= maxSteps) { isPlayingRef.current = false; return; } // preview ended

        const freq = pat.seq[step % pat.seq.length];
        const t    = ctx.currentTime;

        if (freq > 0) {
          // ── Main voice: square wave (NES pulse channel) ──
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type            = pat.wave;
          osc.frequency.value = freq;
          // Hard 8-bit envelope: near-instant attack, sharp cutoff
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.linearRampToValueAtTime(pat.vol, t + 0.005);
          gain.gain.setValueAtTime(pat.vol, t + pat.dur * 0.78);
          gain.gain.linearRampToValueAtTime(0.0001, t + pat.dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + pat.dur + 0.015);
        }

        if (pat.bass) {
          // ── Bass voice: triangle wave (NES triangle channel) ──
          const bf = pat.bass[step % pat.bass.length];
          if (bf > 0) {
            const osc2  = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.type            = pat.bWave || 'triangle';
            osc2.frequency.value = bf;
            gain2.gain.setValueAtTime(0.0001, t);
            gain2.gain.linearRampToValueAtTime(pat.bVol || 0.12, t + 0.005);
            gain2.gain.setValueAtTime(pat.bVol || 0.12, t + pat.dur * 0.9);
            gain2.gain.linearRampToValueAtTime(0.0001, t + pat.dur);
            osc2.connect(gain2).connect(ctx.destination);
            osc2.start(t);
            osc2.stop(t + pat.dur + 0.015);
          }
        }

        step++;
        alarmIntervalRef.current = setTimeout(playStep, pat.stepMs);
      };

      playStep();
    };

    const stopAlarmSound = () => {
      isPlayingRef.current = false;
      clearTimeout(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    };

    // ── Canvas alarm animation ─────────────────────────────────────────────
    // isAnimatingRef plays the same role as isPlayingRef — a synchronous flag
    // the rAF loop reads each frame, avoiding stale closure issues.

    const startAlarmAnimation = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx2d  = canvas.getContext('2d');
      let   frame  = 0;
      isAnimatingRef.current = true;

      const animate = () => {
        if (!isAnimatingRef.current) return;

        const w = canvas.width, h = canvas.height;

        // Dim trail (persistence of vision effect)
        ctx2d.fillStyle = 'rgba(5,10,5,0.75)';
        ctx2d.fillRect(0, 0, w, h);

        const cx = w / 2, cy = h / 2 - 18;

        // Expanding concentric ring pulses
        for (let i = 0; i < 5; i++) {
          const r = 26 + ((frame + i * 8) % 52) * 1.9;
          ctx2d.strokeStyle = i % 2 === 0 ? _cv('--danger', '#ff6b6b') : _cv('--accent-warm', '#ffb454');
          ctx2d.lineWidth   = 2.2 - i * 0.22;
          ctx2d.shadowColor = _cv('--danger', '#ff6b6b');
          ctx2d.shadowBlur  = 10;
          ctx2d.beginPath();
          ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
          ctx2d.stroke();
        }

        // Flicker alarm text (red / green alternating)
        ctx2d.shadowBlur  = 8;
        ctx2d.fillStyle   = frame % 4 < 2 ? _cv('--danger', '#ff6b6b') : _cv('--accent', '#39ff14');
        ctx2d.font        = 'bold 20px var(--mono)';
        ctx2d.textAlign   = 'center';
        ctx2d.fillText('⚠ ALARM ⚠', cx, cy + 6);

        // Scanlines overlay
        ctx2d.shadowBlur    = 0;
        ctx2d.strokeStyle   = ('rgba(' + _cv('--accent-rgb', '57, 255, 20') + ', 0.08)');
        ctx2d.lineWidth     = 1;
        for (let y = 0; y < h; y += 3) {
          ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(w, y); ctx2d.stroke();
        }

        frame++;
        animationRef.current = requestAnimationFrame(animate);
      };

      animate();
    };

    const stopAnimation = () => {
      isAnimatingRef.current = false;
      if (animationRef.current) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
    };

    // ── Snooze ─────────────────────────────────────────────────────────────
    const snooze = () => {
      if (!triggering) return;
      stopAlarmSound();
      stopAnimation();
      const t = new Date();
      t.setMinutes(t.getMinutes() + 5);
      const newHHMM = t.toTimeString().slice(0, 5);
      setAlarms(prev => prev.map(a =>
        a.id === triggering.id ? { ...a, time: newHHMM, lastTriggered: null } : a
      ));
      setSnoozeCount(c => c + 1);
      setTriggering(null);
    };

    // ── Dismiss ────────────────────────────────────────────────────────────
    const dismiss = () => {
      if (!triggering) return;
      stopAlarmSound();
      stopAnimation();
      const today = new Date().toDateString();
      setAlarms(prev => prev.map(a =>
        a.id === triggering.id
          ? { ...a, enabled: a.days && a.days.length < 7 ? false : a.enabled, lastTriggered: today }
          : a
      ));
      setTriggering(null);
      setSnoozeCount(0);
    };

    // ── Save alarm ─────────────────────────────────────────────────────────
    const saveAlarm = () => {
      if (!form.time || form.days.length === 0) return;
      const alarm = {
        id:          editingId || Date.now().toString(36),
        time:        form.time,
        label:       form.label.trim() || 'Alarm',
        days:        [...form.days],
        sound:       form.sound,
        enabled:     true,
        lastTriggered: null,
      };
      setAlarms(prev => editingId
        ? prev.map(a => a.id === editingId ? alarm : a)
        : [...prev, alarm]);
      setForm({ time:'07:00', label:'', days:[1,2,3,4,5], sound:'classic' });
      setEditingId(null);
      setShowForm(false);
    };

    const editAlarm = (alarm) => {
      setForm({ time: alarm.time, label: alarm.label, days: alarm.days || [0,1,2,3,4,5,6], sound: alarm.sound || 'classic' });
      setEditingId(alarm.id);
      setShowForm(true);
    };

    const deleteAlarm = (id) => {
      setAlarms(prev => prev.filter(a => a.id !== id));
      if (triggering && triggering.id === id) dismiss();
    };

    const toggleEnabled = (id) =>
      setAlarms(prev => prev.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a));

    const toggleDay = (idx) =>
      setForm(f => {
        const days = f.days.includes(idx)
          ? f.days.filter(d => d !== idx)
          : [...f.days, idx].sort((a,b) => a-b);
        return { ...f, days };
      });

    const formatTime = (t) => {
      const [h, m] = t.split(':'), hr = parseInt(h);
      return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
    };

    const getNextAlarm = () => {
      const enabled = alarms.filter(a => a.enabled);
      if (!enabled.length) return null;
      const hhmm = now.toTimeString().slice(0, 5);
      const day  = now.getDay();
      const hits = enabled
        .filter(a => (a.days || [0,1,2,3,4,5,6]).includes(day))
        .map(a => ({ ...a, diff: a.time.localeCompare(hhmm) }))
        .sort((a, b) => a.diff - b.diff);
      return hits.length ? `${hits[0].time} — ${hits[0].label}` : null;
    };

    const nextAlarm = getNextAlarm();

    // ── Render ─────────────────────────────────────────────────────────────
    return (
      <div className="p-col" style={{ height:'100%', gap:4, padding:'6px 8px', background:'var(--bg)', position:'relative' }}>

        {/* Header */}
        <div className="p-row" style={{ justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <div className="p-label" style={{ fontSize:9 }}>ALARMS</div>
            <div style={{ fontSize:11, color:'var(--fg-bright)' }}>
              {now.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}
            </div>
          </div>
          <button className="p-btn" style={{ fontSize:10, padding:'2px 10px' }}
            onClick={() => { setShowForm(!showForm); setEditingId(null); }}>
            {showForm ? '✕' : '+ NEW'}
          </button>
        </div>

        {/* Add / Edit form */}
        {showForm && (
          <div style={{ background:'rgba(var(--accent-rgb), 0.08)', border:'1px solid var(--border-bright)', borderRadius:4, padding:'8px 10px', marginBottom:4 }}>
            <div className="p-row" style={{ gap:6, marginBottom:6 }}>
              <input type="time" className="p-input" style={{ flex:1, fontSize:13 }}
                value={form.time} onChange={e => setForm(f => ({...f, time:e.target.value}))} />
              <input className="p-input" style={{ flex:2, fontSize:12 }} placeholder="Label"
                value={form.label} onChange={e => setForm(f => ({...f, label:e.target.value}))} />
            </div>

            {/* Day selector */}
            <div style={{ marginBottom:6 }}>
              <div className="p-dim" style={{ fontSize:8, marginBottom:2 }}>REPEATS ON</div>
              <div className="p-row" style={{ gap:3 }}>
                {DAY_NAMES.map((day, idx) => (
                  <button key={idx} className="p-btn"
                    style={{ padding:'1px 5px', fontSize:8, minWidth:22,
                      background:   form.days.includes(idx) ? 'var(--border)' : undefined,
                      borderColor:  form.days.includes(idx) ? 'var(--accent)' : undefined }}
                    onClick={() => toggleDay(idx)}>
                    {day[0]}
                  </button>
                ))}
              </div>
            </div>

            {/* Sound selector */}
            <div style={{ marginBottom:6 }}>
              <div className="p-dim" style={{ fontSize:8, marginBottom:2 }}>SOUND</div>
              <div className="p-row" style={{ gap:4, alignItems:'center' }}>
                {[
                  { id:'classic',  label:'CLASSIC' },
                  { id:'chiptune', label:'CHIP'    },
                  { id:'radar',    label:'RADAR'   },
                  { id:'beep',     label:'BEEP'    },
                ].map(s => (
                  <button key={s.id} className="p-btn"
                    style={{ flex:1, padding:'2px 4px', fontSize:8,
                      background:  form.sound === s.id ? 'var(--border)' : undefined,
                      borderColor: form.sound === s.id ? 'var(--accent)' : undefined }}
                    onClick={() => setForm(f => ({...f, sound:s.id}))}>
                    {s.label}
                  </button>
                ))}
                {/* Preview: plays 16 steps then auto-stops */}
                <button className="p-btn" style={{ padding:'2px 6px', fontSize:8, marginLeft:4 }}
                  onClick={() => playAlarmSound(form.sound, 16)}>
                  ▶ TEST
                </button>
              </div>
            </div>

            <div className="p-row" style={{ justifyContent:'flex-end' }}>
              <button className="p-btn" style={{ padding:'3px 14px', fontSize:10 }} onClick={saveAlarm}>
                {editingId ? 'UPDATE' : 'ADD ALARM'}
              </button>
            </div>
          </div>
        )}

        {/* Alarm list */}
        <div style={{ flex:1, overflowY:'auto', fontSize:10 }}>
          {alarms.length === 0 ? (
            <div style={{ textAlign:'center', color:'var(--fg-dim)', padding:'18px 8px', fontSize:9 }}>
              No alarms.<br />Click + NEW
            </div>
          ) : (
            alarms.map(alarm => {
              const days   = alarm.days || [0,1,2,3,4,5,6];
              const dayStr = days.length === 7 ? 'Every day' : days.map(d => DAY_NAMES[d][0]).join('');
              return (
                <div key={alarm.id} className="p-row"
                  style={{ padding:'4px 5px', borderBottom:'1px solid var(--border)',
                    alignItems:'center', gap:5, opacity: alarm.enabled ? 1 : 0.5 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, color:'var(--accent)', fontFamily:'var(--mono)' }}>
                      {formatTime(alarm.time)}
                    </div>
                    <div style={{ fontSize:8, color:'var(--fg-bright)' }}>{alarm.label} • {dayStr}</div>
                  </div>
                  <div className="p-row" style={{ gap:3, alignItems:'center' }}>
                    <button className="p-btn" style={{ padding:'0 4px', fontSize:8 }}
                      onClick={() => toggleEnabled(alarm.id)}>
                      {alarm.enabled ? 'ON' : 'OFF'}
                    </button>
                    <button className="p-btn" style={{ padding:'0 4px', fontSize:8 }}
                      onClick={() => editAlarm(alarm)}>✎</button>
                    <button className="p-btn" style={{ padding:'0 4px', fontSize:8, color:'var(--danger)' }}
                      onClick={() => deleteAlarm(alarm.id)}>×</button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {nextAlarm && !triggering && (
          <div style={{ fontSize:7, color:'var(--fg-dim)', textAlign:'center', paddingTop:1 }}>
            NEXT: {nextAlarm}
          </div>
        )}

        {/* Alarm overlay — canvas mounts here, THEN useEffect fires the animation */}
        {triggering && (
          <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.7)',
            backdropFilter:'blur(2px)', zIndex:100, display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', padding:10 }}>
            <canvas ref={canvasRef} width={220} height={140}
              style={{ width:'100%', maxWidth:220, borderRadius:5, marginBottom:10 }} />
            <div style={{ fontSize:10, color:'var(--accent-warm)', textAlign:'center', marginBottom:6 }}>
              {triggering.label} — {formatTime(triggering.time)}
            </div>
            <div className="p-row" style={{ gap:8 }}>
              <button className="p-btn"
                style={{ padding:'5px 14px', fontSize:10, borderColor:'var(--accent-warm)', color:'var(--accent-warm)' }}
                onClick={snooze}>SNOOZE 5 MIN</button>
              <button className="p-btn"
                style={{ padding:'5px 14px', fontSize:10, background:'rgba(255,107,107,0.15)',
                  borderColor:'var(--danger)', color:'var(--danger)' }}
                onClick={dismiss}>STOP</button>
            </div>
            {snoozeCount > 0 && (
              <div style={{ fontSize:7, color:'var(--fg-dim)', marginTop:4 }}>Snoozed {snoozeCount}×</div>
            )}
          </div>
        )}
      </div>
    );
  },
};
