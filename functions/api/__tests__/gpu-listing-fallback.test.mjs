/**
 * Guards for the GPU listing's last-good fallback.
 *
 * When getdeploying refuses the listing (it answers 403 to everything while it
 * is rate-limiting us), the endpoint serves the last listing that parsed,
 * marked stale, rather than an empty tab. Two ways that goes wrong, both of
 * which shipped:
 *
 *  - The fallback went through the edge cache like a fresh listing. withEdgeCache
 *    rewrote its short Cache-Control to the endpoint's 300 s and stored it, so
 *    after the source recovered, readers kept getting the old prices — with a
 *    frozen servedAt — for another five minutes.
 *  - The fallback copy was keyed by path alone, so a CACHE_SCHEMA bump abandoned
 *    every response entry but left the fallback free to hand back the pre-bump
 *    payload shape under the new code's labels.
 *
 * No network and no Workers runtime: fetch and caches.default are stand-ins, and
 * the cache stand-in does the one thing that matters — what put() stores,
 * match() hands back.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../gpu-hardware-pricing-data.js';
import { edgeCacheKey, withEdgeCache } from '../_edge-cache.js';

const ORIGIN = 'https://ai-compute-pricing.pages.dev';
const API_PATH = '/api/gpu-hardware-pricing-data';

// The current card layout: one median price per model, no range.
const LISTING_HTML =
  '<html><body>' +
  '<article data-gpu data-name="Nvidia H100" data-price="3.36" data-providers="54" data-segment="DATACENTER" data-vram="80">' +
  '<a href="/gpus/nvidia-h100">Nvidia H100</a></article>' +
  '</body></html>';

function memoryCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const e = store.get(req.url);
      return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
    },
    async put(req, resp) {
      store.set(req.url, { status: resp.status, headers: [...resp.headers], body: await resp.text() });
    },
  };
}

let cache;
let upstreamStatus;
const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;

beforeEach(() => {
  cache = memoryCache();
  globalThis.caches = { default: cache };
  upstreamStatus = 200;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://getdeploying.com/gpus') {
      return upstreamStatus === 200
        ? new Response(LISTING_HTML, { status: 200 })
        : new Response('refused', { status: upstreamStatus });
    }
    // Detail pages (board power) are irrelevant here; a miss leaves a blank cell.
    return new Response('', { status: 404 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.caches = realCaches;
});

// One reader request, with every waitUntil() settled before returning, so the
// next request sees whatever this one stored.
async function get() {
  const pending = [];
  const context = {
    request: new Request(ORIGIN + API_PATH + '?b=abc12345'),
    waitUntil: (p) => pending.push(p),
  };
  const resp = await onRequestGet(context);
  const body = await resp.json();
  await Promise.all(pending);
  return { resp, body };
}

const edgeEntries = () => [...cache.store.keys()].filter((k) => new URL(k).pathname === API_PATH);

// Simulate the 300 s edge entry running out, leaving the fallback copy in place.
function expireEdgeEntry() {
  for (const k of edgeEntries()) cache.store.delete(k);
}

test('a refused listing falls back to the last good one, marked stale, with its capture time', async () => {
  const first = await get();
  assert.equal(first.body.ok, true);
  assert.equal(first.body.stale, undefined);

  expireEdgeEntry();
  upstreamStatus = 403;
  const second = await get();

  assert.equal(second.resp.status, 200);
  assert.equal(second.body.stale, true);
  // The capture time is the original listing's, not the time of this request.
  assert.equal(second.body.fetchedAt, first.body.fetchedAt);
  assert.equal(second.body.rows[0].dailyPrice, 3.36);
});

test('a fallback listing is never stored in the edge cache', async () => {
  await get();
  expireEdgeEntry();
  upstreamStatus = 403;
  const { resp } = await get();

  assert.equal(resp.headers.get('Cache-Control'), 'private, max-age=60',
    'withEdgeCache rewrote the fallback\'s Cache-Control, which only happens when it stores it');
  assert.deepEqual(edgeEntries(), [], 'the fallback listing was put in the edge cache');
});

test('the first request after the source recovers gets current prices, not the fallback', async () => {
  await get();
  expireEdgeEntry();
  upstreamStatus = 403;
  const fallback = await get();
  assert.equal(fallback.body.stale, true);

  upstreamStatus = 200;
  const recovered = await get();
  assert.equal(recovered.body.stale, undefined, 'a stored fallback was replayed after the source recovered');
  assert.notEqual(recovered.body.fetchedAt, undefined);
  assert.equal(recovered.resp.headers.get('X-Edge-Cache'), 'MISS');
});

test('with no fallback to give, a refusal is an error and is not stored either', async () => {
  upstreamStatus = 403;
  const { resp, body } = await get();
  assert.equal(resp.status, 502);
  assert.equal(body.ok, false);
  assert.deepEqual(edgeEntries(), []);
});

test('the fallback copy is keyed by the cache schema, so a bump abandons it too', async () => {
  await get();
  const schema = new URL(edgeCacheKey(new Request(ORIGIN + API_PATH), {}).url).searchParams.get('__schema');
  const fallbackKeys = [...cache.store.keys()].filter((k) => new URL(k).pathname === '/__gpu-listing-last-good');
  assert.equal(fallbackKeys.length, 1);
  assert.equal(new URL(fallbackKeys[0]).searchParams.get('__schema'), schema);
});

test('withEdgeCache hands a private response back untouched and stores nothing', async () => {
  const pending = [];
  const context = { request: new Request(ORIGIN + '/api/anything'), waitUntil: (p) => pending.push(p) };
  const resp = await withEdgeCache(context, { params: {}, ttl: 300, browserTtl: 0 }, async () =>
    new Response('{}', { status: 200, headers: { 'Cache-Control': 'private, max-age=60' } }),
  );
  await Promise.all(pending);
  assert.equal(resp.headers.get('Cache-Control'), 'private, max-age=60');
  assert.equal(resp.headers.get('X-Edge-Cache'), null);
  assert.equal(cache.store.size, 0);
});
