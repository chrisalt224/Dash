// Terminal — Real Windows shell (PowerShell / cmd / bash) inside the
// dashboard, rendered via xterm.js with a phosphor-green CRT skin.
//
// Architecture:
//   plugin → window.dashboard.pty.spawn() → main spawns node-pty proc
//   xterm onData → pty.write              (stdin)
//   pty.onData → term.write               (stdout/stderr)
//   ResizeObserver → fit() + pty.resize   (cols/rows)
//
// Lifecycle: each terminal widget owns one PTY. Closing/minimizing the
// widget kills its shell — the dashboard unmounts hidden widgets entirely
// so a long-running session would lose its state. To keep a session alive
// while you do other things, just don't minimize the widget.
//
// Requires: `npm install` then `npx electron-rebuild` (for node-pty).

const KEY = 'plugin:terminal:state:v1';

const SHELLS = {
  powershell: { label: 'powershell', cmd: 'powershell.exe', args: ['-NoLogo'] },
  pwsh:       { label: 'pwsh',       cmd: 'pwsh.exe',       args: ['-NoLogo'] },
  cmd:        { label: 'cmd',        cmd: 'cmd.exe',        args: [] },
  wsl:        { label: 'wsl',        cmd: 'wsl.exe',        args: [] },
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { shell: 'powershell', scanlines: true, ...raw };
  } catch {}
  return { shell: 'powershell', scanlines: true };
};

// Phosphor-green xterm theme — the 16 ANSI colors are tinted toward green
// so even apps that hard-code colors mostly fit the aesthetic.
const TERM_THEME = {
  background: 'var(--bg)',
  foreground: 'var(--fg-bright)',
  cursor: 'var(--accent)',
  cursorAccent: 'var(--bg)',
  selectionBackground: 'rgba(var(--accent-rgb),0.25)',
  black: 'var(--border)',
  red: 'var(--danger)',
  green: 'var(--accent)',
  yellow: 'var(--accent-warm)',
  blue: '#5eaaff',
  magenta: '#ff6bd6',
  cyan: '#5eeaff',
  white: 'var(--fg)',
  brightBlack: 'var(--fg-dim)',
  brightRed: '#ff9999',
  brightGreen: 'var(--fg-bright)',
  brightYellow: '#ffd494',
  brightBlue: '#94c4ff',
  brightMagenta: '#ff9ee8',
  brightCyan: '#94f4ff',
  brightWhite: '#e6ffe6',
};

