// Calendar / Agenda — month grid + agenda for the selected day, with
// optional .ics file import.
//
// • Click any day to select it. Today is outlined; selected is filled.
//   Days with events show up to 3 colored dots; "+N" if more.
// • + add event creates a manual event for the selected day. Title required;
//   time, location, notes optional.
// • ↓ import lets you pick an .ics file. Single-occurrence events and basic
//   RRULE (DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL, plus BYDAY
//   for WEEKLY) are expanded. Re-importing the same file replaces its events.
//
// Storage: localStorage. Each event: { id, title, date, time?, location?,
//   notes?, color, source, rrule? } — source is 'manual' or 'ics:<filename>'.

const KEY = 'plugin:calendar-agenda:state:v1';

const DAY_NAMES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const COLORS = {
  green:  'var(--accent)',
  amber:  'var(--accent-warm)',
  pink:   '#ff6bd6',
  cyan:   '#5eeaff',
  red:    'var(--danger)',
};
const COLOR_KEYS = Object.keys(COLORS);

// ---- date helpers ----
const ymd = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
};
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const sameYmd = (a, b) => a === b;
// ISO weekday: Mon=0 ... Sun=6
const isoDow = (date) => (date.getDay() + 6) % 7;

// ---- ICS parsing ----
const unescapeText = (s) =>
  s.replace(/\\([\\,;nN])/g, (_, c) => (c.toLowerCase() === 'n' ? '\n' : c));

const parseICSDate = (value, params) => {
  const isUTC = value.endsWith('Z');
  const dateOnly = params && params.VALUE === 'DATE';
  const v = value.replace(/Z$/, '');
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return null;
  const [_, yr, mo, da, hh, mm, ss] = m;
  if (dateOnly || !hh) {
    return { date: yr + '-' + mo + '-' + da, dateOnly: true };
  }
  let dt;
  if (isUTC) dt = new Date(Date.UTC(+yr, +mo - 1, +da, +hh, +mm, +ss));
  else dt = new Date(+yr, +mo - 1, +da, +hh, +mm, +ss);
  return {
    date: ymd(dt),
    time: String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'),
    dateOnly: false,
  };
};

const parseRRULE = (value) => {
  const out = {};
  for (const p of value.split(';')) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    out[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return out;
};

const parseICS = (text) => {
  // Unfold continuation lines (RFC 5545: any line starting with space or tab)
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else lines.push(raw);
  }
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.summary && cur.dtstart) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const head = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const semiIdx = head.indexOf(';');
    const name = (semiIdx === -1 ? head : head.slice(0, semiIdx)).toUpperCase();
    const params = {};
    if (semiIdx !== -1) {
      for (const p of head.slice(semiIdx + 1).split(';')) {
        const eq = p.indexOf('=');
        if (eq === -1) continue;
        params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
      }
    }
    if (name === 'SUMMARY') cur.summary = unescapeText(value);
    else if (name === 'DESCRIPTION') cur.description = unescapeText(value);
    else if (name === 'LOCATION') cur.location = unescapeText(value);
    else if (name === 'UID') cur.uid = value;
    else if (name === 'DTSTART') cur.dtstart = parseICSDate(value, params);
    else if (name === 'DTEND') cur.dtend = parseICSDate(value, params);
    else if (name === 'RRULE') cur.rrule = parseRRULE(value);
  }
  return events;
};

