// Diff Tool — Two-pane text diff with green/red line highlighting.
//
// • Paste old text in left, new in right. Center pane shows a unified-style
//   diff: removed lines red, added green, context dim. Or toggle to
//   side-by-side with aligned rows.
// • LCS-based diff (O(M·N) memory). Capped at 2000 lines per side — beyond
//   that we'd need Myers, which would about double this file.
// • "ignore whitespace" toggle skips whitespace-only changes.
// • Stats footer: +N added · -M removed · =K unchanged.

const KEY = 'plugin:diff-tool:state:v1';
const MAX_LINES = 2000;

const SAMPLE_A =
  'function greet(name) {\n' +
  '  console.log("Hello, " + name);\n' +
  '  return true;\n' +
  '}\n';
const SAMPLE_B =
  'function greet(name, lang = "en") {\n' +
  '  const hi = lang === "es" ? "Hola" : "Hello";\n' +
  '  console.log(hi + ", " + name);\n' +
  '  return true;\n' +
  '}\n';

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') {
      return { left: SAMPLE_A, right: SAMPLE_B, view: 'unified', ignoreWs: false, ...raw };
    }
  } catch {}
  return { left: SAMPLE_A, right: SAMPLE_B, view: 'unified', ignoreWs: false };
};

const norm = (line, ignoreWs) =>
  ignoreWs ? line.replace(/\s+/g, ' ').trim() : line;

