// Example plugin: a small todo list. Demonstrates lists + handlers + persistence.

const KEY = 'plugin:todo:items';

export default {
  id: 'todo',
  name: 'Todo',
  width: 1,
  height: 2,
  component: ({ useState, useEffect }) => {
    const [items, setItems] = useState(() => {
      try { return JSON.parse(localStorage.getItem(KEY)) || []; }
      catch { return []; }
    });
    const [draft, setDraft] = useState('');

    useEffect(() => { localStorage.setItem(KEY, JSON.stringify(items)); }, [items]);

    const add = () => {
      const t = draft.trim();
      if (!t) return;
      setItems([...items, { id: Date.now(), text: t, done: false }]);
      setDraft('');
    };

    const toggle = (id) =>
      setItems(items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));

    const remove = (id) => setItems(items.filter((i) => i.id !== id));

    return (
      <div className="p-col" style={{ height: '100%' }}>
        <div className="p-row">
          <input
            className="p-input"
            placeholder="new task..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="p-btn" onClick={add}>+</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && <div className="p-dim p-label">no tasks</div>}
          {items.map((i) => (
            <div key={i.id} className="p-row" style={{ padding: '4px 0' }}>
              <input type="checkbox" checked={i.done} onChange={() => toggle(i.id)} />
              <span style={{
                flex: 1,
                textDecoration: i.done ? 'line-through' : 'none',
                opacity: i.done ? 0.5 : 1,
              }}>{i.text}</span>
              <button className="p-btn" onClick={() => remove(i.id)}>×</button>
            </div>
          ))}
        </div>
      </div>
    );
  },
};
