/**
 * Regression tests for the 2026-07-10 change of measure in model pricing.
 *
 * The bug these exist to prevent: on 2026-07-10 the pricing source's figure
 * for 13 Google and 10 OpenAI models fell to exactly half on the same day.
 * No vendor repriced — the source changed which price it reports — but the
 * dashboard published it as a market move: "Biggest price cut: Google -19.5%"
 * for 2026-Q3, OpenAI -11.9% QoQ, and -35% to -50% month-on-month on the
 * touched peer-matrix rows.
 *
 * The fixtures below are the real captured prices ($/token), reduced to the
 * few days that decide each case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASIS_ORIGIN,
  METRIC_FIELD,
  readPrice,
  isAltBillingSku,
  exactStepDirection,
  detectMeasureBreaks,
  buildBasisBook,
  modelBasisTimeline,
  createTally,
  tallyFor,
  addToTally,
  mergeTallies,
  resolveTally,
  resolvePeriodTallies,
  countsToward,
  basisGrowth,
  isMeasureChange,
  growthSeries,
  measureChangeReason,
  sparse,
  describeMeasureBreaks,
} from '../_model-price-basis.js';
import { onRequestGet as readThrough } from '../pricing-share-signal.js';

// ── Fixture helpers ──────────────────────────────────────────────────────

const DAY = 86400000;
function daysBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Upstream rows for one model: [[from, to, prompt, completion], ...]. */
function history(model, spans) {
  const rows = [];
  for (const [from, to, p, c] of spans) {
    for (const d of daysBetween(from, to)) {
      rows.push({ model, date: d + 'T00:00:00+00:00', pricing_prompt: p, pricing_completion: c ?? p * 8 });
    }
  }
  return rows;
}

// The window every fixture runs over: straddles the change by a few days
// either side, and long enough for a month on each side where needed.
const W0 = '2026-07-06', W1 = '2026-07-14';

// Real prices at the change. [model, before, after] in $/token (input).
const GOOGLE_TOUCHED = [
  ['gemini-2.5-pro', 1.25e-6, 6.25e-7],
  ['gemini-2.5-flash', 3e-7, 1.5e-7],
  ['gemini-2.5-flash-lite', 1e-7, 5e-8],
  ['gemini-3.1-pro-preview', 2e-6, 1e-6],
  ['gemini-3-flash-preview', 5e-7, 2.5e-7],
  ['gemini-3.5-flash', 1.5e-6, 7.5e-7],
];
const OPENAI_TOUCHED = [
  ['gpt-5-mini', 2.5e-7, 1.25e-7],
  ['gpt-5.5', 5e-6, 2.5e-6],
  ['gpt-5-nano', 5e-8, 2.5e-8],
  ['gpt-5.4', 2.5e-6, 1.25e-6],
  ['gpt-5.1', 1.25e-6, 6.25e-7],
  ['gpt-5.2', 1.75e-6, 8.75e-7],
];

function touched(list, from = W0, to = W1) {
  return list.flatMap(([m, before, after]) => history(m, [
    [from, '2026-07-09', before],
    ['2026-07-10', to, after],
  ]));
}

const GOOGLE = {
  slug: 'google',
  rows: [
    ...touched(GOOGLE_TOUCHED),
    // Priced straight through the date without moving.
    ...history('gemma-3-27b-it', [[W0, W1, 3e-8, 1.1e-7]]),
  ],
};
const OPENAI = {
  slug: 'openai',
  rows: [
    ...touched(OPENAI_TOUCHED),
    ...history('gpt-5', [[W0, W1, 1.25e-6, 1e-5]]),
    // A genuine move on the same day, by a factor that is not 2.
    ...history('gpt-oss-120b', [[W0, '2026-07-09', 3e-8], ['2026-07-10', W1, 3.6e-8]]),
  ],
};
const ANTHROPIC = {
  slug: 'anthropic',
  rows: history('claude-sonnet-4.5', [[W0, W1, 3e-6, 1.5e-5]]),
};

/* ── Reads ────────────────────────────────────────────────────────────── */

test('every price is read from one place, per metric', () => {
  const row = { pricing_prompt: 1.25e-6, pricing_completion: 1e-5, original_prompt_price: 9 };
  assert.equal(readPrice(row, 'input'), 1.25e-6);
  assert.equal(readPrice(row, 'output'), 1e-5);
  assert.deepEqual(METRIC_FIELD, { input: 'pricing_prompt', output: 'pricing_completion' });
  assert.throws(() => readPrice(row, 'cache'));
});

