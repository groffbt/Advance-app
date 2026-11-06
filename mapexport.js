'use strict';
/* Locations → Google My Maps (KML) and iTAK/ATAK data package (.zip with MANIFEST/manifest.xml + CoT + route KML).
   Coordinates come from the location's Google Maps link when it has them, else the shared geocoder (cached in .geo). */
(function (root) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const okLL = (la, lo) => isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
  // lat/lng from Google Maps links: /@lat,lng,  !3dlat!4dlng, ?q= / ll= / query= / destination= / center= lat,lng
  function geoFromLink(url) {
    let u = String(url || ''); try { u = decodeURIComponent(u); } catch (e) { }
    const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
    const pats = [new RegExp('!3d' + num + '!4d' + num), new RegExp('@' + num + ',\\s*' + num), new RegExp('[?&](?:q|ll|query|destination|center|daddr|sll)=(?:loc:)?' + num + ',\\s*\\+?' + num)];
    for (const re of pats) { const m = u.match(re); if (m && okLL(+m[1], +m[2])) return { lat: +m[1], lon: +m[2] }; }
    const RT = root.RouteTools; return RT && RT.parseCoords ? RT.parseCoords(url) : null; // v19: plain coordinates / DMS in the map field
  }
  const filledAddr = x => x && (String(x.address || '').trim() || x.map);
  // groups: [{key:'locations'|'route'|'medical', name, items:[{name, desc, lat, lon}]}], skipped: [names]
  async function collect(r, opt = {}) {
    const RT = root.RouteTools, groups = [], skipped = []; let changed = false;
    const locate = async (obj, useLink) => {
      if (useLink) { const g = geoFromLink(obj.map); if (g) return g; }
      const before = obj.geo; const g = await RT.geocode(obj, opt); if (g !== before) changed = true; return g;
    };
    const add = async (key, name, list, toItem, useLink) => {
      const items = [];
      for (const x of list) { if (!filledAddr(x)) continue; const g = await locate(x, useLink); const it = toItem(x, items.length);
        if (g) items.push(Object.assign(it, { lat: g.lat, lon: g.lon, fromLink: !!(useLink && geoFromLink(x.map)) })); else skipped.push(it.name); }
      if (items.length) groups.push({ key, name, items });
    };
    await add('locations', 'Locations', r.locations || [], (l, i) => ({ name: l.name || 'Location ' + (i + 1), desc: [l.address, l.notes].filter(Boolean).join('\n') }), true);
    if (opt.route !== false) {
      const list = (r.routes && Array.isArray(r.routes.list) && r.routes.list.length) ? r.routes.list
        : ((r.routes && r.routes.stops && r.routes.stops.length) ? [{ name: 'Route', stops: r.routes.stops }] : []);
      for (const rt of list) await add('route', rt.name || 'Route', rt.stops || [], (s, i) => ({ name: (i + 1) + '. ' + (s.label || s.address), desc: s.address || '' }));
    }
    if (opt.lodging !== false) { // v18: one marker per unique Location + Address
      const seen = new Map();
      for (const e of (r.lodgingList || [])) { if (!filledAddr(e)) continue; const key = (String(e.location || '').trim() + '|' + String(e.address || '').trim()).toLowerCase(); if (!seen.has(key)) seen.set(key, { obj: e, names: [] }); if (String(e.name || '').trim()) seen.get(key).names.push(e.name.trim()); }
      await add('lodging', 'Lodging', [...seen.values()].map(v => v.obj), (e, i) => { const v = [...seen.values()].find(x => x.obj === e); return { name: e.location || e.address || 'Lodging ' + (i + 1), desc: [e.address, e.phone, v && v.names.length ? 'Staying: ' + v.names.join(', ') : ''].filter(Boolean).join('\n') }; });
    }
    if (opt.medical !== false) await add('medical', 'Medical', (r.medical && r.medical.hospitals) || [], h => ({ name: (h.primary ? 'Primary — ' : '') + (h.name || 'Hospital'), desc: [h.address, h.distance, h.notes].filter(Boolean).join('\n') }));
    return { groups, skipped, changed };
  }
  // one named route only (for the per-route "Open in iTAK" button)
  async function collectOne(rt, opt = {}) {
    const fake = { locations: [], routes: { list: [rt] }, medical: { hospitals: [] } };
    return collect(fake, Object.assign({}, opt, { route: true, medical: false, lodging: false }));
  }
  const STY = { locations: { kml: 'ff0000ff', icon: 'http://maps.google.com/mapfiles/kml/paddle/blu-circle.png', argb: -16776961 },
    route: { kml: 'ff00aa00', icon: 'http://maps.google.com/mapfiles/kml/paddle/grn-circle.png', argb: -16711936 },
    lodging: { kml: 'ffff0080', icon: 'http://maps.google.com/mapfiles/kml/paddle/purple-circle.png', argb: -8388353 },
    medical: { kml: 'ff0000ff', icon: 'http://maps.google.com/mapfiles/kml/paddle/red-cross.png', argb: -65536 } };
  const coord = it => (+it.lon).toFixed(6) + ',' + (+it.lat).toFixed(6) + ',0';
  function buildKML(title, groups) {
    const style = (id, s) => '<Style id="' + id + '"><IconStyle><scale>1.1</scale><Icon><href>' + s.icon + '</href></Icon></IconStyle></Style>';
    let x = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + esc(title) + '</name>' +
      style('locations', STY.locations) + style('route', STY.route) + style('lodging', STY.lodging) + style('medical', STY.medical) +
      '<Style id="routeLine"><LineStyle><color>' + STY.route.kml + '</color><width>4</width></LineStyle></Style>';
    for (const g of groups) {
      x += '<Folder><name>' + esc(g.name) + '</name>';
      for (const it of g.items) x += '<Placemark><name>' + esc(it.name) + '</name><description>' + esc(it.desc) + '</description><styleUrl>#' + g.key + '</styleUrl><Point><coordinates>' + coord(it) + '</coordinates></Point></Placemark>';
      if (g.key === 'route' && g.items.length > 1) x += '<Placemark><name>' + esc(g.name || 'Route') + '</name><styleUrl>#routeLine</styleUrl><LineString><tessellate>1</tessellate><coordinates>' + g.items.map(coord).join(' ') + '</coordinates></LineString></Placemark>';
      x += '</Folder>';
    }
    return x + '</Document></kml>\n';
  }
  const uuid = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  function cot(it, g, uid, now) {
    const t = now.toISOString(), stale = new Date(now.getTime() + 365 * 864e5).toISOString(), s = STY[g.key];
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<event version="2.0" uid="' + uid + '" type="b-m-p-s-m" how="h-g-i-g-o" time="' + t + '" start="' + t + '" stale="' + stale + '">' +
      '<point lat="' + (+it.lat).toFixed(7) + '" lon="' + (+it.lon).toFixed(7) + '" hae="0" ce="9999999" le="9999999"/>' +
      '<detail><contact callsign="' + esc(it.name) + '"/><remarks>' + esc(it.desc) + '</remarks><color argb="' + s.argb + '"/>' +
      '<usericon iconsetpath="COT_MAPPING_SPOTMAP/b-m-p-s-m/' + s.argb + '"/><archive/>' +
      '<precisionlocation altsrc="???" geopointsrc="' + (it.fromLink ? 'USER' : 'GEOCODED') + '"/></detail></event>\n';
  }
  // returns { files: {path: string}, manifest } — zip it with fflate
  function buildTAK(title, groups, now = new Date()) {
    const files = {}, entries = [];
    for (const g of groups) for (const it of g.items) {
      const uid = uuid(), path = uid + '/' + uid + '.cot'; files[path] = cot(it, g, uid, now);
      entries.push('<Content ignore="false" zipEntry="' + path + '"><Parameter name="uid" value="' + uid + '"/><Parameter name="name" value="' + esc(g.name + ': ' + it.name) + '"/></Content>');
    }
    const rts = groups.filter(g => g.key === 'route');
    const used = {};
    for (const rt of rts) {
      if (rt.items.length < 2) continue;
      let base = safeName(rt.name || 'route').replace(/\s+/g, '_') || 'route';
      let p = 'route/' + base + '.kml', n = 2; while (used[p]) { p = 'route/' + base + '-' + (n++) + '.kml'; } used[p] = 1;
      files[p] = buildKML(title + ' — ' + (rt.name || 'Route'), [rt]);
      entries.push('<Content ignore="false" zipEntry="' + p + '"><Parameter name="contentType" value="KML"/><Parameter name="name" value="' + esc(title + ' — ' + (rt.name || 'route')) + '"/><Parameter name="visible" value="true"/></Content>');
    }
    files['MANIFEST/manifest.xml'] = '<?xml version="1.0" encoding="UTF-8"?>\n<MissionPackageManifest version="2"><Configuration>' +
      '<Parameter name="uid" value="' + uuid() + '"/><Parameter name="name" value="' + esc(title) + '"/><Parameter name="onReceiveImport" value="true"/><Parameter name="onReceiveDelete" value="false"/>' +
      '</Configuration><Contents>' + entries.join('') + '</Contents></MissionPackageManifest>\n';
    return files;
  }
  function zip(files) { const F = root.fflate; const o = {}; for (const k in files) o[k] = F.strToU8(files[k]); return F.zipSync(o, { level: 6 }); }
  const placeUrl = l => { const g = geoFromLink(l.map); if (/^https?:\/\//i.test(l.map || '')) return l.map; return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(g ? g.lat + ',' + g.lon : (l.address || l.name || '')); };
  function dirUrl(locs) { // Google allows origin + destination + up to 8 waypoints (10 stops) in a URL
    const pts = locs.filter(l => (l.address || '').trim() || geoFromLink(l.map)).slice(0, 10).map(l => { const g = geoFromLink(l.map); return g ? g.lat + ',' + g.lon : l.address.trim(); });
    if (pts.length < 2) return '';
    return 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(pts[0]) + '&destination=' + encodeURIComponent(pts[pts.length - 1]) + (pts.length > 2 ? '&waypoints=' + encodeURIComponent(pts.slice(1, -1).join('|')) : '') + '&travelmode=driving';
  }
  const safeName = t => (String(t || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Advance');
  const API = { geoFromLink, collect, collectOne, buildKML, buildTAK, zip, placeUrl, dirUrl, safeName, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.MapExport = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------- UI (app.js globals: h, cur, save, deliver, bindArr, loadScript) ---------- */
if (typeof window !== 'undefined') window.mapExportBlock = function mapExportBlock() {
  const M = window.MapExport;
  const incRoute = h('input', { type: 'checkbox', checked: true }), incMed = h('input', { type: 'checkbox', checked: true });
  const msg = h('div', { class: 'msg', role: 'status' }), links = h('div', { class: 'maplinks' });
  const title = () => M.safeName(cur.header.title || cur.name);
  async function run(kind, btn) {
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Looking up coordinates…';
    try {
      const res = await M.collect(cur, { route: incRoute.checked, medical: incMed.checked });
      if (res.changed) save(); // geocodes cached in the report
      if (!res.groups.length) throw new Error('No locations with an address or map link to export.');
      const n = res.groups.reduce((a, g) => a + g.items.length, 0);
      if (kind === 'kml') await deliver(new Blob([M.buildKML(title(), res.groups)], { type: 'application/vnd.google-earth.kml+xml' }), title() + ' locations.kml', 'application/vnd.google-earth.kml+xml');
      else { if (!window.fflate) await loadScript('lib/fflate.min.js'); await deliver(new Blob([M.zip(M.buildTAK(title(), res.groups))], { type: 'application/zip' }), title() + '.zip', 'application/zip'); }
      msg.textContent = n + ' point(s) exported.' + (res.skipped.length ? ' Not found (left out): ' + res.skipped.join(', ') + '.' : '');
      if (res.skipped.length) msg.className = 'msg bad';
    } catch (e) { msg.className = 'msg bad'; msg.textContent = e.message || String(e); }
    finally { btn.disabled = false; }
  }
  const kmlBtn = h('button', { class: 'sm', onclick: () => run('kml', kmlBtn) }, 'Export for Google My Maps');
  const takBtn = h('button', { class: 'sm', onclick: () => run('tak', takBtn) }, 'Export iTAK mission package');
  const drawLinks = () => {
    const locs = (cur.locations || []).filter(l => (l.address || '').trim() || l.map); links.innerHTML = ''; if (!locs.length) return;
    const ext = (href, t) => { const a = h('a', { href, target: '_blank', rel: 'noopener' }, t); a.onclick = e => { if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) { e.preventDefault(); window.open(href, '_system'); } }; return a; };
    const d = M.dirUrl(locs);
    if (d) links.append(h('div', {}, ext(d, 'Open all in Google Maps (directions)')), locs.length > 10 ? h('div', { class: 'hint' }, 'Google Maps links hold up to 10 stops; only the first 10 are included. Use the My Maps export for all of them.') : null);
    links.append(h('div', { class: 'maplist' }, ...locs.map((l, i) => ext(M.placeUrl(l), '📍 ' + (l.name || 'Location ' + (i + 1))))));
  };
  bindArr('locations', links, drawLinks); drawLinks();
  const wrap = h('div', { class: 'pblock mapx' }, h('label', {}, '🗺 Map export'),
    h('label', { class: 'chk' }, incRoute, 'Include all routes'), h('label', { class: 'chk' }, incMed, 'Include hospitals (Medical)'),
    h('div', { class: 'row' }, kmlBtn, takBtn), msg,
    h('div', { class: 'hint' }, 'Google My Maps: open mymaps.google.com, tap Create a new map → Import → choose the .kml file.'),
    h('div', { class: 'hint' }, 'In iTAK, open the file from Files or the share sheet, or use Import → Files.'), links);
  wrap.addEventListener('input', () => setTimeout(drawLinks, 0));
  return wrap;
};
