'use strict';
/* Route builder: ordered stops -> Google Maps directions link + keyless drive-time estimates
   (geocoding: OpenStreetMap Nominatim, max 1 request/sec, cached in the report; routing: OSRM public demo server).
   Estimates have no live traffic. Pure helpers are exported for Node tests.
   v12: multiple named routes in routes.list; each opens in Google Maps or iTAK. */
(function (root) {
  const enc = encodeURIComponent;
  const filled = stops => (stops || []).filter(s => s && String(s.address || '').trim());
  function mapsUrl(stops) {
    const s = filled(stops).map(x => { const a = String(x.address).trim(), c = parseCoords(a); return c ? c.lat + ',' + c.lon : a; }); if (s.length < 2) return '';
    let u = 'https://www.google.com/maps/dir/?api=1&origin=' + enc(s[0]) + '&destination=' + enc(s[s.length - 1]);
    if (s.length > 2) u += '&waypoints=' + enc(s.slice(1, -1).join('|'));
    return u + '&travelmode=driving';
  }
  // v19: coordinates typed as a stop / address (drop points with no street address). Returns {lat, lon} or null.
  // Accepts "38.8977, -77.0365", "38.8977,-77.0365", "(38.8977 -77.0365)", "38.8977° N, 77.0365° W",
  // DMS like 38°53'51.7"N 77°02'11.4"W, and Google / Apple Maps links with @lat,lng, !3d..!4d.., q= / ll= / query= etc.
  const okLL = (la, lo) => isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
  function coordsFromUrl(u) {
    const num = '([+-]?\\d{1,3}(?:\\.\\d+)?)';
    const pats = [new RegExp('!3d' + num + '!4d' + num), new RegExp('@' + num + ',\\s*' + num),
      new RegExp('[?&](?:q|ll|query|destination|origin|center|daddr|saddr|sll|coordinate)=(?:loc:)?\\s*' + num + '\\s*,\\s*\\+?' + num),
      new RegExp('/(?:search|place|dir)/(?:[^/]*/)*?\\+?' + num + ',\\s*\\+?' + num + '(?:[/?#]|$)')];
    for (const re of pats) { const m = u.match(re); if (m && okLL(+m[1], +m[2])) return { lat: +m[1], lon: +m[2] }; }
    return null;
  }
  const HALF = '([NSEW])?\\s*([+-]?\\d{1,3}(?:\\.\\d+)?)\\s*(?:°|\\s+deg\\b|d\\b)?\\s*(?:(\\d{1,2}(?:\\.\\d+)?)\\s*\')?\\s*(?:(\\d{1,2}(?:\\.\\d+)?)\\s*(?:"|\'\'))?\\s*([NSEW])?';
  const PAIR = new RegExp('^' + HALF + '\\s*[,;/]?\\s*' + HALF + '$', 'i');
  function parseCoords(input) {
    let s = String(input || '').trim(); if (!s || s.length > 2000) return null;
    try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { }
    if (/^(?:https?:\/\/|www\.)|google\.[a-z.]+\/maps|maps\.apple\.com|goo\.gl\//i.test(s)) return coordsFromUrl(s.replace(/ /g, '+'));
    s = s.replace(/^(?:geo:|loc:)/i, '').replace(/[()[\]{}]/g, ' ').replace(/[″“”]/g, '"').replace(/[′’‘]/g, "'").replace(/[º˚]/g, '°')
      .replace(/^\s*(?:lat(?:itude)?\s*[:=]?)/i, '').replace(/,?\s*(?:longitude|long|lng|lon)\s*[:=]?/i, ',').trim();
    const m = s.match(PAIR); if (!m) return null;
    const half = (h1, d, mi, se, h2) => {
      const hemi = (h1 || h2 || '').toUpperCase(); if (h1 && h2) return null;
      let v = Math.abs(+d) + (mi ? +mi / 60 : 0) + (se ? +se / 3600 : 0);
      if (mi && +mi >= 60 || se && +se >= 60) return null;
      if (/^-/.test(d) || hemi === 'S' || hemi === 'W') v = -v;
      return { v, hemi, dec: /\./.test(d) || !!mi };
    };
    let a = half(m[1], m[2], m[3], m[4], m[5]), b = half(m[6], m[7], m[8], m[9], m[10]); if (!a || !b) return null;
    const marked = a.hemi || b.hemi || /°|'|"/.test(s);
    if (!marked && !(a.dec && b.dec)) return null; // "12 34" or a house number is not a coordinate
    if (/[EW]/.test(a.hemi) || /[NS]/.test(b.hemi)) [a, b] = [b, a];
    if (a.hemi && !/[NS]/.test(a.hemi) || b.hemi && !/[EW]/.test(b.hemi)) return null;
    const lat = +a.v.toFixed(7), lon = +b.v.toFixed(7);
    return okLL(lat, lon) ? { lat, lon } : null;
  }
  const fmtLL = c => +c.lat.toFixed(5) + ', ' + +c.lon.toFixed(5);
  const stopName = (s, i) => { const lab = String(s.label || '').trim(); if (lab) return lab; const a = String(s.address || '').trim(); const c = parseCoords(a); return c ? fmtLL(c) : (a.split(',')[0] || 'Stop ' + (i + 1)); };
  const fmtMin = sec => { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  const fmtMi = m => (m / 1609.344).toFixed(1) + ' mi';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let lastGeo = 0;
  // Fills s.geo = {q, lat, lon} (cache: skipped when the address is unchanged). Returns per-leg estimates.
  async function estimate(stops, opt = {}) {
    const f = opt.fetch || root.fetch.bind(root), gap = opt.gap ?? 1100;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('You are offline. Time estimates need an internet connection.');
    const ss = filled(stops); if (ss.length < 2) throw new Error('Enter at least two stops with an address.');
    const get = async url => { let r; try { r = await f(url, { headers: { Accept: 'application/json' } }); } catch (e) { throw new Error('Could not reach the map service (offline?).'); } if (!r.ok) throw new Error('Map service error (' + r.status + '). Try again in a minute.'); return r.json(); };
    for (const [i, s] of ss.entries()) {
      const q = String(s.address).trim();
      const ll = parseCoords(q); if (ll) { s.geo = { q, lat: ll.lat, lon: ll.lon, ll: true }; continue; } // v19: coordinates need no lookup
      if (s.geo && s.geo.q === q && isFinite(s.geo.lat)) continue;
      const wait = lastGeo + gap - Date.now(); if (wait > 0) await sleep(wait); lastGeo = Date.now();
      const j = await get('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + enc(q));
      if (!Array.isArray(j) || !j.length) throw new Error('Address not found: “' + q + '” (stop ' + (stops.indexOf(s) + 1) + '). Try adding city/state, or type coordinates like 38.8977, -77.0365.');
      s.geo = { q, lat: +j[0].lat, lon: +j[0].lon };
    }
    const legs = [];
    for (let i = 0; i < ss.length - 1; i++) {
      const a = ss[i], b = ss[i + 1];
      const j = await get('https://router.project-osrm.org/route/v1/driving/' + a.geo.lon + ',' + a.geo.lat + ';' + b.geo.lon + ',' + b.geo.lat + '?overview=false');
      if (!j || j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('No driving route found from ' + stopName(a, i) + ' to ' + stopName(b, i + 1) + '.');
      legs.push({ from: stopName(a, i), to: stopName(b, i + 1), sec: j.routes[0].duration, m: j.routes[0].distance });
    }
    return { legs, at: Date.now(), sig: sig(stops) };
  }
  // Shared geocoder (Nominatim, max 1 req/sec across the app). Caches {q, lat, lon} on obj.geo; returns it, or null if not found.
  async function geocode(obj, opt = {}) {
    const f = opt.fetch || root.fetch.bind(root), gap = opt.gap ?? 1100, q = String(obj.address || '').trim();
    if (!q) return null;
    const ll = parseCoords(q); if (ll) return (obj.geo && obj.geo.q === q && obj.geo.lat === ll.lat && obj.geo.lon === ll.lon) ? obj.geo : (obj.geo = { q, lat: ll.lat, lon: ll.lon, ll: true }); // v19
    if (obj.geo && obj.geo.q === q && isFinite(obj.geo.lat)) return obj.geo;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('You are offline. Looking up addresses needs an internet connection.');
    const wait = lastGeo + gap - Date.now(); if (wait > 0) await sleep(wait); lastGeo = Date.now();
    let r; try { r = await f('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + enc(q), { headers: { Accept: 'application/json' } }); } catch (e) { throw new Error('Could not reach the map service (offline?).'); }
    if (!r.ok) throw new Error('Map service error (' + r.status + '). Try again in a minute.');
    const j = await r.json(); if (!Array.isArray(j) || !j.length) return null;
    return (obj.geo = { q, lat: +j[0].lat, lon: +j[0].lon });
  }
  const legText = l => fmtMin(l.sec) + ' / ' + fmtMi(l.m);
  const totals = legs => ({ sec: legs.reduce((a, l) => a + l.sec, 0), m: legs.reduce((a, l) => a + l.m, 0) });
  // replace auto legs (auto:true) with fresh ones at the position of the first old auto leg; manual legs stay
  function mergeLegs(legs, est, key) {
    const fresh = est.legs.map(l => ({ leg: l.from + ' → ' + l.to, time: legText(l), auto: true, _k: key() }));
    const first = legs.findIndex(l => l.auto); const manual = legs.filter(l => !l.auto);
    const at = first < 0 ? manual.length : legs.slice(0, first).filter(l => !l.auto).length;
    return manual.slice(0, at).concat(fresh, manual.slice(at));
  }
  // signature of the stops an estimate was computed for; estimates are stale once stops change
  const sig = stops => JSON.stringify(filled(stops).map(x => [String(x.label || '').trim(), String(x.address).trim()]));
  const isStale = ro => !!(ro && ro.est && ro.est.legs && ro.est.legs.length) && ro.est.sig !== sig(ro.stops);
  const freshEst = ro => ro && ro.est && ro.est.legs && ro.est.legs.length && !isStale(ro) ? ro.est : null;
  const blankRoute = (name, legacy) => ({ _k: legacy ? 'legacy-primary' : (root.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)), name: name || '', notes: '', stops: [], legs: [], est: null, alertLabel: 'Restricted', alert: '', legacy: !!legacy });
  const API = { parseCoords, stopName, fmtLL, geocode, sig, isStale, freshEst, mapsUrl, estimate, mergeLegs, legText, totals, fmtMin, fmtMi, blankRoute, filled };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.RouteTools = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------- UI (app.js globals: h, cur, save, refreshUI, rows, bindArr, bindIn, inp, uid, sheet, deliver, loadScript) ---------- */
if (typeof window !== 'undefined') {
  window.routeCard = function routeCard(rt, i, arr, redraw) {
    const R = window.RouteTools, base = 'routes.list.' + i;
    if (!Array.isArray(rt.stops)) rt.stops = [];
    if (!Array.isArray(rt.legs)) rt.legs = [];
    const card = h('div', { class: 'item rsec' });
    const nameIn = inp(base + '.name', 'Route name', { obj: rt, key: 'name', caps: 'words' });
    nameIn.querySelector('input').classList.add('sec-title-in', 'rname');
    const link = h('a', { class: 'btnlink', target: '_blank', rel: 'noopener' }, 'Open in Google Maps');
    const stale = h('div', { class: 'msg bad stale' }, 'Stops changed since the last calculation. Recalculate; old times are left out of the report.');
    const msg = h('div', { class: 'msg', role: 'status' }), out = h('div', { class: 'est' });
    const upd = () => {
      const u = R.mapsUrl(rt.stops); link.hidden = !u; if (u) link.href = u;
      stale.hidden = !R.isStale(rt); addBtn.disabled = !!R.isStale(rt);
      itakBtn.disabled = !(rt.stops || []).some(s => s && String(s.address || '').trim());
    };
    // Dedicated stops list (not the shared rows helper's tiny add button alone) so new routes always show a clear Add stop.
    let drawEst = () => {};
    const stopsEl = h('div', { class: 'rstops' });
    const drawStops = bindArr(base + '.stops', stopsEl, () => {
      stopsEl.innerHTML = '';
      if (!Array.isArray(rt.stops)) rt.stops = [];
      rt.stops.forEach((row, si) => {
        const sp = base + '.stops.' + si;
        stopsEl.append(h('div', { class: 'item stop' },
          h('div', { class: 'grid2' },
            inp(sp + '.label', 'Stop label', { obj: row, key: 'label' }),
            inp(sp + '.address', 'Address or coordinates', { obj: row, key: 'address', caps: 'none' })),
          h('div', { class: 'tools', style: 'margin-top:8px' },
            si > 0 ? h('button', { class: 'sm', 'aria-label': 'Move stop up', onclick: () => { [rt.stops[si - 1], rt.stops[si]] = [rt.stops[si], rt.stops[si - 1]]; save(); drawStops(); upd(); } }, '↑') : null,
            si < rt.stops.length - 1 ? h('button', { class: 'sm', 'aria-label': 'Move stop down', onclick: () => { [rt.stops[si + 1], rt.stops[si]] = [rt.stops[si], rt.stops[si + 1]]; save(); drawStops(); upd(); } }, '↓') : null,
            h('button', { class: 'danger sm', onclick: () => { rt.stops.splice(si, 1); save(); drawStops(); upd(); } }, 'Remove stop'))));
      });
      if (!rt.stops.length) stopsEl.append(h('div', { class: 'hint' }, 'No stops yet. Add each place in drive order (label + address).'));
      stopsEl.append(h('button', { class: 'primary add-stop', style: 'width:100%;margin-top:6px', onclick: () => {
        rt.stops.push({ label: '', address: '', _k: uid() }); save(); drawStops(); upd();
        const inputs = stopsEl.querySelectorAll('.stop input'); if (inputs.length) inputs[inputs.length - 2].focus();
      } }, '＋ Add stop'));
      drawEst();
    });
    drawStops();
    stopsEl.addEventListener('input', upd);
    link.addEventListener('click', e => {
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) { e.preventDefault(); window.open(link.href, '_system'); }
    });
    const addBtn = h('button', { class: 'sm', onclick: () => {
      const est = rt.est; if (!est || !est.legs || !est.legs.length) return;
      if (!Array.isArray(rt.legs)) rt.legs = [];
      rt.legs = R.mergeLegs(rt.legs, est, uid); save(); refreshUI([base + '.legs']);
      msg.className = 'msg'; msg.textContent = 'Legs updated (manual legs kept).';
    } }, 'Add to legs');
    const stopLabel = (s, i) => R.stopName(s, i);
    const openMaps = (e, url) => {
      if (e) e.preventDefault();
      if (!url) return;
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) window.open(url, '_system');
      else window.open(url, '_blank', 'noopener');
    };
    const openItak = async (btn) => {
      if (btn) btn.disabled = true;
      itakBtn.disabled = true; msg.className = 'msg'; msg.textContent = 'Building iTAK package…';
      try {
        const M = window.MapExport;
        if (!window.fflate) await loadScript('lib/fflate.min.js');
        const res = await M.collectOne(rt);
        if (res.changed) save();
        if (!res.groups.length) throw new Error('Add at least one stop with an address that can be found on the map.');
        const title = M.safeName((cur.header && cur.header.title) || cur.name) + ' — ' + M.safeName(rt.name || 'Route');
        await deliver(new Blob([M.zip(M.buildTAK(title, res.groups))], { type: 'application/zip' }), title + '.zip', 'application/zip');
        msg.textContent = res.groups[0].items.length + ' point(s) ready for iTAK.' + (res.skipped.length ? ' Not found (left out): ' + res.skipped.join(', ') + '.' : '');
        if (res.skipped.length) msg.className = 'msg bad';
      } catch (e) { msg.className = 'msg bad'; msg.textContent = e.message || String(e); }
      finally { itakBtn.disabled = false; if (btn) btn.disabled = false; upd(); }
    };
    drawEst = () => {
      const est = R.freshEst(rt); // chart uses fresh estimate only (stale omitted)
      out.innerHTML = '';
      addBtn.hidden = !(rt.est && rt.est.legs && rt.est.legs.length);
      const filled = R.filled(rt.stops);
      if (!filled.length) return;
      const rUrl = R.mapsUrl(rt.stops);
      const tbl = h('table', { class: 'rchart' });
      tbl.append(h('thead', {}, h('tr', {},
        ...['Route', 'Start', 'Stop', 'Calculated time', 'Distance', 'Google', 'iTAK'].map(t => h('th', {}, t)))));
      const tb = h('tbody');
      const last = filled.length - 1;
      const tt = est ? R.totals(est.legs) : null;
      const gCell = rUrl
        ? h('a', { href: rUrl, class: 'btnlink', target: '_blank', rel: 'noopener', onclick: e => openMaps(e, rUrl) }, 'Open')
        : '';
      const iCell = h('button', { class: 'sm', type: 'button', onclick: ev => openItak(ev.currentTarget) }, 'iTAK');
      tb.append(h('tr', {},
        h('td', {}, h('b', {}, rt.name || 'Route')),
        h('td', {}, stopLabel(filled[0], 0)),
        h('td', {}, stopLabel(filled[last], last)),
        h('td', {}, tt ? R.fmtMin(tt.sec) : ''),
        h('td', {}, tt ? R.fmtMi(tt.m) : ''),
        h('td', {}, gCell),
        h('td', {}, iCell)));
      tbl.append(tb);
      out.append(tbl);
      if (est) out.append(h('div', { class: 'hint' }, 'Estimates: no live traffic (OpenStreetMap / OSRM).'));
    };
    const calc = h('button', { class: 'sm', onclick: async () => {
      calc.disabled = true; msg.className = 'msg'; msg.textContent = 'Calculating…';
      try { rt.est = await R.estimate(rt.stops); save(); drawEst(); upd(); msg.textContent = ''; }
      catch (e) { save(); msg.className = 'msg bad'; msg.textContent = e.message || String(e); }
      finally { calc.disabled = false; }
    } }, 'Calculate times');
    const itakBtn = h('button', { class: 'sm', onclick: () => openItak(itakBtn) }, 'Open in iTAK');
    const legsEl = rows(base + '.legs', [['leg', 'Leg'], ['time', 'Time / distance']], 'Add leg', 'grid');
    bindArr(base + '.stops', link, () => { upd(); drawEst(); });
    bindArr(base + '.est', out, () => { drawEst(); upd(); });
    // Name edits should refresh the Route column without remounting the card
    nameIn.addEventListener('input', drawEst);
    stopsEl.addEventListener('input', () => { upd(); drawEst(); });
    upd(); drawEst();
    const tools = h('div', { class: 'tools', style: 'margin-top:8px' },
      i > 0 ? h('button', { class: 'sm', 'aria-label': 'Move up', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); redraw(); } }, '↑') : null,
      i < arr.length - 1 ? h('button', { class: 'sm', 'aria-label': 'Move down', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); redraw(); } }, '↓') : null,
      h('button', { class: 'danger sm', onclick: () => sheet('Remove route “' + (rt.name || 'Untitled') + '”?', [['Remove route', () => { arr.splice(arr.indexOf(rt), 1); save(); redraw(); }, 'danger']]) }, 'Remove route'));
    card.append(
      nameIn,
      h('div', { class: 'blk-h' }, 'Stops'), h('div', { class: 'hint' }, 'Places in drive order — label + address. For a drop point with no address, type its coordinates (38.8977, -77.0365) or paste a Google Maps pin link.'),
      stopsEl,
      out,
      h('div', { class: 'row' }, link, itakBtn, calc, addBtn), msg, stale,
      h('div', { class: 'blk-h' }, 'Legs'), h('div', { class: 'hint' }, 'Optional typed lines for the report (or tap Add to legs after Calculate times).'),
      legsEl,
      inp(base + '.notes', 'Notes (one per line, “Label: text”)', { area: true, rows: 3, obj: rt, key: 'notes' }),
      inp(base + '.alertLabel', 'Callout label', { obj: rt, key: 'alertLabel' }),
      inp(base + '.alert', 'Restricted / alert callout', { area: true, rows: 2, obj: rt, key: 'alert' }),
      tools);
    return card;
  };
  window.routesEditor = function routesEditor() {
    const wrap = h('div', { class: 'rlist' });
    const cards = new Map(); // _k -> card DOM (reuse across remounts so focus/stops survive)
    const draw = bindArr('routes.list', wrap, () => {
      const arr = cur.routes.list;
      const keep = new Set();
      const frag = document.createDocumentFragment();
      arr.forEach((rt, i) => {
        const k = rt._k || ('idx-' + i);
        keep.add(k);
        let card = cards.get(k);
        // Rebuild when index changed (bind paths use routes.list.<i>) or card missing
        if (!card || card.dataset.idx !== String(i)) {
          card = window.routeCard(rt, i, arr, draw);
          card.dataset.k = k; card.dataset.idx = String(i);
          cards.set(k, card);
        }
        frag.append(card);
      });
      for (const [k, c] of [...cards]) if (!keep.has(k)) { cards.delete(k); c.remove(); }
      wrap.replaceChildren(frag);
      if (!arr.length) wrap.append(h('div', { class: 'hint' }, 'Add a named route for each path (Primary, Alternate, Airport…). Each route has its own stops — tap ＋ Add stop, then Open in Google Maps or iTAK.'));
      wrap.append(h('button', { class: 'primary add-route', style: 'width:100%;margin-top:8px', onclick: () => {
        const first = !arr.length;
        const item = window.RouteTools.blankRoute(first ? 'Primary' : 'Route ' + (arr.length + 1), first);
        if (!first) item._k = uid();
        if (!Array.isArray(item.stops)) item.stops = [];
        if (!Array.isArray(item.legs)) item.legs = [];
        // Start with one empty stop so label/address fields are immediately visible
        if (!item.stops.length) item.stops.push({ label: '', address: '', _k: uid() });
        arr.push(item); save(); draw();
        const card = wrap.querySelectorAll('.rsec'); const last = card[card.length - 1];
        const stopIn = last && last.querySelector('.stop input');
        if (stopIn) stopIn.focus();
        else { const ts = wrap.querySelectorAll('.rname'); if (ts.length) ts[ts.length - 1].focus(); }
      } }, '＋ Add route'));
    });
    draw();
    return h('div', {}, wrap, photoBlock('Route photos (shared)', 'routes.photos'));
  };
  // Back-compat alias used by older tests / callers
  window.routeBuilder = function routeBuilder() { return window.routesEditor(); };
}
