export default {
  id: 'supplier-comparison',
  name: 'Supplier Comparison',
  width: 4,
  height: 4,
  component: ({ useState, useEffect, useRef }) => {
    const KEY = 'plugin:supplier-comparison:data:v1';
    const SUPPLIERS = ['Russo', 'Ferraro', 'Sysco', 'Restaurant Depot', 'Misc'];

    const getDefaultItems = () => [
      { id: '1', item: 'Pilsbury Flour', description: '1 50lb bag', qty: 1, costs: { Russo: 22.95, Ferraro: 22.05, 'Restaurant Depot': 0, Sysco: 21.99, Misc: 0 } },
      { id: '2', item: 'Lg White Bags w/ Handle', description: '1 cs 200 ct', qty: 1, costs: { Russo: 0, Ferraro: 46.68, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '3', item: 'Hoagie Bags', description: '1 cs 1000 ct', qty: 1, costs: { Russo: 0, Ferraro: 47.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '4', item: 'Butcher Paper', description: '1 18" rll w/ 1000\'', qty: 1, costs: { Russo: 0, Ferraro: 24.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '5', item: 'Aluminum Foil 12"', description: '1 12" rll w/ 1000\'', qty: 1, costs: { Russo: 30.49, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '6', item: 'Cling Wrap 18"', description: '1 18" rll w/ 2000\'', qty: 1, costs: { Russo: 18.94, Ferraro: 19.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '7', item: 'Soufflee Lids 3.25 oz', description: '1 cs 2500 ct', qty: 1, costs: { Russo: 0, Ferraro: 39.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '8', item: 'Soup Cup/Lid 16oz', description: '1cs 250ct', qty: 1, costs: { Russo: 0, Ferraro: 30.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '9', item: 'T-Shirt Thank You Bags', description: '1cs 1000 ct', qty: 1, costs: { Russo: 0, Ferraro: 24.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '10', item: 'Full Lid', description: '1 cs 50 ct', qty: 1, costs: { Russo: 0, Ferraro: 36.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '11', item: 'Half Medium Tray', description: '1 cs 100 ct', qty: 1, costs: { Russo: 0, Ferraro: 43.15, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '12', item: '16" Black Tray', description: '1 cs 25 ct', qty: 1, costs: { Russo: 0, Ferraro: 39.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '13', item: '16" Dome Lid', description: '1 cs 25 ct', qty: 1, costs: { Russo: 0, Ferraro: 70.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '14', item: '12" Black Tray', description: '1 cs 25 ct', qty: 1, costs: { Russo: 0, Ferraro: 24.88, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '15', item: 'Black Trash Bags', description: '1 cs 100 ct 58 gl', qty: 1, costs: { Russo: 0, Ferraro: 25.68, 'Restaurant Depot': 0, Sysco: 21.59, Misc: 0 } },
      { id: '16', item: 'Clear Trash Bags', description: '1 cs 100 ct 58 gl', qty: 1, costs: { Russo: 0, Ferraro: 29.77, 'Restaurant Depot': 0, Sysco: 50.35, Misc: 0 } },
      { id: '17', item: 'Paper Plates', description: '1 cs 10 ct 100 pc', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 57.55, Misc: 0 } },
      { id: '18', item: 'Tork Brown Napkins', description: '1 cs 12 ct 500 pc', qty: 1, costs: { Russo: 66.44, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '19', item: 'Catering Tongs', description: '1 cs 36 ct 10.5"', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 40.75, Misc: 0 } },
      { id: '20', item: 'Pineapple Cans', description: '1 cs 12 ct 20 oz', qty: 1, costs: { Russo: 35.99, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '21', item: 'Spaghetti', description: '1 cs 20 ct', qty: 1, costs: { Russo: 0, Ferraro: 21.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '22', item: 'Penne', description: '1 cs 20 ct 8 oz', qty: 1, costs: { Russo: 0, Ferraro: 21.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '23', item: 'Fettucini', description: '1 cs 20 ct', qty: 1, costs: { Russo: 0, Ferraro: 22.11, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '24', item: 'Mild Sauce', description: '1 cs 4 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 68.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '25', item: 'Hot Sauce', description: '1 cs 4 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 39.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '26', item: 'Ketchup Packets', description: '1 cs 1000 ct', qty: 1, costs: { Russo: 0, Ferraro: 27.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '27', item: 'Small Cannoli Shells', description: '1 cs 10 ct 12 pc', qty: 1, costs: { Russo: 38, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '28', item: 'Oven Cleaner', description: '1 cs 6 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 29.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '29', item: 'Dish Soap', description: '1 cs 6 ct 1 gl', qty: 1, costs: { Russo: 33.49, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '30', item: 'Floor Cleaner Lavender', description: '1 cs 6 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 29.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '31', item: 'Salt', description: '1 bag 50 lb', qty: 1, costs: { Russo: 0, Ferraro: 11.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '32', item: 'Sugar', description: '1 bag 50 lb', qty: 1, costs: { Russo: 0, Ferraro: 36.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '33', item: 'Whiz Cans', description: '1 cs 6 ct #10', qty: 1, costs: { Russo: 0, Ferraro: 49.9, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '34', item: 'Tuna Cans', description: '1 cs 6 ct 66.5 oz', qty: 1, costs: { Russo: 0, Ferraro: 58.1, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '35', item: 'Alta Cucina', description: '1 cs 6 cans', qty: 1, costs: { Russo: 0, Ferraro: 34.99, 'Restaurant Depot': 0, Sysco: 34.65, Misc: 0 } },
      { id: '36', item: 'Bonta', description: '1 cs 6 cans', qty: 1, costs: { Russo: 0, Ferraro: 49.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '37', item: 'BBQ', description: '1 gl', qty: 1, costs: { Russo: 0, Ferraro: 45.5, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '38', item: 'Olive Oil', description: '1 cs 4 ct 3 lt', qty: 1, costs: { Russo: 0, Ferraro: 67.05, 'Restaurant Depot': 0, Sysco: 60.7, Misc: 0 } },
      { id: '39', item: 'Blended Oil', description: '1 cs 6 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 47.75, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '40', item: 'Shortening', description: '1 cs', qty: 1, costs: { Russo: 0, Ferraro: 30.75, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '41', item: 'Pan Spray', description: '1 cs 6 ct 17 oz', qty: 1, costs: { Russo: 29.49, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 41.39, Misc: 0 } },
      { id: '42', item: 'Hot Peppers', description: '1 cs 4 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 38.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '43', item: 'Sweet Peppers', description: '1 cs 4 ct 1 gl', qty: 1, costs: { Russo: 38.99, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '44', item: 'Mayo', description: '1 cs 4 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 44.36, Misc: 0 } },
      { id: '45', item: 'Sweet & Spicy Wing Sauce', description: '1 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 91.95, Misc: 0 } },
      { id: '46', item: 'Beef Steak', description: '1 cs 20 ct 8 oz', qty: 1, costs: { Russo: 0, Ferraro: 42.99, 'Restaurant Depot': 0, Sysco: 47.14, Misc: 0 } },
      { id: '47', item: 'Chicken Steak', description: '1 cs 20 ct 8 oz', qty: 5, costs: { Russo: 29.99, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '48', item: 'Broccoli', description: '1 cs 12 ct 2 lb', qty: 1, costs: { Russo: 37.25, Ferraro: 31.25, 'Restaurant Depot': 0, Sysco: 62.65, Misc: 0 } },
      { id: '49', item: 'French Fries', description: '1 cs 6 ct', qty: 1, costs: { Russo: 36.96, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 39.5, Misc: 0 } },
      { id: '50', item: 'Gluten Free Pizza', description: '1 cs 10 ct', qty: 1, costs: { Russo: 46.99, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '51', item: 'Sausage Rope', description: '1 cs 10 lb', qty: 1, costs: { Russo: 0, Ferraro: 29.89, 'Restaurant Depot': 0, Sysco: 32.39, Misc: 0 } },
      { id: '52', item: 'Bacon Topping', description: '1 cs 10 lb', qty: 1, costs: { Russo: 49.99, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '53', item: 'Meatballs 3oz', description: '1 cs 1 bg 10 lb', qty: 1, costs: { Russo: 0, Ferraro: 41.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '54', item: 'Meatballs 2oz', description: '1 cs 2 ct 5 lb bag', qty: 1, costs: { Russo: 0, Ferraro: 41.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '55', item: 'Mini Meatballs', description: '1 cs 1 bg 10 lb', qty: 1, costs: { Russo: 0, Ferraro: 54.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '56', item: 'Wings', description: '1cs 40 lb', qty: 1, costs: { Russo: 61.6, Ferraro: 58.9, 'Restaurant Depot': 0, Sysco: 67.73, Misc: 0 } },
      { id: '57', item: 'Angus Burgers', description: '1 cs 20 ct 8 oz', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 71.05, Misc: 0 } },
      { id: '58', item: 'Chicken Fingers', description: '1 cs 2 ct 5 lb bag', qty: 1, costs: { Russo: 0, Ferraro: 45.75, 'Restaurant Depot': 0, Sysco: 41.99, Misc: 0 } },
      { id: '59', item: 'Mozzarella Sticks', description: '1 cs 6 ct', qty: 1, costs: { Russo: 42.49, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 40.92, Misc: 0 } },
      { id: '60', item: 'Jalapeno Poppers', description: '1 cs 6 ct', qty: 1, costs: { Russo: 0, Ferraro: 50.95, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '61', item: 'Onion Rings', description: '1 cs 4 ct 2.5 lb', qty: 1, costs: { Russo: 0, Ferraro: 26.98, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '62', item: 'Arrancini', description: '1 cs 72 ct', qty: 1, costs: { Russo: 0, Ferraro: 47.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '63', item: 'Shrimp', description: '1 cs 5 ct 2 lb', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 69.99, Misc: 0 } },
      { id: '64', item: 'Cheese Ravioli', description: '1 cs 144 ct', qty: 1, costs: { Russo: 0, Ferraro: 39.04, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '65', item: 'Cheese Tricolor Tortellini', description: '1 cs 12 ct', qty: 1, costs: { Russo: 35.49, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '66', item: 'Pannini', description: '1 cs 50 ct', qty: 1, costs: { Russo: 0, Ferraro: 47.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '67', item: 'Tiramisu', description: '1cs 2 ct', qty: 1, costs: { Russo: 78.52, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '68', item: 'French Packets', description: '1 cs 60 ct 1.5 oz', qty: 1, costs: { Russo: 22.6, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '69', item: 'Ranch Packets', description: '1 cs 60 ct 1.5 oz', qty: 1, costs: { Russo: 0, Ferraro: 26.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '70', item: 'Ham', description: '1cs 2 ct', qty: 1, costs: { Russo: 32.37, Ferraro: 39.54, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '71', item: 'Turkey', description: 'PPP', qty: 1, costs: { Russo: 0, Ferraro: 5.85, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '72', item: 'Genoa Salami', description: 'PPP', qty: 1, costs: { Russo: 3.93, Ferraro: 3.85, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '73', item: 'Cooked Salami', description: 'PPP', qty: 1, costs: { Russo: 3.02, Ferraro: 4.8, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '74', item: 'Capricola', description: 'PPP 1cs 2 ct', qty: 1, costs: { Russo: 0, Ferraro: 29.82, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '75', item: 'Provolone', description: '1 cs 6 ct 1.5 lb', qty: 1, costs: { Russo: 0, Ferraro: 36.81, 'Restaurant Depot': 0, Sysco: 67.89, Misc: 0 } },
      { id: '76', item: 'American Cheese', description: '1 cs 4 ct', qty: 1, costs: { Russo: 53.8, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '77', item: 'Feta Crumbles', description: '1 cs 2 ct 5 lb bag', qty: 1, costs: { Russo: 0, Ferraro: 31.79, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '78', item: 'Parm Shavings', description: 'I cs 2 ct 3 lb bag', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 44.72, Misc: 0 } },
      { id: '79', item: 'Grated Romano', description: '1 cs 4 ct 5 lb', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 57.55, Misc: 0 } },
      { id: '80', item: 'Heavy Cream', description: '1 cs 12ct 32oz', qty: 1, costs: { Russo: 59.25, Ferraro: 53.91, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '81', item: 'Ricotta', description: '1 cs 6 ct', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 29.6, Misc: 0 } },
      { id: '82', item: 'Del Pastaio', description: '1 tub', qty: 1, costs: { Russo: 17.45, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '83', item: 'Sopraffina', description: '1 tub', qty: 1, costs: { Russo: 8.91, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '84', item: 'Ciliegine', description: '1 cs 2 ct 3 lb', qty: 1, costs: { Russo: 0, Ferraro: 28.35, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '85', item: 'Grande East Coast', description: 'PPP 1 cs 6ct', qty: 1, costs: { Russo: 97.8, Ferraro: 101.4, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '86', item: 'Blue Cheese', description: '1 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 66.82, Misc: 0 } },
      { id: '87', item: 'Ranch', description: '1 ct 1 gl', qty: 1, costs: { Russo: 17.27, Ferraro: 59.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '88', item: 'Honey Mustard', description: '1 ct 1 gl', qty: 1, costs: { Russo: 20.1, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '89', item: 'Seperating Italian', description: '1 ct 1 gl', qty: 1, costs: { Russo: 0, Ferraro: 46.99, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '90', item: 'Kalamata Olives', description: '1 tub 20 lb', qty: 1, costs: { Russo: 59.96, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 44.95, Misc: 0 } },
      { id: '91', item: 'Pepperoni', description: '1 cs 2 ct', qty: 1, costs: { Russo: 0, Ferraro: 86.84, 'Restaurant Depot': 0, Sysco: 85.37, Misc: 0 } },
      { id: '92', item: 'Fresh Chicken Tenderloins', description: '1 cs 40 lb', qty: 1, costs: { Russo: 0, Ferraro: 103.99, 'Restaurant Depot': 0, Sysco: 109.61, Misc: 0 } },
      { id: '93', item: 'Gnocchi', description: '1 cs 12 ct 500 g', qty: 1, costs: { Russo: 0, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 28.99, Misc: 0 } },
      { id: '94', item: 'Wheat Wraps', description: '1 cs 6 ct 12 pc', qty: 1, costs: { Russo: 24.54, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '95', item: 'White Wraps', description: '1 cs 6 ct 12 pc', qty: 1, costs: { Russo: 26.75, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } },
      { id: '96', item: 'Spinach Wraps', description: '1 cs 6 ct 12 pc', qty: 1, costs: { Russo: 26.16, Ferraro: 0, 'Restaurant Depot': 0, Sysco: 0, Misc: 0 } }
    ];

    const [items, setItems] = useState(() => {
      try {
        const saved = localStorage.getItem(KEY);
        return saved ? JSON.parse(saved) : getDefaultItems();
      } catch {
        return getDefaultItems();
      }
    });

    const [searchTerm, setSearchTerm] = useState('');
    const [showAddForm, setShowAddForm] = useState(false);
    const [newItem, setNewItem] = useState({ item: '', description: '', qty: 1 });

    useEffect(() => {
      localStorage.setItem(KEY, JSON.stringify(items));
    }, [items]);

    const filteredItems = items.filter(item =>
      item.item.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.description.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const updateCost = (itemId, supplier, value) => {
      setItems(prev => prev.map(item => {
        if (item.id === itemId) {
          return {
            ...item,
            costs: { ...item.costs, [supplier]: parseFloat(value) || 0 }
          };
        }
        return item;
      }));
    };

    const updateQty = (itemId, value) => {
      setItems(prev => prev.map(item => {
        if (item.id === itemId) {
          return { ...item, qty: parseFloat(value) || 1 };
        }
        return item;
      }));
    };

    const addItem = () => {
      if (!newItem.item.trim()) return;
      const id = Date.now().toString(36);
      setItems(prev => [...prev, {
        id,
        item: newItem.item.trim(),
        description: newItem.description.trim(),
        qty: newItem.qty || 1,
        costs: SUPPLIERS.reduce((acc, s) => ({ ...acc, [s]: 0 }), {})
      }]);
      setNewItem({ item: '', description: '', qty: 1 });
      setShowAddForm(false);
    };

    const deleteItem = (id) => {
      if (confirm('Delete this item?')) {
        setItems(prev => prev.filter(item => item.id !== id));
      }
    };

    const resetToDefaults = () => {
      if (confirm('Reset to default items? This will overwrite current data.')) {
        const defaults = getDefaultItems();
        setItems(defaults);
      }
    };

    const calcForItem = (item) => {
      const activeCosts = SUPPLIERS
        .map(s => item.costs[s] || 0)
        .filter(c => c > 0);
      
      const high = activeCosts.length > 0 ? Math.max(...activeCosts) : 0;
      const low = activeCosts.length > 0 ? Math.min(...activeCosts) : 0;
      const avg = activeCosts.length > 0 
        ? activeCosts.reduce((a, b) => a + b, 0) / activeCosts.length 
        : 0;
      
      const supplierTotals = SUPPLIERS.map(s => (item.costs[s] || 0) * (item.qty || 1));
      const grandTotal = supplierTotals.reduce((a, b) => a + b, 0);
      
      return { high, low, avg, supplierTotals, grandTotal };
    };

    const grandTotals = SUPPLIERS.map(supplier => {
      return items.reduce((sum, item) => {
        return sum + ((item.costs[supplier] || 0) * (item.qty || 1));
      }, 0);
    });

    const exportCSV = async () => {
      const date     = new Date().toISOString().split('T')[0];
      const filename = `Tonys-Price-Comparison-${date}.csv`;

      // Build header
      let csv = 'ITEM,DESCRIPTION,QTY,';
      SUPPLIERS.forEach(s => { csv += `${s} COST,${s} TOTAL,`; });
      csv += 'HIGH,LOW,AVERAGE,GRAND TOTAL\n';

      // Data rows
      items.forEach(item => {
        const c = calcForItem(item);
        csv += `"${item.item}","${item.description}",${item.qty},`;
        SUPPLIERS.forEach(s => {
          const cost = item.costs[s] || 0;
          csv += `${cost.toFixed(2)},${(cost * (item.qty || 1)).toFixed(2)},`;
        });
        csv += `${c.high.toFixed(2)},${c.low.toFixed(2)},${c.avg.toFixed(2)},${c.grandTotal.toFixed(2)}\n`;
      });

      // Grand totals row — empty COST column, actual total in TOTAL column per supplier
      csv += '"GRAND TOTALS","",""';
      grandTotals.forEach(t => { csv += `,,${t.toFixed(2)}`; });
      csv += ',,,,\n';

      try {
        // Save to user's Downloads folder via the dashboard fs API
        const home     = await window.dashboard.fs.home();
        const savePath = `${home}\\Downloads\\${filename}`;
        await window.dashboard.fs.write(savePath, csv);
        window.dashboard.shell.open(savePath);
      } catch (err) {
        // Fallback: Blob download (works if IPC is unavailable)
        try {
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href     = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (e2) {
          alert('Export failed: ' + (e2.message || e2));
        }
      }
    };

    const printTable = async () => {
      const date    = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
      const supHdrs = SUPPLIERS.map(s => `<th>${s.split(' ').map(w => w[0]).join('')}</th>`).join('');
      const supCols = SUPPLIERS.map(() => '<col class="sp">').join('');

      const bodyRows = items.map(item => {
        // Find the lowest non-zero price across all suppliers for this row
        const vals   = SUPPLIERS.map(s => item.costs[s] || 0);
        const active = vals.filter(v => v > 0);
        const minVal = active.length ? Math.min(...active) : -1;

        const supCells = SUPPLIERS.map(s => {
          const v    = item.costs[s] || 0;
          const best = v > 0 && v === minVal;
          return `<td class="num${best ? ' best' : ''}">${v > 0 ? '$' + v.toFixed(2) : '&mdash;'}</td>`;
        }).join('');

        return `<tr>
          <td class="name">${item.item}</td>
          <td class="desc">${item.description}</td>
          ${supCells}
        </tr>`;
      }).join('');

      const html = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>Tony's Pizza — Supplier Price Comparison</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0 }
    body { font-family:Arial,Helvetica,sans-serif; font-size:8.5px; color:#111; padding:14px }
    h1   { font-size:14px; font-weight:bold; margin-bottom:3px }
    .sub { font-size:8.5px; color:#555; margin-bottom:10px }
    .no-print { margin-bottom:10px }
    .btn { padding:5px 16px; font-size:11px; cursor:pointer; border-radius:3px;
           background:#111; color:#fff; border:1px solid #333 }

    /* 7 columns: item · desc · 5 suppliers = 100% */
    table  { width:100%; border-collapse:collapse; table-layout:fixed }
    col.nm { width:25% }
    col.ds { width:20% }
    col.sp { width:11% }   /* 5 × 11% = 55% */

    th { background:#1a1a1a; color:#fff; padding:3px 5px; text-align:center;
         border:0.5px solid #555; font-size:8px; white-space:nowrap }
    th.L { text-align:left }
    td { padding:3px 5px; border:0.5px solid #ccc; font-size:8px; vertical-align:middle }
    td.name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
    td.desc { color:#555; font-size:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
    td.num  { text-align:right; white-space:nowrap }
    td.best { background:#b6f0b6; color:#004400; font-weight:bold }
    tr:nth-child(even) { background:#f5f5f5 }
    tr:nth-child(even) td.best { background:#9de09d }

    thead { display:table-header-group }   /* repeat header on every page */
    tr    { page-break-inside:avoid }

    .legend { margin-top:8px; font-size:8px; color:#444 }
    .swatch { display:inline-block; width:12px; height:10px; background:#b6f0b6;
              border:0.5px solid #aaa; vertical-align:middle; margin-right:3px }

    @media print {
      /* Force the browser to print background colors — without this,
         the green best-price highlight is stripped out on paper. */
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact }
      .no-print { display:none }
      body { padding:0; font-size:8px }
      @page { size:letter portrait; margin:0.45in }
    }
  </style>
</head><body>
  <h1>Tony's Pizza &#x2014; Supplier Price Comparison</h1>
  <div class="sub">Generated ${date} &bull; ${items.length} items</div>
  <div class="no-print">
    <button class="btn" onclick="window.print()">&#x1F5A8;&nbsp; Print</button>
  </div>
  <table>
    <colgroup>
      <col class="nm"><col class="ds">
      ${supCols}
    </colgroup>
    <thead>
      <tr>
        <th class="L">ITEM</th><th class="L">DESCRIPTION</th>
        ${supHdrs}
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="legend"><span class="swatch"></span>Best (lowest) price</div>

  <script>
    /* Auto-open the browser's native print dialog once layout is done.
       This runs inside the browser's own JS context, so it works correctly. */
    setTimeout(function () { window.print(); }, 450);
  </script>
</body></html>`;

      // Write HTML to Downloads, then open in the system default browser.
      // Electron's window.open() restricts window.print() in child windows,
      // but a real browser handles it natively — the embedded script above
      // fires automatically once the page loads.
      try {
        const home    = await window.dashboard.fs.home();
        const outPath = home + '\\Downloads\\tonys-supplier-comparison-print.html';
        await window.dashboard.fs.write(outPath, html);
        await window.dashboard.shell.open(outPath);   // opens in default browser
      } catch (e) {
        alert('Print preview failed: ' + (e.message || e));
      }
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4, padding: '4px 6px', background: 'var(--bg)', overflow: 'hidden' }}>
        {/* Header */}
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div>
            <div className="p-label" style={{ fontSize: 9 }}>SUPPLIER PRICE COMPARISON</div>
            <div style={{ fontSize: 10, color: 'var(--fg-bright)' }}>Tony's Pizza • {items.length} items</div>
          </div>
          <div className="p-row" style={{ gap: 4 }}>
            <button className="p-btn" style={{ fontSize: 9, padding: '2px 8px' }} onClick={resetToDefaults}>
              RESET
            </button>
            <button className="p-btn" style={{ fontSize: 9, padding: '2px 8px' }} onClick={() => setShowAddForm(true)}>
              + ADD
            </button>
            <button
              className="p-btn"
              style={{ fontSize: 9, padding: '2px 8px' }}
              onClick={printTable}
            >
              🖨 PRINT
            </button>
            <button
              className="p-btn"
              style={{ fontSize: 9, padding: '2px 8px', background: 'var(--border)', borderColor: 'var(--accent)' }}
              onClick={exportCSV}
            >
              📤 EXPORT CSV
            </button>
          </div>
        </div>

        {/* Search */}
        <div style={{ flexShrink: 0 }}>
          <input 
            className="p-input" 
            placeholder="Search items..." 
            value={searchTerm} 
            onChange={e => setSearchTerm(e.target.value)}
            style={{ width: '100%', fontSize: 11 }}
          />
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elev)', zIndex: 10 }}>
              <tr>
                <th style={{ padding: '3px 4px', textAlign: 'left', borderBottom: '1px solid var(--border)', minWidth: 110 }}>ITEM</th>
                <th style={{ padding: '3px 4px', textAlign: 'left', borderBottom: '1px solid var(--border)', minWidth: 90 }}>DESCRIPTION</th>
                <th style={{ padding: '3px 4px', textAlign: 'center', borderBottom: '1px solid var(--border)', width: 40 }}>QTY</th>
                {SUPPLIERS.map(s => (
                  <th key={s} style={{ padding: '3px 4px', textAlign: 'center', borderBottom: '1px solid var(--border)', minWidth: 55 }}>
                    {s.split(' ').map(w => w[0]).join('')}
                  </th>
                ))}
                <th style={{ padding: '3px 4px', textAlign: 'center', borderBottom: '1px solid var(--border)', width: 50 }}>HIGH</th>
                <th style={{ padding: '3px 4px', textAlign: 'center', borderBottom: '1px solid var(--border)', width: 50 }}>LOW</th>
                <th style={{ padding: '3px 4px', textAlign: 'center', borderBottom: '1px solid var(--border)', width: 50 }}>AVG</th>
                <th style={{ padding: '3px 4px', textAlign: 'right', borderBottom: '1px solid var(--border)', width: 55 }}>TOTAL</th>
                <th style={{ padding: '3px 4px', width: 20 }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={13} style={{ padding: 12, textAlign: 'center', color: 'var(--fg-dim)' }}>
                    No items found. Add some or reset defaults.
                  </td>
                </tr>
              )}
              {filteredItems.map(item => {
                const c = calcForItem(item);
                return (
                  <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '2px 4px', fontWeight: 600, color: 'var(--accent)' }}>{item.item}</td>
                    <td style={{ padding: '2px 4px', color: 'var(--fg-bright)', fontSize: 8 }}>{item.description}</td>
                    <td style={{ padding: '2px 4px', textAlign: 'center' }}>
                      <input 
                        type="number" 
                        value={item.qty} 
                        onChange={e => updateQty(item.id, e.target.value)}
                        className="p-input"
                        style={{ width: 38, fontSize: 9, padding: '1px 2px', textAlign: 'center' }}
                      />
                    </td>
                    {SUPPLIERS.map(s => (
                      <td key={s} style={{ padding: '2px 3px', textAlign: 'center' }}>
                        <input 
                          type="number" 
                          step="0.01"
                          value={item.costs[s] || ''}
                          onChange={e => updateCost(item.id, s, e.target.value)}
                          className="p-input"
                          style={{ 
                            width: 48, 
                            fontSize: 9, 
                            padding: '1px 2px', 
                            textAlign: 'right',
                            background: (item.costs[s] || 0) > 0 ? 'rgba(var(--accent-rgb), 0.1)' : 'var(--bg)'
                          }}
                          placeholder="0"
                        />
                      </td>
                    ))}
                    <td style={{ padding: '2px 4px', textAlign: 'center', color: 'var(--accent-warm)', fontWeight: 600 }}>
                      {c.high > 0 ? c.high.toFixed(2) : '-'}
                    </td>
                    <td style={{ padding: '2px 4px', textAlign: 'center', color: 'var(--accent)' }}>
                      {c.low > 0 ? c.low.toFixed(2) : '-'}
                    </td>
                    <td style={{ padding: '2px 4px', textAlign: 'center', color: 'var(--fg-bright)' }}>
                      {c.avg > 0 ? c.avg.toFixed(2) : '-'}
                    </td>
                    <td style={{ padding: '2px 4px', textAlign: 'right', color: 'var(--accent)', fontWeight: 600 }}>
                      ${c.grandTotal.toFixed(2)}
                    </td>
                    <td style={{ padding: '2px 4px', textAlign: 'center' }}>
                      <button 
                        onClick={() => deleteItem(item.id)}
                        style={{ 
                          background: 'none', 
                          border: 'none', 
                          color: 'var(--danger)', 
                          cursor: 'pointer',
                          fontSize: 10,
                          padding: 0
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot style={{ position: 'sticky', bottom: 0, background: 'var(--bg-elev)', fontWeight: 600 }}>
              <tr>
                <td colSpan={3} style={{ padding: '4px 6px', color: 'var(--fg-bright)' }}>SUPPLIER TOTALS</td>
                {grandTotals.map((total, i) => (
                  <td key={i} style={{ padding: '4px 6px', textAlign: 'center', color: 'var(--accent)' }}>
                    ${total.toFixed(2)}
                  </td>
                ))}
                <td colSpan={5} style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--accent-warm)' }}>
                  BEST DEALS HIGHLIGHTED
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Add Form Modal */}
        {showAddForm && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100
          }}>
            <div style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border-bright)',
              borderRadius: 4,
              padding: 12,
              width: 280
            }}>
              <div className="p-label" style={{ marginBottom: 8 }}>ADD NEW ITEM</div>
              
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 8, color: 'var(--fg-dim)', marginBottom: 2 }}>ITEM NAME</div>
                <input 
                  className="p-input" 
                  value={newItem.item} 
                  onChange={e => setNewItem({ ...newItem, item: e.target.value })}
                  placeholder="e.g. Mozzarella Cheese"
                  style={{ width: '100%' }}
                />
              </div>
              
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 8, color: 'var(--fg-dim)', marginBottom: 2 }}>DESCRIPTION</div>
                <input 
                  className="p-input" 
                  value={newItem.description} 
                  onChange={e => setNewItem({ ...newItem, description: e.target.value })}
                  placeholder="e.g. 1 cs 6 ct 5lb"
                  style={{ width: '100%' }}
                />
              </div>
              
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 8, color: 'var(--fg-dim)', marginBottom: 2 }}>DEFAULT QTY</div>
                <input 
                  type="number" 
                  className="p-input" 
                  value={newItem.qty} 
                  onChange={e => setNewItem({ ...newItem, qty: parseFloat(e.target.value) || 1 })}
                  style={{ width: 80 }}
                />
              </div>

              <div className="p-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <button className="p-btn" style={{ fontSize: 9 }} onClick={() => setShowAddForm(false)}>
                  CANCEL
                </button>
                <button className="p-btn" style={{ fontSize: 9, background: 'var(--border)', borderColor: 'var(--accent)' }} onClick={addItem}>
                  ADD ITEM
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer tip */}
        <div style={{ fontSize: 7, color: 'var(--fg-dim)', textAlign: 'center', flexShrink: 0 }}>
          Edit costs • Auto-calcs HIGH/LOW/AVG • Export CSV for Excel
        </div>
      </div>
    );
  },
};
