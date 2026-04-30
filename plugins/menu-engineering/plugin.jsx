// Menu Engineering — classic Kasavana/Smith matrix.
// Each item has (cost, price, qty sold). Margin = price − cost. Items are
// classified vs. the menu's average margin and average popularity:
//   STAR       (high margin, high popularity)  — promote
//   PUZZLE     (high margin, low  popularity)  — reposition / re-price
//   PLOWHORSE  (low  margin, high popularity)  — cut cost / raise price
//   DOG        (low  margin, low  popularity)  — rework or remove

const KEY = 'plugin:menu-engineering:items:v1';

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);

const CAT = {
  STAR:      { color: 'var(--accent)', label: 'STAR',      hint: 'promote — feature on menu, train staff to upsell' },
  PUZZLE:    { color: 'var(--accent-warm)', label: 'PUZZLE',    hint: 'high margin but low sales — rename, reposition, or re-price' },
  PLOWHORSE: { color: '#5eeaff', label: 'PLOWHORSE', hint: 'popular but thin — raise price slightly or trim cost' },
  DOG:       { color: 'var(--danger)', label: 'DOG',       hint: 'low on both — rework recipe or remove from menu' },
};

const categorize = (margin, qty, avgMargin, avgQty) => {
  const hm = margin >= avgMargin;
  const hq = qty >= avgQty;
  if (hm && hq) return 'STAR';
  if (hm && !hq) return 'PUZZLE';
  if (!hm && hq) return 'PLOWHORSE';
  return 'DOG';
};

