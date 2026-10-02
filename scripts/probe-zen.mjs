#!/usr/bin/env node
// Probe opencode Zen anonymously, per model, using the exact request shape this
// project sends. Copy into a running container and run it:
//
//   docker cp scripts/probe-zen.mjs freemodelfinder:/tmp/probe-zen.mjs
//   docker exec freemodelfinder node /tmp/probe-zen.mjs
//
// opencode rejects anonymous traffic unless the User-Agent, the `ses_`-shaped
// session id and the agent tool block match what the real client sends, so this
// script mirrors packages/zen/src/{identity,gateway,protocol} instead of
// improvising headers. A 403 FreeTierError means the shape drifted.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';

const CATALOG = '/data/zen.models.catalog.json';
const ZEN = 'https://opencode.ai/zen';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 20_000);
const FULL_BODY = process.env.PROBE_FULL === '1';
const BODY_LIMIT = Number(process.env.PROBE_BODY ?? (FULL_BODY ? 4000 : 200));
const MODELS = (process.env.PROBE_MODELS ?? '').split(',').filter(Boolean);

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function canonicalSessionId(seed) {
  const digest = createHash('sha256').update(`ses\0${seed}`).digest();
  const timePart = digest.subarray(0, 6).toString('hex');
  let value = BigInt(`0x${digest.subarray(6, 16).toString('hex')}`);
  let out = '';
  for (let i = 0; i < 14; i += 1) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return `ses_${timePart}${out}`;
}

function baseHeaders(session) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': `opencode/1.18.31 (linux amd64; node${process.versions.node})`,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-request': `req_${randomUUID().replace(/-/g, '')}`,
    'x-opencode-project': '',
  };
}

const AGENT_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'];

function anonymousTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `Agent tool ${name}`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

const PATHS = {
  chat: '/v1/chat/completions',
  responses: '/v1/responses',
  anthropic: '/v1/messages',
};

function buildBody(protocol, model, { withTools }) {
  const tools = withTools ? AGENT_TOOLS.map(anonymousTool) : undefined;
  if (protocol === 'anthropic') {
    return {
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      ...(tools
        ? {
            tools: tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            })),
          }
        : {}),
    };
  }
  if (protocol === 'responses') {
    return {
      model,
      max_output_tokens: 64,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      ...(tools ? { tools } : {}),
    };
  }
  return {
    model,
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    stream_options: { include_usage: true },
    ...(tools ? { tools } : {}),
  };
}

function probe(protocol, model, withTools) {
  const url = `${ZEN}${PATHS[protocol]}`;
  const session = canonicalSessionId(`${model}:${protocol}:${withTools}`);
  const body = JSON.stringify(buildBody(protocol, model, { withTools }));
  const headers = { ...baseHeaders(session), 'content-length': Buffer.byteLength(body) };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = 'public';
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-beta'] =
      'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
  } else {
    headers['authorization'] = 'Bearer public';
  }

  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve({ protocol, model, withTools, ms: Date.now() - started, ...outcome });
    };
    const req = https.request(url, { method: 'POST', headers }, (res) => {
      let collected = '';
      res.on('data', (chunk) => {
        if (collected.length < BODY_LIMIT) collected += chunk.toString('utf8');
      });
      const done = () => {
        res.destroy();
        finish({ status: res.statusCode, first: collected.slice(0, BODY_LIMIT) });
      };
      res.on('end', done);
      res.on('close', () =>
        finish({ status: res.statusCode, first: collected.slice(0, BODY_LIMIT) }),
      );
    });
    req.on('error', (error) => finish({ error: `${error.code ?? ''} ${error.message}`.trim() }));
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      finish({ error: `TIMEOUT after ${TIMEOUT_MS}ms (no response headers)` });
    });
    req.end(body);
  });
}

function loadCatalog() {
  if (!existsSync(CATALOG)) return null;
  try {
    return JSON.parse(readFileSync(CATALOG, 'utf8'));
  } catch {
    return null;
  }
}

const catalog = loadCatalog();
const protocols = catalog?.native_protocols?.zen ?? {};
const targets = MODELS.length
  ? MODELS
  : (catalog?.zen ?? []).filter((id) => !catalog.unsupported?.zen?.[id]).slice(0, 6);

console.log(
  `catalog: ${catalog ? `${catalog.updated_at} (${Object.keys(protocols).length} protocol entries)` : 'MISSING'}`,
);
console.log(`probing ${targets.length} model(s), timeout ${TIMEOUT_MS}ms\n`);

for (const model of targets) {
  const protocol = protocols[model] ?? 'chat';
  for (const withTools of [true, false]) {
    const result = await probe(protocol, model, withTools);
    const tag = `${model} [${protocol}] tools=${withTools ? 'on ' : 'off'}`;
    if (result.error) {
      console.log(`✗ ${tag.padEnd(46)} ${result.error}`);
    } else if (FULL_BODY) {
      console.log(`✓ ${tag.padEnd(46)} status ${result.status} in ${result.ms}ms`);
      console.log(result.first);
    } else {
      console.log(
        `✓ ${tag.padEnd(46)} status ${result.status} in ${result.ms}ms  ${result.first.replace(/\s+/g, ' ').slice(0, 90)}`,
      );
    }
  }
}

console.log('\nonly models listed in MODELS env were probed when it is set');