test('a $0.00 row is not a price unless the caller wants free models shown as free', () => {
  const free = { pricing_prompt: 0 };
  assert.equal(readPrice(free, 'input'), null);
  assert.equal(readPrice(free, 'input', { allowZero: true }), 0);
  assert.equal(readPrice({ pricing_prompt: -1 }, 'input', { allowZero: true }), null);
  assert.equal(readPrice({ pricing_prompt: '1e-6' }, 'input'), null);
  assert.equal(readPrice({}, 'input'), null);
});

test('alternate-billing SKUs are recognised', () => {
  assert.equal(isAltBillingSku('gemini-3.6-flash:batch'), true);
  assert.equal(isAltBillingSku('gemini-3.6-flash'), false);
  assert.equal(isAltBillingSku(undefined), false);
});

test('an exact halving or doubling is recognised, and nothing near it is', () => {
  assert.equal(exactStepDirection(1.25e-6, 6.25e-7), -1);
  assert.equal(exactStepDirection(2.5e-7, 5e-7), 1);
  assert.equal(exactStepDirection(1e-6, 0.49e-6), 0, 'a 51% cut is a price move, not a halving');
  assert.equal(exactStepDirection(3e-8, 3.6e-8), 0);
  assert.equal(exactStepDirection(0, 1e-6), 0);
  // Float noise from $/token decimals must not break an exact match.
  assert.equal(exactStepDirection(0.1 + 0.2, (0.1 + 0.2) / 2), -1);
});

/* ── Detection: the date, from the data ───────────────────────────────── */

test('the detector finds the 2026-07-10 change from the rows alone', () => {
  // Nothing in the module names this date. It has to come out of the data.
  const events = detectMeasureBreaks([GOOGLE, OPENAI, ANTHROPIC], 'input');
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.effectiveDate, '2026-07-10');
  assert.equal(ev.direction, 'halved');
  assert.equal(ev.factor, 0.5);
  assert.equal(ev.modelCount, 12);
  assert.deepEqual(ev.providers, ['google', 'openai']);
  assert.deepEqual(ev.byProvider, [{ provider: 'google', count: 6 }, { provider: 'openai', count: 6 }]);
  // gpt-oss-120b's genuine x1.2 move the same day is counted as a move, not a halving.
  assert.equal(ev.movesThatDay, 13);
});

test('one vendor alone is enough to find it, so a failed provider fetch cannot reopen the comparison', () => {
  const g = detectMeasureBreaks([GOOGLE], 'input');
  assert.deepEqual(g.map(e => e.effectiveDate), ['2026-07-10']);
  const o = detectMeasureBreaks([OPENAI, ANTHROPIC], 'input');
  assert.deepEqual(o.map(e => e.effectiveDate), ['2026-07-10']);
});

test('output prices are detected on their own', () => {
  const events = detectMeasureBreaks([GOOGLE, OPENAI], 'output');
  assert.deepEqual(events.map(e => e.effectiveDate), ['2026-07-10']);
});

test('a single model\'s real 50% cut on its own date is NOT a change of measure', () => {
  // Gemini 3.6 Flash, first listed 2026-07-22, halved alone on 2026-08-14.
  const flash36 = { slug: 'google', rows: history('gemini-3.6-flash', [
    ['2026-07-22', '2026-08-13', 7.5e-7], ['2026-08-14', '2026-08-31', 3.75e-7],
  ]) };
  assert.deepEqual(detectMeasureBreaks([flash36, ANTHROPIC], 'input'), []);

  // With the real change in the same payload, its own step does not make it
  // a participant — the step is on 2026-08-14, nowhere near the change.
  const book = buildBasisBook([{ slug: 'google', rows: [...GOOGLE.rows, ...flash36.rows] }, OPENAI], 'input');
  const t8 = book.touchedModels('google').find(m => m.model === 'gemini-3.6-flash');
  assert.deepEqual(t8.changes.map(c => c.kind), ['listed-after'], 'placed on the new measure at listing, never moved by its own cut');

  // So both sides of its cut sit on one measure, and the cut is reported as
  // the real price move it is.
  const t = new Map();
  for (const r of flash36.rows) {
    const day = r.date.slice(0, 10);
    addToTally(tallyFor(t, day.slice(0, 7)), book.basisOf('google', r.model, day), r.pricing_prompt, r.model);
  }
  const res = resolvePeriodTallies(t);
  const mom = growthSeries(res.levels, pid => (pid === '2026-08' ? '2026-07' : null));
  assert.ok(mom.growth['2026-08'] < -0.25, 'the August cut is reported, got ' + mom.growth['2026-08']);
  assert.deepEqual(mom.measureChanged, {});
});

