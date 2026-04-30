// Break-Even Calculator — enter monthly fixed costs, average sale price,
// and average variable cost per unit. Computes how many units (and how much
// revenue) you need to sell to cover costs. Shows current month's pace
// against the target if Daily Sales is logging.
//
// Formula: BE units = Fixed / (Price − Variable)
//          BE revenue = BE units × Price
//
// Pairs with the Menu Engineering plugin — pulls a sales-weighted price and
// cost average from your menu items if you've populated it.

const KEY = 'plugin:break-even:state:v1';
const SALES_KEY = 'plugin:daily-sales:entries:v1';
const MENU_KEY = 'plugin:menu-engineering:items:v1';

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);
const fmtMoneyShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000) return '$' + (Math.abs(v) / 1000).toFixed(1) + 'k';
  return '$' + Math.abs(Math.round(v)).toLocaleString();
};
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString();

export default {
  id: 'break-even',
  name: 'Break-Even',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useMemo }) => {
    const [state, setState] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && typeof raw === 'object') {
          return { fixedCosts: 0, avgPrice: 0, varCost: 0, unitName: 'items', ...raw };
        }
      } catch (e) {}
      return { fixedCosts: 0, avgPrice: 0, varCost: 0, unitName: 'items' };
    });

    const [tick, setTick] = useState(0);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    }, [state]);

    // Re-pull sibling plugin data periodically.
    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), 5000);
      return () => clearInterval(id);
    }, []);

    // Sales-weighted average price + cost from Menu Engineering, if present.
    const menuSuggestion = useMemo(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(MENU_KEY));
        if (!Array.isArray(raw) || raw.length === 0) return null;
        const items = raw.filter(
          (i) => (Number(i.qty) || 0) > 0 && (Number(i.price) || 0) > 0
        );
        if (items.length === 0) return null;
        const totalQty = items.reduce((s, i) => s + Number(i.qty), 0);
        if (totalQty === 0) return null;
        return {
          price: items.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0) / totalQty,
          cost: items.reduce((s, i) => s + (Number(i.cost) || 0) * Number(i.qty), 0) / totalQty,
          items: items.length,
        };
      } catch (e) { return null; }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick]);

    // Current month's sales pace from Daily Sales.
    const monthStats = useMemo(() => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const off = monthStart.getTimezoneOffset();
      const monthStartISO = new Date(monthStart.getTime() - off * 60000).toISOString().slice(0, 10);
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      try {
        const raw = JSON.parse(localStorage.getItem(SALES_KEY));
        if (Array.isArray(raw)) {
          const filtered = raw.filter((e) => e.date >= monthStartISO);
          const monthSales = filtered.reduce((s, e) => s + (e.sales || 0), 0);
          return {
            monthSales, dayOfMonth, daysInMonth,
            hasData: filtered.length > 0,
          };
        }
      } catch (e) {}
      return { monthSales: 0, dayOfMonth, daysInMonth, hasData: false };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick]);

    const calc = useMemo(() => {
      const fixed = Number(state.fixedCosts) || 0;
      const price = Number(state.avgPrice) || 0;
      const varc = Number(state.varCost) || 0;
      const cm = price - varc;
      const cmRatio = price > 0 ? cm / price : 0;
      if (price <= 0) return { valid: false, reason: 'enter your average sale price' };
      if (cm <= 0) return { valid: false, reason: 'price must exceed variable cost' };
      if (fixed <= 0) return { valid: false, reason: 'enter your fixed monthly costs' };
      const units = fixed / cm;
      const revenue = units * price;
      return {
        valid: true,
        units, revenue,
        unitsPerDay: units / 30,
        revenuePerDay: revenue / 30,
        cmPerUnit: cm,
        cmRatio,
      };
    }, [state]);

    const pacing = useMemo(() => {
      if (!calc.valid || !monthStats.hasData) return null;
      const { monthSales, dayOfMonth, daysInMonth } = monthStats;
      const projected = (monthSales / dayOfMonth) * daysInMonth;
      const pctOfBE = (monthSales / calc.revenue) * 100;
      const projectedPct = (projected / calc.revenue) * 100;
      return { monthSales, projected, pctOfBE, projectedPct, ahead: projected >= calc.revenue };
    }, [calc, monthStats]);

    const useMenuValues = () => {
      if (!menuSuggestion) return;
      setState({
        ...state,
        avgPrice: Math.round(menuSuggestion.price * 100) / 100,
        varCost: Math.round(menuSuggestion.cost * 100) / 100,
      });
    };

    const inputStyle = { fontSize: 11, flex: 1, minWidth: 0, padding: '2px 4px' };
    const labelStyle = {
      fontSize: 9, color: 'var(--fg-dim)',
      letterSpacing: '0.1em', textTransform: 'uppercase',
      flex: '0 0 76px',
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Inputs */}
        <div className="p-col" style={{ gap: 3 }}>
          <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
            <span style={labelStyle}>fixed/mo</span>
            <input
              type="number" step="1" min="0"
              placeholder="rent + payroll + ..."
              value={state.fixedCosts || ''}
              onChange={(e) => setState({ ...state, fixedCosts: parseFloat(e.target.value) || 0 })}
              className="p-input"
              style={inputStyle}
              title="monthly fixed costs that don't change with sales: rent, salaries, insurance, utilities"
            />
          </div>
          <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
            <span style={labelStyle}>avg price</span>
            <input
              type="number" step="0.01" min="0"
              placeholder="$ per sale"
              value={state.avgPrice || ''}
              onChange={(e) => setState({ ...state, avgPrice: parseFloat(e.target.value) || 0 })}
              className="p-input"
              style={inputStyle}
              title="average ticket price per unit sold"
            />
          </div>
          <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
            <span style={labelStyle}>var cost</span>
            <input
              type="number" step="0.01" min="0"
              placeholder="food + packaging"
              value={state.varCost || ''}
              onChange={(e) => setState({ ...state, varCost: parseFloat(e.target.value) || 0 })}
              className="p-input"
              style={inputStyle}
              title="variable cost per unit: food, packaging, hourly labor that scales with sales"
            />
          </div>
          {menuSuggestion && (
            <button
              className="p-btn"
              onClick={useMenuValues}
              title={'sales-weighted average across ' + menuSuggestion.items + ' menu items'}
              style={{ fontSize: 9, padding: '1px 6px', alignSelf: 'flex-start' }}
            >
              ↪ use menu avg ({fmtMoney(menuSuggestion.price)} / {fmtMoney(menuSuggestion.cost)})
            </button>
          )}
        </div>

        {/* Big result */}
        <div
          style={{
            padding: '6px 8px',
            background: 'rgba(0,0,0,0.22)',
            border: '1px solid ' + (calc.valid ? 'var(--border-bright)' : 'var(--border)'),
            borderRadius: 3,
            textAlign: 'center',
          }}
        >
          <div className="p-label" style={{ fontSize: 9 }}>monthly break-even</div>
          {calc.valid ? (
            <>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 22, fontWeight: 700,
                  color: 'var(--accent)',
                  textShadow: '0 0 6px var(--accent)',
                  lineHeight: 1.1, marginTop: 2,
                }}
              >{fmtInt(calc.units)} {state.unitName}</div>
              <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--fg)', marginTop: 1 }}>
                ≈ {fmtMoneyShort(calc.revenue)} revenue
              </div>
              <div className="p-dim" style={{ fontSize: 9, marginTop: 3, fontFamily: 'var(--mono)' }}>
                {Math.ceil(calc.unitsPerDay)} {state.unitName}/day · {fmtMoneyShort(calc.revenuePerDay)}/day
              </div>
              <div className="p-dim" style={{ fontSize: 9, marginTop: 1 }}>
                {fmtMoney(calc.cmPerUnit)} margin/unit · {(calc.cmRatio * 100).toFixed(0)}% contribution
              </div>
            </>
          ) : (
            <div className="p-dim" style={{ fontSize: 11, padding: '12px 4px' }}>
              {calc.reason}
            </div>
          )}
        </div>

        {/* Pacing */}
        {calc.valid && pacing && (
          <div className="p-col" style={{ gap: 2 }}>
            <div className="p-row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="p-label" style={{ fontSize: 9 }}>this month</span>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>
                <span style={{ color: 'var(--fg)' }}>{fmtMoneyShort(pacing.monthSales)}</span>
                <span className="p-dim"> / {fmtMoneyShort(calc.revenue)}</span>
              </span>
            </div>
            <div
              style={{
                position: 'relative',
                height: 8, borderRadius: 2,
                background: 'rgba(255,255,255,0.05)',
                overflow: 'hidden',
                border: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: Math.min(100, pacing.pctOfBE) + '%',
                  background: pacing.pctOfBE >= 100 ? 'var(--accent)' : 'var(--accent-warm)',
                  boxShadow: pacing.pctOfBE >= 100 ? '0 0 6px var(--accent)' : 'none',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <div className="p-row" style={{ fontSize: 9, justifyContent: 'space-between', fontFamily: 'var(--mono)' }}>
              <span className="p-dim">{pacing.pctOfBE.toFixed(0)}% covered</span>
              <span
                style={{
                  color: pacing.ahead ? 'var(--accent)' : 'var(--accent-warm)',
                }}
              >projected: {pacing.projectedPct.toFixed(0)}%{pacing.ahead ? ' ✓' : ''}</span>
            </div>
          </div>
        )}

        {/* Unit name */}
        <div
          className="p-row"
          style={{
            gap: 4, alignItems: 'center',
            borderTop: '1px solid var(--border)', paddingTop: 4, marginTop: 'auto',
          }}
        >
          <span className="p-label" style={{ fontSize: 9 }}>unit:</span>
          <input
            type="text"
            value={state.unitName}
            onChange={(e) => setState({ ...state, unitName: e.target.value.slice(0, 20) })}
            onBlur={(e) => {
              if (!e.target.value.trim()) setState({ ...state, unitName: 'items' });
            }}
            className="p-input"
            style={{ fontSize: 10, flex: 1, minWidth: 0, padding: '1px 4px' }}
            placeholder="items, pizzas, covers..."
          />
        </div>
      </div>
    );
  },
};
