/**
 * Provider price change is like-for-like, not a lineup-mix artefact.
 *
 * The bug these exist to prevent: the read-through headlined "Biggest price
 * cut: Anthropic -10.4%" for 2026-Q3, and the matrix printed +55.9% for
 * 2026-Q2, with not one Anthropic model repriced. Each quarter averaged 18
 * models, but not the same 18 — four left the lineup and four joined, and the
 * fourteen priced in both quarters did not move. The provider's average moved
 * because its MIX changed.
 *
 * Measured on the live source on 2026-09-21, like-for-like: Anthropic 2026-Q3
 * QoQ is 0.0% over 14 of 18 models (was -10.4%), 2026-Q2 0.0% over 12 of 18
 * (was +55.9%), and its YoY matches only 5 of 18 models and is refused (was
 * +24.0%). The fixtures below are reduced to the cases that decide each rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as providerMatrix } from '../provider-pricing-matrix.js';
import { onRequestGet as readThrough } from '../pricing-share-signal.js';

const DAY = 86400000;
const days = (f, t) => {
  const o = [];
  for (let x = Date.parse(f + 'T00:00:00Z'); x <= Date.parse(t + 'T00:00:00Z'); x += DAY) o.push(new Date(x).toISOString().slice(0, 10));
  return o;
};
/** Upstream rows for one model: spans of [from, to, $/token input]. */
const hist = (model, spans) => spans.flatMap(([f, t, p]) =>
  days(f, t).map(d => ({ model, date: d + 'T00:00:00+00:00', pricing_prompt: p, pricing_completion: p * 5 })));

const S = '2026-04-01', E = '2026-09-20';
const Q2_END = '2026-06-30', Q3_START = '2026-07-01';
const SLUGS = ['openai', 'anthropic', 'google', 'xai', 'mistralai', 'deepseek', 'meta-llama', 'cohere'];

/** Mocked fetch: pricepertoken rows from `upstream`, the matrix and history for the read-through. */
function mockFetch(upstream, history) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname.includes('pricepertoken')) {
      // Every provider carries at least one row, so none is retried as empty.
      const slug = u.searchParams.get('provider');
      const rows = upstream[slug] || hist(slug + '-filler', [[S, S, 1e-6]]);
      return new Response(JSON.stringify({ results: rows }), { status: 200 });
    }
    if (u.pathname === '/api/provider-pricing-matrix') {
      return providerMatrix({ request: new Request(u.toString()), env: {}, waitUntil() {} });
    }
    if (u.pathname === '/api/history' && history) return new Response(JSON.stringify(history), { status: 200 });
    return new Response('null', { status: 404 });
  };
}

async function run(handler, path, upstream, history = null) {
  const realFetch = globalThis.fetch, realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = mockFetch(upstream, history);
  try { return await (await handler({ request: new Request('https://x.test' + path), env: {}, waitUntil() {} })).json(); }
  finally { globalThis.fetch = realFetch; globalThis.caches = realCaches; }
}

const matrix = (upstream) => run(providerMatrix, '/api/provider-pricing-matrix?metric=input', upstream);
const cellsOf = (d, quarter) => Object.fromEntries(d.quarters.find(q => q.quarter === quarter).cells.map(c => [c.slug, c]));

/* ── Entering and leaving models do not move the change ───────────────── */

test('a model listed or retired between quarters is not a price change', async () => {
  const d = await matrix({
    // No price moves at all. The priciest model retires at Q2's end and a
    // cheap one is listed at Q3's start, exactly the Anthropic pattern.
    anthropic: [
      ...hist('claude-a', [[S, E, 3e-6]]),
      ...hist('claude-b', [[S, E, 1.5e-5]]),
      ...hist('claude-c', [[S, E, 8e-7]]),
      ...hist('claude-old', [[S, Q2_END, 7.5e-5]]),
      ...hist('claude-new', [[Q3_START, E, 1e-6]]),
    ],
  });
  const q2 = cellsOf(d, '2026-Q2').anthropic, q3 = cellsOf(d, '2026-Q3').anthropic;
  // The level is still the whole lineup's average, and it really did fall...
  assert.equal(q2.avg, 23.45);
  assert.equal(q3.avg, 4.95);
  assert.equal(q3.modelCount, 4);
  assert.ok(q3.avg / q2.avg - 1 < -0.75, 'the lineup average moved a lot — the old QoQ read about -79%');
  // ...but no price did, and that is what the change says.
  assert.equal(q3.qoq, 0);
  assert.equal(q3.qoqLabel, '0.0%');
  assert.equal(q3.qoqMatchedModels, 3);
  assert.equal(q3.qoqTooFewMatched, undefined);
  assert.equal(q3.qoqMeasureChanged, undefined);
  assert.match(q3.qoqNote, /^Like-for-like: the 3 models priced in both Q2 2026 and Q3 2026/);
  assert.match(q3.qoqNote, /1 model priced only in Q3 2026 and 1 model priced only in Q2 2026 are left out of the change/);
});

