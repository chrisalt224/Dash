// Calculator — Terminal-style expression calculator with scrollback.
//
// • Type any JS-style math expression, Enter to evaluate.
// • `last` (or `_`) refers to the previous result. `ans1`, `ans2`, ... refer
//   to the Nth result in this session (1-indexed).
// • `clear` empties the scrollback. ↑/↓ walks input history.
// • Built-ins: pi, e, sqrt, cbrt, abs, floor, ceil, round, sin, cos, tan,
//   asin, acos, atan, atan2, log, log2, log10, ln, exp, pow, min, max,
//   hypot, sign, factorial (or n!).
// • Whitelist tokenizer — no eval of arbitrary code, no host access.

const KEY = 'plugin:calculator:state:v1';
const MAX_HISTORY = 200;

const FNS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  log: Math.log10, log2: Math.log2, log10: Math.log10,
  ln: Math.log, exp: Math.exp, pow: Math.pow,
  min: Math.min, max: Math.max, hypot: Math.hypot, sign: Math.sign,
  factorial: (n) => {
    if (n < 0 || n !== Math.floor(n)) return NaN;
    if (n > 170) return Infinity;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
};

// Tokenize then evaluate using shunting-yard. This is safer than `new Function`
// and gives us precise error messages.
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      // optional exponent
      if (src[j] === 'e' || src[j] === 'E') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const raw = src.slice(i, j).replace(/_/g, '');
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error('bad number: ' + raw);
      tokens.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }
    if (c === ',') { tokens.push({ t: ',' }); i++; continue; }
    if (c === '!') { tokens.push({ t: 'op', v: '!' }); i++; continue; }
    if ('+-*/%^'.includes(c)) {
      // ** for power
      if (c === '*' && src[i + 1] === '*') { tokens.push({ t: 'op', v: '**' }); i += 2; continue; }
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error('unexpected: ' + c);
  }
  return tokens;
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4, '**': 4, 'u-': 5, '!': 6 };
const RIGHT = { '^': true, '**': true, 'u-': true };