test('GPT-5\'s one-week halving in September 2025 is not a change of measure', () => {
  // A lone exact halving does not make a date qualify, however exact it is.
  const lone = { slug: 'openai', rows: history('gpt-5', [
    ['2025-09-10', '2025-09-17', 1.25e-6], ['2025-09-18', '2025-09-24', 6.25e-7], ['2025-09-25', '2025-09-30', 1.25e-6],
  ]) };
  assert.deepEqual(detectMeasureBreaks([lone], 'input'), []);
});

test('four synchronized halvings are below the bar', () => {
  // 2026-07-28: four new gpt-5.6 SKUs halved together, inside one vendor.
  const four = { slug: 'openai', rows: ['luna', 'luna-pro', 'terra', 'terra-pro'].flatMap(s =>
    history('gpt-5.6-' + s, [['2026-07-20', '2026-07-27', 5e-7], ['2026-07-28', '2026-07-30', 2.5e-7]])) };
  assert.deepEqual(detectMeasureBreaks([four], 'input'), []);
});

test('a day of exact steps in BOTH directions is a repricing, not a switch of measure', () => {
  // 2026-08-18: four gpt-5.6 SKUs doubled and two halved.
  const mixed = { slug: 'openai', rows: [
    ...['luna', 'luna-pro', 'terra', 'terra-pro'].flatMap(s =>
      history('gpt-5.6-' + s, [['2026-08-10', '2026-08-17', 5e-8], ['2026-08-18', '2026-08-20', 1e-7]])),
    ...['sol', 'sol-pro'].flatMap(s =>
      history('gpt-5.6-' + s, [['2026-08-10', '2026-08-17', 2.5e-6], ['2026-08-18', '2026-08-20', 1.25e-6]])),
  ] };
  assert.deepEqual(detectMeasureBreaks([mixed], 'input'), []);
});

test('a real repricing day where halvings are a minority does not qualify', () => {
  // Five exact halvings among ten moves: 50% exact, below the 80% bar.
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(...history('half-' + i, [['2026-05-01', '2026-05-09', 1e-6], ['2026-05-10', '2026-05-12', 5e-7]]));
  for (let i = 0; i < 5; i++) rows.push(...history('cut-' + i, [['2026-05-01', '2026-05-09', 1e-6], ['2026-05-10', '2026-05-12', 7e-7]]));
  assert.deepEqual(detectMeasureBreaks([{ slug: 'x', rows }], 'input'), []);
});

test('alternate-billing SKUs never count toward a change', () => {
  // Five ':batch' halvings plus nothing else must not look like an event.
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(...history('m' + i + ':batch', [['2026-05-01', '2026-05-09', 1e-6], ['2026-05-10', '2026-05-12', 5e-7]]));
  assert.deepEqual(detectMeasureBreaks([{ slug: 'x', rows }], 'input'), []);
});

/* ── Which models the change touched ──────────────────────────────────── */

test('a model is touched only by its own exact step across the date', () => {
  const book = buildBasisBook([GOOGLE, OPENAI, ANTHROPIC], 'input');
  // Touched: on the original measure before, on the change's measure after.
  assert.equal(book.basisOf('google', 'gemini-2.5-pro', '2026-07-09'), BASIS_ORIGIN);
  assert.equal(book.basisOf('google', 'gemini-2.5-pro', '2026-07-10'), '2026-07-10');
  assert.equal(book.basisOf('openai', 'gpt-5-mini', '2026-07-12'), '2026-07-10');
  // Untouched: priced through the date without moving, or moving by another factor.
  assert.equal(book.basisOf('google', 'gemma-3-27b-it', '2026-07-12'), null);
  assert.equal(book.basisOf('openai', 'gpt-5', '2026-07-12'), null);
  assert.equal(book.basisOf('openai', 'gpt-oss-120b', '2026-07-12'), null);
  assert.equal(book.basisOf('anthropic', 'claude-sonnet-4.5', '2026-07-12'), null);
  assert.deepEqual(book.touchedModels('anthropic'), []);
  assert.equal(book.touchedModels('google').length, 6);
});

