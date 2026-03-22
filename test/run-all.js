/**
 * SkyCoup – Full Multiplayer Test Suite
 *
 * Runs all three test modules in sequence and prints a final summary.
 *
 *   node test/run-all.js
 */

'use strict';

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   SkyCoup Multiplayer Connection Test Suite  ║');
  console.log('╚══════════════════════════════════════════════╝');

  const results = [];

  const tests = [
    { label: 'Network Layer',       mod: './01-network'           },
    { label: 'PeerJS Signaling',    mod: './02-peerjs-signaling'  },
    { label: 'Browser Integration', mod: './03-browser-connection'},
  ];

  for (const { label, mod } of tests) {
    try {
      const fn = require(mod);
      const ok = await fn();
      results.push({ label, ok });
    } catch (err) {
      console.error(`\n[ERROR] ${label}: ${err.stack}`);
      results.push({ label, ok: false });
    }
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║                 FINAL RESULTS                ║');
  console.log('╠══════════════════════════════════════════════╣');
  for (const { label, ok } of results) {
    const icon = ok ? '✅' : '❌';
    console.log(`║  ${icon}  ${label.padEnd(40)}║`);
  }
  console.log('╚══════════════════════════════════════════════╝\n');

  const allOk = results.every(r => r.ok);
  process.exit(allOk ? 0 : 1);
}

main();
