/**
 * Cache-key guard for functions/api/_edge-cache.js.
 *
 * The edge cache sits in front of financial figures. If two different questions
 * ever mapped to the same key, a reader would be handed one question's answer
 * under the other's label — input prices shown as output, usage-weighted shown
 * as model-day — with no error anywhere, because every response involved is a
 * perfectly healthy 200. Nothing downstream would notice. So the key rules are
 * pinned here as plain logic, with no network and no Workers runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeCacheKey, schemaCacheKey } from '../_edge-cache.js';

const BASE = 'https://ai-compute-pricing.pages.dev/api/provider-pricing-matrix';
const key = (qs, params) => edgeCacheKey(new Request(`${BASE}?${qs}`), params).url;

test('metric is in the key — input and output prices never share an entry', () => {
  assert.notEqual(
    key('metric=input&weight=equal', { metric: 'input', weight: 'equal' }),
    key('metric=output&weight=equal', { metric: 'output', weight: 'equal' }),
  );
});

test('weight is in the key — model-day and usage-weighted never share an entry', () => {
  assert.notEqual(
    key('metric=input&weight=equal', { metric: 'input', weight: 'equal' }),
    key('metric=input&weight=usage', { metric: 'input', weight: 'usage' }),
  );
});

test('all four metric x weight combinations get four distinct keys', () => {
  const keys = new Set();
  for (const metric of ['input', 'output'])
    for (const weight of ['equal', 'usage'])
      keys.add(key(`metric=${metric}&weight=${weight}`, { metric, weight }));
  assert.equal(keys.size, 4);
});

test('the client cache-buster is NOT in the key — it does not change the body', () => {
  // If b= reached the key, every distinct value a caller chose would miss and
  // start another ~35 MB upstream fan-out.
  const params = { metric: 'input', weight: 'equal' };
  assert.equal(
    key('metric=input&weight=equal&b=aaaa1111', params),
    key('metric=input&weight=equal&b=zzzz9999&v=5965616', params),
  );
});

test('a parameter the caller did not declare cannot leak into the key', () => {
  // The key is built from the declared params only — not from the raw query.
  const k = key('metric=input&weight=equal&attacker=1', { metric: 'input', weight: 'equal' });
  assert.ok(!k.includes('attacker'), `undeclared parameter leaked into key: ${k}`);
});

test('parameter order does not split one question across two entries', () => {
  assert.equal(
    edgeCacheKey(new Request(BASE), { metric: 'input', weight: 'usage' }).url,
    edgeCacheKey(new Request(BASE), { weight: 'usage', metric: 'input' }).url,
  );
});

test('the key is a bare GET, so no method or header of the caller folds in', () => {
  const req = new Request(`${BASE}?metric=input`, { method: 'GET', headers: { 'X-Anything': '1' } });
  const k = edgeCacheKey(req, { metric: 'input' });
  assert.equal(k.method, 'GET');
  assert.equal(k.headers.get('X-Anything'), null);
});

test('a handler-private copy of a payload is versioned with the main entry', () => {
  // The GPU listing's last-good fallback is a copy of the cached payload. Keyed
  // on its path alone, it was out of reach of every CACHE_SCHEMA bump and could
  // hand back the previous shape whenever the source refused.
  const main = new URL(edgeCacheKey(new Request(BASE), {}).url).searchParams.get('__schema');
  const priv = new URL(schemaCacheKey(BASE + '?b=zzzz&attacker=1', '/__gpu-listing-last-good').url);
  assert.ok(main, 'edgeCacheKey must carry a schema');
  assert.equal(priv.searchParams.get('__schema'), main);
  assert.equal(priv.pathname, '/__gpu-listing-last-good');
  // Nothing from the caller's URL reaches the key.
  assert.deepEqual([...priv.searchParams.keys()], ['__schema']);
});
