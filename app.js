'use strict';
/* Advance Report PWA — fully client-side. No network calls except same-origin static files. */
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
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('advance-reports', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('reports', { keyPath: 'id' }); r.result.createObjectStore('photos', { keyPath: 'id' }); };
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
    id: uid(), name: 'New Advance', updated: Date.now(),
    header: { org: '', title: '', date: '', venue: '', principal: '', city: '', advance: '' },
    overview: { text: '', principals: '' }, weather: [''],
    intel: { eventRisk: '', eventText: '', areaName: '', areaRisk: '', areaText: '', movement: '', protest: '', contingency: '' },
    taskOrg: { advance: '', movement: '', night: '' },
    vehicles: [], timelineZone: 'LOCAL', timeline: [], contacts: [], locations: [],
    routes: { notes: '', legs: [], alertLabel: 'Restricted', alert: '' }, arrival: '', photoSections: [],
    coordination: [''], lodging: '', medical: { label: '', hospitals: [] }
  };
}
function migrate(r) { // old format: r.photos + r.dropLabel -> one titled section
  if (!Array.isArray(r.photoSections)) r.photoSections = [];
  if (Array.isArray(r.photos)) { if (r.photos.length) r.photoSections.unshift({ id: uid(), title: 'Drop Site — Event', photos: r.photos }); }
  delete r.photos; delete r.dropLabel;
  r.photoSections.forEach(sc => { sc.id ||= uid(); sc.title ??= ''; sc.photos ||= []; sc.photos.forEach(p => (p.caption ??= '')); });
  return r;
}
const allPhotos = r => (r.photoSections || []).flatMap(sc => sc.photos || []);
function normalize(r) { migrate(r); const b = blank(); for (const k in b) if (r[k] == null) r[k] = b[k]; for (const k of ['header', 'overview', 'intel', 'taskOrg', 'routes', 'medical']) r[k] = Object.assign(clone(b[k]), r[k]); return r; }
const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setP = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

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
async function addPhotos(arr, files) {
  for (const f of files) {
    const { blob, w, h: hh } = await compress(f);
    const id = uid(); await DB.putPhoto({ id, blob }); arr.push({ id, w, h: hh, caption: '' });
  }
}
async function copyPhotos(list) {
  const out = [];
  for (const p of list) { const rec = await DB.photo(p.id); if (!rec) continue; const id = uid(); await DB.putPhoto({ id, blob: rec.blob }); out.push(Object.assign({}, p, { id })); }
  return out;
}

/* ---------- Seed sample ---------- */
async function seed() { /* public build: no bundled sample */ }

/* ---------- Views ---------- */
let cur = null, saveT = null;
const view = $('#view');
function bar(title, back) { $('#barTitle').textContent = title; $('#back').hidden = !back; $('#saved').textContent = ''; }
$('#back').onclick = () => { flush(); location.hash = ''; };
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => flush());
document.addEventListener('visibilitychange', () => document.hidden && flush());

function sheet(title, buttons) {
  const s = $('#sheet'); s.innerHTML = ''; s.hidden = false;
  const box = h('div', {}, h('h3', { style: 'margin:0 0 6px' }, title), ...buttons.map(([t, fn, cls]) => h('button', { class: cls || '', onclick: async () => { if (fn) { const keep = await fn(); if (keep === true) return; } s.hidden = true; } }, t)), h('button', { onclick: () => (s.hidden = true) }, 'Cancel'));
  s.append(box); s.onclick = e => { if (e.target === s) s.hidden = true; };
}

