// Tip Pool & Payroll Helper — split a tip pool by hours worked.
// Pool $ auto-pulls from the Daily Sales Logger's `tips` field for the
// selected date if available; you can always override it. Staff roster
// persists across days so you only enter names once.

const KEY = 'plugin:tip-pool:state:v1';
const SALES_KEY = 'plugin:daily-sales:entries:v1';

const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);

export default {
  id: 'tip-pool',
  name: 'Tip Pool',
  width: 2,
  height: 2,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [state, setState] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && typeof raw === 'object') {
          return { date: todayISO(), poolOverride: '', staff: [], ...raw };
        }
      } catch (e) {}
      return { date: todayISO(), poolOverride: '', staff: [] };
    });

    const [tick, setTick] = useState(0);
    const [confirmDel, setConfirmDel] = useState(null);
    const confirmTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    }, [state]);

    // Re-pull from Daily Sales periodically.
    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), 5000);
      return () => clearInterval(id);
    }, []);

    const autoTips = useMemo(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(SALES_KEY));
        if (Array.isArray(raw)) {
          const entry = raw.find((e) => e.date === state.date);
          return entry ? (entry.tips || 0) : null;
        }
      } catch (e) {}
      return null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.date, tick]);

    const pool = useMemo(() => {
      if (state.poolOverride !== '' && state.poolOverride != null) {
        return Math.max(0, parseFloat(state.poolOverride) || 0);
      }
      return autoTips || 0;
    }, [state.poolOverride, autoTips]);

    const totalHours = useMemo(
      () => state.staff.reduce((s, p) => s + (Number(p.hours) || 0), 0),
      [state.staff]
    );

    const splits = useMemo(() => {
      if (totalHours === 0) return state.staff.map((p) => ({ ...p, share: 0 }));
      return state.staff.map((p) => ({
        ...p,
        share: ((Number(p.hours) || 0) / totalHours) * pool,
      }));
    }, [state.staff, totalHours, pool]);

    const updateStaff = (id, key, value) => {
      setState({
        ...state,
        staff: state.staff.map((p) => (p.id === id ? { ...p, [key]: value } : p)),
      });
    };
    const addStaff = () => {
      setState({
        ...state,
        staff: [...state.staff, { id: Date.now() + Math.random(), name: '', hours: '' }],
      });
    };
    const removeStaff = (id) => {
      if (confirmDel === id) {
        setState({ ...state, staff: state.staff.filter((p) => p.id !== id) });
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };
    const clearHours = () => {
      setState({
        ...state,
        staff: state.staff.map((p) => ({ ...p, hours: '' })),
        poolOverride: '',
      });
    };

    const linked = autoTips != null && state.poolOverride === '';
    const totalAllocated = splits.reduce((s, p) => s + p.share, 0);
    const remainder = pool - totalAllocated;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Date + pool input */}
        <div className="p-col" style={{ gap: 4 }}>
          <div className="p-row" style={{ gap: 4 }}>
            <input
              type="date"
              value={state.date}
              onChange={(e) => setState({ ...state, date: e.target.value })}
              className="p-input"
              style={{ fontSize: 11, flex: 1, minWidth: 0 }}
            />
            <input
              type="number" step="0.01" min="0"
              placeholder={autoTips != null ? 'auto ' + fmtMoney(autoTips) : 'pool $'}
              value={state.poolOverride}
              onChange={(e) => setState({ ...state, poolOverride: e.target.value })}
              className="p-input"
              style={{ fontSize: 11, flex: 1, minWidth: 0 }}
              title={autoTips != null ? 'pulled from daily sales — type to override' : 'enter total tips'}
            />
          </div>
          <div className="p-row" style={{ alignItems: 'baseline', gap: 6 }}>
            <span className="p-label">pool</span>
            <span
              style={{
                fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700,
                color: pool > 0 ? 'var(--accent)' : 'var(--fg-dim)',
                textShadow: pool > 0 ? '0 0 6px var(--accent)' : 'none',
                lineHeight: 1,
              }}
            >{fmtMoney(pool)}</span>
            <span style={{ flex: 1 }} />
            {linked && (
              <span style={{ fontSize: 9, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>● linked</span>
            )}
            {!linked && autoTips != null && (
              <span className="p-dim" style={{ fontSize: 9 }}>override (auto: {fmtMoney(autoTips)})</span>
            )}
          </div>
        </div>

        {/* Staff list */}
        <div
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 3,
          }}
        >
          {state.staff.length === 0 ? (
            <div className="p-dim" style={{ fontSize: 10, padding: 8, textAlign: 'center' }}>
              add staff below to split the pool
            </div>
          ) : splits.map((p) => {
            const isConfirming = confirmDel === p.id;
            const pct = totalHours > 0 ? ((Number(p.hours) || 0) / totalHours) * 100 : 0;
            return (
              <div
                key={p.id}
                style={{
                  padding: '3px 4px',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: 4,
                  background: 'rgba(255,255,255,0.015)',
                }}
              >
                <input
                  type="text"
                  placeholder="name"
                  value={p.name}
                  onChange={(e) => updateStaff(p.id, 'name', e.target.value)}
                  className="p-input"
                  style={{ fontSize: 10, flex: 1, minWidth: 0, padding: '1px 4px' }}
                />
                <input
                  type="number" step="0.25" min="0"
                  placeholder="hrs"
                  value={p.hours}
                  onChange={(e) => updateStaff(p.id, 'hours', e.target.value)}
                  className="p-input"
                  style={{ fontSize: 10, width: 44, padding: '1px 4px', textAlign: 'right' }}
                  title={pct > 0 ? pct.toFixed(0) + '% of hours' : ''}
                />
                <span
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
                    color: p.share > 0 ? 'var(--accent)' : 'var(--fg-dim)',
                    width: 64, textAlign: 'right',
                  }}
                >{fmtMoney(p.share)}</span>
                <button
                  onClick={() => removeStaff(p.id)}
                  title={isConfirming ? 'click to confirm' : 'remove'}
                  style={{
                    background: 'transparent',
                    border: '1px solid ' + (isConfirming ? 'var(--danger)' : 'transparent'),
                    color: isConfirming ? 'var(--danger)' : 'var(--fg-dim)',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    padding: '0 4px', cursor: 'pointer', borderRadius: 2,
                  }}
                >{isConfirming ? '✓?' : '×'}</button>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-row" style={{ gap: 4, alignItems: 'center', fontSize: 9 }}>
          <button
            className="p-btn"
            onClick={addStaff}
            style={{ fontSize: 10, padding: '2px 8px' }}
          >+ staff</button>
          <span style={{ flex: 1 }} />
          {state.staff.length > 0 && (
            <span className="p-dim" style={{ fontFamily: 'var(--mono)' }}>
              {totalHours.toFixed(1)} hrs ·{' '}
              {Math.abs(remainder) < 0.01 ? (
                <span style={{ color: pool > 0 ? 'var(--accent)' : 'var(--fg-dim)' }}>balanced</span>
              ) : (
                <span style={{ color: 'var(--accent-warm)' }}>
                  {fmtMoney(Math.abs(remainder))} {remainder > 0 ? 'unsplit' : 'over'}
                </span>
              )}
            </span>
          )}
          {state.staff.length > 0 && (
            <button
              onClick={clearHours}
              title="clear hours and pool override (keep names)"
              style={{
                background: 'transparent',
                border: '1px solid var(--border-bright)',
                color: 'var(--fg-dim)',
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '1px 6px', cursor: 'pointer', borderRadius: 2,
                letterSpacing: '0.05em',
              }}
            >reset hrs</button>
          )}
        </div>
      </div>
    );
  },
};
