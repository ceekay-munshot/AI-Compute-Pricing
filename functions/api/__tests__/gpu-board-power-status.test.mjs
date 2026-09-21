/**
 * Guards for what a blank $/kW-hr cell is allowed to say, and for the cache
 * that decides it.
 *
 * Every blank in that column used to carry the same tooltip — "no rated board
 * power published for this card" — when most blanks were cards that had simply
 * not been read yet. The endpoint now reports one status per row, and these
 * cases pin the three things that status rests on:
 *
 *   - which failed reads describe the source's CONTENT (and may be remembered
 *     as "unpublished") versus which describe only that a read went wrong;
 *   - that a remembered "unpublished" stops taking a top-up slot, so six such
 *     models at the top of the fill order cannot starve every model below;
 *   - that a refusal or timeout is never remembered, and that a refusal stops
 *     the rest of the top-up instead of deepening the rate limit.
 *
 * No network: fetch and caches.default are replaced with in-memory fakes.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoardPower,
  absenceIsCacheable,
  boardPowerStatus,
  fetchBoardPower,
} from '../gpu-hardware-pricing-data.js';

const ldPage = (graph) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': graph,
  })}</script></head><body></body></html>`;

const product = (name, props, offerDescription = 'USD per GPU per hour, on-demand') => ({
  '@type': 'Product',
  name: name + ' Cloud GPU',
  offers: { '@type': 'AggregateOffer', description: offerDescription },
  additionalProperty: props,
});
const watts = (w) => [{ '@type': 'PropertyValue', name: 'Board power', value: w }];

/* ── readBoardPower: why a read produced nothing ── */

test('a card page with no board power is reported as no_board_power', () => {
  const html = ldPage([product('Nvidia T4', [{ '@type': 'PropertyValue', name: 'Memory', value: '16 GB' }])]);
  assert.deepEqual(readBoardPower(html, 'Nvidia T4'), { found: null, reason: 'no_board_power' });
});

test('a board power that is not a single wattage is also no_board_power', () => {
  const html = ldPage([product('Nvidia T4', watts('TBD'))]);
  assert.equal(readBoardPower(html, 'Nvidia T4').reason, 'no_board_power');
});

test('a card page whose price is not per GPU is reported as not_per_gpu', () => {
  const html = ldPage([product('Nvidia T4', watts('70 W'), 'USD per node per hour')]);
  assert.deepEqual(readBoardPower(html, 'Nvidia T4'), { found: null, reason: 'not_per_gpu' });
});

test('a card page for a different card is other_card, not a figure', () => {
  const html = ldPage([product('Nvidia H100 NVL', watts('400 W'))]);
  assert.deepEqual(readBoardPower(html, 'Nvidia H100'), { found: null, reason: 'other_card' });
});

test('a page with no Product at all is not_card_page — a challenge page looks like this', () => {
  assert.equal(readBoardPower('<html><title>Just a moment...</title></html>', 'Nvidia T4').reason, 'not_card_page');
  assert.equal(readBoardPower('<script type="application/ld+json">{ nope </script>', 'Nvidia T4').reason, 'not_card_page');
  // Site-wide structured data alone is not a card page either.
  assert.equal(readBoardPower(ldPage([{ '@type': 'WebSite' }, { '@type': 'Organization' }]), 'Nvidia T4').reason, 'not_card_page');
});

test('a readable figure comes back with no reason', () => {
  assert.deepEqual(readBoardPower(ldPage([product('Nvidia T4', watts('70 W'))]), 'Nvidia T4'), {
    found: { watts: 70, variant: null },
    reason: null,
  });
});

/* ── absenceIsCacheable: the one rule for what may be remembered ── */

test('only a verdict about the page content may be remembered', () => {
  for (const r of ['other_card', 'not_per_gpu', 'no_board_power']) {
    assert.equal(absenceIsCacheable(r), true, r);
  }
});

test('refusals, timeouts, errors and unrecognisable pages are never remembered', () => {
  // Remembering any of these would tell readers for a day that the source
  // publishes nothing, on the strength of a rate limit or a slow answer.
  for (const r of ['http_403', 'http_429', 'http_500', 'http_404', 'TimeoutError', 'AbortError',
                   'TypeError', 'fetch_error', 'not_card_page', '', null, undefined, 'something_new']) {
    assert.equal(absenceIsCacheable(r), false, String(r));
  }
});

/* ── boardPowerStatus ── */

const power = (over = {}) => ({ bySku: new Map(), unpublished: new Set(), failed: new Set(), ...over });
const row = (gpuModel, slug = 'x') => ({ gpuModel, detailUrl: slug ? 'https://getdeploying.com/gpus/' + slug : null });

test('status: known, unpublished, failed, pending, no_page', () => {
  const p = power({
    bySku: new Map([['A', { watts: 700, variant: null }]]),
    unpublished: new Set(['B']),
    failed: new Set(['C']),
  });
  assert.equal(boardPowerStatus(row('A'), p), 'known');
  assert.equal(boardPowerStatus(row('B'), p), 'unpublished');
  assert.equal(boardPowerStatus(row('C'), p), 'failed');
  assert.equal(boardPowerStatus(row('D'), p), 'pending');
  assert.equal(boardPowerStatus(row('E', null), p), 'no_page');
});

