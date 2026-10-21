/*!
 * Immich TV – TizenBrew-Modul für Immich
 * https://github.com/Uruser42/immich-tizenbrew
 *
 * TizenBrew spielt dieses Skript in jede Seite ein, die das Modul öffnet,
 * und es entscheidet anhand der Adresse, was zu tun ist:
 *
 *  1. start.html (Launcher): merkt sich die Adresse des Immich-Servers und
 *     springt dorthin weiter.
 *  2. Der Immich-Server: Sobald man angemeldet ist, legt sich eine
 *     TV-Oberfläche über die Immich-Weboberfläche. Alle API-Aufrufe laufen
 *     über dieselbe Adresse und die normale Immich-Anmeldung (Cookie), es
 *     gibt also keine CORS-Probleme und keinen API-Schlüssel.
 */
(function () {
  'use strict';

  if (window.top !== window || window.__immichTv) return;
  window.__immichTv = true;

  const VERSION = '1.0.1';
  const LAUNCHER_URL = 'https://cdn.jsdelivr.net/gh/Uruser42/immich-tizenbrew/start.html';
  const SERVER_KEY = 'immichTv.server';
  const SETTINGS_KEY = 'immichTv.settings';
  const GRID_COLS = 6;
  const ALBUM_COLS = 5;
  const RENDER_AHEAD = 90; // grid tiles kept rendered beyond the focused one
  const CHUNK = 120;

  // -------------------------------------------------------------- helpers

  const noop = () => {};

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        // Storage blocked: settings just don't survive a restart.
      }
    },
  };

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        const value = attrs[key];
        if (value == null || value === false) return;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'style') el.style.cssText = value;
        else el.setAttribute(key, value === true ? '' : value);
      });
    }
    [].concat(children || []).forEach((child) => {
      if (child == null || child === false) return;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return el;
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function remPx() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }

  // Scrolls `scroller` just enough to show `el` with some breathing room
  // (more at the bottom, where the key hints sit).
  function ensureVisible(el, scroller, smooth) {
    const top = remPx() * 2.5;
    const bottom = remPx() * 5.5;
    const box = scroller.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    let delta = 0;
    if (rect.top < box.top + top) delta = rect.top - box.top - top;
    else if (rect.bottom > box.bottom - bottom) delta = rect.bottom - box.bottom + bottom;
    if (delta) scroller.scrollBy({ top: delta, behavior: smooth === false ? 'auto' : 'smooth' });
  }

  // Index arithmetic for a grid with `cols` columns; returns -1 at the edges.
  // Stays fast with thousands of tiles, unlike measuring every element.
  function gridMove(index, key, count, cols) {
    const col = index % cols;
    const row = (index - col) / cols;
    const lastRow = Math.floor((count - 1) / cols);
    if (key === 'left') return col > 0 ? index - 1 : -1;
    if (key === 'right') return col < cols - 1 && index + 1 < count ? index + 1 : -1;
    if (key === 'up') return row > 0 ? index - cols : -1;
    if (key === 'down') return row < lastRow ? Math.min(index + cols, count - 1) : -1;
    return -1;
  }

  // Picks the tile in one row of `els` that sits closest (horizontally) to `from`.
  function nearestInRow(from, els, rowStart, cols) {
    const centerOf = (el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    const x = centerOf(from);
    let best = rowStart;
    let bestDistance = Infinity;
    for (let k = rowStart; k < Math.min(rowStart + cols, els.length); k++) {
      const distance = Math.abs(centerOf(els[k]) - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    return best;
  }

  // ----------------------------------------------------------------- keys

  const KEY_CODES = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter',
    10009: 'back', 27: 'back', 8: 'back',
    10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop',
    417: 'ff', 412: 'rew', 10233: 'next', 10232: 'prev', 32: 'playpause',
  };
  const KEY_NAMES = {
    ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', Enter: 'enter',
    Escape: 'back', Backspace: 'back', XF86Back: 'back', ' ': 'playpause',
    MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
    MediaFastForward: 'ff', MediaRewind: 'rew', MediaTrackNext: 'next', MediaTrackPrevious: 'prev',
  };

  function keyOf(e) {
    return KEY_CODES[e.keyCode] || KEY_NAMES[e.key] || null;
  }

  // The remote's Back key only; Backspace and Escape stay usable for typing.
  const isTvBack = (e) => e.keyCode === 10009 || e.key === 'XF86Back';

  // Leaves the module. TizenBrew's own page is the first entry of the
  // session history, so go there; if the TV refuses, close the app instead.
  let leaving = false;
  function leaveModule(onStuck) {
    if (leaving) return;
    leaving = true;
    let gone = false;
    const markGone = () => { gone = true; };
    window.addEventListener('pagehide', markGone);
    window.addEventListener('beforeunload', markGone);
    if (history.length > 1) history.go(1 - history.length);
    setTimeout(() => {
      if (gone) return;
      leaving = false;
      try {
        if (window.tizen && window.tizen.application) {
          window.tizen.application.getCurrentApplication().exit();
          return;
        }
      } catch (e) {
        // Tizen APIs aren't exposed to this page.
      }
      window.close();
      if (onStuck) onStuck();
    }, 1500);
  }

  // ----------------------------------------------------------- formatting

  const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

  const pad = (n) => (n < 10 ? '0' : '') + n;

  // Asset dates are wall-clock times kept in the UTC fields of a Date, so
  // they read the same no matter which time zone the TV is set to.
  const fmtDay = (d) => d.getUTCDate() + '. ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  const fmtLongDay = (d) => WEEKDAYS[d.getUTCDay()] + ', ' + fmtDay(d);
  const fmtTime = (d) => pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  const fmtMonth = (d) => MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  const fmtNumber = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fmtCount = (n) => fmtNumber(n) + (n === 1 ? ' Element' : ' Elemente');

  // Immich 3 sends milliseconds, older servers "H:MM:SS.ffffff" strings.
  function fmtDuration(value) {
    let seconds = 0;
    if (typeof value === 'number') {
      seconds = Math.round(value / 1000);
    } else if (typeof value === 'string') {
      const m = /^(\d+):(\d+):(\d+)/.exec(value);
      if (m) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    if (!seconds) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return (hours ? hours + ':' + pad(minutes) : minutes) + ':' + pad(seconds % 60);
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 5) return 'Gute Nacht';
    if (hour < 11) return 'Guten Morgen';
    if (hour < 18) return 'Guten Tag';
    return 'Guten Abend';
  }

  const place = (item) => [item.city, item.country].filter(Boolean).join(', ');

  // ------------------------------------------------------------------ api

  const server = { version: '', legacy: false };

  function qs(params) {
    return Object.keys(params)
      .filter((key) => params[key] != null && params[key] !== '')
      .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(params[key]))
      .join('&');
  }

  function api(path, opts) {
    const options = opts || {};
    const init = { method: options.method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch('/api' + path, init).then((res) => {
      if (!res.ok) {
        const err = new Error(res.status === 401 ? 'nicht angemeldet' : 'Fehler ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    });
  }

  const media = {
    thumb: (id) => '/api/assets/' + id + '/thumbnail?size=thumbnail',
    preview: (id) => '/api/assets/' + id + '/thumbnail?size=preview',
    video: (id) => '/api/assets/' + id + '/video/playback',
  };

  function fromAsset(a) {
    const exif = a.exifInfo || {};
    return {
      id: a.id,
      video: a.type === 'VIDEO',
      duration: a.duration,
      date: new Date(a.localDateTime || a.fileCreatedAt),
      city: exif.city || null,
      country: exif.country || null,
    };
  }

  // Immich >= 1.133 returns time buckets as columns (one array per field).
  function fromColumns(cols) {
    const items = [];
    const count = cols && cols.id ? cols.id.length : 0;
    for (let i = 0; i < count; i++) {
      if (cols.isTrashed && cols.isTrashed[i]) continue;
      const offset = cols.localOffsetHours ? cols.localOffsetHours[i] || 0 : 0;
      items.push({
        id: cols.id[i],
        video: cols.isImage ? !cols.isImage[i] : false,
        duration: cols.duration ? cols.duration[i] : null,
        date: new Date(Date.parse(cols.fileCreatedAt[i]) + offset * 3600000),
        city: cols.city ? cols.city[i] : null,
        country: cols.country ? cols.country[i] : null,
      });
    }
    return items;
  }

  // ------------------------------------------------------------ playlists
  // A playlist is the list of assets behind a grid or a slideshow. Items
  // arrive lazily through loadMore(): month by month, or in random batches.

  function timelinePlaylist(title, params) {
    const base = Object.assign({}, params);
    if (server.legacy) {
      base.size = 'MONTH';
      if (base.visibility === 'timeline') {
        delete base.visibility;
        base.isArchived = false;
      }
    }
    const pl = { title, items: [], total: 0, done: false, random: false, loading: null };
    let buckets = null;
    let next = 0;
    let bucketsRequest = null;

    function loadBuckets() {
      if (!bucketsRequest) {
        bucketsRequest = api('/timeline/buckets?' + qs(base)).then((list) => {
          buckets = list || [];
          pl.total = buckets.reduce((sum, bucket) => sum + (bucket.count || 0), 0);
          if (!buckets.length) pl.done = true;
        }, (err) => {
          bucketsRequest = null;
          throw err;
        });
      }
      return bucketsRequest;
    }

    pl.loadMore = () => {
      if (pl.loading) return pl.loading;
      pl.loading = loadBuckets()
        .then(() => {
          if (next >= buckets.length) {
            pl.done = true;
            return false;
          }
          const bucket = buckets[next];
          return api('/timeline/bucket?' + qs(Object.assign({}, base, { timeBucket: bucket.timeBucket }))).then((data) => {
            next++;
            const added = Array.isArray(data) ? data.map(fromAsset) : fromColumns(data);
            added.forEach((item) => pl.items.push(item));
            if (next >= buckets.length) pl.done = true;
            return true;
          });
        })
        .then((more) => {
          pl.loading = null;
          return more;
        }, (err) => {
          pl.loading = null;
          throw err;
        });
      return pl.loading;
    };
    return pl;
  }

  function randomPlaylist() {
    const pl = { title: 'Diashow', items: [], total: 0, done: false, random: true, loading: null };
    pl.loadMore = () => {
      if (pl.loading) return pl.loading;
      pl.loading = api('/search/random', { method: 'POST', body: { size: 40, type: 'IMAGE', withExif: true } }).then((list) => {
        pl.loading = null;
        const added = (list || []).filter((a) => a.type !== 'VIDEO').map(fromAsset);
        added.forEach((item) => pl.items.push(item));
        if (!added.length) pl.done = true;
        return added.length > 0;
      }, (err) => {
        pl.loading = null;
        throw err;
      });
      return pl.loading;
    };
    return pl;
  }

  function fillTo(pl, count) {
    if (pl.items.length >= count || pl.done) return Promise.resolve();
    return pl.loadMore().then(() => fillTo(pl, count));
  }

  // ------------------------------------------------------------- settings

  const SETTING_DEFS = [
    { key: 'interval', label: 'Diashow-Tempo', options: [[5, '5 Sekunden'], [8, '8 Sekunden'], [12, '12 Sekunden'], [20, '20 Sekunden'], [30, '30 Sekunden'], [60, '1 Minute']] },
    { key: 'order', label: 'Reihenfolge in Alben', options: [['album', 'Wie im Album'], ['shuffle', 'Zufällig']] },
    { key: 'zoom', label: 'Zoom-Effekt in der Diashow', options: [[true, 'An'], [false, 'Aus']] },
    { key: 'clock', label: 'Uhr & Bildinfo in der Diashow', options: [[true, 'An'], [false, 'Aus']] },
    { key: 'videos', label: 'Videos in der Diashow', options: [['play', 'Abspielen'], ['skip', 'Überspringen']] },
  ];
  const DEFAULTS = { interval: 8, order: 'album', zoom: true, clock: true, videos: 'play' };
  const settings = Object.assign({}, DEFAULTS, store.get(SETTINGS_KEY, {}));

  // ---------------------------------------------------------------- icons

  const ICONS = {
    logo: '<svg viewBox="0 0 48 48"><defs><linearGradient id="itv-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b7cfa"/><stop offset="1" stop-color="#a35cf6"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#itv-g)"/><path fill="#fff" d="M14 15h20a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V18a3 3 0 0 1 3-3zm1.5 15h17l-5.2-7-4 5.2-2.8-3.4z"/><circle cx="31" cy="20.5" r="2.3" fill="#fff"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>',
    slideshow: '<svg viewBox="0 0 24 24"><path d="M10 8v8l5-4-5-4zm9-5H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>',
    photos: '<svg viewBox="0 0 24 24"><path d="M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4l2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 13.92 2h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.72 8.47a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
  };

  // --------------------------------------------------------------- styles

  const CSS = `
html.itv-active { font-size: calc(100vw / 120) !important; overflow: hidden !important; background: #0b0d12 !important; }
html.itv-active > body { display: none !important; }
#itv { --bg: #0b0d12; --surface: #161a22; --surface-2: #1f2430; --line: #2a3140; --fg: #f2f4f8; --muted: #9aa4b5; --accent: #8fb1ff;
  position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2147483000; overflow: hidden;
  background: var(--bg); color: var(--fg); font-family: "SamsungOneUI", "SamsungOne", "Samsung Sans", "Overpass", "Helvetica Neue", Arial, sans-serif;
  font-size: 1rem; line-height: 1.35; -webkit-font-smoothing: antialiased; cursor: none; user-select: none; text-align: left; }
#itv *, #itv *::before, #itv *::after { box-sizing: border-box; }
#itv svg { display: block; fill: currentColor; }
#itv .itv-view { position: absolute; top: 0; left: 0; right: 0; bottom: 0; visibility: hidden; }
#itv .itv-view.is-active { visibility: visible; }
#itv .itv-scroll { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
#itv .itv-scroll::-webkit-scrollbar { display: none; }
#itv .is-focusable { transition: transform .16s ease-out, box-shadow .16s ease-out; }
#itv .is-focused { transform: scale(1.05); box-shadow: 0 0 0 .3rem #fff, 0 1.2rem 2.6rem rgba(0, 0, 0, .6); z-index: 2; }

#itv .hero { position: relative; height: 34rem; overflow: hidden; }
#itv .hero-img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; max-width: none; object-fit: cover; opacity: 0; transition: opacity 1.4s ease; }
#itv .hero-img.is-visible { opacity: 1; }
#itv .hero-shade { position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(to top, var(--bg) 0%, rgba(11, 13, 18, .6) 38%, rgba(11, 13, 18, .1) 75%), linear-gradient(to right, rgba(11, 13, 18, .75) 0%, rgba(11, 13, 18, 0) 60%); }
#itv .hero-text { position: absolute; left: 5rem; bottom: 3.2rem; max-width: 62rem; }
#itv .hero-brand { display: flex; align-items: center; font-size: 1.3rem; font-weight: 600; margin-bottom: 1.2rem; }
#itv .hero-brand svg { width: 2.4rem; height: 2.4rem; margin-right: .8rem; }
#itv .hero-greeting { font-size: 3.4rem; font-weight: 700; letter-spacing: -.02em; }
#itv .hero-sub { margin-top: .5rem; font-size: 1.35rem; color: var(--muted); }
#itv .hero-clock { position: absolute; top: 2.6rem; right: 5rem; text-align: right; text-shadow: 0 .1rem .6rem rgba(0, 0, 0, .5); }
#itv .hero-caption { position: absolute; right: 5rem; bottom: 3.4rem; font-size: 1.05rem; color: rgba(255, 255, 255, .72); text-shadow: 0 .1rem .5rem rgba(0, 0, 0, .6); }
#itv .clock-time { font-size: 3rem; font-weight: 300; letter-spacing: .02em; }
#itv .clock-date { font-size: 1.15rem; color: rgba(255, 255, 255, .8); margin-top: .2rem; }
#itv .section { padding: 0 5rem; margin-top: 1.6rem; }
#itv .section-title { font-size: 1.45rem; font-weight: 600; margin: 2.4rem 0 1.1rem; }
#itv .row-actions { display: grid; grid-template-columns: repeat(4, 1fr); grid-gap: 1.5rem; }
#itv .action { position: relative; display: flex; align-items: center; height: 7rem; padding: 0 1.7rem; border-radius: 1.2rem; background: var(--surface); }
#itv .action-icon { flex: none; display: flex; align-items: center; justify-content: center; width: 3.6rem; height: 3.6rem; margin-right: 1.2rem; border-radius: 1rem; background: rgba(255, 255, 255, .08); }
#itv .action-icon svg { width: 2rem; height: 2rem; }
#itv .action.is-primary { background: linear-gradient(135deg, #4f6ef7 0%, #8a5cf6 100%); }
#itv .action.is-primary .action-icon { background: rgba(255, 255, 255, .18); }
#itv .action-label { font-size: 1.4rem; font-weight: 600; }
#itv .action-sub { font-size: 1rem; color: var(--muted); margin-top: .15rem; }
#itv .action.is-primary .action-sub { color: rgba(255, 255, 255, .8); }
#itv .albums { display: grid; grid-template-columns: repeat(${ALBUM_COLS}, 1fr); grid-gap: 1.5rem; padding-bottom: 6rem; }
#itv .album { position: relative; border-radius: 1.1rem; overflow: hidden; background: var(--surface-2); }
#itv .album-cover { position: relative; padding-top: 75%; }
#itv .album-cover img, #itv .photo img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; max-width: none; object-fit: cover; }
#itv .album-empty { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; color: #485062; }
#itv .album-empty svg { width: 4rem; height: 4rem; }
#itv .album-meta { position: absolute; left: 0; right: 0; bottom: 0; padding: 3rem 1.1rem .9rem; background: linear-gradient(to bottom, rgba(0, 0, 0, 0), rgba(0, 0, 0, .82)); }
#itv .album-name { font-size: 1.2rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#itv .album-sub { font-size: .95rem; color: rgba(255, 255, 255, .72); margin-top: .15rem; }
#itv .empty { grid-column: 1 / -1; padding: 2rem 0; color: var(--muted); font-size: 1.2rem; }
#itv .hint { position: absolute; left: 0; right: 0; bottom: 0; padding: 2.4rem 5rem 1.3rem; font-size: 1rem; color: var(--muted);
  background: linear-gradient(to top, var(--bg) 45%, rgba(11, 13, 18, 0)); pointer-events: none; }
#itv .hint b { display: inline-block; padding: .1rem .55rem; margin: 0 .4rem 0 1.6rem; border-radius: .4rem; background: var(--surface-2); color: var(--fg); font-weight: 600; }
#itv .hint b:first-child { margin-left: 0; }

#itv .grid-head { position: absolute; top: 0; left: 0; right: 0; height: 9rem; padding: 0 5rem 1.2rem; display: flex; align-items: flex-end; justify-content: space-between; }
#itv .grid-title { font-size: 2.5rem; font-weight: 700; letter-spacing: -.01em; }
#itv .grid-sub { font-size: 1.15rem; color: var(--muted); margin-top: .3rem; }
#itv .grid-date { font-size: 1.5rem; font-weight: 300; color: var(--muted); }
#itv .grid-scroll { top: 9rem; padding: .8rem 5rem 6rem; }
#itv .photos { display: grid; grid-template-columns: repeat(${GRID_COLS}, 1fr); grid-gap: .8rem; }
#itv .photo { position: relative; padding-top: 100%; border-radius: .7rem; overflow: hidden; background: var(--surface); }
#itv .photo.is-focused { transform: scale(1.07); }
#itv .badge { position: absolute; right: .5rem; bottom: .5rem; display: flex; align-items: center; padding: .2rem .55rem; border-radius: .5rem; background: rgba(0, 0, 0, .6); font-size: .95rem; }
#itv .badge svg { width: 1rem; height: 1rem; }
#itv .badge span { margin-left: .3rem; }
#itv .grid-status { padding: 2rem 0; text-align: center; color: var(--muted); font-size: 1.2rem; }

#itv .itv-viewer { background: #000; }
#itv .v-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; max-width: none; object-fit: contain; opacity: 0; transition: opacity .9s ease; }
#itv .v-layer.is-visible { opacity: 1; }
#itv .v-layer.kb { animation-name: itv-kb; animation-duration: var(--kb-dur, 10s); animation-timing-function: linear; animation-fill-mode: forwards; transform-origin: var(--kb-x, 50%) var(--kb-y, 50%); }
@keyframes itv-kb { from { transform: scale(1); } to { transform: scale(1.09); } }
#itv .v-shade { position: absolute; left: 0; right: 0; bottom: 0; height: 16rem; background: linear-gradient(to top, rgba(0, 0, 0, .7), rgba(0, 0, 0, 0)); opacity: 0; transition: opacity .6s; }
#itv .v-info { position: absolute; left: 4.5rem; bottom: 3.4rem; max-width: 60%; opacity: 0; transition: opacity .6s; text-shadow: 0 .1rem .6rem rgba(0, 0, 0, .6); }
#itv .v-date { font-size: 1.7rem; font-weight: 600; }
#itv .v-place { font-size: 1.25rem; color: rgba(255, 255, 255, .8); margin-top: .3rem; }
#itv .v-pos { position: absolute; top: 2.6rem; right: 4.5rem; padding: .35rem .9rem; border-radius: 99rem; background: rgba(0, 0, 0, .45); font-size: 1.1rem; opacity: 0; transition: opacity .6s; }
#itv .v-clock { position: absolute; right: 4.5rem; bottom: 3.2rem; text-align: right; opacity: 0; transition: opacity .6s; text-shadow: 0 .1rem .6rem rgba(0, 0, 0, .6); }
#itv .itv-viewer.show-info .v-info, #itv .itv-viewer.show-info .v-pos, #itv .itv-viewer.show-info .v-shade,
#itv .itv-viewer.is-playing.with-clock .v-info, #itv .itv-viewer.is-playing.with-clock .v-clock, #itv .itv-viewer.is-playing.with-clock .v-shade { opacity: 1; }
#itv .v-state { position: absolute; top: 50%; left: 50%; display: flex; align-items: center; justify-content: center; width: 7rem; height: 7rem; margin: -3.5rem 0 0 -3.5rem; border-radius: 50%; background: rgba(0, 0, 0, .5); opacity: 0; }
#itv .v-state svg { width: 3.2rem; height: 3.2rem; }
#itv .v-state.is-visible { animation: itv-flash 1s ease-out forwards; }
@keyframes itv-flash { 0% { opacity: 1; transform: scale(.9); } 60% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.05); } }
#itv .v-progress { position: absolute; left: 0; right: 0; bottom: 0; height: .35rem; background: rgba(255, 255, 255, .15); opacity: 0; transition: opacity .4s; }
#itv .v-progress div { width: 0; height: 100%; background: var(--accent); }
#itv .itv-viewer.is-video .v-progress { opacity: 1; }

#itv .settings-wrap { padding: 5rem 0 4rem; }
#itv .settings-title, #itv .settings-list, #itv .settings-foot { width: 66rem; margin: 0 auto; }
#itv .settings-title { margin-bottom: 2rem; font-size: 2.5rem; font-weight: 700; }
#itv .setting { display: flex; align-items: center; justify-content: space-between; padding: 1.25rem 1.8rem; margin-bottom: .8rem; border-radius: 1rem; background: var(--surface); font-size: 1.35rem; }
#itv .setting.is-focused { transform: scale(1.02); background: #fff; color: #0b0d12; box-shadow: 0 1rem 2rem rgba(0, 0, 0, .5); }
#itv .setting-value { color: var(--accent); font-weight: 600; }
#itv .setting.is-focused .setting-value { color: #2d4fd8; }
#itv .setting.is-option.is-focused .setting-value::before { content: '\\2039\\00a0\\00a0'; }
#itv .setting.is-option.is-focused .setting-value::after { content: '\\00a0\\00a0\\203A'; }
#itv .settings-gap { height: 1.6rem; }
#itv .settings-foot { margin-top: 2rem; color: var(--muted); font-size: 1rem; }

#itv .itv-toast { position: absolute; left: 50%; bottom: 4.5rem; z-index: 10; max-width: 80rem; padding: .9rem 1.7rem; border-radius: 99rem; background: rgba(28, 33, 44, .95);
  box-shadow: 0 .8rem 2rem rgba(0, 0, 0, .5); font-size: 1.2rem; opacity: 0; transform: translate(-50%, 1rem); transition: opacity .25s, transform .25s; pointer-events: none; }
#itv .itv-toast.is-visible { opacity: 1; transform: translate(-50%, 0); }

#itv.itv-launcher { display: flex; align-items: center; justify-content: center; background: radial-gradient(ellipse at 30% 20%, #1c2540 0%, #0b0d12 60%); }
#itv .launch { width: 56rem; text-align: center; }
#itv .launch-logo { width: 6rem; height: 6rem; margin: 0 auto 1.6rem; }
#itv .launch-logo svg { width: 100%; height: 100%; }
#itv .launch-title { font-size: 3rem; font-weight: 700; }
#itv .launch-text { margin-top: .8rem; font-size: 1.3rem; color: var(--muted); }
#itv .launch-input { display: block; width: 100%; margin: 2.4rem 0 .8rem; padding: 1.1rem 1.4rem; font: inherit; font-size: 1.6rem; text-align: center;
  color: var(--fg); background: #10141c; border: .15rem solid var(--line); border-radius: 1rem; outline: none; }
#itv .launch-input:focus { border-color: var(--accent); box-shadow: 0 0 0 .3rem rgba(143, 177, 255, .3); }
#itv .launch-hint { font-size: 1.05rem; color: var(--muted); }
#itv .launch-error { min-height: 1.5rem; margin-top: 1rem; font-size: 1.15rem; color: #ff9b9b; }
#itv .launch-button { display: inline-block; margin-top: 1.4rem; padding: 1rem 3rem; border-radius: 99rem; background: var(--surface-2); font-size: 1.4rem; font-weight: 600;
  transition: transform .16s, background .16s, color .16s; }
#itv .launch-button.is-focused { background: #fff; color: #0b0d12; transform: scale(1.06); }
#itv .launch-bar { width: 24rem; height: .35rem; margin: 2.4rem auto 1.4rem; border-radius: 99rem; background: rgba(255, 255, 255, .12); overflow: hidden; }
#itv .launch-bar div { width: 0; height: 100%; background: var(--accent); animation: itv-bar 1.6s linear forwards; }
@keyframes itv-bar { to { width: 100%; } }

#itv-login-hint { position: fixed; top: 16px; left: 50%; z-index: 2147483000; transform: translateX(-50%); padding: 12px 22px; border-radius: 999px;
  background: #1f2430; color: #f2f4f8; font: 600 16px/1.3 "Helvetica Neue", Arial, sans-serif; box-shadow: 0 8px 24px rgba(0, 0, 0, .4); }
`;

  function injectStyles() {
    if (document.getElementById('itv-style')) return;
    const style = h('style', { id: 'itv-style' });
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // --------------------------------------------------------- view stack

  const ui = { root: null, stack: [], toastEl: null, toastTimer: 0 };

  function toast(text) {
    if (!ui.root) return;
    ui.toastEl.textContent = text;
    ui.toastEl.classList.add('is-visible');
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => ui.toastEl.classList.remove('is-visible'), 2800);
  }

  function fail(err) {
    console.error('[Immich TV]', err);
    if (err && err.status === 401) {
      location.href = '/auth/login';
      return;
    }
    toast('Immich antwortet nicht' + (err && err.message ? ' (' + err.message + ')' : ''));
  }

  function topView() {
    return ui.stack[ui.stack.length - 1];
  }

  function pushView(view) {
    const top = topView();
    if (top) {
      top.el.classList.remove('is-active');
      if (top.onHide) top.onHide();
    }
    ui.stack.push(view);
    ui.root.insertBefore(view.el, ui.toastEl);
    view.el.classList.add('is-active');
    tickClocks();
    if (view.onShow) view.onShow();
  }

  function popView() {
    if (ui.stack.length <= 1) return false;
    const view = ui.stack.pop();
    view.el.classList.remove('is-active');
    if (view.destroy) view.destroy();
    view.el.remove();
    const top = topView();
    top.el.classList.add('is-active');
    if (top.onShow) top.onShow();
    return true;
  }

  function tickClocks() {
    if (!ui.root) return;
    const now = new Date();
    const time = pad(now.getHours()) + ':' + pad(now.getMinutes());
    const date = WEEKDAYS[now.getDay()] + ', ' + now.getDate() + '. ' + MONTHS[now.getMonth()];
    ui.root.querySelectorAll('.clock-time').forEach((el) => { el.textContent = time; });
    ui.root.querySelectorAll('.clock-date').forEach((el) => { el.textContent = date; });
  }

  function handleKey(e) {
    const key = keyOf(e);
    if (!ui.root) {
      // Login page: the TV's Back key returns to TizenBrew.
      if (e.type === 'keydown' && isTvBack(e)) {
        e.preventDefault();
        leaveModule();
      }
      return;
    }
    if (!key) return;
    // Swallow the key completely so Immich's own shortcuts never fire.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    const top = topView();
    if (top && top.onKey(key)) return;
    if (key === 'back' && !popView()) leaveModule(() => toast('Zum Beenden die Home-Taste drücken'));
  }

  // ------------------------------------------------------------ actions

  function openGrid(title, pl, subtitle) {
    pushView(GridView(title, pl, subtitle));
  }

  function openAlbum(album, autoplay) {
    const pl = timelinePlaylist(album.albumName, { albumId: album.id, order: album.order });
    pl.total = album.assetCount || 0;
    if (!autoplay) {
      openGrid(album.albumName || 'Album', pl, albumSubtitle(album));
      return Promise.resolve();
    }
    return fillTo(pl, 1).then(() => {
      if (!pl.items.length) toast('Dieses Album ist leer');
      else pushView(ViewerView(pl, 0, true));
    }, fail);
  }

  function startRandomSlideshow() {
    const pl = randomPlaylist();
    return pl.loadMore().then(() => {
      if (!pl.items.length) toast('Keine Fotos gefunden');
      else pushView(ViewerView(pl, 0, true));
    }, fail);
  }

  function logout() {
    api('/auth/logout', { method: 'POST' }).catch(noop).then(() => {
      location.href = '/auth/login';
    });
  }

  function albumYears(album) {
    if (!album.startDate) return '';
    const start = new Date(album.startDate).getUTCFullYear();
    const end = album.endDate ? new Date(album.endDate).getUTCFullYear() : start;
    return start === end ? String(start) : start + '–' + end;
  }

  function albumSubtitle(album) {
    const years = albumYears(album);
    return fmtCount(album.assetCount || 0) + (years ? ' · ' + years : '');
  }

  // Older servers list shared albums only with ?shared=true, Immich 3 uses
  // ?isShared=true; unknown parameters are ignored, so ask all three ways.
  function loadAlbums() {
    const requests = ['/albums', '/albums?shared=true', '/albums?isShared=true'].map((path, k) =>
      api(path).catch((err) => {
        if (k === 0) throw err;
        return [];
      }));
    return Promise.all(requests).then((lists) => {
      const seen = {};
      const albums = [];
      lists.forEach((list) => (list || []).forEach((album) => {
        if (seen[album.id]) return;
        seen[album.id] = true;
        albums.push(album);
      }));
      const recency = (album) => Date.parse(album.endDate || album.updatedAt || album.createdAt) || 0;
      return albums.sort((a, b) => recency(b) - recency(a));
    });
  }

  // ---------------------------------------------------------------- home

  function HomeView(me) {
    const el = h('div', { class: 'itv-view itv-home' });
    const scroller = h('div', { class: 'itv-scroll' });
    const heroImgs = [h('img', { class: 'hero-img', alt: '' }), h('img', { class: 'hero-img', alt: '' })];
    const greetingEl = h('div', { class: 'hero-greeting' });
    const statsEl = h('div', { class: 'hero-sub', text: ' ' });
    const caption = h('div', { class: 'hero-caption' });
    scroller.appendChild(h('div', { class: 'hero' }, [
      heroImgs[0], heroImgs[1],
      h('div', { class: 'hero-shade' }),
      h('div', { class: 'hero-clock' }, [h('div', { class: 'clock-time' }), h('div', { class: 'clock-date' })]),
      h('div', { class: 'hero-text' }, [h('div', { class: 'hero-brand', html: ICONS.logo + '<span>Immich</span>' }), greetingEl, statsEl]),
      caption,
    ]));

    const actions = [
      { icon: 'slideshow', label: 'Diashow', sub: 'Zufällige Fotos', primary: true, run: startRandomSlideshow },
      { icon: 'photos', label: 'Alle Fotos', sub: 'Zeitleiste', run: () => openGrid('Alle Fotos', timelinePlaylist('Alle Fotos', { visibility: 'timeline' })) },
      { icon: 'heart', label: 'Favoriten', sub: 'Deine Lieblinge', run: () => openGrid('Favoriten', timelinePlaylist('Favoriten', { isFavorite: true, visibility: 'timeline' })) },
      { icon: 'gear', label: 'Einstellungen', sub: 'Diashow & Konto', run: () => pushView(SettingsView(me)) },
    ];
    const actionEls = actions.map((action) => h('div', { class: 'action is-focusable' + (action.primary ? ' is-primary' : '') }, [
      h('div', { class: 'action-icon', html: ICONS[action.icon] }),
      h('div', null, [h('div', { class: 'action-label', text: action.label }), h('div', { class: 'action-sub', text: action.sub })]),
    ]));
    scroller.appendChild(h('div', { class: 'section' }, h('div', { class: 'row-actions' }, actionEls)));

    const albumsTitle = h('div', { class: 'section-title', text: 'Alben' });
    const albumsGrid = h('div', { class: 'albums' }, h('div', { class: 'empty', text: 'Alben werden geladen …' }));
    scroller.appendChild(h('div', { class: 'section' }, [albumsTitle, albumsGrid]));
    el.appendChild(scroller);
    el.appendChild(h('div', { class: 'hint', html: '<b>OK</b>Öffnen<b>Play</b>Diashow<b>Zurück</b>TizenBrew' }));

    let albums = [];
    const sections = [{ els: actionEls, cols: 4 }, { els: [], cols: ALBUM_COLS }];
    let focus = { s: 0, i: 0 };
    let pending = false;

    function albumTile(album) {
      const cover = h('div', { class: 'album-cover' }, album.albumThumbnailAssetId
        ? h('img', { src: media.thumb(album.albumThumbnailAssetId), loading: 'lazy', decoding: 'async', alt: '' })
        : h('div', { class: 'album-empty', html: ICONS.image }));
      return h('div', { class: 'album is-focusable' }, [cover, h('div', { class: 'album-meta' }, [
        h('div', { class: 'album-name', text: album.albumName || 'Ohne Titel' }),
        h('div', { class: 'album-sub', text: albumSubtitle(album) }),
      ])]);
    }

    loadAlbums().then((list) => {
      albums = list;
      albumsGrid.textContent = '';
      sections[1].els = albums.map(albumTile);
      sections[1].els.forEach((tile) => albumsGrid.appendChild(tile));
      albumsTitle.textContent = albums.length ? 'Alben · ' + albums.length : 'Alben';
      if (!albums.length) albumsGrid.appendChild(h('div', { class: 'empty', text: 'Noch keine Alben. Leg in Immich welche an, dann erscheinen sie hier.' }));
    }, (err) => {
      albumsGrid.textContent = '';
      albumsGrid.appendChild(h('div', { class: 'empty', text: 'Alben konnten nicht geladen werden.' }));
      fail(err);
    });

    greetingEl.textContent = greeting() + (me.name ? ', ' + me.name.split(' ')[0] : '');
    api('/assets/statistics?' + qs(server.legacy ? { isArchived: false } : { visibility: 'timeline' })).then((stats) => {
      statsEl.textContent = fmtNumber(stats.images || 0) + ' Fotos · ' + fmtNumber(stats.videos || 0) + ' Videos';
    }, noop);

    // Hero: a few random photos, cross-faded.
    let heroItems = [];
    let heroIndex = -1;
    let heroFront = 0;
    let heroTimer = 0;
    function nextHero() {
      clearTimeout(heroTimer);
      if (!heroItems.length) return;
      heroIndex = (heroIndex + 1) % heroItems.length;
      const item = heroItems[heroIndex];
      const img = heroImgs[1 - heroFront];
      img.onload = () => {
        heroImgs[heroFront].classList.remove('is-visible');
        img.classList.add('is-visible');
        heroFront = 1 - heroFront;
        caption.textContent = [fmtDay(item.date), place(item)].filter(Boolean).join(' · ');
      };
      img.src = media.preview(item.id);
      heroTimer = setTimeout(nextHero, 12000);
    }
    api('/search/random', { method: 'POST', body: { size: 12, type: 'IMAGE', withExif: true } }).then((list) => {
      heroItems = (list || []).filter((a) => a.type !== 'VIDEO').map(fromAsset);
      nextHero();
    }, noop);

    function setFocus(s, i, smooth) {
      const old = sections[focus.s].els[focus.i];
      if (old) old.classList.remove('is-focused');
      focus = { s, i };
      const tile = sections[s].els[i];
      if (!tile) return;
      tile.classList.add('is-focused');
      if (s === 0) scroller.scrollTo({ top: 0, behavior: smooth === false ? 'auto' : 'smooth' });
      else ensureVisible(tile, scroller, smooth);
    }

    function move(key) {
      const section = sections[focus.s];
      const next = gridMove(focus.i, key, section.els.length, section.cols);
      if (next >= 0) {
        setFocus(focus.s, next);
        return;
      }
      const from = section.els[focus.i];
      if (key === 'down' && focus.s < sections.length - 1 && sections[focus.s + 1].els.length) {
        const target = sections[focus.s + 1];
        setFocus(focus.s + 1, nearestInRow(from, target.els, 0, target.cols));
      } else if (key === 'up' && focus.s > 0) {
        const target = sections[focus.s - 1];
        const lastRowStart = Math.floor((target.els.length - 1) / target.cols) * target.cols;
        setFocus(focus.s - 1, nearestInRow(from, target.els, lastRowStart, target.cols));
      }
    }

    // Guards against double presses while a slideshow or album is loading.
    function run(task) {
      if (pending) return;
      pending = true;
      Promise.resolve(task()).then(() => { pending = false; }, () => { pending = false; });
    }

    setFocus(0, 0, false);

    return {
      el,
      onShow() {
        if (heroItems.length && !heroTimer) nextHero();
      },
      onHide() {
        clearTimeout(heroTimer);
        heroTimer = 0;
      },
      onKey(key) {
        if (key === 'left' || key === 'right' || key === 'up' || key === 'down') {
          move(key);
          return true;
        }
        if (key === 'enter') {
          if (focus.s === 0) run(actions[focus.i].run);
          else run(() => openAlbum(albums[focus.i], false));
          return true;
        }
        if (key === 'playpause' || key === 'play') {
          if (focus.s === 1) run(() => openAlbum(albums[focus.i], true));
          else run(startRandomSlideshow);
          return true;
        }
        return false;
      },
    };
  }

  // ---------------------------------------------------------------- grid

  function GridView(title, pl, subtitle) {
    const el = h('div', { class: 'itv-view itv-grid' });
    const subEl = h('div', { class: 'grid-sub', text: subtitle || ' ' });
    const dateEl = h('div', { class: 'grid-date' });
    const photos = h('div', { class: 'photos' });
    const status = h('div', { class: 'grid-status', text: 'Wird geladen …' });
    const scroller = h('div', { class: 'itv-scroll grid-scroll' }, [photos, status]);
    el.appendChild(h('div', { class: 'grid-head' }, [h('div', null, [h('div', { class: 'grid-title', text: title }), subEl]), dateEl]));
    el.appendChild(scroller);
    el.appendChild(h('div', { class: 'hint', html: '<b>OK</b>Ansehen<b>Play</b>Diashow ab hier<b>Zurück</b>Übersicht' }));

    const tiles = [];
    let focus = -1;
    let loading = false;

    function tile(item) {
      const t = h('div', { class: 'photo is-focusable' }, h('img', { src: media.thumb(item.id), loading: 'lazy', decoding: 'async', alt: '' }));
      if (item.video) {
        const duration = fmtDuration(item.duration);
        t.appendChild(h('div', { class: 'badge', html: ICONS.play + (duration ? '<span>' + duration + '</span>' : '') }));
      }
      return t;
    }

    function renderUpTo(count) {
      const target = Math.min(pl.items.length, count);
      if (tiles.length >= target) return;
      const frag = document.createDocumentFragment();
      while (tiles.length < target) {
        const t = tile(pl.items[tiles.length]);
        tiles.push(t);
        frag.appendChild(t);
      }
      photos.appendChild(frag);
    }

    function updateStatus() {
      if (!subtitle) subEl.textContent = fmtCount(Math.max(pl.total, pl.items.length));
      status.textContent = pl.done ? (pl.items.length ? '' : 'Hier ist noch nichts.') : 'Wird geladen …';
      status.style.display = status.textContent ? '' : 'none';
    }

    // Keeps data loaded and tiles rendered well ahead of the focused tile.
    // Renders after every loaded month, so the first photos show up at once.
    function ensure(index) {
      const want = index + RENDER_AHEAD;
      const render = () => {
        if (tiles.length < want) renderUpTo(Math.max(want, tiles.length + CHUNK));
        updateStatus();
        if (focus < 0 && tiles.length) setFocus(0, false);
      };
      render();
      if (loading || pl.done || pl.items.length >= want) return;
      loading = true;
      const step = () => pl.loadMore().then(() => {
        render();
        if (!pl.done && pl.items.length < want) return step();
      });
      step().then(() => {
        loading = false;
      }, (err) => {
        loading = false;
        render();
        fail(err);
      });
    }

    function setFocus(i, smooth) {
      if (!tiles.length) return;
      if (focus >= 0 && tiles[focus]) tiles[focus].classList.remove('is-focused');
      focus = Math.max(0, Math.min(i, tiles.length - 1));
      tiles[focus].classList.add('is-focused');
      ensureVisible(tiles[focus], scroller, smooth);
      const item = pl.items[focus];
      dateEl.textContent = item ? fmtMonth(item.date) : '';
    }

    function open(autoplay) {
      pushView(ViewerView(pl, focus, autoplay, (index) => {
        renderUpTo(index + 1);
        setFocus(index, false);
        ensure(index);
      }));
    }

    ensure(0);

    return {
      el,
      onKey(key) {
        if (key === 'left' || key === 'right' || key === 'up' || key === 'down') {
          if (focus < 0) return true;
          const next = gridMove(focus, key, tiles.length, GRID_COLS);
          if (next >= 0) {
            setFocus(next);
            ensure(next);
          }
          return true;
        }
        if (!tiles.length) return false;
        if (key === 'enter') {
          open(false);
          return true;
        }
        if (key === 'playpause' || key === 'play') {
          open(true);
          return true;
        }
        return false;
      },
    };
  }

  // -------------------------------------------------------------- viewer

  let viewerHintShown = false;

  function ViewerView(pl, start, autoplay, onClose) {
    const el = h('div', { class: 'itv-view itv-viewer' + (settings.clock ? ' with-clock' : '') });
    const layers = [h('img', { class: 'v-layer', alt: '' }), h('img', { class: 'v-layer', alt: '' })];
    const video = h('video', { class: 'v-layer', playsinline: true, preload: 'auto' });
    const infoDate = h('div', { class: 'v-date' });
    const infoPlace = h('div', { class: 'v-place' });
    const pos = h('div', { class: 'v-pos' });
    const state = h('div', { class: 'v-state' });
    const progressBar = h('div');
    [
      layers[0], layers[1], video,
      h('div', { class: 'v-shade' }),
      h('div', { class: 'v-info' }, [infoDate, infoPlace]),
      pos,
      h('div', { class: 'v-clock' }, [h('div', { class: 'clock-time' }), h('div', { class: 'clock-date' })]),
      state,
      h('div', { class: 'v-progress' }, progressBar),
    ].forEach((child) => el.appendChild(child));

    const preloader = new Image();
    let index = start;
    let front = 0;
    let token = 0;
    let timer = 0;
    let infoTimer = 0;
    let infoPinned = false;
    let playing = !!autoplay;
    let closed = false;

    function flashState(name) {
      state.innerHTML = ICONS[name];
      state.classList.remove('is-visible');
      void state.offsetWidth; // restart the animation
      state.classList.add('is-visible');
    }

    function flashInfo() {
      el.classList.add('show-info');
      clearTimeout(infoTimer);
      if (!infoPinned) infoTimer = setTimeout(() => el.classList.remove('show-info'), 3500);
    }

    function renderInfo(item) {
      infoDate.textContent = fmtLongDay(item.date) + ' · ' + fmtTime(item.date);
      infoPlace.textContent = place(item);
      pos.style.display = pl.random ? 'none' : '';
      pos.textContent = (index + 1) + ' / ' + fmtNumber(Math.max(pl.total, pl.items.length));
    }

    function kenBurns(layer) {
      layer.classList.remove('kb');
      void layer.offsetWidth; // restart the animation
      layer.style.setProperty('--kb-x', Math.round(20 + Math.random() * 60) + '%');
      layer.style.setProperty('--kb-y', Math.round(20 + Math.random() * 60) + '%');
      layer.style.setProperty('--kb-dur', (settings.interval + 2) + 's');
      layer.style.animationPlayState = 'running';
      layer.classList.add('kb');
    }

    function schedule() {
      clearTimeout(timer);
      if (playing && !closed) timer = setTimeout(advance, settings.interval * 1000);
    }

    function preloadNext() {
      const next = pl.items[index + 1];
      if (next && !next.video) preloader.src = media.preview(next.id);
    }

    function preloadMore() {
      if (!pl.done && pl.items.length - index < 10) pl.loadMore().catch(noop);
    }

    function stopVideo() {
      if (!video.getAttribute('src')) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.classList.remove('is-visible');
    }

    function showVideo(item) {
      layers[front].classList.remove('is-visible');
      progressBar.style.width = '0';
      video.setAttribute('src', media.video(item.id));
      video.classList.add('is-visible');
      const p = video.play();
      if (p && p.catch) p.catch(noop);
    }

    function show() {
      const item = pl.items[index];
      const my = ++token;
      clearTimeout(timer);
      renderInfo(item);
      flashInfo();
      el.classList.toggle('is-video', item.video);
      if (item.video) {
        showVideo(item);
        return;
      }
      stopVideo();
      const incoming = layers[1 - front];
      const url = media.preview(item.id);
      const reveal = () => {
        if (my !== token || closed) return;
        incoming.classList.remove('kb');
        if (playing && settings.zoom) kenBurns(incoming);
        layers[front].classList.remove('is-visible');
        incoming.classList.add('is-visible');
        front = 1 - front;
        schedule();
        preloadNext();
      };
      incoming.onload = () => {
        if (my !== token) return;
        if (incoming.decode) incoming.decode().then(reveal, reveal);
        else reveal();
      };
      incoming.onerror = () => {
        if (my !== token) return;
        toast('Dieses Foto konnte nicht geladen werden');
        if (playing) timer = setTimeout(advance, 2500);
      };
      if (incoming.getAttribute('src') === url && incoming.complete && incoming.naturalWidth) incoming.onload();
      else incoming.setAttribute('src', url);
    }

    function go(target) {
      if (target < 0) return;
      const ready = target < pl.items.length || pl.done ? Promise.resolve() : fillTo(pl, target + 1);
      ready.then(() => {
        if (closed) return;
        if (target >= pl.items.length) {
          toast('Das war das letzte Element');
          return;
        }
        index = target;
        show();
        preloadMore();
      }, fail);
    }

    const skipVideos = () => settings.videos === 'skip';

    function firstSlide() {
      let k = 0;
      while (k < pl.items.length && skipVideos() && pl.items[k].video) k++;
      return k < pl.items.length ? k : 0;
    }

    // Next slide of a running slideshow: shuffled or in order, optionally
    // skipping videos, wrapping around at the end.
    function nextSlide() {
      const count = pl.items.length;
      if (!pl.random && settings.order === 'shuffle' && count > 1) {
        if (!pl.done) pl.loadMore().catch(noop);
        for (let tries = 0; tries < 20; tries++) {
          const k = Math.floor(Math.random() * count);
          if (k !== index && !(skipVideos() && pl.items[k].video)) return Promise.resolve(k);
        }
        return Promise.resolve((index + 1) % count);
      }
      let k = index + 1;
      const step = () => {
        while (k < pl.items.length && skipVideos() && pl.items[k].video) k++;
        if (k < pl.items.length) return Promise.resolve(k);
        if (pl.done) return Promise.resolve(firstSlide());
        return pl.loadMore().then(step);
      };
      return step();
    }

    function advance() {
      nextSlide().then((k) => {
        if (closed || !playing) return;
        index = k;
        show();
        preloadMore();
      }, fail);
    }

    function setPlaying(on) {
      playing = on;
      el.classList.toggle('is-playing', on);
      flashState(on ? 'play' : 'pause');
      clearTimeout(timer);
      const item = pl.items[index];
      if (item.video) return;
      const layer = layers[front];
      if (on) {
        if (settings.zoom) {
          if (layer.classList.contains('kb')) layer.style.animationPlayState = 'running';
          else kenBurns(layer);
        }
        schedule();
      } else {
        layer.style.animationPlayState = 'paused';
      }
    }

    function toggleVideo() {
      if (video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(noop);
        flashState('play');
      } else {
        video.pause();
        flashState('pause');
      }
    }

    video.addEventListener('timeupdate', () => {
      if (video.duration) progressBar.style.width = (video.currentTime / video.duration) * 100 + '%';
    });
    video.addEventListener('ended', () => {
      if (playing) advance();
    });
    video.addEventListener('error', () => {
      if (!video.getAttribute('src')) return;
      toast('Dieses Video lässt sich hier nicht abspielen');
      if (playing) timer = setTimeout(advance, 2500);
    });

    el.classList.toggle('is-playing', playing);
    show();
    if (!viewerHintShown) {
      viewerHintShown = true;
      setTimeout(() => toast(playing ? 'Diashow läuft · OK pausiert · ◀ ▶ blättern' : 'OK startet die Diashow · ◀ ▶ blättern · ▲ Infos'), 600);
    }

    return {
      el,
      onKey(key) {
        const item = pl.items[index];
        switch (key) {
          case 'right':
          case 'next':
            go(index + 1);
            return true;
          case 'left':
          case 'prev':
            go(index - 1);
            return true;
          case 'enter':
          case 'playpause':
            if (item.video) toggleVideo();
            else setPlaying(!playing);
            return true;
          case 'play':
            if (item.video) { if (video.paused) toggleVideo(); } else if (!playing) setPlaying(true);
            return true;
          case 'pause':
          case 'stop':
            if (item.video) { if (!video.paused) toggleVideo(); } else if (playing) setPlaying(false);
            return true;
          case 'ff':
            if (item.video) video.currentTime = Math.min(video.currentTime + 10, video.duration || 0);
            else go(index + 1);
            return true;
          case 'rew':
            if (item.video) video.currentTime = Math.max(video.currentTime - 10, 0);
            else go(index - 1);
            return true;
          case 'up':
            infoPinned = true;
            flashInfo();
            return true;
          case 'down':
            infoPinned = false;
            el.classList.remove('show-info');
            return true;
          case 'back':
            if (infoPinned) {
              infoPinned = false;
              el.classList.remove('show-info');
              return true;
            }
            return false;
          default:
            return false;
        }
      },
      destroy() {
        closed = true;
        clearTimeout(timer);
        clearTimeout(infoTimer);
        stopVideo();
        layers.forEach((layer) => layer.removeAttribute('src'));
        preloader.removeAttribute('src');
        if (onClose) onClose(index);
      },
    };
  }

  // ------------------------------------------------------------ settings

  function SettingsView(me) {
    const el = h('div', { class: 'itv-view itv-settings' });
    const list = h('div', { class: 'settings-list' });
    const rows = [];

    SETTING_DEFS.forEach((def) => {
      const value = h('div', { class: 'setting-value' });
      const row = h('div', { class: 'setting is-option is-focusable' }, [h('div', { class: 'setting-label', text: def.label }), value]);
      const current = () => {
        let found = 0;
        def.options.forEach((option, k) => { if (option[0] === settings[def.key]) found = k; });
        return found;
      };
      const render = () => { value.textContent = def.options[current()][1]; };
      render();
      rows.push({
        el: row,
        change(dir) {
          const next = def.options[(current() + dir + def.options.length) % def.options.length];
          settings[def.key] = next[0];
          store.set(SETTINGS_KEY, settings);
          render();
        },
      });
      list.appendChild(row);
    });

    list.appendChild(h('div', { class: 'settings-gap' }));
    [
      { label: 'Andere Server-Adresse eingeben', run: () => { location.href = LAUNCHER_URL + '?setup'; } },
      { label: 'Abmelden', confirm: 'Zum Abmelden nochmal OK drücken', run: logout },
    ].forEach((action) => {
      const row = h('div', { class: 'setting is-action is-focusable' }, [h('div', { class: 'setting-label', text: action.label }), h('div', { class: 'setting-value', text: '›' })]);
      rows.push({ el: row, action });
      list.appendChild(row);
    });

    const who = me.name ? me.name + (me.email ? ' (' + me.email + ')' : '') : me.email;
    const foot = 'Immich TV ' + VERSION + (server.version ? ' · Immich ' + server.version : '') + (who ? ' · angemeldet als ' + who : '');
    const scroller = h('div', { class: 'itv-scroll settings-wrap' }, [
      h('div', { class: 'settings-title', text: 'Einstellungen' }),
      list,
      h('div', { class: 'settings-foot', text: foot }),
    ]);
    el.appendChild(scroller);

    let focus = 0;
    let armed = null;
    function setFocus(i) {
      rows[focus].el.classList.remove('is-focused');
      focus = i;
      armed = null;
      rows[focus].el.classList.add('is-focused');
      ensureVisible(rows[focus].el, scroller);
    }
    rows[0].el.classList.add('is-focused');

    return {
      el,
      onKey(key) {
        const row = rows[focus];
        if (key === 'up' || key === 'down') {
          const next = focus + (key === 'down' ? 1 : -1);
          if (next >= 0 && next < rows.length) setFocus(next);
          return true;
        }
        if ((key === 'left' || key === 'right') && row.change) {
          row.change(key === 'left' ? -1 : 1);
          return true;
        }
        if (key === 'enter') {
          if (row.change) {
            row.change(1);
          } else if (row.action.confirm && armed !== row) {
            armed = row;
            toast(row.action.confirm);
          } else {
            row.action.run();
          }
          return true;
        }
        return false;
      },
    };
  }

  // ------------------------------------------------------- immich client

  function mount(me) {
    if (ui.root) return;
    document.documentElement.classList.add('itv-active');
    ui.root = h('div', { id: 'itv' });
    ui.toastEl = h('div', { class: 'itv-toast' });
    ui.root.appendChild(ui.toastEl);
    document.documentElement.appendChild(ui.root);
    pushView(HomeView(me));
    setInterval(tickClocks, 10000);
  }

  // Shows a hint on Immich's login page and mounts once the login succeeded.
  function waitForLogin() {
    const banner = h('div', { id: 'itv-login-hint', text: 'Immich TV: Bitte melde dich einmal an – danach startet die TV-Ansicht automatisch.' });
    document.documentElement.appendChild(banner);
    const poll = setInterval(() => {
      api('/users/me').then((me) => {
        clearInterval(poll);
        banner.remove();
        mount(me);
      }, noop);
    }, 3000);
  }

  function startClient() {
    // Only take over pages that really belong to an Immich server. A proxy
    // answering 5xx (or no answer at all) means the server is down.
    return fetch('/api/server/ping', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json().catch(() => null) : { status: res.status }), () => ({ status: 0 }))
      .then((ping) => {
        if (!ping || ping.res !== 'pong') {
          const tizenBrewService = location.port === '8081' && /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
          if (ping && (ping.status === 0 || ping.status >= 500) && !tizenBrewService) showUnreachable();
          return;
        }
        injectStyles();
        window.addEventListener('keydown', handleKey, true);
        window.addEventListener('keyup', handleKey, true);
        return api('/server/version').then((v) => {
          server.version = v.major + '.' + v.minor + '.' + v.patch;
          server.legacy = v.major === 1 && v.minor < 133;
        }, noop).then(() => api('/users/me')).then(mount, waitForLogin);
      });
  }

  // ------------------------------------------------------------ launcher

  function startLauncher() {
    injectStyles();
    document.documentElement.classList.add('itv-active');
    const saved = store.get(SERVER_KEY, '');
    const box = h('div', { class: 'launch' });
    document.documentElement.appendChild(h('div', { id: 'itv', class: 'itv-launcher' }, box));

    let mode = '';
    let countdown = 0;
    let input = null;
    let button = null;
    let errorEl = null;

    function header(text) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'launch-logo', html: ICONS.logo }));
      box.appendChild(h('div', { class: 'launch-title', text: 'Immich TV' }));
      box.appendChild(h('div', { class: 'launch-text', text }));
    }

    function leave() {
      clearTimeout(countdown);
      leaveModule(() => {
        const text = box.querySelector('.launch-text');
        if (text) text.textContent = 'Zum Beenden die Home-Taste drücken';
      });
    }

    function showCountdown() {
      mode = 'countdown';
      header('Verbinde mit ' + saved + ' …');
      box.appendChild(h('div', { class: 'launch-bar' }, h('div')));
      box.appendChild(h('div', { class: 'launch-hint', text: 'OK: Adresse ändern · Zurück: TizenBrew' }));
      countdown = setTimeout(() => { location.href = saved + '/'; }, 1600);
    }

    function showForm() {
      mode = 'form';
      clearTimeout(countdown);
      header('Wie lautet die Adresse deines Immich-Servers?');
      input = h('input', { class: 'launch-input', type: 'url', value: saved || 'http://', spellcheck: 'false', autocomplete: 'off' });
      button = h('div', { class: 'launch-button', text: 'Verbinden' });
      errorEl = h('div', { class: 'launch-error' });
      box.appendChild(input);
      box.appendChild(h('div', { class: 'launch-hint', text: 'Zum Beispiel http://192.168.0.50:2283 · danach mit ▼ zu „Verbinden“ · Zurück: TizenBrew' }));
      box.appendChild(errorEl);
      box.appendChild(button);
      input.focus();
    }

    function connect() {
      let raw = input.value.trim();
      if (!raw || /^https?:\/\/$/i.test(raw)) {
        errorEl.textContent = 'Bitte gib zuerst die Adresse ein.';
        return;
      }
      if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
      let url;
      try {
        url = new URL(raw);
      } catch (e) {
        errorEl.textContent = 'Das sieht nicht nach einer Adresse aus.';
        return;
      }
      // A bare IP without port almost always means Immich's default port.
      if (url.protocol === 'http:' && !url.port && /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) url.port = '2283';
      const target = url.origin;
      store.set(SERVER_KEY, target);
      location.href = target + '/';
    }

    window.addEventListener('keydown', (e) => {
      const key = keyOf(e);
      if (mode === 'countdown') {
        if (key === 'enter' || key === 'back') e.preventDefault();
        if (key === 'enter') showForm();
        else if (key === 'back') leave();
        return;
      }
      // Typing, the on-screen keyboard and OK stay with the input field; only
      // the remote's Back key (not Backspace) leaves from there.
      if (document.activeElement === input) {
        if (key === 'down') {
          e.preventDefault();
          input.blur();
          button.classList.add('is-focused');
        } else if (isTvBack(e)) {
          e.preventDefault();
          leave();
        }
        return;
      }
      if (!key) return;
      e.preventDefault();
      if (key === 'up') {
        button.classList.remove('is-focused');
        input.focus();
      } else if (key === 'enter') {
        connect();
      } else if (key === 'back') {
        leave();
      }
    }, true);

    // Coming back (Back key, or Immich unreachable) shows the form instead of
    // jumping straight to the same server again.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) showForm();
    });
    const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    const cameBack = nav && nav.type === 'back_forward';
    if (saved && !cameBack && !/[?&]setup\b/.test(location.search)) showCountdown();
    else showForm();
  }

  // The server is off or unreachable: the browser's error page, or a proxy's.
  function showUnreachable() {
    injectStyles();
    document.documentElement.classList.add('itv-active');
    const text = h('div', { class: 'launch-text', text: 'Ist der Server an und im selben Netz?' });
    document.documentElement.appendChild(h('div', { id: 'itv', class: 'itv-launcher' }, h('div', { class: 'launch' }, [
      h('div', { class: 'launch-logo', html: ICONS.logo }),
      h('div', { class: 'launch-title', text: 'Immich ist nicht erreichbar' }),
      text,
      h('div', { class: 'launch-hint', style: 'margin-top: 2.4rem', text: 'OK: Adresse prüfen oder neu verbinden · Zurück: TizenBrew' }),
    ])));
    window.addEventListener('keydown', (e) => {
      const key = keyOf(e);
      if (key !== 'enter' && key !== 'back') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (key === 'enter') location.href = LAUNCHER_URL + '?setup';
      else leaveModule(() => { text.textContent = 'Zum Beenden die Home-Taste drücken'; });
    }, true);
  }

  // ---------------------------------------------------------------- start

  if (location.href.indexOf('chrome-error:') === 0) {
    onReady(showUnreachable);
  } else if (/^https?:$/.test(location.protocol)) {
    if (/\/start\.html$/.test(location.pathname)) onReady(startLauncher);
    else onReady(() => startClient().catch((err) => console.error('[Immich TV]', err)));
  }
})();
