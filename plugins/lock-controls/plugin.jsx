// Lock Controls — Lock / Sleep / Restart / Shutdown / Hibernate / Sign Out.
//
// Especially useful in skin mode where the Windows taskbar is hidden and
// the start menu is one extra click away.
//
// • Lock and Sleep are non-destructive — single click.
// • Restart / Shutdown / Hibernate / Sign Out are destructive — two-click
//   confirm: first click arms (button turns red, label "✓?"), second click
//   within 3s commits.
//
// Uses existing window.dashboard.shell.launch — no new host code.
// Commands:
//   Lock:      rundll32.exe user32.dll,LockWorkStation
//   Sleep:     rundll32.exe powrprof.dll,SetSuspendState 0,1,0
//   Restart:   shutdown.exe /r /t 0
//   Shutdown:  shutdown.exe /s /t 0
//   Hibernate: shutdown.exe /h
//   Sign Out:  shutdown.exe /l

const ACTIONS = [
  { id: 'lock',     label: 'Lock',     glyph: '⊟', cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'],          confirm: false, color: 'green' },
  { id: 'sleep',    label: 'Sleep',    glyph: '☾', cmd: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'], confirm: false, color: 'green' },
  { id: 'signout',  label: 'Sign Out', glyph: '⎋', cmd: 'shutdown.exe', args: ['/l'],                                    confirm: true,  color: 'amber' },
  { id: 'hibernate', label: 'Hibernate', glyph: '❄', cmd: 'shutdown.exe', args: ['/h'],                                  confirm: true,  color: 'amber' },
  { id: 'restart',  label: 'Restart',  glyph: '↻', cmd: 'shutdown.exe', args: ['/r', '/t', '0'],                         confirm: true,  color: 'red'   },
  { id: 'shutdown', label: 'Shutdown', glyph: '⏻', cmd: 'shutdown.exe', args: ['/s', '/t', '0'],                         confirm: true,  color: 'red'   },
];

const COLOR_MAP = {
  green: { fg: 'var(--accent)',      glow: 'var(--glow)' },
  amber: { fg: 'var(--accent-warm)', glow: '0 0 6px var(--accent-warm)' },
  red:   { fg: 'var(--danger)',      glow: '0 0 6px var(--danger)' },
};

export default {
  id: 'lock-controls',
  name: 'Power',
  width: 2,
  height: 1,
  component: ({ useState, useEffect, useRef }) => {
    const [armedId, setArmedId] = useState(null);
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState(null);
    const [hint, setHint] = useState(null);
    const armTimer = useRef(null);
    const errTimer = useRef(null);

    useEffect(() => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
      if (errTimer.current) clearTimeout(errTimer.current);
    }, []);

    const flashError = (msg) => {
      setError(msg);
      if (errTimer.current) clearTimeout(errTimer.current);
      errTimer.current = setTimeout(() => setError(null), 4000);
    };

    const exec = async (action) => {
      const api = window.dashboard && window.dashboard.shell;
      if (!api || !api.launch) {
        flashError('shell API unavailable');
        return;
      }
      setBusyId(action.id);
      try {
        await api.launch(action.cmd, action.args);
        // Lock / Sleep return immediately; for the destructive ones the
        // dashboard will likely die before we see the result. Either way
        // we just clear busy after a moment.
        setTimeout(() => setBusyId(null), 600);
      } catch (e) {
        setBusyId(null);
        flashError(e.message || 'launch failed');
      }
    };

    const handleClick = (action) => {
      if (busyId) return;
      if (!action.confirm) {
        exec(action);
        return;
      }
      if (armedId === action.id) {
        setArmedId(null);
        if (armTimer.current) clearTimeout(armTimer.current);
        exec(action);
        return;
      }
      setArmedId(action.id);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmedId(null), 3000);
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {error && (
          <div style={{
            padding: '3px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}
        <div
          onMouseLeave={() => setHint(null)}
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))',
            gap: 4,
          }}
        >
          {ACTIONS.map((a) => {
            const armed = armedId === a.id;
            const busy = busyId === a.id;
            const c = COLOR_MAP[a.color];
            const fg = armed ? 'var(--danger)' : c.fg;
            return (
              <button
                key={a.id}
                onClick={() => handleClick(a)}
                onMouseEnter={() => setHint(a)}
                disabled={!!busyId}
                title={a.confirm ? 'click twice to ' + a.label.toLowerCase() : a.label}
                style={{
                  background: armed ? 'rgba(255,107,107,0.15)' : 'rgba(0,0,0,0.25)',
                  border: '1px solid ' + fg,
                  color: fg,
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  cursor: busyId ? 'wait' : 'pointer',
                  padding: '6px 4px',
                  borderRadius: 3,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 2,
                  textShadow: armed ? '0 0 6px var(--danger)' : (busy ? c.glow : 'none'),
                  fontWeight: armed ? 700 : 400,
                  opacity: busyId && !busy ? 0.4 : 1,
                  transition: 'border-color 0.1s ease, background 0.1s ease',
                  outline: 'none',
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>{a.glyph}</span>
                <span>{armed ? '✓ confirm' : (busy ? '…' : a.label)}</span>
              </button>
            );
          })}
        </div>
        <div className="p-row" style={{ fontSize: 9, color: 'var(--fg-dim)', justifyContent: 'space-between' }}>
          <span>{hint
            ? (hint.confirm ? '⚠ click ' + hint.label.toLowerCase() + ' twice to confirm' : hint.label.toLowerCase())
            : 'lock & sleep are single-click · others need confirm'}</span>
        </div>
      </div>
    );
  },
};
