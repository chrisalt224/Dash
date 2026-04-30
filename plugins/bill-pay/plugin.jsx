// Bill Pay & Invoice Tracker — log supplier invoices with due dates.
// Color-codes by urgency: red=overdue, amber=due this week, normal=later, dim=paid.
// Auto-suggests vendor names from the Food Cost plugin if installed.

const KEY = 'plugin:bill-pay:invoices:v1';
const FOODCOST_KEY = 'plugin:food-cost:purchases:v1';

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

const daysUntil = (dateStr) => {
  const today = new Date(todayISO() + 'T00:00:00');
  const due = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
};

const statusOf = (inv) => {
  if (inv.paid) return 'paid';
  const d = daysUntil(inv.dueDate);
  if (d < 0) return 'overdue';
  if (d <= 7) return 'due-soon';
  return 'pending';
};

const STATUS_INFO = {
  overdue:    { color: 'var(--danger)',      label: 'OVERDUE' },
  'due-soon': { color: 'var(--accent-warm)', label: 'THIS WK' },
  pending:    { color: 'var(--fg)',          label: 'PENDING' },
  paid:       { color: 'var(--fg-dim)',      label: 'PAID'    },
};

export default {
  id: 'bill-pay',
  name: 'Bills & Invoices',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [invoices, setInvoices] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
    });

    const [form, setForm] = useState({
      vendor: '', amount: '', dueDate: todayISO(), invoiceNum: '',
    });
    const [filter, setFilter] = useState('open');
    const [confirmDel, setConfirmDel] = useState(null);
    const confirmTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(invoices)); } catch (e) {}
    }, [invoices]);

    // Pull known vendor names from this plugin's history + the food-cost plugin.
    const knownVendors = useMemo(() => {
      const set = new Set();
      invoices.forEach((inv) => { if (inv.vendor) set.add(inv.vendor); });
      try {
        const raw = JSON.parse(localStorage.getItem(FOODCOST_KEY));
        if (Array.isArray(raw)) {
          raw.forEach((p) => { if (p.vendor && p.vendor !== '—') set.add(p.vendor); });
        }
      } catch (e) {}
      return Array.from(set).sort();
    }, [invoices]);

    const submit = () => {
      const amount = parseFloat(form.amount) || 0;
      const vendor = form.vendor.trim();
      if (!vendor || amount <= 0 || !form.dueDate) return;
      setInvoices([
        ...invoices,
        {
          id: Date.now() + Math.random(),
          vendor,
          amount,
          dueDate: form.dueDate,
          invoiceNum: form.invoiceNum.trim(),
          paid: false,
          createdAt: todayISO(),
        },
      ]);
      // Keep vendor (often same supplier multiple invoices), reset rest
      setForm({ vendor: form.vendor, amount: '', dueDate: todayISO(), invoiceNum: '' });
    };

    const togglePaid = (id) => {
      setInvoices(invoices.map((inv) =>
        inv.id === id
          ? { ...inv, paid: !inv.paid, paidAt: !inv.paid ? todayISO() : null }
          : inv
      ));
    };

    const handleDelete = (id) => {
      if (confirmDel === id) {
        setInvoices(invoices.filter((inv) => inv.id !== id));
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };

    const stats = useMemo(() => {
      const open = invoices.filter((inv) => !inv.paid);
      const overdue = open.filter((inv) => statusOf(inv) === 'overdue');
      const dueSoon = open.filter((inv) => statusOf(inv) === 'due-soon');
      return {
        totalOwed: open.reduce((s, inv) => s + inv.amount, 0),
        overdueCount: overdue.length,
        overdueAmount: overdue.reduce((s, inv) => s + inv.amount, 0),
        dueSoonCount: dueSoon.length,
        dueSoonAmount: dueSoon.reduce((s, inv) => s + inv.amount, 0),
      };
    }, [invoices]);

    const sorted = useMemo(() => {
      const list = filter === 'open' ? invoices.filter((inv) => !inv.paid) : invoices;
      return list.slice().sort((a, b) => {
        if (a.paid !== b.paid) return a.paid ? 1 : -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
    }, [invoices, filter]);

    const headlineColor = stats.overdueCount > 0
      ? 'var(--danger)'
      : stats.dueSoonCount > 0
      ? 'var(--accent-warm)'
      : stats.totalOwed > 0
      ? 'var(--accent)'
      : 'var(--fg-dim)';

    return (
      <div className="p-col" style={{ height: '100%', gap: 8 }}>
        {/* Headline */}
        <div>
          <div className="p-label">total owed</div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 30, fontWeight: 700,
              color: headlineColor,
              textShadow: stats.totalOwed > 0 ? '0 0 8px ' + headlineColor : 'none',
              lineHeight: 1,
            }}
          >{fmtMoneyShort(stats.totalOwed)}</div>
          <div style={{ fontSize: 10, marginTop: 3, fontFamily: 'var(--mono)' }}>
            {stats.overdueCount > 0 && (
              <span style={{ color: 'var(--danger)', marginRight: 8 }}>
                ● {stats.overdueCount} overdue ({fmtMoneyShort(stats.overdueAmount)})
              </span>
            )}
            {stats.dueSoonCount > 0 && (
              <span style={{ color: 'var(--accent-warm)' }}>
                ● {stats.dueSoonCount} due this week ({fmtMoneyShort(stats.dueSoonAmount)})
              </span>
            )}
            {stats.overdueCount === 0 && stats.dueSoonCount === 0 && stats.totalOwed > 0 && (
              <span className="p-dim">all clear for the next 7 days</span>
            )}
            {stats.totalOwed === 0 && (
              <span className="p-dim">no open invoices</span>
            )}
          </div>
        </div>

        {/* Add invoice */}
        <div className="p-col" style={{ gap: 3 }}>
          <div className="p-label">add invoice</div>
          <input
            type="text"
            list="bill-pay-vendors"
            placeholder="vendor"
            value={form.vendor}
            onChange={(e) => setForm({ ...form, vendor: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            className="p-input"
            style={{ fontSize: 11 }}
          />
          <datalist id="bill-pay-vendors">
            {knownVendors.map((v) => <option key={v} value={v} />)}
          </datalist>
          <div className="p-row" style={{ gap: 3 }}>
            <input
              type="number" step="0.01" min="0"
              placeholder="amount $"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              className="p-input"
              style={{ fontSize: 11, flex: 1, minWidth: 0 }}
            />
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              className="p-input"
              style={{ fontSize: 11, flex: 1, minWidth: 0 }}
              title="due date"
            />
          </div>
          <div className="p-row" style={{ gap: 3 }}>
            <input
              type="text"
              placeholder="invoice # (optional)"
              value={form.invoiceNum}
              onChange={(e) => setForm({ ...form, invoiceNum: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              className="p-input"
              style={{ fontSize: 11, flex: 1, minWidth: 0 }}
            />
            <button className="p-btn" onClick={submit} style={{ fontSize: 11, padding: '2px 12px' }}>
              + add
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="p-row" style={{ gap: 3, alignItems: 'center' }}>
          <span className="p-label" style={{ flex: 1 }}>invoices</span>
          {['open', 'all'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? 'var(--accent)' : 'transparent',
                color: filter === f ? 'var(--bg)' : 'var(--fg-dim)',
                border: '1px solid var(--border-bright)',
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '1px 6px', cursor: 'pointer', borderRadius: 2,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                fontWeight: filter === f ? 700 : 400,
              }}
            >{f}</button>
          ))}
        </div>

        {/* List */}
        <div
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 3,
          }}
        >
          {sorted.length === 0 ? (
            <div className="p-dim" style={{ fontSize: 11, padding: 8, textAlign: 'center' }}>
              {filter === 'open' ? 'no open invoices — nice work' : 'nothing logged yet'}
            </div>
          ) : sorted.map((inv) => {
            const status = statusOf(inv);
            const info = STATUS_INFO[status];
            const isConfirming = confirmDel === inv.id;
            const days = daysUntil(inv.dueDate);
            const dueLabel = inv.paid ? 'paid'
              : days < 0 ? Math.abs(days) + 'd late'
              : days === 0 ? 'today'
              : days === 1 ? 'tomorrow'
              : days + 'd';
            return (
              <div
                key={inv.id}
                style={{
                  padding: '4px 6px',
                  borderLeft: '3px solid ' + info.color,
                  borderBottom: '1px solid var(--border)',
                  background: 'rgba(255,255,255,0.015)',
                  fontSize: 11, fontFamily: 'var(--mono)',
                  display: 'flex', alignItems: 'center', gap: 4,
                  opacity: inv.paid ? 0.55 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: 'var(--fg)', fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      textDecoration: inv.paid ? 'line-through' : 'none',
                    }}
                  >{inv.vendor}</div>
                  <div className="p-dim" style={{ fontSize: 9, marginTop: 1 }}>
                    {fmtMoney(inv.amount)} · due {inv.dueDate.slice(5)} ·
                    <span style={{ color: info.color, marginLeft: 3 }}>{dueLabel}</span>
                    {inv.invoiceNum ? ' · #' + inv.invoiceNum : ''}
                  </div>
                </div>
                <button
                  onClick={() => togglePaid(inv.id)}
                  title={inv.paid ? 'mark unpaid' : 'mark paid'}
                  style={{
                    background: inv.paid ? 'transparent' : 'rgba(var(--accent-rgb),0.1)',
                    border: '1px solid ' + (inv.paid ? 'var(--border-bright)' : 'var(--accent)'),
                    color: inv.paid ? 'var(--fg-dim)' : 'var(--accent)',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    padding: '1px 5px', cursor: 'pointer', borderRadius: 2,
                  }}
                >{inv.paid ? '↺' : '✓ pay'}</button>
                <button
                  onClick={() => handleDelete(inv.id)}
                  title={isConfirming ? 'click to confirm' : 'delete'}
                  style={{
                    background: 'transparent',
                    border: '1px solid ' + (isConfirming ? 'var(--danger)' : 'var(--border-bright)'),
                    color: isConfirming ? 'var(--danger)' : 'var(--fg-dim)',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    padding: '0 4px', cursor: 'pointer', borderRadius: 2,
                  }}
                >{isConfirming ? '✓?' : '×'}</button>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};