test('a genuine price cut on a model priced in both quarters is still reported', async () => {
  const d = await matrix({
    // Same lineup churn, plus claude-b really cut from $15 to $12 per 1M.
    anthropic: [
      ...hist('claude-a', [[S, E, 3e-6]]),
      ...hist('claude-b', [[S, Q2_END, 1.5e-5], [Q3_START, E, 1.2e-5]]),
      ...hist('claude-c', [[S, E, 8e-7]]),
      ...hist('claude-old', [[S, Q2_END, 7.5e-5]]),
      ...hist('claude-new', [[Q3_START, E, 1e-6]]),
    ],
    // A cut mid-quarter is charged to the days it applied: 2026-Q3 runs 82
    // days to 2026-09-20 here, 31 of them after the cut.
    mistralai: [
      ...hist('mistral-large', [[S, '2026-08-20', 2e-6], ['2026-08-21', E, 1e-6]]),
      ...hist('mistral-small', [[S, E, 2e-7]]),
    ],
  });
  const q3 = cellsOf(d, '2026-Q3');
  // Ratio of the matched models' average prices: (3 + 12 + 0.8) / (3 + 15 + 0.8).
  assert.equal(q3.anthropic.qoq, Math.round((15.8 / 18.8 - 1) * 1000) / 1000);
  assert.equal(q3.anthropic.qoq, -0.16);
  assert.equal(q3.anthropic.qoqLabel, '-16.0%');
  assert.equal(q3.anthropic.qoqMatchedModels, 3);
  const large = (51 * 2 + 31 * 1) / 82;
  assert.equal(q3.mistralai.qoq, Math.round(((large + 0.2) / 2.2 - 1) * 1000) / 1000);
  assert.ok(q3.mistralai.qoq < 0);
  assert.match(q3.mistralai.qoqNote, /No model was added or dropped between them/);
});

/* ── Too few models priced in both: refused, with a reason ───────────── */

test('growth is refused when fewer than two models were priced in both quarters', async () => {
  const d = await matrix({
    cohere: [
      ...hist('command-keep', [[S, E, 2.5e-6]]),
      ...hist('command-old', [[S, Q2_END, 1e-5]]),
      ...hist('command-new', [[Q3_START, E, 5e-7]]),
    ],
  });
  const c = cellsOf(d, '2026-Q3').cohere;
  assert.equal(c.qoq, null);
  assert.equal(c.qoqLabel, null);
  assert.equal(c.qoqTooFewMatched, true);
  assert.equal(c.qoqMatchedModels, 1);
  assert.equal(c.qoqMeasureChanged, undefined, 'not a change of measure');
  assert.match(c.qoqReason, /^Not computed: only 1 of the 2 models priced in Q3 2026 was also priced in Q2 2026[.]/);
  assert.match(c.qoqReason, /one model's change is not the provider's/);
  assert.equal(c.avg, 1.5, 'the level is still published');
});

