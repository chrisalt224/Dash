// Weather — current conditions for a hardcoded lat/lon via Open-Meteo (no API key).
// Polls every 10 minutes, caches the last response in localStorage so the
// widget stays useful when offline.

const LAT = 40.7;
const LON = -74;
const API_URL =
  'https://api.open-meteo.com/v1/forecast' +
  '?latitude=' + LAT +
  '&longitude=' + LON +
  '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m' +
  '&temperature_unit=fahrenheit&wind_speed_unit=mph';

const POLL_MS = 10 * 60 * 1000;
const KEY = 'plugin:weather:cache:v1';

// U+FE0E (variation selector-15) forces text-style rendering instead of
// colorful emoji, so the icons inherit the phosphor-green text color.
const text = (s) => s + '︎';
const WMO = {
  0:  { label: 'clear',              icon: text('☀') },
  1:  { label: 'mostly clear',       icon: text('☀') },
  2:  { label: 'partly cloudy',      icon: text('⛅') },
  3:  { label: 'overcast',           icon: text('☁') },
  45: { label: 'fog',                icon: text('▤') },
  48: { label: 'rime fog',           icon: text('▤') },
  51: { label: 'light drizzle',      icon: text('☂') },
  53: { label: 'drizzle',            icon: text('☂') },
  55: { label: 'heavy drizzle',      icon: text('☂') },
  61: { label: 'light rain',         icon: text('☂') },
  63: { label: 'rain',               icon: text('☂') },
  65: { label: 'heavy rain',         icon: text('☂') },
  71: { label: 'light snow',         icon: text('❄') },
  73: { label: 'snow',               icon: text('❄') },
  75: { label: 'heavy snow',         icon: text('❄') },
  77: { label: 'snow grains',        icon: text('❄') },
  80: { label: 'rain showers',       icon: text('☂') },
  81: { label: 'rain showers',       icon: text('☂') },
  82: { label: 'heavy showers',      icon: text('☂') },
  85: { label: 'snow showers',       icon: text('❄') },
  86: { label: 'heavy snow showers', icon: text('❄') },
  95: { label: 'thunderstorm',       icon: text('⚡') },
  96: { label: 'storm + hail',       icon: text('⚡') },
  99: { label: 'severe storm',       icon: text('⚡') },
};
const condFor = (code) => WMO[code] || { label: 'unknown', icon: '?' };

const fmtAgo = (ts) => {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default {
  id: 'weather',
  name: 'Weather',
  width: 2,
  height: 1,
  component: ({ useState, useEffect }) => {
    const [data, setData] = useState(() => {
      try {
        const cached = JSON.parse(localStorage.getItem(KEY));
        if (cached && typeof cached === 'object' && 'temp' in cached) return cached;
      } catch {}
      return null;
    });
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [, tick] = useState(0);

    useEffect(() => {
      let cancelled = false;
      const fetchOnce = async () => {
        if (!data) setLoading(true);
        try {
          const res = await fetch(API_URL);
          if (!res.ok) throw new Error('http ' + res.status);
          const json = await res.json();
          if (cancelled) return;
          const next = {
            temp: json.current.temperature_2m,
            apparent: json.current.apparent_temperature,
            code: json.current.weather_code,
            humidity: json.current.relative_humidity_2m,
            wind: json.current.wind_speed_10m,
            fetchedAt: Date.now(),
          };
          setData(next);
          localStorage.setItem(KEY, JSON.stringify(next));
          setError(null);
        } catch (e) {
          if (!cancelled) setError(e.message || 'fetch failed');
        } finally {
          if (!cancelled) setLoading(false);
        }
      };
      fetchOnce();
      const id = setInterval(fetchOnce, POLL_MS);
      return () => { cancelled = true; clearInterval(id); };
    }, []);

    // Re-render every 30s so "X ago" stays current
    useEffect(() => {
      const id = setInterval(() => tick((t) => t + 1), 30000);
      return () => clearInterval(id);
    }, []);

    if (loading && !data) {
      return (
        <div className="p-col" style={{ justifyContent: 'center', alignItems: 'center', height: '100%' }}>
          <span className="p-dim">▸ fetching weather...</span>
        </div>
      );
    }

    if (!data) {
      return (
        <div className="p-col" style={{ height: '100%', justifyContent: 'center' }}>
          <div className="p-label">weather</div>
          <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 6 }}>! {error || 'no data'}</div>
        </div>
      );
    }

    const cond = condFor(data.code);

    return (
      <div className="p-col" style={{ height: '100%', justifyContent: 'space-between', gap: 4 }}>
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="p-label">{LAT.toFixed(1)}, {LON.toFixed(1)}</span>
          <span style={{
            fontSize: 9,
            color: error ? 'var(--accent-warm)' : 'var(--fg-dim)',
            letterSpacing: '0.05em',
          }}>{error ? '! ' + error + ' (cached)' : 'updated ' + fmtAgo(data.fetchedAt)}</span>
        </div>

        <div className="p-row" style={{ alignItems: 'center', gap: 14, flex: 1 }}>
          <div style={{
            fontSize: 44,
            color: 'var(--accent)',
            textShadow: 'var(--glow)',
            lineHeight: 1,
            width: 50,
            textAlign: 'center',
            flexShrink: 0,
          }}>{cond.icon}</div>

          <div className="p-col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 30,
              fontWeight: 600,
              color: 'var(--accent)',
              textShadow: 'var(--glow)',
              fontFamily: 'var(--mono)',
              lineHeight: 1.1,
            }}>{Math.round(data.temp)}°F</div>
            <div className="p-accent" style={{ fontSize: 12 }}>{cond.label}</div>
          </div>

          <div className="p-col" style={{
            fontSize: 10,
            color: 'var(--fg-dim)',
            gap: 4,
            textAlign: 'right',
            flexShrink: 0,
            letterSpacing: '0.04em',
          }}>
            <div>feels {Math.round(data.apparent)}°</div>
            <div>{data.humidity}% rh</div>
            <div>{Math.round(data.wind)} mph</div>
          </div>
        </div>
      </div>
    );
  },
};
