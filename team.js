'use strict';
/* Team sharing (Firebase Auth + Firestore). Loaded lazily: nothing here touches the network until the user
   signs in or opens the Account screen. Local "this phone only" reports never leave the device. */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDKYyB0sIyCFcC4AgE6o-VQgKItaaagUlY',
  authDomain: 'advance-report-d68b9.firebaseapp.com',
  projectId: 'advance-report-d68b9',
  storageBucket: 'advance-report-d68b9.firebasestorage.app',
  messagingSenderId: '973393012431',
  appId: '1:973393012431:web:babbe95af33580f073f9ba'
};
// v18: Firebase App Check. OFF until set up in the Firebase console (see firebase/appcheck-steps.md).
// Web/PWA: reCAPTCHA v3 (or Enterprise) site key. iPhone app: needs a native App Attest provider plugin
// (Capacitor.Plugins.AppCheckNative.getToken), which is not built in yet, so the iPhone app skips App Check.
// Do not turn on enforcement in the console until both are sending tokens.
const APP_CHECK = { enabled: false, webProvider: 'v3' /* 'v3' or 'enterprise' */, webSiteKey: '', debugToken: false };
const PASSWORD_MIN = 12;
// Report fields synced to Firestore; each is its own field (objects are written leaf-by-leaf via dotted paths).
const SYNC_KEYS = ['name', 'folderId', 'header', 'overview', 'weather', 'intel', 'taskOrg', 'vehicles', 'timelineZone', 'weatherZip', 'timeline', 'contacts',
  'locations', 'routes', 'arrival', 'arrivalMedia', 'photoSections', 'coordination', 'lodging', 'lodgingList', 'medical'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const genCode = (n = 8) => { const a = new Uint32Array(n); crypto.getRandomValues(a); return [...a].map(x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join(''); };
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = c => c ? c.slice(0, 4) + '-' + c.slice(4) : '';

const Cloud = (() => {
  let fb, auth, fs, readyP; const subs = new Set();
  const C = {
    user: null, teams: [], failed: null, teamsLoaded: false, removedFrom: null, leaving: new Set(),
    get active() { const t = localStorage.getItem('activeTeam'); return C.teams.find(x => x.id === t) || C.teams[0] || null; },
    setActive(id) { localStorage.setItem('activeTeam', id); emit(); },
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    enabled: () => !!localStorage.getItem('fbOn'),
  };
  const emit = () => subs.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  let teamsUnsub = null;
  C.ready = () => readyP ||= (async () => {
    await loadScript('lib/firebase.js'); fb = window.FB;
    const app = fb.initializeApp(FIREBASE_CONFIG);
    initAppCheck(app);
    // initializeAuth (not getAuth) with IndexedDB persistence and no popup/redirect resolver: works in iOS WKWebView
    // (capacitor://localhost) and needs no auth iframe.
    auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
    let localCache; try { localCache = fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }); } catch (e) { localCache = fb.memoryLocalCache(); }
    fs = fb.initializeFirestore(app, { localCache, ignoreUndefinedProperties: true });
    if (location.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && localStorage.getItem('fbEmu')) { // test hook: local emulators only
      fb.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); fb.connectFirestoreEmulator(fs, '127.0.0.1', 8080);
    }
    await new Promise(res => fb.onAuthStateChanged(auth, u => {
      C.user = u; if (u) localStorage.setItem('fbOn', '1'); else localStorage.removeItem('fbOn');
      if (teamsUnsub) { teamsUnsub(); teamsUnsub = null; } C.teams = [];
      if (u) teamsUnsub = fb.onSnapshot(fb.query(fb.collection(fs, 'teams'), fb.where('members', 'array-contains', u.uid)), s => {
        const before = C.teams;
        C.teams = s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        // v18: notice when the server drops a team we were in (removed by the owner, or left on another phone).
        if (!s.metadata.fromCache) for (const t of before) if (!C.teams.some(x => x.id === t.id) && !C.leaving.has(t.id)) {
          C.removedFrom = t.name || 'a team'; C.removedFromId = t.id; if (localStorage.getItem('activeTeam') === t.id) localStorage.removeItem('activeTeam');
        }
        if (C.removedFromId && C.teams.some(x => x.id === C.removedFromId)) C.removedFrom = C.removedFromId = null; // rejoined
        C.teamsLoaded = true; emit();
      }, e => console.warn('teams', e));
      emit(); res();
    }));
  })().catch(e => { readyP = null; C.failed = e; throw e; });

  function initAppCheck(app) {
    if (!APP_CHECK.enabled) return;
    try {
      const isNat = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      if (APP_CHECK.debugToken) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
      let provider = null;
      if (isNat) {
        const nat = window.Capacitor.Plugins && window.Capacitor.Plugins.AppCheckNative;
        if (nat) provider = new fb.CustomProvider({ getToken: async () => { const r = await nat.getToken(); return { token: r.token, expireTimeMillis: r.expireTimeMillis }; } });
      } else if (APP_CHECK.webSiteKey) {
        provider = APP_CHECK.webProvider === 'enterprise' ? new fb.ReCaptchaEnterpriseProvider(APP_CHECK.webSiteKey) : new fb.ReCaptchaV3Provider(APP_CHECK.webSiteKey);
      }
      if (provider) { fb.initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true }); C.appCheck = true; }
    } catch (e) { console.warn('App Check not started', e); }
  }
  const err = e => { const m = String((e && (e.code || e.message)) || e); return ({ 'auth/invalid-credential': 'Wrong email or password.', 'auth/wrong-password': 'Wrong email or password.', 'auth/user-not-found': 'No account with that email.', 'auth/email-already-in-use': 'That email already has an account. Sign in instead.', 'auth/weak-password': 'Password must be at least ' + PASSWORD_MIN + ' characters.', 'auth/password-does-not-meet-requirements': 'Password must be at least ' + PASSWORD_MIN + ' characters.', 'auth/invalid-email': 'That email address is not valid.', 'auth/network-request-failed': 'No connection. Try again when online.', 'auth/too-many-requests': 'Too many attempts. Wait a few minutes.' })[m] || m.replace(/^auth\//, ''); };
  C.err = err;
  C.PASSWORD_MIN = PASSWORD_MIN;
  C.signUp = async (e, p) => {
    if (String(p || '').length < PASSWORD_MIN) throw new Error('Use a password of at least ' + PASSWORD_MIN + ' characters.');
    await C.ready(); const cred = await fb.createUserWithEmailAndPassword(auth, e.trim(), p);
    try { await fb.sendEmailVerification(cred.user); } catch (x) { console.warn('verify email', x); }
  };
  // v18: email verification (needed to create or join a team; existing memberships keep working).
  C.verified = () => !!(C.user && C.user.emailVerified);
  C.resendVerification = async () => { await C.ready(); if (!C.user) throw new Error('Sign in first.'); await fb.sendEmailVerification(C.user); };
  C.refreshUser = async () => { await C.ready(); if (!C.user) return false; await fb.reload(C.user); await fb.getIdToken(C.user, true); emit(); return C.user.emailVerified; };
  const needVerified = () => { if (!C.verified()) throw new Error('Verify your email first: open the link we emailed you, then tap “I’ve verified”.'); };
  C.signIn = async (e, p) => { await C.ready(); await fb.signInWithEmailAndPassword(auth, e.trim(), p); };
  C.reset = async e => { await C.ready(); await fb.sendPasswordResetEmail(auth, e.trim()); };
  C.signOut = async () => { // also wipe the local Firestore cache so team data does not stay on a signed-out device
    await fb.signOut(auth); localStorage.removeItem('activeTeam');
    try { await fb.terminate(fs); await fb.clearIndexedDbPersistence(fs); } catch (e) { console.warn(e); }
    try { await tx('tphotos', 'readwrite', s => s.clear()); } catch (e) { }
  };

  const teamRef = t => fb.doc(fs, 'teams', t);
  C.createTeam = async name => {
    await C.ready(); needVerified(); const u = C.user; name = String(name || '').trim().slice(0, 80) || 'My team';
    for (let i = 0; i < 5; i++) {
      const code = genCode(), ref = fb.doc(fb.collection(fs, 'teams')), b = fb.writeBatch(fs);
      b.set(ref, { name, code, owner: u.uid, members: [u.uid], emails: { [u.uid]: u.email }, created: Date.now() });
      b.set(fb.doc(fs, 'invites', code), { teamId: ref.id, by: u.uid });
      try { await b.commit(); C.setActive(ref.id); return { id: ref.id, code }; }
      catch (e) { if (e.code !== 'permission-denied') throw e; } // code already taken: try another
    }
    throw new Error('Could not create team. Try again.');
  };
  C.joinTeam = async raw => {
    await C.ready(); const code = cleanCode(raw), u = C.user;
    if (code.length !== 8) throw new Error('Invite codes have 8 characters.');
    needVerified();
    const inv = await fb.getDocFromServer(fb.doc(fs, 'invites', code)).catch(e => { throw new Error(e.code === 'unavailable' ? 'No connection. Joining needs internet.' : e.message); });
    if (!inv.exists()) throw new Error('No team with that code.');
    const tid = inv.data().teamId;
    if (!C.teams.some(t => t.id === tid)) await fb.updateDoc(teamRef(tid), { members: fb.arrayUnion(u.uid), ['emails.' + u.uid]: u.email, ['joins.' + u.uid]: code, joinCode: fb.deleteField() })
      .catch(e => { throw new Error(e.code === 'permission-denied' ? 'That invite code is no longer valid. Ask the team owner for the current code.' : e.message); });
    C.setActive(tid); return tid;
  };
  C.leaveTeam = async tid => { C.leaving.add(tid); await fb.updateDoc(teamRef(tid), { members: fb.arrayRemove(C.user.uid), ['emails.' + C.user.uid]: fb.deleteField(), ['joins.' + C.user.uid]: fb.deleteField() }); if (localStorage.getItem('activeTeam') === tid) localStorage.removeItem('activeTeam'); };

  // v18: owner tools. Rules: only the owner may remove someone else (never themselves; they use Leave) or reset the code.
  C.isOwner = t => !!(t && C.user && t.owner === C.user.uid);
  C.removeMember = async (tid, uid) => {
    if (uid === C.user.uid) throw new Error('Use Leave team to remove yourself.');
    // also clears joinCode (used by older app builds) and their joins entry, so they need the code to come back
    await fb.updateDoc(teamRef(tid), { members: fb.arrayRemove(uid), ['emails.' + uid]: fb.deleteField(), ['joins.' + uid]: fb.deleteField(), joinCode: fb.deleteField() });
  };
  // New invite code: team.code changes and invites/{new} is created in one batch; the old invite doc is deleted, and
  // the join rule checks the team's current code anyway, so old codes stop working (also on older app builds).
  C.resetCode = async tid => {
    await C.ready(); const t = C.teams.find(x => x.id === tid); if (!t) throw new Error('Team not found.');
    if (!navigator.onLine) throw new Error('Resetting the code needs internet.');
    for (let i = 0; i < 6; i++) {
      const code = genCode(), b = fb.writeBatch(fs);
      b.update(teamRef(tid), { code });
      b.set(fb.doc(fs, 'invites', code), { teamId: tid, by: C.user.uid });
      if (i < 4 && t.code) b.delete(fb.doc(fs, 'invites', t.code)); // last tries skip cleanup in case the old invite is already gone
      try { await b.commit(); return code; }
      catch (e) { if (e.code !== 'permission-denied') throw e; }
    }
    throw new Error('Could not reset the code. Make sure you are the team owner and online, then try again.');
  };

  const reports = t => fb.collection(fs, 'teams', t, 'reports');
  const rref = (t, r) => fb.doc(fs, 'teams', t, 'reports', r);
  const pref = (t, r, p) => fb.doc(fs, 'teams', t, 'reports', r, 'photos', p);
  const meta = () => ({ updated: Date.now(), updatedBy: C.user.uid, updatedByEmail: C.user.email || '' });
  C.toDoc = r => Object.assign(Object.fromEntries(SYNC_KEYS.map(k => [k, docForm(clone(r[k] ?? null))])), meta(), { created: Date.now(), createdBy: C.user.uid, createdByEmail: C.user.email || '' });
  // v18: folders/templates: owner or creator may delete (rules enforce it; legacy ones: owner only). Reports: any member.
  C.canDelete = (t, x, field = 'createdBy') => !!(C.user && t && (t.owner === C.user.uid || (x && x[field] === C.user.uid)));
  C.watchReports = (t, cb) => fb.onSnapshot(reports(t), s => cb(s.docs.map(d => Object.assign(fromForm(d.data()), { id: d.id, _team: t }))), e => cb(null, e));
  C.watchReport = (t, r, cb, onErr) => fb.onSnapshot(rref(t, r), { includeMetadataChanges: true }, cb, onErr);
  C.createReport = (t, r) => fb.setDoc(rref(t, r.id), C.toDoc(r));
  C.updateReport = (t, r, upd) => { for (const k in upd) if (upd[k] === undefined) upd[k] = fb.deleteField(); return fb.updateDoc(rref(t, r), Object.assign(upd, meta())).catch(e => { console.warn('sync', e); C.lastError = e; emit(); }); };
  C.deleteReport = async (t, r, photoIds) => { const b = fb.writeBatch(fs); for (const p of photoIds) b.delete(pref(t, r, p)); b.delete(rref(t, r)); return b.commit(); };
  C.putPhoto = (t, r, p, data) => fb.setDoc(pref(t, r, p), Object.assign(data, { by: C.user.uid }));
  C.getPhoto = async (t, r, p) => { try { const d = await fb.getDoc(pref(t, r, p)); return d.exists() ? d.data() : null; } catch (e) { return null; } };
  C.delPhoto = (t, r, p) => fb.deleteDoc(pref(t, r, p)).catch(e => console.warn(e));

  const folders = t => fb.collection(fs, 'teams', t, 'folders');
  const fref = (t, id) => fb.doc(fs, 'teams', t, 'folders', id);
  C.watchFolders = (t, cb) => fb.onSnapshot(folders(t), s => cb(s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || (a.name || '').localeCompare(b.name || ''))), e => cb(null, e));
  C.createFolder = async (t, name, order = 0) => {
    const ref = fb.doc(folders(t));
    await fb.setDoc(ref, { name: String(name || '').trim().slice(0, 80) || 'Folder', order: order | 0, created: Date.now(), by: C.user.uid });
    return ref.id;
  };
  C.updateFolder = (t, id, patch) => fb.updateDoc(fref(t, id), patch);
  C.deleteFolder = async (t, id, reportIds = [], templateIds = []) => {
    const b = fb.writeBatch(fs); b.delete(fref(t, id));
    for (const rid of reportIds) b.update(rref(t, rid), Object.assign({ folderId: null }, meta()));
    for (const tid of templateIds) b.update(tref(t, tid), { folderId: null, updated: Date.now(), by: C.user.uid });
    return b.commit();
  };

  const templates = t => fb.collection(fs, 'teams', t, 'templates');
  const tref = (t, id) => fb.doc(fs, 'teams', t, 'templates', id);
  C.watchTemplates = (t, cb) => fb.onSnapshot(templates(t), s => cb(s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.name || '').localeCompare(b.name || ''))), e => cb(null, e));
  C.watchTemplate = (t, id, cb, onErr) => fb.onSnapshot(tref(t, id), { includeMetadataChanges: true }, cb, onErr);
  C.saveTemplate = (t, tmpl) => fb.setDoc(tref(t, tmpl.id), Object.assign({
    name: String(tmpl.name || '').trim().slice(0, 120) || 'Template',
    folderId: tmpl.folderId || null,
    data: docForm(tmpl.data),
    updated: Date.now(), by: C.user.uid, byEmail: C.user.email || ''
  }, tmpl.isNew ? { createdBy: C.user.uid } : {}), { merge: true });
  C.deleteTemplate = (t, id) => fb.deleteDoc(tref(t, id));
  C.raw = () => ({ fb, fs }); // for tests/debugging
  return C;
})();

