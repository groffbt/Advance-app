// Builds a pdfmake document definition matching the reference ADVANCE report layout.
(function () {
  const W = 612 - 2 * 29; // content width
  function rich(str, base) {
    // minimal markup: **bold**, *italic*
    const out = []; const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g; let last = 0, m;
    str = str || '';
    while ((m = re.exec(str))) {
      if (m.index > last) out.push(Object.assign({ text: str.slice(last, m.index) }, base));
      const t = m[0];
      if (t.startsWith('**')) out.push(Object.assign({ text: t.slice(2, -2), bold: true }, base));
      else out.push(Object.assign({ text: t.slice(1, -1), italics: true }, base));
      last = m.index + t.length;
    }
    if (last < str.length) out.push(Object.assign({ text: str.slice(last) }, base));
    return linkify(out);
  }
  // v19: web links anywhere in typed text become real, tappable PDF links (short blue underlined text)
  const URL_SRC = '\\b(?:https?:\\/\\/|www\\.)[^\\s<>"]*[^\\s<>".,;:!?)\\]\'*]';
  const hasUrl = x => new RegExp(URL_SRC, 'i').test(String(x || ''));
  const LINK = { color: '#0645ad', decoration: 'underline' };
  const hrefOf = u => /^https?:/i.test(u) ? u : 'https://' + u;
  const shortUrl = u => { const t = u.replace(/^https?:\/\//i, '').replace(/^www\./i, ''); return t.length > 40 ? t.slice(0, 38) + '…' : t; };
  function linkify(runs) {
    return runs.flatMap(r => {
      const str = String(r.text || ''); if (r.link || !hasUrl(str)) return [r];
      const out = [], re = new RegExp(URL_SRC, 'gi'); let last = 0, m;
      while ((m = re.exec(str))) {
        if (m.index > last) out.push(Object.assign({}, r, { text: str.slice(last, m.index) }));
        out.push(Object.assign({}, r, LINK, { text: shortUrl(m[0]), link: hrefOf(m[0]) }));
        last = m.index + m[0].length;
      }
      if (last < str.length) out.push(Object.assign({}, r, { text: str.slice(last) }));
      return out;
    });
  }
  const cell = x => { x = x == null ? '' : String(x); return hasUrl(x) ? { text: linkify([{ text: x }]) } : x; }; // plain table text, links made tappable
  function labeled(line) { // "Label: rest" -> bold label
    if (/\*\*/.test(line)) return rich(line);
    const i = line.indexOf(':');
    if (i > 0 && i < 40) return [{ text: line.slice(0, i + 1), bold: true }, ...rich(line.slice(i + 1))];
    return rich(line);
  }
  const lines = s => (s || '').split('\n').map(x => x.trim()).filter(Boolean);
  function sec(title) {
    return { unbreakable: true, margin: [0, 7, 0, 3], stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 0.6, lineColor: '#888' }] },
      { text: title.toUpperCase(), bold: true, fontSize: 8.6, characterSpacing: 1.3, margin: [0, 3, 0, 2] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 1.1 }] }] };
  }
  const layout = {
    hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#444', vLineColor: () => '#444',
    paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 1.6, paddingBottom: () => 1.2,
    fillColor: r => (r === 0 ? '#000' : null)
  };
  function table(heads, rows, widths, extra) {
    if (!rows.length) return null;
    return Object.assign({ margin: [0, 2, 0, 3], table: { headerRows: 1, dontBreakRows: true, widths,
      body: [heads.map(h => ({ text: h.toUpperCase(), bold: true, color: '#fff', fontSize: 6.3, characterSpacing: 0.4 })), ...rows] }, layout }, extra || {});
  }
  // v19: even chart — columns with no data are hidden, widths shared by weight so nothing bunches up
  function chart(defs, items, keep) {
    const val = (e, d) => String(e[d[0]] ?? '').trim();
    const cols = defs.filter(d => (keep || []).includes(d[0]) || items.some(e => val(e, d)));
    if (!cols.length) return null;
    const avail = W - cols.length * 6.5 - 0.5, tot = cols.reduce((a, d) => a + d[2], 0);
    return table(cols.map(d => typeof d[1] === 'function' ? d[1](items) : d[1]), items.map(e => cols.map(d => d[3] ? d[3](e) : cell(e[d[0]]))), cols.map(d => Math.floor(avail * d[2] / tot * 10) / 10));
  }
  const RTs = () => window.RouteTools;
  function mapHref(e) { // Map column: link from the map field, or from coordinates typed as the address
    const m = String(e.map || '').trim(), RT = RTs();
    if (/^(?:https?:\/\/|www\.)/i.test(m) || /^[\w-]+(?:\.[\w-]+)+\/\S*$/.test(m) && !/\s/.test(m)) return hrefOf(m);
    const ll = RT && RT.parseCoords && (RT.parseCoords(m) || (!m && RT.parseCoords(e.address)));
    return ll ? 'https://www.google.com/maps/search/?api=1&query=' + ll.lat + ',' + ll.lon : '';
  }
  const has = a => a && a.some(x => x && (typeof x !== 'object' || Object.values(x).some(Boolean)));

  // [key, header, width weight, renderer]
  const VEH_COLS = [['oom', 'OOM', 4, v => ({ text: v.oom || '', bold: true, alignment: 'center' })], ['desc', 'Vehicle', 15, v => ({ text: rich(v.desc || ''), bold: true })], ['plate', 'Plate', 9],
    ['driver', vs => vs.some(v => /\//.test(v.driver || '')) && !vs.some(v => String(v.pax || '').trim()) ? 'Driver / Pax' : 'Driver', 11], ['pax', 'Passengers', 15],
    ['seats', 'Car seats', 6, v => ({ text: v.seats || '', alignment: 'center' })], ['equip', 'Equipment', 14], ['issues', 'Issues / notes', 13]];
  window.VEH_COLS = VEH_COLS.map(d => d[0]);
  window.fmtDay = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); if (!m) return '';
    return new Date(+m[1], m[2] - 1, +m[3]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); };
  window.buildDocDefinition = function (r, photoSecs, inline) {
    const h = r.header || {}; const c = []; inline = inline || {};
    // v19: photo size (report setting). Large (default): landscape photos span the page width, portrait photos
    // two across; Medium: two across; Small: the old three-across grid. Full stored resolution is embedded.
    const pSize = /^small/i.test(h.photoSize || '') ? 3 : /^medium/i.test(h.photoSize || '') ? 2 : 1;
    const bigCell = (ph, w, maxH) => ({ width: w, stack: [{ image: ph.dataUrl, fit: [w, maxH], alignment: 'center' }]
      .concat(ph.caption ? [{ text: ph.caption, fontSize: 7.4, bold: true, alignment: 'center', margin: [0, 2, 0, 0] }] : []) });
    const grid = (photos, pre) => {
      if (!photos || !photos.length) { (pre || []).forEach(x => c.push(x)); return; }
      if (pSize < 3) {
        const gap = 8, half = (W - gap) / 2, rowsOut = []; let k = 0;
        while (k < photos.length) {
          const a = photos[k], b = photos[k + 1], wide = x => x.w >= x.h * 1.05;
          if (pSize === 1 && wide(a)) { rowsOut.push([bigCell(a, W, 420)]); k += 1; continue; }
          if (pSize === 1 && b && wide(b)) { rowsOut.push([bigCell(a, half, 370), { width: half, text: '' }]); k += 1; continue; }
          rowsOut.push([bigCell(a, half, pSize === 1 ? 370 : 250), b ? bigCell(b, half, pSize === 1 ? 370 : 250) : { width: half, text: '' }]); k += 2;
        }
        rowsOut.forEach((cols, i) => {
          const rowEl = cols.length === 1 ? Object.assign({ margin: [0, i ? gap : 2, 0, 0] }, cols[0], { width: undefined }) : { columns: cols, columnGap: gap, margin: [0, i ? gap : 2, 0, 0] };
          c.push(i === 0 && pre && pre.length ? { stack: [...pre, rowEl], unbreakable: true } : Object.assign(rowEl, { unbreakable: true }));
        });
        return;
      }
      const gap = 5, cw = (W - 2 * gap) / 3, ch = 137, iw = cw - 8, ih = ch - 8, gw = iw - 22;
      for (let k = 0; k < photos.length; k += 3) {
        const row = photos.slice(k, k + 3).map(ph => {
          const s = Math.min(gw / ph.w, ih / ph.h), dh = ph.h * s, top = (ih - dh) / 2;
          const stack = [{ margin: [4, 4, 4, 4], table: { widths: ['*'], body: [[{ image: ph.dataUrl, fit: [gw, ih], alignment: 'center', margin: [0, top, 0, ih - dh - top] }]] }, layout: 'noBorders' }];
          if (ph.caption) stack.push({ text: ph.caption, fontSize: 6.4, lineHeight: 1.1, alignment: 'center', margin: [4, -2, 4, 4] });
          return { width: cw, table: { widths: ['*'], body: [[{ stack }]] },
            layout: { hLineWidth: () => 0.8, vLineWidth: () => 0.8, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 } };
        });
        while (row.length < 3) row.push({ width: cw, text: '' });
        const rowEl = { columns: row, columnGap: gap, margin: [0, k ? gap : 2, 0, 0] };
        c.push(k === 0 && pre && pre.length ? { stack: [...pre, rowEl], unbreakable: true } : Object.assign(rowEl, { unbreakable: true }));
      }
    };
    // Header block
    c.push({ text: (h.org || '').toUpperCase(), bold: true, fontSize: 7.4, characterSpacing: 1.5, margin: [0, 0, 0, 2] });
    c.push({ columns: [
      { text: 'ADVANCE — ' + (h.title || '').toUpperCase(), bold: true, fontSize: 14.5 },
      { text: h.date || '', bold: true, fontSize: 8.5, alignment: 'right', margin: [0, 5, 0, 0] }] });
    c.push({ columns: [
      { text: [h.venue || '', h.principal ? '  ·  ' + h.principal : ''].join(''), fontSize: 8.3 },
      { text: h.advance ? 'Advance: ' + h.advance : '', fontSize: 8.3, alignment: 'right' }], margin: [0, 1, 0, 5] });
    c.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 2.6 }], margin: [0, 0, 0, 2] });

    const o = r.overview || {};
    if (o.text || o.principals) {
      c.push(sec('Trip Overview'));
      lines(o.text).forEach(l => c.push({ text: rich(l), margin: [0, 0, 0, 3] }));
      if (o.principals) c.push({ text: [{ text: 'Principals on visit — ', bold: true }, ...rich(o.principals)], margin: [0, 0, 0, 1] });
    }
    if (has(r.weather)) { c.push(sec('Weather')); c.push({ ul: r.weather.filter(Boolean).map(l => ({ text: labeled(l) })), margin: [6, 0, 0, 0] }); }

    // original imported PDF pages: one per page, fit to the printable area, aspect kept
    // When the section has no typed content, its heading starts a new page and the first original page sits under it.
    const fullPages = (list, alone) => (list || []).forEach((ph, k) => c.push(alone && k === 0 ? { image: ph.dataUrl, fit: [554, 690], alignment: 'center' } : { image: ph.dataUrl, fit: [554, 726], alignment: 'center', pageBreak: 'before' }));
    const secTop = (t, alone) => { const x = sec(t); if (alone) c.push({ text: '', pageBreak: 'before' }); c.push(x); };
    const figures = list => (list || []).forEach(ph => c.push({ unbreakable: true, margin: [0, 4, 0, 6], stack: [{ image: ph.dataUrl, fit: [W, 380], alignment: 'center' }].concat(ph.caption ? [{ text: ph.caption, bold: true, italics: true, fontSize: 7, alignment: 'center', margin: [0, 2, 0, 0] }] : []) }));
    const i = r.intel || {}; const iPages = inline.intelPages || [], iFigs = inline.intelFigures || [];
    // titled sub-sections (Intel / Medical): bold uppercase sub-heading (+ risk badge), then text
    const subSecs = (list, fallback, RC) => list.forEach(x => {
      const head = [{ text: (x.title || fallback).toUpperCase(), bold: true, characterSpacing: 0.4 }];
      if (x.risk) head.push({ text: '   ' }, { text: ' RISK: ' + x.risk + ' ', bold: true, color: '#fff', background: (RC && RC[x.risk]) || '#444', fontSize: 6.6 });
      c.push({ text: head, margin: [0, 3, 0, 1] });
      if (x.text) lines(x.text).forEach(l => c.push({ text: rich(l), margin: [0, 0, 0, 2] }));
    });
    const iSecs = (Array.isArray(i.sections) ? i.sections : []).filter(x => x && (x.title || x.text || x.risk)); const iText = iSecs.length > 0;
    const RC = { 'LOW': '#2a7a3a', 'LOW–MODERATE': '#5c8a1f', 'MODERATE': '#b07800', 'MODERATE–HIGH': '#c25400', 'HIGH': '#b3261e', 'CRITICAL': '#7a0000' };
    if (iText || iPages.length || iFigs.length) {
      secTop('Intel', !iText && !iFigs.length);
      subSecs(iSecs, 'Intel', RC);
      figures(iFigs); fullPages(iPages, !iText && !iFigs.length);
    }

    const t = r.taskOrg || {};
    const tcols = (Array.isArray(t.columns) ? t.columns : [['Advance', t.advance], ['Movement', t.movement], ['Night', t.night]].map(([title, names]) => ({ title, names })))
      .map(x => ({ title: x.title || '', names: lines(x.names) })).filter(x => x.names.length || x.title.trim());
    if (tcols.some(x => x.names.length)) { // up to 4 columns per table; more wrap into further tables
      c.push(sec('Task Org'));
      for (let g = 0; g < tcols.length; g += 4) {
        const grp = tcols.slice(g, g + 4), n = Math.max(1, ...grp.map(x => x.names.length));
        const tb = table(grp.map(x => x.title), [...Array(n)].map((_, k) => grp.map(x => x.names[k] || '')), grp.map(() => '*'));
        c.push(g ? Object.assign({ margin: [0, 6, 0, 0] }, { stack: [tb] }) : tb);
      }
    }

    const vehs = (r.vehicles || []).filter(v => v && VEH_COLS.some(d => String(v[d[0]] ?? '').trim()));
    if (vehs.length) { // v19: even chart, one row per vehicle, empty columns hidden
      c.push(sec('Vehicle Package'));
      c.push(chart(VEH_COLS, vehs, ['desc']));
    }
    if (has((r.timeline || []).filter(e => e.day == null))) {
      const z = r.timelineZone ? ' (' + r.timelineZone + ')' : '';
      c.push(sec('Timeline' + z));
      c.push(table(['Time' + z.replace(/ \/ /, '/').replace(/ /g, ''), 'Event', 'Remarks'].map((x, k) => k ? x : 'Time' + (r.timelineZone ? ' (' + r.timelineZone.replace(/\s*\/\s*/, '/') + ')' : '')),
        r.timeline.filter(e => e.day == null || e.day).map(e => e.day != null ? [{ text: window.fmtDay(e.day).toUpperCase(), colSpan: 3, bold: true, fontSize: 7, characterSpacing: 0.6, fillColor: '#d9d9d9' }, {}, {}] : [e.time, e.event, e.remarks].map(cell)), [112, 165, '*']));
    }
    if (has(r.contacts)) { c.push(sec('Key Contacts')); c.push(table(['Name', 'Position', 'Contact information'], r.contacts.map(e => [e.name, e.position, e.contact].map(cell)), [110, 160, '*'])); }
    if (has((r.locations || []).map(({ photos, ...x }) => x))) {
      c.push(sec('Primary Locations'));
      // v19: Notes is a column; Map is a real tappable link ("Open map")
      const locs = r.locations.filter(e => e && ['name', 'address', 'map', 'notes'].some(k => String(e[k] || '').trim()));
      c.push(chart([['name', 'Name', 15, e => ({ text: e.name || '', bold: true })], ['address', 'Address', 22], ['notes', 'Notes', 26, e => lines(e.notes).length ? { stack: lines(e.notes).map(l => ({ text: rich(l) })) } : ''],
        ['_mapcol', 'Map', 8, e => e._href ? { text: 'Open map', link: e._href, color: LINK.color, decoration: 'underline', bold: true } : cell(e.map)]],
        locs.map(e => { const u = mapHref(e); return Object.assign({}, e, { _href: u, _mapcol: u || e.map || '' }); }), ['name']));
      r.locations.forEach((e, k) => {
        const ph = (inline.locations || [])[k] || [];
        if (!ph.length) return;
        const pre = [{ text: (e.name || 'Location ' + (k + 1)).toUpperCase() + ' — PHOTOS', bold: true, fontSize: 7.4, characterSpacing: 1, margin: [0, 5, 0, 1] }];
        grid(ph, pre);
      });
    }
    const ro = r.routes || {};
    const rList = Array.isArray(ro.list) && ro.list.length ? ro.list
      : ((ro.notes || has(ro.legs) || ro.alert || (ro.stops && ro.stops.length) || (ro.est && ro.est.legs)) ? [{ name: 'Primary', notes: ro.notes, legs: ro.legs, stops: ro.stops, est: ro.est, alert: ro.alert, alertLabel: ro.alertLabel }] : []);
    const RT = window.RouteTools;
    const filledStops = rt => RT ? RT.filled(rt.stops) : (rt.stops || []).filter(s => s && String(s.address || '').trim());
    const stopLabel = (s, i) => RT && RT.stopName ? RT.stopName(s, i) : (String(s.label || '').trim() || String(s.address || '').trim().split(',')[0] || ('Stop ' + (i + 1)));
    const routeHasContent = rt => {
      const u = RT ? RT.mapsUrl(rt.stops) : '';
      const e = RT ? RT.freshEst(rt) : null;
      return !!(rt.notes || has(rt.legs) || rt.alert || u || e || (rt.stops && rt.stops.length));
    };
    const anyRoute = rList.some(routeHasContent);
    if (anyRoute) {
      c.push(sec('Routes'));
      const chartRows = []; let anyEst = false;
      rList.forEach((rt, ri) => {
        if (!routeHasContent(rt)) return;
        const filled = filledStops(rt);
        if (!filled.length) return; // no stops → no chart row
        const rEst = RT ? RT.freshEst(rt) : null;
        const rUrl = RT ? RT.mapsUrl(rt.stops) : '';
        if (rEst) anyEst = true;
        const tt = rEst ? RT.totals(rEst.legs) : null;
        const last = filled.length - 1;
        chartRows.push([
          { text: rt.name || ('Route ' + (ri + 1)), bold: true },
          stopLabel(filled[0], 0),
          stopLabel(filled[last], last),
          tt ? RT.fmtMin(tt.sec) : '',
          tt ? RT.fmtMi(tt.m) : '',
          rUrl ? { text: 'Open', link: rUrl, color: LINK.color, decoration: 'underline', bold: true } : '',
          'Use app' // iTAK needs a shareable mission package; PDF cannot open it
        ]);
      });
      if (chartRows.length) {
        c.push(table(['Route', 'Start', 'Stop', 'Calculated time', 'Distance', 'Google', 'iTAK'],
          chartRows, [68, '*', '*', 52, 42, 34, 34]));
        if (anyEst) c.push({ text: '(estimated drive times, no live traffic)', italics: true, color: '#555', fontSize: 6.5, margin: [0, 0, 0, 4] });
      }
      // Per-route notes / typed Legs / alert (Google link lives only in the chart)
      rList.forEach((rt, ri) => {
        if (!routeHasContent(rt)) return;
        if (!(rt.notes || has(rt.legs) || rt.alert)) return;
        c.push({ text: (rt.name || ('Route ' + (ri + 1))).toUpperCase(), bold: true, fontSize: 8, characterSpacing: 1.2, margin: [0, 8, 0, 3] });
        lines(rt.notes).forEach(l => c.push({ text: labeled(l), margin: [0, 0, 0, 3] }));
        if (has(rt.legs)) c.push(table(['Leg', 'Time / Distance'], rt.legs.map(e => [{ text: e.leg || '', bold: true }, e.time || '']), [270, '*']));
        if (rt.alert) c.push({ margin: [0, 2, 0, 2], table: { widths: ['*'], body: [[{ text: (rt.alertLabel ? rt.alertLabel + ' — ' : '') + rt.alert, bold: true, margin: [4, 3, 4, 3] }]] },
          layout: { hLineWidth: () => 1, vLineWidth: () => 1 } });
      });
    }
    if (inline.routes && inline.routes.length) { if (!anyRoute) c.push(sec('Routes')); grid(inline.routes); }
    if (r.arrival || (inline.arrival && inline.arrival.length)) { c.push(sec('Arrival / Park Plan — FBO')); lines(r.arrival).forEach(l => c.push({ text: rich(l), margin: [0, 0, 0, 3] })); grid(inline.arrival); }

    (photoSecs || []).filter(sc => sc.photos && sc.photos.length).forEach(sc => grid(sc.photos, [sec(sc.title || 'Photos')]));
    if (has(r.coordination)) { c.push(sec('Coordination Instructions')); c.push({ ul: r.coordination.filter(Boolean).map(l => ({ text: labeled(l) })), margin: [6, 0, 0, 0] }); }
    const lodg = (r.lodgingList || []).filter(e => e && ['name', 'location', 'address', 'phone'].some(k => String(e[k] || '').trim()));
    if (lodg.length || r.lodging) { // v18: chart (Name | Location | Address | Phone number), empty columns hidden; old free text = notes below
      c.push(sec('Lodging for Team'));
      if (lodg.length) {
        const tel = p => String(p || '').replace(/[^\d+]/g, '');
        const cols = [['name', 'Name', 90, e => ({ text: e.name || '', bold: true })], ['location', 'Location', 110, e => e.location || ''], ['address', 'Address', '*', e => e.address || ''],
          ['phone', 'Phone number', 80, e => e.phone ? (tel(e.phone).length >= 3 ? { text: e.phone, link: 'tel:' + tel(e.phone), color: '#0645ad' } : e.phone) : '']]
          .filter(([k]) => lodg.some(e => String(e[k] || '').trim()));
        if (!cols.some(x => x[2] === '*')) cols[cols.length - 1][2] = '*';
        c.push(table(cols.map(x => x[1]), lodg.map(e => cols.map(x => x[3](e))), cols.map(x => x[2])));
      }
      if (r.lodging) lines(r.lodging).forEach(l => c.push({ text: rich(l), margin: [0, 2, 0, 0] }));
    }
    const m = r.medical || {};
    const mPages = inline.medicalPages || [], mFigs = inline.medicalFigures || [];
    const mSecs = (Array.isArray(m.sections) ? m.sections : []).filter(x => x && (x.title || x.text));
    const mText = !!(m.label || has(m.hospitals) || mSecs.length);
    if (mText || mPages.length || mFigs.length) {
      secTop('Medical Contingencies', !mText && !mFigs.length);
      if (m.label) c.push({ text: m.label, bold: true, margin: [0, 0, 0, 3] });
      (m.hospitals || []).forEach(x => c.push({ unbreakable: true, margin: [0, 0, 0, 3], stack: [
        { text: (x.primary ? 'Primary — ' : '') + (x.name || ''), bold: true },
        { text: [x.address, x.distance, x.notes].filter(Boolean).map(s => s.replace(/\.?\s*$/, '')).join('. ') + '.' }] }));
      subSecs(mSecs, 'Medical');
      figures(mFigs); fullPages(mPages, !mText && !mFigs.length);
    }

    const foot = [h.city, h.date, h.advance].filter(Boolean).join(' | ');
    return {
      pageSize: 'LETTER', pageMargins: [29, 24, 29, 40],
      info: { title: 'ADVANCE — ' + (h.title || ''), creator: 'Advance Report PWA' },
      defaultStyle: { font: 'Sans', fontSize: 7.9, lineHeight: 1.18 },
      content: c.filter(Boolean),
      footer: (cur, total) => ({ margin: [29, 14, 29, 0], fontSize: 5.8, columns: [
        { width: 'auto', text: 'UNCLASSIFIED // FOR OFFICIAL USE — ADVANCE' + (h.principal ? ' ' + h.principal : '') },
        { width: '*', text: foot, margin: [16, 0, 0, 0] },
        { width: 'auto', text: 'Page ' + cur + ' of ' + total }] })
    };
  };
  window.PDF_FONTS = {
    Sans: { normal: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf', italics: 'LiberationSans-Italic.ttf', bolditalics: 'LiberationSans-BoldItalic.ttf' },
    Mono: { normal: 'LiberationMono-Regular.ttf', bold: 'LiberationMono-Regular.ttf', italics: 'LiberationMono-Regular.ttf', bolditalics: 'LiberationMono-Regular.ttf' }
  };
})();
