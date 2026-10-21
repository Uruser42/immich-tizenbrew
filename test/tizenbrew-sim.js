// End-to-end checks in headless Chromium that inject the module the way
// TizenBrew does: via the DevTools protocol into every new page.
//
// Needs the mock servers (2399 normal, 2401 with MOCK_DOWN=1) and runs in the
// zenika/alpine-chrome:with-puppeteer image:
//   docker run --rm --network host -v "$PWD":/usr/src/app/it \
//     zenika/alpine-chrome:with-puppeteer node it/test/tizenbrew-sim.js
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const MODULE = fs.readFileSync(path.join(__dirname, '..', 'immich-tv.js'), 'utf8');
const BASE = 'http://localhost:2399';
const DOWN = 'http://localhost:2401';
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

// Each test gets a fresh profile, so saved addresses don't leak between tests.
async function newTv(browser) {
  const context = browser.createBrowserContext ? await browser.createBrowserContext() : await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  page.on('close', () => context.close().catch(() => {}));
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('pageerror', (err) => console.log('    [pageerror]', err.message));
  const cdp = await page.target().createCDPSession();
  await cdp.send('Runtime.enable');
  // The real TizenBrew menu is a local file the module ignores; the stand-in
  // shares the mock's origin, so keep the module out of it explicitly.
  const expression = "if (location.pathname !== '/tizenbrew.html') {\n" + MODULE + '\n}';
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (!context.auxData || !context.auxData.isDefault) return; // main world only
    cdp.send('Runtime.evaluate', { expression, contextId: context.id }).catch(() => {});
  });
  page.cdp = cdp;
  return page;
}

// On the TV, TizenBrew's menu is the first page of the app's history. A new
// Chromium tab starts with about:blank, so drop that before going on.
async function firstPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.cdp.send('Page.resetNavigationHistory');
}

// TizenBrew's menu stand-in forwards to `to`; extra query params reach the target page.
async function launch(page, to, extra) {
  await firstPage(page, BASE + '/tizenbrew.html?fwd=1200&to=' + encodeURIComponent(to) + (extra || ''));
}

const tvBack = (page) => page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'XF86Back', bubbles: true })));
const press = (page, key) => page.keyboard.press(key);
const where = (page) => page.evaluate(() => location.href).catch(() => '?');

async function expect(name, page, predicate, timeout) {
  try {
    await page.waitForFunction(predicate, { timeout: timeout || 6000 });
    console.log('  ok   ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + ' (at ' + (await where(page)) + ')');
  }
}

const inTizenBrew = () => location.pathname === '/tizenbrew.html';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  console.log('1. Erster Start: Adressfeld hat den Fokus, Zurück -> TizenBrew');
  let page = await newTv(browser);
  await launch(page, '/start.html');
  await expect('Launcher-Formular sichtbar', page, () => document.activeElement && document.activeElement.classList.contains('launch-input'));
  await tvBack(page);
  await expect('zurück im TizenBrew-Menü', page, inTizenBrew);
  await page.close();

  console.log('2. Gespeicherter Server: Zurück während des Countdowns -> TizenBrew');
  page = await newTv(browser);
  await launch(page, '/start.html', '&seed=' + encodeURIComponent(BASE));
  await expect('Countdown sichtbar', page, () => !!document.querySelector('#itv .launch-bar'));
  await press(page, 'Escape');
  await expect('zurück im TizenBrew-Menü', page, inTizenBrew);
  await page.close();

  console.log('3. Countdown -> Immich -> Album -> Foto, dann Zurück bis TizenBrew');
  page = await newTv(browser);
  await launch(page, '/start.html', '&seed=' + encodeURIComponent(BASE));
  await expect('Immich-Startseite geladen', page, () => !!document.querySelector('#itv .itv-home') && document.querySelectorAll('#itv .album').length > 0, 10000);
  await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect('Album-Raster offen', page, () => document.querySelectorAll('#itv .itv-grid .photo').length > 0);
  await press(page, 'Enter');
  await expect('Einzelansicht offen', page, () => !!document.querySelector('#itv .itv-viewer.is-active'));
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOTS, 'sim-viewer.png') });
  await press(page, 'Escape');
  await expect('zurück im Raster', page, () => !!document.querySelector('#itv .itv-grid.is-active'));
  await press(page, 'Escape');
  await expect('zurück auf der Startseite', page, () => !!document.querySelector('#itv .itv-home.is-active'));
  await press(page, 'Escape');
  await expect('zurück im TizenBrew-Menü', page, inTizenBrew);
  await page.close();

  console.log('4. Proxy meldet 502 (NAS aus): Hinweis, Zurück -> TizenBrew');
  page = await newTv(browser);
  await launch(page, '/start.html', '&seed=' + encodeURIComponent(DOWN));
  await expect('Hinweis „nicht erreichbar“', page, () => /nicht erreichbar/.test(document.body.parentNode.textContent), 10000);
  await tvBack(page);
  await expect('zurück im TizenBrew-Menü', page, inTizenBrew);
  await page.close();

  console.log('5. Server gar nicht erreichbar (Browser-Fehlerseite): Hinweis, Zurück -> TizenBrew');
  page = await newTv(browser);
  await launch(page, '/start.html', '&seed=' + encodeURIComponent('http://localhost:2499'));
  await expect('Hinweis auf der Fehlerseite', page, () => location.href.indexOf('chrome-error:') === 0 && /nicht erreichbar/.test(document.documentElement.textContent), 10000);
  await page.screenshot({ path: path.join(SHOTS, 'sim-error-page.png') });
  await tvBack(page);
  await expect('zurück im TizenBrew-Menü', page, inTizenBrew);
  await page.close();

  console.log('6. Ohne Verlauf (Modul direkt gestartet): App schließen oder Hinweis auf die Home-Taste');
  page = await newTv(browser);
  await firstPage(page, BASE + '/start.html');
  await expect('Launcher-Formular sichtbar', page, () => !!document.querySelector('#itv .launch-input'));
  console.log('       Verlaufslänge: ' + (await page.evaluate(() => history.length)));
  const closed = new Promise((resolve) => page.once('close', () => resolve('Fenster per window.close() geschlossen')));
  await tvBack(page);
  // A closing page makes waitForFunction throw; let `closed` win that race.
  const hint = page.waitForFunction(() => /Home-Taste/.test(document.documentElement.textContent), { timeout: 4000 })
    .then(() => 'Hinweis auf die Home-Taste angezeigt', () => sleep(1000).then(() => null));
  const outcome = await Promise.race([closed, hint]);
  if (outcome) console.log('  ok   ' + outcome);
  else {
    failures++;
    console.log('  FAIL weder geschlossen noch Hinweis (at ' + (await where(page)) + ')');
  }
  if (!page.isClosed()) await page.close();

  await browser.close();
  console.log(failures ? failures + ' Fehler' : 'Alle Checks bestanden');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