test('a model first listed on or after the change is on the new measure — at a provider the change touched', () => {
  // GPT-5.6 Sol was first priced on the day of the change. There is no earlier
  // figure to say which measure it is on, and the source reports it the way it
  // now reports OpenAI; comparing it with GPT-5.5 Pro's pre-change $30 as one
  // measure produced a -91.7% "frontier" move.
  const sol = history('gpt-5.6-sol', [['2026-07-10', '2026-07-31', 2.5e-6]]);
  const pro = history('gpt-5.5-pro', [['2026-06-01', '2026-07-09', 3e-5], ['2026-07-10', '2026-07-31', 1.5e-5]]);
  const newAnthropic = history('claude-fable-5.1', [['2026-08-01', '2026-08-31', 1e-5]]);
  const book = buildBasisBook([
    { slug: 'openai', rows: [...OPENAI.rows, ...sol, ...pro] }, GOOGLE,
    { slug: 'anthropic', rows: [...ANTHROPIC.rows, ...newAnthropic] },
  ], 'input');
  assert.equal(book.basisOf('openai', 'gpt-5.6-sol', '2026-07-10'), '2026-07-10');
  assert.equal(book.basisOf('anthropic', 'claude-fable-5.1', '2026-08-10'), null, 'the change never touched Anthropic');

  // A frontier that moves from GPT-5.5 Pro (June, before) to GPT-5.6 Sol
  // (July, after) crosses the change: refused, not -91.7%.
  const jun = createTally(), jul = createTally();
  for (const r of pro) if (r.date < '2026-07') addToTally(jun, book.basisOf('openai', r.model, r.date.slice(0, 10)), r.pricing_prompt, r.model);
  for (const r of sol) addToTally(jul, book.basisOf('openai', r.model, r.date.slice(0, 10)), r.pricing_prompt, r.model);
  const levels = resolvePeriodTallies(new Map([['2026-06', jun], ['2026-07', jul]])).levels;
  const g = growthSeries(levels, pid => (pid === '2026-07' ? '2026-06' : null));
  assert.deepEqual(g.growth, {});
  assert.ok(g.measureChanged['2026-07']);
});

test('a capture gap across the date still counts as the model\'s own step', () => {
  const gap = history('gemini-2.5-pro', [['2026-07-01', '2026-07-05', 1.25e-6], ['2026-07-12', '2026-07-20', 6.25e-7]]);
  const events = detectMeasureBreaks([GOOGLE], 'input');
  const days = new Map(gap.map(r => [r.date.slice(0, 10), r.pricing_prompt]));
  const t = modelBasisTimeline(days, events);
  assert.equal(t.touched, true);
  assert.deepEqual(t.segments.map(s => s.basis), [BASIS_ORIGIN, '2026-07-10']);
});

test('a touched model that steps back onto its old figure has returned to the old measure', () => {
  // Gemini 3.1 Flash Image Preview: $0.25, $0.50 from 2026-03-04, $0.25 on the
  // change, $0.50 again from 2026-07-27. The 07-27 step is not a +100% rise.
  const flip = history('gemini-3.1-flash-image-preview', [
    ['2026-02-27', '2026-03-03', 2.5e-7], ['2026-03-04', '2026-07-09', 5e-7],
    ['2026-07-10', '2026-07-26', 2.5e-7], ['2026-07-27', '2026-08-31', 5e-7],
  ]);
  const book = buildBasisBook([{ slug: 'google', rows: [...GOOGLE.rows, ...flip] }, OPENAI], 'input');
  assert.equal(book.basisOf('google', 'gemini-3.1-flash-image-preview', '2026-03-10'), BASIS_ORIGIN);
  assert.equal(book.basisOf('google', 'gemini-3.1-flash-image-preview', '2026-07-20'), '2026-07-10');
  assert.equal(book.basisOf('google', 'gemini-3.1-flash-image-preview', '2026-08-20'), BASIS_ORIGIN);

  // Its lone +100% on 2026-03-04 was an ordinary move and stays one.
  const t = new Map();
  for (const r of flip) {
    const day = r.date.slice(0, 10);
    addToTally(tallyFor(t, day.slice(0, 7)), book.basisOf('google', r.model, day), r.pricing_prompt, r.model);
  }
  const months = resolvePeriodTallies(t);
  const prior = pid => ({ '2026-03': '2026-02', '2026-06': '2026-05', '2026-07': '2026-06', '2026-08': '2026-07' })[pid] || null;
  const mom = growthSeries(months.levels, prior);
  assert.equal(months.basis['2026-07'], '2026-07-10', '17 of July\'s 31 days are on the new measure');
  assert.ok(mom.growth['2026-03'] > 0.5, 'the March repricing is still reported');
  assert.ok(mom.measureChanged['2026-07'], 'June to July crosses the change');
  assert.ok(mom.measureChanged['2026-08'], 'July to August crosses it back');
  assert.equal(mom.growth['2026-08'], undefined, 'no +63% "price rise" in August');
});

