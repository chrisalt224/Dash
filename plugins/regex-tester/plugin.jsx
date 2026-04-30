// Regex Tester — Live regex matching with highlighted results.
//
// • Pattern input + flag toggles (g, i, m, s, u, y). Pattern is wrapped in
//   /.../ visually but you type it bare.
// • Test text below shows matches highlighted in green; current selected
//   match in amber. Click any match in the list to scroll to and highlight
//   that one.
// • Capture groups (numbered + named) shown for the selected match.
// • Errors (bad pattern) show inline; existing matches stay visible until
//   you fix the regex.
//
// All in renderer — no host APIs.

const KEY = 'plugin:regex-tester:state:v1';

const FLAGS = [
  { id: 'g', hint: 'global — find all matches' },
  { id: 'i', hint: 'case-insensitive' },
  { id: 'm', hint: 'multiline ^ and $' },
  { id: 's', hint: 'dotAll — . matches newline' },
  { id: 'u', hint: 'unicode' },
  { id: 'y', hint: 'sticky — anchored at lastIndex' },
];

const SAMPLE_PATTERN = '\\b(\\w+)@(\\w+\\.\\w+)\\b';
const SAMPLE_TEXT =
  'Mail us at hello@example.com or support@test.io.\n' +
  'Bad: foo@bar (no TLD).\n' +
  'Good: dev+filter@nested.example.org\n';

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') {
      return { pattern: SAMPLE_PATTERN, flags: 'g', testText: SAMPLE_TEXT, ...raw };
    }
  } catch {}
  return { pattern: SAMPLE_PATTERN, flags: 'g', testText: SAMPLE_TEXT };
};

const computeMatches = (pattern, flags, testText) => {
  if (!pattern) return { matches: [], error: null };
  let re;
  try { re = new RegExp(pattern, flags); }
  catch (e) { return { matches: [], error: e.message }; }
  const out = [];
  if (flags.includes('g') || flags.includes('y')) {
    let m;
    let safety = 0;
    while ((m = re.exec(testText)) !== null && safety++ < 5000) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        match: m[0],
        groups: m.slice(1),
        named: m.groups || null,
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  } else {
    const m = re.exec(testText);
    if (m) out.push({
      start: m.index,
      end: m.index + m[0].length,
      match: m[0],
      groups: m.slice(1),
      named: m.groups || null,
    });
  }
  return { matches: out, error: null };
};

// Slice text into [text, match, text, match, ...] for highlighted rendering
const sliceForRender = (text, matches) => {
  const parts = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) parts.push({ type: 'text', text: text.slice(cursor, m.start) });
    parts.push({ type: 'match', text: text.slice(m.start, m.end), ref: m });
    cursor = m.end;
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
};

