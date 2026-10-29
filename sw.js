// Offline support. Network-first for the app shell (HTML/JS/CSS/manifest) so updates land on first launch;
// cache-first for heavy static assets (lib/, icons/, sample/). Bump VERSION to ship updates.
const VERSION='advance-v3';
const FILES=["./", "index.html", "style.css", "app.js", "pdf.js", "manifest.webmanifest", "lib/pdfmake.min.js", "lib/fonts.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener('install',e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:'reload'})))).then(()=>self.skipWaiting())));
// On upgrade from an older version, reload open windows once so they pick up the new shell
// (older builds' page code has no reload-on-update logic of its own).
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(async ks=>{const old=ks.filter(k=>k!==VERSION);await Promise.all(old.map(k=>caches.delete(k)));await self.clients.claim();
  if(old.length)self.clients.matchAll({type:'window'}).then(cs=>cs.forEach(c=>c.navigate(c.url).catch(()=>{})));/* not awaited: navigation needs this SW active */})));
const isShell=(req,u)=>req.mode==='navigate'||(!/\/(lib|icons|sample)\//.test(u.pathname)&&/(\.html|\.js|\.css|\.webmanifest|\/)$/.test(u.pathname));
self.addEventListener('fetch',e=>{const req=e.request,u=new URL(req.url);if(req.method!=='GET'||u.origin!==location.origin)return;
  if(isShell(req,u)){
    e.respondWith(fetch(req,{cache:'no-store'}).then(res=>{if(res.ok){const c=res.clone();caches.open(VERSION).then(x=>x.put(req,c));}return res;})
      .catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>r||caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(req,{ignoreSearch:true}).then(r=>r||fetch(req).then(res=>{if(res.ok){const c=res.clone();caches.open(VERSION).then(x=>x.put(req,c));}return res;})));
});