test('growth is refused when under half the lineup was priced in both, and computed at half', async () => {
  const d = await matrix({
    // 2 of 5 models in Q3 were priced in Q2: refused, even though one of them
    // genuinely halved — two survivors do not stand for a five-model lineup.
    xai: [
      ...hist('grok-a', [[S, Q2_END, 2e-6], [Q3_START, E, 1e-6]]),
      ...hist('grok-b', [[S, E, 3e-6]]),
      ...hist('grok-c', [[Q3_START, E, 2e-7]]),
      ...hist('grok-d', [[Q3_START, E, 3e-7]]),
      ...hist('grok-e', [[Q3_START, E, 4e-7]]),
    ],
    // 2 of 4: exactly half, computed.
    deepseek: [
      ...hist('ds-a', [[S, Q2_END, 1e-6], [Q3_START, E, 9e-7]]),
      ...hist('ds-b', [[S, E, 2e-6]]),
      ...hist('ds-c', [[Q3_START, E, 1e-7]]),
      ...hist('ds-d', [[Q3_START, E, 2e-7]]),
    ],
  });
  const q3 = cellsOf(d, '2026-Q3');
  assert.equal(q3.xai.qoq, null);
  assert.equal(q3.xai.qoqTooFewMatched, true);
  assert.equal(q3.xai.qoqMatchedModels, 2);
  assert.match(q3.xai.qoqReason, /only 2 of the 5 models priced in Q3 2026 were also priced in Q2 2026/);
  assert.match(q3.xai.qoqReason, /fewer than half of this lineup/);
  assert.equal(q3.deepseek.qoq, Math.round((2.9 / 3 - 1) * 1000) / 1000);
  assert.equal(q3.deepseek.qoqMatchedModels, 2);
  assert.equal(q3.deepseek.qoqTooFewMatched, undefined);
});

test('YoY is like-for-like too, and refused on a lineup that mostly turned over', async () => {
  const Y0 = '2025-07-28', Y_END = '2025-09-30';
  const d = await matrix({
    'meta-llama': [
      ...hist('llama-a', [[Y0, E, 2e-7]]),
      ...hist('llama-b', [[Y0, E, 6e-7]]),
      ...hist('llama-c', [[Y0, E, 1e-7]]),
      ...hist('llama-old', [[Y0, Y_END, 5e-6]]),
      ...hist('llama-new', [['2026-07-01', E, 3e-8]]),
    ],
    // Two of the five models priced now were priced a year ago.
    cohere: [
      ...hist('command-a', [[Y0, E, 2.5e-6]]),
      ...hist('command-b', [[Y0, E, 1.5e-7]]),
      ...hist('command-c', [['2026-04-01', E, 1e-6]]),
      ...hist('command-d', [['2026-04-01', E, 2e-6]]),
      ...hist('command-e', [['2026-04-01', E, 3e-6]]),
    ],
  });
  const q3 = cellsOf(d, '2026-Q3');
  assert.equal(q3['meta-llama'].yoy, 0);
  assert.equal(q3['meta-llama'].yoyMatchedModels, 3);
  assert.match(q3['meta-llama'].yoyNote, /priced in both Q3 2025 and Q3 2026/);
  assert.equal(q3.cohere.yoy, null);
  assert.equal(q3.cohere.yoyTooFewMatched, true);
  assert.match(q3.cohere.yoyReason, /only 2 of the 5 models priced in Q3 2026 were also priced in Q3 2025/);
  // Its QoQ matches all five and is computed.
  assert.equal(q3.cohere.qoq, 0);
  assert.equal(q3.cohere.qoqMatchedModels, 5);
});

/* ── A change of measure is still refused, and nothing re-enters ──────── */

test('across the change of measure every moved model is linked at its exact factor, a returned one included', async () => {
  const Q4_END = '2026-10-31';
  const touched = [['g-1', 1.25e-6], ['g-2', 3e-7], ['g-3', 1e-7], ['g-4', 2e-6], ['g-5', 5e-7]];
  const d = await matrix({
    google: [
      // Five models halve on 2026-07-10: the source changing what it reports.
      ...touched.flatMap(([m, p]) => hist(m, [[S, '2026-07-09', p], ['2026-07-10', Q4_END, p / 2]])),
      // One halves with them and returns to its old figure on 2026-07-27 —
      // back on the old measure, which from there on is not the quarter's.
      ...hist('g-ret', [[S, '2026-07-09', 5e-7], ['2026-07-10', '2026-07-26', 2.5e-7], ['2026-07-27', Q4_END, 5e-7]]),
      ...hist('gemma', [[S, Q4_END, 3e-8]]),
    ],
  });
  assert.deepEqual(d.measureBreaks.events.map(e => e.effectiveDate), ['2026-07-10']);
  const q3 = cellsOf(d, '2026-Q3').google, q4 = cellsOf(d, '2026-Q4').google;
  // Q3 against Q2: each moved model enters at twice its reported Q3 price —
  // exactly its Q2 figure — so nothing moved. g-ret's Q3 level rests on its
  // halved days, linked the same way. The raw levels would read a cut.
  assert.equal(q3.qoq, 0);
  assert.equal(q3.qoqLinked, true);
  assert.equal(q3.qoqMeasureChanged, undefined);
  assert.equal(q3.qoqMatchedModels, 7);
  // Q4 against Q3, both on the new measure. g-ret's Q4 figures are all on the
  // old measure, so it is in neither Q4's level nor the matched set; were it
  // matched on its raw figures, Q3's blend of $0.25 and $0.50 against Q4's
  // $0.50 would print a rise that is only the measure.
  assert.equal(q3.modelCount, 7);
  assert.equal(q4.modelCount, 6);
  assert.equal(q4.qoqMatchedModels, 6);
  assert.equal(q4.qoq, 0);
  assert.equal(q4.qoqMeasureChanged, undefined);
});