/* ── Levels: one measure per period, never a blend ────────────────────── */

test('a period straddling the change averages only its majority measure', () => {
  // July 2026 for Gemini 2.5 Pro: 9 days at $1.25, 22 days at $0.625.
  const rows = history('gemini-2.5-pro', [['2026-07-01', '2026-07-09', 1.25e-6], ['2026-07-10', '2026-07-31', 6.25e-7]]);
  const book = buildBasisBook([{ slug: 'google', rows: [...rows, ...GOOGLE.rows.filter(r => r.model !== 'gemini-2.5-pro')] }], 'input');
  const t = createTally();
  for (const r of rows) addToTally(t, book.basisOf('google', r.model, r.date.slice(0, 10)), r.pricing_prompt, r.model);
  const res = resolveTally(t);
  assert.equal(res.basis, '2026-07-10');
  assert.equal(res.n, 22);
  assert.equal(res.excludedN, 9);
  assert.equal(+(res.mean * 1e6).toFixed(3), 0.625, 'not the $0.806 blend, which measures nothing');
});

test('untouched models always count, whichever measure a period is on', () => {
  const t = createTally();
  addToTally(t, '2026-07-10', 6.25e-7, 'gemini-2.5-pro');
  addToTally(t, BASIS_ORIGIN, 1.25e-6, 'gemini-2.5-pro');
  addToTally(t, '2026-07-10', 6.25e-7, 'gemini-2.5-pro');
  addToTally(t, null, 3e-8, 'gemma-3-27b-it');
  const res = resolveTally(t);
  assert.equal(res.basis, '2026-07-10');
  assert.equal(res.n, 3);
  assert.deepEqual([...res.models].sort(), ['gemini-2.5-pro', 'gemma-3-27b-it']);
  assert.equal(countsToward(null, '2026-07-10'), true);
  assert.equal(countsToward(BASIS_ORIGIN, '2026-07-10'), false);
  assert.equal(countsToward('2026-07-10', '2026-07-10'), true);
});

test('a tie goes to the measure the source publishes going forward', () => {
  const t = createTally();
  addToTally(t, BASIS_ORIGIN, 1.25e-6, 'a');
  addToTally(t, '2026-07-10', 6.25e-7, 'a');
  assert.equal(resolveTally(t).basis, '2026-07-10');
});

test('a period with no touched model is on the original measure', () => {
  const t = createTally();
  addToTally(t, null, 3e-6, 'claude-sonnet-4.5');
  const res = resolveTally(t);
  assert.equal(res.basis, BASIS_ORIGIN);
  assert.equal(res.excludedN, 0);
});

test('merging variants keeps each observation on its own measure', () => {
  const a = createTally(); addToTally(a, '2026-07-10', 1e-6, 'gemini-3.1-pro-preview');
  const b = createTally(); addToTally(b, null, 2e-6, 'gemini-3-pro-preview');
  const res = resolveTally(mergeTallies([a, b, null]));
  assert.equal(res.basis, '2026-07-10');
  assert.equal(res.n, 2);
});

test('resolved series publish sparse basis maps — only periods off the original measure', () => {
  const t = new Map();
  addToTally(tallyFor(t, '2026-Q2'), BASIS_ORIGIN, 1.25e-6, 'm');
  addToTally(tallyFor(t, '2026-Q3'), '2026-07-10', 6.25e-7, 'm');
  addToTally(tallyFor(t, '2026-Q3'), BASIS_ORIGIN, 1.25e-6, 'm');
  tallyFor(t, '2026-Q4');                           // a period with no price at all
  const res = resolvePeriodTallies(t);
  assert.deepEqual(res.values, { '2026-Q2': 1.25, '2026-Q3': 0.625, '2026-Q4': null });
  assert.deepEqual(res.basis, { '2026-Q3': '2026-07-10' });
  assert.deepEqual(res.excluded, { '2026-Q3': 1 });
});

