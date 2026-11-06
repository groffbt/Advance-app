'use strict';
/* Import PDF / JSON into the Intel and Medical sections. Parsing is pure (testable in Node); PDF text is
   extracted fully offline with the bundled Mozilla pdf.js (lib/pdfjs, legacy build). */
(function (root) {
  const RISK_LIST = ['LOW', 'LOW–MODERATE', 'MODERATE', 'MODERATE–HIGH', 'HIGH', 'CRITICAL'];
  const INTEL_KEYS = ['eventRisk', 'eventText', 'areaName', 'areaRisk', 'areaText', 'movement', 'protest', 'contingency'];
  const HOSP_KEYS = ['name', 'address', 'distance', 'notes'];
  const str = v => v == null ? '' : Array.isArray(v) ? v.map(str).filter(Boolean).join('\n') : typeof v === 'object' ? '' : String(v).trim();
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const newKey = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // "low to moderate", "Low-Mod", "medium", "HIGH" -> RISKS value, else ''
  function matchRisk(s) {
    let t = ' ' + str(s).toUpperCase().replace(/MEDIUM|\bMED\b|\bMOD\b/g, 'MODERATE').replace(/\s*(?:-|–|—|\/|\bTO\b)\s*/g, '–') + ' ';
    for (const r of RISK_LIST.slice().sort((a, b) => b.length - a.length)) if (new RegExp('[^A-Z–]' + r + '[^A-Z–]').test(t)) return r;
    return '';
  }

  /* ---------- JSON ---------- */
  // Legacy flat Intel fields (v9 and older) -> sections. With tag=true the sections carry fixed keys + a legacy tag
  // so they keep mirroring into the old fields for older app builds in a team.
  const LEGACY_INTEL = [
    ['event', 'Event', 'eventRisk', 'eventText'], ['area', 'Area', 'areaRisk', 'areaText'], ['movement', 'Movement / Access', null, 'movement'],
    ['protest', 'Protest / Threat climate', null, 'protest'], ['contingency', 'Contingency — high-value principal', null, 'contingency']];
  function legacySection(o, [id, title, rk, tk], tag) {
    const risk = rk ? matchRisk(str(o[rk])) : '', text = str(o[tk]), t = id === 'area' ? (str(o.areaName) || title) : title;
    const hasData = !!(risk || text || (id === 'area' && str(o.areaName)));
    if (!hasData) return null;
    const x = { _k: tag ? 'legacy-' + id : newKey(), title: t, risk, text }; if (tag) x.legacy = id; return x;
  }
  const intelLegacyToSections = (o, tag) => LEGACY_INTEL.map(d => legacySection(o || {}, d, tag)).filter(Boolean);
  function intelFromJSON(j) {
    const src = isObj(j) && (isObj(j.report) && isObj(j.report.intel) ? j.report.intel : isObj(j.intel) ? j.intel : j);
    let secs = null;
    if (Array.isArray(j)) secs = j; else if (isObj(src) && Array.isArray(src.sections)) secs = src.sections;
    if (!secs && !isObj(src)) throw new Error('No Intel data found in this JSON.');
    const out = secs ? secs.filter(isObj).map(x => ({ _k: newKey(), title: str(x.title || x.heading || x.name), risk: x.risk ? matchRisk(x.risk) : '', text: str(x.text || x.body || x.content) })).filter(x => x.title || x.text || x.risk)
      : intelLegacyToSections(src, false);
    if (!out.length) throw new Error('No Intel sections found in this JSON.');
    return { sections: out };
  }
  function hospital(o) {
    if (typeof o === 'string') o = { name: o };
    if (!isObj(o)) return null;
    const x = { _k: newKey(), primary: o.primary === true || /^(true|yes|1)$/i.test(str(o.primary)) };
    for (const k of HOSP_KEYS) x[k] = str(o[k]);
    return x.name || x.address || x.distance || x.notes ? x : null;
  }
  function medicalFromJSON(j) {
    let src = Array.isArray(j) ? { hospitals: j } : isObj(j) && (isObj(j.report) && isObj(j.report.medical) ? j.report.medical : isObj(j.medical) ? j.medical : Array.isArray(j.hospitals) ? j : null);
    if (!src && isObj(j) && Array.isArray(j.sections)) src = j;
    if (!src && isObj(j) && (j.name || j.address)) src = { hospitals: [j] }; // a single hospital object
    if (!isObj(src)) throw new Error('No Medical data found in this JSON.');
    const out = { label: str(src.label), hospitals: (Array.isArray(src.hospitals) ? src.hospitals : []).map(hospital).filter(Boolean),
      sections: (Array.isArray(src.sections) ? src.sections : []).filter(isObj).map(x => ({ _k: newKey(), title: str(x.title || x.heading || x.name), text: str(x.text || x.body || x.content) })).filter(x => x.title || x.text) };
    if (out.hospitals.filter(x => x.primary).length > 1) out.hospitals.forEach((x, i, a) => (x.primary = i === a.findIndex(y => y.primary)));
    if (!out.label && !out.hospitals.length && !out.sections.length) throw new Error('No Medical fields found in this JSON.');
    return out;
  }

  /* ---------- PDF text heuristics ---------- */
  const tidy = a => a.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const RISK_PHRASE = /^(?:(?:overall\s+)?risk(?:\s+level)?\s*[:\-–—]?\s*)?(low|moderate|medium|high|critical|elevated)(?:\s*(?:-|–|—|\/|to)\s*(moderate|medium|high))?\b\.?\s*[:\-–—.]?\s*/i;
  const KNOWN_HEAD = /^(?:(?:overall\s+)?risk\s+to\s+(?:the\s+)?(?:event|area|venue|site)|movement(?:\s*(?:\/|and|&)\s*access)?|access|traffic|protests?(?:\s*(?:\/|and|&)\s*threats?)?(?:\s+climate)?|threats?(?:\s+climate|\s+assessment)?|contingenc(?:y|ies)(?:\s*[—–-]\s*high[\s-]value\s+principal)?|crime|terrorism|weather|summary|overview|background|assessment|recommendations?|notes?)\b/i;
  const titleish = l => { const w = l.replace(/[\/&—–\-]+/g, ' ').split(/\s+/).filter(x => /[A-Za-z]/.test(x)); if (!w.length || w.length > 8) return false;
    const small = /^(of|and|to|the|a|an|in|on|for|at|by|or|vs)$/i; const caps = w.filter(x => /^[A-Z]/.test(x) || small.test(x)).length; return caps / w.length >= 0.6; };
  const cleanTitle = t => { t = t.replace(/^\s*(?:\d+[.)]|[IVX]+\.|[-•*])\s*/, '').replace(/\s*[:\-–—]\s*$/, '').trim(); return /[a-z]/.test(t) ? t : t.toLowerCase().replace(/(^|[\s\-\/(])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Of|And|To|The|In|On|For|At|By|Or)\b/g, (w, x, i) => (i ? w.toLowerCase() : w)).replace(/\b(Ems|Aeds?|Lz|Mci|Er|Icu|Emt|Casevac|Medevac|Ppe|Us|Dc|Cbrn)\b/g, w => w.toUpperCase().replace(/S$/, w.endsWith('s') && w.length > 3 ? 's' : 'S')); };
  // One section per heading: title = cleaned heading, risk from the heading line or the first body line, text = paragraphs.
  function parseIntelText(text) {
    const secs = []; let cur = null;
    const start = (title, risk) => { if (cur && !cur.lines.join('').trim() && !(cur.risk && risk)) { if (!cur.risk) cur.risk = risk; if (/^overall risk to|^risk\b/i.test(cur.title) || cur.title === 'Summary') cur.title = title; return; } cur = { title, risk: risk || '', lines: [] }; secs.push(cur); };
    const lines = String(text).split(/\r?\n/);
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k].replace(/\s+/g, ' ').trim();
      if (!line) { if (cur) cur.lines.push(''); continue; }
      if (BOILER_RE.test(line) || CAPLINE_RE.test(line)) continue;
      if (/^intel(?:ligence)?(?:\s+(?:summary|brief|briefing|assessment|update|report))?\s*:?$/i.test(line)) continue; // document title
      let m = line.match(/^([^:]{2,48}):\s*(.*)$/);
      if (m && m[1].split(/\s+/).length <= 7 && line.length <= 140 && !/^\d/.test(m[1]) && (KNOWN_HEAD.test(m[1]) || titleish(m[1]) || /^area\b/i.test(m[1]))) {
        let rest = m[2].trim(), risk = '';
        const rm = rest.match(RISK_PHRASE); if (rm && (rm[0].length === rest.length || /^(overall\s+)?risk/i.test(m[1]) || /^[-–—:.]/.test(rest.slice(rm[0].length).trim()) || rest.slice(rm[0].length).trim() === '')) { risk = matchRisk(rm[0]); rest = rest.slice(rm[0].length).trim(); }
        let title = cleanTitle(m[1]);
        if (rest && rest.length <= 40 && !/[.!?]$/.test(rest) && !risk) { title += ' — ' + rest; rest = ''; }
        start(title, risk); if (rest) cur.lines.push(rest); continue;
      }
      const short = line.length <= 60 && !/[.!?,;]$/.test(line) && /^[A-Z]/.test(line);
      if (short && (KNOWN_HEAD.test(line) || /^[^a-z]*[A-Z]{3}[^a-z]*$/.test(line) || titleish(line))) {
        let title = line, risk = '';
        const tm = line.match(/^(.*?)\s*[\(\[\-–—]\s*((?:low|moderate|medium|high|critical)(?:\s*(?:-|–|—|\/|to)\s*(?:moderate|medium|high))?)\s*(?:risk)?\s*[\)\]]?\s*$/i);
        if (tm && tm[1]) { title = tm[1]; risk = matchRisk(tm[2]); }
        start(cleanTitle(title), risk); continue;
      }
      if (!cur) { cur = { title: 'Summary', risk: '', lines: [] }; secs.push(cur); }
      if (!cur.risk && !cur.lines.join('').trim()) { const rm = line.match(/^(?:overall\s+)?risk(?:\s+level)?\s*[:\-–—]\s*(.+)$/i); if (rm && matchRisk(rm[1])) { cur.risk = matchRisk(rm[1]); const r2 = rm[1].replace(RISK_PHRASE, '').trim(); if (r2) cur.lines.push(r2); continue; } }
      cur.lines.push(line);
    }
    return { sections: secs.map(x => ({ _k: newKey(), title: x.title, risk: x.risk, text: tidy(x.lines) })).filter(x => x.title || x.text || x.risk) };
  }

  const HOSP_RE = /\b(hospital|medical\s+(?:center|centre|ctr)|med\.?\s*ctr|trauma\s+center|health\s*(?:care|system)?\s+center|infirmary|emergency\s+(?:room|department|center)|urgent\s+care)\b/i;
  const ADDR_RE = /^\d+[A-Za-z]?\s+\S+.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|pl|place|ct|court|cir|circle|ter|terrace|sq|square|pike|route|rte)\b\.?|,\s*[A-Z]{2}\.?\s+\d{5}(?:-\d{4})?\b|^\d+\s+[NSEW]\.?\s+\w+/i;
  const DIST_RE = /\b\d+(?:\.\d+)?\s*(?:mi|mile|miles|min|mins|minutes|km|kilometers)\b/i;
  // document noise that never belongs in a field
  const BOILER_RE = /^page\s+\d+(\s+of\s+\d+)?$|for official use|^confidential|sensitive but|do not (distribute|forward)|disclaimer|this (document|report|information|plan) (is|was|has|may)|prepared by|all rights reserved|subject to change|^generated\b|^(www\.|https?:)|^printed\b/i;
  const CAPLINE_RE = /^(fig(?:ure)?\.?\s*\d+|map|chart|graph|diagram|exhibit)\s*\d*\s*[:.\-–—]/i; // figure captions (kept with the figure)
  const PHONE_RE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g;
  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
  const SPECS = [[/\bburn\b/i, 'Burn unit'], [/\bpediatric|\bpaediatric|children'?s/i, 'Pediatric'], [/\bstroke\b/i, 'Stroke center'], [/\bcardiac|\bstemi\b|cath(?:eterization)?\s+lab|\bpci\b/i, 'Cardiac'],
    [/\bneuro(?:surg|logy)/i, 'Neurosurgery'], [/\bobstetric|\blabor\s*&?\s*delivery|\bl&d\b/i, 'Obstetrics'], [/\bhyperbaric/i, 'Hyperbaric'], [/\borthop/i, 'Orthopedics']];
  const titleCase = n => (/[a-z]/.test(n) ? n : n.toLowerCase().replace(/(^|[\s\-\/(])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Er|Icu|Va|Usa|Ii|Iii|Iv)\b/g, w => w.toUpperCase()));
  function facts(lines) { // pull the important hospital facts out of its lines
    const all = lines.join('\n'), f = { trauma: '', lvl: 9, peds: false, phones: [], specs: [], helipad: false, er: '' };
    let m = all.match(/\b(pediatric\s+|adult\s+)?level\s*(IV|V|I{1,3}|[1-5])\b\s*(?:(pediatric|adult)\s+)?trauma/i) || all.match(/\btrauma\s+(?:center\s*)?[,(\-–]?\s*level\s*(IV|V|I{1,3}|[1-5])\b/i);
    if (m) { const raw = (m[2] || m[1]).toUpperCase(); const lv = ROMAN[raw] || +raw; const ped = /pediatric/i.test(m[0]); f.lvl = lv + (ped ? 10 : 0); f.peds = ped;
      f.trauma = (ped ? 'Pediatric ' : '') + 'Level ' + (['', 'I', 'II', 'III', 'IV', 'V'][lv] || raw) + ' Trauma Center'; }
    else if (/\b(not\s+a|non[-\s]?|no)\s+trauma/i.test(all)) f.trauma = 'Not a trauma center';
    for (const l of lines) for (const pm of l.matchAll(PHONE_RE)) {
      const before = l.slice(0, pm.index).match(/\b(main|er|ed|emergency|security|nurse|switchboard|phone|tel)\.?\s*[:#]?\s*$/i);
      const lab = before ? ({ phone: '', tel: '', ed: 'ER', emergency: 'ER', er: 'ER' }[before[1].toLowerCase()] ?? before[1][0].toUpperCase() + before[1].slice(1).toLowerCase()) : '';
      const ph = '(' + pm[1] + ') ' + pm[2] + '-' + pm[3]; if (!f.phones.some(x => x.endsWith(ph))) f.phones.push((lab ? lab + ' ' : '') + ph);
    }
    for (const [re, name] of SPECS) if (re.test(all) && !(name === 'Pediatric' && f.peds)) f.specs.push(name);
    if (/cath(?:eterization)?\s+lab/i.test(all)) f.specs = f.specs.map(x => (x === 'Cardiac' ? 'Cardiac (cath lab)' : x));
    f.helipad = /\bheli(?:pad|port|stop)\b/i.test(all);
    m = all.match(/\b(?:er|ed|emergency(?:\s+(?:room|dept|department))?)\b[^\n]{0,20}?\b(24\s*\/\s*7|24\s*hours?|24-hour)/i) || all.match(/\b(24\s*\/\s*7)\b/);
    if (m) f.er = 'ER 24/7'; else if ((m = all.match(/\b(?:er\s+)?hours?\s*:?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i))) f.er = 'Hours ' + m[1].replace(/\s+/g, '');
    return f;
  }
  const CAPTURE_RE = /\b(level\s*(IV|V|I{1,3}|[1-5])\b|trauma|heli(pad|port|stop)|burn|pediatric|stroke|cardiac|cath\s+lab|stemi|24\s*\/\s*7|24\s*hours?|hours?\s*:?\s*\d)/i;
  const MED_HEAD = /^(?:nearest\s+|closest\s+|on[-\s]?site\s+)?(?:ems|ambulance|emergency\s+medical\s+services|casevac|casualty(?:\s+evac\w*)?|medevac|evacuation|aeds?|defibrillators?|first\s+aid|medical\s+kits?|trauma\s+kits?|pharmac(?:y|ies)|clinics?|notes?|summary|overview|communications?|mass\s+casualty|mci|staging|landing\s+zones?|lz|helicopter|poison\s+control|medical\s+(?:support|staff|team|plan|notes))\b/i;
  function medHead(line) {
    if (/\d|,/.test(line) || HOSP_RE.test(line) || ADDR_RE.test(line) || CAPTURE_RE.test(line)) {
      const m = line.match(/^([^:]{2,40}):\s*(.+)$/); // "Nearest AED: lobby by security" (digits allowed in the text part)
      if (m && MED_HEAD.test(m[1]) && !/\d/.test(m[1])) return { title: cleanTitle(m[1]), rest: m[2].trim() };
      return null;
    }
    const m = line.match(/^([^:]{2,40}):\s*(.*)$/);
    if (m && (MED_HEAD.test(m[1]) || titleish(m[1])) && m[1].split(/\s+/).length <= 6) return { title: cleanTitle(m[1]), rest: m[2].trim() };
    if (line.length <= 60 && !/[.!?;]$/.test(line) && /^[A-Z]/.test(line) && (MED_HEAD.test(line) || /^[^a-z]*[A-Z]{3}[^a-z]*$/.test(line) || titleish(line))) return { title: cleanTitle(line), rest: '' };
    return null;
  }
  function parseMedicalText(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !BOILER_RE.test(l) && !CAPLINE_RE.test(l));
    const hs = []; const pre = []; const secs = []; let cur = null, curSec = null;
    const fresh = name => { curSec = null; cur = { _k: newKey(), name, address: '', distance: '', notes: '', primary: false, raw: [], extra: [] }; hs.push(cur); };
    for (let line of lines) {
      if (/^medical(?:\s+contingenc(?:y|ies)|\s+plan|\s+support)?\s*:?$/i.test(line)) continue;
      if (/^(?:area\s+|nearest\s+|nearby\s+)?(?:hospitals?|medical\s+facilities|trauma\s+centers?)\s*:?$/i.test(line)) { cur = null; curSec = null; continue; } // list heading
      const sentence0 = /^(the|closest|nearest|if|in|for|all|note|call|use|transport|patients?)\b/i.test(line) && /[a-z]/.test(line);
      const isHosp0 = HOSP_RE.test(line) && !ADDR_RE.test(line) && !sentence0 && !/^trauma\s+level|^level\s+[IV1-5]+\b|^(not\s+a|non[-\s]?)\s*trauma/i.test(line) && line.length < 140;
      if (!isHosp0) { // non-hospital heading (EMS plan, AED, pharmacy, notes…) -> its own section
        const sh = medHead(line);
        if (sh && cur && !curSec && sh.rest && /^notes?$/i.test(sh.title)) { /* inline hospital note */ }
        else if (sh && (cur || curSec || pre.length || MED_HEAD.test(line))) { cur = null; curSec = { title: sh.title, lines: sh.rest ? [sh.rest] : [] }; secs.push(curSec); continue; }
      }
      if (curSec && !isHosp0 && !/^(name|hospital|facility)\s*[:\-–—]/i.test(line)) { curSec.lines.push(line); continue; }
      const lab = line.match(/^(name|hospital|facility|address|location|distance|drive(?:\s+time)?|eta|notes?|remarks|comments)\s*[:\-–—]\s*(.*)$/i);
      if (lab) {
        const k = lab[1].toLowerCase(), v = lab[2];
        if (/^(name|hospital|facility)$/.test(k)) { fresh(v); continue; }
        if (!cur) fresh('');
        if (/^(address|location)$/.test(k)) cur.address = cur.address ? cur.address + ', ' + v : v;
        else if (/^(distance|drive|eta)/.test(k)) cur.distance = cur.distance ? cur.distance + ' · ' + v : v;
        else { cur.raw.push(v); cur.extra.push(v); }
        if (/primary/i.test(line)) cur.primary = true;
        continue;
      }
      const sentence = /^(the|closest|nearest|if|in|for|all|note|call|use|transport|patients?)\b/i.test(line) && /[a-z]/.test(line);
      const isHosp = HOSP_RE.test(line) && !ADDR_RE.test(line) && !sentence && !/^trauma\s+level|^level\s+[IV1-5]+\b|^(not\s+a|non[-\s]?)\s*trauma/i.test(line) && line.length < 140;
      if (isHosp) {
        let ln = line.replace(/^\s*(?:#?\d+[.):]|[-•*])\s*/, '');
        const primary = /\bprimary\b/i.test(ln);
        ln = ln.replace(/\s*[\(\[]?\s*primary\s*(?:hospital)?\s*[\)\]]?\s*[:\-–—]?/i, ' ').replace(/^primary\s*(?:hospital)?\s*[:\-–—]\s*/i, '').trim();
        const segs = ln.split(/\s+[|–—-]\s+|\s*\|\s*/).map(x => x.trim()).filter(Boolean);
        const ni = Math.max(0, segs.findIndex(x => HOSP_RE.test(x) && !/^(pediatric\s+|adult\s+)?level\b/i.test(x)));
        let name = segs[ni]; const rest = segs.filter((_, i) => i !== ni);
        let dist = ''; const dm = name.match(/\s*[,(]\s*([^,(]*\b\d+(?:\.\d+)?\s*(?:mi|miles?|min|mins|minutes|km)\b[^)]*)\)?\s*$/i); if (dm) { dist = dm[1].trim(); name = name.slice(0, dm.index).trim(); }
        fresh(titleCase(name)); if (primary) cur.primary = true;
        for (const r of rest) { if (DIST_RE.test(r) && !cur.distance) cur.distance = r; else cur.raw.push(r); }
        if (dist) cur.distance = dist; continue;
      }
      if (!cur) { pre.push(line); continue; }
      cur.raw.push(line);
      const noPhone = line.replace(PHONE_RE, '').trim();
      if (!cur.address && ADDR_RE.test(line) && !DIST_RE.test(line.replace(/\d{5}/, ''))) cur.address = line;
      else if (cur.address && !cur.distance && !DIST_RE.test(line) && !CAPTURE_RE.test(line) && !/\d{3}[\s.-]\d{4}/.test(line) && /^[A-Za-z .'-]+,\s*[A-Z]{2}\b/.test(line)) cur.address += ', ' + line; // city/state line
      else if (DIST_RE.test(line) && line.length < 80 && !CAPTURE_RE.test(line)) { const d = line.replace(/^(?:drive\s*time|distance|eta|approx\.?)\s*[:\-–]?\s*/i, ''); cur.distance = cur.distance ? cur.distance + ' · ' + d : d; }
      else { if (/^primary\b/i.test(line)) cur.primary = true;
        const leftover = noPhone.replace(/^(main|er|ed|phone|tel|security)\.?\s*[:#]?\s*/gi, '').replace(/\b(main|er|phone|tel)\s*:?\s*$/i, '').trim();
        if (!CAPTURE_RE.test(line) && leftover.length > 3 && !/^[\W\d]+$/.test(leftover)) cur.extra.push(line); }
    }
    for (const x of hs) {
      const f = facts([x.name, ...x.raw]); x._lvl = f.lvl; x._peds = f.peds;
      const key = [f.trauma, ...f.phones, f.specs.join(', '), f.helipad ? 'Helipad' : '', f.er].filter(Boolean).join(' · ');
      const extra = x.extra.filter(l => !BOILER_RE.test(l) && l.length <= 160).slice(0, 3).map(l => l.replace(/\s*\.$/, '.'));
      x.notes = [key, ...extra].filter(Boolean).join('\n');
      delete x.raw; delete x.extra;
    }
    if (hs.filter(x => x.primary).length > 1) hs.forEach((x, i, a) => (x.primary = i === a.findIndex(y => y.primary)));
    if (hs.length && !hs.some(x => x.primary)) { // none marked: best (adult before pediatric-only) trauma level, then closest
      const mins = x => { const m = x.distance.match(/(\d+(?:\.\d+)?)\s*min/i); if (m) return +m[1]; const mi = x.distance.match(/(\d+(?:\.\d+)?)\s*mi/i); return mi ? +mi[1] * 2.5 : 999; };
      [...hs].sort((a, b) => a._lvl - b._lvl || mins(a) - mins(b))[0].primary = true;
    }
    hs.forEach(x => { delete x._lvl; delete x._peds; });
    // label: document title if it looks like one
    let label = '';
    const title = pre.find(l => l.length <= 90 && !/[.;]$/.test(l));
    if (title) label = title.replace(/^medical\s*(?:contingenc(?:y|ies)|plan|support|annex|brief)?\s*[:\-–—|]?\s*/i, '').trim();
    const sections = secs.map(x => ({ _k: newKey(), title: x.title, text: tidy(x.lines) })).filter(x => x.text || x.title);
    const rest = pre.filter(l => l !== title);
    if (!hs.length && !sections.length && pre.length) // nothing recognizable: keep all text in a Summary section
      return { label: '', hospitals: [], sections: [{ _k: newKey(), title: 'Summary', text: lines.join('\n') }], unparsed: true };
    if (rest.length) sections.unshift({ _k: newKey(), title: 'Summary', text: rest.join('\n') });
    return { label, hospitals: hs, sections };
  }

  /* ---------- merge ---------- */
  function mergeIntel(old, inc, mode) {
    const fresh = (inc.sections || []).map(x => ({ _k: newKey(), title: x.title || '', risk: x.risk || '', text: x.text || '' }));
    return Object.assign({}, old, { sections: mode === 'replace' ? fresh : (old.sections || []).concat(fresh) });
  }
  function mergeMedical(old, inc, mode) {
    const hs = inc.hospitals.map(x => Object.assign({}, x, { _k: newKey() }));
    const ns = (inc.sections || []).map(x => ({ _k: newKey(), title: x.title || '', text: x.text || '' }));
    if (mode === 'replace') return { label: inc.label || '', hospitals: hs, sections: ns, pages: old.pages, figures: old.figures };
    const had = (old.hospitals || []).some(x => x.primary); if (had) hs.forEach(x => (x.primary = false));
    const label = !inc.label || old.label === inc.label ? old.label || '' : old.label ? old.label + ' / ' + inc.label : inc.label;
    return { label, hospitals: (old.hospitals || []).concat(hs), sections: (old.sections || []).concat(ns), pages: old.pages, figures: old.figures };
  }

  /* ---------- PDF extraction (browser) ---------- */
  let pdfp;
  function loadPdfJs() {
    return pdfp ||= new Promise((res, rej) => {
      if (root.pdfjsLib) return res(root.pdfjsLib);
      const s = document.createElement('script'); s.src = 'lib/pdfjs/pdf.min.js';
      s.onload = () => { const L = root.pdfjsLib || root['pdfjs-dist/build/pdf']; if (!L) return rej(new Error('PDF reader failed to load')); L.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js'; res(L); };
      s.onerror = () => { pdfp = null; rej(new Error('PDF reader failed to load')); }; document.head.append(s);
    });
  }
  // text with line breaks, rebuilt from item positions
  async function pdfText(buf) {
    const L = await loadPdfJs();
    const doc = await L.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n); const tc = await pg.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!('str' in it)) continue; const y = it.transform[5], x = it.transform[4];
        let r = rows.find(r => Math.abs(r.y - y) < Math.max(2, (it.height || 10) * 0.4));
        if (!r) rows.push(r = { y, parts: [] }); r.parts.push({ x, s: it.str, w: it.width || 0 });
      }
      rows.sort((a, b) => b.y - a.y);
      let lastY = null; const out = [];
      for (const r of rows) {
        r.parts.sort((a, b) => a.x - b.x); let line = '', end = null;
        for (const p of r.parts) { if (end != null && p.x - end > 1.5 && !/\s$/.test(line) && !/^\s/.test(p.s)) line += ' '; line += p.s; end = p.x + p.w; }
        if (lastY != null && lastY - r.y > 24) out.push(''); lastY = r.y; out.push(line.trim());
      }
      pages.push(out.join('\n')); pg.cleanup && pg.cleanup();
    }
    doc.destroy && doc.destroy();
    return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  // render every page to a JPEG blob (~150 dpi, max 1600 px wide), keeping the original look
  async function renderPages(buf, onProgress) {
    const L = await loadPdfJs();
    const doc = await L.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true }).promise;
    const out = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        if (onProgress) onProgress(n, doc.numPages);
        const pg = await doc.getPage(n); const v1 = pg.getViewport({ scale: 1 });
        const scale = Math.min(150 / 72, 1600 / v1.width, 2200 / v1.height); const vp = pg.getViewport({ scale });
        const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
        await pg.render({ canvasContext: x, viewport: vp, background: '#ffffff' }).promise;
        const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.9));
        out.push({ blob, w: cv.width, h: cv.height }); cv.width = cv.height = 0; pg.cleanup && pg.cleanup();
      }
    } finally { doc.destroy && doc.destroy(); }
    return out;
  }
  // Charts, graphs and maps: image XObjects + dense vector drawing regions, found from the operator list,
  // cropped from the rendered page. Skips logos/icons (< 8% of page), text tables (only straight rules + text),
  // and full-page background images on text-heavy pages. Caption: nearby "Figure/Map/Chart…" line, else nearest heading.
  async function detectFigures(buf, onProgress) {
    const L = await loadPdfJs(); const OPS = L.OPS, U = L.Util;
    const doc = await L.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true }).promise;
    const out = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        if (onProgress) onProgress(n, doc.numPages);
        const pg = await doc.getPage(n); const v1 = pg.getViewport({ scale: 1 }); const [px0, py0, px1, py1] = pg.view; const pArea = (px1 - px0) * (py1 - py0);
        const ol = await pg.getOperatorList(); const tc = await pg.getTextContent();
        const texts = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: it.str }));
        const pageChars = texts.reduce((a, t) => a + t.s.length, 0);
        let ctm = [1, 0, 0, 1, 0, 0]; const st = []; const boxes = [];
        const bbox = (m, x0, y0, x1, y1) => { const ps = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(p => U.applyTransform(p, m)); const xs = ps.map(p => p[0]), ys = ps.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
        for (let i = 0; i < ol.fnArray.length; i++) {
          const fn = ol.fnArray[i], args = ol.argsArray[i];
          if (fn === OPS.save) st.push(ctm); else if (fn === OPS.restore) ctm = st.pop() || ctm;
          else if (fn === OPS.transform) ctm = U.transform(ctm, args);
          else if (fn === OPS.paintFormXObjectBegin) { st.push(ctm); if (args && args[0]) ctm = U.transform(ctm, args[0]); }
          else if (fn === OPS.paintFormXObjectEnd) ctm = st.pop() || ctm;
          else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObjectRepeat) boxes.push({ b: bbox(ctm, 0, 0, 1, 1), img: 1, ops: 0, straight: 0 });
          else if (fn === OPS.constructPath) {
            const mm = args[2]; if (!mm || !isFinite(mm[0]) || !isFinite(mm[2])) continue;
            const b = bbox(ctm, mm[0], mm[2], mm[1], mm[3]); const w = b[2] - b[0], hh = b[3] - b[1];
            if (w * hh > pArea * 0.9) continue; // page background / frame
            const straight = (w < 1.6 || hh < 1.6) ? 1 : 0; const nops = args[0].length;
            const curves = args[0].some(o => o === OPS.curveTo || o === OPS.curveTo2 || o === OPS.curveTo3);
            boxes.push({ b, img: 0, ops: nops, straight: straight && !curves ? 1 : 0, fill: !straight || curves });
          }
        }
        // cluster nearby boxes
        const grow = (b, d) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d], hit = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
        let cl = boxes.map(x => ({ b: x.b.slice(), img: x.img, ops: x.ops, shapes: x.img ? 0 : 1, fills: x.fill ? 1 : 0 }));
        for (let changed = true; changed;) { changed = false;
          for (let i = 0; i < cl.length && !changed; i++) for (let j = i + 1; j < cl.length; j++) if (hit(grow(cl[i].b, 8), cl[j].b)) {
            const a = cl[i], c = cl[j]; a.b = [Math.min(a.b[0], c.b[0]), Math.min(a.b[1], c.b[1]), Math.max(a.b[2], c.b[2]), Math.max(a.b[3], c.b[3])];
            a.img += c.img; a.ops += c.ops; a.shapes += c.shapes; a.fills += c.fills; cl.splice(j, 1); changed = true; break; } }
        const inside = (t, b) => t.x >= b[0] - 2 && t.x <= b[2] + 2 && t.y >= b[1] - 2 && t.y <= b[3] + 2;
        const keep = cl.filter(c => {
          const area = (c.b[2] - c.b[0]) * (c.b[3] - c.b[1]); if (area < pArea * 0.08) return false;
          if (c.img) return !(area > pArea * 0.85 && pageChars > 200);
          const tIn = texts.filter(t => inside(t, c.b)); const chars = tIn.reduce((a, t) => a + t.s.length, 0);
          if (c.fills < 3 && chars > 0) return false; // ruled table / text box
          if (chars > area / 120) return false; // mostly text
          return c.shapes >= 4;
        });
        if (!keep.length) { pg.cleanup && pg.cleanup(); continue; }
        // lines of text with positions, for captions
        const lines = []; for (const t of texts) { let l = lines.find(l => Math.abs(l.y - t.y) < 3); if (!l) lines.push(l = { y: t.y, parts: [] }); l.parts.push(t); }
        lines.forEach(l => { l.parts.sort((a, b) => a.x - b.x); l.s = l.parts.map(p => p.s).join(' ').replace(/\s+/g, ' ').trim(); l.x0 = l.parts[0].x; l.x1 = Math.max(...l.parts.map(p => p.x + p.w)); });
        const scale = Math.min(150 / 72, 1600 / v1.width); const vp = pg.getViewport({ scale });
        const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        for (const c of keep.sort((a, b) => b.b[3] - a.b[3])) {
          const b = [Math.max(px0, c.b[0] - 6), Math.max(py0, c.b[1] - 6), Math.min(px1, c.b[2] + 6), Math.min(py1, c.b[3] + 6)];
          const r = vp.convertToViewportRectangle(b); const x = Math.max(0, Math.floor(Math.min(r[0], r[2]))), y = Math.max(0, Math.floor(Math.min(r[1], r[3])));
          const w = Math.min(cv.width - x, Math.ceil(Math.abs(r[2] - r[0]))), hh = Math.min(cv.height - y, Math.ceil(Math.abs(r[3] - r[1])));
          const cc = document.createElement('canvas'); cc.width = w; cc.height = hh; cc.getContext('2d').drawImage(cv, x, y, w, hh, 0, 0, w, hh);
          const blob = await new Promise(res => cc.toBlob(res, 'image/jpeg', 0.9));
          const outside = lines.filter(l => !(l.y >= c.b[1] - 2 && l.y <= c.b[3] + 2 && l.x1 >= c.b[0] && l.x0 <= c.b[2]));
          const near = outside.map(l => ({ l, d: l.y < c.b[1] ? c.b[1] - l.y : l.y - c.b[3] })).filter(o => o.d < 40).sort((a, b) => a.d - b.d);
          let cap = (near.find(o => /^(fig(?:ure)?\.?\s*\d*|map|chart|graph|diagram|exhibit|plot)\b/i.test(o.l.s)) || {}).l;
          if (!cap) cap = outside.filter(l => l.y > c.b[3] && l.y - c.b[3] < 90 && l.s.length <= 80).sort((a, b) => a.y - b.y)[0];
          out.push({ blob, w, h: hh, page: n, caption: cap ? cap.s : 'Figure (page ' + n + ')', kind: c.img ? 'image' : 'vector' });
          cc.width = cc.height = 0;
        }
        cv.width = cv.height = 0; pg.cleanup && pg.cleanup();
      }
    } finally { doc.destroy && doc.destroy(); }
    return out;
  }
  const API = { intelLegacyToSections, LEGACY_INTEL, detectFigures, renderPages, matchRisk, intelFromJSON, medicalFromJSON, parseIntelText, parseMedicalText, mergeIntel, mergeMedical, pdfText, loadPdfJs };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.AdvImport = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------- UI (uses app.js globals: h, $, cur, save, refreshUI) ---------- */
