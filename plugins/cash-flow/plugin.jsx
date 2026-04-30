// Cash Flow Forecaster — projects weekly cash position 4 or 8 weeks out by
// composing data from every other plugin in this suite:
//
//   • Daily Sales:     historical sales drive the projected weekly inflows.
//   • Food Cost:       recent food-cost ratio is applied to projected sales.
//   • Weekly P&L:      labor + other recurring expenses pulled in.
//   • Bill Pay:        unpaid invoices land in the week of their due date.
//
// You add: a starting cash balance, a forecast horizon, and (optionally)
// overrides for any of the auto-pulled values.

const KEY = 'plugin:cash-flow:state:v1';
const SALES_KEY = 'plugin:daily-sales:entries:v1';
const FOODCOST_KEY = 'plugin:food-cost:purchases:v1';
const PL_KEY = 'plugin:weekly-pl:settings:v1';
const BILLS_KEY = 'plugin:bill-pay:invoices:v1';

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);
const fmtMoneyShort = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  if (Math.abs(v) >= 10000) return sign + '$' + (Math.abs(v) / 1000).toFixed(1) + 'k';
  return sign + '$' + Math.abs(Math.round(v)).toLocaleString();
};

const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const mondayOfWeek = (date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const addDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

export default {
  id: 'cash-flow',
  name: 'Cash Flow',
  width: 3,
  height: 2,
  component: ({ useState, useEffect, useMemo }) => {
    const [state, setState] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && typeof raw === 'object') {
          return {
            startingCash: 0,
            forecastWeeks: 4,
            salesMode: 'avg',
            ...raw,
          };
        }
      } catch (e) {}
      return { startingCash: 0, forecastWeeks: 4, salesMode: 'avg' };
    });

    const [tick, setTick] = useState(0);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    }, [state]);

    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), 5000);
      return () => clearInterval(id);
    }, []);

    // Slurp data from sibling plugins
    const sib = useMemo(() => {
      const read = (key, fallback) => {
        try { const raw = JSON.parse(localStorage.getItem(key)); return raw != null ? raw : fallback; }
        catch (e) { return fallback; }
      };
      return {
        sales: Array.isArray(read(SALES_KEY, [])) ? read(SALES_KEY, []) : [],
        food: Array.isArray(read(FOODCOST_KEY, [])) ? read(FOODCOST_KEY, []) : [],
        pl: { labor: 0, other: 0, ...(read(PL_KEY, {}) || {}) },
        bills: Array.isArray(read(BILLS_KEY, [])) ? read(BILLS_KEY, []) : [],
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick]);

    // Baseline metrics from history
    const baseline = useMemo(() => {
      const cutoff = addDays(todayISO(), -28);
      const recentSales = sib.sales.filter((e) => e.date >= cutoff);
      const totalRecentSales = recentSales.reduce((s, e) => s + (e.sales || 0), 0);
      const dayCount = recentSales.length;
      const avgWeeklySales = dayCount > 0 ? (totalRecentSales / dayCount) * 7 : 0;

      // Group recent sales by Monday-week for trend
      const byWeek = {};
      recentSales.forEach((e) => {
        const wk = mondayOfWeek(new Date(e.date + 'T00:00:00'));
        byWeek[wk] = (byWeek[wk] || 0) + (e.sales || 0);
      });
      const weeks = Object.keys(byWeek).sort();
      let trendSlope = 0, trendIntercept = avgWeeklySales;
      if (weeks.length >= 2) {
        const xs = weeks.map((_, i) => i);
        const ys = weeks.map((w) => byWeek[w]);
        const n = xs.length;
        const sumX = xs.reduce((s, x) => s + x, 0);
        const sumY = ys.reduce((s, y) => s + y, 0);
        const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
        const sumX2 = xs.reduce((s, x) => s + x * x, 0);
        const denom = n * sumX2 - sumX * sumX;
        if (denom !== 0) {
          trendSlope = (n * sumXY - sumX * sumY) / denom;
          trendIntercept = (sumY - trendSlope * sumX) / n;
        }
      }

      const recentFood = sib.food.filter((p) => p.date >= cutoff);
      const totalRecentFood = recentFood.reduce((s, p) => s + (p.amount || 0), 0);
      const foodCostPctAuto = totalRecentSales > 0 ? (totalRecentFood / totalRecentSales) * 100 : 30;

      return {
        avgWeeklySales,
        trendSlope, trendIntercept,
        weekCount: weeks.length,
        foodCostPct: foodCostPctAuto,
        weeklyLabor: Number(sib.pl.labor) || 0,
        weeklyOther: Number(sib.pl.other) || 0,
        hasSales: recentSales.length > 0,
      };
    }, [sib]);

    // Build the forecast
    const forecast = useMemo(() => {
      const startMon = mondayOfWeek(new Date());
      const weeks = state.forecastWeeks;
      const horizonEnd = addDays(startMon, weeks * 7 - 1);

      // Bucket bills by week (only unpaid; overdue lumped into week 0)
      const today = todayISO();
      const billsByWeek = {};
      const overdueBills = [];
      sib.bills.forEach((b) => {
        if (b.paid) return;
        if (!b.dueDate) return;
        if (b.dueDate < today) {
          overdueBills.push(b);
          return;
        }
        if (b.dueDate > horizonEnd) return;
        const wk = mondayOfWeek(new Date(b.dueDate + 'T00:00:00'));
        if (!billsByWeek[wk]) billsByWeek[wk] = [];
        billsByWeek[wk].push(b);
      });
      const overdueAmount = overdueBills.reduce((s, b) => s + (b.amount || 0), 0);

      const out = [];
      let bal = Number(state.startingCash) || 0;
      const startBal = bal;

      for (let w = 0; w < weeks; w++) {
        const weekStart = addDays(startMon, w * 7);
        let projSales;
        if (state.salesMode === 'trend' && baseline.weekCount >= 2) {
          const futureIdx = baseline.weekCount + w;
          projSales = Math.max(0, baseline.trendIntercept + baseline.trendSlope * futureIdx);
        } else {
          projSales = baseline.avgWeeklySales;
        }
        const foodCost = projSales * (baseline.foodCostPct / 100);
        const billsThisWeek = billsByWeek[weekStart] || [];
        let billsAmount = billsThisWeek.reduce((s, b) => s + (b.amount || 0), 0);
        if (w === 0) billsAmount += overdueAmount;
        const totalOut = foodCost + baseline.weeklyLabor + baseline.weeklyOther + billsAmount;
        const net = projSales - totalOut;
        bal += net;
        out.push({
          week: w + 1,
          weekStart,
          inflows: projSales,
          foodCost,
          labor: baseline.weeklyLabor,
          other: baseline.weeklyOther,
          bills: billsAmount,
          billsList: billsThisWeek,
          totalOut, net, balance: bal,
          hasOverdue: w === 0 && overdueAmount > 0,
          overdueAmount: w === 0 ? overdueAmount : 0,
        });
      }
      return { startBal, weeks: out, overdueAmount };
    }, [state, baseline, sib.bills]);

    const dangerWeek = forecast.weeks.find((w) => w.balance < 0);
    const minBal = forecast.weeks.reduce((m, w) => Math.min(m, w.balance), forecast.startBal);
    const endBal = forecast.weeks.length > 0 ? forecast.weeks[forecast.weeks.length - 1].balance : forecast.startBal;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Controls */}
        <div className="p-row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="p-row" style={{ gap: 3, alignItems: 'center' }}>
            <span className="p-label" style={{ fontSize: 9 }}>cash now</span>
            <input
              type="number" step="100"
              placeholder="bank balance"
              value={state.startingCash || ''}
              onChange={(e) => setState({ ...state, startingCash: parseFloat(e.target.value) || 0 })}
              className="p-input"
              style={{ fontSize: 11, width: 100, padding: '2px 4px' }}
              title="current bank account balance"
            />
          </div>

          <div
            style={{
              display: 'inline-flex', border: '1px solid var(--border-bright)',
              borderRadius: 3, overflow: 'hidden',
            }}
            title="how to project future weekly sales"
          >
            {[{ id: 'avg', label: 'flat' }, { id: 'trend', label: 'trend' }].map((m) => {
              const active = state.salesMode === m.id;
              const disabled = m.id === 'trend' && baseline.weekCount < 2;
              return (
                <button
                  key={m.id}
                  onClick={() => !disabled && setState({ ...state, salesMode: m.id })}
                  disabled={disabled}
                  title={
                    m.id === 'trend'
                      ? (disabled
                          ? 'need ≥2 weeks of sales for trend'
                          : 'linear regression across ' + baseline.weekCount + ' historical weeks')
                      : 'flat average of recent days'
                  }
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none', padding: '2px 8px',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.4 : 1,
                  }}
                >{m.label}</button>
              );
            })}
          </div>

          <div
            style={{
              display: 'inline-flex', border: '1px solid var(--border-bright)',
              borderRadius: 3, overflow: 'hidden',
            }}
          >
            {[4, 8].map((w) => {
              const active = state.forecastWeeks === w;
              return (
                <button
                  key={w}
                  onClick={() => setState({ ...state, forecastWeeks: w })}
                  style={{
                    background: active ? 'var(--accent-warm)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none', padding: '2px 8px',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    fontWeight: active ? 700 : 400, cursor: 'pointer',
                  }}
                >{w}wk</button>
              );
            })}
          </div>

          <span style={{ flex: 1 }} />

          {dangerWeek ? (
            <span style={{ color: 'var(--danger)', fontSize: 10, fontFamily: 'var(--mono)' }}>
              ▲ negative wk {dangerWeek.week} ({fmtMoneyShort(dangerWeek.balance)})
            </span>
          ) : forecast.weeks.length > 0 && (
            <span style={{ color: 'var(--accent)', fontSize: 10, fontFamily: 'var(--mono)' }}>
              min {fmtMoneyShort(minBal)} · end {fmtMoneyShort(endBal)}
            </span>
          )}
        </div>

        {/* Chart + table */}
        <div className="p-row" style={{ flex: 1, gap: 8, minHeight: 0 }}>
          <Chart weeks={forecast.weeks} startBal={forecast.startBal} />
          <Table weeks={forecast.weeks} />
        </div>

        {/* Assumptions footer */}
        <div
          className="p-row"
          style={{
            fontSize: 9, gap: 10, fontFamily: 'var(--mono)',
            borderTop: '1px solid var(--border)', paddingTop: 4,
            color: 'var(--fg-dim)', flexWrap: 'wrap',
          }}
        >
          <span>
            sales <span style={{ color: 'var(--fg)' }}>{fmtMoneyShort(baseline.avgWeeklySales)}/wk</span>
            {state.salesMode === 'trend' && baseline.weekCount >= 2 && baseline.trendSlope !== 0 && (
              <span style={{ color: baseline.trendSlope > 0 ? 'var(--accent)' : 'var(--danger)' }}>
                {' '}({baseline.trendSlope > 0 ? '+' : ''}{fmtMoneyShort(baseline.trendSlope)}/wk)
              </span>
            )}
          </span>
          <span>food <span style={{ color: 'var(--fg)' }}>{baseline.foodCostPct.toFixed(1)}%</span></span>
          <span>labor <span style={{ color: 'var(--fg)' }}>{fmtMoneyShort(baseline.weeklyLabor)}</span></span>
          <span>other <span style={{ color: 'var(--fg)' }}>{fmtMoneyShort(baseline.weeklyOther)}</span></span>
          {forecast.overdueAmount > 0 && (
            <span style={{ color: 'var(--danger)' }}>
              overdue <span style={{ fontWeight: 700 }}>{fmtMoneyShort(forecast.overdueAmount)}</span>
              <span className="p-dim"> (in wk 1)</span>
            </span>
          )}
          {!baseline.hasSales && (
            <span style={{ color: 'var(--accent-warm)' }}>
              ⚠ no sales data — install daily sales for realistic projections
            </span>
          )}
        </div>
      </div>
    );
  },
};

