#!/usr/bin/env node
// Diagnose whether opencode.ai connects reliably and whether IPv6 is the culprit.
//
//   docker cp scripts/diag-connect.mjs freemodelfinder:/tmp/diag-connect.mjs
//   docker exec freemodelfinder node /tmp/diag-connect.mjs
//
// Prints, in order:
//   1. whether the running bundle contains the first-byte-window fix
//   2. 40 auto-family connects (time + resolved family)
//   3. 40 IPv4-only connects (time + address)
//   4. the comparison — if auto-family times out but IPv4-only never does,
//      the IPv6 route is a black hole and that is the source of the 50% failures.
import { readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';

const COUNT = Number(process.env.DIAG_COUNT ?? 40);
const TIMEOUT_MS = 5000;

const entry = '/app/index.js';
if (existsSync(entry)) {
  const bundle = readFileSync(entry, 'utf8');
  console.log(`bundle ${entry}:`);
  console.log(`  has first-byte-window fix: ${bundle.includes('first byte timeout')}`);
  console.log(`  has old connect-only behaviour: ${!bundle.includes('first byte timeout')}`);
} else {
  console.log(`no ${entry} in this container (maybe not the fmf image)`);
}

const addresses = await new Promise((resolve, reject) =>
  dns.lookup('opencode.ai', { all: true }, (error, list) =>
    error ? reject(error) : resolve(list),
  ),
);
console.log('\nresolved opencode.ai:');
for (const entry2 of addresses) console.log(`  ${entry2.address}  (ipv${entry2.family})`);

function connect(family) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: 'opencode.ai', port: 443, family, timeout: TIMEOUT_MS });
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...outcome, ms: Date.now() - started, family });
    };
    socket.on('connect', () => done({ ok: true, address: socket.remoteAddress }));
    socket.on('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.on('error', (error) => done({ ok: false, error: error.code ?? error.message }));
  });
}

async function run(label, family, count) {
  console.log(`\n${label} (${count} connects, family=${family}, ${TIMEOUT_MS}ms cap):`);
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(await connect(family));
  const ok = rows.filter((r) => r.ok);
  const slow = ok.filter((r) => r.ms >= 3000);
  const errors = new Map();
  for (const r of rows) {
    if (!r.ok) errors.set(r.error, (errors.get(r.error) ?? 0) + 1);
  }
  const byFamily = new Map();
  for (const r of ok) byFamily.set(r.family, (byFamily.get(r.family) ?? 0) + 1);
  console.log(`  succeeded ${ok.length}/${rows.length}`);
  console.log(
    `  >3000ms: ${slow.length}   errors: ${[...errors].map(([k, v]) => `${k}×${v}`).join(' ') || 'none'}`,
  );
  console.log(`  by family: ${[...byFamily].map(([k, v]) => `ipv${k}=${v}`).join(' ') || 'n/a'}`);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  if (times.length) {
    console.log(
      `  ms p50=${times[Math.floor(times.length / 2)]} p90=${times[Math.floor(times.length * 0.9)]} max=${times[times.length - 1]}`,
    );
  }
  return rows;
}

const auto = await run('auto-family (0)', 0, COUNT);
const v4 = await run('ipv4-only (4)', 4, COUNT);

console.log('\n--- verdict ---');
const autoFail = auto.filter((r) => !r.ok).length;
const v4Fail = v4.filter((r) => !r.ok).length;
const autoV6 = auto.filter((r) => r.ok && r.address?.includes(':')).length;
console.log(`auto-family failures: ${autoFail}/${COUNT}, v4-only failures: ${v4Fail}/${COUNT}`);
console.log(`auto-family connects that landed on IPv6: ${autoV6}`);
if (autoFail > 0 && v4Fail === 0) {
  console.log('=> IPv6 is the culprit: v4-only never fails. Force IPv4 in the gateway.');
} else if (autoFail > 0 && v4Fail > 0) {
  console.log('=> even IPv4 fails; this is a general egress problem, not a family issue.');
} else {
  console.log(
    '=> no connect-phase failures observed this run; try DIAG_COUNT=200 for longer sampling.',
  );
}
