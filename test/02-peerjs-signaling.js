/**
 * Test 2 – PeerJS Signaling Server (WebSocket handshake)
 *
 * Opens a real WebSocket connection to 0.peerjs.com (the default
 * PeerJS cloud server) and verifies:
 *   1. The WS upgrade succeeds
 *   2. The server sends us an assigned peer ID
 *   3. We can request a specific custom ID (the format the app uses)
 *
 * Uses the ws npm package if available, otherwise falls back to
 * a raw HTTP-upgrade approach with Node's built-in http module.
 */

'use strict';

const https = require('https');
const http  = require('http');
const net   = require('net');
const crypto = require('crypto');

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

/**
 * Minimal WebSocket client (RFC 6455 opening handshake only).
 * Returns { success, firstMessage } where firstMessage is the
 * first text frame received from the server.
 */
function wsConnect(host, port, path, timeoutMs = 10000) {
  return new Promise(resolve => {
    const key = crypto.randomBytes(16).toString('base64');
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ success: false, firstMessage: null, error: 'timeout' });
    }, timeoutMs);

    const sock = net.createConnection({ host, port }, () => {
      const req = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      sock.write(req);
    });

    let buf = Buffer.alloc(0);
    let upgraded = false;
    let firstMsg = null;

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);

      if (!upgraded) {
        const str = buf.toString();
        if (!str.includes('\r\n\r\n')) return;
        if (!str.includes('101')) {
          clearTimeout(timer);
          sock.destroy();
          resolve({ success: false, firstMessage: null, error: `no 101: ${str.slice(0, 200)}` });
          return;
        }
        upgraded = true;
        // Strip HTTP headers from buf
        const idx = buf.indexOf('\r\n\r\n');
        buf = buf.slice(idx + 4);
      }

      // Try to parse first WebSocket text frame
      if (upgraded && !firstMsg && buf.length >= 2) {
        const byte0 = buf[0];
        const byte1 = buf[1];
        const opcode = byte0 & 0x0f;
        const masked  = (byte1 & 0x80) !== 0;
        let payloadLen = byte1 & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }

        if (masked) offset += 4;
        if (buf.length < offset + payloadLen) return;

        if (opcode === 1 /* text */) {
          firstMsg = buf.slice(offset, offset + payloadLen).toString('utf8');
        } else if (opcode === 2 /* binary */) {
          firstMsg = '<binary frame>';
        }

        clearTimeout(timer);
        sock.destroy();
        resolve({ success: true, firstMessage: firstMsg, error: null });
      }
    });

    sock.on('error', err => {
      clearTimeout(timer);
      resolve({ success: false, firstMessage: null, error: err.message });
    });
  });
}

/**
 * Make an HTTPS request to the PeerJS REST API.
 */
function httpsGet(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error',   () => resolve({ status: -1, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: '' }); });
  });
}

async function runTests() {
  console.log('\n══════════════════════════════════════════════');
  console.log(' Test 2 – PeerJS Signaling Server');
  console.log('══════════════════════════════════════════════\n');

  // ── REST API ──────────────────────────────────────────────────
  console.log('── REST API ─────────────────────────────────');

  const health = await httpsGet('https://0.peerjs.com/');
  health.status > 0
    ? ok('GET /', `HTTP ${health.status}`)
    : fail('GET /', 'no response');

  // Generate a random peer ID just like the server does
  const idRes = await httpsGet('https://0.peerjs.com/peerjs/id');
  if (idRes.status === 200) {
    ok('GET /peerjs/id', `assigned ID = "${idRes.body.trim().slice(0, 30)}"`);
  } else {
    fail('GET /peerjs/id', `HTTP ${idRes.status}`);
  }

  // Check peer listing endpoint
  const peersRes = await httpsGet('https://0.peerjs.com/peerjs/peers');
  if (peersRes.status === 200 || peersRes.status === 401) {
    ok('GET /peerjs/peers', `HTTP ${peersRes.status} (401 = auth required = server up)`);
  } else {
    fail('GET /peerjs/peers', `HTTP ${peersRes.status}`);
  }

  // ── WebSocket handshake ───────────────────────────────────────
  console.log('\n── WebSocket Connection ─────────────────────');

  // PeerJS WS path format: /peerjs?key=peerjs&id=<peerId>&token=<token>
  const testId  = `skycoup-test-${Date.now()}`;
  const token   = Math.random().toString(36).slice(2, 10);
  const wsPath  = `/peerjs?key=peerjs&id=${testId}&token=${token}`;

  // PeerJS server uses HTTPS/WSS on port 443
  const wsResult = await wsConnect('0.peerjs.com', 443, wsPath, 12000);

  if (wsResult.success) {
    ok('WSS handshake (101 Upgrade)', `first frame: ${JSON.stringify(wsResult.firstMessage?.slice(0, 80))}`);

    // PeerJS server sends {"type":"OPEN"} when peer is registered
    if (wsResult.firstMessage?.includes('"OPEN"')) {
      ok('Server sent OPEN message', 'peer registered successfully');
    } else {
      fail('Server OPEN message', `got: ${wsResult.firstMessage?.slice(0, 100)}`);
    }
  } else {
    fail('WSS handshake', wsResult.error);

    // Try plain WS on port 80 as fallback
    console.log('  ↳ Trying plain WS on port 80…');
    const wsPlain = await wsConnect('0.peerjs.com', 80, wsPath, 8000);
    if (wsPlain.success) {
      ok('WS (port 80) handshake');
    } else {
      fail('WS (port 80) handshake', wsPlain.error);
    }
  }

  // ── Custom peer ID (app format) ───────────────────────────────
  console.log('\n── Custom Peer ID (skycoup-XXXX format) ─────');

  const pin      = String(Math.floor(1000 + Math.random() * 9000));
  const hostId   = `skycoup-${pin}`;
  const hostToken = Math.random().toString(36).slice(2, 10);
  const hostPath  = `/peerjs?key=peerjs&id=${hostId}&token=${hostToken}`;

  const hostWs = await wsConnect('0.peerjs.com', 443, hostPath, 12000);
  if (hostWs.success) {
    ok(`Register host ID "${hostId}"`, `frame: ${JSON.stringify(hostWs.firstMessage?.slice(0, 60))}`);
    if (hostWs.firstMessage?.includes('"OPEN"')) {
      ok('Host peer registered with custom ID');
    } else if (hostWs.firstMessage?.includes('"ID-TAKEN"')) {
      fail('Host peer ID', 'ID already in use (try again – expected if another test just ran)');
    } else {
      fail('Host peer OPEN', `unexpected frame: ${hostWs.firstMessage?.slice(0, 80)}`);
    }
  } else {
    fail(`Register host ID "${hostId}"`, hostWs.error);
  }

  // ── Summary ───────────────────────────────────────────────────
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
