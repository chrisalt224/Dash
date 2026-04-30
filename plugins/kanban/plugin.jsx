// Kanban — Columns of draggable cards. Drag-and-drop between columns.
//
// • Default columns: Todo / Doing / Done (rename, add, remove from edit
//   mode). Each card has a title, optional notes, and a color.
// • HTML5 drag/drop — pick up a card, drop on another column or between
//   cards in the same column. Drag indicator shows the drop target.
// • Click a card to edit; two-click × to delete.
// • Persistent. Different from `todo` (flat list); kanban gives you
//   workflow visibility.

const KEY = 'plugin:kanban:state:v1';

const COLORS = {
  green:  'var(--accent)',
  amber:  'var(--accent-warm)',
  pink:   '#ff6bd6',
  cyan:   '#5eeaff',
  red:    'var(--danger)',
};
const COLOR_KEYS = Object.keys(COLORS);

const DEFAULTS = {
  columns: [
    { id: 'todo',  name: 'Todo',  color: 'amber' },
    { id: 'doing', name: 'Doing', color: 'green' },
    { id: 'done',  name: 'Done',  color: 'cyan'  },
  ],
  cards: [
    { id: 'c1', col: 'todo',  title: 'try the kanban widget', notes: 'click "+ card" to add more' },
    { id: 'c2', col: 'doing', title: 'drag me to another column' },
    { id: 'c3', col: 'done',  title: 'celebrate getting things done', color: 'green' },
  ],
};

const newId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.columns) && Array.isArray(raw.cards)) return raw;
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULTS));
};