// ---- recurrence expansion ----
// Returns Map<ymdString, Array<EventOccurrence>> for the inclusive [from, to] range.
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const expandEventInRange = (event, fromDate, toDate, push) => {
  const start = parseYmd(event.date);
  if (!event.rrule) {
    if (start >= fromDate && start <= toDate) push(event.date, event);
    return;
  }
  const r = event.rrule;
  const freq = String(r.FREQ || '').toUpperCase();
  const interval = parseInt(r.INTERVAL, 10) || 1;
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  let until = null;
  if (r.UNTIL) {
    const m = String(r.UNTIL).match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) until = new Date(+m[1], +m[2] - 1, +m[3]);
  }
  const SAFETY = 1000;

  if (freq === 'WEEKLY' && r.BYDAY) {
    const dows = r.BYDAY.split(',')
      .map((s) => WEEKDAY_CODES.indexOf(s.toUpperCase().slice(-2)))
      .filter((i) => i >= 0);
    if (!dows.length) return;
    let weekAnchor = new Date(start);
    weekAnchor.setDate(weekAnchor.getDate() - weekAnchor.getDay()); // Sunday
    let emitted = 0;
    for (let i = 0; i < SAFETY && emitted < count; i++) {
      for (const dow of dows) {
        const occ = new Date(weekAnchor);
        occ.setDate(occ.getDate() + dow);
        if (occ < start) continue;
        if (until && occ > until) return;
        if (occ > toDate) return;
        if (occ >= fromDate) push(ymd(occ), event);
        emitted++;
        if (emitted >= count) return;
      }
      weekAnchor.setDate(weekAnchor.getDate() + 7 * interval);
    }
    return;
  }

  let cur = new Date(start);
  let emitted = 0;
  for (let i = 0; i < SAFETY && emitted < count; i++) {
    if (until && cur > until) return;
    if (cur > toDate) return;
    if (cur >= fromDate) push(ymd(cur), event);
    emitted++;
    if (freq === 'DAILY') cur.setDate(cur.getDate() + interval);
    else if (freq === 'WEEKLY') cur.setDate(cur.getDate() + 7 * interval);
    else if (freq === 'MONTHLY') cur.setMonth(cur.getMonth() + interval);
    else if (freq === 'YEARLY') cur.setFullYear(cur.getFullYear() + interval);
    else return;
  }
};

const eventsByDay = (events, fromYmd, toYmd) => {
  const fromDate = parseYmd(fromYmd);
  const toDate = parseYmd(toYmd);
  const map = new Map();
  const push = (k, ev) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(ev);
  };
  for (const ev of events) expandEventInRange(ev, fromDate, toDate, push);
  return map;
};

const sortAgenda = (a, b) => {
  const at = a.time || '';
  const bt = b.time || '';
  if (at && bt) return at.localeCompare(bt);
  if (at) return -1;
  if (bt) return 1;
  return a.title.localeCompare(b.title);
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object' && Array.isArray(raw.events)) return raw;
  } catch {}
  return { events: [], selectedDate: ymd(new Date()) };
};

