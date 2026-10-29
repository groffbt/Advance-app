// Offline cache: same-origin only. Bump VERSION to ship updates.
const VERSION='advance-v2';
const FILES=["./", "index.html", "style.css", "app.js", "pdf.js", "manifest.webmanifest", "lib/pdfmake.min.js", "lib/fonts.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener('install',e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin)return;
e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).then(res=>{if(res.ok){const c=res.clone();caches.open(VERSION).then(x=>x.put(e.request,c));}return res;}).catch(()=>caches.match('./'))));});