async function listView() {
  bar('Advance Reports', false); cur = null;
  const rs = (await DB.all()).sort((a, b) => b.updated - a.updated);
  view.innerHTML = '';
  view.append(h('div', { class: 'row', style: 'margin:0 0 12px' },
    h('button', { class: 'primary', style: 'flex:1', onclick: async () => { const r = blank(); await DB.put(r); location.hash = '#r/' + r.id; } }, '＋ New report'),
    h('button', { onclick: importJSON }, 'Import JSON')));
  if (!rs.length) view.append(h('p', { class: 'muted' }, 'No reports yet.'));
  for (const r of rs) {
    view.append(h('div', { class: 'card' },
      h('h3', { onclick: () => (location.hash = '#r/' + r.id), style: 'cursor:pointer' }, r.name || 'Untitled'),
      h('div', { class: 'muted' }, [r.header.city, r.header.date, r.header.advance].filter(Boolean).join(' · ') || '—'),
      h('div', { class: 'muted' }, 'Edited ' + new Date(r.updated).toLocaleString()),
      h('div', { class: 'row' },
        h('button', { class: 'primary sm', onclick: () => (location.hash = '#r/' + r.id) }, 'Open'),
        h('button', { class: 'sm', onclick: async () => { const n = normalize(clone(r)); n.id = uid(); n.name = 'Copy of ' + r.name; n.updated = Date.now(); for (const sc of n.photoSections) { sc.id = uid(); sc.photos = await copyPhotos(sc.photos); } await DB.put(n); listView(); } }, 'Duplicate'),
        h('button', { class: 'sm', onclick: () => exportJSON(r) }, 'Export'),
        h('button', { class: 'danger sm', onclick: () => sheet('Delete “' + r.name + '”? This cannot be undone.', [['Delete report', async () => { for (const p of allPhotos(normalize(clone(r)))) await DB.delPhoto(p.id); await DB.del(r.id); listView(); }, 'danger']]) }, 'Delete'))));
  }
  view.append(h('p', { class: 'hint' }, 'All data stays on this device (IndexedDB). Nothing is sent anywhere. Use Export to back up or share a report between phones.'));
}

function save() { clearTimeout(saveT); $('#saved').textContent = '…'; saveT = setTimeout(flush, 400); }
async function flush() { clearTimeout(saveT); saveT = null; if (!cur) return; cur.updated = Date.now(); await DB.put(cur); $('#saved').textContent = 'Saved ✓'; }

