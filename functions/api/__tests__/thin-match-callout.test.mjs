/**
 * A headline must not carry more confidence than the table it came from.
 *
 * Until this run, a price change computed over under half a provider's lineup
 * was REFUSED, so it could never reach a callout. Publishing it was the right
 * call — it is a correct like-for-like figure and blanking it hid a real
 * number. But it arrived in the callouts stripped of the caveat the matrix
 * renders beside it.
 *
 * The failure: a provider whose change rests on 5 of 18 models gets crowned
 * "Biggest price cut · -31.2% input" as a headline chip, while the same figure
 * one tab away appears in lighter type under "5 of 18 models like-for-like".
 * Same number, two confidence levels — and the chip is the one a reader quotes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../pricing-share-signal.js';

const matrix = () => ({
  success: true,
  quarters: [
    { quarter: '2026-Q2', cells: [
      { slug: 'anthropic', avg: 4.0, avgLabel: '$4.00', qoq: 0.0, modelCount: 18 },
      { slug: 'openai', avg: 2.5, avgLabel: '$2.50', qoq: 0.0, modelCount: 10 },
    ] },
    { quarter: '2026-Q3', cells: [
      // A real like-for-like cut, but over 5 of 18 models.
      { slug: 'anthropic', avg: 2.75, avgLabel: '$2.75', qoq: -0.312,
        qoqLowMatchedShare: true, qoqMatchedModels: 5, qoqLineupModels: 18, modelCount: 18 },
      // A full-lineup comparison, for contrast.
      { slug: 'openai', avg: 2.45, avgLabel: '$2.45', qoq: -0.02,
        qoqMatchedModels: 10, qoqLineupModels: 10, modelCount: 10 },
    ] },
  ],
});

const mk = (m, a, o) => Array.from({ length: 30 }, (_, i) => ({
  date: '2026-' + m + '-' + String(i + 1).padStart(2, '0'),
  or: [{ rank: 1, provider: 'anthropic', tokRaw: a }, { rank: 2, provider: 'openai', tokRaw: o }],
}));
const history = () => ({ success: true, snapshots: [...mk('05', 40, 60), ...mk('08', 55, 45)] });

async function run() {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes('provider-pricing-matrix')
    ? new Response(JSON.stringify(matrix()), { status: 200 })
    : new Response(JSON.stringify(history()), { status: 200 });
  try {
    const res = await onRequestGet({ request: new Request('https://x.test/api/pricing-share-signal'), env: {} });
    return await res.json();
  } finally { globalThis.fetch = real; }
}

test('the row carries what a thin change rests on', async () => {
  const d = await run();
  const q = (d.quarters || []).find(x => x.quarter === '2026-Q3');
  assert.ok(q, 'expected a 2026-Q3 row set');
  const a = q.rows.find(r => r.slug === 'anthropic');
  assert.ok(a, 'anthropic missing');
  assert.equal(a.lowMatchedShare, true, 'the thin-match flag did not survive into the row');
  assert.equal(a.matchedModels, 5);
  assert.equal(a.lineupModels, 18);
});

test('a callout built on a thin match says so', async () => {
  const d = await run();
  const cut = (d.callouts || []).find(c => c.kind === 'biggest_price_cut');
  assert.ok(cut, 'no biggest_price_cut callout was produced');
  assert.equal(cut.slug, 'anthropic', 'fixture expects anthropic to be the deepest cut');
  assert.match(cut.detail, /5 of 18 models like-for-like/,
    'the chip presents a 5-of-18 figure with the confidence of a full-lineup one: ' + cut.detail);
});

test('a full-lineup callout is not cluttered with a caveat it does not need', async () => {
  // The caveat must be earned, not boilerplate — otherwise it stops carrying
  // information and readers learn to skip it.
  const d = await run();
  for (const c of d.callouts || []) {
    if (c.slug === 'openai') {
      assert.doesNotMatch(c.detail, /like-for-like/,
        'a complete comparison was captioned as though it were partial: ' + c.detail);
    }
  }
});
