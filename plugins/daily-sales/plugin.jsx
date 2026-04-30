// Daily Sales Logger — log one row per day (sales, covers, tips, comps).
// Auto-calcs 7-day rolling totals and average ticket. The food-cost plugin
// reads from this widget's localStorage key for live food-cost %.

const KEY = 'plugin:daily-sales:entries:v1';

const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);
const fmtMoneyShort = (n) => {
  const v = Number(n) || 0;
  if (v >= 10000) return '$' + (v / 1000).toFixed(1) + 'k';
  return '$' + Math.round(v).toLocaleString();
};

export default {
  id: 'daily-sales',
  name: 'Daily Sales',
  width: 3,
  height: 2,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [entries, setEntries] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
    });

    const [form, setForm] = useState({
      date: todayISO(), sales: '', covers: '', tips: '', comps: '',
    });
    const [confirmDel, setConfirmDel] = useState(null);
    const confirmTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (e) {}
    }, [entries]);

    const submit = () => {
      const sales = parseFloat(form.sales) || 0;
      const covers = parseInt(form.covers, 10) || 0;
      const tips = parseFloat(form.tips) || 0;
      const comps = parseFloat(form.comps) || 0;
      if (sales <= 0) return;
      const next = entries.filter((e) => e.date !== form.date);
      next.push({ date: form.date, sales, covers, tips, comps });
      next.sort((a, b) => a.date.localeCompare(b.date));
      setEntries(next);
      setForm({ date: todayISO(), sales: '', covers: '', tips: '', comps: '' });
    };

    const handleDelete = (date) => {
      if (confirmDel === date) {
        setEntries(entries.filter((e) => e.date !== date));
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(date);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };

    const stats = useMemo(() => {
      const last7 = entries.slice(-7);
      const totalSales = last7.reduce((s, e) => s + e.sales, 0);
      const totalCovers = last7.reduce((s, e) => s + e.covers, 0);
      const totalTips = last7.reduce((s, e) => s + e.tips, 0);
      const totalComps = last7.reduce((s, e) => s + e.comps, 0);
      return {
        totalSales,
        totalCovers,
        totalTips,
        totalComps,
        avgTicket: totalCovers > 0 ? totalSales / totalCovers : 0,
        tipPct: totalSales > 0 ? (totalTips / totalSales) * 100 : 0,
        days: last7.length,
      };
    }, [entries]);

    const sparkData = useMemo(() => {
      const last14 = entries.slice(-14);
      if (last14.length === 0) return [];
      const max = Math.max(...last14.map((e) => e.sales), 1);
      return last14.map((e) => ({ date: e.date, sales: e.sales, h: e.sales / max }));
    }, [entries]);

    const recent = useMemo(() => entries.slice(-7).slice().reverse(), [entries]);

    const inputStyle = { fontSize: 11, minWidth: 0 };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Form */}
        <div className="p-row" style={{ gap: 4, flexWrap: 'wrap' }}>
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="p-input"
            style={{ ...inputStyle, flex: '0 0 130px' }}
          />
          <input
            type="number" step="0.01" min="0"
            placeholder="sales $"
            value={form.sales}
            onChange={(e) => setForm({ ...form, sales: e.target.value })}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 80px' }}
          />
          <input
            type="number" min="0"
            placeholder="covers"
            value={form.covers}
            onChange={(e) => setForm({ ...form, covers: e.target.value })}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 70px' }}
          />
          <input
            type="number" step="0.01" min="0"
            placeholder="tips $"
            value={form.tips}
            onChange={(e) => setForm({ ...form, tips: e.target.value })}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 70px' }}
          />
          <input
            type="number" step="0.01" min="0"
            placeholder="comps $"
            value={form.comps}
            onChange={(e) => setForm({ ...form, comps: e.target.value })}
            className="p-input"
            style={{ ...inputStyle, flex: '1 1 70px' }}
          />
          <button
            className="p-btn"
            onClick={submit}
            style={{ fontSize: 11, padding: '2px 14px' }}
            title="save / overwrite this date"
          >save</button>
        </div>

        {/* Stat row */}
        <div
          className="p-row"
          style={{
            gap: 14, padding: '4px 0',
            borderTop: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
            flexWrap: 'wrap',
          }}
        >
          <Stat label="7d sales" value={fmtMoneyShort(stats.totalSales)} />
          <Stat label="avg ticket" value={fmtMoney(stats.avgTicket)} />
          <Stat label="tip %" value={stats.tipPct.toFixed(1) + '%'} />
          <Stat label="covers" value={String(stats.totalCovers)} />
          <Stat label="comps" value={fmtMoneyShort(stats.totalComps)} dim />
        </div>

        {/* Chart + recent list */}
        <div className="p-row" style={{ flex: 1, gap: 10, minHeight: 0 }}>
          <div className="p-col" style={{ flex: 2, minWidth: 0, gap: 2 }}>
            <div className="p-label">14-day sales</div>
            <div
              style={{
                flex: 1, minHeight: 0,
                display: 'flex', alignItems: 'flex-end', gap: 2,
                padding: '4px 2px',
                background: 'rgba(0,0,0,0.18)',
                border: '1px solid var(--border)',
                borderRadius: 3,
              }}
            >
              {sparkData.length === 0 ? (
                <div className="p-dim" style={{ fontSize: 10, alignSelf: 'center', margin: '0 auto' }}>
                  log a day to start the trend
                </div>
              ) : sparkData.map((d, i) => (
                <div
                  key={d.date + i}
                  title={d.date + ': ' + fmtMoney(d.sales)}
                  style={{
                    flex: 1,
                    height: Math.max(2, d.h * 100) + '%',
                    background: 'var(--accent)',
                    opacity: 0.55 + 0.45 * d.h,
                    borderRadius: '2px 2px 0 0',
                    boxShadow: '0 0 4px rgba(var(--accent-rgb),0.3)',
                  }}
                />
              ))}
            </div>
          </div>

          <div className="p-col" style={{ flex: 1, minWidth: 130, gap: 2 }}>
            <div className="p-label">recent</div>
            <div style={{ flex: 1, overflowY: 'auto', fontSize: 10, fontFamily: 'var(--mono)' }}>
              {recent.length === 0 && (
                <div className="p-dim" style={{ padding: 4 }}>nothing yet</div>
              )}
              {recent.map((e) => {
                const isConfirming = confirmDel === e.date;
                return (
                  <div
                    key={e.date}
                    style={{
                      display: 'flex', alignItems: 'center',
                      gap: 4, padding: '2px 4px',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span className="p-dim" style={{ flex: '0 0 56px' }}>{e.date.slice(5)}</span>
                    <span style={{ flex: 1, color: 'var(--fg)' }}>{fmtMoneyShort(e.sales)}</span>
                    <span className="p-dim" style={{ flex: '0 0 28px', textAlign: 'right' }}>{e.covers}c</span>
                    <button
                      onClick={() => handleDelete(e.date)}
                      title={isConfirming ? 'click to confirm' : 'delete this day'}
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
        </div>
      </div>
    );
  },
};

function Stat({ label, value, dim }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="p-label" style={{ fontSize: 9 }}>{label}</div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 16, fontWeight: 700,
          color: dim ? 'var(--fg-dim)' : 'var(--accent)',
          textShadow: dim ? 'none' : 'var(--glow-soft)',
          lineHeight: 1.1,
        }}
      >{value}</div>
    </div>
  );
}