/* ── Growth: the refusal that stops the phantom cut ───────────────────── */

const Q2 = { value: 1.25, basis: BASIS_ORIGIN };
const Q3 = { value: 0.625, basis: '2026-07-10' };
const Q4 = { value: 0.6, basis: '2026-07-10' };

test('growth across the change is refused, not reported as -50%', () => {
  assert.equal(basisGrowth(Q3, Q2), null);
  assert.equal(isMeasureChange(Q3, Q2), true);
  // Sanity check on the number being refused.
  assert.equal(+((Q3.value - Q2.value) / Q2.value).toFixed(3), -0.5);
});

test('growth within one side of the change is computed', () => {
  assert.equal(basisGrowth(Q4, Q3), -0.04);
  assert.equal(basisGrowth({ value: 1.3, basis: BASIS_ORIGIN }, Q2), 0.04);
  assert.equal(isMeasureChange(Q4, Q3), false);
});

test('a missing or zero prior is refused, and is not called a change of measure', () => {
  assert.equal(basisGrowth(Q3, null), null);
  assert.equal(isMeasureChange(Q3, null), false);
  assert.equal(basisGrowth(Q3, { value: 0, basis: '2026-07-10' }), null);
  assert.equal(basisGrowth(Q3, { value: null, basis: BASIS_ORIGIN }), null);
  assert.equal(isMeasureChange(Q3, { value: null, basis: BASIS_ORIGIN }), false);
});

test('a payload without basis fields reads as the original measure', () => {
  assert.equal(basisGrowth({ value: 1.3 }, { value: 1.25 }), 0.04);
});

test('growthSeries computes within a side, refuses across, and skips the period in progress', () => {
  const levels = { '2026-Q1': { value: 1.2, basis: BASIS_ORIGIN }, '2026-Q2': Q2, '2026-Q3': Q3, '2026-Q4': Q4 };
  const prior = { '2026-Q2': '2026-Q1', '2026-Q3': '2026-Q2', '2026-Q4': '2026-Q3' };
  const g = growthSeries(levels, pid => prior[pid] || null, { skip: '2026-Q4', events: [] });
  assert.deepEqual(g.growth, { '2026-Q2': 0.042 });
  assert.deepEqual(Object.keys(g.measureChanged), ['2026-Q3']);
  assert.match(g.measureChanged['2026-Q3'], /Q2 2026/);
});

test('the refusal carries a reason a reader can use, with no internal names in it', () => {
  const events = detectMeasureBreaks([GOOGLE, OPENAI], 'input');
  const why = measureChangeReason(Q3, Q2, 'Q2 2026', events);
  assert.match(why, /Not comparable/);
  assert.match(why, /2026-07-10/);
  assert.match(why, /Q2 2026/);
  assert.match(why, /12 models halved at once/);
  assert.match(why, /not a price move/);
  assert.doesNotMatch(why, /pricing_|original_|basis|\/api\/|_KV/);
});

test('annotation maps are dropped when empty, so an untouched series carries none', () => {
  assert.equal(sparse({ input: {}, output: {} }), undefined);
  assert.deepEqual(sparse({ input: {}, inputMonthly: { '2026-07': '2026-07-10' } }), { inputMonthly: { '2026-07': '2026-07-10' } });
  assert.equal(JSON.stringify({ a: 1, priceBasis: sparse({ input: {} }) }), '{"a":1}');
});