/* ── The read-through inherits it ─────────────────────────────────────── */

test('the read-through no longer names a lineup change as the biggest price cut', async () => {
  const snap = (date, tok) => ({
    date,
    or: Object.entries(tok).map(([provider, tokRaw], i) => ({ rank: i + 1, model: provider + ' model', provider, tokRaw })),
  });
  const history = {
    success: true,
    snapshots: [
      snap('2026-05-01', { anthropic: 40, deepseek: 30, google: 30 }),
      snap('2026-05-02', { anthropic: 40, deepseek: 30, google: 30 }),
      snap('2026-08-01', { anthropic: 30, deepseek: 35, google: 35 }),
      snap('2026-08-02', { anthropic: 30, deepseek: 35, google: 35 }),
    ],
  };
  const upstream = {
    // Lineup churn only: the old matrix read this as a large cut.
    anthropic: [
      ...hist('claude-a', [[S, E, 3e-6]]),
      ...hist('claude-b', [[S, E, 1.5e-5]]),
      ...hist('claude-c', [[S, E, 8e-7]]),
      ...hist('claude-old', [[S, Q2_END, 7.5e-5]]),
      ...hist('claude-new', [[Q3_START, E, 1e-6]]),
    ],
    // A real 10% cut on both of its models.
    deepseek: [
      ...hist('ds-a', [[S, Q2_END, 1e-6], [Q3_START, E, 9e-7]]),
      ...hist('ds-b', [[S, Q2_END, 2e-6], [Q3_START, E, 1.8e-6]]),
    ],
    // The change of measure: linked at its exact factor, so no move.
    google: [
      ...[['g-1', 1.25e-6], ['g-2', 3e-7], ['g-3', 1e-7], ['g-4', 2e-6], ['g-5', 5e-7]]
        .flatMap(([m, p]) => hist(m, [[S, '2026-07-09', p], ['2026-07-10', E, p / 2]])),
      ...hist('gemma', [[S, E, 3e-8]]),
    ],
  };
  const d = await run(readThrough, '/api/pricing-share-signal', upstream, history);
  assert.equal(d.success, true);
  const rows = Object.fromEntries(d.quarters.find(q => q.quarter === '2026-Q3').rows.map(r => [r.slug, r]));
  assert.equal(rows.anthropic.priceQoq, 0, "the matrix's like-for-like figure, not the lineup average's");
  assert.equal(rows.anthropic.priceReg, 'hold');
  assert.equal(rows.deepseek.priceQoq, -0.1);
  assert.equal(rows.google.priceMeasureChanged, false);
  assert.equal(rows.google.priceQoq, 0, 'the halving is linked, not a cut');
  assert.equal(rows.google.priceReg, 'hold');

  const cut = d.callouts.find(c => c.kind === 'biggest_price_cut');
  assert.equal(cut?.slug, 'deepseek', 'the genuine cut is the one called out');
  assert.ok(cut.detail.startsWith('-10.0%'));
  for (const c of d.callouts.filter(c => c.kind !== 'strongest_share_gain')) {
    assert.notEqual(c.slug, 'anthropic', 'price callout fired on a lineup change: ' + c.kind);
    assert.ok(!(c.slug === 'google' && c.kind === 'biggest_price_cut'), 'the linked halving must not read as a cut');
  }
});
