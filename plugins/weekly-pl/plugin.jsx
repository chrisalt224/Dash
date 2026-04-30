// Weekly P&L Snapshot — pulls 7-day sales from the Daily Sales plugin and
// 7-day food cost from the Food Cost plugin; you fill in labor + other
// expenses (which aren't tracked elsewhere). Shows the classic P&L
// breakdown plus restaurant KPIs (food%, labor%, prime cost%, net margin%).

const KEY = 'plugin:weekly-pl:settings:v1';
const SALES_KEY = 'plugin:daily-sales:entries:v1';
const FOODCOST_KEY = 'plugin:food-cost:purchases:v1';

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

const fmtMoney = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toFixed(2);
};
const fmtMoneyShort = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  if (Math.abs(v) >= 10000) return sign + '$' + (Math.abs(v) / 1000).toFixed(1) + 'k';
  return sign + '$' + Math.abs(Math.round(v)).toLocaleString();
};

const STATUS_COLOR = {
  good:   'var(--accent)',
  warn:   'var(--accent-warm)',
  danger: 'var(--danger)',
  dim:    'var(--fg-dim)',
};

const statusForFood = (pct) => pct > 33 ? 'danger' : pct > 28 ? 'warn' : 'good';
const statusForLabor = (pct) => pct > 35 ? 'danger' : pct > 30 ? 'warn' : 'good';
const statusForPrime = (pct) => pct > 65 ? 'danger' : pct > 60 ? 'warn' : 'good';
const statusForMargin = (pct) => pct < 0 ? 'danger' : pct < 5 ? 'warn' : 'good';

export default {
  id: 'weekly-pl',
  name: 'Weekly P&L',
  width: 3,
  height: 2,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [settings, setSettings] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        return raw && typeof raw === 'object' ? { labor: 0, other: 0, ...raw } : { labor: 0, other: 0 };
      } catch (e) { return { labor: 0, other: 0 }; }
    });

    const [editing, setEditing] = useState(null);
    const [editValue, setEditValue] = useState('');
    const [tick, setTick] = useState(0);
    const editInputRef = useRef(null);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
    }, [settings]);

    // Re-pull from sibling plugins periodically (user might log a sale in
    // the daily-sales widget while this one is open).
    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), 5000);
      return () => clearInterval(id);
    }, []);

    useEffect(() => {
      if (editing && editInputRef.current) {
        editInputRef.current.focus();
        editInputRef.current.select();
      }
    }, [editing]);

    const data = useMemo(() => {
      const cutoff = daysAgo(6);
      let sales = 0, foodCost = 0, salesDays = 0, hasFood = false;
      try {
        const raw = JSON.parse(localStorage.getItem(SALES_KEY));
        if (Array.isArray(raw)) {
          const recent = raw.filter((e) => e.date >= cutoff);
          salesDays = recent.length;
          sales = recent.reduce((s, e) => s + (e.sales || 0), 0);
        }
      } catch (e) {}
      try {
        const raw = JSON.parse(localStorage.getItem(FOODCOST_KEY));
        if (Array.isArray(raw)) {
          const recent = raw.filter((p) => p.date >= cutoff);
          hasFood = recent.length > 0;
          foodCost = recent.reduce((s, p) => s + (p.amount || 0), 0);
        }
      } catch (e) {}
      const labor = Number(settings.labor) || 0;
      const other = Number(settings.other) || 0;
      const profit = sales - foodCost - labor - other;
      const pct = (n) => sales > 0 ? (n / sales) * 100 : 0;
      return {
        sales, foodCost, labor, other, profit,
        salesDays, hasFood,
        foodPct: pct(foodCost),
        laborPct: pct(labor),
        otherPct: pct(other),
        profitPct: pct(profit),
        primePct: pct(foodCost + labor),
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings, tick]);

    const startEdit = (key) => {
      setEditing(key);
      setEditValue(String(settings[key] || 0));
    };
    const commitEdit = () => {
      if (editing) {
        const v = Math.max(0, parseFloat(editValue) || 0);
        setSettings({ ...settings, [editing]: v });
      }
      setEditing(null);
      setEditValue('');
    };
    const cancelEdit = () => {
      setEditing(null);
      setEditValue('');
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'baseline', gap: 6 }}>
          <span className="p-label">7-day P&amp;L · ending</span>
          <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--fg)' }}>
            {todayISO()}
          </span>
          <span style={{ flex: 1 }} />
          <span className="p-dim" style={{ fontSize: 9 }}>
            {data.salesDays} day{data.salesDays === 1 ? '' : 's'} of sales · {data.hasFood ? 'food cost linked' : 'no food cost'}
          </span>
          <button
            onClick={() => setTick((t) => t + 1)}
            title="re-pull from sales / food cost"
            style={{
              background: 'transparent', border: '1px solid var(--border-bright)',
              color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 10,
              padding: '0 6px', cursor: 'pointer', borderRadius: 2,
            }}
          >↻</button>
        </div>

        {/* Body: waterfall left, KPIs right */}
        <div className="p-row" style={{ flex: 1, gap: 16, minHeight: 0 }}>
          {/* Waterfall */}
          <div className="p-col" style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <PLLine label="GROSS SALES" amount={data.sales} color="var(--accent)" source={data.sales > 0 ? 'from daily sales log' : 'no sales logged yet'} />
            <PLLine
              label="− Food Cost"
              amount={-data.foodCost}
              pct={data.foodPct}
              source={data.hasFood ? 'from food cost log' : null}
            />
            <PLLine
              label="− Labor"
              amount={-data.labor}
              pct={data.laborPct}
              editable
              isEditing={editing === 'labor'}
              editValue={editValue}
              editInputRef={editInputRef}
              onEdit={() => startEdit('labor')}
              onEditChange={setEditValue}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              hint="weekly payroll, including kitchen + FOH"
            />
            <PLLine
              label="− Other Expenses"
              amount={-data.other}
              pct={data.otherPct}
              editable
              isEditing={editing === 'other'}
              editValue={editValue}
              editInputRef={editInputRef}
              onEdit={() => startEdit('other')}
              onEditChange={setEditValue}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              hint="rent, utilities, supplies, marketing"
            />
            <div style={{ borderTop: '1px solid var(--border-bright)', margin: '4px 0 2px 0' }} />
            <PLLine
              label="= NET PROFIT"
              amount={data.profit}
              pct={data.profitPct}
              big
              color={data.sales === 0 ? 'var(--fg-dim)' : data.profit >= 0 ? 'var(--accent)' : 'var(--danger)'}
            />
          </div>

          {/* KPIs */}
          <div className="p-col" style={{ flex: '0 0 130px', gap: 6 }}>
            <KPI
              label="net margin"
              value={data.sales > 0 ? data.profitPct.toFixed(1) + '%' : '—'}
              status={data.sales > 0 ? statusForMargin(data.profitPct) : 'dim'}
              note="industry avg ~5%"
            />
            <KPI
              label="food cost"
              value={data.sales > 0 ? data.foodPct.toFixed(1) + '%' : '—'}
              status={data.sales > 0 ? statusForFood(data.foodPct) : 'dim'}
              note="target <30%"
            />
            <KPI
              label="labor"
              value={data.sales > 0 ? data.laborPct.toFixed(1) + '%' : '—'}
              status={data.sales > 0 ? statusForLabor(data.laborPct) : 'dim'}
              note="target <30%"
            />
            <KPI
              label="prime cost"
              value={data.sales > 0 ? data.primePct.toFixed(1) + '%' : '—'}
              status={data.sales > 0 ? statusForPrime(data.primePct) : 'dim'}
              note="food + labor · target <60%"
              emphasize
            />
          </div>
        </div>
      </div>
    );
  },
};

