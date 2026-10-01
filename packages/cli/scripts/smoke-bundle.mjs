#!/usr/bin/env node
// Smoke-test the built CLI bundle without touching the npm registry.
//
// `pnpm test:pack` is the release gate, but it runs `npm audit`, which fails on
// registries that do not implement the audit endpoint and on advisories in
// pre-existing dependencies. Neither says anything about whether the bundle
// actually boots, which is the failure this script exists to catch: a CJS
// dependency reaching for `require()` inside the single-file ESM bundle dies at
// startup with `Dynamic require of "net" is not supported`.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { get } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const entry = resolve(distDir, 'index.js');
const port = 11500 + Math.floor(Math.random() * 400);

if (!existsSync(entry)) {
  console.error(`missing ${entry}; run "pnpm --filter freemodelfinder build" first`);
  process.exit(1);
}

const probe = (path) =>
  new Promise((finish) => {
    get({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => finish(res.statusCode));
    }).on('error', (error) => finish(`ERROR ${error.message}`));
  });

const child = spawn(process.execPath, [entry, 'serve', '--port', String(port)], {
  cwd: distDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`✗ ${message}`);
};

await new Promise((r) => setTimeout(r, 7000));

if (child.exitCode !== null) {
  fail(`bundle exited during startup with code ${child.exitCode}`);
  console.error(stderr.slice(0, 2000));
} else {
  if (stderr !== '') fail(`bundle wrote to stderr:\n${stderr.slice(0, 2000)}`);
  for (const path of ['/healthz', '/v1/models']) {
    const status = await probe(path);
    if (status !== 200) fail(`${path} responded ${status}`);
    else console.log(`✓ ${path} -> 200`);
  }
  if (!stdout.includes('Server listening')) fail('startup banner missing from stdout');
}

child.kill('SIGTERM');
await once(child, 'exit');

if (failed) {
  console.error('bundle smoke test failed');
  process.exit(1);
}
console.log('bundle smoke test passed');