if (typeof window !== 'undefined') window.importButton = function importButton(section) {
  const I = window.AdvImport;
  const status = h('div', { class: 'msg', role: 'status' });
  const fileIn = h('input', { type: 'file', accept: '.pdf,.json,application/pdf,application/json', class: 'imp-in', hidden: true });

  const short = s => (s.length > 220 ? s.slice(0, 220) + '…' : s);
  const rowsFor = data => {
    const rowsEl = []; if (!data) return rowsEl;
    if (section === 'intel') { data.sections.forEach(x => rowsEl.push(h('div', { class: 'pv-row' }, h('b', {}, (x.title || 'Untitled section') + (x.risk ? ' · ' + x.risk : '')), x.text ? h('div', {}, short(x.text)) : null))); }
    else {
      if (data.label) rowsEl.push(h('div', { class: 'pv-row' }, h('b', {}, 'Event label'), h('div', {}, short(data.label))));
      data.hospitals.forEach((x, i) => rowsEl.push(h('div', { class: 'pv-row' }, h('b', {}, 'Hospital ' + (i + 1) + (x.primary ? ' · primary' : '')),
        ...[x.name, x.address, x.distance, x.notes].filter(Boolean).map(v => h('div', {}, short(v))))));
      (data.sections || []).forEach(x => rowsEl.push(h('div', { class: 'pv-row' }, h('b', {}, 'Section: ' + (x.title || 'Untitled')), x.text ? h('div', {}, short(x.text)) : null)));
    }
    return rowsEl;
  };
  const applyFields = (data, mode) => { cur[section] = section === 'intel' ? I.mergeIntel(cur.intel, data, mode) : I.mergeMedical(cur.medical, data, mode); };
  const done = t => { status.className = 'msg'; status.textContent = t; };
  // JSON: field preview, Replace section / Add to existing
  function preview(data, fileName) {
    const s = $('#sheet'); s.innerHTML = ''; s.hidden = false;
    const apply = mode => { if (!cur) return; applyFields(data, mode); save(); refreshUI([section]); s.hidden = true; done('Imported from ' + fileName + (mode === 'add' ? ' (added to existing).' : '.')); };
    s.append(h('div', { class: 'pv' }, h('h3', { style: 'margin:0 0 6px' }, 'Import into ' + (section === 'intel' ? 'Intel' : 'Medical')),
      h('div', { class: 'muted' }, fileName + (data.unparsed ? ' — no hospitals detected; the text goes into a Summary section.' : '')),
      h('div', { class: 'pv-list' }, ...rowsFor(data)),
      h('button', { class: 'primary', onclick: () => apply('replace') }, 'Replace section'),
      h('button', { onclick: () => apply('add') }, 'Add to existing'),
      h('button', { onclick: () => (s.hidden = true) }, 'Cancel')));
    s.onclick = e => { if (e.target === s) s.hidden = true; };
  }
  // PDF: original pages (always) + optional field filling from text
  function pdfPreview(buf, nPages, data, fileName, figs) {
    figs = figs || []; const urls = figs.map(f => URL.createObjectURL(f.blob)); const picked = figs.map(() => true);
    const s = $('#sheet'); s.innerHTML = ''; s.hidden = false;
    const hasPages = (cur[section].pages.photos || []).length;
    const pageMode = h('select', { 'aria-label': 'Existing pages' }, h('option', { value: 'append' }, 'Add after existing pages'), h('option', { value: 'replace' }, 'Replace existing pages'));
    const fieldMode = h('select', { 'aria-label': 'Fields' }, h('option', { value: 'add' }, 'Add to existing fields'), h('option', { value: 'replace' }, 'Replace section fields'));
    const prog = h('div', { class: 'msg', role: 'status' });
    let busy = false;
    const close = () => { s.hidden = true; urls.forEach(URL.revokeObjectURL); };
    // Fit to template: fields from text + the charts/maps the user kept, no full pages
    const fit = async () => {
      if (busy || !cur) return; busy = true; s.querySelectorAll('button,select,input').forEach(b => (b.disabled = true));
      const r = cur;
      try {
        const keep = figs.filter((_, i) => picked[i]); const metas = [];
        for (const [i, f] of keep.entries()) { prog.textContent = 'Saving figure ' + (i + 1) + ' of ' + keep.length + '…'; const m = await P.add(r, new File([f.blob], 'figure-' + (i + 1) + '.jpg', { type: 'image/jpeg' })); m.caption = f.caption || ''; metas.push(m); }
        if (cur !== r) return;
        applyFields(data, fieldMode.value); r[section].figures.photos.push(...metas);
        await flush(); refreshUI([section]); close();
        done('Fitted ' + fileName + ' to the template' + (metas.length ? ' with ' + metas.length + ' chart/map image(s).' : '.'));
      } catch (e) { prog.className = 'msg bad'; prog.textContent = 'Import failed: ' + (e.message || e); s.querySelectorAll('button,select,input').forEach(b => (b.disabled = false)); }
      finally { busy = false; }
    };
    const go = async withText => {
      if (busy || !cur) return; busy = true; s.querySelectorAll('button,select,input').forEach(b => (b.disabled = true));
      const r = cur, holder = r[section].pages;
      try {
        const imgs = await I.renderPages(buf, (n, t) => (prog.textContent = 'Rendering page ' + n + ' of ' + t + '…'));
        prog.textContent = (r._team ? 'Compressing & uploading ' : 'Saving ') + imgs.length + ' page(s)…';
        const metas = []; for (const [i, im] of imgs.entries()) { const m = await P.add(r, new File([im.blob], 'page-' + (i + 1) + '.jpg', { type: 'image/jpeg' })); m.caption = ''; metas.push(m); }
        if (cur !== r) return;
        if (pageMode.value === 'replace') { for (const p of holder.photos.splice(0)) await P.del(r, p.id); }
        holder.photos.push(...metas);
        if (withText && data) applyFields(data, fieldMode.value);
        await flush(); refreshUI([section]); close();
        done('Inserted ' + metas.length + ' original page(s) from ' + fileName + (withText && data ? ' and filled fields from its text.' : '.'));
      } catch (e) { prog.className = 'msg bad'; prog.textContent = 'Could not render this PDF: ' + (e.message || e); s.querySelectorAll('button,select').forEach(b => (b.disabled = false)); }
      finally { busy = false; }
    };
    s.append(h('div', { class: 'pv' }, h('h3', { style: 'margin:0 0 6px' }, 'Import PDF into ' + (section === 'intel' ? 'Intel' : 'Medical')),
      h('div', { class: 'muted' }, fileName + ' · ' + nPages + ' page' + (nPages === 1 ? '' : 's') + (data && data.unparsed ? ' — no hospitals detected; the text goes into a Summary section.' : '')),
      hasPages ? h('div', {}, h('label', {}, 'Existing original pages (' + hasPages + ')'), pageMode) : null,
      data ? h('div', {}, h('label', {}, 'Text found in the PDF'), h('div', { class: 'pv-list' }, ...rowsFor(data)), h('label', {}, 'When filling fields'), fieldMode) : null,
      data && figs.length ? h('div', {}, h('label', {}, 'Charts, graphs & maps to keep (' + figs.length + ')'), h('div', { class: 'figpick' }, ...figs.map((f, i) => {
        const c = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Keep ' + f.caption }); c.onchange = () => (picked[i] = c.checked);
        return h('label', { class: 'fig' }, h('img', { src: urls[i], alt: f.caption }), h('span', { class: 'chk' }, c, f.caption)); }))) : null,
      data ? null
        : h('div', { class: 'hint pv-note' }, 'This PDF has no selectable text (it looks like a scanned image), so fields cannot be filled from it. The original pages can still be inserted.'),
      prog,
      data ? h('button', { class: 'primary', onclick: fit }, 'Fit to template') : null,
      data ? h('div', { class: 'hint' }, 'Fit to template: fills the fields with the important information' + (section === 'medical' ? ' (per hospital: address, phone, distance, trauma level, specialties, helipad, ER hours)' : '') + ' and keeps the charts/maps you tick, without the full pages.') : null,
      h('button', { class: data ? '' : 'primary', onclick: () => go(false) }, 'Insert original pages'),
      data ? h('button', { onclick: () => go(true) }, 'Insert pages + fill fields from text') : null,
      h('button', { onclick: () => { if (!busy) close(); } }, 'Cancel')));
    s.onclick = e => { if (e.target === s && !busy) close(); };
  }
  fileIn.onchange = async () => {
    const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (!f) return;
    status.className = 'msg'; status.textContent = 'Reading ' + f.name + '…';
    try {
      const buf = await f.arrayBuffer(); const head = new Uint8Array(buf.slice(0, 5));
      const isPdf = String.fromCharCode(...head) === '%PDF-' || /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
      if (isPdf) {
        let text, n;
        try { const L = await I.loadPdfJs(); const d = await L.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise; n = d.numPages; d.destroy && d.destroy(); text = await I.pdfText(buf.slice(0)); }
        catch (e) { throw new Error(/password/i.test(e.name + e.message) ? 'This PDF is password-protected.' : 'Could not read this PDF (' + (e.message || e) + ').'); }
        let data = null;
        if (text.replace(/\s/g, '').length >= 10) { data = section === 'intel' ? I.parseIntelText(text) : I.parseMedicalText(text); if (section === 'intel' && !data.sections.length) data = null; }
        let figs = [];
        if (data) { try { figs = await I.detectFigures(buf.slice(0), (k, t) => (status.textContent = 'Looking for charts and maps… page ' + k + ' of ' + t)); } catch (e) { console.warn('figure detection', e); } }
        status.textContent = ''; pdfPreview(buf, n, data, f.name, figs); return;
      }
      let j; try { j = JSON.parse(new TextDecoder().decode(buf).replace(/^\uFEFF/, '')); } catch (e) { throw new Error('This file is not valid JSON or PDF.'); }
      const data = section === 'intel' ? I.intelFromJSON(j) : I.medicalFromJSON(j);
      status.textContent = ''; preview(data, f.name);
    } catch (e) { status.className = 'msg bad'; status.textContent = 'Import failed: ' + (e.message || e); }
  };
  return h('div', { class: 'imp' }, h('button', { class: 'sm', onclick: () => fileIn.click() }, 'Import PDF / JSON'), fileIn, status);
};
