// JSON Formatter — Paste, prettify, validate, minify.
//
// • Auto-formats as you type (debounced 150ms). Indent toggle: 2 / 4 / tab.
// • On parse error, the broken character is highlighted in the input via
//   an overlay span; "↧ jump" scrolls the input to that position. Error
//   message includes line and column.
// • minify collapses to a single line. copy puts the current output on the
//   clipboard. clear empties both panes.
//
// Pure-renderer: just JSON.parse/stringify. No host APIs needed.

const KEY = 'plugin:json-formatter:state:v1';

const TERM_BG = 'var(--bg)';
const TERM_BORDER = 'var(--border)';
const TERM_GREEN = 'var(--accent)';
const TERM_GREEN_DIM = 'var(--fg-dim)';
const TERM_GREEN_BRIGHT = 'var(--fg-bright)';
const TERM_AMBER = 'var(--accent-warm)';
const TERM_DANGER = 'var(--danger)';

const SAMPLE = '{ "name": "dashboard", "active": true, "items": [1, 2, 3], "nested": { "a": null } }';

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { input: SAMPLE, indent: 2, ...raw };
  } catch {}
  return { input: SAMPLE, indent: 2 };
};

const lineColAt = (text, position) => {
  if (position == null || position < 0) return null;
  let line = 1, col = 1;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1; }
    else col++;
  }
  return { line, col };
};

// Extract position from V8 / browser SyntaxError messages — varies by version
//  ↳ "Unexpected token X in JSON at position 12"
//  ↳ "Expected ',' or ']' after array element in JSON at position 12 (line 1 column 13)"
//  ↳ "Unexpected end of JSON input"
const extractErrorPosition = (msg, src) => {
  const m = /at position (\d+)/.exec(msg);
  if (m) return parseInt(m[1], 10);
  if (/end of JSON input/i.test(msg)) return src.length;
  return null;
};

const indentSize = (indent) => indent === 'tab' ? '\t' : indent;

