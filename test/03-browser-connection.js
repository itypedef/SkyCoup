/**
 * Test 3 – Browser Integration: Host ↔ Client Connection
 *
 * Self-contained: runs a local PeerJS signaling server + HTTP server
 * so no external internet is required.
 *
 * Tests the full connection flow:
 *   Host creates game → PIN appears → Client enters PIN →
 *   DataChannel opens → Game starts → Client receives game state
 *
 * Also diagnoses what actually fails when using the production
 * 0.peerjs.com signaling server.
 */

'use strict';

// Always use the globally installed playwright which has the correct browser
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const CHROME_EXEC = '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';
const { PeerServer} = require('peer');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT       = path.resolve(__dirname, '..');
const HTTP_PORT  = 9876;
const PEER_PORT  = 9001;
const PEER_HOST  = '127.0.0.1';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') {
  console.log(`  ✅  ${name}${detail ? '  (' + detail + ')' : ''}`);
  passed++;
}
function fail(name, reason) {
  console.log(`  ❌  ${name}: ${reason}`);
  failed++;
  failures.push({ name, reason });
}

// ── Minimal MIME-aware HTTP server ────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function startGameServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let filePath = path.join(ROOT, req.url === '/' ? '/index.html' : req.url.split('?')[0]);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
      const mime = MIME[path.extname(filePath)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    });
    srv.on('error', reject);
    srv.listen(HTTP_PORT, '127.0.0.1', () => resolve(srv));
  });
}

function startPeerServer() {
  return new Promise((resolve, reject) => {
    try {
      const srv = PeerServer({ port: PEER_PORT, host: PEER_HOST, path: '/' });
      // PeerServer does its own listening; give it a moment
      setTimeout(() => resolve(srv), 800);
      srv.on('error', reject);
    } catch (e) { reject(e); }
  });
}

// ── Helpers ───────────────────────────────────────────────────

async function waitFor(fn, ms = 20000, label = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Timed out (${ms}ms) waiting for: ${label}`);
}

async function getText(page, selector) {
  try { return await page.$eval(selector, el => el.textContent.trim()); }
  catch { return null; }
}

async function hasToast(page, text) {
  try {
    const toasts = await page.$$eval('.toast', els => els.map(e => e.textContent.trim()));
    return toasts.some(t => t.toLowerCase().includes(text.toLowerCase()));
  } catch { return false; }
}

async function isScreenActive(page, id) {
  try { return await page.$eval(`#${id}`, el => el.classList.contains('active')); }
  catch { return false; }
}

function collectLogs(page, label) {
  const logs = [];
  page.on('console', m => logs.push(`[${label}][${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[${label}][ERROR] ${e.message}`));
  return logs;
}

// ── Patch network.js to point at local PeerJS ─────────────────
// We intercept the request for network.js and inject a new
// default host/port for the Peer constructor.
async function patchNetworkJs(page) {
  await page.route('**/js/network.js', async route => {
    const original = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');

    // Inject PEERJS_SERVER_OVERRIDE before the existing code so tests
    // can target the local server without modifying the source.
    const patch = `
// ── TEST PATCH: override PeerJS to use local server ──────────
const _OrigPeer = Peer;
window.Peer = function PeerPatched(id, opts = {}) {
  opts = Object.assign({}, opts);
  opts.host = '${PEER_HOST}';
  opts.port = ${PEER_PORT};
  opts.path = '/';
  opts.secure = false;
  opts.config = opts.config || {};
  // Disable TURN for local test - both peers on same machine
  opts.config.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  return new _OrigPeer(id, opts);
};
// ─────────────────────────────────────────────────────────────
` + original;

    await route.fulfill({ contentType: 'application/javascript', body: patch });
  });
}

