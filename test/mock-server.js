// Fake Immich server to try the module in a desktop browser.
//
//   node test/mock-server.js [port]
//   MOCK_AUTH=0 simulates "logged out", MOCK_DOWN=1 a proxy whose NAS is off (502).
//
// /start.html is the launcher, every other page is the "Immich web app".
// Both get immich-tv.js injected like TizenBrew would. /tizenbrew.html stands
// in for TizenBrew's menu: it forwards to ?to= (default /start.html) so the
// Back key can be tested. Remote keys can be replayed with
// ?keys=down,right,enter (see driver.js), and ?hold=ms delays the page's load
// event so headless screenshots catch the final state.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 2283;
const AUTH = process.env.MOCK_AUTH !== '0';
const DOWN = process.env.MOCK_DOWN === '1';

// Stand-in for TizenBrew's menu. On first load it forwards to ?to=, coming
// back it says so. Its load event waits (hold.gif) so screenshots show the end state.
const TIZENBREW = `<!doctype html><html><head><meta charset="utf-8"><title>TizenBrew (Mock)</title>
<style>body{background:#1d4ed8;color:#fff;font:32px sans-serif;padding:60px}</style></head>
<body><h1>TizenBrew-Menü (Attrappe)</h1><p id="state">Startet das Modul …</p><script>
const nav = performance.getEntriesByType('navigation')[0];
const back = nav && nav.type === 'back_forward';
document.write('<img src="/hold.gif?ms=' + (back ? 300 : 20000) + '" style="display:none">');
if (back) document.getElementById('state').textContent = 'Zurück im TizenBrew-Menü ✓';
else setTimeout(() => { location.href = (new URLSearchParams(location.search).get('to') || '/start.html') + location.search; }, Number(new URLSearchParams(location.search).get('fwd')) || 300);
</script></body></html>`;
const MODULE = path.join(__dirname, '..', 'immich-tv.js');
const DRIVER = path.join(__dirname, 'driver.js');

const PLACES = [['Lissabon', 'Portugal'], ['Oberstdorf', 'Deutschland'], ['Berlin', 'Deutschland'], ['Bergen', 'Norwegen'], [null, null], ['Wien', 'Österreich']];
const ALBUMS = ['Sommer in Lissabon', 'Wanderung Allgäu', 'Weihnachten 2025', 'Roadtrip Norwegen', 'Katze Mila', 'Balkonpflanzen', 'Konzerte', 'Festival 2024', 'Familie', 'Kochen', 'Leeres Album', 'Ein Album mit einem sehr langen Namen, der abgeschnitten werden muss'];

// A deterministic little library: 30 months, 3–40 assets each.
const assets = [];
for (let m = 0; m < 30; m++) {
  const month = new Date(Date.UTC(2026, 9 - m, 1));
  const count = 3 + ((m * 17) % 38);
  for (let n = 0; n < count; n++) {
    const day = 1 + ((n * 7 + m) % 27);
    const date = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day, 9 + (n % 11), (n * 13) % 60));
    const k = assets.length;
    const where = PLACES[k % PLACES.length];
    assets.push({
      id: 'asset-' + String(k).padStart(4, '0'),
      date,
      bucket: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(),
      isImage: k % 9 !== 4,
      duration: k % 9 === 4 ? 12000 + (k % 5) * 61000 : null,
      city: where[0],
      country: where[1],
      fav: k % 7 === 0,
      album: ALBUMS[k % (ALBUMS.length - 2)],
    });
  }
}

function hue(id) {
  let value = 0;
  for (const ch of id) value = (value * 131 + ch.charCodeAt(0) * 7) % 360;
  return value;
}

function picture(id, w, h) {
  const a = hue(id);
  const b = (a + 60) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a},55%,62%)"/><stop offset="1" stop-color="hsl(${b},50%,22%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${w * 0.72}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.11}" fill="hsla(48,95%,88%,.9)"/>