export default {
  id: 'kanban',
  name: 'Kanban',
  width: 3,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const [state, setState] = useState(loadState);
    const [editing, setEditing] = useState(null); // card id
    const [draft, setDraft] = useState({ title: '', notes: '', color: '' });
    const [boardEdit, setBoardEdit] = useState(false);
    const [confirmId, setConfirmId] = useState(null);
    const [dragId, setDragId] = useState(null);
    const [dropTarget, setDropTarget] = useState(null); // {col, beforeId}
    const confirmTimer = useRef(null);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    const cardsByCol = (colId) => state.cards.filter((c) => c.col === colId);

    const startNewCard = (colId) => {
      const id = newId('c');
      setState((s) => ({ ...s, cards: [...s.cards, { id, col: colId, title: '' }] }));
      setEditing(id);
      setDraft({ title: '', notes: '', color: '' });
    };

    const startEdit = (card) => {
      setEditing(card.id);
      setDraft({ title: card.title || '', notes: card.notes || '', color: card.color || '' });
    };

    const saveEdit = () => {
      const t = draft.title.trim();
      if (!t) {
        // empty title -> remove blank card
        setState((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== editing || (c.title || '').trim()) }));
        setEditing(null);
        return;
      }
      setState((s) => ({
        ...s,
        cards: s.cards.map((c) => c.id === editing ? { ...c, title: t, notes: draft.notes, color: draft.color || undefined } : c),
      }));
      setEditing(null);
    };

    const cancelEdit = () => {
      // If editing a brand-new card with no title, drop it
      const card = state.cards.find((c) => c.id === editing);
      if (card && !(card.title || '').trim()) {
        setState((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== editing) }));
      }
      setEditing(null);
    };

    const deleteCard = (id) => {
      if (confirmId === id) {
        setState((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== id) }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        if (editing === id) setEditing(null);
        return;
      }
      setConfirmId(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    // Column ops
    const addColumn = () => {
      const id = newId('col');
      setState((s) => ({ ...s, columns: [...s.columns, { id, name: 'New', color: 'green' }] }));
    };
    const renameColumn = (id, name) =>
      setState((s) => ({ ...s, columns: s.columns.map((c) => c.id === id ? { ...c, name } : c) }));
    const cycleColColor = (id) =>
      setState((s) => ({
        ...s,
        columns: s.columns.map((c) => {
          if (c.id !== id) return c;
          const idx = COLOR_KEYS.indexOf(c.color);
          return { ...c, color: COLOR_KEYS[(idx + 1) % COLOR_KEYS.length] };
        }),
      }));
    const removeColumn = (id) => {
      if (confirmId === 'col:' + id) {
        setState((s) => ({
          ...s,
          columns: s.columns.filter((c) => c.id !== id),
          cards: s.cards.filter((c) => c.col !== id),
        }));
        setConfirmId(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmId('col:' + id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    };

    // Drag & drop
    const onDragStart = (cardId, ev) => {
      setDragId(cardId);
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', cardId); } catch {}
    };
    const onDragEnd = () => { setDragId(null); setDropTarget(null); };
    const onDragOverCard = (colId, beforeId, ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      setDropTarget({ col: colId, beforeId });
    };
    const onDragOverCol = (colId, ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      setDropTarget({ col: colId, beforeId: null });
    };
    const onDrop = (ev) => {
      ev.preventDefault();
      if (!dragId || !dropTarget) { setDragId(null); setDropTarget(null); return; }
      setState((s) => {
        const idx = s.cards.findIndex((c) => c.id === dragId);
        if (idx === -1) return s;
        const cards = s.cards.slice();
        const [card] = cards.splice(idx, 1);
        card.col = dropTarget.col;
        // Insert before beforeId, or append to end of column
        if (dropTarget.beforeId) {
          const beforeIdx = cards.findIndex((c) => c.id === dropTarget.beforeId);
          if (beforeIdx === -1) cards.push(card);
          else cards.splice(beforeIdx, 0, card);
        } else {
          cards.push(card);
        }
        return { ...s, cards };
      });
      setDragId(null);
      setDropTarget(null);
    };

    const totalCards = state.cards.length;

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="p-label">kanban · {totalCards} card{totalCards !== 1 ? 's' : ''}</span>
          <div className="p-row" style={{ gap: 4 }}>
            {boardEdit && (
              <button className="p-btn" onClick={addColumn} style={{ fontSize: 10, padding: '2px 8px' }}>+ col</button>
            )}
            <button
              onClick={() => setBoardEdit((b) => !b)}
              title="board edit mode"
              style={{
                background: boardEdit ? 'rgba(255,180,84,0.15)' : 'transparent',
                border: '1px solid ' + (boardEdit ? 'var(--accent-warm)' : 'var(--border-bright)'),
                color: boardEdit ? 'var(--accent-warm)' : 'var(--fg-dim)',
                fontFamily: 'var(--mono)', fontSize: 10,
                padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
                letterSpacing: '0.1em', textTransform: 'uppercase',
              }}
            >{boardEdit ? 'done' : 'edit'}</button>
          </div>
        </div>

        {/* Columns row */}
        <div style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
        }} onDrop={onDrop}>
          {state.columns.map((col) => {
            const cards = cardsByCol(col.id);
            const c = COLORS[col.color] || COLORS.green;
            return (
              <div
                key={col.id}
                onDragOver={(e) => cards.length === 0 && onDragOverCol(col.id, e)}
                style={{
                  flex: '1 1 0',
                  minWidth: 140,
                  display: 'flex',
                  flexDirection: 'column',
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid var(--border)',
                  borderTop: '2px solid ' + c,
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                {/* Column header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 6px',
                  borderBottom: '1px solid var(--border)',
                  background: 'rgba(var(--accent-rgb),0.02)',
                }}>
                  {boardEdit ? (
                    <>
                      <button
                        onClick={() => cycleColColor(col.id)}
                        title="cycle color"
                        style={{
                          width: 10, height: 10, borderRadius: 5,
                          background: c, boxShadow: '0 0 4px ' + c,
                          border: 'none', cursor: 'pointer', padding: 0,
                          flexShrink: 0,
                        }}
                      />
                      <input
                        value={col.name}
                        onChange={(e) => renameColumn(col.id, e.target.value)}
                        className="p-input"
                        style={{ flex: 1, fontSize: 11, padding: '1px 4px' }}
                      />
                      <button
                        onClick={() => removeColumn(col.id)}
                        title="delete column + cards"
                        style={{
                          background: 'transparent', border: 'none',
                          color: confirmId === 'col:' + col.id ? 'var(--danger)' : 'var(--fg-dim)',
                          cursor: 'pointer', fontFamily: 'var(--mono)',
                          fontSize: confirmId === 'col:' + col.id ? 10 : 13,
                          padding: '0 4px', lineHeight: 1,
                          fontWeight: confirmId === 'col:' + col.id ? 700 : 400,
                        }}
                      >{confirmId === 'col:' + col.id ? '✓?' : '×'}</button>
                    </>
                  ) : (
                    <>
                      <span style={{
                        width: 8, height: 8, borderRadius: 4,
                        background: c, boxShadow: '0 0 4px ' + c,
                        flexShrink: 0,
                      }} />
                      <span style={{
                        flex: 1,
                        fontFamily: 'var(--mono)', fontSize: 11,
                        color: 'var(--fg-bright)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        fontWeight: 600,
                      }}>{col.name}</span>
                      <span className="p-dim" style={{ fontSize: 10 }}>{cards.length}</span>
                    </>
                  )}
                </div>
                {/* Cards list */}
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: 4,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    minHeight: 30,
                  }}
                  onDragOver={(e) => onDragOverCol(col.id, e)}
                >
                  {cards.length === 0 && dragId && dropTarget && dropTarget.col === col.id && (
                    <div style={{
                      height: 2, background: 'var(--accent)',
                      boxShadow: '0 0 6px var(--accent)',
                      margin: '4px 0',
                    }} />
                  )}
                  {cards.map((card) => {
                    const cc = card.color ? COLORS[card.color] : null;
                    const isEditing = editing === card.id;
                    const isDragging = dragId === card.id;
                    const showIndicator = dropTarget && dropTarget.col === col.id && dropTarget.beforeId === card.id;
                    const armed = confirmId === card.id;
                    return (
                      <React.Fragment key={card.id}>
                        {showIndicator && (
                          <div style={{
                            height: 2, background: 'var(--accent)',
                            boxShadow: '0 0 6px var(--accent)',
                          }} />
                        )}
                        <div
                          draggable={!isEditing}
                          onDragStart={(e) => onDragStart(card.id, e)}
                          onDragEnd={onDragEnd}
                          onDragOver={(e) => onDragOverCard(col.id, card.id, e)}
                          onClick={() => !isEditing && startEdit(card)}
                          style={{
                            background: 'rgba(var(--accent-rgb),0.05)',
                            border: '1px solid ' + (cc || 'var(--border-bright)'),
                            borderLeft: cc ? '3px solid ' + cc : '1px solid var(--border-bright)',
                            borderRadius: 2,
                            padding: '4px 6px',
                            cursor: isEditing ? 'default' : 'grab',
                            opacity: isDragging ? 0.4 : 1,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          }}
                        >
                          {isEditing ? (
                            <>
                              <input
                                value={draft.title}
                                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                                placeholder="title…"
                                autoFocus
                                spellCheck={false}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                style={{
                                  background: 'transparent', border: 'none',
                                  color: 'var(--fg-bright)',
                                  fontFamily: 'var(--mono)', fontSize: 11,
                                  outline: 'none', padding: 0,
                                  fontWeight: 600,
                                }}
                              />
                              <textarea
                                value={draft.notes}
                                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                                placeholder="notes (optional)"
                                spellCheck={false}
                                rows={2}
                                style={{
                                  background: 'transparent', border: 'none',
                                  color: 'var(--fg-dim)',
                                  fontFamily: 'var(--mono)', fontSize: 10,
                                  outline: 'none', padding: 0,
                                  resize: 'vertical',
                                  lineHeight: 1.4,
                                }}
                              />
                              <div className="p-row" style={{ gap: 2, alignItems: 'center', marginTop: 2 }}>
                                {COLOR_KEYS.map((k) => (
                                  <button
                                    key={k}
                                    onClick={(e) => { e.stopPropagation(); setDraft((d) => ({ ...d, color: d.color === k ? '' : k })); }}
                                    title={k}
                                    style={{
                                      width: 12, height: 12, borderRadius: 6,
                                      background: COLORS[k],
                                      border: draft.color === k ? '2px solid var(--fg-bright)' : '1px solid var(--border)',
                                      cursor: 'pointer', padding: 0,
                                    }}
                                  />
                                ))}
                                <span style={{ flex: 1 }} />
                                <button
                                  onClick={(e) => { e.stopPropagation(); deleteCard(card.id); }}
                                  style={{
                                    background: 'transparent', border: 'none',
                                    color: armed ? 'var(--danger)' : 'var(--fg-dim)',
                                    cursor: 'pointer', fontFamily: 'var(--mono)',
                                    fontSize: armed ? 9 : 11, padding: '0 4px',
                                    fontWeight: armed ? 700 : 400, lineHeight: 1,
                                  }}
                                >{armed ? '✓ del' : '×'}</button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                                  className="p-btn"
                                  style={{ fontSize: 9, padding: '1px 6px' }}
                                >cancel</button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); saveEdit(); }}
                                  className="p-btn"
                                  style={{ fontSize: 9, padding: '1px 8px' }}
                                >save</button>
                              </div>
                            </>
                          ) : (
                            <>
                              <span style={{
                                fontFamily: 'var(--mono)', fontSize: 11,
                                color: 'var(--fg-bright)',
                                lineHeight: 1.3,
                                wordBreak: 'break-word',
                              }}>{card.title || '(untitled)'}</span>
                              {card.notes && (
                                <span className="p-dim" style={{
                                  fontSize: 9, lineHeight: 1.3,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}>{card.notes}</span>
                              )}
                            </>
                          )}
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
                {/* Add card */}
                <button
                  onClick={() => startNewCard(col.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    borderTop: '1px solid var(--border)',
                    color: 'var(--fg-dim)',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    padding: '4px 6px',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >+ card</button>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};