/* Firestore form of a report. Lists of keyed items (rows with _k, photos/sections with id) are stored as maps
   {_list:true, <key>: {...item, _o: order}} so two people editing different rows, adding rows, or captioning
   different photos at the same time update different fields and never overwrite each other. */
const itemKey = x => x && typeof x === 'object' && !Array.isArray(x) ? (x._k || x.id) : null;
const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
function docForm(x) {
  if (Array.isArray(x)) {
    if (x.every(itemKey)) { const m = { _list: true }; x.forEach((it, i) => { m[itemKey(it)] = Object.assign(docForm(it), { _o: i }); }); return m; }
    return x.map(docForm);
  }
  if (isPlain(x)) { const o = {}; for (const k in x) if (k !== '_team' && x[k] !== undefined) o[k] = docForm(x[k]); return o; }
  return x;
}
function fromForm(x) {
  const vals = isPlain(x) ? Object.keys(x).filter(k => k !== '_list').map(k => x[k]) : [];
  if (isPlain(x) && (x._list || (vals.length && vals.every(v => isPlain(v) && typeof v._o === 'number')))) return Object.keys(x).filter(k => k !== '_list' && isPlain(x[k])).sort((a, b) => ((x[a]._o ?? 0) - (x[b]._o ?? 0)) || (a < b ? -1 : 1))
    .map(k => { const it = fromForm(x[k]); delete it._o; return it; });
  if (Array.isArray(x)) return x.map(fromForm);
  if (isPlain(x)) { const o = {}; for (const k in x) o[k] = fromForm(x[k]); return o; }
  return x;
}