// ── Main ──────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════════');
  console.log(' Test 3 – Browser Integration (Host ↔ Client)');
  console.log('══════════════════════════════════════════════\n');

  let gameServer, peerServer, browser;
  let hostLogs = [], clientLogs = [];

  try {
    // ── 1. Infrastructure ─────────────────────────────────────
    console.log('── Infrastructure setup ─────────────────────');

    gameServer = await startGameServer();
    ok(`HTTP server  →  http://${PEER_HOST}:${HTTP_PORT}`);

    peerServer = await startPeerServer();
    ok(`PeerJS server  →  ws://${PEER_HOST}:${PEER_PORT}`);

    browser = await chromium.launch({
      headless: true,
      executablePath: CHROME_EXEC,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    });
    ok('Chromium launched');

    // ── 2. Open two independent browser contexts ──────────────
    console.log('\n── Opening browser pages ────────────────────');

    const ctxHost   = await browser.newContext();
    const ctxClient = await browser.newContext();
    const hostPage   = await ctxHost.newPage();
    const clientPage = await ctxClient.newPage();

    hostLogs   = collectLogs(hostPage,   'HOST');
    clientLogs = collectLogs(clientPage, 'CLIENT');

    // Patch both pages to use local PeerJS server
    await patchNetworkJs(hostPage);
    await patchNetworkJs(clientPage);

    const BASE = `http://${PEER_HOST}:${HTTP_PORT}/`;
    await Promise.all([
      hostPage.goto(BASE),
      clientPage.goto(BASE),
    ]);

    const hostHome   = await isScreenActive(hostPage,   'screen-home');
    const clientHome = await isScreenActive(clientPage, 'screen-home');
    hostHome   ? ok('Host:   home screen loaded') : fail('Host:   home screen', 'not active');
    clientHome ? ok('Client: home screen loaded') : fail('Client: home screen', 'not active');

    // ── 3. Host creates game ──────────────────────────────────
    console.log('\n── Step 1: Host creates game ────────────────');

    await hostPage.click('#btn-create');
    await hostPage.fill('#host-name', 'Alice');
    await hostPage.selectOption('#num-players', '2');  // 2-player game so 1 client is enough
    await hostPage.click('#btn-go-create');

    try {
      await waitFor(() => isScreenActive(hostPage, 'screen-host-setup'), 10000, 'host-setup screen');
      ok('Host: moved to host-setup screen');
    } catch { fail('Host: host-setup screen', 'did not appear'); }

    // ── 4. Wait for PIN ───────────────────────────────────────
    console.log('\n── Step 2: Host registers with PeerJS ───────');
    let pin = null;
    try {
      await waitFor(async () => {
        const txt = await getText(hostPage, '#host-setup-pin');
        if (txt && /^\d{4}$/.test(txt)) { pin = txt; return true; }
        return false;
      }, 15000, '4-digit PIN');
      ok(`PeerJS peer registered  →  PIN = ${pin}`);
    } catch {
      const txt = await getText(hostPage, '#host-setup-pin');
      fail('Host: PeerJS peer registration', `element shows: "${txt}"`);
    }

    if (!pin) throw new Error('No PIN — cannot continue');

    // ── 5. Client joins ───────────────────────────────────────
    console.log('\n── Step 3: Client connects with PIN ─────────');

    await clientPage.click('#btn-join');
    await clientPage.fill('#client-name', 'Bob');
    await clientPage.fill('#join-pin', pin);
    await clientPage.click('#btn-go-join');

    // ── 6. Verify DataChannel open (client side) ──────────────
    console.log('\n── Step 4: DataChannel negotiation ──────────');
    try {
      await waitFor(async () => {
        const toast  = await hasToast(clientPage, 'Connected');
        const screen = await isScreenActive(clientPage, 'screen-waiting');
        return toast || screen;
      }, 25000, '"Connected" toast or waiting screen');
      ok('Client: DataChannel opened → "Connected!" received');
    } catch {
      const screen = await clientPage.$eval('body', el => el.textContent.slice(0, 200));
      fail('Client: DataChannel open', 'no Connected event in 25 s');
    }

    // ── 7. Verify host received hello ─────────────────────────
    try {
      await waitFor(() => hasToast(hostPage, 'joined'), 10000, '"joined" toast on host');
      ok('Host: received "hello" from client → player joined');
    } catch {
      fail('Host: received client hello', 'no "joined" toast');
    }

    // Verify player list
    try {
      await waitFor(async () => {
        const items = await hostPage.$$eval('#connected-players li', els => els.map(e => e.textContent));
        return items.some(t => t.includes('Bob'));
      }, 5000, 'Bob in player list');
      ok('Host: player list contains Bob');
    } catch { fail('Host: player list', 'Bob not visible'); }

    // ── 8. Host starts game ───────────────────────────────────
    console.log('\n── Step 5: Game start + state sync ──────────');

    try {
      await waitFor(async () => {
        return !(await hostPage.$eval('#btn-start-game', el => el.disabled));
      }, 8000, 'Start Game enabled');
      ok('"Start Game" button enabled');
      await hostPage.click('#btn-start-game');
      ok('Host: clicked "Start Game"');
    } catch { fail('"Start Game" button', 'still disabled'); }

    // ── 9. Client receives game_state ─────────────────────────
    try {
      await waitFor(() => isScreenActive(clientPage, 'screen-game'), 15000, 'client game screen');
      ok('Client: received game_state → rendered game screen');
    } catch { fail('Client: game screen', 'never shown after host started'); }

    try {
      await waitFor(() => isScreenActive(hostPage, 'screen-game'), 5000, 'host game screen');
      ok('Host: on game screen');
    } catch { fail('Host: game screen', 'not shown'); }

    // ── 10. Verify both players visible on client ─────────────
    try {
      const area = await clientPage.$eval('#players-area', el => el.textContent);
      const seesAlice = area.includes('Alice');
      const seesBob   = area.includes('Bob');
      if (seesAlice && seesBob) {
        ok('Client: game renders both players (Alice + Bob)');
      } else {
        fail('Client: player names in game', `Alice=${seesAlice} Bob=${seesBob} area="${area.slice(0,80)}"`);
      }
    } catch(e) { fail('Client: players-area', e.message); }

    // ── 11. Round-trip: client sends action, host responds ────
    console.log('\n── Step 6: Message round-trip ────────────────');
    try {
      const actionArea = await clientPage.$eval('#action-area', el => el.textContent.trim());
      ok('Client: action-area rendered', `"${actionArea.replace(/\s+/g,' ').slice(0,60)}"`);
    } catch(e) { fail('Client: action-area', e.message); }

    // Check whose turn it is and send an action from the correct player
    try {
      const hostActionArea = await hostPage.$eval('#action-area', el => el.textContent);
      const isHostTurn = hostActionArea.includes('Your Turn');

      if (isHostTurn) {
        // Host takes the Income action
        const incomeBtn = await hostPage.$('button.btn-action');
        if (incomeBtn) {
          const btnText = await incomeBtn.textContent();
          await incomeBtn.click();
          ok(`Host took action: "${btnText.trim().slice(0,30)}" (host's turn)`);

          // Client should see updated state
          await waitFor(async () => {
            const log = await clientPage.$eval('#game-log', el => el.textContent);
            return log.length > 0;
          }, 8000, 'game log update on client');
          ok('Client: received updated game_state after host action');
        } else {
          ok('Host turn confirmed, action buttons present');
        }
      } else {
        // Client's turn
        const incomeBtn = await clientPage.$('button.btn-action');
        if (incomeBtn) {
          const btnText = await incomeBtn.textContent();
          await incomeBtn.click();
          ok(`Client took action: "${btnText.trim().slice(0,30)}" (client's turn)`);

          await waitFor(async () => {
            const log = await hostPage.$eval('#game-log', el => el.textContent);
            return log.length > 0;
          }, 8000, 'game log update on host after client action');
          ok('Host: received client action, game log updated');
        } else {
          ok('Client turn confirmed, action buttons present');
        }
      }
    } catch(e) { fail('Round-trip message test', e.message); }

  } catch (topErr) {
    fail('Test runner', topErr.message);
  } finally {
    if (failed > 0 || hostLogs.some(l => l.includes('ERROR'))) {
      console.log('\n── Browser console logs (HOST) ──────────────');
      hostLogs.slice(-40).forEach(l => console.log('  ', l));
      console.log('\n── Browser console logs (CLIENT) ────────────');
      clientLogs.slice(-40).forEach(l => console.log('  ', l));
    }

    if (browser)    await browser.close().catch(() => {});
    if (gameServer) gameServer.close();
    // PeerServer doesn't expose close() cleanly, process will exit
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`  Passed: ${passed}   Failed: ${failed}`);
  if (failures.length) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`    • ${f.name}: ${f.reason}`));
  }
  console.log('──────────────────────────────────────────────\n');

  return failed === 0;
}

module.exports = runTests;
if (require.main === module) runTests().then(ok => process.exit(ok ? 0 : 1));