function Chart({ weeks, startBal }) {
  if (weeks.length === 0) return null;
  const W = 320, H = 160, PL = 38, PR = 8, PT = 10, PB = 18;
  const balances = [startBal, ...weeks.map((w) => w.balance)];
  const rawMax = Math.max(...balances, 0);
  const rawMin = Math.min(...balances, 0);
  const padRange = Math.max(100, (rawMax - rawMin) * 0.12);
  const yMax = rawMax + padRange;
  const yMin = rawMin - padRange;
  const range = yMax - yMin || 1;

  const yFor = (v) => H - PB - ((v - yMin) / range) * (H - PT - PB);
  const stepX = (W - PL - PR) / Math.max(1, weeks.length);
  const xFor = (i) => PL + i * stepX;
  const zeroY = yFor(0);

  const points = balances.map((b, i) => ({ x: xFor(i), y: yFor(b), v: b }));
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ' ' + p.y).join(' ');
  const fillPath =
    linePath +
    ' L ' + points[points.length - 1].x + ' ' + zeroY +
    ' L ' + points[0].x + ' ' + zeroY + ' Z';

  return (
    <div className="p-col" style={{ flex: 1, minWidth: 0, minHeight: 0, gap: 2 }}>
      <div className="p-label" style={{ fontSize: 9 }}>weekly cash position</div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <svg
          viewBox={'0 0 ' + W + ' ' + H}
          preserveAspectRatio="none"
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.22)',
            border: '1px solid var(--border)', borderRadius: 3,
          }}
        >
          {/* Frame */}
          <rect x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} fill="none" stroke="var(--border-bright)" strokeWidth="0.5" />
          {/* Zero line */}
          {yMin < 0 && yMax > 0 && (
            <>
              <line x1={PL} y1={zeroY} x2={W - PR} y2={zeroY} stroke="var(--danger)" strokeDasharray="3 3" strokeWidth="0.8" />
              <text x={PL - 2} y={zeroY + 3} fontSize="7" fill="var(--danger)" fontFamily="monospace" textAnchor="end">$0</text>
            </>
          )}
          {/* Fill area */}
          <path d={fillPath} fill="rgba(var(--accent-rgb),0.10)" />
          {/* Line */}
          <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
          {/* Points */}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x} cy={p.y} r={i === 0 ? 2.5 : 3}
              fill={i === 0 ? 'var(--fg-dim)' : (p.v < 0 ? 'var(--danger)' : 'var(--accent)')}
              stroke={i === 0 ? 'var(--fg-dim)' : (p.v < 0 ? 'var(--danger)' : 'var(--accent)')}
            >
              <title>{(i === 0 ? 'now' : 'wk ' + i) + ': ' + fmtMoney(p.v)}</title>
            </circle>
          ))}
          {/* Y labels */}
          <text x={PL - 2} y={PT + 5} fontSize="8" fill="var(--fg-dim)" fontFamily="monospace" textAnchor="end">{fmtMoneyShort(yMax)}</text>
          <text x={PL - 2} y={H - PB + 1} fontSize="8" fill="var(--fg-dim)" fontFamily="monospace" textAnchor="end">{fmtMoneyShort(yMin)}</text>
          {/* X labels */}
          <text x={PL} y={H - 4} fontSize="7" fill="var(--fg-dim)" fontFamily="monospace" textAnchor="start">now</text>
          <text x={W - PR} y={H - 4} fontSize="7" fill="var(--fg-dim)" fontFamily="monospace" textAnchor="end">+{weeks.length}wk</text>
        </svg>
      </div>
    </div>
  );
}

