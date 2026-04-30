// Food Cost % Tracker — log supplier purchases, get a live 7-day food-cost
// percentage. Reads sales from the Daily Sales Logger if installed
// (localStorage key `plugin:daily-sales:entries:v1`); otherwise lets you
// enter sales manually.

const KEY = 'plugin:food-cost:purchases:v1';
const SALES_KEY = 'plugin:daily-sales:entries:v1';
const MANUAL_SALES_KEY = 'plugin:food-cost:manualSales:v1';

const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const daysAgo = (n) => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  d.setDate(d.getDate() - n);
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);
const fmtMoneyShort = (n) => {
  const v = Number(n) || 0;
  if (v >= 10000) return '$' + (v / 1000).toFixed(1) + 'k';
  return '$' + Math.round(v).toLocaleString();
};

export default {
  id: 'food-cost',
  name: 'Food Cost %',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [purchases, setPurchases] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
    });

    // Manual sales fallback (only used if Daily Sales plugin isn't logging).
    const [manualSales, setManualSales] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(MANUAL_SALES_KEY));
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
    });

    const [form, setForm] = useState({ date: todayISO(), amount: '', vendor: '' });
    const [manualForm, setManualForm] = useState({ date: todayISO(), sales: '' });
    const [confirmDel, setConfirmDel] = useState(null);
    const confirmTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(purchases)); } catch (e) {}
    }, [purchases]);
    useEffect(() => {
      try { localStorage.setItem(MANUAL_SALES_KEY, JSON.stringify(manualSales)); } catch (e) {}
    }, [manualSales]);

    // Detect whether Daily Sales plugin is providing data — re-check on each
    // purchase add and on a slow interval (so a fresh install picks up).
    const [tick, setTick] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), 5000);
      return () => clearInterval(id);
    }, []);

    const dailySales = useMemo(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(SALES_KEY));
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick, purchases.length]);

    const linked = dailySales.length > 0;
    const sales = linked ? dailySales : manualSales;

    const submitPurchase = () => {
      const amount = parseFloat(form.amount) || 0;
      if (amount <= 0) return;
      setPurchases([
        ...purchases,
        {
          id: Date.now() + Math.random(),
          date: form.date,
          amount,
          vendor: form.vendor.trim() || '—',
        },
      ].sort((a, b) => a.date.localeCompare(b.date)));
      setForm({ date: todayISO(), amount: '', vendor: form.vendor });
    };

    const submitManualSales = () => {
      const s = parseFloat(manualForm.sales) || 0;
      if (s <= 0) return;
      const next = manualSales.filter((e) => e.date !== manualForm.date);
      next.push({ date: manualForm.date, sales: s });
      next.sort((a, b) => a.date.localeCompare(b.date));
      setManualSales(next);
      setManualForm({ date: todayISO(), sales: '' });
    };

    const handleDelete = (id) => {
      if (confirmDel === id) {
        setPurchases(purchases.filter((p) => p.id !== id));
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };

    const stats = useMemo(() => {
      const cutoff = daysAgo(6); // last 7 days inclusive of today
      const recentP = purchases.filter((p) => p.date >= cutoff);
      const recentS = sales.filter((s) => s.date >= cutoff);
      const totalPurchases = recentP.reduce((s, p) => s + p.amount, 0);
      const totalSales = recentS.reduce((s, e) => s + e.sales, 0);
      const pct = totalSales > 0 ? (totalPurchases / totalSales) * 100 : null;
      return { totalPurchases, totalSales, pct, hasPurchases: recentP.length > 0 };
    }, [purchases, sales]);

    const recent = useMemo(() => purchases.slice(-5).slice().reverse(), [purchases]);

    const status =
      stats.pct == null ? { color: 'var(--fg-dim)', label: '—' }
      : stats.pct < 28 ? { color: 'var(--accent)', label: 'GOOD' }
      : stats.pct < 33 ? { color: 'var(--accent-warm)', label: 'WATCH' }
      : { color: 'var(--danger)', label: 'HIGH' };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Big % */}
        <div>
          <div className="p-row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div className="p-label">7-day food cost</div>
            <span
              style={{
                fontSize: 9, fontFamily: 'var(--mono)',
                color: status.color, letterSpacing: '0.15em',
                textShadow: stats.pct != null ? '0 0 6px ' + status.color : 'none',
              }}
            >{status.label}</span>
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 38, fontWeight: 700,
              color: status.color,
              textShadow: stats.pct != null ? '0 0 10px ' + status.color : 'none',
              lineHeight: 1, padding: '2px 0',
            }}
          >
            {stats.pct != null ? stats.pct.toFixed(1) + '%' : '—'}
          </div>
          <div className="p-dim" style={{ fontSize: 10 }}>
            {fmtMoneyShort(stats.totalPurchases)} cost / {fmtMoneyShort(stats.totalSales)} sales
          </div>
          <div style={{ fontSize: 9, marginTop: 2 }}>
            {linked ? (
              <span style={{ color: 'var(--accent)' }}>● linked to daily sales</span>
            ) : (
              <span className="p-dim">○ enter sales below for live %</span>
            )}
          </div>
        </div>

        {/* Purchase form */}
        <div className="p-col" style={{ gap: 3 }}>
          <div className="p-label">log purchase</div>
          <div className="p-row" style={{ gap: 3 }}>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="p-input"
              style={{ flex: '1 1 110px', fontSize: 10, minWidth: 0 }}
            />
            <input
              type="number" step="0.01" min="0"
              placeholder="$"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="p-input"
              style={{ flex: '1 1 60px', fontSize: 10, minWidth: 0 }}
            />
          </div>
          <div className="p-row" style={{ gap: 3 }}>
            <input
              type="text"
              placeholder="vendor (optional)"
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              className="p-input"
              style={{ flex: 1, fontSize: 10, minWidth: 0 }}
            />
            <button className="p-btn" onClick={submitPurchase} style={{ fontSize: 10, padding: '2px 10px' }}>
              + buy
            </button>
          </div>
        </div>

        {/* Manual sales input only when not linked */}
        {!linked && (
          <div className="p-col" style={{ gap: 3 }}>
            <div className="p-label">log sales (manual)</div>
            <div className="p-row" style={{ gap: 3 }}>
              <input
                type="date"
                value={manualForm.date}
                onChange={(e) => setManualForm({ ...manualForm, date: e.target.value })}
                className="p-input"
                style={{ flex: '1 1 110px', fontSize: 10, minWidth: 0 }}
              />
              <input
                type="number" step="0.01" min="0"
                placeholder="sales $"
                value={manualForm.sales}
                onChange={(e) => setManualForm({ ...manualForm, sales: e.target.value })}
                className="p-input"
                style={{ flex: '1 1 60px', fontSize: 10, minWidth: 0 }}
              />
              <button className="p-btn" onClick={submitManualSales} style={{ fontSize: 10, padding: '2px 8px' }}>
                set
              </button>
            </div>
          </div>
        )}

        {/* Recent purchases */}
        <div className="p-col" style={{ flex: 1, minHeight: 0, gap: 2 }}>
          <div className="p-label">recent</div>
          <div style={{ flex: 1, overflowY: 'auto', fontSize: 10, fontFamily: 'var(--mono)' }}>
            {recent.length === 0 && (
              <div className="p-dim" style={{ padding: 4 }}>no purchases yet</div>
            )}
            {recent.map((p) => {
              const isConfirming = confirmDel === p.id;
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '2px 2px', borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span className="p-dim" style={{ flex: '0 0 50px' }}>{p.date.slice(5)}</span>
                  <span style={{ flex: 1, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.vendor}
                  </span>
                  <span style={{ color: 'var(--fg-bright)' }}>{fmtMoney(p.amount)}</span>
                  <button
                    onClick={() => handleDelete(p.id)}
                    title={isConfirming ? 'click to confirm' : 'delete'}
                    style={{
                      background: 'transparent',
                      border: '1px solid ' + (isConfirming ? 'var(--danger)' : 'transparent'),
                      color: isConfirming ? 'var(--danger)' : 'var(--fg-dim)',
                      fontFamily: 'var(--mono)',
                      fontSize: 10, padding: '0 4px',
                      cursor: 'pointer', borderRadius: 2,
                    }}
                  >{isConfirming ? '✓?' : '×'}</button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Threshold legend */}
        <div
          className="p-row"
          style={{ fontSize: 9, gap: 4, justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 3 }}
        >
          <span style={{ color: 'var(--accent)' }}>● &lt;28</span>
          <span style={{ color: 'var(--accent-warm)' }}>● 28–33</span>
          <span style={{ color: 'var(--danger)' }}>● &gt;33</span>
        </div>
      </div>
    );
  },
};