function PLLine({ label, amount, pct, color, source, hint, editable, isEditing, editValue, editInputRef, onEdit, onEditChange, onCommit, onCancel, big }) {
  const fontSize = big ? 18 : 12;
  const valueColor = color || (amount < 0 ? 'var(--fg)' : 'var(--fg)');
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: big ? '4px 0' : '2px 0',
        fontFamily: 'var(--mono)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: big ? 11 : 10,
            color: big ? 'var(--accent)' : 'var(--fg-dim)',
            letterSpacing: big ? '0.18em' : '0.05em',
            textTransform: big ? 'uppercase' : 'none',
            fontWeight: big ? 700 : 400,
          }}
        >{label}</div>
        {(source || hint) && !isEditing && (
          <div className="p-dim" style={{ fontSize: 9, marginTop: 1 }}>
            {source || hint}
          </div>
        )}
      </div>
      {pct != null && (
        <span
          className="p-dim"
          style={{ fontSize: 10, fontFamily: 'var(--mono)', minWidth: 36, textAlign: 'right' }}
        >{pct.toFixed(1)}%</span>
      )}
      {isEditing ? (
        <input
          ref={editInputRef}
          type="number" step="0.01" min="0"
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit();
            else if (e.key === 'Escape') onCancel();
          }}
          onBlur={onCommit}
          className="p-input"
          style={{
            fontSize: 13, fontFamily: 'var(--mono)',
            width: 90, textAlign: 'right',
            padding: '1px 4px',
          }}
        />
      ) : editable ? (
        <button
          onClick={onEdit}
          title="click to edit"
          style={{
            background: 'transparent',
            border: '1px dashed var(--border-bright)',
            color: valueColor,
            fontFamily: 'var(--mono)',
            fontSize, fontWeight: big ? 700 : 600,
            padding: '0 6px', cursor: 'pointer', borderRadius: 2,
            minWidth: 90, textAlign: 'right',
          }}
        >{fmtMoney(amount)}</button>
      ) : (
        <span
          style={{
            fontSize, fontWeight: big ? 700 : 600,
            color: valueColor, textShadow: big ? '0 0 6px ' + valueColor : 'none',
            minWidth: 90, textAlign: 'right',
          }}
        >{fmtMoney(amount)}</span>
      )}
    </div>
  );
}

function KPI({ label, value, status, note, emphasize }) {
  const color = STATUS_COLOR[status] || STATUS_COLOR.dim;
  return (
    <div
      style={{
        padding: '4px 6px',
        border: '1px solid ' + (emphasize ? color : 'var(--border)'),
        borderRadius: 3,
        background: emphasize ? 'rgba(255,255,255,0.02)' : 'transparent',
      }}
    >
      <div className="p-label" style={{ fontSize: 9 }}>{label}</div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: emphasize ? 18 : 15,
          fontWeight: 700,
          color,
          textShadow: status && status !== 'dim' ? '0 0 4px ' + color : 'none',
          lineHeight: 1.1,
        }}
      >{value}</div>
      {note && (
        <div className="p-dim" style={{ fontSize: 8, marginTop: 1 }}>{note}</div>
      )}
    </div>
  );
}
