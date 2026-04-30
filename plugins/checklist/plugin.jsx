// Daily Open/Close Checklist — defaults loaded with sensible restaurant
// open/close tasks; edit the lists, check off as you go. History persists
// per-day so the 7-day strip at the bottom shows whether closes have been
// getting skipped. A warm-amber banner at the top flags last night's close
// if it was incomplete — the cheapest possible "freezer left unplugged"
// catch.

const KEY = 'plugin:checklist:v1';

const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};
const isoDaysAgo = (n) => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  d.setDate(d.getDate() - n);
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

const DEFAULTS = {
  opening: [
    'Turn on lights & unlock front',
    'Check walk-in & reach-in temps (log if abnormal)',
    'Count opening cash drawer',
    'Light pilots / preheat ovens & fryers',
    'Brew coffee, prep beverage station',
    'Check ice machine',
    'Bathroom check + restock',
    'Sweep, set tables, wipe surfaces',
  ],
  closing: [
    'Count & secure cash drawer · drop deposit',
    'Wrap, label, date all open product',
    'Wipe down all stations & surfaces',
    'Run final dishwasher load',
    'Re-check walk-in & reach-in temps',
    'Empty all trash, break down boxes',
    'Sweep & mop floors',
    'Turn off equipment (ovens, fryers, vents)',
    'Lock back door · set alarm',
  ],
};

const seedTasks = (mode) =>
  DEFAULTS[mode].map((name, i) => ({ id: mode + '-seed-' + i, name }));