<path d="M0 ${h} L${w * 0.32} ${h * 0.52} L${w * 0.55} ${h * 0.8} L${w * 0.76} ${h * 0.58} L${w} ${h} Z" fill="hsla(${b},45%,14%,.75)"/>
<text x="${w * 0.04}" y="${h * 0.1}" font-family="sans-serif" font-size="${Math.round(h * 0.06)}" fill="rgba(255,255,255,.75)">${id}</text></svg>`;
}

function filtered(query) {
  return assets.filter((a) =>
    (!query.get('albumId') || a.album === query.get('albumId')) &&
    (query.get('isFavorite') !== 'true' || a.fav));
}

function columns(list) {
  return {
    id: list.map((a) => a.id),
    isImage: list.map((a) => a.isImage),
    duration: list.map((a) => a.duration),
    fileCreatedAt: list.map((a) => new Date(a.date.getTime() - 2 * 3600000).toISOString()),
    localOffsetHours: list.map(() => 2),
    city: list.map((a) => a.city),
    country: list.map((a) => a.country),
    isTrashed: list.map(() => false),
    isFavorite: list.map((a) => a.fav),
    ratio: list.map(() => 1.5),
  };
}

function assetDto(a) {
  return {
    id: a.id,
    type: a.isImage ? 'IMAGE' : 'VIDEO',
    duration: a.duration,
    localDateTime: a.date.toISOString(),
    fileCreatedAt: a.date.toISOString(),
    exifInfo: { city: a.city, country: a.country },
  };
}

function albums() {
  return ALBUMS.map((name) => {
    const list = assets.filter((a) => a.album === name);
    const dates = list.map((a) => a.date.getTime()).sort((x, y) => x - y);
    return {
      id: name,
      albumName: name,
      albumThumbnailAssetId: list.length ? list[0].id : null,
      assetCount: list.length,
      startDate: dates.length ? new Date(dates[0]).toISOString() : undefined,
      endDate: dates.length ? new Date(dates[dates.length - 1]).toISOString() : undefined,
      updatedAt: '2026-01-01T00:00:00.000Z',
      order: 'desc',
    };
  });
}

function page(title, body, hold) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;background:#fff;color:#222;padding:40px}</style></head>
<body>${body}<img src="/hold.gif?ms=${hold}" style="display:none" alt="">
<script src="/immich-tv.js"></script><script src="/driver.js"></script></body></html>`;
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const json = (res, data, status) => send(res, status || 200, 'application/json', JSON.stringify(data));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  const hold = Number(q.get('hold')) || 0;

  if (p === '/immich-tv.js') return send(res, 200, 'text/javascript', fs.readFileSync(MODULE));
  if (p === '/driver.js') return send(res, 200, 'text/javascript', fs.readFileSync(DRIVER));
  if (p === '/hold.gif') return setTimeout(() => send(res, 200, 'image/gif', GIF), Number(q.get('ms')) || 0);
  if (p === '/start.html') return send(res, 200, 'text/html', page('Immich TV', '<pre>(start.html wird von jsDelivr als Text ausgeliefert)</pre>', hold));
  if (p === '/tizenbrew.html') return send(res, 200, 'text/html', TIZENBREW);
  if (DOWN) {
    const body = p.startsWith('/api/') ? '{"message":"Bad Gateway"}' : page('502 Bad Gateway', '<h1>502 Bad Gateway</h1><hr>nginx', hold);
    return send(res, 502, p.startsWith('/api/') ? 'application/json' : 'text/html', body);
  }

  if (p.startsWith('/api/')) {
    const route = p.slice(4);
    if (route === '/server/ping') return json(res, { res: 'pong' });
    if (route === '/server/version') return json(res, { major: 2, minor: 5, patch: 2 });
    if (!AUTH) return json(res, { message: 'Authentication required' }, 401);
    if (route === '/users/me') return json(res, { id: 'u1', name: 'Lukas Beispiel', email: 'lukas@example.com' });
    if (route === '/assets/statistics') return json(res, { images: assets.filter((a) => a.isImage).length, videos: assets.filter((a) => !a.isImage).length, total: assets.length });
    if (route === '/albums') return json(res, q.has('shared') || q.has('isShared') ? [] : albums());
    if (route === '/timeline/buckets') {
      const counts = {};
      filtered(q).forEach((a) => { counts[a.bucket] = (counts[a.bucket] || 0) + 1; });
      return json(res, Object.keys(counts).sort().reverse().map((timeBucket) => ({ timeBucket, count: counts[timeBucket] })));
    }
    if (route === '/timeline/bucket') {
      const list = filtered(q).filter((a) => a.bucket === q.get('timeBucket'));
      return setTimeout(() => json(res, columns(list)), 120);
    }
    if (route === '/search/random') {
      const images = assets.filter((a) => a.isImage);
      return json(res, Array.from({ length: 40 }, (_, k) => assetDto(images[(k * 37 + Date.now()) % images.length])));
    }
    if (route === '/auth/logout') return json(res, { successful: true });
    const thumb = /^\/assets\/([^/]+)\/thumbnail$/.exec(route);
    if (thumb) {
      const portrait = hue(thumb[1]) % 4 === 0;
      const size = q.get('size') === 'thumbnail' ? [250, 250] : portrait ? [1080, 1440] : [1440, 960];
      return send(res, 200, 'image/svg+xml', picture(thumb[1], size[0], size[1]));
    }
    return json(res, { message: 'Not found' }, 404);
  }

  return send(res, 200, 'text/html', page('Immich (Mock)', '<h1>Immich-Weboberfläche (Mock)</h1><p>Hier läuft normalerweise Immich selbst.</p><input placeholder="E-Mail">', hold));
}).listen(PORT, () => console.log('Mock-Immich läuft auf http://localhost:' + PORT + (AUTH ? '' : ' (abgemeldet)')));