test('a card with no page is never described as waiting to be read', () => {
  // It never will be read, so "pending" would be a promise nothing keeps.
  assert.equal(boardPowerStatus(row('E', null), power()), 'no_page');
});

/* ── fetchBoardPower against fakes ── */

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;
let store, fetched, behave;

function fakeCache() {
  return {
    async match(req) {
      const e = store.get(req.url);
      return e ? new Response(e.body, { headers: e.headers }) : undefined;
    },
    async put(req, resp) {
      store.set(req.url, { body: await resp.text(), headers: Object.fromEntries(resp.headers) });
    },
  };
}

beforeEach(() => {
  store = new Map();
  fetched = [];
  behave = () => new Response('', { status: 500 });
  globalThis.caches = { default: fakeCache() };
  globalThis.fetch = async (url) => {
    const slug = String(url).split('/gpus/')[1];
    fetched.push(slug);
    return behave(slug);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realCaches === undefined) delete globalThis.caches; else globalThis.caches = realCaches;
});

// Eight models outside the strategic list, in fill order (most providers first).
const MODELS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const ROWS = MODELS.map((s, i) => ({
  gpuModel: 'Test ' + s.toUpperCase(),
  detailUrl: 'https://getdeploying.com/gpus/test-' + s,
  providerCount: 100 - i,
}));
const nameOf = (slug) => 'Test ' + slug.replace('test-', '').toUpperCase();

async function run() {
  const pending = [];
  const context = {
    request: new Request('https://dash.test/api/gpu-hardware-pricing-data?b=1'),
    waitUntil: (p) => pending.push(p),
  };
  const out = await fetchBoardPower(context, ROWS);
  await Promise.all(pending);
  const statuses = Object.fromEntries(ROWS.map(r => [r.gpuModel, boardPowerStatus(r, out)]));
  return { out, statuses };
}

const ttlOf = (slug) => {
  const e = store.get('https://dash.test/__board-power/' + slug);
  return e ? e.headers['cache-control'] : null;
};

test('an unpublished page is remembered for a day, a figure for a week', async () => {
  behave = (slug) => new Response(ldPage([product(nameOf(slug),
    slug === 'test-a' ? watts('700 W') : [])]));
  const { statuses } = await run();
  assert.equal(statuses['Test A'], 'known');
  assert.equal(statuses['Test B'], 'unpublished');
  assert.equal(ttlOf('test-a'), 'public, max-age=604800');
  assert.equal(ttlOf('test-b'), 'public, max-age=86400');
});

test('remembered unpublished models stop starving the models below them', async () => {
  // The six models at the top publish nothing; G and H do. Before negative
  // caching, every miss refetched A-F and G and H were never reached.
  behave = (slug) => new Response(ldPage([product(nameOf(slug),
    slug === 'test-g' || slug === 'test-h' ? watts('300 W') : [])]));

  const first = await run();
  assert.deepEqual(fetched, ['test-a', 'test-b', 'test-c', 'test-d', 'test-e', 'test-f']);
  assert.equal(first.statuses['Test G'], 'pending');

  fetched = [];
  const second = await run();
  assert.deepEqual(fetched, ['test-g', 'test-h'], 'the second miss must reach G and H');
  assert.equal(second.statuses['Test A'], 'unpublished');
  assert.equal(second.statuses['Test G'], 'known');
  assert.equal(second.statuses['Test H'], 'known');
});

test('a refusal is not remembered, and it stops the rest of the top-up', async () => {
  behave = () => new Response('Forbidden', { status: 403 });
  const { statuses, out } = await run();
  // One batch of three, then stop: the other three are not fired into a 403.
  assert.deepEqual(fetched, ['test-a', 'test-b', 'test-c']);
  assert.equal(statuses['Test A'], 'failed');
  assert.equal(statuses['Test D'], 'pending');
  assert.equal(store.size, 0, 'nothing may be cached on a refusal');
  assert.deepEqual(out.errors.map(e => e.error), ['http_403', 'http_403', 'http_403']);

  // Source recovered: the refused models are first in line again.
  behave = (slug) => new Response(ldPage([product(nameOf(slug), watts('250 W'))]));
  fetched = [];
  await run();
  assert.deepEqual(fetched.slice(0, 3), ['test-a', 'test-b', 'test-c']);
});

test('a timeout or an unrecognisable page is retried, never remembered', async () => {
  behave = (slug) => {
    if (slug === 'test-a') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return new Response('<html><title>Just a moment...</title></html>');
  };
  const { statuses } = await run();
  assert.equal(statuses['Test A'], 'failed');
  assert.equal(statuses['Test B'], 'failed');
  assert.equal(store.size, 0);
  // Neither is a refusal, so the top-up runs its full six.
  assert.equal(fetched.length, 6);
});
