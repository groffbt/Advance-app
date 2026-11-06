'use strict';
/* Advance Report PWA. Local reports stay on this device (IndexedDB). Team reports sync via Firebase (team.js), only when signed in. */
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const APP_VERSION = 'v19';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('advance-reports', 2);
    r.onupgradeneeded = () => { const d = r.result; for (const n of ['reports', 'photos', 'tphotos']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); }; // tphotos = cache of team photos
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store); let out;
    const q = fn(s); if (q) q.onsuccess = () => (out = q.result);
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const DB = {
  all: () => tx('reports', 'readonly', s => s.getAll()),
  get: id => tx('reports', 'readonly', s => s.get(id)),
  put: r => tx('reports', 'readwrite', s => s.put(r)),
  del: id => tx('reports', 'readwrite', s => s.delete(id)),
  photo: id => tx('photos', 'readonly', s => s.get(id)),
  putPhoto: p => tx('photos', 'readwrite', s => s.put(p)),
  delPhoto: id => tx('photos', 'readwrite', s => s.delete(id)),
};
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------- Model ---------- */
function blank() {
  return {
    id: uid(), name: 'New Advance', folderId: null, updated: Date.now(),
    header: { org: '', title: '', date: '', venue: '', principal: '', city: '', advance: '', photoSize: '' },
    overview: { text: '', principals: '' }, weather: [''], weatherZip: '',
    intel: { eventRisk: '', eventText: '', areaName: '', areaRisk: '', areaText: '', movement: '', protest: '', contingency: '', sections: [], pages: { photos: [] }, figures: { photos: [] } },
    taskOrg: { advance: '', movement: '', night: '', columns: defaultCols() },
    vehicles: [], timelineZone: 'LOCAL', timeline: [], contacts: [], locations: [],
    routes: { list: [], notes: '', legs: [], alertLabel: 'Restricted', alert: '', photos: [], stops: [], est: null }, arrival: '', arrivalMedia: { photos: [] }, photoSections: [],
    coordination: [''], lodging: '', lodgingList: [], medical: { label: '', hospitals: [], sections: [], pages: { photos: [] }, figures: { photos: [] } }
  };
}
// Task org columns. The first three keep stable keys and mirror into the legacy advance/movement/night fields so
// team members still on v8 (which only know those fields) keep seeing and editing the same names.
const LEGACY_COLS = [['advance', 'Advance'], ['movement', 'Movement'], ['night', 'Night']];
function defaultCols(t = {}) { return LEGACY_COLS.map(([k, title]) => ({ _k: 'legacy-' + k, title, names: t[k] || '', legacy: k })); }
function migrateTaskOrg(r) {
  const t = r.taskOrg || (r.taskOrg = {});
  if (!Array.isArray(t.columns)) t.columns = defaultCols(t);
  for (const c of t.columns) { c.title ??= ''; c.names ??= ''; if (c.legacy && typeof t[c.legacy] === 'string' && t[c.legacy] !== c.names) c.names = t[c.legacy]; } // a v8 device edited the legacy field
  for (const [k] of LEGACY_COLS) { t[k] ??= ''; if (!t.columns.some(c => c.legacy === k)) t[k] = ''; }
}
// Intel = user-defined sections [{_k, title, risk, text}]. Sections migrated from the v9 fixed fields keep fixed keys
// ('legacy-event', …) and a legacy tag; they mirror both ways into the old fields so v8/v9 phones in a team keep working.
const LEGACY_INTEL = () => window.AdvImport.LEGACY_INTEL;
function migrateIntel(r) {
  const i = r.intel || (r.intel = {});
  for (const d of LEGACY_INTEL()) for (const k of [d[2], d[3]]) if (k) i[k] ??= ''; i.areaName ??= '';
  if (!Array.isArray(i.sections)) i.sections = window.AdvImport.intelLegacyToSections(i, true);
  for (const x of i.sections) { x._k ||= uid(); x.title ??= ''; x.risk ??= ''; x.text ??= ''; }
  for (const d of LEGACY_INTEL()) { // an older phone edited a legacy field -> adopt it (or re-create the section)
    const [id, , rk, tk] = d; let x = i.sections.find(s => s.legacy === id);
    const lt = id === 'area' ? (i.areaName || 'Area') : null;
    if (!x) { const n = window.AdvImport.intelLegacyToSections(i, true).find(s => s.legacy === id); if (n) i.sections.push(n); continue; }
    if (i[tk] !== x.text) x.text = i[tk];
    if (rk && i[rk] !== x.risk) x.risk = RISKS.includes(i[rk]) ? i[rk] : x.risk;
    if (lt && lt !== x.title && !(lt === 'Area' && !x.title)) x.title = lt;
  }
}
function mirrorIntel(i) { // write legacy sections back into the old fields (cleared when the section is gone)
  if (!i || !Array.isArray(i.sections)) return;
  for (const [id, , rk, tk] of LEGACY_INTEL()) {
    const x = i.sections.find(s => s.legacy === id);
    i[tk] = x ? x.text : ''; if (rk) i[rk] = x ? x.risk : '';
    if (id === 'area') i.areaName = x && x.title !== 'Area' ? x.title : '';
  }
}
// Routes = named list [{_k, name, notes, stops, legs, est, alertLabel, alert}]. Shared photos stay on routes.photos.
// The first/legacy route mirrors into the top-level stops/legs/est/notes/alert fields so older team phones keep working.
function makeLegacyRoute(ro) {
  return { _k: 'legacy-primary', name: 'Primary', notes: ro.notes || '', stops: clone(ro.stops || []), legs: clone(ro.legs || []),
    est: ro.est ? clone(ro.est) : null, alertLabel: ro.alertLabel || 'Restricted', alert: ro.alert || '', legacy: true };
}
function migrateRoutes(r) {
  const ro = r.routes || (r.routes = {});
  ro.photos ||= []; if (!Array.isArray(ro.stops)) ro.stops = []; if (!Array.isArray(ro.legs)) ro.legs = [];
  if (ro.est === undefined) ro.est = null; ro.notes ??= ''; ro.alert ??= ''; ro.alertLabel ??= 'Restricted';
  if (!Array.isArray(ro.list)) ro.list = [];
  let leg = ro.list.find(x => x && (x.legacy || x._k === 'legacy-primary'));
  const hasLegacy = !!(ro.stops.length || ro.legs.length || ro.notes || ro.alert || ro.est);
  if (!leg && hasLegacy) { leg = makeLegacyRoute(ro); ro.list.unshift(leg); }
  else if (leg) {
    // Older phone edited top-level → adopt into the legacy route. Never wipe list content with an empty top-level
    // (blank Object.assign / partial sync used to clear stops and make the route card look like it vanished).
    const J = JSON.stringify;
    const adoptArr = (top, cur) => {
      if (J(top) === J(cur)) return cur;
      if ((top && top.length) || !(cur && cur.length)) return clone(top || []);
      return cur;
    };
    leg.stops = adoptArr(ro.stops, leg.stops);
    leg.legs = adoptArr(ro.legs, leg.legs);
    if (J(ro.est) !== J(leg.est)) {
      if (ro.est || !leg.est) leg.est = ro.est ? clone(ro.est) : null;
    }
    if (ro.notes !== leg.notes) { if (ro.notes || !leg.notes) leg.notes = ro.notes || ''; }
    if (ro.alert !== leg.alert) { if (ro.alert || !leg.alert) leg.alert = ro.alert || ''; }
    if (ro.alertLabel !== leg.alertLabel && (ro.alertLabel || !leg.alertLabel)) leg.alertLabel = ro.alertLabel || 'Restricted';
  }
  for (const x of ro.list) {
    x._k ||= uid(); x.name ??= ''; x.notes ??= ''; x.alert ??= ''; x.alertLabel ??= 'Restricted';
    if (!Array.isArray(x.stops)) x.stops = []; if (!Array.isArray(x.legs)) x.legs = [];
    if (x.est === undefined) x.est = null;
    if (x.legacy || x._k === 'legacy-primary') x.legacy = true;
    for (const a of [x.stops, x.legs]) a.forEach(it => { if (it && typeof it === 'object') it._k ||= uid(); });
  }
  mirrorRoutes(ro); // keep top-level legacy fields aligned with the list (fills empty top from list)
}
function mirrorRoutes(ro) { // write legacy/first route back into top-level fields
  if (!ro || !Array.isArray(ro.list)) return;
  const leg = ro.list.find(x => x.legacy || x._k === 'legacy-primary') || ro.list[0];
  if (!leg) { ro.stops = []; ro.legs = []; ro.est = null; ro.notes = ''; ro.alert = ''; return; }
  ro.stops = clone(leg.stops || []); ro.legs = clone(leg.legs || []); ro.est = leg.est ? clone(leg.est) : null;
  ro.notes = leg.notes || ''; ro.alert = leg.alert || ''; ro.alertLabel = leg.alertLabel || 'Restricted';
}
function migrate(r) { // old format: r.photos + r.dropLabel -> one titled section
  if (!Array.isArray(r.photoSections)) r.photoSections = [];
  if (Array.isArray(r.photos)) { if (r.photos.length) r.photoSections.unshift({ id: uid(), title: 'Drop Site — Event', photos: r.photos }); }
  delete r.photos; delete r.dropLabel;
  r.photoSections.forEach(sc => { sc.id ||= uid(); sc.title ??= ''; });
  for (const k of ['intel', 'medical']) if (r[k]) for (const f of ['pages', 'figures']) if (!r[k][f] || !Array.isArray(r[k][f].photos)) r[k][f] = { photos: [] }; // imported original PDF pages / charts & maps
  if (!r.arrivalMedia || !Array.isArray(r.arrivalMedia.photos)) r.arrivalMedia = { photos: [] };
  if (r.routes) { r.routes.photos ||= []; if (!Array.isArray(r.routes.stops)) r.routes.stops = []; if (!Array.isArray(r.routes.legs)) r.routes.legs = []; if (r.routes.est === undefined) r.routes.est = null; }
  (r.locations || []).forEach(l => { l.notes ??= ''; l.photos ||= []; });
  holders(r).forEach(hd => { hd.photos ||= []; hd.photos.forEach(p => (p.caption ??= '')); });
  return r;
}
// every object that owns a .photos array
function stripForTemplate(r) {
  const n = normalize(clone(r));
  delete n.id; delete n._team; delete n._template; n.folderId = null;
  for (const hd of holders(n)) hd.photos = [];
  // keep only synced report fields (+ name)
  const out = { name: n.name || 'Template' };
  for (const k of SYNC_KEYS) if (k !== 'folderId') out[k] = n[k];
  return out;
}
function rekeyDeep(x) {
  if (Array.isArray(x)) { x.forEach(rekeyDeep); return x; }
  if (!x || typeof x !== 'object') return x;
  if (typeof x._k === 'string') x._k = uid();
  if (typeof x.id === 'string') x.id = uid();
  for (const k of Object.keys(x)) if (k !== 'geo' && k !== 'est' && k !== 'legacy') rekeyDeep(x[k]);
  return x;
}
function useTemplate(t, tmpl, folderId) {
  const raw = fromForm(clone(tmpl.data || {}));
  const r = normalize(Object.assign(blank(), raw));
  r.id = uid(); r.name = tmpl.name || 'From template'; r.folderId = folderId != null ? folderId : (tmpl.folderId || null);
  r.updated = Date.now(); rekeyDeep(r); for (const hd of holders(r)) hd.photos = [];
  Cloud.createReport(t.id, r).catch(e => alert('Could not create report: ' + e.message));
  location.hash = '#t/' + t.id + '/' + r.id;
}
function saveAsTemplate(r, folderId) {
  const t = Cloud.active; if (!t || !r) return;
  const id = uid();
  const data = stripForTemplate(r);
  Cloud.saveTemplate(t.id, { id, isNew: true, name: (r.name || 'Template') + ' template', folderId: folderId != null ? folderId : (r.folderId || null), data })
    .then(() => alert('Template saved to the team.'))
    .catch(e => alert('Could not save template: ' + e.message));
}

