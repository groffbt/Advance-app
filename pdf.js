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
    return out;
  }
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
  const has = a => a && a.some(x => x && (typeof x !== 'object' || Object.values(x).some(Boolean)));

  window.buildDocDefinition = function (r, photoSecs) {
    const h = r.header || {}; const c = [];
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

    const i = r.intel || {};
    if (Object.values(i).some(Boolean)) {
      c.push(sec('Intel'));
      const p = (t, m) => c.push(Object.assign({ text: t, margin: [0, 0, 0, 4] }, m || {}));
      if (i.eventRisk || i.eventText) p([{ text: 'Overall Risk to Event' + (i.eventRisk ? ': ' + i.eventRisk + '.' : ':'), bold: true }, ' ', ...rich(i.eventText)]);
      if (i.areaRisk || i.areaText) p([{ text: 'Overall Risk to Area' + (i.areaName ? ' (' + i.areaName + ')' : '') + (i.areaRisk ? ': ' + i.areaRisk + '.' : ':'), bold: true }, ' ', ...rich(i.areaText)]);
      if (i.movement) p([{ text: 'Movement/Access', bold: true }, ' — ', ...rich(i.movement)]);
      if (i.protest) p([{ text: 'Protest/Threat Climate:', bold: true }, ' ', ...rich(i.protest)]);
      if (i.contingency) p([{ text: 'Contingency — High-Value Principal' + (h.principal ? ' (' + h.principal + ')' : '') + ': ' }, ...rich(i.contingency)], { italics: true, fontSize: 7, lineHeight: 1.12 });
    }

    const t = r.taskOrg || {};
    const cols = [lines(t.advance), lines(t.movement), lines(t.night)];
    const n = Math.max(...cols.map(x => x.length));
    if (n) { c.push(sec('Task Org')); c.push(table(['Advance', 'Movement', 'Night'], [...Array(n)].map((_, k) => cols.map(x => x[k] || '')), ['*', '*', '*'])); }

    if (has(r.vehicles)) {
      c.push(sec('Vehicle Package'));
      c.push(table(['Description', 'Driver / Pax', 'OOM', 'Car seats', 'Issues', 'Equipment'],
        r.vehicles.map(v => [v.desc, v.driver, v.oom, v.seats, v.issues, v.equip].map(x => x || '')), [110, 128, 28, 50, 34, '*']));
    }
    if (has(r.timeline)) {
      const z = r.timelineZone ? ' (' + r.timelineZone + ')' : '';
      c.push(sec('Timeline' + z));
      c.push(table(['Time' + z.replace(/ \/ /, '/').replace(/ /g, ''), 'Event', 'Remarks'].map((x, k) => k ? x : 'Time' + (r.timelineZone ? ' (' + r.timelineZone.replace(/\s*\/\s*/, '/') + ')' : '')),
        r.timeline.map(e => [e.time, e.event, e.remarks].map(x => x || '')), [112, 165, '*']));
    }
    if (has(r.contacts)) { c.push(sec('Key Contacts')); c.push(table(['Name', 'Position', 'Contact information'], r.contacts.map(e => [e.name, e.position, e.contact].map(x => x || '')), [110, 160, '*'])); }
    if (has(r.locations)) {
      c.push(sec('Primary Locations'));
      c.push(table(['Name', 'Address', 'Map'], r.locations.map(e => [e.name || '', e.address || '',
        e.map ? { text: e.map.replace(/^https?:\/\//, ''), link: /^https?:/.test(e.map) ? e.map : 'https://' + e.map, font: 'Mono', fontSize: 5.6 } : '']), [62, '*', 140]));
    }
    const ro = r.routes || {};
    if (ro.notes || has(ro.legs) || ro.alert) {
      c.push(sec('Routes'));
      lines(ro.notes).forEach(l => c.push({ text: labeled(l), margin: [0, 0, 0, 3] }));
      if (has(ro.legs)) c.push(table(['Leg', 'Time / Distance'], ro.legs.map(e => [e.leg || '', e.time || '']), [270, '*']));
      if (ro.alert) c.push({ margin: [0, 2, 0, 2], table: { widths: ['*'], body: [[{ text: (ro.alertLabel ? ro.alertLabel + ' — ' : '') + ro.alert, bold: true, margin: [4, 3, 4, 3] }]] },
        layout: { hLineWidth: () => 1, vLineWidth: () => 1 } });
    }
    if (r.arrival) { c.push(sec('Arrival / Park Plan — FBO')); lines(r.arrival).forEach(l => c.push({ text: rich(l), margin: [0, 0, 0, 3] })); }

    (photoSecs || []).filter(sc => sc.photos && sc.photos.length).forEach(sc => {
      c.push(sec(sc.title || 'Photos'));
      const photos = sc.photos;
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
        c.push({ columns: row, columnGap: gap, margin: [0, k ? gap : 2, 0, 0], unbreakable: true });
      }
    });
    if (has(r.coordination)) { c.push(sec('Coordination Instructions')); c.push({ ul: r.coordination.filter(Boolean).map(l => ({ text: labeled(l) })), margin: [6, 0, 0, 0] }); }
    if (r.lodging) { c.push(sec('Lodging for Team')); lines(r.lodging).forEach(l => c.push({ text: rich(l) })); }
    const m = r.medical || {};
    if (m.label || has(m.hospitals)) {
      c.push(sec('Medical Contingencies'));
      if (m.label) c.push({ text: m.label, bold: true, margin: [0, 0, 0, 3] });
      (m.hospitals || []).forEach(x => c.push({ unbreakable: true, margin: [0, 0, 0, 3], stack: [
        { text: (x.primary ? 'Primary — ' : '') + (x.name || ''), bold: true },
        { text: [x.address, x.distance, x.notes].filter(Boolean).map(s => s.replace(/\.?\s*$/, '')).join('. ') + '.' }] }));
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