const newId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export default {
  id: 'calendar-agenda',
  name: 'Calendar',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [state, setState] = useState(loadState);
    const today = useMemo(() => ymd(new Date()), []);
    const [view, setView] = useState(() => {
      const sel = parseYmd(state.selectedDate || today);
      return { year: sel.getFullYear(), month: sel.getMonth() };
    });
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState(null); // event id or null
    const [draft, setDraft] = useState({ title: '', time: '', location: '', notes: '', color: 'green' });
    const [confirmId, setConfirmId] = useState(null);
    const [error, setError] = useState(null);
    const [info, setInfo] = useState(null);
    const confirmTimer = useRef(null);
    const errTimer = useRef(null);

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(state)); }, [state]);

    const flashError = (msg) => {
      setError(msg);
      if (errTimer.current) clearTimeout(errTimer.current);
      errTimer.current = setTimeout(() => setError(null), 4000);
    };
    const flashInfo = (msg) => {
      setInfo(msg);
      if (errTimer.current) clearTimeout(errTimer.current);
      errTimer.current = setTimeout(() => setInfo(null), 3000);
    };

    // The 6-week visible window for the current month view
    const grid = useMemo(() => {
      const first = new Date(view.year, view.month, 1);
      const startOffset = isoDow(first); // 0=Mon
      const start = new Date(view.year, view.month, 1 - startOffset);
      const days = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        days.push(d);
      }
      return { start, days, fromYmd: ymd(days[0]), toYmd: ymd(days[41]) };
    }, [view]);

    const dayMap = useMemo(
      () => eventsByDay(state.events, grid.fromYmd, grid.toYmd),
      [state.events, grid.fromYmd, grid.toYmd]
    );

    // Agenda for selected day — expand events in a single-day window
    const selected = state.selectedDate || today;
    const agenda = useMemo(() => {
      const m = eventsByDay(state.events, selected, selected);
      const items = m.get(selected) || [];
      return items.slice().sort(sortAgenda);
    }, [state.events, selected]);

    const setSelected = (s) => setState((st) => ({ ...st, selectedDate: s }));

    const navMonth = (delta) => {
      setView((v) => {
        const m = v.month + delta;
        const year = v.year + Math.floor(m / 12);
        const month = ((m % 12) + 12) % 12;
        return { year, month };
      });
    };
    const goToday = () => {
      const d = new Date();
      setView({ year: d.getFullYear(), month: d.getMonth() });
      setSelected(ymd(d));
    };

    // ---- event CRUD ----
    const startAdd = () => {
      setEditing(null);
      setDraft({ title: '', time: '', location: '', notes: '', color: 'green' });
      setAdding(true);
    };
    const startEdit = (ev) => {
      // Don't let users edit specific occurrence fields on a recurring event;
      // we edit the parent, but not the date.
      setEditing(ev.id);
      setDraft({
        title: ev.title || '',
        time: ev.time || '',
        location: ev.location || '',
        notes: ev.notes || '',
        color: ev.color || 'green',
      });
      setAdding(true);
    };
    const cancelEdit = () => {
      setAdding(false);
      setEditing(null);
    };
    const saveEvent = () => {
      const title = draft.title.trim();
      if (!title) { flashError('title required'); return; }
      if (editing) {
        setState((s) => ({
          ...s,
          events: s.events.map((e) =>
            e.id === editing
              ? { ...e, title, time: draft.time, location: draft.location, notes: draft.notes, color: draft.color }
              : e
          ),
        }));
      } else {
        const ev = {
          id: newId(),
          title,
          date: selected,
          time: draft.time,
          location: draft.location,
          notes: draft.notes,
          color: draft.color,
          source: 'manual',
        };
        setState((s) => ({ ...s, events: [...s.events, ev] }));
      }
      cancelEdit();
    };
    const deleteEvent = (id) => {
      if (confirmId === id) {
        setState((s) => ({ ...s, events: s.events.filter((e) => e.id !== id) }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        if (editing === id) cancelEdit();
        return;
      }
      setConfirmId(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    // ---- ICS import ----
    const importICS = async () => {
      try {
        const api = window.dashboard;
        if (!api || !api.dialog || !api.fs) { flashError('host APIs unavailable'); return; }
        const path = await api.dialog.openFile({
          filters: [
            { name: 'iCalendar', extensions: ['ics', 'ical'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });
        if (!path) return;
        const text = await api.fs.read(path, 'utf8');
        const parsed = parseICS(text);
        if (!parsed.length) { flashError('no events found'); return; }
        const filename = path.split(/[\\/]/).pop() || path;
        const tag = 'ics:' + filename;
        // Replace any existing events from this file
        const kept = state.events.filter((e) => e.source !== tag);
        const palette = COLOR_KEYS;
        const imported = parsed.map((p, i) => ({
          id: newId(),
          title: p.summary || '(untitled)',
          date: p.dtstart.date,
          time: p.dtstart.dateOnly ? '' : (p.dtstart.time || ''),
          location: p.location || '',
          notes: p.description || '',
          color: palette[i % palette.length],
          source: tag,
          rrule: p.rrule || null,
        }));
        setState((s) => ({ ...s, events: [...kept, ...imported] }));
        flashInfo('imported ' + imported.length + ' from ' + filename);
      } catch (e) {
        flashError(e.message || 'import failed');
      }
    };

    // ---- render helpers ----
    const dotsForDay = (key) => {
      const evs = dayMap.get(key) || [];
      if (!evs.length) return null;
      const max = 3;
      const shown = evs.slice(0, max);
      return (
        <div style={{ display: 'flex', gap: 2, justifyContent: 'center', marginTop: 1, height: 5 }}>
          {shown.map((e, i) => (
            <span key={i} style={{
              width: 4, height: 4, borderRadius: 2,
              background: COLORS[e.color] || COLORS.green,
              boxShadow: '0 0 3px ' + (COLORS[e.color] || COLORS.green),
            }} />
          ))}
          {evs.length > max && (
            <span style={{ fontSize: 7, color: 'var(--fg-dim)', lineHeight: 1 }}>+{evs.length - max}</span>
          )}
        </div>
      );
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <button className="p-btn" onClick={() => navMonth(-1)} style={{ padding: '2px 8px', fontSize: 12 }}>‹</button>
          <span style={{
            flex: 1, textAlign: 'center',
            fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--fg-bright)',
            textShadow: 'var(--glow-soft)',
          }}>
            {MONTH_NAMES[view.month]} {view.year}
          </span>
          <button className="p-btn" onClick={() => navMonth(1)} style={{ padding: '2px 8px', fontSize: 12 }}>›</button>
          <button className="p-btn" onClick={goToday} style={{ padding: '2px 8px', fontSize: 10 }} title="jump to today">today</button>
          <button className="p-btn" onClick={startAdd} style={{ padding: '2px 8px', fontSize: 10 }} title="add event">+</button>
          <button className="p-btn" onClick={importICS} style={{ padding: '2px 8px', fontSize: 10 }} title="import .ics">↓ ics</button>
        </div>

        {error && (
          <div style={{
            padding: '3px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}
        {info && (
          <div style={{
            padding: '3px 8px', color: 'var(--accent)',
            border: '1px dashed var(--accent)', borderRadius: 3, fontSize: 10,
          }}>{info}</div>
        )}

        {/* Month grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 2,
        }}>
          {DAY_NAMES.map((n) => (
            <div key={n} className="p-label" style={{ fontSize: 9, textAlign: 'center', padding: '1px 0' }}>
              {n}
            </div>
          ))}
          {grid.days.map((d, i) => {
            const key = ymd(d);
            const inMonth = d.getMonth() === view.month;
            const isToday = key === today;
            const isSelected = key === selected;
            const evs = dayMap.get(key);
            const hasEvents = evs && evs.length > 0;
            return (
              <button
                key={i}
                onClick={() => setSelected(key)}
                title={hasEvents ? evs.map((e) => (e.time ? e.time + ' ' : '') + e.title).join('\n') : ''}
                style={{
                  background: isSelected ? 'var(--accent)' : (hasEvents ? 'rgba(var(--accent-rgb),0.05)' : 'transparent'),
                  color: isSelected ? 'var(--bg)' : (inMonth ? 'var(--fg)' : 'var(--fg-dim)'),
                  border: isToday && !isSelected ? '1px solid var(--accent)' : '1px solid var(--border)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  padding: '3px 0 1px',
                  cursor: 'pointer',
                  borderRadius: 3,
                  textShadow: isToday && !isSelected ? '0 0 4px var(--accent)' : 'none',
                  fontWeight: isToday ? 700 : 400,
                  outline: 'none',
                  minHeight: 26,
                  opacity: inMonth ? 1 : 0.5,
                }}
              >
                <div style={{ lineHeight: 1 }}>{d.getDate()}</div>
                {dotsForDay(key)}
              </button>
            );
          })}
        </div>

        {/* Agenda for selected day */}
        <div className="p-col" style={{
          flex: 1, minHeight: 60, gap: 3,
          borderTop: '1px solid var(--border-bright)',
          paddingTop: 6,
        }}>
          <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="p-label">{(() => {
              const d = parseYmd(selected);
              const wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
              return wk + ' ' + MONTH_NAMES[d.getMonth()].slice(0, 3) + ' ' + d.getDate();
            })()}</span>
            <span className="p-dim" style={{ fontSize: 10 }}>
              {agenda.length} event{agenda.length !== 1 ? 's' : ''}
            </span>
          </div>

          {adding && (
            <div style={{
              border: '1px dashed var(--border-bright)',
              borderRadius: 3, padding: 6,
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <input
                className="p-input"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="title"
                autoFocus
                style={{ fontSize: 11 }}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEvent(); if (e.key === 'Escape') cancelEdit(); }}
              />
              <div className="p-row" style={{ gap: 4 }}>
                <input
                  className="p-input"
                  type="time"
                  value={draft.time}
                  onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))}
                  style={{ width: 90, fontSize: 11 }}
                  title="time (optional)"
                />
                <input
                  className="p-input"
                  value={draft.location}
                  onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
                  placeholder="location"
                  style={{ flex: 1, fontSize: 11 }}
                />
              </div>
              <div className="p-row" style={{ gap: 4, alignItems: 'center' }}>
                {COLOR_KEYS.map((k) => (
                  <button
                    key={k}
                    onClick={() => setDraft((d) => ({ ...d, color: k }))}
                    title={k}
                    style={{
                      width: 16, height: 16, borderRadius: 8,
                      background: COLORS[k],
                      border: draft.color === k ? '2px solid var(--fg-bright)' : '1px solid var(--border)',
                      boxShadow: draft.color === k ? '0 0 6px ' + COLORS[k] : 'none',
                      cursor: 'pointer', padding: 0,
                    }}
                  />
                ))}
                <span style={{ flex: 1 }} />
                <button className="p-btn" onClick={cancelEdit} style={{ fontSize: 10, padding: '2px 8px' }}>cancel</button>
                <button className="p-btn" onClick={saveEvent} style={{ fontSize: 10, padding: '2px 12px' }}>
                  {editing ? 'save' : 'add'}
                </button>
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {agenda.length === 0 && !adding && (
              <div className="p-dim" style={{ fontSize: 11, padding: 6, textAlign: 'center' }}>
                no events — + to add
              </div>
            )}
            {agenda.map((ev) => {
              const c = COLORS[ev.color] || COLORS.green;
              const armed = confirmId === ev.id;
              return (
                <div
                  key={ev.id}
                  className="p-row"
                  onClick={() => startEdit(ev)}
                  style={{
                    cursor: 'pointer',
                    alignItems: 'flex-start',
                    padding: '4px 6px',
                    border: '1px solid var(--border)',
                    borderLeft: '3px solid ' + c,
                    borderRadius: 3,
                    background: 'rgba(var(--accent-rgb),0.02)',
                    gap: 6,
                  }}
                >
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 11,
                    color: c, textShadow: '0 0 4px ' + c,
                    width: 42, flexShrink: 0,
                  }}>{ev.time || '—'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--fg-bright)', lineHeight: 1.3 }}>
                      {ev.title}
                      {ev.rrule && (
                        <span title="recurring" style={{ marginLeft: 4, color: 'var(--fg-dim)', fontSize: 9 }}>↻</span>
                      )}
                    </div>
                    {(ev.location || ev.notes) && (
                      <div className="p-dim" style={{ fontSize: 10, lineHeight: 1.3, marginTop: 1 }}>
                        {ev.location && <span style={{ color: 'var(--fg-dim)' }}>{ev.location}</span>}
                        {ev.location && ev.notes && <span> · </span>}
                        {ev.notes && <span>{ev.notes.split('\n')[0].slice(0, 80)}</span>}
                      </div>
                    )}
                    {ev.source && ev.source.startsWith('ics:') && (
                      <div className="p-dim" style={{ fontSize: 9, marginTop: 1, opacity: 0.6 }}>
                        from {ev.source.slice(4)}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteEvent(ev.id); }}
                    title="delete"
                    style={{
                      background: 'transparent', border: 'none',
                      color: armed ? 'var(--danger)' : 'var(--fg-dim)',
                      cursor: 'pointer', fontFamily: 'var(--mono)',
                      fontSize: armed ? 11 : 14, lineHeight: 1, padding: '0 4px',
                      fontWeight: armed ? 700 : 400, flexShrink: 0,
                    }}
                  >{armed ? '✓?' : '×'}</button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
};