function holders(r) { return [r.arrivalMedia, r.routes, ...(r.locations || []), ...(r.photoSections || []), r.intel && r.intel.pages, r.medical && r.medical.pages, r.intel && r.intel.figures, r.medical && r.medical.figures].filter(Boolean); }
const allPhotos = r => holders(r).flatMap(hd => hd.photos || []);
function normalize(r) {
  migrate(r); const b = blank(); for (const k in b) if (r[k] == null) r[k] = b[k]; for (const k of ['header', 'overview', 'intel', 'taskOrg', 'routes', 'medical']) r[k] = Object.assign(clone(b[k]), r[k]); migrateTaskOrg(r); migrateIntel(r); migrateRoutes(r); if (!Array.isArray(r.medical.sections)) r.medical.sections = []; r.medical.sections.forEach(x => { x._k ||= uid(); x.title ??= ''; x.text ??= ''; });
  if (!Array.isArray(r.lodgingList)) r.lodgingList = [];
  for (const a of [r.vehicles, r.timeline, r.contacts, r.locations, r.lodgingList, r.routes.legs, r.routes.stops, r.medical.hospitals, r.routes.list]) if (Array.isArray(a)) a.forEach(x => { if (x && typeof x === 'object') x._k ||= uid(); }); // stable item keys for live merging
  return r;
}
const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setP = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] == null || typeof a[k] !== 'object' ? (a[k] = {}) : a[k]), o)[last] = v; };
const J = JSON.stringify;
const related = (a, b) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
// leaf paths (plain objects recurse; arrays and values are leaves) where two reports differ, limited to synced keys
function diffPaths(a, b, pre = '', out = []) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (pre || SYNC_KEYS.includes(k)) diffPaths(a[k], b[k], pre ? pre + '.' + k : k, out); }
  else if (J(a) !== J(b)) out.push(pre);
  return out;
}

/* ---------- Photos ---------- */
async function compress(file, max = 1600, q = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * s), hh = Math.round(img.naturalHeight * s);
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, hh); x.drawImage(img, 0, 0, w, hh);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', q));
    return { blob, w, h: hh };
  } finally { URL.revokeObjectURL(url); }
}
const toDataURL = blob => new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(blob); });
function dataURLtoBlob(d) { const [m, b] = d.split(','); const bin = atob(b); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: m.slice(5).split(';')[0] }); }
// Photo store. Local reports: blobs in IndexedDB. Team reports (r._team): one Firestore doc per photo holding a
// JPEG data URL (<= ~1280px, q~0.7, kept under 1 MB), cached on-device in the tphotos store.
async function teamJpeg(file) {
  for (const [max, q] of [[1280, 0.7], [1280, 0.55], [1024, 0.5], [800, 0.45]]) {
    const c = await compress(file, max, q); const data = await toDataURL(c.blob);
    if (data.length < 900000) return Object.assign(c, { data });
  }
  throw new Error('Photo too large');
}
const P = {
  async get(r, id) {
    if (!r._team) return DB.photo(id);
    const hit = await tx('tphotos', 'readonly', s => s.get(id)); if (hit) return hit;
    const d = await Cloud.getPhoto(r._team, r.id, id); if (!d || !d.data) return null;
    const rec = { id, blob: dataURLtoBlob(d.data) }; tx('tphotos', 'readwrite', s => s.put(rec)).catch(() => {}); return rec;
  },
  async add(r, file) { // returns photo meta {id, w, h, caption}
    const id = uid();
    if (!r._team) { const { blob, w, h: hh } = await compress(file); await DB.putPhoto({ id, blob }); return { id, w, h: hh, caption: '' }; }
    const { blob, w, h: hh, data } = await teamJpeg(file);
    await tx('tphotos', 'readwrite', s => s.put({ id, blob }));
    Cloud.putPhoto(r._team, r.id, id, { data, w, h: hh }).catch(e => console.warn('photo upload', e)); // queued offline
    return { id, w, h: hh, caption: '' };
  },
  async del(r, id) { if (!r._team) return DB.delPhoto(id); await tx('tphotos', 'readwrite', s => s.delete(id)).catch(() => {}); Cloud.delPhoto(r._team, r.id, id); },
};
async function addPhotos(r, arr, files) { for (const f of files) arr.push(await P.add(r, f)); }
async function copyPhotos(list) {
  const out = [];
  for (const p of list) { const rec = await DB.photo(p.id); if (!rec) continue; const id = uid(); await DB.putPhoto({ id, blob: rec.blob }); out.push(Object.assign({}, p, { id })); }
  return out;
}

/* ---------- Seed sample ---------- */
async function seed() { /* public build: no bundled sample */ }

/* ---------- Views ---------- */
let cur = null, saveT = null;
let base = null, binds = [], unsubs = [], lastMeta = null; const stale = new Set();
const clearSubs = () => unsubs.splice(0).forEach(f => { try { f(); } catch (e) { } });
const view = $('#view');
function bar(title, back) { $('#barTitle').textContent = title; $('#back').hidden = !back; $('#saved').textContent = ''; $('#saved').className = ''; }
$('#back').onclick = () => { flush(); location.hash = ''; };
$('#acct').onclick = () => { flush(); location.hash = '#account'; };
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => flush());
document.addEventListener('visibilitychange', () => document.hidden && flush());

function sheet(title, buttons) {
  const s = $('#sheet'); s.innerHTML = ''; s.hidden = false;
  const box = h('div', {}, h('h3', { style: 'margin:0 0 6px' }, title), ...buttons.map(([t, fn, cls]) => h('button', { class: cls || '', onclick: async () => { if (fn) { const keep = await fn(); if (keep === true) return; } s.hidden = true; } }, t)), h('button', { onclick: () => (s.hidden = true) }, 'Cancel'));
  s.append(box); s.onclick = e => { if (e.target === s) s.hidden = true; };
}
const withTimeout = (p, ms) => Promise.race([p.then(() => true), new Promise(res => setTimeout(() => res(false), ms))]);

function reportCard(r, buttons, extra) {
  const open = () => (location.hash = r._team ? '#t/' + r._team + '/' + r.id : '#r/' + r.id);
  return h('div', { class: 'card' + (r._team ? ' team' : '') },
    h('h3', { onclick: open, style: 'cursor:pointer' }, r.name || 'Untitled'),
    h('div', { class: 'muted' }, [r.header && r.header.city, r.header && r.header.date, r.header && r.header.advance].filter(Boolean).join(' · ') || '—'),
    h('div', { class: 'muted' }, 'Edited ' + new Date(r.updated || 0).toLocaleString() + (extra || '')),
    h('div', { class: 'row' }, h('button', { class: 'primary sm', onclick: open }, 'Open'), ...buttons));
}
function newLocal() { const r = blank(); DB.put(r).then(() => (location.hash = '#r/' + r.id)); }
function newTeam(t, folderId) { const r = normalize(blank()); if (folderId) r.folderId = folderId; Cloud.createReport(t.id, r).catch(e => alert('Could not create team report: ' + e.message)); location.hash = '#t/' + t.id + '/' + r.id; }