// LCS-based diff — returns an array of ops:
//   { op: 'eq', a, b }   matched pair
//   { op: 'del', a }     line removed from left
//   { op: 'ins', b }     line added in right
const computeDiff = (a, b, ignoreWs) => {
  const m = a.length, n = b.length;
  // Quick equality check to skip the table for identical inputs
  if (m === n && a.every((line, i) => norm(line, ignoreWs) === norm(b[i], ignoreWs))) {
    return a.map((line, i) => ({ op: 'eq', a: line, b: b[i] }));
  }
  // dp table — flat 1D for memory
  const dp = new Int32Array((m + 1) * (n + 1));
  const W = n + 1;
  for (let i = 1; i <= m; i++) {
    const aL = norm(a[i - 1], ignoreWs);
    for (let j = 1; j <= n; j++) {
      if (aL === norm(b[j - 1], ignoreWs)) {
        dp[i * W + j] = dp[(i - 1) * W + (j - 1)] + 1;
      } else {
        const up = dp[(i - 1) * W + j];
        const left = dp[i * W + (j - 1)];
        dp[i * W + j] = up >= left ? up : left;
      }
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (norm(a[i - 1], ignoreWs) === norm(b[j - 1], ignoreWs)) {
      ops.unshift({ op: 'eq', a: a[i - 1], b: b[j - 1] });
      i--; j--;
    } else if (dp[(i - 1) * W + j] >= dp[i * W + (j - 1)]) {
      ops.unshift({ op: 'del', a: a[i - 1] });
      i--;
    } else {
      ops.unshift({ op: 'ins', b: b[j - 1] });
      j--;
    }
  }
  while (i > 0) { ops.unshift({ op: 'del', a: a[i - 1] }); i--; }
  while (j > 0) { ops.unshift({ op: 'ins', b: b[j - 1] }); j--; }
  return ops;
};

// For side-by-side: walk ops, pairing del+ins as a "changed" row
const buildSideBySide = (ops) => {
  const rows = [];
  let i = 0;
  while (i < ops.length) {
    const o = ops[i];
    if (o.op === 'eq') {
      rows.push({ kind: 'eq', a: o.a, b: o.b });
      i++;
    } else if (o.op === 'del') {
      // peek for paired ins (consecutive del runs followed by ins runs are common in LCS output)
      const dels = [];
      while (i < ops.length && ops[i].op === 'del') { dels.push(ops[i].a); i++; }
      const inss = [];
      while (i < ops.length && ops[i].op === 'ins') { inss.push(ops[i].b); i++; }
      const max = Math.max(dels.length, inss.length);
      for (let k = 0; k < max; k++) {
        rows.push({
          kind: dels[k] != null && inss[k] != null ? 'chg' : (dels[k] != null ? 'del' : 'ins'),
          a: dels[k] != null ? dels[k] : '',
          b: inss[k] != null ? inss[k] : '',
        });
      }
    } else if (o.op === 'ins') {
      rows.push({ kind: 'ins', a: '', b: o.b });
      i++;
    }
  }
  return rows;
};

export default {
  id: 'diff-tool',
  name: 'Diff',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useMemo }) => {
    const [state, setState] = useState(loadState);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const { ops, stats, truncated } = useMemo(() => {
      const aLines = state.left.split('\n');
      const bLines = state.right.split('\n');
      const tooBig = aLines.length > MAX_LINES || bLines.length > MAX_LINES;
      const a = tooBig ? aLines.slice(0, MAX_LINES) : aLines;
      const b = tooBig ? bLines.slice(0, MAX_LINES) : bLines;
      const result = computeDiff(a, b, state.ignoreWs);
      let added = 0, removed = 0, eq = 0;
      for (const o of result) {
        if (o.op === 'eq') eq++;
        else if (o.op === 'del') removed++;
        else if (o.op === 'ins') added++;
      }
      return { ops: result, stats: { added, removed, eq }, truncated: tooBig };
    }, [state.left, state.right, state.ignoreWs]);

    const swap = () => setState((s) => ({ ...s, left: s.right, right: s.left }));
    const clear = () => setState((s) => ({ ...s, left: '', right: '' }));

    const setView = (v) => setState((s) => ({ ...s, view: v }));
    const toggleIgnoreWs = () => setState((s) => ({ ...s, ignoreWs: !s.ignoreWs }));

    const sideBySideRows = state.view === 'split' ? buildSideBySide(ops) : null;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Toolbar */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 4, overflow: 'hidden',
          }}>
            {[{ id: 'unified', label: 'unified' }, { id: 'split', label: 'split' }].map((t) => {
              const active = state.view === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setView(t.id)}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '3px 10px',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                  }}
                >{t.label}</button>
              );
            })}
          </div>
          <button
            onClick={toggleIgnoreWs}
            title="ignore whitespace differences"
            style={{
              background: state.ignoreWs ? 'rgba(var(--accent-rgb),0.1)' : 'transparent',
              border: '1px solid ' + (state.ignoreWs ? 'var(--accent)' : 'var(--border-bright)'),
              color: state.ignoreWs ? 'var(--accent)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '2px 6px', borderRadius: 2, cursor: 'pointer',
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}
          >ws</button>
          <span style={{ flex: 1 }} />
          <button onClick={swap} className="p-btn" style={{ fontSize: 10, padding: '2px 8px' }} title="swap left ↔ right">⇄ swap</button>
          <button onClick={clear} className="p-btn" style={{ fontSize: 10, padding: '2px 8px' }}>clear</button>
        </div>

        {/* Inputs */}
        <div style={{ display: 'flex', gap: 4, height: 100 }}>
          <textarea
            value={state.left}
            onChange={(e) => setState((s) => ({ ...s, left: e.target.value }))}
            placeholder="left / old…"
            spellCheck={false}
            style={{
              flex: 1, resize: 'none',
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              color: 'var(--fg)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '4px 6px', outline: 'none',
              lineHeight: 1.3,
            }}
          />
          <textarea
            value={state.right}
            onChange={(e) => setState((s) => ({ ...s, right: e.target.value }))}
            placeholder="right / new…"
            spellCheck={false}
            style={{
              flex: 1, resize: 'none',
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              color: 'var(--fg)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '4px 6px', outline: 'none',
              lineHeight: 1.3,
            }}
          />
        </div>

        {/* Diff output */}
        <div style={{
          flex: 1,
          minHeight: 80,
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid var(--border-bright)',
          borderRadius: 3,
          overflow: 'auto',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          lineHeight: 1.4,
        }}>
          {state.view === 'unified' ? (
            <div style={{ minWidth: 'min-content' }}>
              {ops.map((o, i) => {
                const sym = o.op === 'eq' ? '  ' : o.op === 'del' ? '- ' : '+ ';
                const text = o.op === 'eq' ? o.a : o.op === 'del' ? o.a : o.b;
                const bg = o.op === 'eq' ? 'transparent'
                  : o.op === 'del' ? 'rgba(255,107,107,0.12)' : 'rgba(var(--accent-rgb),0.12)';
                const color = o.op === 'eq' ? 'var(--fg-dim)'
                  : o.op === 'del' ? 'var(--danger)' : 'var(--accent)';
                return (
                  <div key={i} style={{
                    background: bg, color,
                    padding: '1px 8px',
                    whiteSpace: 'pre',
                    borderLeft: '2px solid ' + (o.op === 'eq' ? 'transparent' : color),
                  }}>
                    <span style={{ opacity: 0.6, marginRight: 2 }}>{sym}</span>{text || ' '}
                  </div>
                );
              })}
              {ops.length === 0 && (
                <div className="p-dim" style={{ padding: 12, textAlign: 'center' }}>(no content)</div>
              )}
            </div>
          ) : (
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              tableLayout: 'fixed',
            }}>
              <tbody>
                {sideBySideRows && sideBySideRows.map((row, i) => {
                  const leftBg = row.kind === 'del' || row.kind === 'chg' ? 'rgba(255,107,107,0.12)' : 'transparent';
                  const rightBg = row.kind === 'ins' || row.kind === 'chg' ? 'rgba(var(--accent-rgb),0.12)' : 'transparent';
                  const leftColor = row.kind === 'del' || row.kind === 'chg' ? 'var(--danger)' : 'var(--fg-dim)';
                  const rightColor = row.kind === 'ins' || row.kind === 'chg' ? 'var(--accent)' : 'var(--fg-dim)';
                  return (
                    <tr key={i}>
                      <td style={{
                        width: '50%', padding: '1px 6px',
                        whiteSpace: 'pre',
                        background: leftBg,
                        color: leftColor,
                        borderRight: '1px solid var(--border-bright)',
                        verticalAlign: 'top',
                        wordBreak: 'break-all',
                        overflowWrap: 'anywhere',
                      }}>{row.a || ' '}</td>
                      <td style={{
                        width: '50%', padding: '1px 6px',
                        whiteSpace: 'pre',
                        background: rightBg,
                        color: rightColor,
                        verticalAlign: 'top',
                        wordBreak: 'break-all',
                        overflowWrap: 'anywhere',
                      }}>{row.b || ' '}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Stats footer */}
        <div className="p-row" style={{ fontSize: 10, justifyContent: 'space-between', fontFamily: 'var(--mono)' }}>
          <span>
            <span style={{ color: 'var(--accent)' }}>+{stats.added}</span>
            <span style={{ color: 'var(--fg-dim)', margin: '0 4px' }}>·</span>
            <span style={{ color: 'var(--danger)' }}>-{stats.removed}</span>
            <span style={{ color: 'var(--fg-dim)', margin: '0 4px' }}>·</span>
            <span className="p-dim">={stats.eq}</span>
          </span>
          {truncated && (
            <span style={{ color: 'var(--accent-warm)' }}>
              ⚠ truncated to {MAX_LINES} lines/side
            </span>
          )}
        </div>
      </div>
    );
  },
};