function Table({ weeks }) {
  if (weeks.length === 0) return null;
  return (
    <div className="p-col" style={{ flex: '0 0 200px', minHeight: 0, gap: 2 }}>
      <div className="p-label" style={{ fontSize: 9 }}>by week</div>
      <div
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          border: '1px solid var(--border)', borderRadius: 3,
          fontFamily: 'var(--mono)', fontSize: 10,
        }}
      >
        {weeks.map((w) => (
          <div
            key={w.weekStart}
            style={{
              padding: '4px 6px',
              borderBottom: '1px solid var(--border)',
              borderLeft: '3px solid ' + (w.balance < 0 ? 'var(--danger)' : 'var(--accent)'),
              background: 'rgba(255,255,255,0.012)',
            }}
            title={
              'inflows ' + fmtMoney(w.inflows) +
              '\n- food ' + fmtMoney(w.foodCost) +
              '\n- labor ' + fmtMoney(w.labor) +
              '\n- other ' + fmtMoney(w.other) +
              '\n- bills ' + fmtMoney(w.bills) +
              (w.billsList.length > 0 ? '\n  ' + w.billsList.map((b) => b.vendor + ': ' + fmtMoney(b.amount)).join('\n  ') : '') +
              '\n= net ' + fmtMoney(w.net) +
              '\n= balance ' + fmtMoney(w.balance)
            }
          >
            <div className="p-row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="p-dim" style={{ fontSize: 9 }}>
                wk{w.week} · {w.weekStart.slice(5)}
              </span>
              <span
                style={{
                  color: w.balance < 0 ? 'var(--danger)' : 'var(--accent)',
                  fontWeight: 700,
                }}
              >{fmtMoneyShort(w.balance)}</span>
            </div>
            <div className="p-row" style={{ fontSize: 9, gap: 4, marginTop: 1, justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--accent)' }}>+{fmtMoneyShort(w.inflows)}</span>
              <span style={{ color: 'var(--danger)' }}>-{fmtMoneyShort(w.totalOut)}</span>
              {(w.bills > 0 || w.hasOverdue) && (
                <span className="p-dim">
                  {w.billsList.length > 0 ? w.billsList.length + ' bill' + (w.billsList.length === 1 ? '' : 's') : ''}
                  {w.hasOverdue ? (w.billsList.length > 0 ? ' + overdue' : 'overdue') : ''}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