async function listView() {
  bar('Advance Reports', false); cur = null; base = null;
  const rs = (await DB.all()).sort((a, b) => b.updated - a.updated);
  view.innerHTML = '';
  const teamBox = h('div', { id: 'teamBox' }), localBox = h('div');
  view.append(h('div', { class: 'row', style: 'margin:0 0 12px' },
    h('button', { class: 'primary', style: 'flex:1', onclick: () => { const t = Cloud.user && Cloud.active; if (!t) return newLocal(); const fid = (location.hash.match(/^#f\/(.+)$/) || [])[1]; sheet('Where should the new report live?', [['👥 Team: ' + t.name, () => newTeam(t, fid ? decodeURIComponent(fid) : null), 'primary'], ['📱 This phone only', newLocal]]); } }, '＋ New report'),
    h('button', { onclick: importJSON }, 'Import JSON')), teamBox, localBox);
  const drawLocal = () => {
    const signed = !!(Cloud.user && Cloud.active);
    localBox.replaceChildren(signed || Cloud.user ? h('h2', { class: 'sech' }, '📱 This phone only') : '');
    if (!rs.length) localBox.append(h('p', { class: 'muted' }, 'No reports on this phone yet.'));
    for (const r of rs) localBox.append(reportCard(r, [
      h('button', { class: 'sm', onclick: async () => { const n = normalize(clone(r)); n.id = uid(); n.name = 'Copy of ' + r.name; n.updated = Date.now(); n.photoSections.forEach(sc => (sc.id = uid())); for (const hd of holders(n)) hd.photos = await copyPhotos(hd.photos || []); await DB.put(n); listView(); } }, 'Duplicate'),
      h('button', { class: 'sm', onclick: () => exportJSON(r) }, 'Export'),
      signed ? h('button', { class: 'sm move', onclick: () => moveToTeam(r) }, '👥 Move to team') : null,
      h('button', { class: 'danger sm', onclick: () => sheet('Delete “' + r.name + '”? This cannot be undone.', [['Delete report', async () => { for (const p of allPhotos(normalize(clone(r)))) await DB.delPhoto(p.id); await DB.del(r.id); listView(); }, 'danger']]) }, 'Delete')]));
    localBox.append(h('p', { class: 'hint' }, 'Phone-only reports stay on this device (IndexedDB) and are never uploaded. Team reports sync to everyone in the team. Use Export to back up a report as a file.'));
  };
  drawLocal();
  let repUnsub = null, foldUnsub = null, tmplUnsub = null, repTeam = null;
  let teamRs = [], teamFolders = [], teamTemplates = [];
  const folderHash = () => { const m = location.hash.match(/^#f\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; };
  const moveReportSheet = (r, t) => {
    const opts = [['Unfiled (top level)', async () => { Cloud.updateReport(t.id, r.id, { folderId: null }); }]];
    for (const f of teamFolders) opts.push(['📁 ' + f.name, async () => { Cloud.updateReport(t.id, r.id, { folderId: f.id }); }]);
    sheet('Move “' + (r.name || 'Untitled') + '” to…', opts.map(([label, fn], i) => [label, fn, i === 0 ? '' : '']));
  };
  const teamReportButtons = (r, t) => [
    h('button', { class: 'sm', onclick: () => exportJSON(r) }, 'Export'),
    h('button', { class: 'sm', onclick: () => moveReportSheet(r, t) }, 'Move'),
    h('button', { class: 'sm', onclick: () => saveAsTemplate(r, r.folderId || null) }, 'Save as template'),
    h('button', { class: 'danger sm', onclick: () => sheet('Delete team report “' + (r.name || 'Untitled') + '” for everyone in ' + t.name + '? This cannot be undone.', [['Delete for everyone', async () => { Cloud.deleteReport(t.id, r.id, allPhotos(normalize(clone(r))).map(p => p.id)).catch(e => alert('Delete failed: ' + e.message)); }, 'danger']]) }, 'Delete')
  ];
  const templateCard = (tmpl, t) => h('div', { class: 'card tmpl' },
    h('h3', { onclick: () => (location.hash = '#tmpl/' + t.id + '/' + tmpl.id), style: 'cursor:pointer' }, '📄 ' + (tmpl.name || 'Untitled template')),
    h('div', { class: 'muted' }, 'Template' + (tmpl.byEmail ? ' · ' + tmpl.byEmail : '')),
    h('div', { class: 'row' },
      h('button', { class: 'primary sm', onclick: () => useTemplate(t, tmpl, tmpl.folderId || folderHash()) }, 'Use template'),
      h('button', { class: 'sm', onclick: () => (location.hash = '#tmpl/' + t.id + '/' + tmpl.id) }, 'Edit'),
      !Cloud.canDelete(t, tmpl) ? null : h('button', { class: 'danger sm', onclick: () => sheet('Delete template “' + (tmpl.name || 'Untitled') + '”?', [['Delete template', () => Cloud.deleteTemplate(t.id, tmpl.id).catch(e => alert(e.message)), 'danger']]) }, 'Delete')));
  const renderTeamBox = () => {
    const t = Cloud.active; const box = $('#teamReports'); if (!t || !box) return;
    const fid = folderHash();
    if (fid) {
      const f = teamFolders.find(x => x.id === fid);
      const reps = teamRs.filter(r => r.folderId === fid).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const tmpls = teamTemplates.filter(x => x.folderId === fid);
      box.replaceChildren(
        h('div', { class: 'crumb' }, h('a', { href: '#' }, '👥 ' + t.name), ' / ', h('b', {}, f ? f.name : 'Folder')),
        h('div', { class: 'row' },
          h('button', { class: 'primary sm', onclick: () => newTeam(t, fid) }, '＋ New report'),
          h('button', { class: 'sm', onclick: () => { const id = uid(); Cloud.saveTemplate(t.id, { id, isNew: true, name: 'New template', folderId: fid, data: stripForTemplate(blank()) }).then(() => (location.hash = '#tmpl/' + t.id + '/' + id)); } }, '＋ New template')),
        h('h2', { class: 'sech' }, 'Templates'),
        ...(tmpls.length ? tmpls.map(x => templateCard(x, t)) : [h('p', { class: 'muted' }, 'No templates in this folder.')]),
        h('h2', { class: 'sech' }, 'Reports'),
        ...(reps.length ? reps.map(r => reportCard(r, teamReportButtons(r, t), r.updatedByEmail ? ' by ' + r.updatedByEmail : '')) : [h('p', { class: 'muted' }, 'No reports in this folder yet.')]));
      return;
    }
    const unfiled = teamRs.filter(r => !r.folderId).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const rootTmpls = teamTemplates.filter(x => !x.folderId);
    const folderCards = teamFolders.map((f, i) => {
      const nR = teamRs.filter(r => r.folderId === f.id).length, nT = teamTemplates.filter(x => x.folderId === f.id).length;
      return h('div', { class: 'card folder', onclick: e => { if (e.target.closest('button')) return; location.hash = '#f/' + encodeURIComponent(f.id); } },
        h('h3', {}, '📁 ' + (f.name || 'Folder')),
        h('div', { class: 'muted' }, nR + ' report' + (nR === 1 ? '' : 's') + ' · ' + nT + ' template' + (nT === 1 ? '' : 's')),
        h('div', { class: 'row' },
          h('button', { class: 'primary sm', onclick: () => (location.hash = '#f/' + encodeURIComponent(f.id)) }, 'Open'),
          i > 0 ? h('button', { class: 'sm', onclick: async () => { const prev = teamFolders[i - 1]; await Cloud.updateFolder(t.id, f.id, { order: prev.order ?? i - 1 }); await Cloud.updateFolder(t.id, prev.id, { order: f.order ?? i }); } }, '↑') : null,
          i < teamFolders.length - 1 ? h('button', { class: 'sm', onclick: async () => { const next = teamFolders[i + 1]; await Cloud.updateFolder(t.id, f.id, { order: next.order ?? i + 1 }); await Cloud.updateFolder(t.id, next.id, { order: f.order ?? i }); } }, '↓') : null,
          h('button', { class: 'sm', onclick: () => { const name = prompt('Folder name', f.name || ''); if (name == null) return; Cloud.updateFolder(t.id, f.id, { name: name.trim().slice(0, 80) || f.name }); } }, 'Rename'),
          !Cloud.canDelete(t, f, 'by') ? null : h('button', { class: 'danger sm', onclick: () => sheet('Delete folder “' + (f.name || '') + '”? Reports and templates move to Unfiled.', [['Delete folder', async () => { const ids = teamRs.filter(r => r.folderId === f.id).map(r => r.id); const tids = teamTemplates.filter(x => x.folderId === f.id).map(x => x.id); await Cloud.deleteFolder(t.id, f.id, ids, tids); }, 'danger']]) }, 'Delete')));
    });
    box.replaceChildren(
      h('div', { class: 'row' },
        h('button', { class: 'sm', onclick: async () => { const name = prompt('Folder name', 'New folder'); if (!name) return; await Cloud.createFolder(t.id, name, teamFolders.length); } }, '＋ New folder'),
        h('button', { class: 'sm', onclick: () => { const id = uid(); Cloud.saveTemplate(t.id, { id, isNew: true, name: 'New template', folderId: null, data: stripForTemplate(blank()) }).then(() => (location.hash = '#tmpl/' + t.id + '/' + id)); } }, '＋ New template')),
      h('h2', { class: 'sech' }, 'Folders'),
      ...(folderCards.length ? folderCards : [h('p', { class: 'muted' }, 'No folders yet. Add one to organize reports and templates.')]),
      h('h2', { class: 'sech' }, 'Templates'),
      ...(rootTmpls.length ? rootTmpls.map(x => templateCard(x, t)) : [h('p', { class: 'muted' }, 'No templates at team root.')]),
      h('h2', { class: 'sech' }, 'Unfiled reports'),
      ...(unfiled.length ? unfiled.map(r => reportCard(r, teamReportButtons(r, t), r.updatedByEmail ? ' by ' + r.updatedByEmail : '')) : [h('p', { class: 'muted' }, 'No unfiled team reports. Tap ＋ New report, or Move a phone report to the team.')]));
  };
  const onReports = list => { if (list === null) { const box = $('#teamReports'); if (box) box.replaceChildren(h('p', { class: 'muted' }, 'Cannot load team reports (are you still a member?).')); return; } teamRs = list; renderTeamBox(); };
  const onFolders = list => { if (list === null) return; teamFolders = list; renderTeamBox(); };
  const onTemplates = list => { if (list === null) return; teamTemplates = list; renderTeamBox(); };
  const drawTeam = () => {
    const hs = location.hash || '#';
    if (hs !== '#' && hs !== '' && !hs.startsWith('#f/')) return;
    const u = Cloud.user, t = Cloud.active;
    $('#acct').classList.toggle('on', !!u);
    if (!u) { teamBox.replaceChildren(h('p', { class: 'hint' }, h('a', { href: '#account' }, 'Sign in'), ' to share reports live with your team.')); if (repUnsub) { repUnsub(); repUnsub = null; } if (foldUnsub) { foldUnsub(); foldUnsub = null; } if (tmplUnsub) { tmplUnsub(); tmplUnsub = null; } drawLocal(); return; }
    if (!t) { const note = removedNote(); if (note) teamBox.before(note); teamBox.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Signed in as ' + u.email + '. You are not in a team yet.'), h('div', { class: 'row' }, h('button', { class: 'primary sm', onclick: () => (location.hash = '#account') }, 'Create or join a team')))); drawLocal(); return; }
    const note = removedNote(); if (note) teamBox.before(note);
    const sel = h('select', { id: 'teamSel', 'aria-label': 'Active team', onchange: e => Cloud.setActive(e.target.value) }, ...Cloud.teams.map(x => h('option', { value: x.id, selected: x.id === t.id }, x.name)));
    teamBox.replaceChildren(h('h2', { class: 'sech' }, '👥 Team reports'), Cloud.teams.length > 1 ? sel : h('div', { class: 'muted' }, t.name), h('div', { id: 'teamReports' }, h('p', { class: 'muted' }, 'Loading…')));
    if (repTeam !== t.id || !repUnsub) {
      if (repUnsub) repUnsub(); if (foldUnsub) foldUnsub(); if (tmplUnsub) tmplUnsub();
      repTeam = t.id;
      repUnsub = Cloud.watchReports(t.id, onReports);
      foldUnsub = Cloud.watchFolders(t.id, onFolders);
      tmplUnsub = Cloud.watchTemplates(t.id, onTemplates);
    } else renderTeamBox();
    drawLocal();
  };
  unsubs.push(() => { if (repUnsub) repUnsub(); if (foldUnsub) foldUnsub(); if (tmplUnsub) tmplUnsub(); });
  if (Cloud.enabled() || Cloud.user) {
    teamBox.append(h('p', { class: 'muted' }, 'Loading team…'));
    unsubs.push(Cloud.on(drawTeam));
    Cloud.ready().then(drawTeam, () => teamBox.replaceChildren(h('p', { class: 'hint' }, 'Team reports unavailable (offline and not cached yet). Phone reports work as usual.')));
  } else drawTeam();
}

async function moveToTeam(r) {
  const t = Cloud.active; if (!t) return;
  sheet('Move “' + (r.name || 'Untitled') + '” to team ' + t.name + '? Everyone in the team will be able to see and edit it.', [['👥 Move to team', async () => {
    const st = $('#saved'); st.textContent = 'Uploading…';
    try {
      const n = normalize(clone(r)); n._team = t.id; const writes = [];
      for (const p of allPhotos(n)) {
        const rec = await DB.photo(p.id); if (!rec) continue;
        const j = await teamJpeg(rec.blob); p.w = j.w; p.h = j.h;
        await tx('tphotos', 'readwrite', s => s.put({ id: p.id, blob: j.blob }));
        writes.push(Cloud.putPhoto(t.id, n.id, p.id, { data: j.data, w: j.w, h: j.h }));
      }
      writes.push(Cloud.createReport(t.id, n));
      if (await withTimeout(Promise.all(writes), 30000)) {
        for (const p of allPhotos(normalize(clone(r)))) await DB.delPhoto(p.id); await DB.del(r.id); st.textContent = 'Moved ✓';
      } else alert('Queued for the team, but the upload is not confirmed yet (offline?). The phone copy was kept; delete it once the team copy appears on another phone.');
    } catch (e) { alert('Move failed: ' + e.message); }
    listView();
  }, 'primary']]);
}

/* v18: shown once after the server drops a team you were in (removed by its owner). Phone-only reports are untouched. */
function removedNote() {
  const old = document.getElementById('removedNote'); if (old) old.remove();
  if (!Cloud.removedFrom) return '';
  const n = h('div', { class: 'card removed', id: 'removedNote', role: 'status' }, h('b', {}, 'You are no longer a member of ' + Cloud.removedFrom + '.'),
    h('div', { class: 'muted' }, 'Its reports are no longer available here. Your phone-only reports are unchanged.'),
    h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => { Cloud.removedFrom = null; n.remove(); } }, 'OK')));
  return n;
}

/* v18: email verification prompt (needed to create or join a team; current team memberships keep working). */
function verifyCard(msg) {
  if (!Cloud.user || Cloud.verified()) return '';
  const say = (t, bad) => { msg.textContent = t; msg.className = 'msg' + (bad ? ' bad' : ''); };
  return h('div', { class: 'card verify', id: 'verifyCard' }, h('h3', {}, '✉️ Verify your email'),
    h('div', { class: 'muted' }, 'We sent a link to ' + Cloud.user.email + '. Open it, then tap “I’ve verified”. You need a verified email to create or join a team. Teams you are already in keep working.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary sm', id: 'verified', onclick: async e => { e.target.disabled = true; try { if (await Cloud.refreshUser()) { say('Email verified ✓'); const c = $('#verifyCard'); if (c) c.remove(); } else say('Not verified yet. Open the link in the email (check spam), then try again.', true); } catch (x) { say(Cloud.err(x), true); } finally { e.target.disabled = false; } } }, 'I’ve verified'),
      h('button', { class: 'sm', id: 'resend', onclick: async e => { e.target.disabled = true; try { await Cloud.resendVerification(); say('Verification email sent to ' + Cloud.user.email + '.'); } catch (x) { say(Cloud.err(x), true); } finally { e.target.disabled = false; } } }, 'Resend email')));
}

/* ---------- Account & teams ---------- */
async function accountView() {
  bar('Account & Teams', true); cur = null;
  view.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try { await Cloud.ready(); } catch (e) { view.replaceChildren(AppLock.card(), h('p', { class: 'muted' }, 'Sign-in could not load (no connection?). Phone-only reports still work. ' + (e.message || ''))); return; }
  let shownUid;
  const draw = () => {
    if (location.hash !== '#account') return;
    const u = Cloud.user; $('#acct').classList.toggle('on', !!u);
    if ((u && u.uid) === shownUid && view.firstChild && view.firstChild.id !== 'loading') { drawTeams(); return; }
    shownUid = u && u.uid; view.innerHTML = ''; view.append(AppLock.card());
    const msg = h('div', { class: 'msg', role: 'status' });
    const busy = async (btn, fn) => { msg.textContent = ''; msg.className = 'msg'; btn.disabled = true; try { await fn(); } catch (e) { msg.textContent = Cloud.err(e); msg.className = 'msg bad'; } finally { btn.disabled = false; } };
    if (!u) {
      const em = h('input', { type: 'email', id: 'em', autocomplete: 'username', autocapitalize: 'none', placeholder: 'you@example.com' });
      const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', placeholder: 'At least ' + Cloud.PASSWORD_MIN + ' characters' });
      view.append(h('div', { class: 'card' }, h('h3', {}, 'Sign in to share reports with your team'),
        h('label', { for: 'em' }, 'Email'), em, h('label', { for: 'pw' }, 'Password'), pw, msg,
        h('div', { class: 'row' },
          h('button', { class: 'primary', id: 'signin', onclick: e => busy(e.target, () => Cloud.signIn(em.value, pw.value)) }, 'Sign in'),
          h('button', { id: 'signup', onclick: e => busy(e.target, () => Cloud.signUp(em.value, pw.value)) }, 'Create account'),
          h('button', { class: 'sm', id: 'forgot', onclick: e => busy(e.target, async () => { if (!em.value.trim()) throw new Error('Type your email first.'); await Cloud.reset(em.value); msg.textContent = 'Password reset email sent to ' + em.value.trim() + '.'; }) }, 'Forgot password?'))),
        h('p', { class: 'hint' }, 'New accounts need a password of at least ' + Cloud.PASSWORD_MIN + ' characters and a verified email to create or join a team. You do not need an account for phone-only reports.'));
      return;
    }
    const tname = h('input', { type: 'text', id: 'tname', placeholder: 'Team name', autocapitalize: 'words' });
    const tcode = h('input', { type: 'text', id: 'tcode', placeholder: 'ABCD-EFGH', autocapitalize: 'characters', autocomplete: 'off' });
    view.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Signed in as'), h('h3', { id: 'me' }, u.email),
      h('div', { class: 'row' }, h('button', { class: 'sm', id: 'signout', onclick: () => sheet('Sign out? Team reports cached on this phone are removed; phone-only reports stay.', [['Sign out', async () => { await flush(); await Cloud.signOut(); location.hash = ''; location.reload(); }, 'danger']]) }, 'Sign out'))),
      msg, verifyCard(msg), removedNote(), h('div', { id: 'teams' }),
      h('div', { class: 'card' }, h('h3', {}, 'Create a team'), tname, h('div', { class: 'row' }, h('button', { class: 'primary sm', id: 'mkteam', onclick: e => busy(e.target, async () => { if (!navigator.onLine) throw new Error('Creating a team needs internet.'); const t = await Cloud.createTeam(tname.value); tname.value = ''; msg.textContent = 'Team created. Invite code: ' + fmtCode(t.code); }) }, 'Create team'))),
      h('div', { class: 'card' }, h('h3', {}, 'Join a team'), h('div', { class: 'hint' }, 'Enter the 8-character invite code from a teammate.'), tcode,
        h('div', { class: 'row' }, h('button', { class: 'primary sm', id: 'jointeam', onclick: e => busy(e.target, async () => { await Cloud.joinTeam(tcode.value); tcode.value = ''; msg.textContent = 'Joined ✓'; }) }, 'Join team'))));
    drawTeams();
  };
  const drawTeams = () => {
    const box = $('#teams'); if (!box) return; const act = Cloud.active;
    const rn = removedNote(); if (rn) box.before(rn);
    const me = Cloud.user && Cloud.user.uid;
    box.replaceChildren(...Cloud.teams.map(t => { const owner = Cloud.isOwner(t), others = (t.members || []).filter(m => m !== me).length;
      const people = (t.members || []).map(m => ({ uid: m, email: (t.emails || {})[m] || '(no email)' })).sort((a, b) => (b.uid === t.owner) - (a.uid === t.owner) || a.email.localeCompare(b.email));
      return h('div', { class: 'card team' + (act && act.id === t.id ? ' active' : '') },
      h('h3', {}, t.name, act && act.id === t.id ? h('span', { class: 'badge' }, 'Active') : null, owner ? h('span', { class: 'badge own' }, 'Owner') : null),
      h('div', { class: 'muted' }, 'Invite code: ', h('b', { class: 'code' }, fmtCode(t.code)),
        owner ? h('button', { class: 'sm resetcode', onclick: () => sheet('Reset the invite code for ' + t.name + '? The old code stops working right away. Members already in the team stay in.', [['Reset code', async () => { try { const c = await Cloud.resetCode(t.id); alert('New invite code: ' + fmtCode(c)); } catch (e) { alert(Cloud.err(e)); } }, 'danger']]) }, 'Reset code') : null),
      h('div', { class: 'muted' }, 'Members (' + people.length + '):'),
      h('ul', { class: 'members' }, ...people.map(p => h('li', {},
        h('span', {}, p.email + (p.uid === me ? ' (you)' : '') + (p.uid === t.owner ? ' · owner' : '')),
        owner && p.uid !== me ? h('button', { class: 'danger sm rm', onclick: () => sheet('Remove ' + p.email + ' from ' + t.name + '? They lose access to its reports right away. They can only rejoin with the current invite code (use Reset code to change it).', [['Remove member', () => Cloud.removeMember(t.id, p.uid).catch(e => alert(Cloud.err(e))), 'danger']]) }, 'Remove') : null))),
      h('div', { class: 'row' },
        act && act.id === t.id ? null : h('button', { class: 'sm', onclick: () => Cloud.setActive(t.id) }, 'Make active'),
        h('button', { class: 'danger sm', onclick: () => sheet('Leave ' + t.name + '? You will lose access to its reports until you rejoin with the code.' + (owner && others ? ' You are the owner: after you leave, nobody can remove members or reset the code.' : ''), [['Leave team', () => Cloud.leaveTeam(t.id).catch(e => alert(Cloud.err(e))), 'danger']]) }, 'Leave team'))); }));
    if (!Cloud.teams.length) box.append(h('p', { class: 'muted' }, 'You are not in any team yet.'));
  };
  unsubs.push(Cloud.on(draw)); draw();
}

/* ---------- Save / sync ---------- */
function save() { if (cur) { mirrorIntel(cur.intel); mirrorRoutes(cur.routes); } clearTimeout(saveT); $('#saved').textContent = '…'; saveT = setTimeout(flush, cur && cur._team ? 500 : 400); }
// Live sync. base = last known server state, cur = what this device shows. Both are compared in Firestore form
// (docForm: keyed lists become maps), so only changed leaf fields are written and concurrent edits to different
// fields, rows or photos merge cleanly. A field edited on two devices at once: the later save wins.
function flush() {
  clearTimeout(saveT); saveT = null; if (!cur) return Promise.resolve();
  if (cur._template) {
    const t = cur._template;
    return Cloud.saveTemplate(t.teamId, { id: t.id, name: cur.name, folderId: cur.folderId || null, data: stripForTemplate(cur) })
      .then(() => { $('#saved').textContent = 'Template saved ✓'; syncStatus(); })
      .catch(e => { $('#saved').textContent = 'Template save failed'; alert(Cloud.err(e)); });
  }
  if (cur._team) {
    if (!base) return Promise.resolve();
    const bD = docForm(base), cD = docForm(cur), ps = diffPaths(bD, cD);
    if (ps.length) { const upd = {}; for (const p of ps) { const v = getP(cD, p); upd[p] = v === undefined ? undefined : clone(v); } base = clone(cur); Cloud.updateReport(cur._team, cur.id, upd); } // undefined = deleteField
    syncStatus(); return Promise.resolve();
  }
  cur.updated = Date.now(); return DB.put(cur).then(() => { $('#saved').textContent = 'Saved ✓'; });
}
const delP = (o, p) => { const ks = p.split('.'), last = ks.pop(), par = ks.reduce((a, k) => (a == null ? a : a[k]), o); if (par && typeof par === 'object') delete par[last]; };
// update `old` in place to equal `nw`, keeping existing objects (so open editors' closures stay valid)
function reconcile(old, nw) {
  for (const k of Object.keys(old)) if (!(k in nw) && k !== '_team' && k !== 'id') delete old[k];
  for (const k of Object.keys(nw)) {
    const o = old[k], n = nw[k];
    if (Array.isArray(o) && Array.isArray(n)) {
      const om = new Map(o.filter(itemKey).map(x => [itemKey(x), x]));
      const out = n.map(x => { const e = itemKey(x) && om.get(itemKey(x)); if (e && isPlain(e)) { reconcile(e, x); return e; } return x; });
      if (J(o) !== J(out) || o.some((x, i) => x !== out[i])) o.splice(0, o.length, ...out);
    } else if (isPlain(o) && isPlain(n)) reconcile(o, n);
    else if (J(o) !== J(n)) old[k] = n;
  }
}
// True when path is a keyed list ROW in docForm (e.g. routes.list.<uuid>), not a field under that row.
function isKeyedListRowPath(p, doc) {
  const parts = String(p || '').split('.');
  for (let i = 1; i < parts.length; i++) {
    const parent = getP(doc, parts.slice(0, i).join('.'));
    if (parent && typeof parent === 'object' && parent._list && parts[i] !== '_list') {
      return i === parts.length - 1; // path ends on the row key itself
    }
  }
  return false;
}
function applyRemote(remote) {
  const bD = docForm(base), cD = docForm(cur), rD = docForm(remote), mD = clone(cD);
  const pending = !!(saveT || (lastMeta && lastMeta.hasPendingWrites));
  for (const p of diffPaths(bD, rD)) {
    if (J(getP(cD, p)) !== J(getP(bD, p))) continue; // this device changed it and has not saved yet: keep ours
    const v = getP(rD, p);
    // Stale snapshot race: flush() already set base=cur (with the new row) before the server had it.
    // A snapshot missing that keyed row would look like a remote delete — skip while our write is pending.
    // After skipping, base becomes `remote` (without the row) so the next echo no longer diffs as a delete.
    if (v === undefined && pending && isKeyedListRowPath(p, bD) && getP(cD, p) != null) continue;
    if (v === undefined) delP(mD, p); else setP(mD, p, clone(v));
  }
  base = clone(remote);
  const next = normalize(Object.assign(fromForm(mD), { id: cur.id, _team: cur._team }));
  const changed = diffPaths(cur, next);
  if (changed.length) { reconcile(cur, next); refreshUI(changed); }
  if (diffPaths(base, cur).length && !saveT) save(); // merged local edits still need saving
}
function refreshUI(paths) {
  binds = binds.filter(b => b.node.isConnected);
  const a = document.activeElement, held = [];
  for (const b of binds.slice()) {
    if (!b.node.isConnected) continue;
    // List/draw binders: only remount when this path itself (or a parent) changed — NOT when a deep child
    // changed (e.g. routes.list.0.stops.0.address must not remount routes.list, or the route card vanishes).
    const hit = b.draw
      ? paths.some(p => p === b.path || b.path.startsWith(p + '.'))
      : paths.some(p => related(p, b.path));
    if (!hit) continue;
    if (held.some(n => n.contains(b.node))) continue;
    if (b.draw) {
      // Skip remount while typing in a child field — but always remount when this list path itself changed
      // (e.g. a route row removed by sync); otherwise the deleted card stays on screen.
      const structural = paths.some(p => p === b.path);
      if (!structural && a && b.node.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { stale.add(b.path); held.push(b.node); }
      else b.draw();
    }
    else { const v = String(getP(cur, b.path) ?? ''); if (b.node === a) stale.add(b.path); else if (b.node.value !== v) { b.node.value = v; if (b.onset) b.onset(); } }
  }
}
document.addEventListener('focusout', () => setTimeout(() => { if (!cur || !cur._team || !stale.size) return; const ps = [...stale]; stale.clear(); refreshUI(ps); }, 0));
function syncStatus() {
  const el = $('#saved'); if (!cur || !cur._team) return;
  const m = lastMeta || {}; const off = !navigator.onLine || m.fromCache;
  el.textContent = off ? (m.hasPendingWrites ? 'Offline · saved on phone' : 'Offline') : m.hasPendingWrites || saveT ? 'Syncing…' : 'Synced ✓';
  el.className = off ? 'off' : '';
}
window.addEventListener('online', syncStatus); window.addEventListener('offline', syncStatus);
const bindIn = (path, el, onset) => { el.dataset.path = path; binds.push({ path, node: el, onset }); };
const bindArr = (path, wrap, draw) => { binds.push({ path, node: wrap, draw }); return draw; };

const RISKS = ['', 'LOW', 'LOW–MODERATE', 'MODERATE', 'MODERATE–HIGH', 'HIGH', 'CRITICAL'];
function inp(path, label, opt = {}) {
  const v = getP(cur, path) ?? '';
  let el;
  if (opt.area) el = h('textarea', { rows: opt.rows || 4 }, v);
  else if (opt.options) { el = h('select', {}, ...opt.options.map(o => h('option', { value: o, selected: o === v }, o || opt.blank || '— select —'))); }
  else el = h('input', { type: 'text', value: v, autocapitalize: opt.caps || 'sentences' });
  el.value = v; if (opt.ph && !opt.options) el.placeholder = opt.ph; // v19: example text so each box gets one kind of detail
  el.addEventListener(opt.options ? 'change' : 'input', () => { if (opt.obj) opt.obj[opt.key] = el.value; else setP(cur, path, el.value); save(); });
  bindIn(path, el, path === 'name' ? () => ($('#barTitle').textContent = el.value) : null);
  return h('div', {}, label ? h('label', {}, label) : null, el, opt.hint ? h('div', { class: 'hint' }, opt.hint) : null);
}
function strList(path, label, ph) {
  const wrap = h('div');
  const draw = bindArr(path, wrap, () => {
    wrap.innerHTML = ''; const arr = getP(cur, path);
    if (label) wrap.append(h('label', {}, label));
    arr.forEach((_, i) => {
      const t = h('textarea', { rows: 2, 'data-path': path + '.' + i }); t.value = arr[i];
      t.oninput = () => { arr[i] = t.value; save(); };
      wrap.append(h('div', { class: 'item' }, t, h('div', { class: 'tools', style: 'margin-top:6px' }, h('button', { class: 'danger sm', onclick: () => { arr.splice(i, 1); save(); draw(); } }, 'Remove'))));
    });
    wrap.append(h('button', { class: 'sm', onclick: () => { arr.push(''); save(); draw(); } }, '＋ Add bullet'));
  });
  draw(); return wrap;
}
function rows(path, cols, addLabel, extra) {
  const wrap = h('div');
  const draw = bindArr(path, wrap, () => {
    wrap.innerHTML = ''; const arr = getP(cur, path);
    arr.forEach((row, i) => {
      const fields = cols.map(([k, lab, o = {}]) => {
        if (o.check) { const c = h('input', { type: 'checkbox', 'data-path': path + '.' + i + '.' + k }); c.checked = !!row[k]; c.onchange = () => { if (o.exclusive && c.checked) arr.forEach(x => (x[k] = false)); row[k] = c.checked; save(); if (o.exclusive) draw(); }; return h('label', { class: 'chk' }, c, lab); }
        return inp(path + '.' + i + '.' + k, lab, Object.assign({ obj: row, key: k }, o));
      });
      wrap.append(h('div', { class: 'item' }, h('div', { class: extra === 'grid' ? 'grid2' : '' }, ...fields),
        h('div', { class: 'tools', style: 'margin-top:8px' },
          i > 0 ? h('button', { class: 'sm', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '↑') : null,
          i < arr.length - 1 ? h('button', { class: 'sm', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '↓') : null,
          h('button', { class: 'danger sm', onclick: () => { arr.splice(arr.indexOf(row), 1); save(); draw(); } }, 'Remove'))));
    });
    wrap.append(h('button', { class: 'sm', onclick: () => { arr.push(Object.assign(Object.fromEntries(cols.map(([k]) => [k, ''])), { _k: uid() })); save(); draw(); } }, '＋ ' + addLabel));
  });
  draw(); return wrap;
}
function photoGrid(path, opt = {}) { // path of a photos array, e.g. 'routes.photos', 'locations.2.photos'
  const wrap = h('div'); const urls = [];
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', class: 'lib-in' });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' });
  const status = h('div', { class: 'hint' });
  const onFiles = async e => { const fs = [...e.target.files]; e.target.value = ''; if (!fs.length) return; status.textContent = (cur._team ? 'Compressing & uploading ' : 'Compressing ') + fs.length + ' photo(s)…'; try { await addPhotos(cur, getP(cur, path), fs); } catch (er) { alert('Photo failed: ' + er.message); } await flush(); status.textContent = ''; draw(); };
  fileIn.onchange = onFiles; camIn.onchange = onFiles;
  const grid = h('div', { class: 'photos' });
  let gen = 0;
  const draw = bindArr(path, grid, async () => {
    const my = ++gen; const arr = getP(cur, path) || []; const cells = []; const r = cur;
    const fresh = [];
    for (let i = 0; i < arr.length; i++) {
      const rec = await P.get(r, arr[i].id); if (my !== gen) { fresh.forEach(URL.revokeObjectURL); return; }
      const u = rec ? URL.createObjectURL(rec.blob) : ''; fresh.push(u);
      const cap = h('input', { type: 'text', class: 'cap', 'aria-label': 'Photo caption', value: arr[i].caption || '', 'data-path': path + '.' + i + '.caption' });
      const ph = arr[i]; cap.value = ph.caption || ''; cap.oninput = () => { ph.caption = cap.value; save(); };
      cells.push(h('div', {}, h('div', { class: 'ph' }, u ? h('img', { src: u, alt: (opt.noun || 'photo') + ' ' + (i + 1), onclick: () => viewImage(u) }) : h('div', { class: 'nophoto' }, 'Photo not downloaded yet'),
        h('button', { class: 'x', 'aria-label': 'Remove ' + (opt.noun || 'photo'), onclick: () => sheet('Remove this ' + (opt.noun || 'photo') + '?', [['Remove', async () => { await P.del(cur, ph.id); if (arr.indexOf(ph) >= 0) arr.splice(arr.indexOf(ph), 1); await flush(); draw(); }, 'danger']]) }, '✕'),
        h('div', { class: 'mv' }, i > 0 ? h('button', { onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '‹') : null,
          i < arr.length - 1 ? h('button', { onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '›') : null)), cap));
    }
    urls.splice(0).forEach(URL.revokeObjectURL); urls.push(...fresh);
    grid.replaceChildren(...cells); if (opt.after) opt.after();
  });
  if (opt.noAdd) wrap.append(grid); else wrap.append(h('div', { class: 'row' }, h('button', { class: 'primary sm', onclick: () => camIn.click() }, '📷 Camera'), h('button', { class: 'sm', onclick: () => fileIn.click() }, '🖼 Photo library')), fileIn, camIn, status, grid);
  draw(); return wrap;
}
function viewImage(u) { const s = $('#sheet'); s.innerHTML = ''; s.hidden = false; s.append(h('div', { class: 'viewer' }, h('img', { src: u, alt: 'full size' }), h('button', { onclick: () => (s.hidden = true) }, 'Close'))); s.onclick = e => { if (e.target === s) s.hidden = true; }; }
function pagesBlock(section, figs) { // original pages of an imported PDF (printed full-page) or kept charts/maps (printed after the text)
  const path = section + (figs ? '.figures.photos' : '.pages.photos'), wrap = h('div', { class: 'pblock pages' + (figs ? ' figs' : '') });
  const title = figs ? '🗺 Charts & maps' : '📄 Original PDF pages';
  const lab = h('label', {}, title), hint = h('div', { class: 'hint' }, figs ? 'Printed after this section’s text, full width, with captions. Tap to view.' : 'Printed full-page in the report, in this order. Tap a page to view it.');
  const vis = () => { const n = (getP(cur, path) || []).length; wrap.hidden = !n; lab.textContent = title + ' (' + n + ')'; };
  wrap.append(lab, hint, photoGrid(path, { noAdd: true, noun: figs ? 'figure' : 'page', after: () => vis() })); bindArr(path, lab, vis); vis(); return wrap;
}
// Editable titled sections (Intel: with optional risk; Medical: title + text)
function sectionsEditor(path, withRisk, emptyHint) {
  const wrap = h('div', { class: 'secs' });
  const draw = bindArr(path, wrap, () => {
    const arr = getP(cur, path); wrap.innerHTML = '';
    arr.forEach((x, i) => {
      const base = path + '.' + i;
      const titleIn = inp(base + '.title', 'Section title', { obj: x, key: 'title' }); titleIn.querySelector('input').classList.add('sec-title-in');
      wrap.append(h('div', { class: 'item isec' },
        withRisk ? h('div', { class: 'grid2 isec-h' }, titleIn, inp(base + '.risk', 'Risk level', { options: RISKS, blank: 'None', obj: x, key: 'risk' })) : h('div', { class: 'isec-h' }, titleIn),
        inp(base + '.text', 'Text', { area: true, rows: 5, obj: x, key: 'text' }),
        h('div', { class: 'tools', style: 'margin-top:8px' },
          i > 0 ? h('button', { class: 'sm', 'aria-label': 'Move up', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '↑') : null,
          i < arr.length - 1 ? h('button', { class: 'sm', 'aria-label': 'Move down', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '↓') : null,
          h('button', { class: 'danger sm', onclick: () => sheet('Remove section “' + (x.title || 'Untitled') + '”?', [['Remove section', () => { arr.splice(arr.indexOf(x), 1); save(); draw(); }, 'danger']]) }, 'Remove'))));
    });
    if (!arr.length && emptyHint) wrap.append(h('div', { class: 'hint' }, emptyHint));
    wrap.append(h('button', { class: 'primary add-isec', style: 'width:100%;margin-top:8px', onclick: () => { arr.push(withRisk ? { _k: uid(), title: '', risk: '', text: '' } : { _k: uid(), title: '', text: '' }); save(); draw(); const ts = wrap.querySelectorAll('.isec-h input'); ts[ts.length - 1].focus(); } }, '＋ Add section'));
  });
  draw(); return wrap;
}
const intelEditor = () => sectionsEditor('intel.sections', true, 'No Intel sections yet. Add one for each topic (e.g. Event, Area, Crime, Protest), or import a PDF / JSON.');
function taskOrgEditor() {
  const wrap = h('div');
  const draw = bindArr('taskOrg.columns', wrap, () => {
    const t = cur.taskOrg, arr = t.columns; wrap.innerHTML = '';
    const grid = h('div', { class: 'tocols' });
    arr.forEach((col, i) => {
      const base = 'taskOrg.columns.' + i;
      const names = h('textarea', { rows: 5, 'aria-label': (col.title || 'Column ' + (i + 1)) + ' names' }); names.value = col.names || '';
      names.oninput = () => { col.names = names.value; if (col.legacy) t[col.legacy] = names.value; save(); };
      bindIn(base + '.names', names);
      grid.append(h('div', { class: 'item tocol' }, inp(base + '.title', 'Column title', { obj: col, key: 'title' }), h('label', {}, 'Names'), names,
        h('div', { class: 'tools', style: 'margin-top:8px' },
          i > 0 ? h('button', { class: 'sm', 'aria-label': 'Move left', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '←') : null,
          i < arr.length - 1 ? h('button', { class: 'sm', 'aria-label': 'Move right', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '→') : null,
          h('button', { class: 'danger sm', onclick: () => sheet('Remove column “' + (col.title || 'Column ' + (i + 1)) + '”' + (col.names.trim() ? ' and its names' : '') + '?', [['Remove column', () => { if (col.legacy) t[col.legacy] = ''; arr.splice(arr.indexOf(col), 1); save(); draw(); }, 'danger']]) }, 'Remove'))));
    });
    wrap.append(grid, h('button', { class: 'sm add-col', onclick: () => { arr.push({ _k: uid(), title: '', names: '' }); save(); draw(); const ts = wrap.querySelectorAll('.tocol input'); ts[ts.length - 1].focus(); } }, '＋ Add column'));
  });
  draw(); return wrap;
}
// v19: one card per vehicle with one box per detail (examples shown), plus a live chart preview that matches the PDF
const VEH_FIELDS = [['oom', 'OOM (order)', { ph: '1', caps: 'none' }], ['desc', 'Vehicle', { ph: 'Black Escalade' }], ['plate', 'Plate', { ph: 'FL ABC1234', caps: 'characters' }],
  ['driver', 'Driver', { ph: 'Driver name' }], ['pax', 'Passengers', { ph: 'V1, staff…' }], ['seats', 'Car seats', { ph: '0', caps: 'none' }],
  ['equip', 'Equipment', { ph: 'Med bag, luggage…' }], ['issues', 'Issues / notes', { ph: 'None' }]];
function vehiclesEditor() {
  const prev = h('div', { class: 'vprev' });
  const drawPrev = () => {
    prev.innerHTML = ''; const vs = (cur.vehicles || []).filter(v => v && VEH_FIELDS.some(([k]) => String(v[k] || '').trim())); if (!vs.length) return;
    const cols = VEH_FIELDS.filter(([k]) => k === 'desc' || vs.some(v => String(v[k] || '').trim()));
    prev.append(h('div', { class: 'blk-h' }, 'Chart preview (as in the PDF)'), h('div', { class: 'tblwrap' }, h('table', { class: 'rchart vchart' },
      h('thead', {}, h('tr', {}, ...cols.map(([, lab]) => h('th', {}, lab.replace(' (order)', ''))))),
      h('tbody', {}, ...vs.map(v => h('tr', {}, ...cols.map(([k]) => h('td', {}, String(v[k] || '')))))))));
  };
  const list = rows('vehicles', VEH_FIELDS, 'Add vehicle', 'grid');
  bindArr('vehicles', prev, drawPrev); list.addEventListener('input', drawPrev); list.addEventListener('click', () => setTimeout(drawPrev, 0)); drawPrev();
  return h('div', {}, h('div', { class: 'hint' }, 'One card per vehicle. Put each detail in its own box (vehicle, plate, driver, passengers…); the PDF lines them up in even columns. Empty columns are left out.'), list, prev);
}
function photoBlock(label, path) { return h('div', { class: 'pblock' }, h('label', {}, '📷 ' + label), photoGrid(path)); }
function locationsEditor() {
  const wrap = h('div');
  const draw = bindArr('locations', wrap, () => {
    const arr = cur.locations; wrap.innerHTML = '';
    if (!arr.length) wrap.append(h('div', { class: 'hint' }, 'No locations yet. Add as many as you need — FBO, venue, hotel, safe sites…'));
    arr.forEach((l, i) => {
      wrap.append(h('div', { class: 'item loc' }, h('div', { class: 'loc-h' }, 'Location ' + (i + 1)),
        inp('locations.' + i + '.name', 'Name', { obj: l, key: 'name' }), inp('locations.' + i + '.address', 'Address', { obj: l, key: 'address' }),
        inp('locations.' + i + '.map', 'Map link (Google Maps link or coordinates)', { caps: 'none', obj: l, key: 'map', ph: 'https://maps.google.com/…' }), inp('locations.' + i + '.notes', 'Notes (optional, prints in the Notes column)', { area: true, rows: 2, obj: l, key: 'notes' }),
        photoBlock('Photos for this location', 'locations.' + i + '.photos'),
        h('div', { class: 'tools', style: 'margin-top:8px' },
          i > 0 ? h('button', { class: 'sm', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '↑') : null,
          i < arr.length - 1 ? h('button', { class: 'sm', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '↓') : null,
          h('button', { class: 'danger sm', onclick: () => sheet('Delete location “' + (l.name || 'Untitled') + '”' + (l.photos.length ? ' and its ' + l.photos.length + ' photo(s)' : '') + '?', [['Delete location', async () => { for (const p of l.photos) await P.del(cur, p.id); arr.splice(arr.indexOf(l), 1); await flush(); draw(); }, 'danger']]) }, 'Delete'))));
    });
    wrap.append(h('button', { class: 'primary add-loc', style: 'width:100%', onclick: () => { arr.push({ name: '', address: '', map: '', notes: '', photos: [], _k: uid() }); save(); draw(); } }, '＋ Add location'));
  });
  draw(); return wrap;
}
function photoSections() {
  const wrap = h('div');
  const draw = bindArr('photoSections', wrap, () => {
    const arr = cur.photoSections; wrap.innerHTML = '';
    arr.forEach((sc, i) => {
      const t = h('input', { type: 'text', class: 'sec-title', autocapitalize: 'words', 'data-path': 'photoSections.' + i + '.title' }); t.value = sc.title;
      t.oninput = () => { sc.title = t.value; save(); };
      wrap.append(h('div', { class: 'item psec' }, h('label', {}, 'Section title'), t, photoGrid('photoSections.' + i + '.photos'),
        h('div', { class: 'tools', style: 'margin-top:8px' },
          i > 0 ? h('button', { class: 'sm', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '↑ Move up') : null,
          i < arr.length - 1 ? h('button', { class: 'sm', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '↓ Move down') : null,
          h('button', { class: 'danger sm', onclick: () => sheet('Delete section “' + (sc.title || 'Untitled') + '” and its ' + sc.photos.length + ' photo(s)?', [['Delete section', async () => { for (const p of sc.photos) await P.del(cur, p.id); arr.splice(arr.indexOf(sc), 1); await flush(); draw(); }, 'danger']]) }, 'Delete section'))));
    });
    wrap.append(h('button', { class: 'primary sm add-psec', onclick: () => { arr.push({ id: uid(), title: '', photos: [] }); save(); draw(); wrap.querySelectorAll('.sec-title')[arr.length - 1].focus(); } }, '＋ Add photo section'),
      h('div', { class: 'hint' }, 'Each section prints as its own titled header with its photos (size set above). Photos are resized on-device (≤1600px, or ≤1280px for team reports). Sections without photos are skipped in the PDF.'));
  });
  draw(); return wrap;
}

function timelineEditor() {
  // Timeline is a flat array; entries with a `day` key ('YYYY-MM-DD') are date-block headers and the
  // following rows belong to that day. Older reports (no day entries) render as one undated block.
  const wrap = h('div');
  const mv = (arr, i, j) => { [arr[i], arr[j]] = [arr[j], arr[i]]; save(); draw(); };
  const draw = bindArr('timeline', wrap, () => {
    wrap.innerHTML = ''; const arr = cur.timeline;
    arr.forEach((row, i) => {
      const nav = [i > 0 ? h('button', { class: 'sm', onclick: () => mv(arr, i - 1, i) }, '↑') : null,
        i < arr.length - 1 ? h('button', { class: 'sm', onclick: () => mv(arr, i + 1, i) }, '↓') : null];
      if (row.day != null) {
        const lbl = h('div', { class: 'day-label' }, window.fmtDay(row.day) || 'Select a date');
        const d = h('input', { type: 'date', 'aria-label': 'Day date', 'data-path': 'timeline.' + i + '.day' }); d.value = row.day || '';
        d.oninput = d.onchange = () => { row.day = d.value; lbl.textContent = window.fmtDay(d.value) || 'Select a date'; save(); };
        wrap.append(h('div', { class: 'item day-block' }, h('label', {}, 'Day'), lbl, d,
          h('div', { class: 'tools', style: 'margin-top:8px' }, ...nav,
            h('button', { class: 'danger sm', onclick: () => { arr.splice(i, 1); save(); draw(); } }, 'Remove day'))));
        return;
      }
      wrap.append(h('div', { class: 'item' + (arr.slice(0, i).some(x => x.day != null) ? ' in-day' : '') },
        inp('timeline.' + i + '.time', 'Time', { obj: row, key: 'time' }), inp('timeline.' + i + '.event', 'Event', { obj: row, key: 'event' }), inp('timeline.' + i + '.remarks', 'Remarks', { obj: row, key: 'remarks' }),
        h('div', { class: 'tools', style: 'margin-top:8px' }, ...nav,
          h('button', { class: 'danger sm', onclick: () => { arr.splice(i, 1); save(); draw(); } }, 'Remove'))));
    });
    wrap.append(h('div', { class: 'row' },
      h('button', { class: 'sm', onclick: () => { arr.push({ time: '', event: '', remarks: '', _k: uid() }); save(); draw(); } }, '＋ Add timeline row'),
      h('button', { class: 'sm add-day', onclick: () => { arr.push({ day: '', _k: uid() }); save(); draw(); const ds = wrap.querySelectorAll('input[type=date]'); ds[ds.length - 1].focus(); } }, '＋ Add Day')),
      h('div', { class: 'hint' }, 'Add Day inserts a date header; timeline rows below it belong to that day. Use ↑/↓ to move rows between days.'));
  });
  draw(); return wrap;
}
function S(title, open, ...kids) { return h('details', { class: 'sec', open }, h('summary', {}, title), h('div', { class: 'body' }, ...kids)); }

async function editView(id) {
  const r = await DB.get(id); if (!r) { location.hash = ''; return; }
  cur = normalize(r); base = null; renderEditor();
}
function setLastBy(d) {
  const el = $('#lastBy'); if (!el || !d) return;
  const me = Cloud.user && d.updatedBy === Cloud.user.uid;
  el.textContent = d.updatedByEmail ? 'Last edited by ' + (me ? 'you' : d.updatedByEmail) + ' · ' + new Date(d.updated || 0).toLocaleString() : '';
}
function teamEditView(tid, rid) {
  bar('Loading…', true); cur = null; base = null; lastMeta = null; stale.clear();
  view.replaceChildren(h('p', { class: 'muted' }, 'Loading team report…'));
  Cloud.ready().then(() => {
    if (!Cloud.user) { location.hash = '#account'; return; }
    if (location.hash !== '#t/' + tid + '/' + rid) return;
    let first = true, wasMember = Cloud.teams.some(t => t.id === tid);
    unsubs.push(Cloud.on(() => { // v18: removed from the team while this report is open
      if (Cloud.teams.some(t => t.id === tid)) { wasMember = true; return; }
      if (wasMember && Cloud.teamsLoaded && location.hash === '#t/' + tid + '/' + rid) { clearTimeout(saveT); cur = null; view.replaceChildren(h('p', { class: 'muted' }, 'You are no longer a member of this team, so this report is closed. Your phone-only reports are unchanged.'), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => (location.hash = '') }, 'Back to reports'))); }
    }));
    unsubs.push(Cloud.watchReport(tid, rid, snap => {
      lastMeta = snap.metadata;
      if (!snap.exists()) {
        if (snap.metadata.fromCache && first) { view.replaceChildren(h('p', { class: 'muted' }, 'This team report is not on this phone yet. Connect to the internet to load it.')); return; }
        cur = null; view.replaceChildren(h('p', { class: 'muted' }, 'This report was deleted by a team member.')); return;
      }
      const d = snap.data(); const data = normalize(Object.assign(blank(), fromForm(d))); data.id = rid; data._team = tid;
      if (first || !cur) { first = false; cur = data; base = clone(data); renderEditor(); }
      else applyRemote(data); // keyed-list deletes are ignored inside applyRemote while local writes are pending
      setLastBy(d); syncStatus();
    }, e => { view.replaceChildren(h('p', { class: 'muted' }, 'Cannot open this team report: ' + Cloud.err(e))); }));
  }, e => view.replaceChildren(h('p', { class: 'muted' }, 'Team reports need the sync library, which could not load (offline?). ' + (e.message || ''))));
}
function templateEditView(tid, id) {
  bar('Loading template…', true); cur = null; base = null;
  view.replaceChildren(h('p', { class: 'muted' }, 'Loading template…'));
  Cloud.ready().then(() => {
    if (!Cloud.user) { location.hash = '#account'; return; }
    if (location.hash !== '#tmpl/' + tid + '/' + id) return;
    let first = true;
    unsubs.push(Cloud.watchTemplate(tid, id, snap => {
      if (!snap.exists()) { cur = null; view.replaceChildren(h('p', { class: 'muted' }, 'This template was deleted.')); return; }
      const d = snap.data(); const body = fromForm(d.data || {});
      const data = normalize(Object.assign(blank(), body));
      data.id = id; data.name = d.name || data.name; data.folderId = d.folderId || null;
      data._template = { teamId: tid, id };
      if (first || !cur) { first = false; cur = data; base = clone(data); renderEditor(); }
      else { // adopt remote template fields
        cur.name = data.name; cur.folderId = data.folderId;
        for (const k of SYNC_KEYS) if (k !== 'folderId' && k !== 'name') cur[k] = data[k];
        renderEditor();
      }
      $('#saved').textContent = 'Template';
    }, e => { view.replaceChildren(h('p', { class: 'muted' }, 'Cannot open template: ' + Cloud.err(e))); }));
  }, e => view.replaceChildren(h('p', { class: 'muted' }, 'Templates need the sync library. ' + (e.message || ''))));
}
function renderEditor() {
  binds = []; bar(cur.name || 'Report', true);
  view.innerHTML = '';
  const team = cur._team && Cloud.teams.find(t => t.id === cur._team);
  if (cur._team) view.append(h('div', { class: 'teamline' }, h('b', {}, '👥 ' + (team ? team.name : 'Team report')), ' · live shared', h('div', { id: 'lastBy', class: 'muted' })));
  view.append(
    S('Header info', true,
      inp('name', 'Report name (list only)'),
      inp('header.org', 'Organization', { caps: 'characters' }),
      h('div', { class: 'grid2' }, inp('header.title', 'Trip title (ADVANCE — …)', { caps: 'characters' }), inp('header.date', 'Date', { caps: 'characters' })),
      inp('header.venue', 'Venue'),
      h('div', { class: 'grid2' }, inp('header.principal', 'Principal code', { caps: 'characters' }), inp('header.city', 'City (footer)')),
      inp('header.advance', 'Advance team names')),
    S('Trip overview', false, inp('overview.text', 'Overview', { area: true, rows: 5, hint: 'Tip: wrap text in **double asterisks** for bold, *single* for italic. New line = new paragraph.' }), inp('overview.principals', 'Principals on visit')),
    S('Weather', false, weatherFetcher(), strList('weather', null)),
    S('Intel', false, importButton('intel'), pagesBlock('intel'), pagesBlock('intel', true),
      intelEditor()),
    S('Task org', false, h('div', { class: 'hint' }, 'One name per line. Rename, add, remove or reorder columns.'), taskOrgEditor()),
    S('Vehicle package', false, vehiclesEditor()),
    S('Timeline', false, inp('timelineZone', 'Time zone label'), timelineEditor()),
    S('Key contacts', false, rows('contacts', [['name', 'Name'], ['position', 'Position'], ['contact', 'Contact information']], 'Add contact')),
    S('Primary locations · 📷', false, locationsEditor(), mapExportBlock()),
    S('Routes · 📷', false, h('div', { class: 'hint' }, 'Add one card per path. Each has its own Google Maps link and iTAK send. Photos are shared across all routes.'),
      routesEditor()),
    S('Arrival / park plan — FBO · 📷', false, inp('arrival', null, { area: true }), photoBlock('FBO / arrival photos', 'arrivalMedia.photos')),
    S('Location photos · 📷', false, inp('header.photoSize', 'Photo size in PDF (all photo sections)', { options: ['', 'Medium — 2 across', 'Small — 3 across'], blank: 'Large — full page width (default)' }), photoSections()),
    S('Coordination instructions', false, strList('coordination', null)),
    S('Lodging for team', false, h('div', { class: 'hint' }, 'One row per person: who is staying, where, the address and the phone number.'),
      rows('lodgingList', [['name', 'Name'], ['location', 'Location (hotel / lodging)'], ['address', 'Address'], ['phone', 'Phone number', { caps: 'none' }]], 'Add lodging', 'grid'),
      inp('lodging', 'Notes', { area: true, rows: 2, hint: 'Printed under the lodging chart.' })),
    S('Medical contingencies', false, importButton('medical'), pagesBlock('medical'), pagesBlock('medical', true), inp('medical.label', 'Event label'),
      h('div', { class: 'blk-h' }, 'Hospitals'), rows('medical.hospitals', [['name', 'Hospital name'], ['address', 'Address'], ['distance', 'Distance / drive time'], ['notes', 'Trauma level / notes', { area: true, rows: 3 }], ['primary', 'Primary hospital', { check: true, exclusive: true }]], 'Add hospital'), h('div', { class: 'blk-h' }, 'Sections'), sectionsEditor('medical.sections', false, 'Add sections for EMS / ambulance plan, nearest AED, pharmacies, casualty evacuation, notes…')),
    h('div', { class: 'fab' },
      cur._template ? h('button', { class: 'primary', onclick: () => flush() }, 'Save template') : h('button', { onclick: () => exportJSON(cur) }, 'Export JSON'),
      cur._team && !cur._template ? h('button', { class: 'sm', onclick: () => saveAsTemplate(cur, cur.folderId || null) }, 'Save as template') : null,
      h('button', { class: 'primary', id: 'genpdf', onclick: generatePDF }, 'Generate PDF'))
  );
  if (cur._template) view.prepend(h('div', { class: 'teamline tmplline' }, h('b', {}, '📄 Template'), ' · editing for the team — photos are not stored on templates'));
  // keep title bar in sync with name
  view.querySelector('input[data-path="name"]').addEventListener('input', e => ($('#barTitle').textContent = e.target.value));
  if (cur._template) $('#barTitle').textContent = 'Template: ' + (cur.name || '');
}

/* ---------- PDF ---------- */
const fname = (r, ext) => ('ADVANCE ' + (r.header.title || '') + ' ' + (r.header.date || '')).trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') + '.' + ext;
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src)); document.head.append(s); });
let libs; const loadPdfLibs = () => (libs ||= loadScript('lib/pdfmake.min.js').then(() => loadScript('lib/fonts.js')));
async function buildPdfBlob(r) {
  await loadPdfLibs();
  const secs = [];
  for (const sc of r.photoSections || []) {
    const photos = [];
    for (const p of sc.photos) { const rec = await P.get(r, p.id); if (rec) photos.push({ dataUrl: await toDataURL(rec.blob), w: p.w, h: p.h, caption: p.caption }); }
    if (photos.length) secs.push({ title: sc.title, photos });
  }
  const res = async list => { const o = []; for (const p of list || []) { const rec = await P.get(r, p.id); if (rec) o.push({ dataUrl: await toDataURL(rec.blob), w: p.w, h: p.h, caption: p.caption }); } return o; };
  const inline = { arrival: await res(r.arrivalMedia.photos), routes: await res(r.routes.photos), locations: [], intelPages: await res(r.intel.pages.photos), medicalPages: await res(r.medical.pages.photos), intelFigures: await res(r.intel.figures.photos), medicalFigures: await res(r.medical.figures.photos) };
  for (const l of r.locations) inline.locations.push(await res(l.photos));
  const dd = window.buildDocDefinition(r, secs, inline);
  return new Promise((res, rej) => { try { pdfMake.createPdf(dd, null, window.PDF_FONTS).getBlob(res); } catch (e) { rej(e); } });
}
const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
async function nativeDeliver(blob, name) {
  const { Filesystem, Share } = window.Capacitor.Plugins;
  const data = (await toDataURL(blob)).split(',')[1];
  const path = EXPORT_DIR + '/' + name; // v18: exports live in Caches/exports and are deleted after sharing
  const w = await Filesystem.writeFile({ path, data, directory: 'CACHE', recursive: true });
  try {
    try { await Share.share({ title: name, files: [w.uri] }); }
    catch (e) { if (!/cancel/i.test(e.message || '')) { try { await Share.share({ title: name, url: w.uri }); } catch (e2) { if (!/cancel/i.test(e2.message || '')) alert('Share failed: ' + e2.message); } } }
  } finally { Filesystem.deleteFile({ path, directory: 'CACHE' }).catch(() => { }); }
}
// v18: on start, remove export files left over from earlier versions or an interrupted share.
const EXPORT_DIR = 'exports', EXPORT_EXT = /\.(pdf|kml|zip|json)$/i;
async function sweepExports() {
  if (!isNative()) return; const F = window.Capacitor.Plugins.Filesystem; if (!F) return;
  try { await F.rmdir({ path: EXPORT_DIR, directory: 'CACHE', recursive: true }); } catch (e) { /* not there */ }
  try { const r = await F.readdir({ path: '', directory: 'CACHE' }); for (const f of r.files || []) { const n = typeof f === 'string' ? f : f.name; if ((typeof f === 'string' || f.type === 'file') && EXPORT_EXT.test(n)) await F.deleteFile({ path: n, directory: 'CACHE' }).catch(() => { }); } } catch (e) { /* ignore */ }
}
async function deliver(blob, name, type) {
  if (isNative()) return nativeDeliver(blob, name);
  const file = new File([blob], name, { type });
  const url = URL.createObjectURL(blob);
  const dl = () => { const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); };
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  window.__lastFile = file; // for tests
  sheet(name + ' ready (' + Math.round(blob.size / 1024) + ' KB)', [
    canShare ? ['Share / Save to Files…', async () => { try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') dl(); } }, 'primary'] : null,
    ['Open / Download', () => { if (type === 'application/pdf' && !canShare) window.open(url, '_blank') || dl(); else dl(); }, canShare ? '' : 'primary']
  ].filter(Boolean));
}
async function generatePDF() {
  const b = $('#genpdf'); b.disabled = true; b.textContent = 'Building…';
  try { await flush(); const blob = await buildPdfBlob(cur); await deliver(blob, fname(cur, 'pdf'), 'application/pdf'); }
  catch (e) { alert('PDF failed: ' + e.message); console.error(e); }
  finally { b.disabled = false; b.textContent = 'Generate PDF'; }
}

/* ---------- JSON export/import ---------- */
async function exportJSON(r) {
  const out = normalize(clone(r));
  for (const sc of holders(out)) { const ps = []; for (const p of sc.photos) { const rec = await P.get(r, p.id); if (rec) ps.push(Object.assign({}, p, { data: await toDataURL(rec.blob) })); } sc.photos = ps; }
  delete out._team;
  const blob = new Blob([JSON.stringify({ format: 'advance-report', version: 2, report: out })], { type: 'application/json' });
  deliver(blob, fname(r, 'json'), 'application/json');
}
function importJSON() {
  const i = h('input', { type: 'file', accept: 'application/json,.json' });
  i.onchange = async () => {
    try {
      const j = JSON.parse(await i.files[0].text()); const src = j.report || j;
      const r = normalize(Object.assign(blank(), clone(src))); r.id = uid(); r.updated = Date.now(); // migrate() handles v1 'photos'
      for (const sc of holders(r)) { const ps = []; for (const p of sc.photos || []) { if (!p.data) continue; const id = uid(); await DB.putPhoto({ id, blob: dataURLtoBlob(p.data) }); ps.push({ id, w: p.w, h: p.h, caption: p.caption || '' }); } sc.photos = ps; } r.photoSections.forEach(sc => (sc.id = uid()));
      await DB.put(r); location.hash = '#r/' + r.id;
    } catch (e) { alert('Import failed: ' + e.message); }
  };
  i.click();
}

/* ---------- Router ---------- */
async function route() {
  clearSubs(); $('#sheet').hidden = true; const hs = location.hash;
  let m;
  if (hs === '#account') accountView();
  else if ((m = hs.match(/^#t\/([^/]+)\/(.+)$/))) teamEditView(m[1], m[2]);
  else if ((m = hs.match(/^#tmpl\/([^/]+)\/(.+)$/))) templateEditView(m[1], m[2]);
  else if ((m = hs.match(/^#r\/(.+)$/))) editView(m[1]);
  else listView();
}
(async () => {
  if ('serviceWorker' in navigator && !isNative()) {
    const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded && !sessionStorage.getItem('swReloaded')) { reloaded = true; sessionStorage.setItem('swReloaded', '1'); setTimeout(() => sessionStorage.removeItem('swReloaded'), 10000); flush().finally(() => location.reload()); } });
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(e => console.warn(e));
  }
  if (Cloud.enabled()) Cloud.ready().catch(e => console.warn('team sync unavailable', e));
  sweepExports();
  await seed(); route();
})();