function evaluate(src, ctx) {
  const tokens = tokenize(src);
  // Shunting-yard with function calls, unary minus, postfix !
  const output = [];
  const ops = [];
  let prevType = null; // for unary detection
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.t === 'num') { output.push(tk); prevType = 'val'; continue; }
    if (tk.t === 'name') {
      // function call?
      if (tokens[i + 1] && tokens[i + 1].t === '(') {
        ops.push({ t: 'fn', v: tk.v });
        prevType = 'fn';
      } else {
        // identifier — resolve to a value
        const name = tk.v.toLowerCase();
        let val;
        if (name === 'pi') val = Math.PI;
        else if (name === 'e') val = Math.E;
        else if (name === 'last' || name === '_' || name === 'ans') val = ctx.last;
        else if (/^ans\d+$/.test(name)) {
          const idx = Number(name.slice(3)) - 1;
          val = ctx.history[idx];
          if (val === undefined) throw new Error('no ' + name);
        } else throw new Error('unknown: ' + tk.v);
        if (typeof val !== 'number') throw new Error('no value for ' + tk.v);
        output.push({ t: 'num', v: val });
        prevType = 'val';
      }
      continue;
    }
    if (tk.t === '(') { ops.push(tk); prevType = '('; continue; }
    if (tk.t === ')') {
      while (ops.length && ops[ops.length - 1].t !== '(') output.push(ops.pop());
      if (!ops.length) throw new Error('mismatched )');
      ops.pop(); // pop (
      if (ops.length && ops[ops.length - 1].t === 'fn') output.push(ops.pop());
      prevType = 'val';
      continue;
    }
    if (tk.t === ',') {
      while (ops.length && ops[ops.length - 1].t !== '(') output.push(ops.pop());
      prevType = ',';
      continue;
    }
    if (tk.t === 'op') {
      let op = tk.v;
      // unary minus / plus
      if ((op === '-' || op === '+') && (prevType === null || prevType === 'op' || prevType === '(' || prevType === ',' || prevType === 'fn')) {
        if (op === '-') op = 'u-';
        else { prevType = 'op'; continue; } // unary + is no-op
      }
      // Caret as alias for **
      if (op === '^') op = '**';
      // Postfix !
      if (op === '!') {
        // ! has higher prec than anything in flight
        while (ops.length) {
          const top = ops[ops.length - 1];
          if (top.t === 'op' && PREC[top.v] >= PREC['!']) output.push(ops.pop());
          else break;
        }
        output.push({ t: 'op', v: '!' });
        prevType = 'val';
        continue;
      }
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top.t === 'op') {
          const tp = PREC[top.v];
          const cp = PREC[op];
          if (tp > cp || (tp === cp && !RIGHT[op])) { output.push(ops.pop()); continue; }
        }
        break;
      }
      ops.push({ t: 'op', v: op });
      prevType = 'op';
      continue;
    }
  }
  while (ops.length) {
    const top = ops.pop();
    if (top.t === '(') throw new Error('mismatched (');
    output.push(top);
  }
  // Evaluate RPN
  const stack = [];
  for (const tk of output) {
    if (tk.t === 'num') { stack.push(tk.v); continue; }
    if (tk.t === 'op') {
      if (tk.v === 'u-') {
        if (!stack.length) throw new Error('bad unary');
        stack.push(-stack.pop());
        continue;
      }
      if (tk.v === '!') {
        if (!stack.length) throw new Error('bad !');
        stack.push(FNS.factorial(stack.pop()));
        continue;
      }
      const b = stack.pop(), a = stack.pop();
      if (a === undefined || b === undefined) throw new Error('missing operand');
      switch (tk.v) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/': stack.push(a / b); break;
        case '%': stack.push(a % b); break;
        case '**': stack.push(Math.pow(a, b)); break;
        default: throw new Error('bad op: ' + tk.v);
      }
      continue;
    }
    if (tk.t === 'fn') {
      const fn = FNS[tk.v.toLowerCase()];
      if (!fn) throw new Error('unknown fn: ' + tk.v);
      // Pop args until we hit a stack underflow — simpler approach: count by arity.
      // We reconstruct from output stream-style: assume the fn takes the values pushed
      // since we cannot otherwise know arity here. For common cases, support 1–4 args
      // by pulling whatever the function expects via fn.length.
      const arity = fn.length || 1;
      const args = [];
      for (let k = 0; k < arity; k++) {
        if (!stack.length) break;
        args.unshift(stack.pop());
      }
      stack.push(fn(...args));
      continue;
    }
  }
  if (stack.length !== 1) throw new Error('bad expression');
  const r = stack[0];
  if (typeof r !== 'number') throw new Error('non-numeric');
  return r;
}

const fmtResult = (n) => {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  // Trim trailing zeros after a decimal
  const s = n.toPrecision(12);
  if (s.includes('e')) return s;
  return s.replace(/\.?0+$/, '');
};

const TERM_BG = 'var(--bg)';
const TERM_BORDER = 'var(--border)';
const TERM_GREEN = 'var(--accent)';
const TERM_GREEN_DIM = 'var(--fg-dim)';
const TERM_GREEN_BRIGHT = 'var(--fg-bright)';
const TERM_AMBER = 'var(--accent-warm)';
const TERM_DANGER = 'var(--danger)';