export default {
  id: 'json-formatter',
  name: 'JSON',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [output, setOutput] = useState('');
    const [error, setError] = useState(null);
    const [stats, setStats] = useState({ chars: 0, lines: 0 });
    const [toast, setToast] = useState(null);
    const inputRef = useRef(null);

    useEffect(() => {
      // Debounce input persistence + parse
      const id = setTimeout(() => {
        localStorage.setItem(KEY, JSON.stringify(state));
        format(state.input, state.indent);
      }, 150);
      return () => clearTimeout(id);
    }, [state.input, state.indent]);

    const format = (text, indent) => {
      if (!text.trim()) {
        setOutput('');
        setError(null);
        setStats({ chars: 0, lines: 0 });
        return;
      }
      try {
        const parsed = JSON.parse(text);
        const formatted = JSON.stringify(parsed, null, indentSize(indent));
        setOutput(formatted);
        setError(null);
        setStats({ chars: formatted.length, lines: formatted.split('\n').length });
      } catch (e) {
        const pos = extractErrorPosition(e.message, text);
        const lc = lineColAt(text, pos);
        setError({
          message: e.message.replace(/^SyntaxError:\s*/i, ''),
          position: pos,
          line: lc ? lc.line : null,
          col: lc ? lc.col : null,
        });
        setOutput('');
        setStats({ chars: 0, lines: 0 });
      }
    };

    const minify = () => {
      try {
        const parsed = JSON.parse(state.input);
        const min = JSON.stringify(parsed);
        setState((s) => ({ ...s, input: min }));
      } catch {}
    };

    const copy = async () => {
      const text = output || state.input;
      if (!text) return;
      try {
        const api = window.dashboard && window.dashboard.clipboard;
        if (api && api.write) await api.write(text);
        else if (navigator.clipboard) await navigator.clipboard.writeText(text);
        flashToast('copied');
      } catch { flashToast('copy failed'); }
    };

    const flashToast = (m) => { setToast(m); setTimeout(() => setToast(null), 1200); };

    const clear = () => {
      setState((s) => ({ ...s, input: '' }));
      setOutput('');
      setError(null);
    };

    const jumpToError = () => {
      if (!error || error.position == null || !inputRef.current) return;
      const ta = inputRef.current;
      ta.focus();
      ta.setSelectionRange(error.position, Math.min(error.position + 1, state.input.length));
      // Approximate scroll: roughly 16px per line, line is 1-indexed
      if (error.line) ta.scrollTop = Math.max(0, (error.line - 5) * 16);
    };

    const setIndent = (v) => setState((s) => ({ ...s, indent: v }));

    return (
      <div
        className="p-col p-mono"
        style={{
          height: '100%',
          gap: 6,
          background: TERM_BG,
          padding: 8,
          borderRadius: 4,
          border: '1px solid ' + TERM_BORDER,
          boxShadow: 'inset 0 0 24px rgba(0,0,0,0.55)',
          color: TERM_GREEN_DIM,
          fontSize: 12,
        }}
      >
        {/* Toolbar */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <span style={{ color: TERM_GREEN_DIM, fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
            $ json
          </span>
          <span style={{ flex: 1 }} />
          <span className="p-row" style={{ gap: 2, alignItems: 'center' }}>
            <span style={{ color: TERM_GREEN_DIM, fontSize: 9, marginRight: 2 }}>indent</span>
            {[2, 4, 'tab'].map((v) => {
              const active = state.indent === v;
              return (
                <button
                  key={v}
                  onClick={() => setIndent(v)}
                  style={{
                    background: active ? TERM_GREEN : 'transparent',
                    color: active ? TERM_BG : TERM_GREEN_DIM,
                    border: '1px solid ' + (active ? TERM_GREEN : TERM_BORDER),
                    padding: '1px 6px',
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    cursor: 'pointer',
                    borderRadius: 2,
                    fontWeight: active ? 700 : 400,
                  }}
                >{v}</button>
              );
            })}
          </span>
          <button onClick={minify} style={btn()} title="JSON.stringify with no spaces">min</button>
          <button onClick={copy} style={btn()} title="copy output">{toast || 'copy'}</button>
          <button onClick={clear} style={btn()} title="clear input">clr</button>
        </div>

        {/* Input pane */}
        <textarea
          ref={inputRef}
          value={state.input}
          onChange={(e) => setState((s) => ({ ...s, input: e.target.value }))}
          spellCheck={false}
          placeholder="paste JSON here…"
          style={{
            flex: 1,
            minHeight: 60,
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid ' + (error ? TERM_DANGER : TERM_BORDER),
            borderRadius: 3,
            color: TERM_GREEN_BRIGHT,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            padding: '6px 8px',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.4,
            caretColor: TERM_GREEN,
          }}
        />

        {/* Error or output */}
        {error ? (
          <div style={{
            padding: '6px 10px',
            border: '1px dashed ' + TERM_DANGER,
            borderRadius: 3,
            color: TERM_DANGER,
            fontSize: 11,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}>
            <span style={{ flex: 1 }}>
              ! {error.message}
              {error.line && (
                <span style={{ display: 'block', marginTop: 2, fontSize: 10, opacity: 0.85 }}>
                  line {error.line}, column {error.col}
                  {error.position != null && (
                    <span style={{ color: TERM_GREEN_DIM, marginLeft: 6 }}>· offset {error.position}</span>
                  )}
                </span>
              )}
            </span>
            {error.position != null && (
              <button
                onClick={jumpToError}
                title="select the broken character"
                style={btn(TERM_DANGER)}
              >↧ jump</button>
            )}
          </div>
        ) : (
          <div style={{
            flex: 1,
            minHeight: 60,
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid ' + TERM_BORDER,
            borderRadius: 3,
            padding: '6px 8px',
            overflow: 'auto',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: TERM_GREEN,
            textShadow: output ? '0 0 4px ' + TERM_GREEN : 'none',
            whiteSpace: 'pre',
            lineHeight: 1.4,
          }}>{output || (
            <span style={{ color: TERM_GREEN_DIM }}>{state.input.trim() ? '' : '(awaiting input)'}</span>
          )}</div>
        )}

        {/* Footer stats */}
        <div className="p-row" style={{ fontSize: 9, color: TERM_GREEN_DIM, justifyContent: 'space-between' }}>
          <span>in: {state.input.length}c · {state.input.split('\n').length}L</span>
          <span>{output ? 'out: ' + stats.chars + 'c · ' + stats.lines + 'L' : (error ? '✗ invalid' : '○ empty')}</span>
        </div>
      </div>
    );
  },
};

function btn(color) {
  return {
    background: 'transparent',
    color: color || 'var(--fg-bright)',
    border: '1px solid ' + (color || 'var(--border)'),
    padding: '2px 8px',
    fontFamily: 'var(--mono)',
    fontSize: 10,
    cursor: 'pointer',
    borderRadius: 2,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  };
}
