'use strict';
/* Weather from a US zip code, no API key: Zippopotam.us (zip -> place, lat/lon) + Open-Meteo daily forecast.
   Produces bullets in the report's "Label: text" format. Pure helpers exported for Node tests. */
(function (root) {
  const WMO = { 0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorms', 96: 'Thunderstorms with hail', 99: 'Thunderstorms with hail' };
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  // dates from free text like "29-30SEP2026", "SEP 29-30, 2026", "10/31/2026", "Oct 31 2026", "2026-10-31"
  function parseDates(t) {
    t = String(t || '').toUpperCase(); const out = []; let m;
    const add = (y, mo, d) => { const x = new Date(y, mo, d); if (x.getMonth() === mo && x.getDate() === d) out.push(iso(x)); };
    const range = (y, mo, a, b) => { for (let d = a; d <= Math.min(b ?? a, a + 14); d++) add(y, mo, d); };
    for (m of t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) add(+m[1], +m[2] - 1, +m[3]);
    for (m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)) add(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
    for (m of t.matchAll(/\b(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*([A-Z]{3})[A-Z]*\.?,?\s*'?(\d{2,4})\b/g)) { const mo = MON.indexOf(m[3]); if (mo >= 0) range(+m[4] < 100 ? 2000 + +m[4] : +m[4], mo, +m[1], m[2] && +m[2]); }
    for (m of t.matchAll(/\b([A-Z]{3})[A-Z]*\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?(?:ST|ND|RD|TH)?,?\s+(\d{4})\b/g)) { const mo = MON.indexOf(m[1]); if (mo >= 0) range(+m[4], mo, +m[2], m[3] && +m[3]); }
    return [...new Set(out)].sort();
  }
  function eventDates(r) {
    const days = (r.timeline || []).filter(x => x && x.day).map(x => x.day).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    return [...new Set(days.concat(parseDates(r.header && r.header.date)))].sort();
  }
  const fmtDate = s => pd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtTime = s => { const m = String(s || '').match(/T(\d{2}):(\d{2})/); if (!m) return ''; const hh = +m[1]; return (hh % 12 || 12) + ':' + m[2] + ' ' + (hh < 12 ? 'AM' : 'PM'); };
  async function fetchWeather(zip, wanted, opt = {}) {
    const f = opt.fetch || root.fetch.bind(root); zip = String(zip || '').trim();
    if (!/^\d{5}$/.test(zip)) throw new Error('Enter a 5-digit US zip code.');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('You are offline. Weather needs an internet connection.');
    const get = async (url, nf) => { let r; try { r = await f(url); } catch (e) { throw new Error('Could not reach the weather service (offline?).'); } if (r.status === 404 && nf) throw new Error(nf); if (!r.ok) throw new Error('Weather service error (' + r.status + '). Try again later.'); return r.json(); };
    const z = await get('https://api.zippopotam.us/us/' + zip, 'Zip code ' + zip + ' was not found.');
    const pl = z && z.places && z.places[0]; if (!pl) throw new Error('Zip code ' + zip + ' was not found.');
    const place = { name: pl['place name'] + ', ' + pl['state abbreviation'] + ' ' + zip, lat: +pl.latitude, lon: +pl.longitude };
    const w = await get('https://api.open-meteo.com/v1/forecast?latitude=' + place.lat + '&longitude=' + place.lon +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=16');
    const d = w && w.daily; if (!d || !Array.isArray(d.time) || !d.time.length) throw new Error('No forecast returned. Try again later.');
    return build(place, d, wanted || [], opt.now || new Date());
  }
  function build(place, d, wanted, now) {
    const idx = wanted.map(x => d.time.indexOf(x)).filter(i => i >= 0);
    let note = '';
    if (!idx.length) { for (let i = 0; i < Math.min(3, d.time.length); i++) idx.push(i); note = wanted.length ? 'Event dates are outside the forecast window. Forecast available up to 16 days out; showing the next few days.' : 'No event dates found (header date or timeline days). Forecast available up to 16 days out; showing the next few days.'; }
    else if (idx.length < wanted.length) note = 'Some event dates are beyond the forecast window (up to 16 days out).';
    const v = (k, i) => (d[k] && d[k][i] != null ? d[k][i] : null);
    const bullets = ['Location: ' + place.name];
    for (const i of idx) {
      const parts = [WMO[v('weather_code', i)] || 'Weather code ' + v('weather_code', i)];
      if (v('temperature_2m_max', i) != null) parts.push('High ' + Math.round(v('temperature_2m_max', i)) + '°F / Low ' + Math.round(v('temperature_2m_min', i)) + '°F');
      if (v('precipitation_probability_max', i) != null) parts.push(Math.round(v('precipitation_probability_max', i)) + '% rain');
      if (v('wind_speed_10m_max', i) != null) parts.push('wind ' + Math.round(v('wind_speed_10m_max', i)) + ' mph' + (v('wind_gusts_10m_max', i) != null ? ' (gusts ' + Math.round(v('wind_gusts_10m_max', i)) + ')' : ''));
      bullets.push(fmtDate(d.time[i]) + ': ' + parts.join(', '));
      if (v('sunrise', i)) bullets.push('Sunrise/Sunset' + (idx.length > 1 ? ' ' + fmtDate(d.time[i]).replace(/^\w+, /, '') : '') + ': ' + fmtTime(v('sunrise', i)) + ' / ' + fmtTime(v('sunset', i)));
    }
    bullets.push('Updated: ' + now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (Open-Meteo)');
    return { bullets, note, place };
  }
  const API = { parseDates, eventDates, fetchWeather, build, WMO };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.WeatherTools = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------- UI (app.js globals: h, $, cur, save, refreshUI, inp) ---------- */
if (typeof window !== 'undefined') window.weatherFetcher = function weatherFetcher() {
  const W = window.WeatherTools;
  const msg = h('div', { class: 'msg', role: 'status' });
  const btn = h('button', { class: 'sm', onclick: async () => {
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Getting weather…';
    try {
      const res = await W.fetchWeather(cur.weatherZip, W.eventDates(cur)); msg.textContent = ''; const s = $('#sheet'); s.innerHTML = ''; s.hidden = false;
      const apply = mode => { const old = (cur.weather || []).filter(x => String(x).trim()); cur.weather = mode === 'add' ? old.concat(res.bullets) : res.bullets.slice(); save(); refreshUI(['weather']); s.hidden = true; msg.className = 'msg'; msg.textContent = 'Weather ' + (mode === 'add' ? 'added' : 'updated') + ' for ' + res.place.name + '.'; };
      s.append(h('div', { class: 'pv' }, h('h3', { style: 'margin:0 0 6px' }, 'Weather for ' + res.place.name),
        res.note ? h('div', { class: 'hint pv-note' }, res.note) : null,
        h('div', { class: 'pv-list' }, ...res.bullets.map(b => h('div', { class: 'pv-row' }, b))),
        h('div', { class: 'hint' }, 'Source: Open-Meteo forecast (open-meteo.com), place from Zippopotam.us.'),
        h('button', { class: 'primary', onclick: () => apply('replace') }, 'Replace weather'),
        h('button', { onclick: () => apply('add') }, 'Add to existing'),
        h('button', { onclick: () => (s.hidden = true) }, 'Cancel')));
      s.onclick = e => { if (e.target === s) s.hidden = true; };
    } catch (e) { msg.className = 'msg bad'; msg.textContent = e.message || String(e); }
    finally { btn.disabled = false; }
  } }, 'Get weather');
  const zip = inp('weatherZip', 'Zip code (US)', { caps: 'none' }); const zi = zip.querySelector('input'); zi.setAttribute('inputmode', 'numeric'); zi.setAttribute('maxlength', '5'); zi.setAttribute('autocomplete', 'postal-code');
  return h('div', { class: 'wx' }, h('div', { class: 'wx-row' }, zip, btn), msg, h('div', { class: 'hint' }, 'Forecast from Open-Meteo for the report’s dates (timeline days / header date), up to 16 days out.'));
};
