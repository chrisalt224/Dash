// Recipe Cost Calculator — break each menu item into ingredients (qty +
// item name). Pulls the current best supplier price from Supplier Prices
// (`plugin:supplier-prices:v1`) to compute live plate cost and margin.
//
// "↪ push to menu" syncs the recipe's name + cost + price into the Menu
// Engineering plugin so its Star/Puzzle/Plowhorse/Dog matrix uses the
// current ingredient-driven cost — when supplier prices change, so does
// the menu category.

const KEY = 'plugin:recipe-cost:v1';
const SUPPLIER_KEY = 'plugin:supplier-prices:v1';
const MENU_KEY = 'plugin:menu-engineering:items:v1';

const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2);

export default {
  id: 'recipe-cost',
  name: 'Recipe Cost',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useMemo, useRef }) => {
    const [data, setData] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (raw && typeof raw === 'object' && Array.isArray(raw.recipes)) return raw;
      } catch (e) {}
      return { recipes: [] };
    });

    const [form, setForm] = useState({ name: '', sellPrice: '' });
    const [selected, setSelected] = useState(null);
    const [ingForm, setIngForm] = useState({ item: '', qty: '' });
    const [tick, setTick] = useState(0);
    const [confirmDel, setConfirmDel] = useState(null);
    const [syncedFlash, setSyncedFlash] = useState(null);
    const confirmTimerRef = useRef(null);
    const syncTimerRef = useRef(null);
    useEffect(() => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    }, []);

    useEffect(() => {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    }, [data]);

    useEffect(() => {
      const id = setInterval(() => setTick((t) => t + 1), 5000);
      return () => clearInterval(id);
    }, []);

    // Build best-price-per-item lookup from Supplier Prices
    const supplierPrices = useMemo(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(SUPPLIER_KEY));
        if (!raw || !Array.isArray(raw.entries)) return {};
        const byItemSup = {};
        raw.entries.forEach((e) => {
          if (!byItemSup[e.item]) byItemSup[e.item] = {};
          const cur = byItemSup[e.item][e.supplier];
          if (!cur || e.date > cur.date) {
            byItemSup[e.item][e.supplier] = { date: e.date, price: e.price, unit: e.unit };
          }
        });
        const best = {};
        Object.entries(byItemSup).forEach(([item, sups]) => {
          const stats = Object.entries(sups).map(([s, v]) => ({ supplier: s, ...v }));
          stats.sort((a, b) => a.price - b.price);
          best[item] = stats[0];
        });
        return best;
      } catch (e) { return {}; }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick]);

    const knownItems = useMemo(() => Object.keys(supplierPrices).sort(), [supplierPrices]);

    const addRecipe = () => {
      const name = form.name.trim();
      if (!name) return;
      const sellPrice = parseFloat(form.sellPrice) || 0;
      const newRecipe = {
        id: Date.now() + Math.random(),
        name, sellPrice, ingredients: [],
      };
      setData({ ...data, recipes: [...data.recipes, newRecipe] });
      setSelected(newRecipe.id);
      setForm({ name: '', sellPrice: '' });
    };

    const updateRecipe = (id, updates) => {
      setData({ ...data, recipes: data.recipes.map((r) => (r.id === id ? { ...r, ...updates } : r)) });
    };

    const addIngredient = () => {
      if (!selected) return;
      const item = ingForm.item.trim();
      const qty = parseFloat(ingForm.qty) || 0;
      if (!item || qty <= 0) return;
      const recipe = data.recipes.find((r) => r.id === selected);
      if (!recipe) return;
      updateRecipe(selected, {
        ingredients: [...recipe.ingredients, { id: Date.now() + Math.random(), item, qty }],
      });
      setIngForm({ item: '', qty: '' });
    };

    const removeIngredient = (recipeId, ingId) => {
      const r = data.recipes.find((x) => x.id === recipeId);
      if (!r) return;
      updateRecipe(recipeId, { ingredients: r.ingredients.filter((i) => i.id !== ingId) });
    };

    const removeRecipe = (id) => {
      if (confirmDel === id) {
        setData({ ...data, recipes: data.recipes.filter((r) => r.id !== id) });
        if (selected === id) setSelected(null);
        setConfirmDel(null);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        return;
      }
      setConfirmDel(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDel(null), 3000);
    };

    const computeCost = (recipe) => {
      let cost = 0, unknownCount = 0;
      const items = recipe.ingredients.map((ing) => {
        const sp = supplierPrices[ing.item];
        if (!sp) {
          unknownCount++;
          return { ...ing, cost: 0, unit: '?', supplier: null, unknown: true };
        }
        const ic = sp.price * ing.qty;
        cost += ic;
        return { ...ing, cost: ic, unit: sp.unit, supplier: sp.supplier, unitPrice: sp.price };
      });
      const margin = recipe.sellPrice - cost;
      const marginPct = recipe.sellPrice > 0 ? (margin / recipe.sellPrice) * 100 : 0;
      const foodPct = recipe.sellPrice > 0 ? (cost / recipe.sellPrice) * 100 : 0;
      return { cost, margin, marginPct, foodPct, items, unknownCount };
    };

    const recipesWithStats = useMemo(
      () => data.recipes.map((r) => ({ ...r, ...computeCost(r) })),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [data.recipes, supplierPrices]
    );

    const syncToMenu = (recipe) => {
      try {
        const raw = JSON.parse(localStorage.getItem(MENU_KEY));
        const items = Array.isArray(raw) ? raw : [];
        const existing = items.find((i) => i.name === recipe.name);
        let next;
        if (existing) {
          next = items.map((i) =>
            i.id === existing.id
              ? { ...i, cost: recipe.cost, price: recipe.sellPrice || i.price }
              : i
          );
        } else {
          next = [
            ...items,
            { id: Date.now() + Math.random(), name: recipe.name, cost: recipe.cost, price: recipe.sellPrice, qty: 0 },
          ];
        }
        localStorage.setItem(MENU_KEY, JSON.stringify(next));
        setSyncedFlash(recipe.id);
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(() => setSyncedFlash(null), 1800);
      } catch (e) {}
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Add recipe */}
        <div className="p-row" style={{ gap: 4 }}>
          <input
            type="text"
            placeholder="recipe name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addRecipe(); }}
            className="p-input"
            style={{ fontSize: 11, flex: 2, minWidth: 0 }}
          />
          <input
            type="number" step="0.01" min="0"
            placeholder="sell $"
            value={form.sellPrice}
            onChange={(e) => setForm({ ...form, sellPrice: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addRecipe(); }}
            className="p-input"
            style={{ fontSize: 11, flex: 1, minWidth: 0 }}
          />
          <button className="p-btn" onClick={addRecipe} style={{ fontSize: 11, padding: '2px 10px' }}>
            + recipe
          </button>
        </div>

        {/* Recipe list */}
        <div
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 3,
          }}
        >
          {recipesWithStats.length === 0 ? (
            <div className="p-dim" style={{ fontSize: 11, padding: 8, textAlign: 'center' }}>
              add a recipe. ingredients pull live prices from supplier prices.
            </div>
          ) : recipesWithStats.map((recipe) => {
            const isSelected = selected === recipe.id;
            const stripeColor = !recipe.sellPrice || recipe.foodPct === 0 ? 'var(--fg-dim)'
              : recipe.foodPct > 33 ? 'var(--danger)'
              : recipe.foodPct > 28 ? 'var(--accent-warm)'
              : 'var(--accent)';
            return (
              <div key={recipe.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  onClick={() => setSelected(isSelected ? null : recipe.id)}
                  style={{
                    padding: '4px 6px',
                    borderLeft: '3px solid ' + stripeColor,
                    background: isSelected ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.012)',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 11, fontFamily: 'var(--mono)',
                  }}
                >
                  <span style={{ color: 'var(--fg-dim)', fontSize: 9, width: 10 }}>
                    {isSelected ? '▾' : '▸'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        color: 'var(--fg)', fontWeight: 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >{recipe.name}</div>
                    <div className="p-dim" style={{ fontSize: 9 }}>
                      {recipe.ingredients.length} ingredient{recipe.ingredients.length === 1 ? '' : 's'}
                      {recipe.unknownCount > 0 && (
                        <span style={{ color: 'var(--accent-warm)' }}>
                          {' · '}{recipe.unknownCount} no price
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: 'var(--fg)', fontSize: 11 }}>{fmtMoney(recipe.cost)}</div>
                    <div style={{ color: stripeColor, fontSize: 9 }}>
                      {recipe.sellPrice > 0 ? recipe.foodPct.toFixed(0) + '% food' : 'no price'}
                    </div>
                  </div>
                </div>

                {isSelected && (
                  <div style={{ padding: '6px 8px', background: 'rgba(0,0,0,0.18)' }}>
                    {/* Sell price + delete */}
                    <div className="p-row" style={{ gap: 4, alignItems: 'center', marginBottom: 6 }}>
                      <span className="p-label" style={{ fontSize: 9 }}>sell $</span>
                      <input
                        type="number" step="0.01" min="0"
                        value={recipe.sellPrice || ''}
                        onChange={(e) => updateRecipe(recipe.id, { sellPrice: parseFloat(e.target.value) || 0 })}
                        className="p-input"
                        style={{ fontSize: 10, flex: 1, padding: '1px 4px' }}
                      />
                      <button
                        onClick={() => syncToMenu(recipe)}
                        disabled={!recipe.sellPrice || recipe.unknownCount > 0}
                        title={
                          recipe.unknownCount > 0 ? 'log all ingredient prices first' :
                          !recipe.sellPrice ? 'set a sell price first' :
                          'push name + cost + price into menu engineering'
                        }
                        style={{
                          background: syncedFlash === recipe.id ? 'var(--accent)' : 'transparent',
                          color: syncedFlash === recipe.id ? 'var(--bg)' : 'var(--accent)',
                          border: '1px solid var(--accent)',
                          fontFamily: 'var(--mono)', fontSize: 9,
                          padding: '1px 6px', cursor: 'pointer', borderRadius: 2,
                          letterSpacing: '0.05em',
                          opacity: (!recipe.sellPrice || recipe.unknownCount > 0) ? 0.4 : 1,
                          fontWeight: 700,
                        }}
                      >{syncedFlash === recipe.id ? '✓ synced' : '↪ menu'}</button>
                      <button
                        onClick={() => removeRecipe(recipe.id)}
                        title={confirmDel === recipe.id ? 'click to confirm' : 'delete recipe'}
                        style={{
                          background: 'transparent',
                          border: '1px solid ' + (confirmDel === recipe.id ? 'var(--danger)' : 'var(--border-bright)'),
                          color: confirmDel === recipe.id ? 'var(--danger)' : 'var(--fg-dim)',
                          fontFamily: 'var(--mono)', fontSize: 10,
                          padding: '0 5px', cursor: 'pointer', borderRadius: 2,
                        }}
                      >{confirmDel === recipe.id ? '✓?' : '×'}</button>
                    </div>

                    {/* Ingredients */}
                    {recipe.items.length === 0 ? (
                      <div className="p-dim" style={{ fontSize: 10, fontStyle: 'italic', marginBottom: 4 }}>
                        no ingredients yet
                      </div>
                    ) : recipe.items.map((ing) => (
                      <div
                        key={ing.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '2px 0',
                          fontSize: 10, fontFamily: 'var(--mono)',
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            color: ing.unknown ? 'var(--accent-warm)' : 'var(--fg)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                          title={ing.unknown ? 'no supplier price logged for this item' : ing.supplier + ': ' + fmtMoney(ing.unitPrice) + '/' + ing.unit}
                        >{ing.item}</span>
                        <span className="p-dim" style={{ width: 56, textAlign: 'right', fontSize: 9 }}>
                          {ing.qty} {ing.unit}
                        </span>
                        <span
                          style={{
                            width: 56, textAlign: 'right',
                            color: ing.unknown ? 'var(--accent-warm)' : 'var(--fg)',
                            fontSize: 10,
                          }}
                        >{ing.unknown ? 'no price' : fmtMoney(ing.cost)}</span>
                        <button
                          onClick={() => removeIngredient(recipe.id, ing.id)}
                          title="remove ingredient"
                          style={{
                            background: 'transparent', border: '1px solid transparent',
                            color: 'var(--fg-dim)',
                            fontFamily: 'var(--mono)', fontSize: 10,
                            padding: '0 4px', cursor: 'pointer', borderRadius: 2,
                          }}
                        >×</button>
                      </div>
                    ))}

                    {/* Add ingredient */}
                    <div className="p-row" style={{ gap: 3, marginTop: 4 }}>
                      <input
                        type="text"
                        list={'rc-items-' + recipe.id}
                        placeholder="ingredient"
                        value={ingForm.item}
                        onChange={(e) => setIngForm({ ...ingForm, item: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') addIngredient(); }}
                        className="p-input"
                        style={{ fontSize: 10, flex: 2, minWidth: 0, padding: '1px 4px' }}
                      />
                      <datalist id={'rc-items-' + recipe.id}>
                        {knownItems.map((i) => <option key={i} value={i} />)}
                      </datalist>
                      <input
                        type="number" step="0.01" min="0"
                        placeholder="qty"
                        value={ingForm.qty}
                        onChange={(e) => setIngForm({ ...ingForm, qty: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') addIngredient(); }}
                        className="p-input"
                        style={{ fontSize: 10, flex: 1, minWidth: 0, padding: '1px 4px' }}
                      />
                      <button
                        onClick={addIngredient}
                        className="p-btn"
                        style={{ fontSize: 10, padding: '1px 6px' }}
                      >+</button>
                    </div>

                    {/* Summary */}
                    <div
                      style={{
                        marginTop: 6, paddingTop: 4,
                        borderTop: '1px solid var(--border)',
                        fontSize: 10, fontFamily: 'var(--mono)',
                      }}
                    >
                      <div className="p-row" style={{ justifyContent: 'space-between' }}>
                        <span className="p-dim">plate cost</span>
                        <span style={{ color: 'var(--fg)' }}>{fmtMoney(recipe.cost)}</span>
                      </div>
                      <div className="p-row" style={{ justifyContent: 'space-between' }}>
                        <span className="p-dim">sell price</span>
                        <span style={{ color: 'var(--fg)' }}>{fmtMoney(recipe.sellPrice)}</span>
                      </div>
                      <div
                        className="p-row"
                        style={{ justifyContent: 'space-between', fontWeight: 700, marginTop: 1 }}
                      >
                        <span style={{ color: 'var(--fg-dim)' }}>margin</span>
                        <span style={{ color: recipe.margin >= 0 ? 'var(--accent)' : 'var(--danger)' }}>
                          {fmtMoney(recipe.margin)} ({recipe.marginPct.toFixed(0)}%)
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};