export default {
  id: 'regex-tester',
  name: 'Regex',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [state, setState] = useState(loadState);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const previewRef = useRef(null);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const result = useMemo(
      () => computeMatches(state.pattern, state.flags, state.testText),
      [state.pattern, state.flags, state.testText]
    );

    const parts = useMemo(
      () => sliceForRender(state.testText, result.matches),
      [state.testText, result.matches]
    );

    useEffect(() => {
      if (selectedIdx >= result.matches.length) setSelectedIdx(0);
    }, [result.matches.length]);

    const toggleFlag = (f) => {
      setState((s) => {
        const has = s.flags.includes(f);
        const newFlags = has ? s.flags.replace(f, '') : s.flags + f;
        return { ...s, flags: newFlags };
      });
    };

    const selectMatch = (i) => {
      setSelectedIdx(i);
      // Scroll preview to the match
      const el = previewRef.current && previewRef.current.querySelector('[data-match="' + i + '"]');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    const selected = result.matches[selectedIdx] || null;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Pattern input + flags */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          border: '1px solid ' + (result.error ? 'var(--danger)' : 'var(--border-bright)'),
          borderRadius: 3,
          padding: '2px 4px',
          background: 'rgba(0,0,0,0.25)',
        }}>
          <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 14 }}>/</span>
          <input
            value={state.pattern}
            onChange={(e) => setState((s) => ({ ...s, pattern: e.target.value }))}
            spellCheck={false}
            placeholder="pattern…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--fg-bright)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              padding: '4px 0',
            }}
          />
          <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 14 }}>/</span>
          <span style={{
            color: 'var(--accent-warm)',
            fontFamily: 'var(--mono)', fontSize: 12,
            minWidth: 28,
            textAlign: 'left',
          }}>{state.flags || ''}</span>
        </div>

        {/* Flag toggles */}
        <div className="p-row" style={{ gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
          {FLAGS.map((f) => {
            const active = state.flags.includes(f.id);
            return (
              <button
                key={f.id}
                onClick={() => toggleFlag(f.id)}
                title={f.hint}
                style={{
                  background: active ? 'var(--accent-warm)' : 'transparent',
                  color: active ? 'var(--bg)' : 'var(--fg-dim)',
                  border: '1px solid ' + (active ? 'var(--accent-warm)' : 'var(--border-bright)'),
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  width: 22, height: 22,
                  borderRadius: 2,
                  cursor: 'pointer',
                  fontWeight: active ? 700 : 400,
                  padding: 0,
                  lineHeight: 1,
                }}
              >{f.id}</button>
            );
          })}
          <span style={{ flex: 1 }} />
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: result.error ? 'var(--danger)' : (result.matches.length > 0 ? 'var(--accent)' : 'var(--fg-dim)'),
            textShadow: result.matches.length > 0 ? '0 0 4px var(--accent)' : 'none',
          }}>
            {result.error
              ? '! ' + result.error.replace(/^.*?Invalid regular expression:\s*/i, '')
              : result.matches.length + ' match' + (result.matches.length === 1 ? '' : 'es')}
          </span>
        </div>

        {/* Test text input */}
        <textarea
          value={state.testText}
          onChange={(e) => setState((s) => ({ ...s, testText: e.target.value }))}
          spellCheck={false}
          placeholder="test text…"
          style={{
            minHeight: 60,
            maxHeight: 120,
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            color: 'var(--fg)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            padding: '6px 8px',
            resize: 'vertical',
            outline: 'none',
            lineHeight: 1.4,
          }}
        />

        {/* Highlighted preview */}
        <div
          ref={previewRef}
          style={{
            flex: 1,
            minHeight: 50,
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid var(--border-bright)',
            borderRadius: 3,
            padding: '6px 8px',
            overflowY: 'auto',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--fg-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.5,
          }}
        >
          {parts.length === 0 || (parts.length === 1 && parts[0].type === 'text')
            ? <span style={{ opacity: 0.6 }}>{state.testText || '(empty)'}</span>
            : parts.map((p, i) => {
              if (p.type === 'text') return <span key={i}>{p.text}</span>;
              const matchIdx = result.matches.indexOf(p.ref);
              const isSel = matchIdx === selectedIdx;
              return (
                <span
                  key={i}
                  data-match={matchIdx}
                  onClick={() => selectMatch(matchIdx)}
                  style={{
                    background: isSel ? 'var(--accent-warm)' : 'rgba(var(--accent-rgb),0.25)',
                    color: isSel ? 'var(--bg)' : 'var(--fg-bright)',
                    padding: '0 2px',
                    borderRadius: 2,
                    cursor: 'pointer',
                    textShadow: isSel ? 'none' : '0 0 4px var(--accent)',
                    fontWeight: isSel ? 700 : 400,
                  }}
                >{p.text}</span>
              );
            })
          }
        </div>

        {/* Selected match details (groups) */}
        {selected && (selected.groups.length > 0 || selected.named) && (
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: 3,
            padding: '4px 8px',
            background: 'rgba(var(--accent-rgb),0.02)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxHeight: 90,
            overflowY: 'auto',
          }}>
            <div className="p-label" style={{ fontSize: 9 }}>
              match #{selectedIdx + 1} groups
            </div>
            {selected.groups.map((g, i) => (
              <div key={'g' + i} style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                display: 'flex', gap: 6,
              }}>
                <span style={{ color: 'var(--fg-dim)', width: 22 }}>${i + 1}</span>
                <span style={{
                  color: g == null ? 'var(--fg-dim)' : 'var(--fg-bright)',
                  fontStyle: g == null ? 'italic' : 'normal',
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{g == null ? 'undefined' : g}</span>
              </div>
            ))}
            {selected.named && Object.entries(selected.named).map(([name, val]) => (
              <div key={'n' + name} style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                display: 'flex', gap: 6,
              }}>
                <span style={{ color: 'var(--accent-warm)', width: 'auto', minWidth: 22 }}>?&lt;{name}&gt;</span>
                <span style={{ color: 'var(--fg-bright)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {val == null ? 'undefined' : val}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
};
