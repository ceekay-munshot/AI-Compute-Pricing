/**
 * This dashboard is a read-only consumer of google-dash's KV namespace.
 *
 * Two deployments writing one namespace corrupts `index:days` and breaks BOTH
 * dashboards, so google-dash must stay its sole writer. That guarantee was
 * previously carried by prose: a comment in each copied endpoint, plus one test
 * that inspected a single file (functions/__tests__/embed-routes.test.mjs,
 * which reads only ppt-api/[[path]].js). Meanwhile openrouter-model-usage.js
 * still contained a complete captureNow() with two live kv.put calls — dead
 * only because nothing happened to call it.
 *
 * This walks every Function in the repo instead. Cache API writes are the one
 * legitimate .put: functions/api/_edge-cache.js stores responses in
 * caches.default, which is a per-PoP HTTP cache, not the shared KV store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FUNCTIONS = join(fileURLToPath(new URL('../../', import.meta.url)));

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...jsFiles(p)); continue; }
    if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** `.put(` calls whose receiver is not a Cache API handle. */
function kvPuts(src) {
  const hits = [];
  const re = /([A-Za-z_$][\w$.]*)\s*\.\s*put\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const receiver = m[1];
    const tail = receiver.split('.').pop();
    if (tail === 'cache' || tail === 'caches' || tail === 'default') continue;
    hits.push(m[0]);
  }
  return hits;
}

const FILES = jsFiles(FUNCTIONS);

test('the Functions tree contains no KV write', () => {
  assert.ok(FILES.length > 20, 'expected to walk the whole Functions tree, saw ' + FILES.length);
  const offenders = [];
  for (const f of FILES) {
    const hits = kvPuts(readFileSync(f, 'utf8'));
    if (hits.length) offenders.push(relative(FUNCTIONS, f) + ' → ' + hits.join(', '));
  }
  assert.deepEqual(offenders, [],
    'A Function writes to a binding. google-dash is the sole writer of the shared\n' +
    'HISTORY_KV namespace; a second writer corrupts index:days and breaks both\n' +
    'dashboards. If this is a Cache API write, name the handle `cache`.');
});

test('the endpoints that upstream writes from still expose no POST handler', () => {
  const WRITERS = [
    'api/openrouter-chart-weekly.js',   // upstream: POST ?capture=1 banks a week
    'api/openrouter-model-usage.js',    // upstream: GET does a read-through capture
  ];
  for (const rel of WRITERS) {
    const src = readFileSync(join(FUNCTIONS, rel), 'utf8');
    assert.doesNotMatch(src, /export\s+(async\s+)?function\s+onRequestPost\b/,
      rel + ' exports onRequestPost. Upstream writes from this route; here it must not exist.');
  }
});

test('the refresh endpoint that writes day:* upstream is not deployed here', () => {
  const present = FILES.map(f => relative(FUNCTIONS, f));
  assert.ok(
    !present.some(p => p.includes('gpu-hardware-pricing-history-refresh')),
    'api/gpu-hardware-pricing-history-refresh is deployed. A GET on it writes day:* ' +
    'and index:days upstream; it must not exist in this repo.'
  );
});