export default {
  id: 'calculator',
  name: 'Calculator',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useRef, useMemo }) => {
    const [history, setHistory] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && Array.isArray(raw.history)) return raw.history;
      } catch {}
      return [];
    });
    const [input, setInput] = useState('');
    const [histIdx, setHistIdx] = useState(-1); // -1 = current input
    const [error, setError] = useState(null);
    const scrollRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => {
      localStorage.setItem(KEY, JSON.stringify({ history: history.slice(-MAX_HISTORY) }));
    }, [history]);

    useEffect(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [history.length]);

    const lastResult = useMemo(() => {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].ok) return history[i].result;
      }
      return 0;
    }, [history]);

    const submit = () => {
      const expr = input.trim();
      if (!expr) return;
      if (expr.toLowerCase() === 'clear') {
        setHistory([]);
        setInput('');
        setHistIdx(-1);
        return;
      }
      if (expr.toLowerCase() === 'help') {
        setHistory((h) => [...h, {
          expr,
          ok: true,
          help: true,
          ts: Date.now(),
          result: 'fns: sqrt cbrt abs floor ceil round sin cos tan ln log exp pow min max hypot factorial — vars: pi e last ansN',
        }]);
        setInput('');
        setHistIdx(-1);
        return;
      }
      try {
        const okHistory = history.filter((h) => h.ok && !h.help).map((h) => h.result);
        const result = evaluate(expr, { last: lastResult, history: okHistory });
        setHistory((h) => [...h, { expr, ok: true, result, ts: Date.now() }]);
        setInput('');
        setHistIdx(-1);
        setError(null);
      } catch (e) {
        setHistory((h) => [...h, { expr, ok: false, result: e.message, ts: Date.now() }]);
        setInput('');
        setHistIdx(-1);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const exprs = history.map((h) => h.expr);
        if (!exprs.length) return;
        const next = histIdx === -1 ? exprs.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        setInput(exprs[next]);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const exprs = history.map((h) => h.expr);
        if (histIdx === -1) return;
        const next = histIdx + 1;
        if (next >= exprs.length) {
          setHistIdx(-1);
          setInput('');
        } else {
          setHistIdx(next);
          setInput(exprs[next]);
        }
        return;
      }
    };

    const copyResult = (val) => {
      const text = String(val);
      try {
        if (window.dashboard && window.dashboard.clipboard) {
          window.dashboard.clipboard.write(text);
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(text);
        }
      } catch {}
    };

    return (
      <div
        className="p-col p-mono"
        onClick={() => inputRef.current && inputRef.current.focus()}
        style={{
          height: '100%',
          gap: 6,
          background: TERM_BG,
          padding: 8,
          borderRadius: 4,
          boxShadow: 'inset 0 0 24px rgba(0,0,0,0.55)',
          border: '1px solid ' + TERM_BORDER,
          color: TERM_GREEN_DIM,
          fontSize: 12,
        }}
      >
        <div style={{ color: TERM_GREEN_DIM, fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
          $ calc — type "help" or "clear"
        </div>
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            paddingRight: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {history.length === 0 && (
            <div style={{ color: TERM_GREEN_DIM, opacity: 0.5 }}>
              {'> 2 + 2'}{'\n'}{'> sqrt(144) + last'}
            </div>
          )}
          {history.map((h, i) => {
            const idx = history.slice(0, i + 1).filter((x) => x.ok && !x.help).length;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <div>
                  <span style={{ color: TERM_GREEN_DIM, marginRight: 6 }}>
                    {h.ok && !h.help ? 'ans' + idx : '>'}
                  </span>
                  <span style={{ color: TERM_GREEN_BRIGHT }}>{h.expr}</span>
                </div>
                <div
                  onClick={(e) => { e.stopPropagation(); h.ok && !h.help && copyResult(h.result); }}
                  title={h.ok && !h.help ? 'click to copy' : ''}
                  style={{
                    paddingLeft: 22,
                    color: h.ok ? (h.help ? TERM_GREEN_DIM : TERM_GREEN) : TERM_DANGER,
                    textShadow: h.ok && !h.help ? '0 0 4px ' + TERM_GREEN : 'none',
                    cursor: h.ok && !h.help ? 'pointer' : 'default',
                    wordBreak: 'break-all',
                  }}
                >
                  {h.ok ? (h.help ? h.result : '= ' + fmtResult(h.result)) : '! ' + h.result}
                </div>
              </div>
            );
          })}
        </div>
        <div className="p-row" style={{ alignItems: 'center', gap: 6 }}>
          <span style={{ color: TERM_GREEN, textShadow: '0 0 6px ' + TERM_GREEN }}>{'>'}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); setHistIdx(-1); }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoFocus
            placeholder="2 + 2"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: TERM_GREEN_BRIGHT,
              fontFamily: 'var(--mono)',
              fontSize: 13,
              caretColor: TERM_GREEN,
            }}
          />
        </div>
      </div>
    );
  },
};