const RISKS = ['', 'LOW', 'LOW–MODERATE', 'MODERATE', 'MODERATE–HIGH', 'HIGH', 'CRITICAL'];
function inp(path, label, opt = {}) {
  const v = getP(cur, path) ?? '';
  let el;
  if (opt.area) el = h('textarea', { rows: opt.rows || 4 }, v);
  else if (opt.options) { el = h('select', {}, ...opt.options.map(o => h('option', { value: o, selected: o === v }, o || '— select —'))); }
  else el = h('input', { type: 'text', value: v, placeholder: opt.ph || '', autocapitalize: opt.caps || 'sentences' });
  el.value = v;
  el.addEventListener(opt.options ? 'change' : 'input', () => { setP(cur, path, el.value); save(); });
  return h('div', {}, label ? h('label', {}, label) : null, el, opt.hint ? h('div', { class: 'hint' }, opt.hint) : null);
}
function strList(path, label, ph) {
  const wrap = h('div');
  const draw = () => {
    wrap.innerHTML = ''; const arr = getP(cur, path);
    if (label) wrap.append(h('label', {}, label));
    arr.forEach((_, i) => {
      const t = h('textarea', { rows: 2, placeholder: ph || '' }); t.value = arr[i];
      t.oninput = () => { arr[i] = t.value; save(); };
      wrap.append(h('div', { class: 'item' }, t, h('div', { class: 'tools', style: 'margin-top:6px' }, h('button', { class: 'danger sm', onclick: () => { arr.splice(i, 1); save(); draw(); } }, 'Remove'))));
    });
    wrap.append(h('button', { class: 'sm', onclick: () => { arr.push(''); save(); draw(); } }, '＋ Add bullet'));
  };
  draw(); return wrap;
}
function rows(path, cols, addLabel, extra) {
  const wrap = h('div');
  const draw = () => {
    wrap.innerHTML = ''; const arr = getP(cur, path);
    arr.forEach((row, i) => {
      const fields = cols.map(([k, lab, o = {}]) => {
        if (o.check) { const c = h('input', { type: 'checkbox' }); c.checked = !!row[k]; c.onchange = () => { if (o.exclusive && c.checked) arr.forEach(x => (x[k] = false)); row[k] = c.checked; save(); if (o.exclusive) draw(); }; return h('label', { class: 'chk' }, c, lab); }
        return inp(path + '.' + i + '.' + k, lab, o);
      });
      wrap.append(h('div', { class: 'item' }, h('div', { class: extra === 'grid' ? 'grid2' : '' }, ...fields),
        h('div', { class: 'tools', style: 'margin-top:8px' },
          i > 0 ? h('button', { class: 'sm', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '↑') : null,
          i < arr.length - 1 ? h('button', { class: 'sm', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '↓') : null,
          h('button', { class: 'danger sm', onclick: () => { arr.splice(i, 1); save(); draw(); } }, 'Remove'))));
    });
    wrap.append(h('button', { class: 'sm', onclick: () => { arr.push(Object.fromEntries(cols.map(([k]) => [k, '']))); save(); draw(); } }, '＋ ' + addLabel));
  };
  draw(); return wrap;
}
function photoGrid(sc) {
  const wrap = h('div'); const urls = [];
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', class: 'lib-in' });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' });
  const status = h('div', { class: 'hint' });
  const onFiles = async e => { const fs = [...e.target.files]; e.target.value = ''; if (!fs.length) return; status.textContent = 'Compressing ' + fs.length + ' photo(s)…'; await addPhotos(sc.photos, fs); await flush(); status.textContent = ''; draw(); };
  fileIn.onchange = onFiles; camIn.onchange = onFiles;
  const grid = h('div', { class: 'photos' });
  const draw = async () => {
    urls.splice(0).forEach(URL.revokeObjectURL);
    const arr = sc.photos; const cells = [];
    for (let i = 0; i < arr.length; i++) {
      const rec = await DB.photo(arr[i].id); const u = rec ? URL.createObjectURL(rec.blob) : ''; urls.push(u);
      const cap = h('input', { type: 'text', class: 'cap', placeholder: 'Caption (optional)', value: arr[i].caption || '' });
      cap.value = arr[i].caption || ''; cap.oninput = () => { arr[i].caption = cap.value; save(); };
      cells.push(h('div', {}, h('div', { class: 'ph' }, h('img', { src: u, alt: 'photo ' + (i + 1) }),
        h('button', { class: 'x', 'aria-label': 'Remove photo', onclick: () => sheet('Remove this photo?', [['Remove', async () => { await DB.delPhoto(arr[i].id); arr.splice(i, 1); await flush(); draw(); }, 'danger']]) }, '✕'),
        h('div', { class: 'mv' }, i > 0 ? h('button', { onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '‹') : null,
          i < arr.length - 1 ? h('button', { onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '›') : null)), cap));
    }
    grid.replaceChildren(...cells);
  };
  wrap.append(h('div', { class: 'row' }, h('button', { class: 'primary sm', onclick: () => camIn.click() }, '📷 Camera'), h('button', { class: 'sm', onclick: () => fileIn.click() }, '🖼 Photo library')), fileIn, camIn, status, grid);
  draw(); return wrap;
}
function photoSections() {
  const wrap = h('div');
  const draw = () => {
    const arr = cur.photoSections; wrap.innerHTML = '';
    arr.forEach((sc, i) => {
      const t = h('input', { type: 'text', class: 'sec-title', placeholder: 'e.g. Drop Site — Event, FBO Arrival, Hotel Entrance', autocapitalize: 'words' }); t.value = sc.title;
      t.oninput = () => { sc.title = t.value; save(); };
      wrap.append(h('div', { class: 'item psec' }, h('label', {}, 'Section title'), t, photoGrid(sc),
        h('div', { class: 'tools', style: 'margin-top:8px' },
          i > 0 ? h('button', { class: 'sm', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; save(); draw(); } }, '↑ Move up') : null,
          i < arr.length - 1 ? h('button', { class: 'sm', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; save(); draw(); } }, '↓ Move down') : null,
          h('button', { class: 'danger sm', onclick: () => sheet('Delete section “' + (sc.title || 'Untitled') + '” and its ' + sc.photos.length + ' photo(s)?', [['Delete section', async () => { for (const p of sc.photos) await DB.delPhoto(p.id); arr.splice(i, 1); await flush(); draw(); }, 'danger']]) }, 'Delete section'))));
    });
    wrap.append(h('button', { class: 'primary sm add-psec', onclick: () => { arr.push({ id: uid(), title: '', photos: [] }); save(); draw(); wrap.querySelectorAll('.sec-title')[arr.length - 1].focus(); } }, '＋ Add photo section'),
      h('div', { class: 'hint' }, 'Each section prints as its own titled header with a 3-across photo grid. Photos are resized to ≤1600px JPEG on-device. Sections without photos are skipped in the PDF.'));
  };
  draw(); return wrap;
}

