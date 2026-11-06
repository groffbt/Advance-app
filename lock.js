'use strict';
/* App lock (v18): Face ID / Touch ID with the iPhone passcode as fallback, via the app's own native plugin
   (Capacitor.Plugins.AppLock, compiled into the iOS app). Loaded in <head> so report content is hidden before
   the first paint. The lock is only a cover: sync and everything else keep running underneath it.
   Web/PWA: no plugin, so the lock never engages and Settings shows "Available in the iPhone app". */
const AppLock = (() => {
  const KEY = 'appLock', AFTER = 'appLockAfter';
  const OPTIONS = [[0, 'Immediately'], [60, 'After 1 minute'], [300, 'After 5 minutes'], [900, 'After 15 minutes']];
  const plugin = () => { const C = window.Capacitor; return (C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.AppLock) || null; };
  const L = {
    OPTIONS, locked: false, authing: false, hiddenAt: null, msg: '',
    native: () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
    available: () => !!plugin(),
    // Never locks without the plugin, so a missing/old native build can't lock anyone out.
    enabled: () => localStorage.getItem(KEY) === '1' && !!plugin(),
    after: () => { const v = Number(localStorage.getItem(AFTER)); return OPTIONS.some(o => o[0] === v) ? v : 0; },
    setAfter: s => { localStorage.setItem(AFTER, String(OPTIONS.some(o => o[0] === Number(s)) ? Number(s) : 0)); },
    // Pure: lock when the app was in the background at least `afterSec` seconds (0 = always).
    shouldLock: (hiddenAt, now, afterSec) => hiddenAt != null && now - hiddenAt >= afterSec * 1000,
  };
  const errText = e => {
    const c = e && e.code;
    if (c === 'cancel') return 'Unlock cancelled. Tap Unlock to try again.';
    if (c === 'notAvailable') return 'No passcode is set on this iPhone. Set one in Settings > Face ID & Passcode.';
    return (e && e.message) || 'Could not unlock. Try again.';
  };
  L.errText = errText;
  L.status = async () => { const p = plugin(); if (!p) return { canAuth: false, biometry: 'none' }; try { return await p.status(); } catch (e) { return { canAuth: false, biometry: 'none' }; } };
  L.auth = async reason => {
    const p = plugin(); if (!p) throw Object.assign(new Error('App lock is available in the iPhone app.'), { code: 'notAvailable' });
    L.authing = true;
    try { await p.authenticate({ reason }); return true; } finally { L.authing = false; L.hiddenAt = null; }
  };
  const privacy = on => { const p = plugin(); if (p && p.setPrivacyScreen) p.setPrivacyScreen({ enabled: !!on }).catch(() => { }); };

  // Turning ON needs a passcode/Face ID on the device and one successful unlock first.
  L.enable = async () => {
    if (!plugin()) throw new Error('App lock is available in the iPhone app.');
    const st = await L.status();
    if (!st.canAuth) throw Object.assign(new Error('This iPhone has no passcode, so App lock cannot turn on. Set a passcode in Settings > Face ID & Passcode first.'), { code: 'notAvailable' });
    await L.auth('Turn on App lock for Advance Report');
    localStorage.setItem(KEY, '1'); privacy(true); return st;
  };
  L.disable = () => { localStorage.removeItem(KEY); privacy(false); L.locked = false; render(); };

  // ---- overlay ----
  let el = null;
  const render = () => {
    document.documentElement.classList.toggle('locked', L.locked);
    if (!document.body) return;
    if (!L.locked) { if (el) { el.remove(); el = null; } return; }
    if (!el) {
      el = document.createElement('div'); el.id = 'lockScreen'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Advance Report is locked');
      el.innerHTML = '<div class="lk"><img src="icons/icon-180.png" alt=""><h2>Advance Report</h2><p>Locked</p><button type="button" class="primary" id="unlockBtn">Unlock</button><div class="lkmsg" role="status"></div></div>';
      el.querySelector('#unlockBtn').onclick = () => L.unlock();
      document.body.append(el);
    }
    el.querySelector('.lkmsg').textContent = L.msg || '';
  };
  L.lock = (prompt = true) => {
    if (!L.enabled()) return;
    if (!L.locked) { L.locked = true; L.msg = ''; }
    render();
    if (prompt) setTimeout(() => { if (L.locked && !document.hidden) L.unlock(); }, 250);
  };
  L.unlock = async () => {
    if (!L.locked || L.authing) return;
    L.msg = ''; render();
    try { await L.auth('Unlock Advance Report'); L.locked = false; L.msg = ''; }
    catch (e) { L.msg = errText(e); }
    render();
  };

  // Background / foreground.
  document.addEventListener('visibilitychange', () => {
    if (!L.enabled() || L.authing) return;
    if (document.hidden) {
      if (L.hiddenAt == null) L.hiddenAt = Date.now();
      if (L.after() === 0) L.lock(false); // cover now; prompt when back
    } else {
      if (L.locked || L.shouldLock(L.hiddenAt, Date.now(), L.after())) L.lock(true);
      L.hiddenAt = null;
    }
  });

  // Cold start: hide content before first paint, then show the overlay and prompt.
  if (L.enabled()) { L.locked = true; document.documentElement.classList.add('locked'); }
  const start = () => { if (L.native()) privacy(L.enabled()); if (L.locked) L.lock(true); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // ---- Settings card (Account screen) ----
  L.card = () => {
    const card = document.createElement('div'); card.className = 'card lockcard'; card.id = 'lockCard';
    const draw = (note, bad) => {
      card.innerHTML = '';
      const t = document.createElement('h3'); t.textContent = '🔒 App lock (Face ID / passcode)'; card.append(t);
      const msg = document.createElement('div'); msg.className = 'msg' + (bad ? ' bad' : ''); msg.setAttribute('role', 'status'); msg.textContent = note || '';
      if (!L.available()) {
        const p = document.createElement('div'); p.className = 'muted';
        p.textContent = L.native() ? 'Update the iPhone app to the latest build to use App lock.' : 'Available in the iPhone app.';
        card.append(p); return;
      }
      const row = document.createElement('label'); row.className = 'chk lockrow';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'lockToggle'; cb.checked = L.enabled();
      row.append(cb, document.createTextNode(' Lock with Face ID / passcode'));
      cb.onchange = async () => {
        if (cb.checked) {
          cb.checked = false; cb.disabled = true;
          try { const st = await L.enable(); draw('App lock is on' + (st.biometry === 'none' ? ' (passcode; Face ID is not set up on this iPhone).' : '.')); }
          catch (e) { draw(e.code === 'cancel' ? 'Not turned on: unlock was cancelled.' : errText(e), true); }
        } else { L.disable(); draw('App lock is off.'); }
      };
      const lab = document.createElement('label'); lab.textContent = 'Lock after'; lab.setAttribute('for', 'lockAfter');
      const sel = document.createElement('select'); sel.id = 'lockAfter'; sel.disabled = !L.enabled();
      for (const [v, n] of OPTIONS) { const o = document.createElement('option'); o.value = v; o.textContent = n + (v ? ' in background' : ''); o.selected = v === L.after(); sel.append(o); }
      sel.onchange = () => L.setAfter(sel.value);
      const hint = document.createElement('div'); hint.className = 'hint';
      hint.textContent = 'Uses Face ID (or Touch ID), with your iPhone passcode as backup. Report contents are also hidden in the app switcher. Saved on this phone only.';
      card.append(row, lab, sel, msg, hint);
    };
    draw(); return card;
  };
  return L;
})();