test('the caption names the vendors and counts, and says what is and is not computed', () => {
  const events = detectMeasureBreaks([GOOGLE, OPENAI], 'input');
  const label = s => ({ google: 'Google', openai: 'OpenAI' })[s];
  const d = describeMeasureBreaks([events, events], label);
  assert.equal(d.headline, 'The source changed how it reports prices on 2026-07-10.');
  assert.match(d.detail, /6 Google and 6 OpenAI models fell to exactly half/);
  assert.match(d.detail, /not a price move/);
  assert.match(d.detail, /measure changed/);
  assert.doesNotMatch(d.headline + d.detail, /pricing_|original_|basis|\/api\//);
  assert.equal(describeMeasureBreaks([[]]), null);
});

/* ── The whole scenario, end to end ───────────────────────────────────── */

test('provider level: one touched model is enough to refuse the provider\'s quarter', () => {
  // "Any", not "most": one touched $1.25 model among cheap untouched ones
  // still moves an equal-weighted $/token mean by most of the artefact.
  const rows = [
    ...history('gemini-2.5-pro', [['2026-06-01', '2026-07-09', 1.25e-6], ['2026-07-10', '2026-09-30', 6.25e-7]]),
    ...['a', 'b', 'c', 'd'].flatMap(s => history('gemma-' + s, [['2026-06-01', '2026-09-30', 3e-8]])),
  ];
  const provider = { slug: 'google', rows };
  const book = buildBasisBook([provider, GOOGLE, OPENAI], 'input');
  const q = new Map();
  for (const r of rows) {
    const day = r.date.slice(0, 10);
    const qid = day < '2026-07-01' ? '2026-Q2' : '2026-Q3';
    addToTally(tallyFor(q, qid), book.basisOf('google', r.model, day), readPrice(r, 'input'), r.model);
  }
  const res = resolvePeriodTallies(q);
  assert.equal(res.levels['2026-Q2'].basis, BASIS_ORIGIN);
  assert.equal(res.levels['2026-Q3'].basis, '2026-07-10');
  const g = growthSeries(res.levels, pid => (pid === '2026-Q3' ? '2026-Q2' : null), { events: book.events });
  assert.deepEqual(g.growth, {});
  assert.ok(g.measureChanged['2026-Q3']);
});

test('Gemini 2.5 Pro\'s real history contains no fabricated cut', () => {
  // $1.25 input from 2025-07-28 for a year, $0.625 from 2026-07-10.
  const rows = history('gemini-2.5-pro', [['2025-07-28', '2026-07-09', 1.25e-6, 1e-5], ['2026-07-10', '2026-09-21', 6.25e-7, 5e-6]]);
  const payload = [{ slug: 'google', rows: [...rows, ...GOOGLE.rows.filter(r => r.model !== 'gemini-2.5-pro')] }, OPENAI];
  const book = buildBasisBook(payload, 'input');
  const months = new Map(), quarters = new Map();
  for (const r of rows) {
    const day = r.date.slice(0, 10);
    const b = book.basisOf('google', r.model, day);
    const m = +day.slice(5, 7);
    addToTally(tallyFor(months, day.slice(0, 7)), b, r.pricing_prompt, r.model);
    addToTally(tallyFor(quarters, day.slice(0, 4) + '-Q' + (Math.floor((m - 1) / 3) + 1)), b, r.pricing_prompt, r.model);
  }
  const M = resolvePeriodTallies(months), Q = resolvePeriodTallies(quarters);
  const priorMonth = pid => { const [y, m] = pid.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };
  const yearAgoMonth = pid => (+pid.slice(0, 4) - 1) + pid.slice(4);
  const priorQ = pid => { const [y, q] = pid.split('-Q').map(Number); return q === 1 ? (y - 1) + '-Q4' : y + '-Q' + (q - 1); };

  // 1. The straddle quarter is a clean $0.625, not a blend.
  assert.equal(Q.values['2026-Q3'], 0.625);
  assert.equal(Q.values['2026-Q2'], 1.25);

  // 2. No growth anywhere reports the change as a price move.
  const mom = growthSeries(M.levels, priorMonth, { skip: '2026-09', events: book.events });
  const yoy = growthSeries(M.levels, yearAgoMonth, { skip: '2026-09', events: book.events });
  const qoq = growthSeries(Q.levels, priorQ, { skip: '2026-Q3', events: book.events });
  for (const g of [mom, yoy, qoq]) {
    for (const [pid, v] of Object.entries(g.growth)) {
      assert.ok(Math.abs(v) < 0.01, pid + ' reported ' + v + ' — a change of measure leaked into growth');
    }
  }

  // 3. The comparisons that straddle it are refused, with a reason.
  assert.ok(mom.measureChanged['2026-07'], 'Jun -> Jul crosses the change');
  assert.ok(yoy.measureChanged['2026-07'] && yoy.measureChanged['2026-08'], 'YoY across it is refused too');

  // 4. The comparisons on one side of it still compute, and show it flat.
  assert.equal(mom.growth['2026-08'], 0);
  assert.equal(mom.growth['2026-06'], 0);
});

test('with no change detected, every level and growth is exactly the plain average', () => {
  const book = buildBasisBook([ANTHROPIC], 'input');
  assert.deepEqual(book.events, []);
  const t = new Map();
  for (const r of ANTHROPIC.rows) addToTally(tallyFor(t, 'p'), book.basisOf('anthropic', r.model, r.date.slice(0, 10)), r.pricing_prompt, r.model);
  const res = resolvePeriodTallies(t);
  assert.equal(res.values.p, 3);
  assert.deepEqual(res.basis, {});
  assert.deepEqual(res.excluded, {});
});

/* ── The read-through: no callout from a refused change ───────────────── */

test('the pricing/share read-through makes no price callout from a refused change', async () => {
  // 2026-Q3 as the matrix now publishes it: Google and OpenAI refused, Anthropic
  // computed. Google's cell deliberately still carries the old -19.5% as well —
  // the refusal flag must win over any number that is present.
  const matrix = {
    success: true,
    providers: [{ slug: 'google', label: 'Google' }, { slug: 'anthropic', label: 'Anthropic' }, { slug: 'openai', label: 'OpenAI' }],
    quarters: [
      { quarter: '2026-Q3', partial: false, cells: [
        { slug: 'google', avg: 0.478, avgLabel: '$0.478', qoq: -0.195, qoqMeasureChanged: true, qoqReason: 'Not comparable: the source changed how it reports prices on 2026-07-10.', modelCount: 29 },
        { slug: 'anthropic', avg: 7.12, avgLabel: '$7.12', qoq: -0.102, modelCount: 18 },
        { slug: 'openai', avg: 6.43, avgLabel: '$6.43', qoq: null, qoqMeasureChanged: true, qoqReason: 'Not comparable: the source changed how it reports prices on 2026-07-10.', modelCount: 68 },
      ] },
      { quarter: '2026-Q2', partial: false, cells: [
        { slug: 'google', avg: 0.622, avgLabel: '$0.622', qoq: 0.04, modelCount: 27 },
        { slug: 'anthropic', avg: 7.93, avgLabel: '$7.93', qoq: 0.559, modelCount: 18 },
        { slug: 'openai', avg: 7.31, avgLabel: '$7.31', qoq: 0.007, modelCount: 63 },
      ] },
    ],
    measureBreaks: { events: [], summary: null },
  };
  // Shares: Q2 google 30 / anthropic 40 / openai 30; Q3 20 / 30 / 50.
  const history = { success: true, snapshots: [
    { date: '2026-05-01', or: [{ provider: 'google', tokRaw: 30 }, { provider: 'anthropic', tokRaw: 40 }, { provider: 'openai', tokRaw: 30 }] },
    { date: '2026-08-01', or: [{ provider: 'google', tokRaw: 20 }, { provider: 'anthropic', tokRaw: 30 }, { provider: 'openai', tokRaw: 50 }] },
  ] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = path === '/api/provider-pricing-matrix' ? matrix : path === '/api/history' ? history : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  };
  let d;
  try {
    d = await (await readThrough({ request: new Request('https://x.test/api/pricing-share-signal') })).json();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(d.success, true);
  assert.equal(d.latestComparable, '2026-Q3');
  const rows = Object.fromEntries(d.quarters.find(q => q.quarter === '2026-Q3').rows.map(r => [r.slug, r]));
  for (const slug of ['google', 'openai']) {
    assert.equal(rows[slug].priceQoq, null, slug + ' price change must not be read as a number');
    assert.equal(rows[slug].priceMeasureChanged, true);
    assert.equal(rows[slug].priceReg, 'measure_changed');
    assert.equal(rows[slug].priceQoqLabel, 'measure changed');
    assert.equal(rows[slug].regimeLabel, 'Price measure changed');
    assert.match(rows[slug].priceQoqReason, /Not comparable/);
  }

  const bySlugKind = d.callouts.map(c => c.kind + ':' + c.slug);
  // No price callout names a provider whose price change was refused.
  for (const c of d.callouts.filter(c => c.kind !== 'strongest_share_gain')) {
    assert.ok(!['google', 'openai'].includes(c.slug), 'price callout fired on a refused change: ' + c.kind + ' ' + c.slug);
  }
  assert.ok(bySlugKind.includes('biggest_price_cut:anthropic'), 'the real cut is still called out');
  assert.ok(!d.callouts.some(c => /-19\.5%/.test(c.detail)), 'the phantom Google cut appears nowhere');
  // The share move is real and still reported, without quoting a price change.
  const gainer = d.callouts.find(c => c.kind === 'strongest_share_gain');
  assert.equal(gainer.slug, 'openai');
  assert.match(gainer.detail, /price measure changed/);
  assert.doesNotMatch(gainer.detail, /price [-+]\d/);
});
