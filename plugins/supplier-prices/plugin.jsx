// Supplier Price Tracker — log unit prices per item per supplier over time.
// Flags any item where a supplier raised the price by more than the
// configured threshold % since the previous log. Items list reorders so
// flagged items float to the top — vendor price creep stops being silent.
//
// Pairs with Food Cost (vendor autocomplete) and Recipe Cost (provides
// per-item current best price).

const KEY = 'plugin:supplier-prices:v1';
const FOODCOST_KEY = 'plugin:food-cost:purchases:v1';

const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);

export default {
  id: 'supplier-prices',
  name: 'Supplier Prices',
  width: 3,
  height: 2,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [data, setData] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && typeof raw === 'object') {
          return { entries: [], threshold: 5, ...raw };
        }
      } catch (e) {}
      return { entries: [], threshold: 5 };
    });

    const [form, setForm] = useState({
      item: '', supplier: '', unit: 'lb', price: '', date: todayISO(),
    });
    const [expanded, setExpanded] = useState(null);
    const [confirmDel, setConfirmDel] = useState(null);
    const confirmTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    }, [data]);

    const knownVendors = useMemo(() => {
      const set = new Set();
      data.entries.forEach((e) => { if (e.supplier) set.add(e.supplier); });
      try {
        const raw = JSON.parse(localStorage.getItem(FOODCOST_KEY));
        if (Array.isArray(raw)) {
          raw.forEach((p) => { if (p.vendor && p.vendor !== '—') set.add(p.vendor); });
        }
      } catch (e) {}
      return Array.from(set).sort();
    }, [data.entries]);

    const knownItems = useMemo(() => {
      const set = new Set();
      data.entries.forEach((e) => { if (e.item) set.add(e.item); });
      return Array.from(set).sort();
    }, [data.entries]);

    const submit = () => {
      const price = parseFloat(form.price) || 0;
      const item = form.item.trim();
      const supplier = form.supplier.trim();
      if (!item || !supplier || price <= 0) return;
      const newEntry = {
        id: Date.now() + Math.random(),
        item, supplier,
        unit: form.unit.trim() || 'unit',
        price, date: form.date || todayISO(),
      };
      setData({
        ...data,
        entries: [...data.entries, newEntry].sort((a, b) => a.date.localeCompare(b.date)),
      });
      setForm({ ...form, price: '' });
    };

    const handleDelete = (id) => {
      if (confirmDel === id) {
        setData({ ...data, entries: data.entries.filter((e) => e.id !== id) });
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };

    // Group: { item: { supplier: [entries newest-first] } }
    const byItem = useMemo(() => {
      const groups = {};
      data.entries.forEach((e) => {
        if (!groups[e.item]) groups[e.item] = { item: e.item, suppliers: {}, all: [] };
        if (!groups[e.item].suppliers[e.supplier]) groups[e.item].suppliers[e.supplier] = [];
        groups[e.item].suppliers[e.supplier].push(e);
        groups[e.item].all.push(e);
      });
      Object.values(groups).forEach((g) => {
        Object.keys(g.suppliers).forEach((s) => {
          g.suppliers[s].sort((a, b) => b.date.localeCompare(a.date));
        });
        const supplierStats = Object.entries(g.suppliers).map(([sup, entries]) => {
          const cur = entries[0];
          const prev = entries[1];
          const change = prev ? ((cur.price - prev.price) / prev.price) * 100 : 0;
          return {
            supplier: sup,
            currentPrice: cur.price,
            currentDate: cur.date,
            unit: cur.unit,
            previousPrice: prev ? prev.price : null,
            previousDate: prev ? prev.date : null,
            change,
            history: entries,
          };
        });
        supplierStats.sort((a, b) => a.currentPrice - b.currentPrice);
        g.supplierStats = supplierStats;
        g.bestSupplier = supplierStats[0];
        // Largest UPWARD change among suppliers — that's the creep signal.
        g.maxIncrease = supplierStats.reduce((m, s) => (s.change > m ? s.change : m), 0);
        g.flagged = g.maxIncrease > data.threshold;
      });
      return groups;
    }, [data.entries, data.threshold]);

    const sortedItems = useMemo(() => {
      const arr = Object.values(byItem);
      arr.sort((a, b) => {
        if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
        if (a.flagged && b.flagged) return b.maxIncrease - a.maxIncrease;
        return a.item.localeCompare(b.item);
      });
      return arr;
    }, [byItem]);

    const alertCount = sortedItems.filter((i) => i.flagged).length;
    const inputStyle = { fontSize: 11, minWidth: 0 };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Log form */}
        <div className="p-row" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text" list="sp-items"
            placeholder="item"
            value={form.item}
            onChange={(e) => setForm({ ...form, item: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '2 1 100px' }}
          />
          <datalist id="sp-items">{knownItems.map((i) => <option key={i} value={i} />)}</datalist>
          <input
            type="text" list="sp-vendors"
            placeholder="supplier"
            value={form.supplier}
            onChange={(e) => setForm({ ...form, supplier: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '2 1 100px' }}
          />
          <datalist id="sp-vendors">{knownVendors.map((v) => <option key={v} value={v} />)}</datalist>
          <input
            type="text"
            placeholder="unit"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '0 0 56px' }}
            title="lb, case, gal, ea..."
          />
          <input
            type="number" step="0.01" min="0"
            placeholder="price"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 70px' }}
          />
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="p-input"
            style={{ ...inputStyle, flex: '0 0 120px' }}
          />
          <button className="p-btn" onClick={submit} style={{ fontSize: 11, padding: '2px 12px' }}>
            log
          </button>
        </div>

        {/* Threshold + alert summary */}
        <div className="p-row" style={{ gap: 6, alignItems: 'center', fontSize: 10 }}>
          <span className="p-dim">alert when price up &gt;</span>
          <input
            type="number" step="0.5" min="0"
            value={data.threshold}
            onChange={(e) => setData({ ...data, threshold: Math.max(0, parseFloat(e.target.value) || 0) })}
            className="p-input"
            style={{ fontSize: 10, width: 50, padding: '1px 4px', textAlign: 'right' }}
          />
          <span className="p-dim">% since previous log</span>
          <span style={{ flex: 1 }} />
          {alertCount > 0 ? (
            <span style={{ color: 'var(--danger)', fontFamily: 'var(--mono)' }}>
              ▲ {alertCount} item{alertCount === 1 ? '' : 's'} flagged
            </span>
          ) : sortedItems.length > 0 ? (
            <span className="p-dim" style={{ fontFamily: 'var(--mono)' }}>
              {sortedItems.length} tracked · all stable
            </span>
          ) : null}
        </div>

        {/* Items */}
        <div
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 3,
          }}
        >
          {sortedItems.length === 0 ? (
            <div className="p-dim" style={{ fontSize: 11, padding: 8, textAlign: 'center' }}>
              log a few item / supplier prices to start tracking creep
            </div>
          ) : sortedItems.map((g) => {
            const isExpanded = expanded === g.item;
            return (
              <div key={g.item} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  onClick={() => setExpanded(isExpanded ? null : g.item)}
                  style={{
                    padding: '4px 6px',
                    borderLeft: '3px solid ' + (g.flagged ? 'var(--danger)' : 'var(--accent)'),
                    background: isExpanded ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.012)',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 11, fontFamily: 'var(--mono)',
                  }}
                >
                  <span style={{ color: 'var(--fg-dim)', fontSize: 9, width: 10 }}>
                    {isExpanded ? '▾' : '▸'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        color: 'var(--fg)', fontWeight: 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >{g.item}</div>
                    <div className="p-dim" style={{ fontSize: 9 }}>
                      best: {g.bestSupplier.supplier} {fmtMoney(g.bestSupplier.currentPrice)}/{g.bestSupplier.unit}
                      {Object.keys(g.suppliers).length > 1 && ' · ' + Object.keys(g.suppliers).length + ' suppliers'}
                    </div>
                  </div>
                  {g.maxIncrease !== 0 && (
                    <span
                      style={{
                        color: g.flagged ? 'var(--danger)' : 'var(--accent-warm)',
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                        textShadow: g.flagged ? '0 0 4px var(--danger)' : 'none',
                      }}
                    >↑{g.maxIncrease.toFixed(1)}%</span>
                  )}
                </div>

                {isExpanded && (
                  <div style={{ padding: '4px 8px 6px 24px', background: 'rgba(0,0,0,0.18)' }}>
                    {g.supplierStats.map((s) => {
                      const flagged = s.change > data.threshold;
                      const isBest = s === g.bestSupplier;
                      return (
                        <div
                          key={s.supplier}
                          style={{ padding: '3px 0', fontSize: 10, fontFamily: 'var(--mono)' }}
                        >
                          <div className="p-row" style={{ alignItems: 'baseline', gap: 6 }}>
                            <span style={{ flex: 1, color: 'var(--fg)' }}>
                              {s.supplier}
                              {isBest && Object.keys(g.suppliers).length > 1 && (
                                <span style={{ color: 'var(--accent)', fontSize: 8, marginLeft: 4 }}>● best</span>
                              )}
                            </span>
                            <span style={{ color: 'var(--fg)', fontWeight: 600 }}>
                              {fmtMoney(s.currentPrice)}/{s.unit}
                            </span>
                            {s.change !== 0 && (
                              <span
                                style={{
                                  color: flagged ? 'var(--danger)'
                                    : s.change > 0 ? 'var(--accent-warm)'
                                    : 'var(--accent)',
                                  width: 56, textAlign: 'right', fontSize: 9,
                                }}
                              >{s.change > 0 ? '↑' : '↓'}{Math.abs(s.change).toFixed(1)}%</span>
                            )}
                          </div>
                          <div className="p-dim" style={{ fontSize: 8 }}>
                            {s.currentDate.slice(5)}
                            {s.previousPrice != null && (
                              <span> · was {fmtMoney(s.previousPrice)} on {s.previousDate.slice(5)}</span>
                            )}
                          </div>
                          {s.history.length > 1 && (
                            <div style={{ display: 'flex', gap: 2, marginTop: 2, flexWrap: 'wrap' }}>
                              {s.history.slice(0, 8).reverse().map((h) => (
                                <span
                                  key={h.id}
                                  title={h.date + ': ' + fmtMoney(h.price) + '/' + h.unit}
                                  style={{
                                    fontSize: 8, padding: '0 3px',
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 2,
                                    color: 'var(--fg-dim)', fontFamily: 'var(--mono)',
                                  }}
                                >{fmtMoney(h.price)}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <div
                      style={{
                        marginTop: 4, paddingTop: 3,
                        borderTop: '1px solid var(--border)',
                      }}
                    >
                      <div className="p-dim" style={{ fontSize: 8, marginBottom: 2 }}>recent logs</div>
                      {g.all.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((e) => {
                        const isConfirming = confirmDel === e.id;
                        return (
                          <div
                            key={e.id}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              fontSize: 9, padding: '1px 0', fontFamily: 'var(--mono)',
                            }}
                          >
                            <span className="p-dim" style={{ flex: '0 0 50px' }}>{e.date.slice(5)}</span>
                            <span className="p-dim" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.supplier}</span>
                            <span style={{ color: 'var(--fg)' }}>{fmtMoney(e.price)}/{e.unit}</span>
                            <button
                              onClick={() => handleDelete(e.id)}
                              title={isConfirming ? 'click to confirm' : 'delete this log'}
                              style={{
                                background: 'transparent',
                                border: '1px solid ' + (isConfirming ? 'var(--danger)' : 'transparent'),
                                color: isConfirming ? 'var(--danger)' : 'var(--fg-dim)',
                                fontFamily: 'var(--mono)', fontSize: 9,
                                padding: '0 4px', cursor: 'pointer', borderRadius: 2,
                              }}
                            >{isConfirming ? '✓?' : '×'}</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};
