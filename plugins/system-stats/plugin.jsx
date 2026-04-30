// Example plugin: shows uptime and a fake "load" gauge that updates every second.
// Demonstrates: useState, useEffect, basic styling helper classes.

export default {
  id: 'system-stats',
  name: 'System Stats',
  width: 1,
  height: 1,
  component: ({ useState, useEffect }) => {
    const [uptime, setUptime] = useState(0);
    const [load, setLoad] = useState(0.42);

    useEffect(() => {
      const start = Date.now();
      const id = setInterval(() => {
        setUptime(Math.floor((Date.now() - start) / 1000));
        setLoad((l) => Math.max(0.05, Math.min(0.99, l + (Math.random() - 0.5) * 0.1)));
      }, 1000);
      return () => clearInterval(id);
    }, []);

    const fmt = (s) => {
      const h = Math.floor(s / 3600).toString().padStart(2, '0');
      const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
      const sec = (s % 60).toString().padStart(2, '0');
      return `${h}:${m}:${sec}`;
    };

    const bars = 20;
    const filled = Math.round(load * bars);
    const gauge = '█'.repeat(filled) + '░'.repeat(bars - filled);

    return (
      <div className="p-col">
        <div>
          <div className="p-label">session uptime</div>
          <div className="p-stat-num p-mono">{fmt(uptime)}</div>
        </div>
        <div>
          <div className="p-label">load</div>
          <div className="p-mono p-accent">{gauge} {(load * 100).toFixed(0)}%</div>
        </div>
      </div>
    );
  },
};