export default {
  id: 'terminal',
  name: 'Terminal',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState(null);
    const [exited, setExited] = useState(null); // { code, signal } | null
    const [meta, setMeta] = useState({ cols: 0, rows: 0, cwd: '' });
    const wrapRef = useRef(null);
    const termHostRef = useRef(null);
    const termRef = useRef(null);
    const fitRef = useRef(null);
    const sessionRef = useRef(null);
    const resizeRafRef = useRef(null);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    // Spin up a session whenever the chosen shell changes
    useEffect(() => {
      // xterm globals
      const Terminal = window.Terminal;
      const FitAddonNS = window.FitAddon;
      if (!Terminal) {
        setError('xterm.js not loaded — restart the app');
        return;
      }
      if (!FitAddonNS || !FitAddonNS.FitAddon) {
        setError('xterm fit addon not loaded — restart the app');
        return;
      }
      const api = window.dashboard && window.dashboard.pty;
      if (!api || !api.spawn) {
        setError('host pty API unavailable — restart the app');
        return;
      }

      const term = new Terminal({
        fontFamily: (typeof document !== 'undefined' && getComputedStyle(document.body).getPropertyValue('--mono').trim())
          || '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.15,
        theme: TERM_THEME,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 5000,
        allowTransparency: true,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
      });
      const fit = new FitAddonNS.FitAddon();
      term.loadAddon(fit);
      term.open(termHostRef.current);
      try { fit.fit(); } catch {}
      termRef.current = term;
      fitRef.current = fit;

      let cancelled = false;
      let unsubData = null;
      let unsubExit = null;
      let curId = null;
      // Line buffer used in `cp` (child_process) mode — characters are echoed
      // locally and only sent to the shell on Enter.
      let cpBuf = '';

      const shell = SHELLS[state.shell] || SHELLS.powershell;
      api.spawn({
        shell: shell.cmd,
        args: shell.args,
        cols: term.cols,
        rows: term.rows,
      }).then((res) => {
        if (cancelled) return;
        if (res.error) { setError(res.error); return; }
        curId = res.id;
        sessionRef.current = res.id;
        const mode = res.mode === 'pty' ? 'pty' : 'cp';
        setMeta({ cols: term.cols, rows: term.rows, cwd: res.cwd || '', mode });
        setReady(true);
        setExited(null);
        setError(null);

        // In cp mode, surface a one-time notice so the user knows why
        // tab-completion / vim / etc. don't work.
        if (mode === 'cp') {
          term.write('\x1b[33m[no native PTY available — line-buffered mode]\x1b[0m\r\n');
          term.write('\x1b[2;37m  type a command and press Enter. tab-completion, vim, less,\x1b[0m\r\n');
          term.write('\x1b[2;37m  and arrow-key history are unavailable in this mode.\x1b[0m\r\n');
          term.write('\x1b[2;37m  install node-pty for a full terminal — see plugin.jsx header.\x1b[0m\r\n\r\n');
        }

        unsubData = api.onData((id, data) => {
          if (id !== curId) return;
          term.write(data);
        });
        unsubExit = api.onExit((id, code, signal) => {
          if (id !== curId) return;
          setExited({ code, signal });
          term.write('\r\n\x1b[33m[' + shell.label + ' exited with code ' + code + ']\x1b[0m\r\n');
        });

        // Input handling differs by mode
        if (mode === 'pty') {
          // Real TTY — pass every keystroke through unchanged
          term.onData((d) => { if (curId) api.write(curId, d); });
        } else {
          // Line-buffered: echo locally, send on Enter
          term.onData((d) => {
            if (!curId) return;
            const code = d.charCodeAt(0);
            if (d === '\r') {
              term.write('\r\n');
              api.write(curId, cpBuf + '\n');
              cpBuf = '';
            } else if (code === 127 || d === '\b') {
              if (cpBuf.length > 0) {
                cpBuf = cpBuf.slice(0, -1);
                term.write('\b \b');
              }
            } else if (code === 3) {
              // Ctrl+C — kill the running shell. The next ↻ click respawns.
              term.write('^C\r\n');
              cpBuf = '';
              api.kill(curId);
            } else if (code >= 32 || code === 9) {
              cpBuf += d;
              term.write(d);
            }
            // Other control codes (arrows, etc.) silently ignored in cp mode
          });
        }
        // Auto-focus so typing works immediately
        setTimeout(() => term.focus(), 30);
      });

      // Resize: rAF-debounced so we don't spam pty.resize on grid drag
      const ro = new ResizeObserver(() => {
        if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = requestAnimationFrame(() => {
          try {
            fit.fit();
            const { cols, rows } = term;
            setMeta((m) => (m.cols === cols && m.rows === rows) ? m : { ...m, cols, rows });
            if (curId) api.resize(curId, cols, rows);
          } catch {}
        });
      });
      if (wrapRef.current) ro.observe(wrapRef.current);

      return () => {
        cancelled = true;
        if (unsubData) unsubData();
        if (unsubExit) unsubExit();
        if (curId && api.kill) api.kill(curId);
        ro.disconnect();
        if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
        try { term.dispose(); } catch {}
        termRef.current = null;
        fitRef.current = null;
        sessionRef.current = null;
        setReady(false);
      };
    }, [state.shell]);

    const switchShell = (id) => {
      if (id === state.shell) return;
      setState((s) => ({ ...s, shell: id }));
    };

    const toggleScanlines = () => setState((s) => ({ ...s, scanlines: !s.scanlines }));

    const restart = () => {
      // Force a reinit by toggling shell to itself via state mutation
      setState((s) => ({ ...s, shell: s.shell }));
      // Setting the same value won't trigger the effect; toggle through then back
      const cur = state.shell;
      setState((s) => ({ ...s, shell: '__restart__' }));
      setTimeout(() => setState((s) => ({ ...s, shell: cur })), 30);
    };

    const focusTerm = () => { if (termRef.current) termRef.current.focus(); };

    return (
      <div
        ref={wrapRef}
        className="p-col"
        style={{
          height: '100%', gap: 4,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: 4,
        }}
      >
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <span style={{
            color: 'var(--accent)',
            fontFamily: 'var(--mono)', fontSize: 11,
            letterSpacing: '0.16em', textTransform: 'uppercase',
            textShadow: 'var(--glow-soft)',
          }}>$ {(SHELLS[state.shell] || {}).label || state.shell}</span>
          <span className="p-dim" style={{ fontSize: 9, fontFamily: 'var(--mono)' }}>
            {meta.cols}×{meta.rows}
            {meta.mode === 'cp' && (
              <span style={{ color: 'var(--accent-warm)', marginLeft: 4 }} title="child_process mode — limited shell features">· no-tty</span>
            )}
            {exited && <span style={{ color: 'var(--accent-warm)', marginLeft: 4 }}>· exited {exited.code}</span>}
          </span>
          <span style={{ flex: 1 }} />
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 3, overflow: 'hidden',
          }}>
            {Object.entries(SHELLS).map(([id, s]) => {
              const active = state.shell === id;
              return (
                <button
                  key={id}
                  onClick={() => switchShell(id)}
                  title={'switch to ' + s.cmd}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '2px 8px',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                  }}
                >{s.label}</button>
              );
            })}
          </div>
          <button
            onClick={toggleScanlines}
            title="toggle CRT scanlines"
            style={{
              background: state.scanlines ? 'rgba(var(--accent-rgb),0.1)' : 'transparent',
              border: '1px solid ' + (state.scanlines ? 'var(--accent)' : 'var(--border-bright)'),
              color: state.scanlines ? 'var(--accent)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '2px 6px', borderRadius: 2, cursor: 'pointer',
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}
          >crt</button>
          <button
            onClick={restart}
            title="restart shell"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-bright)',
              color: exited ? 'var(--accent-warm)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '2px 6px', borderRadius: 2, cursor: 'pointer',
            }}
          >↻</button>
        </div>

        {/* Error banner */}
        {error && (
          <div style={{
            padding: '8px 12px',
            color: 'var(--danger)',
            border: '1px dashed var(--danger)',
            borderRadius: 3,
            fontSize: 11,
            fontFamily: 'var(--mono)',
            background: 'rgba(255,107,107,0.05)',
          }}>! {error}</div>
        )}

        {/* Terminal host + CRT overlays */}
        <div
          onClick={focusTerm}
          style={{
            flex: 1, minHeight: 0,
            position: 'relative',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            overflow: 'hidden',
            cursor: 'text',
          }}
        >
          {/* xterm mounts here */}
          <div
            ref={termHostRef}
            style={{
              position: 'absolute',
              inset: 0,
              padding: 4,
            }}
          />

          {/* Vignette — sits on top of xterm but doesn't catch clicks */}
          <div style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            boxShadow: 'inset 0 0 60px rgba(0, 20, 0, 0.55), inset 0 0 16px rgba(0,0,0,0.3)',
          }} />

          {/* Scanlines + faint flicker — CSS-only, no JS frame cost */}
          {state.scanlines && (
            <>
              <div style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 3px)',
                mixBlendMode: 'multiply',
              }} />
              <div style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                background: 'linear-gradient(180deg, rgba(var(--accent-rgb),0.04) 0%, transparent 30%, transparent 70%, rgba(var(--accent-rgb),0.03) 100%)',
              }} />
            </>
          )}

          {/* "Loading" overlay before pty is wired */}
          {!ready && !error && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--accent)',
              fontFamily: 'var(--mono)', fontSize: 11,
              letterSpacing: '0.1em',
              textShadow: 'var(--glow-soft)',
              pointerEvents: 'none',
            }}>booting shell…</div>
          )}
        </div>
      </div>
    );
  },
};
