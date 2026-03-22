/**
 * Test 1 – Network Layer
 *
 * Checks every external host that SkyCoup needs:
 *   • PeerJS signaling server  (0.peerjs.com)
 *   • Google STUN servers
 *   • OpenRelay TURN servers
 *
 * Uses only Node built-ins – no npm install required.
 */

'use strict';

const net  = require('net');
const dns  = require('dns').promises;
const https = require('https');
const http  = require('http');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  console.log(`  ✅  ${name}`);
  passed++;
}

function fail(name, reason) {
  console.log(`  ❌  ${name}: ${reason}`);
  failed++;
  failures.push({ name, reason });
}

/** TCP connect with timeout (ms). Returns true on success. */
function tcpConnect(host, port, timeoutMs = 5000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('error',   () => done(false));
    sock.on('timeout', () => done(false));
    sock.connect(port, host);
  });
}

/** HTTP/HTTPS GET with timeout. Returns { status, body }. */
function httpGet(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, res => {
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
  console.log(' Test 1 – Network Connectivity');
  console.log('══════════════════════════════════════════════\n');

  // ── 1. DNS resolution ─────────────────────────────────────────
  console.log('── DNS resolution ───────────────────────────');
  const hosts = [
    '0.peerjs.com',
    'stun.l.google.com',
    'stun1.l.google.com',
    'standard.relay.metered.ca',
  ];
  for (const h of hosts) {
    try {
      const addrs = await dns.resolve4(h);
      ok(`DNS ${h}  →  ${addrs[0]}`);
    } catch (e) {
      fail(`DNS ${h}`, e.code ?? e.message);
    }
  }

  // ── 2. PeerJS signaling server ────────────────────────────────
  console.log('\n── PeerJS signaling server (0.peerjs.com) ──');

  // Health endpoint
  const peerHealth = await httpGet('https://0.peerjs.com');
  if (peerHealth.status > 0) {
    ok(`HTTP GET 0.peerjs.com  →  HTTP ${peerHealth.status}`);
  } else {
    fail('HTTP GET 0.peerjs.com', 'no response');
  }

  // The PeerJS server exposes a /id endpoint to verify it's up
  const peerId = await httpGet('https://0.peerjs.com/peerjs/id');
  if (peerId.status === 200) {
    ok(`/peerjs/id endpoint  →  "${peerId.body.trim().slice(0, 20)}…"`);
  } else {
    fail('/peerjs/id endpoint', `HTTP ${peerId.status}`);
  }

  // TCP port 443
  const peerTcp = await tcpConnect('0.peerjs.com', 443);
  peerTcp ? ok('TCP 0.peerjs.com:443') : fail('TCP 0.peerjs.com:443', 'refused/timeout');

  // ── 3. Google STUN servers ────────────────────────────────────
  console.log('\n── Google STUN servers (UDP 19302 / TCP 3478) ──');
  // STUN uses UDP – we can't truly test UDP from Node easily,
  // but TCP reachability on port 3478 is a good proxy.
  for (const h of ['stun.l.google.com', 'stun1.l.google.com']) {
    const tcp = await tcpConnect(h, 3478);
    tcp ? ok(`TCP ${h}:3478`) : fail(`TCP ${h}:3478`, 'refused/timeout');
  }

  // ── 4. OpenRelay TURN servers ─────────────────────────────────
  console.log('\n── OpenRelay TURN servers (standard.relay.metered.ca) ──');
  const turnChecks = [
    { port: 80,  proto: 'TCP' },
    { port: 443, proto: 'TCP' },
  ];
  for (const { port } of turnChecks) {
    const result = await tcpConnect('standard.relay.metered.ca', port);
    result
      ? ok(`TCP standard.relay.metered.ca:${port}`)
      : fail(`TCP standard.relay.metered.ca:${port}`, 'refused/timeout');
  }

  // Also check HTTP on port 80 to see if it responds at all
  const turnHttp = await httpGet('http://standard.relay.metered.ca/');
  if (turnHttp.status > 0) {
    ok(`HTTP standard.relay.metered.ca  →  ${turnHttp.status}`);
  } else {
    fail('HTTP standard.relay.metered.ca', 'no response');
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