export default {
  id: 'checklist',
  name: 'Daily Checklist',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [data, setData] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && typeof raw === 'object' && raw.tasks) {
          return { history: {}, ...raw };
        }
      } catch (e) {}
      return {
        tasks: { opening: seedTasks('opening'), closing: seedTasks('closing') },
        history: {},
      };
    });

    const [mode, setMode] = useState('opening');
    const [editing, setEditing] = useState(false);
    const [newTask, setNewTask] = useState('');
    const [confirmDel, setConfirmDel] = useState(null);
    const confirmTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    }, [data]);

    const today = todayISO();
    const todayHistory = data.history[today] || {};
    const tasks = data.tasks[mode] || [];
    const completed = (todayHistory[mode] && todayHistory[mode].completed) || {};

    const toggleTask = (taskId) => {
      const cur = (todayHistory[mode] && todayHistory[mode].completed) || {};
      const next = { ...cur };
      if (next[taskId]) delete next[taskId];
      else next[taskId] = new Date().toISOString();
      setData({
        ...data,
        history: {
          ...data.history,
          [today]: {
            ...todayHistory,
            [mode]: { completed: next },
          },
        },
      });
    };

    const addTask = () => {
      const name = newTask.trim();
      if (!name) return;
      const newId = mode + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      setData({
        ...data,
        tasks: {
          ...data.tasks,
          [mode]: [...(data.tasks[mode] || []), { id: newId, name }],
        },
      });
      setNewTask('');
    };

    const removeTask = (id) => {
      if (confirmDel === id) {
        setData({
          ...data,
          tasks: {
            ...data.tasks,
            [mode]: data.tasks[mode].filter((t) => t.id !== id),
          },
        });
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };

    const completedCount = tasks.filter((t) => completed[t.id]).length;
    const pct = tasks.length > 0 ? (completedCount / tasks.length) * 100 : 0;

    // Last 7 days strip — count tasks completed against current task ids
    // (so removing/adding tasks doesn't break old history's denominator).
    const last7 = useMemo(() => {
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const iso = isoDaysAgo(i);
        const h = data.history[iso] || {};
        const opTasks = data.tasks.opening.length;
        const clTasks = data.tasks.closing.length;
        const opIds = new Set(data.tasks.opening.map((t) => t.id));
        const clIds = new Set(data.tasks.closing.map((t) => t.id));
        const opDone = Object.keys((h.opening && h.opening.completed) || {}).filter((id) => opIds.has(id)).length;
        const clDone = Object.keys((h.closing && h.closing.completed) || {}).filter((id) => clIds.has(id)).length;
        const total = opTasks + clTasks;
        const done = opDone + clDone;
        days.push({
          date: iso,
          pct: total > 0 ? (done / total) * 100 : 0,
        });
      }
      return days;
    }, [data]);

    // Yesterday's closing — flag if incomplete and we haven't acknowledged it
    const yesterdayClose = useMemo(() => {
      const iso = isoDaysAgo(1);
      const h = data.history[iso] || {};
      const ids = new Set(data.tasks.closing.map((t) => t.id));
      const done = Object.keys((h.closing && h.closing.completed) || {}).filter((id) => ids.has(id)).length;
      const total = data.tasks.closing.length;
      return {
        date: iso,
        done, total,
        pct: total > 0 ? (done / total) * 100 : 0,
      };
    }, [data]);

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Tabs + edit */}
        <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
          <div
            style={{
              display: 'inline-flex', border: '1px solid var(--border-bright)',
              borderRadius: 3, overflow: 'hidden',
            }}
          >
            {[{ id: 'opening', label: 'open' }, { id: 'closing', label: 'close' }].map((t) => {
              const active = mode === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => { setMode(t.id); setConfirmDel(null); }}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none', padding: '2px 14px',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400, cursor: 'pointer',
                  }}
                >{t.label}</button>
              );
            })}
          </div>
          <span style={{ flex: 1 }} />
          <span className="p-dim" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>
            {today.slice(5)}
          </span>
          <button
            onClick={() => setEditing(!editing)}
            title={editing ? 'finish editing list' : 'edit task list'}
            style={{
              background: editing ? 'var(--accent-warm)' : 'transparent',
              color: editing ? 'var(--bg)' : 'var(--fg-dim)',
              border: '1px solid var(--border-bright)',
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '1px 6px', cursor: 'pointer', borderRadius: 2,
              letterSpacing: '0.1em', textTransform: 'uppercase',
              fontWeight: editing ? 700 : 400,
            }}
          >{editing ? 'done' : 'edit'}</button>
        </div>

        {/* Progress bar */}
        <div className="p-col" style={{ gap: 2 }}>
          <div className="p-row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span className="p-label" style={{ fontSize: 9 }}>{mode} progress</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--fg)' }}>
              {completedCount}/{tasks.length} · {pct.toFixed(0)}%
            </span>
          </div>
          <div
            style={{
              height: 6, borderRadius: 2,
              background: 'rgba(255,255,255,0.05)',
              overflow: 'hidden',
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                height: '100%', width: pct + '%',
                background: pct >= 100 ? 'var(--accent)' : 'var(--accent-warm)',
                boxShadow: pct >= 100 ? '0 0 6px var(--accent)' : 'none',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>

        {/* Yesterday warning */}
        {!editing && yesterdayClose.total > 0 && yesterdayClose.pct < 100 && (
          <div
            style={{
              padding: '4px 6px',
              border: '1px dashed var(--accent-warm)',
              borderRadius: 3,
              color: 'var(--accent-warm)',
              fontSize: 10, fontFamily: 'var(--mono)',
            }}
          >
            ⚠ last night's close was {yesterdayClose.pct.toFixed(0)}% complete ({yesterdayClose.done}/{yesterdayClose.total})
          </div>
        )}

        {/* Task list */}
        <div
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 3,
          }}
        >
          {tasks.length === 0 ? (
            <div className="p-dim" style={{ fontSize: 11, padding: 8, textAlign: 'center' }}>
              no {mode} tasks. {editing ? 'add some below.' : 'click edit to add some.'}
            </div>
          ) : tasks.map((task) => {
            const done = !!completed[task.id];
            const doneAt = completed[task.id];
            const isConfirming = confirmDel === task.id;
            return (
              <div
                key={task.id}
                style={{
                  padding: '4px 6px',
                  borderBottom: '1px solid var(--border)',
                  background: done ? 'rgba(var(--accent-rgb),0.05)' : 'transparent',
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 11, fontFamily: 'var(--mono)',
                }}
              >
                <button
                  onClick={() => toggleTask(task.id)}
                  title={done ? 'mark undone' : 'mark done'}
                  style={{
                    width: 18, height: 18, padding: 0, flexShrink: 0,
                    background: done ? 'var(--accent)' : 'transparent',
                    border: '1px solid ' + (done ? 'var(--accent)' : 'var(--border-bright)'),
                    borderRadius: 3, cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1,
                    color: done ? 'var(--bg)' : 'var(--fg-dim)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >{done ? '✓' : ''}</button>
                <span
                  style={{
                    flex: 1, minWidth: 0,
                    color: done ? 'var(--fg-dim)' : 'var(--fg)',
                    textDecoration: done ? 'line-through' : 'none',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  title={task.name}
                >{task.name}</span>
                {done && doneAt && (
                  <span className="p-dim" style={{ fontSize: 9, flexShrink: 0 }}>
                    {new Date(doneAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                {editing && (
                  <button
                    onClick={() => removeTask(task.id)}
                    title={isConfirming ? 'click to confirm' : 'remove task from list'}
                    style={{
                      background: 'transparent',
                      border: '1px solid ' + (isConfirming ? 'var(--danger)' : 'transparent'),
                      color: isConfirming ? 'var(--danger)' : 'var(--fg-dim)',
                      fontFamily: 'var(--mono)', fontSize: 10,
                      padding: '0 5px', cursor: 'pointer', borderRadius: 2, flexShrink: 0,
                    }}
                  >{isConfirming ? '✓?' : '×'}</button>
                )}
              </div>
            );
          })}
        </div>

        {/* Add task — only in edit mode */}
        {editing && (
          <div className="p-row" style={{ gap: 3 }}>
            <input
              type="text"
              placeholder={'new ' + mode + ' task'}
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }}
              className="p-input"
              style={{ fontSize: 11, flex: 1, minWidth: 0 }}
            />
            <button
              className="p-btn"
              onClick={addTask}
              style={{ fontSize: 11, padding: '2px 10px' }}
            >+ task</button>
          </div>
        )}

        {/* 7-day history */}
        {!editing && (
          <div className="p-col" style={{ gap: 2 }}>
            <div
              className="p-row"
              style={{ alignItems: 'baseline', justifyContent: 'space-between' }}
            >
              <span className="p-label" style={{ fontSize: 9 }}>last 7 days</span>
              <span className="p-dim" style={{ fontSize: 9, fontFamily: 'var(--mono)' }}>
                open + close combined
              </span>
            </div>
            <div className="p-row" style={{ gap: 2, alignItems: 'flex-end', height: 22 }}>
              {last7.map((d, i) => (
                <div
                  key={d.date}
                  title={d.date + ': ' + d.pct.toFixed(0) + '%' + (i === 6 ? ' (today)' : '')}
                  style={{
                    flex: 1, position: 'relative', height: '100%',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid ' + (i === 6 ? 'var(--border-bright)' : 'var(--border)'),
                    borderRadius: 1,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute', bottom: 0, left: 0, right: 0,
                      height: d.pct + '%',
                      background:
                        d.pct >= 100 ? 'var(--accent)'
                          : d.pct >= 50 ? 'var(--accent-warm)'
                          : d.pct > 0 ? 'var(--danger)'
                          : 'transparent',
                      opacity: 0.75,
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  },
};