export default {
  id: 'menu-engineering',
  name: 'Menu Engineering',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [items, setItems] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
    });

    const [draft, setDraft] = useState({ name: '', cost: '', price: '', qty: '' });
    const [editingId, setEditingId] = useState(null);
    const [confirmDel, setConfirmDel] = useState(null);
    const [hoverId, setHoverId] = useState(null);
    const confirmTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    }, [items]);

    const addOrUpdate = () => {
      const name = draft.name.trim();
      const cost = parseFloat(draft.cost) || 0;
      const price = parseFloat(draft.price) || 0;
      const qty = parseInt(draft.qty, 10) || 0;
      if (!name || price <= 0) return;
      if (editingId != null) {
        setItems(items.map((i) => (i.id === editingId ? { ...i, name, cost, price, qty } : i)));
        setEditingId(null);
      } else {
        setItems([...items, { id: Date.now() + Math.random(), name, cost, price, qty }]);
      }
      setDraft({ name: '', cost: '', price: '', qty: '' });
    };

    const startEdit = (item) => {
      setDraft({ name: item.name, cost: String(item.cost), price: String(item.price), qty: String(item.qty) });
      setEditingId(item.id);
    };

    const cancelEdit = () => {
      setDraft({ name: '', cost: '', price: '', qty: '' });
      setEditingId(null);
    };

    const handleDelete = (id) => {
      if (confirmDel === id) {
        setItems(items.filter((i) => i.id !== id));
        if (editingId === id) cancelEdit();
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };

    const analysis = useMemo(() => {
      if (items.length === 0) return { items: [], avgMargin: 0, avgQty: 0, totalContribution: 0 };
      const enriched = items.map((i) => ({ ...i, margin: i.price - i.cost }));
      const avgMargin = enriched.reduce((s, i) => s + i.margin, 0) / enriched.length;
      const avgQty = enriched.reduce((s, i) => s + i.qty, 0) / enriched.length;
      const cat = enriched.map((i) => ({
        ...i,
        category: categorize(i.margin, i.qty, avgMargin, avgQty),
        contribution: i.margin * i.qty,
        marginPct: i.price > 0 ? ((i.price - i.cost) / i.price) * 100 : 0,
      }));
      const totalContribution = cat.reduce((s, i) => s + i.contribution, 0);
      return { items: cat, avgMargin, avgQty, totalContribution };
    }, [items]);

    const counts = useMemo(() => {
      const c = { STAR: 0, PUZZLE: 0, PLOWHORSE: 0, DOG: 0 };
      analysis.items.forEach((i) => { c[i.category]++; });
      return c;
    }, [analysis]);

    const sortedItems = useMemo(() => {
      return analysis.items.slice().sort((a, b) => b.contribution - a.contribution);
    }, [analysis]);

    const inputStyle = { fontSize: 11, minWidth: 0 };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Form */}
        <div className="p-row" style={{ gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="item name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addOrUpdate(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '2 1 110px' }}
          />
          <input
            type="number" step="0.01" min="0"
            placeholder="cost $"
            value={draft.cost}
            onChange={(e) => setDraft({ ...draft, cost: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addOrUpdate(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 60px' }}
          />
          <input
            type="number" step="0.01" min="0"
            placeholder="price $"
            value={draft.price}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addOrUpdate(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 60px' }}
          />
          <input
            type="number" min="0"
            placeholder="qty/wk"
            value={draft.qty}
            onChange={(e) => setDraft({ ...draft, qty: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addOrUpdate(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 60px' }}
          />
          <button className="p-btn" onClick={addOrUpdate} style={{ fontSize: 11, padding: '2px 10px' }}>
            {editingId != null ? 'update' : '+ add'}
          </button>
          {editingId != null && (
            <button className="p-btn" onClick={cancelEdit} style={{ fontSize: 11, padding: '2px 8px' }}>cancel</button>
          )}
        </div>

        {/* Counts strip */}
        <div
          className="p-row"
          style={{
            gap: 10, fontSize: 10, padding: '4px 6px',
            background: 'rgba(0,0,0,0.2)',
            border: '1px solid var(--border)', borderRadius: 3,
            flexWrap: 'wrap', alignItems: 'center',
          }}
        >
          {Object.entries(CAT).map(([k, info]) => (
            <div key={k} style={{ color: info.color, opacity: counts[k] > 0 ? 1 : 0.35, fontFamily: 'var(--mono)' }}>
              ● {info.label} <span style={{ fontWeight: 700 }}>{counts[k]}</span>
            </div>
          ))}
          <span style={{ flex: 1 }} />
          <span className="p-dim" style={{ fontSize: 10 }}>
            weekly contribution: <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{fmtMoney(analysis.totalContribution)}</span>
          </span>
        </div>

        {/* Item list + scatter chart */}
        <div className="p-row" style={{ flex: 1, gap: 8, minHeight: 0 }}>
          <div className="p-col" style={{ flex: 1, minWidth: 0, minHeight: 0, gap: 2 }}>
            <div className="p-label">items · sorted by contribution</div>
            <div
              style={{
                flex: 1, minHeight: 0, overflowY: 'auto',
                border: '1px solid var(--border)',
                borderRadius: 3, padding: 2,
              }}
            >
              {sortedItems.length === 0 ? (
                <div className="p-dim" style={{ fontSize: 11, padding: 8 }}>
                  add a few menu items above. you'll need at least 2 to see meaningful categories.
                </div>
              ) : sortedItems.map((item) => {
                const info = CAT[item.category];
                const isConfirming = confirmDel === item.id;
                const isHover = hoverId === item.id;
                return (
                  <div
                    key={item.id}
                    onMouseEnter={() => setHoverId(item.id)}
                    onMouseLeave={() => setHoverId((h) => (h === item.id ? null : h))}
                    style={{
                      padding: '4px 6px',
                      borderLeft: '3px solid ' + info.color,
                      marginBottom: 2,
                      background: isHover ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.015)',
                      fontSize: 11, fontFamily: 'var(--mono)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          color: 'var(--fg)', fontWeight: 600,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >{item.name}</div>
                      <div className="p-dim" style={{ fontSize: 9, marginTop: 1 }}>
                        {fmtMoney(item.margin)}/u × {item.qty} = {fmtMoney(item.contribution)} · {item.marginPct.toFixed(0)}% margin
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 8, color: info.color,
                        letterSpacing: '0.1em', fontWeight: 700,
                      }}
                    >{info.label}</span>
                    <button
                      onClick={() => startEdit(item)}
                      title="edit"
                      style={{
                        background: 'transparent',
                        border: '1px solid ' + (editingId === item.id ? 'var(--accent)' : 'var(--border-bright)'),
                        color: editingId === item.id ? 'var(--accent)' : 'var(--fg-dim)',
                        fontFamily: 'var(--mono)', fontSize: 10,
                        padding: '0 5px', cursor: 'pointer', borderRadius: 2,
                      }}
                    >✎</button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      title={isConfirming ? 'click again to confirm' : 'delete'}
                      style={{
                        background: 'transparent',
                        border: '1px solid ' + (isConfirming ? 'var(--danger)' : 'var(--border-bright)'),
                        color: isConfirming ? 'var(--danger)' : 'var(--fg-dim)',
                        fontFamily: 'var(--mono)', fontSize: 10,
                        padding: '0 5px', cursor: 'pointer', borderRadius: 2,
                      }}
                    >{isConfirming ? '✓?' : '×'}</button>
                  </div>
                );
              })}
            </div>
          </div>

          <Scatter
            items={analysis.items}
            avgMargin={analysis.avgMargin}
            avgQty={analysis.avgQty}
            hoverId={hoverId}
            onHover={setHoverId}
          />
        </div>

        {/* Hover hint */}
        <div
          className="p-dim"
          style={{
            fontSize: 10, fontFamily: 'var(--mono)',
            minHeight: 14, padding: '0 2px',
            borderTop: '1px solid var(--border)', paddingTop: 3,
          }}
        >
          {hoverId != null && (() => {
            const it = analysis.items.find((i) => i.id === hoverId);
            if (!it) return null;
            const info = CAT[it.category];
            return (
              <span>
                <span style={{ color: info.color, fontWeight: 700 }}>{info.label}:</span> {info.hint}
              </span>
            );
          })() || (
            <span>hover an item to see what to do about it</span>
          )}
        </div>
      </div>
    );
  },
};

function Scatter({ items, avgMargin, avgQty, hoverId, onHover }) {
  if (items.length === 0) return null;
  const W = 200, H = 200, P = 18;
  const maxMargin = Math.max(...items.map((i) => i.margin), avgMargin * 1.6, 1);
  const maxQty = Math.max(...items.map((i) => i.qty), avgQty * 1.6, 1);

  const xFor = (q) => P + (Math.max(0, q) / maxQty) * (W - 2 * P);
  const yFor = (m) => H - P - (Math.max(0, m) / maxMargin) * (H - 2 * P);
  const cx = xFor(avgQty);
  const cy = yFor(avgMargin);

  return (
    <div className="p-col" style={{ flex: '0 0 auto', gap: 2, minWidth: 0 }}>
      <div className="p-label">popularity × margin</div>
      <svg
        viewBox={'0 0 ' + W + ' ' + H}
        style={{
          width: W, height: H, maxWidth: '100%', display: 'block',
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3,
        }}
      >
        {/* Quadrant tints */}
        <rect x={cx} y={P} width={W - P - cx} height={cy - P} fill="rgba(var(--accent-rgb),0.07)" />
        <rect x={P} y={P} width={cx - P} height={cy - P} fill="rgba(255,180,84,0.06)" />
        <rect x={cx} y={cy} width={W - P - cx} height={H - P - cy} fill="rgba(94,234,255,0.05)" />
        <rect x={P} y={cy} width={cx - P} height={H - P - cy} fill="rgba(255,107,107,0.06)" />
        {/* Axes */}
        <line x1={P} y1={cy} x2={W - P} y2={cy} stroke="var(--border-bright)" strokeDasharray="2 2" />
        <line x1={cx} y1={P} x2={cx} y2={H - P} stroke="var(--border-bright)" strokeDasharray="2 2" />
        <rect x={P} y={P} width={W - 2 * P} height={H - 2 * P} fill="none" stroke="var(--border-bright)" />
        {/* Quadrant labels */}
        <text x={cx + 4} y={P + 9} fill="var(--accent)" fontSize="9" fontFamily="monospace">STAR</text>
        <text x={P + 3} y={P + 9} fill="var(--accent-warm)" fontSize="9" fontFamily="monospace">PUZZLE</text>
        <text x={cx + 4} y={H - P - 3} fill="#5eeaff" fontSize="9" fontFamily="monospace">PLOW</text>
        <text x={P + 3} y={H - P - 3} fill="var(--danger)" fontSize="9" fontFamily="monospace">DOG</text>
        {/* Points */}
        {items.map((item) => {
          const x = xFor(item.qty);
          const y = yFor(item.margin);
          const color = CAT[item.category].color;
          const isHover = hoverId === item.id;
          return (
            <g
              key={item.id}
              onMouseEnter={() => onHover(item.id)}
              onMouseLeave={() => onHover(null)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={x} cy={y}
                r={isHover ? 6 : 4}
                fill={color}
                fillOpacity={isHover ? 0.9 : 0.7}
                stroke={color}
                strokeWidth={isHover ? 2 : 1}
              >
                <title>{item.name + ': ' + fmtMoney(item.margin) + ' margin × ' + item.qty}</title>
              </circle>
              {isHover && (
                <text
                  x={x + 8} y={y + 3}
                  fill={color} fontSize="9" fontFamily="monospace"
                  style={{ pointerEvents: 'none' }}
                >{item.name}</text>
              )}
            </g>
          );
        })}
        {/* Axis labels */}
        <text x={W - P - 2} y={H - 3} fill="var(--fg-dim)" fontSize="8" fontFamily="monospace" textAnchor="end">
          popularity →
        </text>
        <text
          x={5} y={P + 4}
          fill="var(--fg-dim)" fontSize="8" fontFamily="monospace"
          transform={'rotate(-90, 5, ' + (P + 4) + ')'}
        >margin →</text>
      </svg>
    </div>
  );
}
