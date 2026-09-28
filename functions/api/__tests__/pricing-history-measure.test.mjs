/**
 * /api/pricing-history across the source's change of measure.
 *
 * The route averages the 16-slug tracked basket, six of whose members sit in
 * the Google and OpenAI families whose reported figure the source halved on
 * one day in 2026. Read raw, a quarter straddling that day is a blend of two
 * measures and the QoQ off it is a price cut that never happened.
 *
 * The fixture is built so the change CANNOT be found in the basket: only two
 * basket members step, and _model-price-basis.js needs five at a provider. It
 * is found in the live per-model history the route now reads, and applied to
 * the basket — which is the whole point of the test.
 *
 * Dates run off today's quarter so nothing here is ever the in-progress
 * quarter: the comparator quarter and the straddled quarter are both complete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as pricingHistory } from '../pricing-history.js';
import { PRICING_BASKET } from '../_pricing-basket.js';

const DAY = 86400000;
const iso = d => d.toISOString().slice(0, 10);
const days = (f, t) => {
  const o = [];
  for (let x = Date.parse(f + 'T00:00:00Z'); x <= Date.parse(t + 'T00:00:00Z'); x += DAY) {
    o.push(new Date(x).toISOString().slice(0, 10));
  }
  return o;
};

const now = new Date();
const back = (y, q, n) => { let t = y * 4 + (q - 1) - n; return { y: Math.floor(t / 4), q: (t % 4) + 1 }; };
const CUR = { y: now.getUTCFullYear(), q: Math.floor(now.getUTCMonth() / 3) + 1 };
const STRADDLED = back(CUR.y, CUR.q, 1);   // the quarter the change falls in
const BASE = back(CUR.y, CUR.q, 2);        // its comparator, wholly before it
const qid = ({ y, q }) => y + '-Q' + q;
const S = iso(new Date(Date.UTC(BASE.y, (BASE.q - 1) * 3, 1)));
const BREAK = iso(new Date(Date.UTC(STRADDLED.y, (STRADDLED.q - 1) * 3 + 1, 10)));
const E = iso(new Date(Date.UTC(STRADDLED.y, STRADDLED.q * 3, 0)));
const ALL_DAYS = days(S, E);
const PRE_BREAK_DAYS = ALL_DAYS.filter(d => d >= iso(new Date(Date.UTC(STRADDLED.y, (STRADDLED.q - 1) * 3, 1))) && d < BREAK).length;

// ── The basket's own captured snapshots ──
// Two Google members are cut to exactly half on the break date; the other
// fourteen never move. Two is below MIN_EVENT_MODELS, so the basket alone
// cannot tell this from an ordinary repricing.
const STEPPED = ['google-gemini-2.5-pro', 'google-gemini-2.5-flash'];
const snapshotFor = date => ({
  date,
  pricing: {
    models: PRICING_BASKET.map(b => {
      const input = STEPPED.includes(b.slug) ? (date < BREAK ? 4 : 2) : 1;
      return { slug: b.slug, provider: b.provider, input, output: input * 4 };
    }),
  },
});
const KV = {
  get: async (key) => {
    if (key === 'index:days') return ALL_DAYS.slice().reverse();
    const d = key.slice('day:'.length);
    return ALL_DAYS.includes(d) ? snapshotFor(d) : null;
  },
};

// ── The live per-model history the break dates come from ──
const hist = (model, spans) => spans.flatMap(([f, t, p]) =>
  days(f, t).map(d => ({ model, date: d + 'T00:00:00+00:00', pricing_prompt: p, pricing_completion: p * 8 })));
const dayBefore = d => iso(new Date(Date.parse(d + 'T00:00:00Z') - DAY));
const halving = prefix => [1, 2, 3, 4, 5, 6].flatMap(i =>
  hist(prefix + '-' + i, [[S, dayBefore(BREAK), i * 2e-7], [BREAK, E, i * 1e-7]]));
const FLAT = slug => hist(slug + '-flagship', [[S, E, 1e-6]]);
// Six models at Google and six at OpenAI halve on one day; every other
// provider is flat, so the only date detected is the real one.
const WITH_BREAK = { google: halving('gemini'), openai: halving('gpt') };
// Same basket, same two stepping members — but a source whose per-model
// history shows no such day.
const NO_BREAK = { google: FLAT('google'), openai: FLAT('openai') };

async function call(path, upstream = WITH_BREAK, { unreachable = false } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (!u.hostname.includes('pricepertoken')) return new Response('null', { status: 404 });
    if (unreachable) return new Response('nope', { status: 503 });
    const p = u.searchParams.get('provider');
    return new Response(JSON.stringify({ results: upstream[p] || FLAT(p) }), { status: 200 });
  };
  try {
    const resp = await pricingHistory({
      request: new Request('https://x.test' + path),
      env: { HISTORY_KV: KV },
    });
    return await resp.json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const byId = qs => Object.fromEntries(qs.map(q => [q.id, q]));

test('the basket quarter rests on one measure and its QoQ is linked across the change', async () => {
  const d = await call('/api/pricing-history?metric=input');
  const q = byId(d.quarters);
  // The comparator quarter is wholly before the change: 2 members at $4 and
  // 14 at $1.
  assert.equal(q[qid(BASE)].avg, 1.38);
  assert.equal(q[qid(BASE)].basis, null);
  // The straddled quarter settles on the measure the source reports from the
  // break date — 2 x $2 and 14 x $1 — and leaves the pre-break observations
  // of the two stepped members out rather than blending $4 with $2.
  const q2 = q[qid(STRADDLED)];
  assert.equal(q2.avg, 1.13);
  assert.equal(q2.basis, BREAK);
  assert.equal(q2.excludedObs, 2 * PRE_BREAK_DAYS);
  // Nothing was repriced, so nothing is reported as repriced. Read raw this
  // quarter averaged about $1.15 and printed roughly -16% QoQ.
  assert.equal(q2.qoq, 0);
  assert.equal(q2.qoqLabel, '0.0%');
  assert.match(q2.qoqNote, new RegExp('change of reporting on ' + BREAK));
  assert.match(q2.qoqNote, /at twice the reported price/);
  assert.equal(d.sourceHistory.growthWithheld, null);
  assert.match(d.measureBreaks.headline, new RegExp('changed how it reports prices on ' + BREAK));
  // Every basket provider's history is fetched — an unmapped provider would
  // silently drop out of detection.
  assert.equal(d.sourceHistory.readable.length,
    new Set(PRICING_BASKET.map(b => b.provider)).size);
});

test('the break date comes from the live per-model history, not from the basket', async () => {
  // Identical snapshots. The only difference is a source whose per-model
  // history shows no uniform step, so the two members' halving is what it
  // then looks like — an ordinary price cut, reported as one.
  const d = await call('/api/pricing-history?metric=input', NO_BREAK);
  const q2 = byId(d.quarters)[qid(STRADDLED)];
  assert.equal(d.measureBreaks, null);
  assert.equal(q2.basis, null);
  assert.equal(q2.excludedObs, 0);
  assert.ok(q2.qoq < -0.1, 'a real cut of this size is still reported as one');
  assert.equal(q2.qoqNote, null);
});

test('view=by-slug links each touched slug instead of halving it', async () => {
  const d = await call('/api/pricing-history?view=by-slug');
  const m = Object.fromEntries(d.models.map(x => [x.slug, x]));
  const pro = m['google-gemini-2.5-pro'];
  // The level is what the source now reports; the comparison is linked to it.
  assert.equal(pro.input[qid(BASE)], 4);
  assert.equal(pro.input[qid(STRADDLED)], 2);
  assert.equal(pro.priceBasis.input[qid(STRADDLED)], BREAK);
  assert.equal(pro.basisExcludedObs.input[qid(STRADDLED)], PRE_BREAK_DAYS);
  assert.equal(pro.qoqInput[qid(STRADDLED)], 0, 'read raw this cell was -0.5');
  assert.equal(pro.qoqOutput[qid(STRADDLED)], 0);
  assert.match(pro.linkedChange.qoqInput[qid(STRADDLED)], /at twice the reported price/);
  assert.equal(pro.measureChanged, undefined);
  // A member no change touched is untouched: no annotations, growth as ever.
  const opus = m['anthropic-claude-3-opus'];
  assert.equal(opus.priceBasis, undefined);
  assert.equal(opus.qoqInput[qid(STRADDLED)], 0);
});

test('an unreadable provider withholds growth only where a step could hide a change', async () => {
  const d = await call('/api/pricing-history?metric=input', WITH_BREAK, { unreachable: true });
  const q2 = byId(d.quarters)[qid(STRADDLED)];
  // The averages are still published — they are the figures the source gave.
  assert.ok(q2.avg > 0);
  assert.equal(d.sourceHistory.readable.length, 0);
  // But the comparison off them is not guessed at in either direction.
  assert.equal(q2.qoq, null);
  assert.match(q2.qoqNote, /Google per-model price history could not be read/);
  assert.match(q2.qoqNote, /no telling such a step apart from the source changing which price it reports/);
  assert.ok(q2.notes.includes(q2.qoqNote));

  // Per-slug, the withholding costs only the members that actually step.
  const s = await call('/api/pricing-history?view=by-slug', WITH_BREAK, { unreachable: true });
  const m = Object.fromEntries(s.models.map(x => [x.slug, x]));
  assert.deepEqual(m['google-gemini-2.5-pro'].qoqInput, {});
  assert.match(m['google-gemini-2.5-pro'].growthWithheld, /could not be read/);
  assert.equal(m['anthropic-claude-3-opus'].growthWithheld, undefined);
  assert.equal(m['anthropic-claude-3-opus'].qoqInput[qid(STRADDLED)], 0,
    'a member that never steps is on one measure whatever happened upstream');
});