function S(title, open, ...kids) { return h('details', { class: 'sec', open }, h('summary', {}, title), h('div', { class: 'body' }, ...kids)); }

async function editView(id) {
  const r = await DB.get(id); if (!r) { location.hash = ''; return; }
  cur = normalize(r); bar(cur.name || 'Report', true);
  view.innerHTML = '';
  view.append(
    S('Header info', true,
      inp('name', 'Report name (list only)'),
      inp('header.org', 'Organization', { caps: 'characters' }),
      h('div', { class: 'grid2' }, inp('header.title', 'Trip title (ADVANCE — …)', { ph: 'DC VISIT', caps: 'characters' }), inp('header.date', 'Date', { ph: '8 OCT 2026', caps: 'characters' })),
      inp('header.venue', 'Venue'),
      h('div', { class: 'grid2' }, inp('header.principal', 'Principal code', { ph: 'V1', caps: 'characters' }), inp('header.city', 'City (footer)', { ph: 'Washington, DC' })),
      inp('header.advance', 'Advance team names', { ph: 'Smith / Jones / Lee' })),
    S('Trip overview', false, inp('overview.text', 'Overview', { area: true, rows: 5, hint: 'Tip: wrap text in **double asterisks** for bold, *single* for italic. New line = new paragraph.' }), inp('overview.principals', 'Principals on visit')),
    S('Weather', false, strList('weather', null, 'Thu 8 OCT: Mostly sunny, high near 79°F')),
    S('Intel', false,
      inp('intel.eventRisk', 'Overall risk to event', { options: RISKS }), inp('intel.eventText', null, { area: true, rows: 5 }),
      inp('intel.areaName', 'Area name', { ph: 'D.C./Arlington' }), inp('intel.areaRisk', 'Overall risk to area', { options: RISKS }), inp('intel.areaText', null, { area: true }),
      inp('intel.movement', 'Movement / access', { area: true, rows: 2 }), inp('intel.protest', 'Protest / threat climate', { area: true, rows: 5 }),
      inp('intel.contingency', 'Contingency — high-value principal', { area: true, rows: 4 })),
    S('Task org', false, h('div', { class: 'hint' }, 'One name per line.'), inp('taskOrg.advance', 'Advance', { area: true, rows: 4 }), inp('taskOrg.movement', 'Movement', { area: true, rows: 4 }), inp('taskOrg.night', 'Night', { area: true, rows: 3 })),
    S('Vehicle package', false, rows('vehicles', [['desc', 'Description'], ['driver', 'Driver / Pax'], ['oom', 'OOM'], ['seats', 'Car seats'], ['issues', 'Issues'], ['equip', 'Equipment']], 'Add vehicle', 'grid')),
    S('Timeline', false, inp('timelineZone', 'Time zone label', { ph: 'LOCAL / EST' }), rows('timeline', [['time', 'Time'], ['event', 'Event'], ['remarks', 'Remarks']], 'Add timeline row')),
    S('Key contacts', false, rows('contacts', [['name', 'Name'], ['position', 'Position'], ['contact', 'Contact information']], 'Add contact')),
    S('Primary locations', false, rows('locations', [['name', 'Name'], ['address', 'Address'], ['map', 'Map link', { caps: 'none' }]], 'Add location')),
    S('Routes', false, inp('routes.notes', 'Notes (one per line, “Label: text”)', { area: true, rows: 5 }), h('label', {}, 'Legs'),
      rows('routes.legs', [['leg', 'Leg'], ['time', 'Time / distance']], 'Add leg', 'grid'),
      inp('routes.alertLabel', 'Callout label', { ph: 'Restricted' }), inp('routes.alert', 'Restricted / alert callout', { area: true, rows: 2 })),
    S('Arrival / park plan — FBO', false, inp('arrival', null, { area: true })),
    S('Location photos', false, photoSections()),
    S('Coordination instructions', false, strList('coordination', null, 'Attire: Business Formal')),
    S('Lodging for team', false, inp('lodging', null, { area: true, rows: 2 })),
    S('Medical contingencies', false, inp('medical.label', 'Event label', { ph: 'Venue (Thu 8 OCT)' }),
      rows('medical.hospitals', [['name', 'Hospital name'], ['address', 'Address'], ['distance', 'Distance / drive time'], ['notes', 'Trauma level / notes', { area: true, rows: 3 }], ['primary', 'Primary hospital', { check: true, exclusive: true }]], 'Add hospital')),
    h('div', { class: 'fab' }, h('button', { onclick: () => exportJSON(cur) }, 'Export JSON'), h('button', { class: 'primary', id: 'genpdf', onclick: generatePDF }, 'Generate PDF'))
  );
  // keep title bar in sync with name
  view.querySelector('input').addEventListener('input', e => ($('#barTitle').textContent = e.target.value));
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
    for (const p of sc.photos) { const rec = await DB.photo(p.id); if (rec) photos.push({ dataUrl: await toDataURL(rec.blob), w: p.w, h: p.h, caption: p.caption }); }
    if (photos.length) secs.push({ title: sc.title, photos });
  }
  const dd = window.buildDocDefinition(r, secs);
  return new Promise((res, rej) => { try { pdfMake.createPdf(dd, null, window.PDF_FONTS).getBlob(res); } catch (e) { rej(e); } });
}
async function deliver(blob, name, type) {
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
  for (const sc of out.photoSections) { const ps = []; for (const p of sc.photos) { const rec = await DB.photo(p.id); if (rec) ps.push(Object.assign({}, p, { data: await toDataURL(rec.blob) })); } sc.photos = ps; }
  const blob = new Blob([JSON.stringify({ format: 'advance-report', version: 2, report: out })], { type: 'application/json' });
  deliver(blob, fname(r, 'json'), 'application/json');
}
function importJSON() {
  const i = h('input', { type: 'file', accept: 'application/json,.json' });
  i.onchange = async () => {
    try {
      const j = JSON.parse(await i.files[0].text()); const src = j.report || j;
      const r = normalize(Object.assign(blank(), clone(src))); r.id = uid(); r.updated = Date.now(); // migrate() handles v1 'photos'
      for (const sc of r.photoSections) { const ps = []; for (const p of sc.photos) { if (!p.data) continue; const id = uid(); await DB.putPhoto({ id, blob: dataURLtoBlob(p.data) }); ps.push({ id, w: p.w, h: p.h, caption: p.caption || '' }); } sc.id = uid(); sc.photos = ps; }
      await DB.put(r); location.hash = '#r/' + r.id;
    } catch (e) { alert('Import failed: ' + e.message); }
  };
  i.click();
}

/* ---------- Router ---------- */
async function route() { const m = location.hash.match(/^#r\/(.+)$/); if (m) editView(m[1]); else listView(); }
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn(e));
  await seed(); route();
})();
