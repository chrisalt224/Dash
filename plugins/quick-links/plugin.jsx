// Quick links — a small list of one-click bookmarks. Each entry is a label
// + target. Target can be a URL, a folder path, a file path, or an exe.
// Click "edit" to add or remove links. Persists in localStorage.

const KEY = 'plugin:quicklinks:items:v1';

const loadItems = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; }
  catch { return []; }
};

const isUrl = (s) => /^https?:\/\//i.test(s);

export default {
  id: 'quick-links',
  name: 'Quick Links',
  width: 1,
  height: 2,
  component: ({ useState }) => {
    const [items, setItems] = useState(loadItems);
    const [editing, setEditing] = useState(false);
    const [draftLabel, setDraftLabel] = useState('');
    const [draftTarget, setDraftTarget] = useState('');

    const persist = (next) => {
      setItems(next);
      localStorage.setItem(KEY, JSON.stringify(next));
    };

    const addLink = () => {
      const label = draftLabel.trim();
      const target = draftTarget.trim();
      if (!label || !target) return;
      persist([...items, { id: Date.now().toString(36), label, target }]);
      setDraftLabel('');
      setDraftTarget('');
    };

    const removeLink = (id) => persist(items.filter((i) => i.id !== id));

    const open = (target) => {
      if (isUrl(target)) window.dashboard.shell.openExternal(target);
      else window.dashboard.shell.open(target);
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        <div className="p-row" style={{ justifyContent: 'space-between' }}>
          <span className="p-label">links</span>
          <button
            className="p-btn"
            onClick={() => setEditing(!editing)}
            style={{ fontSize: 10, padding: '2px 8px' }}
          >{editing ? 'done' : 'edit'}</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {items.length === 0 && (
            <div className="p-dim p-label" style={{ padding: 8 }}>
              no links — click edit
            </div>
          )}
          {items.map((item) => (
            <div key={item.id} className="p-row" style={{ padding: '2px 0', gap: 4 }}>
              <button
                className="p-btn"
                onClick={() => open(item.target)}
                style={{
                  flex: 1,
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  fontSize: 11,
                  padding: '5px 8px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'block',
                }}
                title={item.target}
              >▸ {item.label}</button>
              {editing && (
                <button
                  className="p-btn"
                  onClick={() => removeLink(item.id)}
                  style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                  title="remove"
                >×</button>
              )}
            </div>
          ))}
        </div>
        {editing && (
          <div className="p-col" style={{
            gap: 4,
            paddingTop: 6,
            borderTop: '1px dashed var(--border-bright)',
          }}>
            <input
              className="p-input"
              placeholder="label"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              style={{ fontSize: 11 }}
            />
            <input
              className="p-input"
              placeholder="url, file, folder, or exe"
              value={draftTarget}
              onChange={(e) => setDraftTarget(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addLink(); }}
              style={{ fontSize: 11 }}
            />
            <button className="p-btn" onClick={addLink}>+ add link</button>
          </div>
        )}
      </div>
    );
  },
};
